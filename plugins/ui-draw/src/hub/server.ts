import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { Op } from '../board/ops.js'
import { Board } from '../board/types.js'
import { renderPng, boundedRasterScale } from '../render/raster.js'
import { BOARD_MAX_HEIGHT, BOARD_MAX_WIDTH, validateBoardDimensions } from '../board/ops.js'
import { boardToSvg } from '../render/svg.js'
import { ProjectRegistry, ProjectRuntime, BoardRuntime } from './projects.js'
import { DAEMON_VERSION } from './version.js'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

function findWebDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, '..', '..', 'web'), // dist/hub/server.js → 项目根/web
    join(process.cwd(), 'web'),
  ]
  for (const c of candidates) {
    if (existsSync(join(c, 'index.html'))) return c
  }
  throw new Error('找不到 web/ 画板页面目录')
}

/**
 * ui-draw 守护进程：一个进程、一个端口，服务所有项目/所有 agent。
 * 项目挂在 /p/<项目名>/ 下，一个项目可有多块画布（一个界面一块），
 * 每块画布挂在 /p/<项目名>/<画布>/ 下，独立状态与撤销历史。
 */
export class HubServer {
  private http = createServer((req, res) => this.handleHttp(req, res))
  private wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 })
  private registry = new ProjectRegistry()
  private runtimes = new Map<string, ProjectRuntime>()
  private clients = new Map<string, Set<WebSocket>>()
  port = 0
  private started = false

  constructor() {
    this.http.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head))
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`
  }

  async start(from = 4680): Promise<number> {
    if (this.started) return this.port
    this.started = true
    this.port = await this.listen(from)
    // 项目运行时懒加载：只在被访问（页面/API/工具）时才读它的画布索引
    return this.port
  }

  private listen(from: number): Promise<number> {
    return new Promise((ok, fail) => {
      const tryPort = (port: number) => {
        if (port > from + 20) return fail(new Error('没有可用端口（4680-4700）'))
        const onError = () => {
          this.http.removeListener('listening', onListening)
          tryPort(port + 1)
        }
        const onListening = () => {
          this.http.removeListener('error', onError)
          ok(port)
        }
        this.http.once('error', onError)
        this.http.once('listening', onListening)
        this.http.listen(port, '127.0.0.1')
      }
      tryPort(from)
    })
  }

  async stop(): Promise<void> {
    for (const rt of this.runtimes.values()) rt.dispose()
    this.wss.close()
    await new Promise<void>((ok) => this.http.close(() => ok()))
    this.started = false
  }

  flushAll() {
    for (const rt of this.runtimes.values()) rt.flush()
  }

  // ---------- 项目 / 画布 ----------

  /** 广播与变更跟踪都用「项目/画布」作为键 */
  private boardKey(slug: string, boardId: string): string {
    return `${slug}\u0000${boardId}`
  }

  private ensureRuntime(slug: string): ProjectRuntime | undefined {
    const existing = this.runtimes.get(slug)
    if (existing) return existing
    const meta = this.registry.get(slug)
    if (!meta) return undefined
    const rt = new ProjectRuntime(meta)
    this.runtimes.set(slug, rt)
    rt.onBoardCommit = (brt) => {
      this.registry.touch(slug)
      const key = this.boardKey(slug, brt.id)
      this.broadcast(key, {
        type: 'update',
        board: brt.service.board,
        revision: brt.service.revision,
        actor: this.lastActor.get(key) ?? 'agent',
        changedIds: this.lastChanged.get(key) ?? [],
      })
    }
    return rt
  }

  private ensureBoard(slug: string, boardId: string): BoardRuntime | undefined {
    return this.ensureRuntime(slug)?.board(boardId)
  }

  private runtimesState(): Record<string, unknown>[] {
    return this.registry.list().map((meta) => {
      const rt = this.ensureRuntime(meta.slug)
      const boards = rt?.listBoards() ?? []
      return {
        slug: meta.slug,
        name: meta.name,
        projectDir: meta.projectDir,
        boards: boards.length,
        elements: boards.reduce((sum, b) => sum + b.elements, 0),
        updatedAt: meta.updatedAt,
      }
    })
  }

  private autoBoardTitle(rt: ProjectRuntime): string {
    let n = rt.boardCount + 1
    while (rt.listBoards().some((b) => b.title === `画布${n}`)) n++
    return `画布${n}`
  }

  // ---------- HTTP ----------

  private handleHttp(req: IncomingMessage, res: ServerResponse) {
    Promise.resolve()
      .then(() => this.route(req, res))
      .catch((err) => json(res, 500, { error: err instanceof Error ? err.message : String(err) }))
  }

  private async route(req: IncomingMessage, res: ServerResponse) {
    const u = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)
    const pathname = decodeURIComponent(u.pathname)

    if (pathname === '/api/health') {
      json(res, 200, { ok: true, name: 'ui-draw', version: DAEMON_VERSION, pid: process.pid })
      return
    }
    if (pathname === '/api/projects') {
      if (req.method === 'POST') {
        const body = await readJson(req)
        if (!body?.projectDir || typeof body.projectDir !== 'string') {
          json(res, 400, { error: '缺少 projectDir' })
          return
        }
        const meta = this.registry.register(resolve(String(body.projectDir)))
        const rt = this.ensureRuntime(meta.slug)!
        json(res, 200, {
          slug: meta.slug,
          name: meta.name,
          projectDir: meta.projectDir,
          boards: rt.listBoards(),
          boardUrlBase: `${this.url}/p/${encodeURIComponent(meta.slug)}/`,
        })
        return
      }
      json(res, 200, { projects: this.runtimesState() })
      return
    }
    if (pathname === '/' || pathname === '') {
      this.serveProjectsIndex(res)
      return
    }

    const m = pathname.match(/^\/p\/([^/]+)(\/.*)?$/)
    if (m) {
      const slug = m[1]
      const rest = m[2] || '/'
      const rt = this.ensureRuntime(slug)
      if (!rt) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<h1>项目不存在</h1><p>${escapeHtml(slug)} 还没有注册。让 agent 在对应项目里调用 ui-draw 画板工具即可创建。</p>`)
        return
      }

      // ---- 项目级：画布清单与新建 ----
      if (rest === '/api/boards') {
        if (req.method === 'POST') {
          const body = (await readJson(req)) as { title?: string; width?: number; height?: number; grid?: boolean }
          const title = typeof body?.title === 'string' && body.title.trim() ? body.title.trim() : this.autoBoardTitle(rt)
          const width = body?.width ?? 1440
          const height = body?.height ?? 900
          try {
            validateBoardDimensions(width, height)
            const brt = rt.createBoard(title, { width, height, grid: body?.grid !== false })
            json(res, 200, {
              board: { id: brt.id, title: brt.title },
              boards: rt.listBoards(),
              boardUrl: `${this.url}/p/${encodeURIComponent(slug)}/${encodeURIComponent(brt.id)}/`,
            })
          } catch (err) {
            json(res, 409, { error: err instanceof Error ? err.message : String(err) })
          }
          return
        }
        json(res, 200, { boards: rt.listBoards() })
        return
      }
      if (rest === '/' || rest === '') {
        this.serveProjectBoardsPage(res, rt)
        return
      }

      // ---- 画布级：/p/<项目>/<画布>/… ----
      const bm = rest.match(/^\/([^/]+)(\/.*)?$/)
      if (!bm) {
        this.serveStatic(rest, res)
        return
      }
      const boardId = bm[1]
      const brt = this.ensureBoard(slug, boardId)
      if (!brt) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(
          `<h1>画布不存在</h1><p>项目「${escapeHtml(rt.meta.name)}」里没有画布 ${escapeHtml(boardId)}。</p>` +
            `<p><a href="/p/${encodeURIComponent(slug)}/">回到项目画布列表</a></p>`,
        )
        return
      }
      const key = this.boardKey(slug, brt.id)
      const brest = bm[2] || '/'
      if (brest === '/' || brest === '') {
        this.serveFile(res, 'index.html', 'text/html; charset=utf-8')
        return
      }
      if (brest === '/api/state') {
        json(res, 200, {
          board: brt.service.board,
          revision: brt.service.revision,
          canvas: { id: brt.id, title: brt.title },
          project: {
            slug: rt.meta.slug,
            name: rt.meta.name,
            projectDir: rt.meta.projectDir,
            boards: rt.listBoards().map((b) => ({ id: b.id, title: b.title })),
          },
        })
        return
      }
      if (brest === '/api/op' && req.method === 'POST') {
        const body = (await readJson(req)) as { op?: Op; actor?: 'agent' | 'human' }
        if (!body?.op) {
          json(res, 400, { error: '缺少 op' })
          return
        }
        const actor = body.actor === 'human' ? 'human' : 'agent'
        this.trackChange(key, body.op, actor)
        brt.service.commit(body.op, actor)
        json(res, 200, { ok: true, revision: brt.service.revision })
        return
      }
      if ((brest === '/api/undo' || brest === '/api/redo') && req.method === 'POST') {
        this.trackChange(key, { type: 'undo' as never }, 'agent')
        const done = brest === '/api/undo' ? brt.service.undo() : brt.service.redo()
        json(res, 200, { ok: done, revision: brt.service.revision })
        return
      }
      if (brest === '/api/screenshot.png') {
        const q = u.searchParams
        const regionW = q.get('w') ? clampNum(q.get('w'), 1, BOARD_MAX_WIDTH, brt.service.board.width) : undefined
        const regionH = q.get('h') ? clampNum(q.get('h'), 1, BOARD_MAX_HEIGHT, brt.service.board.height) : undefined
        const scale = boundedRasterScale(regionW ?? brt.service.board.width, regionH ?? brt.service.board.height, clampNum(q.get('scale'), 0.5, 3, 1))
        const png = renderPng(brt.service.board, {
          rasterScale: scale,
          offsetX: clampNum(q.get('x'), -BOARD_MAX_HEIGHT, BOARD_MAX_HEIGHT, 0),
          offsetY: clampNum(q.get('y'), -BOARD_MAX_HEIGHT, BOARD_MAX_HEIGHT, 0),
          regionW,
          regionH,
          ...(q.get('layer') ? { layerFilter: (l: { name: string }) => l.name === q.get('layer') } : {}),
          ...(q.get('annotations') === 'hide' ? { skipAnnotations: true } : {}),
        })
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'X-Ui-Draw-Scale': String(scale) })
        res.end(png)
        return
      }
      if (brest === '/api/svg') {
        const svg = boardToSvg(brt.service.board)
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' })
        res.end(svg)
        return
      }
      if (brest === '/api/restore' && req.method === 'POST') {
        const body = (await readJson(req)) as { board?: Board }
        if (!body?.board) {
          json(res, 400, { error: '缺少 board' })
          return
        }
        brt.service.commit({ type: 'load', board: body.board }, 'agent')
        json(res, 200, { ok: true, revision: brt.service.revision })
        return
      }
      if (brest === '/api/flush' && req.method === 'POST') {
        brt.flush()
        json(res, 200, { ok: true })
        return
      }
      this.serveStatic(brest, res)
      return
    }

    // 根路径静态资源（页面里用绝对路径引用）
    this.serveStatic(pathname, res)
  }

  private serveStatic(rest: string, res: ServerResponse) {
    const rel = rest.replace(/^\/+/, '')
    if (rel.startsWith('api/')) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '未知接口' }))
      return
    }
    this.serveFile(res, rel || 'index.html')
  }

  private serveFile(res: ServerResponse, rel: string, contentType?: string) {
    let webDir: string
    try {
      webDir = findWebDir()
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(String(err))
      return
    }
    const abs = normalize(join(webDir, rel))
    if (!abs.startsWith(webDir) || !existsSync(abs) || statSync(abs).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    const type = contentType ?? MIME[extname(abs)] ?? 'application/octet-stream'
    // 本地工具不为缓存付出代价：页面与脚本一律不缓存，
    // 且页面里的资源引用带时间戳，升级后立刻拿到新版本。
    if (rel === 'index.html') {
      const stamp = `${DAEMON_VERSION}-${process.pid}`
      const html = readFileSync(abs, 'utf-8')
        .replace('href="/board.css"', `href="/board.css?v=${stamp}"`)
        .replace('src="/board.js"', `src="/board.js?v=${stamp}"`)
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' })
      res.end(html)
      return
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' })
    res.end(readFileSync(abs))
  }

  private serveProjectsIndex(res: ServerResponse) {
    const projects = this.runtimesState() as Array<{
      slug: string
      name: string
      projectDir: string
      boards: number
      elements: number
      updatedAt: string
    }>
    const rows = projects
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map(
        (p) => `<li>
        <a class="name" href="/p/${encodeURIComponent(p.slug)}/">${escapeHtml(p.name)}</a>
        <span class="meta">${p.boards} 块画布 · ${p.elements} 个图元 · ${escapeHtml(p.updatedAt.replace('T', ' ').slice(0, 16))}</span>
        <span class="dir">${escapeHtml(p.projectDir)}</span>
      </li>`,
      )
      .join('\n')
    const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>ui-draw 项目</title>
<style>
:root{color-scheme:light}
body{font:14px/1.6 "Microsoft YaHei","PingFang SC",sans-serif;background:#eef1f5;color:#1f2937;margin:0;padding:40px 24px}
main{max-width:760px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:24px 28px;box-shadow:0 2px 18px rgba(15,23,42,.08)}
h1{font-size:20px;margin:0 0 4px}
p.sub{color:#6b7280;margin:0 0 20px;font-size:13px}
ul{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:10px}
li{border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:2px}
li:hover{border-color:#2563eb}
a.name{font-weight:700;color:#2563eb;text-decoration:none;font-size:15px}
span.meta{color:#6b7280;font-size:12px}
span.dir{color:#9ca3af;font-size:11px;font-family:ui-monospace,Consolas,monospace}
.empty{color:#6b7280;font-size:13px;border:1px dashed #e5e7eb;border-radius:10px;padding:16px}
</style></head>
<body><main>
<h1>🎨 ui-draw 项目</h1>
<p class="sub">所有 agent 共享这一个服务；每个项目可有多块画布（一个界面一块），数据存放在用户目录 <code>~/.ui-draw/projects/</code>。</p>
${projects.length ? `<ul>${rows}</ul>` : '<div class="empty">还没有项目。让 agent 在项目里调用 ui-draw 画板工具，这里就会出现入口。</div>'}
</main></body></html>`
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  }

  /** /p/<项目>/ ：这个项目的画布列表页 */
  private serveProjectBoardsPage(res: ServerResponse, rt: ProjectRuntime) {
    const boards = rt.listBoards().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    const rows = boards
      .map(
        (b) => `<li>
        <a class="name" href="/p/${encodeURIComponent(rt.meta.slug)}/${encodeURIComponent(b.id)}/">${escapeHtml(b.title)}</a>
        <span class="meta">${b.width}×${b.height} · ${b.elements} 个图元 · ${escapeHtml(b.updatedAt.replace('T', ' ').slice(0, 16))}</span>
      </li>`,
      )
      .join('\n')
    const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(rt.meta.name)} · ui-draw</title>
<style>
:root{color-scheme:light}
body{font:14px/1.6 "Microsoft YaHei","PingFang SC",sans-serif;background:#eef1f5;color:#1f2937;margin:0;padding:40px 24px}
main{max-width:760px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:24px 28px;box-shadow:0 2px 18px rgba(15,23,42,.08)}
h1{font-size:20px;margin:0 0 4px}
p.sub{color:#6b7280;margin:0 0 20px;font-size:13px}
ul{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:10px}
li{border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:2px}
li:hover{border-color:#2563eb}
a.name{font-weight:700;color:#2563eb;text-decoration:none;font-size:15px}
span.meta{color:#6b7280;font-size:12px}
span.dir{color:#9ca3af;font-size:11px;font-family:ui-monospace,Consolas,monospace}
.empty{color:#6b7280;font-size:13px;border:1px dashed #e5e7eb;border-radius:10px;padding:16px}
a.back{color:#6b7280;text-decoration:none;font-size:13px;display:inline-block;margin-bottom:12px}
</style></head>
<body><main>
<a class="back" href="/">← 所有项目</a>
<h1>🎨 ${escapeHtml(rt.meta.name)}</h1>
<p class="sub">一个界面一块画布；画新界面让 agent <code>setup_board</code> 支起。<span class="dir">${escapeHtml(rt.meta.projectDir)}</span></p>
${boards.length ? `<ul>${rows}</ul>` : '<div class="empty">这个项目还没有画布。让 agent 调用 setup_board 支起第一块。</div>'}
</main></body></html>`
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  }

  // ---------- WebSocket ----------

  private lastActor = new Map<string, 'agent' | 'human'>()
  private lastChanged = new Map<string, string[]>()

  private trackChange(key: string, op: Op, actor: 'agent' | 'human' = 'agent') {
    this.lastActor.set(key, actor)
    const ids: string[] = []
    if (op.type === 'addElement') ids.push(op.element.id)
    else if (op.type === 'addElements') ids.push(...op.elements.map((e) => e.id))
    else if (op.type === 'deleteElements' || op.type === 'moveElements' || op.type === 'setAnnotationStatus') ids.push(...op.ids)
    this.lastChanged.set(key, ids)
  }

  private handleUpgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) {
    const u = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)
    const m = decodeURIComponent(u.pathname).match(/^\/p\/([^/]+)\/([^/]+)\/ws$/)
    if (!m) {
      socket.destroy()
      return
    }
    const brt = this.ensureBoard(m[1], m[2])
    if (!brt) {
      socket.destroy()
      return
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onWs(ws, m[1], brt))
  }

  private onWs(ws: WebSocket, slug: string, brt: BoardRuntime) {
    const rt = this.ensureRuntime(slug)!
    const key = this.boardKey(slug, brt.id)
    let set = this.clients.get(key)
    if (!set) {
      set = new Set()
      this.clients.set(key, set)
    }
    set.add(ws)
    ws.send(
      JSON.stringify({
        type: 'init',
        board: brt.service.board,
        revision: brt.service.revision,
        canvas: { id: brt.id, title: brt.title },
        project: { slug, name: rt.meta.name, boards: rt.listBoards().map((b) => ({ id: b.id, title: b.title })) },
      }),
    )

    ws.on('message', (data) => {
      let msg: unknown
      try {
        msg = JSON.parse(String(data))
      } catch {
        return
      }
      const m = msg as { type?: string; op?: Op }
      try {
        if (m.type === 'op' && m.op) {
          this.trackChange(key, m.op, 'human')
          brt.service.commit(m.op, 'human')
          this.sendTo(ws, { type: 'ok', revision: brt.service.revision })
        } else if (m.type === 'undo') {
          this.trackChange(key, { type: 'undo' as never }, 'human')
          brt.service.undo()
        } else if (m.type === 'redo') {
          this.trackChange(key, { type: 'redo' as never }, 'human')
          brt.service.redo()
        }
      } catch (err) {
        this.sendTo(ws, { type: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    })
    ws.on('close', () => set?.delete(ws))
  }

  private sendTo(ws: WebSocket, msg: unknown) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  private broadcast(key: string, msg: unknown) {
    const raw = JSON.stringify(msg)
    for (const ws of this.clients.get(key) ?? []) {
      if (ws.readyState === WebSocket.OPEN) ws.send(raw)
    }
  }
}

function clampNum(raw: string | null, min: number, max: number, fallback: number): number {
  const n = raw === null ? NaN : Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function json(res: ServerResponse, code: number, body: unknown) {
  const raw = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(raw)
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > 64 * 1024 * 1024) {
        fail(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : null)
      } catch {
        ok(null)
      }
    })
    req.on('error', fail)
  })
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
