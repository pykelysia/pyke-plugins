import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { Board } from '../board/types.js'
import { Op } from '../board/ops.js'
import { dataDir, lockFile, runtimeFile } from './paths.js'
import { DAEMON_VERSION } from './version.js'

export interface RuntimeInfo {
  port: number
  pid: number
  version: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function readRuntime(): RuntimeInfo | null {
  try {
    if (!existsSync(runtimeFile())) return null
    const rt = JSON.parse(readFileSync(runtimeFile(), 'utf-8')) as RuntimeInfo
    return rt?.port ? rt : null
  } catch {
    return null
  }
}

async function healthOf(port: number): Promise<{ ok: boolean; version?: string; pid?: number } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) })
    if (!res.ok) return null
    return (await res.json()) as { ok: boolean; version?: string; pid?: number }
  } catch {
    return null
  }
}

/** 端口上是否已经没有任何服务（等旧守护进程真正退出） */
async function portDown(port: number, timeoutMs = 4000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (!(await healthOf(port))) return true
    await sleep(150)
  }
  return false
}

function daemonEntry(): string {
  // dist/hub/client.js → dist/daemon.js
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'daemon.js')
}

function spawnDaemon(): void {
  const child = spawn(process.execPath, [daemonEntry()], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  })
  child.unref()
}

/**
 * 保证用户级守护进程在运行：
 * - 已有健康实例 → 复用（多 agent 因此共享同一端口）
 * - 否则用锁文件协调，拉起一个 detached 进程
 */
export async function ensureDaemon(): Promise<RuntimeInfo> {
  mkdirSync(dataDir(), { recursive: true })
  const existing = readRuntime()
  if (existing) {
    const h = await healthOf(existing.port)
    if (h?.ok) {
      if (h.version === DAEMON_VERSION) return existing
      // 版本不一致（刚升级过）：停掉旧守护进程，等端口释放后重新拉起
      try {
        if (h.pid) process.kill(h.pid)
      } catch {
        /* 已经退出 */
      }
      await portDown(existing.port)
    }
  }

  const lock = lockFile()
  let acquired = false
  try {
    const fd = openSync(lock, 'wx')
    writeSync(fd, String(process.pid))
    closeSync(fd)
    acquired = true
  } catch {
    // 别的 agent 正在启动，等它
  }

  if (acquired || staleLock(lock)) {
    if (!acquired) {
      try {
        unlinkSync(lock)
      } catch {
        /* 忽略 */
      }
      try {
        const fd = openSync(lock, 'wx')
        writeSync(fd, String(process.pid))
        closeSync(fd)
        acquired = true
      } catch {
        /* 继续等 */
      }
    }
    if (acquired) spawnDaemon()
  }

  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    await sleep(150)
    const rt = readRuntime()
    if (rt && (await healthOf(rt.port))?.ok) return rt
  }
  throw new Error(
    `无法启动 ui-draw 后台服务（数据目录 ${dataDir()}）。可以手动运行：node ${daemonEntry()}`,
  )
}

function staleLock(lock: string): boolean {
  try {
    return Date.now() - statSync(lock).mtimeMs > 10_000
  } catch {
    return false
  }
}

/** 画布摘要（守护进程 boards.json 里的轻量元数据） */
export interface BoardSummary {
  id: string
  title: string
  createdAt?: string
  updatedAt?: string
  width?: number
  height?: number
  elements?: number
}

export interface ProjectInfo {
  slug: string
  name: string
  projectDir: string
  boards: BoardSummary[]
}

/**
 * MCP 侧到守护进程的代理客户端：状态、撤销历史、渲染都在守护进程里，
 * 多个 agent / 多个会话共享同一份。
 * 一个项目可有多块画布（一个界面一块）；每个 MCP 会话记住自己的活跃画布，
 * 默认落在项目里最近更新的那块上。
 */
export class HubClient {
  private constructor(
    readonly base: string,
    readonly project: ProjectInfo,
    private activeId: string | null,
  ) {}

