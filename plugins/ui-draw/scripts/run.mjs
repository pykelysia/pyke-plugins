#!/usr/bin/env node
/**
 * 插件入口：确保运行时依赖就绪后启动 ui-draw MCP server。
 *
 * 插件被安装到 agent 的插件缓存目录时通常不会带 node_modules，
 * 所以首次运行在这里自动补装「仅运行时依赖」——dist 已随仓库提交，无需构建。
 * 如果你是在源码仓库里直接运行（已经 npm install 过），这里会立即跳过。
 */
import { closeSync, existsSync, openSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const log = (msg) => process.stderr.write(`[ui-draw] ${msg}\n`)
const runtimeRequire = createRequire(join(root, 'dist', 'index.js'))

const REQUIRED = [
  '@modelcontextprotocol/sdk/server/mcp.js',
  '@napi-rs/canvas',
  'ws',
  'zod',
]

function depsReady() {
  return REQUIRED.every((p) => {
    try {
      runtimeRequire.resolve(p)
      return true
    } catch {
      return false
    }
  })
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function ensureDeps() {
  if (depsReady()) return true
  const lock = join(root, '.install.lock')
  let acquired = false
  try {
    writeFileSync(lock, String(process.pid), { flag: 'wx' })
    acquired = true
  } catch {
    /* 另一个进程正在装 */
  }

  if (acquired) {
    log('首次运行：安装运行时依赖（npm install --omit=dev，只需一次）…')
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const res = spawnSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'inherit'],
      shell: process.platform === 'win32',
      timeout: 10 * 60 * 1000,
    })
    try {
      unlinkSync(lock)
    } catch {
      /* 忽略 */
    }
    if (res.status !== 0) {
      log('依赖安装失败（可能是网络问题）。请手动执行：')
      log(`  cd "${root}" && npm install --omit=dev`)
      return false
    }
    return depsReady()
  }

  // 等另一个进程装完（最多 3 分钟）
  for (let i = 0; i < 180; i++) {
    if (depsReady()) return true
    sleep(1000)
    if (!existsSync(lock)) break
  }
  return depsReady()
}

async function main() {
  if (!ensureDeps()) process.exit(1)
  const entry = join(root, 'dist', 'index.js')
  if (!existsSync(entry)) {
    log(`找不到 ${entry}。若从源码运行，请先执行 npm install && npm run build。`)
    process.exit(1)
  }
  await import(pathToFileURL(entry).href)
}

main().catch((err) => {
  log(`启动失败：${err instanceof Error ? err.stack || err.message : String(err)}`)
  process.exit(1)
})
