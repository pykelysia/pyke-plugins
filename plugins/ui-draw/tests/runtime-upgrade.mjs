// npm run test:upgrade -- <installed 0.4.0 plugin directory, with node_modules>
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import WebSocket from 'ws'
import { once } from 'node:events'

const root = process.cwd()
const legacy = process.argv[2]
if (!legacy || !existsSync(join(legacy, 'node_modules', '@napi-rs', 'canvas'))) {
  throw new Error('请传入已安装运行时依赖的 ui-draw 0.4.0 插件目录')
}

const sandbox = mkdtempSync(join(tmpdir(), 'ui-draw-upgrade-'))
const home = join(sandbox, 'home')
const project = join(sandbox, 'project')
const runtimeFile = join(home, 'runtime.json')
const env = { UI_DRAW_HOME: home, UI_DRAW_PROJECT_DIR: project }
const clients = []
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const runtime = () => readJson(runtimeFile)
const active = () => readJson(join(home, 'active-release.json')).build
const text = (result) => result.content.map((item) => item.text ?? '').join('\n')
const stop = () => {
  const child = spawnSync(process.execPath, [join(root, 'scripts', 'stop-daemon.mjs')], {
    env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 25_000,
  })
  assert.equal(child.status, 0, child.stderr || child.error?.message)
  return child.stdout
}

function copyPlugin(source, name, version) {
  const target = join(sandbox, name)
  mkdirSync(target)
  for (const file of ['dist', 'web', 'scripts', 'package.json', 'package-lock.json']) {
    cpSync(join(source, file), join(target, file), { recursive: true })
  }
  if (version) {
    const file = join(target, 'package.json')
    writeFileSync(file, JSON.stringify({ ...readJson(file), version }))
  } else {
    cpSync(join(source, 'node_modules'), join(target, 'node_modules'), { recursive: true })
  }
  return target
}

async function connect(cache) {
  const client = new Client({ name: 'upgrade-test', version: '1.0.0' })
  clients.push(client)
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(cache, 'scripts', 'run.mjs')],
    cwd: cache,
    env: { ...env, PLUGIN_ROOT: cache },
    stderr: 'inherit',
  }), { timeout: 90_000 })
  return client
}

async function tool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args })
  assert.ok(!result.isError, text(result))
  return result
}

let ws
try {
  mkdirSync(home)
  mkdirSync(project)

  const oldCache = copyPlugin(resolve(legacy), 'legacy-cache')
  const oldClient = await connect(oldCache)
  const created = await tool(oldClient, 'setup_board', { title: '旧版迁移' })
  const boardUrl = text(created).match(/http:\/\/127\.0\.0\.1:\d+\/p\/[^\s]+\//)?.[0]
  assert.ok(boardUrl)
  await tool(oldClient, 'write_text', { x: 40, y: 60, content: 'legacy content' })
  await oldClient.close()

  const retiredCache = join(sandbox, 'legacy-retired')
  if (process.platform === 'win32') assert.throws(() => renameSync(oldCache, retiredCache), { code: 'EBUSY' })
  assert.match(stop(), /已停止/)
  assert.ok(!existsSync(runtimeFile))
  renameSync(oldCache, retiredCache)
  console.log('通过：旧版写入画板，安全停止后可替换缓存目录')

  writeFileSync(runtimeFile, JSON.stringify({ pid: process.pid, port: 4680, version: 'stale' }))
  assert.match(stop(), /没有找到/)
  console.log('通过：停止脚本跳过已复用的陈旧 PID')

  const cache = copyPlugin(root, 'market-cache', '0.5.0')
  const [first, peer] = await Promise.all([connect(cache), connect(cache)])
  assert.equal(runtime().version, 'stale', 'MCP 启动保持懒加载')
  for (const result of await Promise.all([tool(first, 'list_boards'), tool(peer, 'list_boards')])) {
    assert.match(text(result), /旧版迁移/)
  }
  const original = runtime()
  const originalBuild = active()
  assert.equal(original.build, originalBuild)
  assert.match(originalBuild, /^0\.5\.0-/)
  const boardPath = new URL(boardUrl).pathname
  const url = `http://127.0.0.1:${original.port}${boardPath}`
  const base = new URL(url).origin
  assert.equal((await fetch(base + '/api/shutdown', { method: 'POST' })).status, 403)
  assert.ok(!('token' in await fetch(base + '/api/health').then((res) => res.json())))
  assert.match(text(await tool(first, 'inspect_board')), /legacy content/)
  ws = new WebSocket(url.replace('http:', 'ws:') + 'ws')
  await once(ws, 'message')

  const previous = join(sandbox, 'market-retired')
  renameSync(cache, previous)
  assert.ok((await tool(first, 'look_at_board')).content.some((item) => item.type === 'image'))
  assert.equal(runtime().pid, original.pid)
  console.log('通过：MCP 与守护进程继续服务时，Windows 可替换插件缓存')

  const boardDisconnected = once(ws, 'close')
  const upgraded = await connect(copyPlugin(root, 'market-cache', '0.5.1'))
  await boardDisconnected
  const newRuntime = runtime()
  assert.notEqual(newRuntime.pid, original.pid)
  assert.equal(newRuntime.port, original.port)
  assert.match(active(), /^0\.5\.1-/)
  const reconnected = new WebSocket(url.replace('http:', 'ws:') + 'ws')
  ws = reconnected
  const [snapshot] = await once(ws, 'message')
  assert.match(String(snapshot), /legacy content/)
  assert.match(text(await tool(first, 'inspect_board')), /legacy content/)
  const oldLauncher = await connect(previous)
  await tool(oldLauncher, 'list_boards')
  assert.equal(runtime().pid, newRuntime.pid)
  assert.equal(active(), newRuntime.build)
  console.log('通过：新版接管同一端口，画板与旧会话重连，旧启动器无法降级')

  await tool(upgraded, 'write_text', { x: 50, y: 130, content: 'saved through rollback' })
  const broken = copyPlugin(root, 'broken-cache', '0.5.2')
  const daemon = join(broken, 'dist', 'daemon.js')
  writeFileSync(daemon, "if (!process.argv.includes('--check')) process.exit(42)\n")
  const fallback = await connect(broken)
  const restored = runtime()
  assert.notEqual(restored.pid, newRuntime.pid, '候选版本失败后重新启动上一版')
  assert.equal(restored.port, newRuntime.port)
  assert.equal(restored.build, newRuntime.build)
  assert.equal(active(), newRuntime.build)
  assert.match(text(await tool(fallback, 'inspect_board')), /saved through rollback/)
  assert.match(text(await tool(first, 'inspect_board')), /saved through rollback/)
  console.log('通过：候选守护进程启动失败，上一版恢复服务且保留画板修改')

  const blockedSave = join(home, 'projects', 'project', 'boards.json.tmp')
  mkdirSync(blockedSave)
  try {
    const refused = await connect(copyPlugin(root, 'blocked-save-cache', '0.5.3'))
    assert.equal(runtime().pid, restored.pid, '保存失败时保留正在运行的进程')
    assert.equal(active(), restored.build)
    assert.match(text(await tool(refused, 'inspect_board')), /saved through rollback/)
    console.log('通过：画板保存失败时取消停机，旧版继续服务')
  } finally {
    rmSync(blockedSave, { recursive: true })
  }
} finally {
  ws?.terminate()
  await Promise.allSettled(clients.map((client) => client.close()))
  try {
    stop()
  } finally {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
