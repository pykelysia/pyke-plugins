// 开发用：在进程内起一个 hub（多项目服务），挂上示例内容，供浏览器联调。
// 注意：使用独立的数据目录，避免和常驻守护进程共享同一份存档。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
const base = `http://127.0.0.1:${port}/p/${encodeURIComponent(slug)}`
async function op(op) {
  await fetch(`${base}/api/op`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op }),
  })
}

const add = (element) => op({ type: 'addElement', element })
await op({ type: 'setup', width: 1280, height: 800 })
await op({ type: 'setActiveLayer', name: '线稿' })
await add({ id: 'demo-card', kind: 'rect', layer: '线稿', x: 390, y: 200, w: 500, h: 420, radius: 12, color: '#1f2937', width: 2 })
await add({ id: 'demo-title', kind: 'text', layer: '线稿', x: 560, y: 300, content: '浏览器联调中', size: 26, color: '#1f2937' })
await add({ id: 'demo-btn', kind: 'rect', layer: '线稿', x: 470, y: 480, w: 340, h: 46, radius: 10, color: '#2563eb', width: 2, fill: '#dbeafe' })
await add({ id: 'demo-anno', kind: 'annotation', layer: '批注', x: 60, y: 640, w: 420, h: 90, text: '批注示例：框选区域写说明，agent 会按批注修改', n: 1, status: 'open', author: 'human' })

console.log(`画板服务已启动：http://127.0.0.1:${port}（项目页 /p/${slug}/，项目索引 ${port}/）`)
setInterval(() => {}, 1 << 30)
