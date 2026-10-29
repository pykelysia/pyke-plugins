#!/usr/bin/env node
/**
 * ui-draw 常驻守护进程：一个用户一份，所有 agent 共享同一端口。
 * MCP server 会在需要时自动把它拉起来（detached），会话结束后它继续存活。
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { HubServer } from './hub/server.js'
import { dataDir, lockFile, runtimeFile } from './hub/paths.js'
import { DAEMON_VERSION } from './hub/version.js'

interface RuntimeInfo {
  port: number
  pid: number
  version: string
}

const VERSION = DAEMON_VERSION

async function healthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) })
    if (!res.ok) return false
    const body = (await res.json()) as { ok?: boolean; pid?: number }
    return body.ok === true
  } catch {
    return false
  }
}

async function alreadyRunning(): Promise<boolean> {
  try {
    if (!existsSync(runtimeFile())) return false
    const rt = JSON.parse(readFileSync(runtimeFile(), 'utf-8')) as RuntimeInfo
    if (!rt?.port) return false
    return await healthy(rt.port)
  } catch {
    return false
  }
}

async function main() {
  mkdirSync(dataDir(), { recursive: true })
  if (await alreadyRunning()) {
    console.error('[ui-draw daemon] 已有实例在运行，退出')
    cleanupLock()
    process.exit(0)
  }

  const server = new HubServer()
  const port = await server.start(4680)
  const info: RuntimeInfo = { port, pid: process.pid, version: VERSION }
  writeFileSync(runtimeFile(), JSON.stringify(info, null, 2), 'utf-8')
  cleanupLock()
  console.error(`[ui-draw daemon] 已启动：http://127.0.0.1:${port}（pid ${process.pid}）`)

  const shutdown = () => {
    try {
      server.flushAll()
      unlinkSync(runtimeFile())
    } catch {
      /* 忽略 */
    }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('exit', () => {
    try {
      server.flushAll()
    } catch {
      /* 忽略 */
    }
  })
}

function cleanupLock() {
  try {
    unlinkSync(lockFile())
  } catch {
    /* 忽略 */
  }
}

main().catch((err) => {
  console.error('[ui-draw daemon] 启动失败：', err)
  process.exit(1)
})
