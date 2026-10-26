// 端到端：多 agent 共享同一个常驻服务
// 覆盖：自动拉起守护进程 → 两个项目各自一块画板 → 同项目多会话共享 → 人类批注 →
//       客户端全关后守护进程仍存活 → 重启恢复 → 定稿导出。
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import WebSocket from 'ws'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const assert = (cond, msg) => {
  if (!cond) throw new Error('❌ ' + msg)
  console.log('✅ ' + msg)
}

const sandbox = mkdtempSync(join(tmpdir(), 'ui-draw-e2e-'))
const home = join(sandbox, 'home')
const projA = join(sandbox, 'proj-a')
const projB = join(sandbox, 'proj-b')
for (const d of [home, projA, projB]) mkdirSync(d, { recursive: true })

const env = { UI_DRAW_HOME: home }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function newClient(cwd) {
  return new Client({ name: 'e2e-test', version: '0.0.0' })
}
async function connect(cwd) {
  const c = newClient(cwd)
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(process.cwd(), 'dist', 'index.js')],
      cwd,
      env,
      stderr: 'ignore',
    }),
  )
  return c
}
const text = (res) => res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
const runtime = () => JSON.parse(readFileSync(join(home, 'runtime.json'), 'utf-8'))
async function health() {
  try {
    const rt = runtime()
    const r = await fetch(`http://127.0.0.1:${rt.port}/api/health`, { signal: AbortSignal.timeout(1000) })
    return r.ok ? await r.json() : null
  } catch {
    return null
  }
}
async function projects(port) {
  const r = await fetch(`http://127.0.0.1:${port}/api/projects`)
  return (await r.json()).projects
}

// ========== agent A：项目 A ==========
let clientA = await connect(projA)

let r = await clientA.callTool({ name: 'inspect_board', arguments: {} })
assert(text(r).includes('0 个图元'), '首次调用自动拉起后台服务并创建项目 A 画板')

const rt1 = runtime()
assert(!!rt1.port && !!rt1.pid, `守护进程已就绪：端口 ${rt1.port}，pid ${rt1.pid}`)
assert(!!(await health()), '健康检查通过')
const storeA = join(home, 'projects', 'proj-a', 'board.json')
assert(text(r).includes(storeA), `项目 A 存档在用户目录：${storeA}`)

r = await clientA.callTool({ name: 'setup_board', arguments: { preset: 'laptop' } })
assert(text(r).includes('画板已支起'), 'setup_board（项目 A）')
await clientA.callTool({ name: 'layers', arguments: { action: 'switch', name: '线稿' } })
r = await clientA.callTool({ name: 'draw_rect', arguments: { x: 100, y: 100, w: 300, h: 200, radius: 8, fill: '#eef2ff' } })
const rectId = text(r).match(/e\w+/)?.[0]
assert(!!rectId, 'draw_rect 返回图元 id')
await clientA.callTool({ name: 'write_text', arguments: { x: 140, y: 140, content: '设置 Settings', size: 24 } })
await clientA.callTool({ name: 'draw_arrow', arguments: { x1: 420, y1: 200, x2: 500, y2: 150, color: '#ea580c' } })

r = await clientA.callTool({ name: 'look_at_board', arguments: {} })
const img = r.content.find((c) => c.type === 'image')
assert(!!img && img.mimeType === 'image/png' && img.data.length > 3000, 'look_at_board 走守护进程渲染返回 PNG')

// ========== agent B：项目 B（同一守护进程、不同端口路径） ==========
const clientB = await connect(projB)
r = await clientB.callTool({ name: 'inspect_board', arguments: {} })
assert(text(r).includes('0 个图元'), '项目 B 是独立画板（0 图元）')
r = await clientB.callTool({ name: 'draw_ellipse', arguments: { x: 50, y: 50, w: 80, h: 80 } })
assert(text(r).includes('椭圆'), '项目 B 独立作图')

const rt2 = runtime()
assert(rt2.port === rt1.port && rt2.pid === rt1.pid, '两个 agent 共享同一个守护进程/端口')
const list = await projects(rt1.port)
assert(list.length === 2, `项目索引里有 2 个项目（${list.map((p) => p.name).join('、')}）`)
const slugA = list.find((p) => p.projectDir === projA)?.slug
const slugB = list.find((p) => p.projectDir === projB)?.slug
assert(!!slugA && !!slugB && slugA !== slugB, `按项目名区分路径：/p/${slugA}/ 与 /p/${slugB}/`)
const boardUrlA = `http://127.0.0.1:${rt1.port}/p/${encodeURIComponent(slugA)}/`
const boardUrlB = `http://127.0.0.1:${rt1.port}/p/${encodeURIComponent(slugB)}/`

// 项目 A 再看一眼：B 的图元没有串进来
r = await clientA.callTool({ name: 'inspect_board', arguments: {} })
assert(text(r).includes('设置 Settings') && !text(r).includes('椭圆'), '项目之间的图元互不串台')
assert(text(r).includes(boardUrlA), '项目 A 的画板地址带项目名')

// ========== 同项目第二个会话（另一个 agent 同时画同一块板） ==========
const clientA2 = await connect(projA)
r = await clientA2.callTool({ name: 'inspect_board', arguments: {} })
assert(text(r).includes('设置 Settings'), '同项目的第二个 agent 看到同一块画板')
r = await clientA2.callTool({ name: 'draw_line', arguments: { x1: 100, y1: 330, x2: 400, y2: 330, dash: true } })
assert(text(r).includes('直线'), '第二个 agent 在共享画板上作图')

