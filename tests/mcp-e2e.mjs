// 端到端：懒创建 + 一个项目多块画布 + 多 agent 共享同一个常驻服务
// 覆盖：首次工具调用才拉守护进程/注册项目（空项目先指引 setup_board）→
//       setup_board 支新画布（不清旧的）→ 同项目多画布隔离与切换 →
//       同项目多会话落在最近更新的画布 → 人类在指定画布上批注 →
//       客户端全关后守护进程仍存活 → 重启恢复 → 按画布定稿导出。
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

async function connect(cwd) {
  const c = new Client({ name: 'e2e-test', version: '0.0.0' })
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
const boardUrl = (port, slug, boardId) =>
  `http://127.0.0.1:${port}/p/${encodeURIComponent(slug)}/${encodeURIComponent(boardId)}/`

// ========== agent A：项目 A，首次工具调用拉起服务（懒创建） ==========
let clientA = await connect(projA)

let r = await clientA.callTool({ name: 'inspect_board', arguments: {} })
assert(r.isError === true && text(r).includes('setup_board'), '空项目先给指引：还没有画布，用 setup_board 支起（而不是悄悄建一块）')

const rt1 = runtime()
assert(!!rt1.port && !!rt1.pid, `守护进程已就绪：端口 ${rt1.port}，pid ${rt1.pid}`)
assert(!!(await health()), '健康检查通过')
const storeDirA = join(home, 'projects', 'proj-a', 'boards')

// ========== 支起第一块画布：设置页 ==========
r = await clientA.callTool({ name: 'setup_board', arguments: { title: '设置页', preset: 'laptop' } })
assert(text(r).includes('新画布已支起') && text(r).includes('设置页'), 'setup_board 支起画布「设置页」')
assert(text(r).includes('1280×800'), '尺寸预设生效（laptop）')
await clientA.callTool({ name: 'layers', arguments: { action: 'switch', name: '线稿' } })
r = await clientA.callTool({ name: 'draw_rect', arguments: { x: 100, y: 100, w: 300, h: 200, radius: 8, fill: '#eef2ff' } })
const rectId = text(r).match(/e\w+/)?.[0]
assert(!!rectId, 'draw_rect 返回图元 id')
await clientA.callTool({ name: 'write_text', arguments: { x: 140, y: 140, content: '设置 Settings', size: 24 } })
await clientA.callTool({ name: 'draw_arrow', arguments: { x1: 420, y1: 200, x2: 500, y2: 150, color: '#ea580c' } })

r = await clientA.callTool({ name: 'look_at_board', arguments: {} })
const img = r.content.find((c) => c.type === 'image')
assert(!!img && img.mimeType === 'image/png' && img.data.length > 3000, 'look_at_board 走守护进程渲染返回 PNG')

// ========== agent B：项目 B（同一守护进程，自动标题画布） ==========
const clientB = await connect(projB)
r = await clientB.callTool({ name: 'inspect_board', arguments: {} })
assert(r.isError === true && text(r).includes('setup_board'), '项目 B 也是空项目（画布不随会话自动创建）')
r = await clientB.callTool({ name: 'setup_board', arguments: {} })
assert(text(r).includes('画布1'), '不传 title 时自动命名「画布1」')
r = await clientB.callTool({ name: 'draw_ellipse', arguments: { x: 50, y: 50, w: 80, h: 80 } })
assert(text(r).includes('椭圆'), '项目 B 独立作图')

const rt2 = runtime()
assert(rt2.port === rt1.port && rt2.pid === rt1.pid, '两个 agent 共享同一个守护进程/端口')
const list0 = await projects(rt1.port)
assert(list0.length === 2, `项目索引里有 2 个项目（${list0.map((p) => p.name).join('、')}）`)

// ========== 项目 A 的第二块画布：登录页（旧画布保留，互不串台） ==========
r = await clientA.callTool({ name: 'setup_board', arguments: { title: '登录页', preset: 'phone' } })
assert(text(r).includes('新画布已支起') && text(r).includes('共 2 块画布'), '同项目再支一块画布「登录页」，旧的保留')
r = await clientA.callTool({ name: 'draw_rect', arguments: { x: 20, y: 100, w: 340, h: 120, radius: 12 } })
r = await clientA.callTool({ name: 'write_text', arguments: { x: 60, y: 140, content: '登录卡片', size: 20 } })
r = await clientA.callTool({ name: 'inspect_board', arguments: {} })
assert(text(r).includes('登录卡片') && !text(r).includes('设置 Settings'), '当前画布是「登录页」，设置页的图元没串进来')
assert(text(r).includes('其他：「设置页」'), 'inspect_board 提示项目里还有哪些画布')

r = await clientA.callTool({ name: 'setup_board', arguments: { title: '登录页' } })
assert(r.isError === true && text(r).includes('已有'), '同标题画布拒绝重复创建')

r = await clientA.callTool({ name: 'list_boards', arguments: {} })
assert(text(r).includes('共 2 块画布') && text(r).includes('「设置页」') && text(r).includes('「登录页」') && text(r).includes('← 当前'), 'list_boards 列出全部画布并标注当前')

r = await clientA.callTool({ name: 'switch_board', arguments: { board: '设置页' } })
assert(text(r).includes('已切到画布「设置页」'), '按标题切换画布')
r = await clientA.callTool({ name: 'inspect_board', arguments: {} })
assert(text(r).includes('设置 Settings') && !text(r).includes('登录卡片'), '切回「设置页」内容完好')
r = await clientA.callTool({ name: 'switch_board', arguments: { board: '登录页' } })
assert(text(r).includes('已切到画布「登录页」'), '按 id 切换（id=登录页）')
r = await clientA.callTool({ name: 'inspect_board', arguments: {} })
assert(text(r).includes('登录卡片'), '按 id 切换也落到同一块画布')

// ========== 同项目第二个会话：默认落在最近更新的画布 ==========
const clientA2 = await connect(projA)
r = await clientA2.callTool({ name: 'inspect_board', arguments: {} })
assert(text(r).includes('登录卡片'), '第二个会话默认落在最近更新的「登录页」')
r = await clientA2.callTool({ name: 'draw_line', arguments: { x1: 20, y1: 300, x2: 360, y2: 300, dash: true } })
assert(text(r).includes('直线'), '第二个 agent 在共享画布上作图')
r = await clientA2.callTool({ name: 'switch_board', arguments: { board: '设置页' } })
assert(text(r).includes('已切到画布「设置页」'), '第二会话也能自由切到别的画布')

// ========== 页面与静态资源 ==========
const projPage = await (await fetch(`http://127.0.0.1:${rt1.port}/p/proj-a/`)).text()
assert(projPage.includes('登录页') && projPage.includes('设置页'), '项目页 /p/proj-a/ 列出两块画布')
const pageLogin = await (await fetch(boardUrl(rt1.port, 'proj-a', '登录页'))).text()
assert(pageLogin.includes('zoom-bar') && pageLogin.includes('board-select'), '画布页可访问且带画布切换器')
for (const f of ['board.js', 'board.css', 'shared/render.js', 'shared/ops.js', 'shared/types.js']) {
  const resp = await fetch(`http://127.0.0.1:${rt1.port}/${f}`)
  assert(resp.ok, `静态资源 /${f}`)
}
const indexHtml = await (await fetch(`http://127.0.0.1:${rt1.port}/`)).text()
assert(indexHtml.includes('proj-a') && indexHtml.includes('proj-b'), '根路径项目索引页列出两个项目')
const stateLogin = await (await fetch(`${boardUrl(rt1.port, 'proj-a', '登录页')}api/state`)).json()
assert(stateLogin.canvas?.id === '登录页' && stateLogin.project?.boards?.length === 2, '画布级 /api/state 带 canvas 与画布清单')
const pngHttp = await (await fetch(`${boardUrl(rt1.port, 'proj-a', '登录页')}api/screenshot.png`)).arrayBuffer()
assert(pngHttp.byteLength > 3000, `/api/screenshot.png（${Math.round(pngHttp.byteLength / 1024)}KB）`)

// ========== 人类：在「登录页」画布上框选写批注 ==========
const ws = new WebSocket(`${boardUrl(rt1.port, 'proj-a', '登录页').replace('http', 'ws')}ws`)
await new Promise((res) => ws.on('open', res))
const init = JSON.parse(await new Promise((res) => (ws.once('message', res))))
assert(init.type === 'init' && init.board.elements.some((e) => e.content === '登录卡片') && init.canvas.id === '登录页', 'WS 只推送当前画布，init 带画布信息')
ws.send(JSON.stringify({
  type: 'op',
  op: {
    type: 'addElement',
    element: {
      id: 'human-anno1', kind: 'annotation', layer: '批注',
      x: 30, y: 110, w: 300, h: 100,
      text: '登录按钮太小，点击区域要加大', n: 1, status: 'open', author: 'human',
    },
  },
}))
const upd = JSON.parse(await new Promise((res) => (ws.once('message', (d) => {
  const m = JSON.parse(d)
  if (m.type === 'update') res(d)
}))))
assert(upd.board.elements.some((e) => e.id === 'human-anno1') && upd.actor === 'human', '人类批注实时广播到这块画布')
r = await clientA.callTool({ name: 'list_annotations', arguments: {} })
assert(text(r).includes('登录按钮太小'), 'agent 读到人类批注（含区域坐标）')
r = await clientA.callTool({ name: 'inspect_board', arguments: {} })
assert(text(r).includes('待处理 1 条'), 'inspect_board 置顶展示待处理批注')
r = await clientA.callTool({ name: 'resolve_annotation', arguments: { numbers: [1] } })
assert(text(r).includes('已解决'), 'resolve_annotation 标记已解决')
ws.close()

// ========== 关掉所有 MCP 客户端：守护进程仍存活，画布按块落盘 ==========
await sleep(400)
assert(existsSync(join(storeDirA, '登录页.json')), '「登录页」存档在用户目录 boards/ 下')
assert(existsSync(join(storeDirA, '设置页.json')), '「设置页」存档独立成文件')
const savedLogin = JSON.parse(readFileSync(join(storeDirA, '登录页.json'), 'utf-8'))
assert(savedLogin.board.elements.some((e) => e.kind === 'annotation'), '存档含人类批注')

await clientA.close()
await clientA2.close()
await clientB.close()
await sleep(600)
assert(!!(await health()), '所有 agent 断开后，守护进程仍常驻（端口不释放）')

// ========== 重启 agent：自动恢复，默认落在最近更新的画布 ==========
clientA = await connect(projA)
r = await clientA.callTool({ name: 'inspect_board', arguments: {} })
assert(text(r).includes('登录卡片') && text(r).includes('登录按钮太小'), '重启后落在「登录页」，画布与批注都还在')
assert(runtime().pid === rt1.pid, '重启的 agent 复用了同一个常驻服务')
r = await clientA.callTool({ name: 'switch_board', arguments: { board: '设置页' } })
assert(text(r).includes('已切到画布「设置页」'), '重启后也能切到「设置页」')
r = await clientA.callTool({ name: 'inspect_board', arguments: {} })
assert(text(r).includes('设置 Settings'), '「设置页」内容持久')
r = await clientA.callTool({ name: 'load_board', arguments: { path: join(storeDirA, '登录页.json') } })
assert(text(r).includes('已恢复到画布「设置页」'), 'load_board 把快照恢复进当前画布')

// ========== 定稿导出：一块画布一份设计包 ==========
r = await clientA.callTool({ name: 'switch_board', arguments: { board: '登录页' } })
r = await clientA.callTool({ name: 'finalize_design', arguments: {} })
assert(text(r).includes('「登录页」'), 'finalize_design 默认导出到 design/<画布标题>/')
const mdLogin = readFileSync(join(projA, 'design', '登录页', 'DESIGN.md'), 'utf-8')
assert(mdLogin.includes('登录卡片'), '登录页 DESIGN.md 含其文案')
r = await clientA.callTool({ name: 'finalize_design', arguments: { dir: join(projA, 'design', 'settings-export') } })
assert(text(r).includes('settings-export'), '显式指定导出目录仍可用')
assert(existsSync(join(projA, 'design', '登录页', 'design.png')), 'design.png 已生成')

// ========== show_board 返回当前画布地址 ==========
r = await clientA.callTool({ name: 'show_board', arguments: { opener: 'none' } })
assert(text(r).includes(`/p/proj-a/${encodeURIComponent('登录页')}/`), 'show_board 返回带项目+画布的地址')

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
