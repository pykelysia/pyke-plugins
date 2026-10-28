// 开发用：在进程内起一个 hub（多项目服务），挂上示例内容，供浏览器联调。
// 注意：使用独立的数据目录，避免和常驻守护进程共享同一份存档。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

process.env.UI_DRAW_HOME = mkdtempSync(join(tmpdir(), 'ui-draw-dev-'))
const { HubServer } = await import('../dist/hub/server.js')

const server = new HubServer()
const port = await server.start(4690)

const reg = await (
  await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectDir: process.cwd() }),
  })
).json()

const slug = reg.slug
async function createBoard(title, width, height) {
  const r = await (
    await fetch(`http://127.0.0.1:${port}/p/${encodeURIComponent(slug)}/api/boards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, width, height, grid: true }),
    })
  ).json()
  return `http://127.0.0.1:${port}/p/${encodeURIComponent(slug)}/${encodeURIComponent(r.board.id)}`
}
async function boardOp(boardUrl, op) {
  await fetch(`${boardUrl}api/op`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op }),
  })
}

// 一个项目两块画布：登录页 + 设置页
const loginUrl = await createBoard('登录页', 390, 844)
await boardOp(loginUrl, { type: 'setActiveLayer', name: '线稿' })
const addLogin = (element) => boardOp(loginUrl, { type: 'addElement', element })
await addLogin({ id: 'demo-card', kind: 'rect', layer: '线稿', x: 30, y: 160, w: 330, h: 380, radius: 12, color: '#1f2937', width: 2 })
await addLogin({ id: 'demo-title', kind: 'text', layer: '线稿', x: 130, y: 220, content: '欢迎回来', size: 24, color: '#1f2937' })
await addLogin({ id: 'demo-btn', kind: 'rect', layer: '线稿', x: 60, y: 440, w: 270, h: 46, radius: 10, color: '#2563eb', width: 2, fill: '#dbeafe' })
await addLogin({ id: 'demo-anno', kind: 'annotation', layer: '批注', x: 30, y: 560, w: 330, h: 90, text: '批注示例：框选区域写说明，agent 会按批注修改', n: 1, status: 'open', author: 'human' })

const settingsUrl = await createBoard('设置页', 1280, 800)
await boardOp(settingsUrl, { type: 'setActiveLayer', name: '线稿' })
const addSettings = (element) => boardOp(settingsUrl, { type: 'addElement', element })
await addSettings({ id: 'demo-title2', kind: 'text', layer: '线稿', x: 560, y: 300, content: '浏览器联调中', size: 26, color: '#1f2937' })

console.log(`画板服务已启动：http://127.0.0.1:${port}`)
console.log(`  登录页：${loginUrl}`)
console.log(`  设置页：${settingsUrl}`)
console.log(`  项目页：http://127.0.0.1:${port}/p/${slug}/ · 项目索引：http://127.0.0.1:${port}/`)
setInterval(() => {}, 1 << 30)