// ========== 页面与静态资源 ==========
const page = await (await fetch(boardUrlA)).text()
assert(page.includes('zoom-bar') && page.includes('project-chip'), '项目画板页可访问')
for (const f of ['board.js', 'board.css', 'shared/render.js', 'shared/ops.js', 'shared/types.js']) {
  const resp = await fetch(`http://127.0.0.1:${rt1.port}/${f}`)
  assert(resp.ok, `静态资源 /${f}`)
}
const indexHtml = await (await fetch(`http://127.0.0.1:${rt1.port}/`)).text()
assert(indexHtml.includes('proj-a') && indexHtml.includes('proj-b'), '根路径项目索引页列出两个项目')
const pngHttp = await (await fetch(`${boardUrlA}api/screenshot.png`)).arrayBuffer()
assert(pngHttp.byteLength > 3000, `/api/screenshot.png（${Math.round(pngHttp.byteLength / 1024)}KB）`)

// ========== 人类：项目 A 的页面里框选写批注 ==========
const ws = new WebSocket(`${boardUrlA.replace('http', 'ws')}ws`)
await new Promise((res) => ws.on('open', res))
const init = JSON.parse(await new Promise((res) => (ws.once('message', res))))
assert(init.type === 'init' && init.board.elements.length >= 3 && init.project.name === 'proj-a', 'WS 只推送本项目画板')
ws.send(JSON.stringify({
  type: 'op',
  op: {
    type: 'addElement',
    element: {
      id: 'human-anno1', kind: 'annotation', layer: '批注',
      x: 120, y: 110, w: 260, h: 170,
      text: '登录按钮太小，点击区域要加大', n: 1, status: 'open', author: 'human',
    },
  },
}))
const upd = JSON.parse(await new Promise((res) => (ws.once('message', (d) => {
  const m = JSON.parse(d)
  if (m.type === 'update') res(d)
}))))
assert(upd.board.elements.some((e) => e.id === 'human-anno1') && upd.actor === 'human', '人类批注实时广播')
r = await clientA.callTool({ name: 'list_annotations', arguments: {} })
assert(text(r).includes('登录按钮太小'), 'agent 读到人类批注（含区域坐标）')
r = await clientA.callTool({ name: 'inspect_board', arguments: {} })
assert(text(r).includes('待处理 1 条'), 'inspect_board 置顶展示待处理批注')
r = await clientA.callTool({ name: 'resolve_annotation', arguments: { numbers: [1] } })
assert(text(r).includes('已解决'), 'resolve_annotation 标记已解决')
ws.close()

// ========== 关掉所有 MCP 客户端：守护进程仍存活（这是与旧版的关键差异） ==========
await sleep(400)
assert(existsSync(storeA), '项目 A 已落盘到用户目录')
const savedA = JSON.parse(readFileSync(storeA, 'utf-8'))
assert(savedA.board.elements.some((e) => e.kind === 'annotation'), '存档含人类批注')

await clientA.close()
await clientA2.close()
await clientB.close()
await sleep(600)
assert(!!(await health()), '所有 agent 断开后，守护进程仍常驻（端口不释放）')

// ========== 重启 agent：自动恢复 ==========
clientA = await connect(projA)
r = await clientA.callTool({ name: 'inspect_board', arguments: {} })
assert(text(r).includes('设置 Settings') && text(r).includes('登录按钮太小'), '重启后项目 A 的画板与批注都还在')
assert(runtime().pid === rt1.pid, '重启的 agent 复用了同一个常驻服务')

r = await clientA.callTool({ name: 'setup_board', arguments: { preset: 'phone' } })
assert(r.isError === true && text(r).includes('自动恢复'), 'setup_board 拒绝清掉恢复的画板')
r = await clientA.callTool({ name: 'setup_board', arguments: { preset: 'laptop', force: true } })
assert(!r.isError, 'force=true 才能重来')
r = await clientA.callTool({ name: 'load_board', arguments: { path: storeA } })
assert(text(r).includes('已恢复'), '从用户目录存档恢复画板')

// ========== 定稿导出（写到项目目录） ==========
const designDir = join(projA, 'design')
r = await clientA.callTool({ name: 'finalize_design', arguments: { dir: designDir } })
assert(text(r).includes('DESIGN.md'), 'finalize_design')
const md = readFileSync(join(designDir, 'DESIGN.md'), 'utf-8')
assert(md.includes('设置 Settings') && md.includes('登录按钮太小'), 'DESIGN.md 含文案与批注记录')
const svg = readFileSync(join(designDir, 'design.svg'), 'utf-8')
assert(!svg.includes('登录按钮太小'), 'design.svg 不含批注')
assert(existsSync(join(designDir, 'design.png')), 'design.png 已生成')

// ========== 桌面环境下 show_board 的打开策略 ==========
r = await clientA.callTool({ name: 'show_board', arguments: { opener: 'none' } })
assert(text(r).includes(`/p/${encodeURIComponent(slugA)}/`), 'show_board 返回带项目名的地址')

await clientA.close()
// 清理：杀掉测试用的守护进程，避免影响本机其它会话
try {
  process.kill(rt1.pid)
  console.log('✅ 已清理测试守护进程')
} catch {
  console.log('（测试守护进程已退出）')
}

console.log(`\n端到端全部通过。产物：${sandbox}`)
process.exit(0)
