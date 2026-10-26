// 冒烟脚本：不经 MCP，直接驱动 BoardService 画一张登录页线框，
// 验证无头渲染 PNG、SVG、DESIGN.md 导出整条链路。
import { BoardService } from '../dist/board/service.js'
import { renderPng } from '../dist/render/raster.js'
import { boardToSvg } from '../dist/render/svg.js'
import { finalizeDesign, loadBoardFile, saveBoardFile } from '../dist/persist.js'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const out = join(tmpdir(), 'ui-draw-smoke')
mkdirSync(out, { recursive: true })

const s = new BoardService()
s.commit({ type: 'setup', width: 1440, height: 900 })

// —— 草稿层：细灰线打布局 ——
const draft = { color: '#9ca3af', width: 1 }
s.commit({ type: 'addElement', element: { id: 'd1', kind: 'line', layer: '草稿', x1: 120, y1: 200, x2: 1320, y2: 200, ...draft } })
s.commit({ type: 'addElement', element: { id: 'd2', kind: 'line', layer: '草稿', x1: 720, y1: 240, x2: 720, y2: 800, ...draft, dash: true } })

// —— 线稿层：正式线框 ——
s.commit({ type: 'setActiveLayer', name: '线稿' })
const ink = { color: '#1f2937', width: 2 }
s.commit({ type: 'addElement', element: { id: 'card', kind: 'rect', layer: '线稿', x: 460, y: 240, w: 520, h: 460, radius: 12, ...ink } })
s.commit({ type: 'addElement', element: { id: 'avatar', kind: 'ellipse', layer: '线稿', x: 660, y: 180, w: 120, h: 120, ...ink, fill: '#eef2ff' } })
s.commit({ type: 'addElement', element: { id: 't-title', kind: 'text', layer: '线稿', x: 640, y: 380, content: '欢迎回来', size: 28, color: '#1f2937' } })
s.commit({ type: 'addElement', element: { id: 'inp1', kind: 'rect', layer: '线稿', x: 520, y: 440, w: 400, h: 44, radius: 8, color: '#6b7280', width: 1.5 } })
s.commit({ type: 'addElement', element: { id: 't-user', kind: 'text', layer: '线稿', x: 540, y: 452, content: '用户名 / 邮箱', size: 14, color: '#6b7280' } })
s.commit({ type: 'addElement', element: { id: 'inp2', kind: 'rect', layer: '线稿', x: 520, y: 508, w: 400, h: 44, radius: 8, color: '#6b7280', width: 1.5 } })
s.commit({ type: 'addElement', element: { id: 't-pwd', kind: 'text', layer: '线稿', x: 540, y: 520, content: '密码', size: 14, color: '#6b7280' } })
s.commit({ type: 'addElement', element: { id: 'btn', kind: 'rect', layer: '线稿', x: 520, y: 588, w: 400, h: 48, radius: 10, color: '#2563eb', width: 2, fill: '#dbeafe' } })
s.commit({ type: 'addElement', element: { id: 't-btn', kind: 'text', layer: '线稿', x: 672, y: 602, content: '登 录', size: 18, color: '#2563eb' } })
s.commit({ type: 'addElement', element: { id: 'note', kind: 'arrow', layer: '线稿', x1: 980, y1: 612, x2: 1060, y2: 560, color: '#ea580c', width: 2 } })
s.commit({ type: 'addElement', element: { id: 't-note', kind: 'text', layer: '线稿', x: 1050, y: 530, content: '主操作按钮', size: 14, color: '#ea580c' } })

// —— 批注层：人类意见 ——
s.commit({ type: 'addElement', element: { id: 'anno1', kind: 'annotation', layer: '批注', x: 470, y: 730, w: 540, h: 110, text: '建议：加一个"忘记密码"链接 —— 来自人类的批注', n: 1, status: 'open', author: 'human' } })
s.commit({ type: 'addElement', element: { id: 'anno2', kind: 'annotation', layer: '批注', x: 1030, y: 520, w: 220, h: 90, text: '主按钮这里再强调一点', n: 2, status: 'open', author: 'agent' } })
s.commit({ type: 'setAnnotationStatus', ids: ['anno2'], status: 'resolved' })

// —— 按 agent 的方式自查/修改 ——
s.commit({ type: 'moveElements', ids: ['t-title'], dx: -30, dy: 0 })
s.undo() // 不满意，撤销
s.redo() // 又要了

// —— 截图验证 ——
const png = renderPng(s.board, { rasterScale: 1 })
const pngPath = join(out, 'board.png')
writeFileSync(pngPath, png)
const pngSize = statSync(pngPath).size
if (pngSize < 5000) throw new Error(`PNG 太小（${pngSize}B），渲染疑似异常`)
console.log(`✅ 无头渲染 PNG ok：${pngPath}（${(pngSize / 1024).toFixed(1)} KB）`)

// —— 局部放大截图 ——
const regionPng = renderPng(s.board, { rasterScale: 2, offsetX: 460, offsetY: 240, regionW: 520, regionH: 460 })
writeFileSync(join(out, 'region.png'), regionPng)
console.log(`✅ 区域截图 ok（${(regionPng.length / 1024).toFixed(1)} KB）`)

// —— SVG：批注不应混进设计矢量图 ——
const svg = boardToSvg(s.board)
if (!svg.includes('<rect') || !svg.includes('欢迎回来') || !svg.includes('<ellipse')) throw new Error('SVG 内容缺失')
if (svg.includes('忘记密码')) throw new Error('SVG 不应包含批注文字')
writeFileSync(join(out, 'board.svg'), svg, 'utf-8')
console.log(`✅ SVG 导出 ok（${(svg.length / 1024).toFixed(1)} KB，已排除批注）`)

// —— 撤销/重做链路 ——
if (s.board.elements.some((e) => e.id === 't-title' && e.x !== 610)) throw new Error('redo 后 t-title 位置不对')
console.log(`✅ 撤销/重做 ok，当前 ${s.board.elements.length} 个图元，第 ${s.revision} 版`)

// —— 存档往返：保存 → 读回 → 状态一致 ——
const savedPath = saveBoardFile(s.board, join(out, '.ui-draw', 'board.json'))
const roundTrip = loadBoardFile(savedPath)
if (roundTrip.elements.length !== s.board.elements.length) throw new Error('存档往返图元数不一致')
const annoAfter = roundTrip.elements.find((e) => e.id === 'anno2')
if (!annoAfter || annoAfter.status !== 'resolved') throw new Error('存档往返丢失批注状态')
s.restore(roundTrip)
if (s.board.elements.length !== roundTrip.elements.length) throw new Error('restore 后状态不一致')
console.log(`✅ 持久化往返 ok：${savedPath}（含批注状态）`)

// —— 定稿设计包 ——
const files = finalizeDesign(s.board, join(out, 'design'))
for (const f of files) {
  const size = statSync(f).size
  if (size < 200) throw new Error(`${f} 内容为空`)
  console.log(`✅ 设计包 ${f}（${(size / 1024).toFixed(1)} KB）`)
}
const md = (await import('node:fs')).readFileSync(files[3], 'utf-8')
if (!md.includes('欢迎回来') || !md.includes('图层「线稿」')) throw new Error('DESIGN.md 内容缺失')
if (!md.includes('过程批注') || !md.includes('忘记密码')) throw new Error('DESIGN.md 应记录批注反馈')
console.log('✅ DESIGN.md 含坐标、文案清单与批注记录')

console.log(`\n冒烟通过。产物目录：${out}`)