  static async connect(projectDir: string): Promise<HubClient> {
    const rt = await ensureDaemon()
    const base = `http://127.0.0.1:${rt.port}`
    const res = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectDir }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) throw new Error(`注册项目失败：HTTP ${res.status}`)
    const info = (await res.json()) as ProjectInfo
    const latest = [...(info.boards ?? [])].sort((a, b) => ((a.updatedAt ?? '') < (b.updatedAt ?? '') ? 1 : -1))[0]
    return new HubClient(base, info, latest?.id ?? null)
  }

  /** 本会话当前在哪块画布上作画 */
  get activeBoard(): BoardSummary | null {
    return this.project.boards.find((b) => b.id === this.activeId) ?? null
  }

  /** 所有画布级操作的前置：项目还没有画布时给出可执行的指引 */
  guardBoard(): BoardSummary {
    const active = this.activeBoard
    if (!active) {
      throw new Error(`项目「${this.project.name}」还没有画布：先用 setup_board 支起一块（可带 title 命名，如「登录页」）`)
    }
    return active
  }

  get boardUrl(): string {
    return `${this.base}/p/${encodeURIComponent(this.project.slug)}/${encodeURIComponent(this.guardBoard().id)}/`
  }

  get projectUrlBase(): string {
    return `${this.base}/p/${encodeURIComponent(this.project.slug)}/`
  }

  /** 支起一块新画布并切过去（旧画布原样保留） */
  async createBoard(opts: { title?: string; width: number; height: number; grid: boolean }): Promise<BoardSummary> {
    const res = await fetch(`${this.projectUrlBase}api/boards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
      signal: AbortSignal.timeout(8000),
    })
    const body = (await res.json().catch(() => ({}))) as { board?: BoardSummary; boards?: BoardSummary[]; error?: string }
    if (!res.ok || !body.board) throw new Error(body.error ?? `支起画布失败：HTTP ${res.status}`)
    this.project.boards = body.boards ?? this.project.boards
    this.activeId = body.board.id
    return body.board
  }

  async listBoards(): Promise<BoardSummary[]> {
    const res = await fetch(`${this.projectUrlBase}api/boards`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`读取画布清单失败：HTTP ${res.status}`)
    const body = (await res.json()) as { boards: BoardSummary[] }
    this.project.boards = body.boards ?? []
    return this.project.boards
  }

  /** 切换活跃画布（按 id 或标题） */
  async switchBoard(idOrTitle: string): Promise<BoardSummary> {
    const boards = await this.listBoards()
    const hit = boards.find((b) => b.id === idOrTitle) ?? boards.find((b) => b.title === idOrTitle)
    if (!hit) {
      throw new Error(`没有叫「${idOrTitle}」的画布。现有：${boards.map((b) => b.title).join('、')}`)
    }
    this.activeId = hit.id
    return hit
  }

  private boardUrlPath(path: string): string {
    const board = this.guardBoard()
    return `${this.base}/p/${encodeURIComponent(this.project.slug)}/${encodeURIComponent(board.id)}${path}`
  }

  async state(): Promise<{ board: Board; revision: number }> {
    const res = await fetch(this.boardUrlPath('/api/state'), { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`读取画板失败：HTTP ${res.status}`)
    return (await res.json()) as { board: Board; revision: number }
  }

  async commit(op: Op, actor: 'agent' | 'human' = 'agent'): Promise<{ revision: number }> {
    const res = await fetch(this.boardUrlPath('/api/op'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, actor }),
      signal: AbortSignal.timeout(15000),
    })
    const body = (await res.json().catch(() => ({}))) as { revision?: number; error?: string }
    if (!res.ok) throw new Error(body.error ?? `操作失败：HTTP ${res.status}`)
    return { revision: body.revision ?? 0 }
  }

  async undo(): Promise<{ ok: boolean; revision: number }> {
    return this.postAction('/api/undo')
  }

  async redo(): Promise<{ ok: boolean; revision: number }> {
    return this.postAction('/api/redo')
  }

  private async postAction(path: string): Promise<{ ok: boolean; revision: number }> {
    const res = await fetch(this.boardUrlPath(path), { method: 'POST', signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`操作失败：HTTP ${res.status}`)
    return (await res.json()) as { ok: boolean; revision: number }
  }

  async restore(board: Board): Promise<{ revision: number }> {
    const res = await fetch(this.boardUrlPath('/api/restore'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ board }),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) throw new Error(`恢复画板失败：HTTP ${res.status}`)
    return (await res.json()) as { revision: number }
  }

  async flush(): Promise<void> {
    await fetch(this.boardUrlPath('/api/flush'), { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => {})
  }

  async screenshot(opts: {
    scale?: number
    region?: { x: number; y: number; w: number; h: number }
    layer?: string
    hideAnnotations?: boolean
  } = {}): Promise<Buffer> {
    const q = new URLSearchParams()
    if (opts.scale) q.set('scale', String(opts.scale))
    if (opts.region) {
      q.set('x', String(opts.region.x))
      q.set('y', String(opts.region.y))
      q.set('w', String(opts.region.w))
      q.set('h', String(opts.region.h))
    }
    if (opts.layer) q.set('layer', opts.layer)
    if (opts.hideAnnotations) q.set('annotations', 'hide')
    const qs = q.toString()
    const res = await fetch(this.boardUrlPath(`/api/screenshot.png${qs ? '?' + qs : ''}`), {
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) throw new Error(`截图失败：HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }

  async svg(): Promise<string> {
    const res = await fetch(this.boardUrlPath('/api/svg'), { signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`导出 SVG 失败：HTTP ${res.status}`)
    return await res.text()
  }
}
