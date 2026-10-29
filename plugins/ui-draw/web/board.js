// ui-draw 人类端画板：与 agent 共享同一份状态（服务端权威，WS 双向同步）
import { renderBoard } from './shared/render.js'
import { elementBBox, hitElement } from './shared/ops.js'

const boardCanvas = document.getElementById('board-canvas')
const overlayCanvas = document.getElementById('overlay-canvas')
const stage = document.getElementById('stage')
const textInput = document.getElementById('text-input')
const boardCtx = boardCanvas.getContext('2d')
const overlayCtx = overlayCanvas.getContext('2d')

// ---------- 状态 ----------
let board = null
let revision = 0
const deviceDpr = window.devicePixelRatio || 1
// Both canvases cover the entire board. Cap each backing store so zooming a
// long board cannot allocate an enormous bitmap or exceed common edge limits.
const MAX_CANVAS_EDGE = 8192
const MAX_CANVAS_PIXELS = 16_000_000
let backingScaleX = deviceDpr
let backingScaleY = deviceDpr
let tool = 'select'
let color = '#1f2937'
let width = 2
let dash = false
let fillOn = false
let fillColor = '#eef2ff'
let fontSize = 16
let selection = new Set() // 图元 id
let gesture = null        // 进行中的手势
let pendingEls = []       // 已提交、等服务器回声的图元
let eraseHits = new Set()
const animating = new Map() // id -> { start, dur }
const imageCache = new Map() // id -> HTMLImageElement
let flash = null          // 批注定位高亮 { box, until }
let boardSig = ''

// 视口：zoom = 屏幕像素/画板像素，tx/ty = 画板原点在舞台内的偏移
const view = { zoom: 1, tx: 0, ty: 0 }
const MIN_ZOOM = 0.1
const MAX_ZOOM = 6

const uid = () => 'h' + crypto.randomUUID().replace(/-/g, '').slice(0, 10)

// ---------- 小工具 ----------
let toastTimer = null
function toast(msg) {
  const el = document.getElementById('toast')
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200)
}

const snap = (n) => Math.round(n)
const clamp = (n, a, b) => Math.min(b, Math.max(a, n))

function normRect(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }
}

function unionBBox(els) {
  const boxes = els.map(elementBBox)
  if (boxes.length === 0) return null
  const x = Math.min(...boxes.map((b) => b.x))
  const y = Math.min(...boxes.map((b) => b.y))
  const x2 = Math.max(...boxes.map((b) => b.x + b.w))
  const y2 = Math.max(...boxes.map((b) => b.y + b.h))
  return { x, y, w: x2 - x, h: y2 - y }
}

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text)
    toast(okMsg)
    return
  } catch {
    /* 退化为 execCommand */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
    toast(okMsg)
  } catch {
    toast('复制失败，请手动选择文本复制')
  }
}

// ---------- WebSocket ----------
// 页面地址形如 /p/<项目名>/，API 与 WS 都用相对路径，天然按项目隔离
const API_BASE = new URL('.', location.href).pathname.replace(/\/$/, '') + '/'
let ws = null
let wsTimer = null
function connectWs() {
  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${API_BASE.replace(/\/$/, '')}/ws`
  ws = new WebSocket(wsUrl)
  ws.onopen = () => setStatus(true)
  ws.onclose = () => {
    setStatus(false)
    clearTimeout(wsTimer)
    wsTimer = setTimeout(connectWs, 1500)
  }
  ws.onerror = () => ws.close()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.type === 'init' || msg.type === 'update') applyState(msg)
    else if (msg.type === 'error') toast('操作被拒绝：' + msg.message)
  }
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function applyState(msg) {
  const prevIds = new Set((board?.elements ?? []).map((e) => e.id))
  board = msg.board
  revision = msg.revision
  // update 消息不带 project/canvas，只有 init/state 才有：记住最近一次，避免被 update 刷掉
  if (msg.canvas) lastCanvas = msg.canvas
  if (msg.project?.name) lastProject = msg.project
  if (lastProject?.name) {
    document.title = `${lastCanvas?.title ? lastCanvas.title + ' · ' : ''}${lastProject.name} · ui-draw`
    document.getElementById('project-chip').textContent = lastProject.name
    document.getElementById('project-chip').title = lastProject.projectDir || ''
  }
  if (msg.project?.boards || msg.canvas) renderBoardSelect(msg)
  if (msg.type === 'update') {
    for (const id of msg.changedIds ?? []) {
      if (!prevIds.has(id)) startAnim(id, msg.actor === 'agent' ? 450 : 120)
    }
  }
  const stateIds = new Set(board.elements.map((e) => e.id))
  pendingEls = pendingEls.filter((e) => !stateIds.has(e.id))
  selection = new Set([...selection].filter((id) => stateIds.has(id)))
  preloadImages()

  const sig = `${board.width}x${board.height}`
  if (sig !== boardSig) {
    boardSig = sig
    fitView()
  } else {
    applyView()
  }
  renderLayersPanel()
  renderAnnoPanel()
  updateStatusText()
  updateCopyButton()
}

function startAnim(id, dur) {
  animating.set(id, { start: performance.now(), dur })
}

// ---------- 画布切换器（一个项目多块画布，一个界面一块） ----------
const boardSelect = document.getElementById('board-select')
let boardSelectSig = ''
let lastCanvas = null
let lastProject = null
function renderBoardSelect(msg) {
  const boards = msg.project?.boards ?? (lastProject?.boards ?? [{ id: msg.canvas?.id, title: msg.canvas?.title }])
  const current = msg.canvas?.id ?? lastCanvas?.id ?? ''
  const sig = `${current}|${boards.map((b) => b.id + b.title).join(',')}`
  if (sig === boardSelectSig) return
  boardSelectSig = sig
  boardSelect.innerHTML = ''
  for (const b of boards) {
    const opt = document.createElement('option')
    opt.value = b.id
    opt.textContent = b.title
    if (b.id === current) opt.selected = true
    boardSelect.appendChild(opt)
  }
  boardSelect.classList.toggle('single', boards.length <= 1)
}
boardSelect.addEventListener('change', () => {
  const id = boardSelect.value
  if (id) location.href = `../${encodeURIComponent(id)}/`
})

// ---------- 视口：缩放 / 平移 ----------
let userAdjustedView = false // 人手动缩放/平移过之后，窗口变化不再自动适应

function fitZoom() {
  const pad = 48
  const availW = Math.max(50, stage.clientWidth - pad)
  const availH = Math.max(50, stage.clientHeight - pad)
  return Math.min(availW / board.width, availH / board.height, MAX_ZOOM)
}

// A long canvas must still be able to fit even below the usual 10% minimum.
function minZoom() {
  return Math.min(MIN_ZOOM, fitZoom())
}

function fitView(attempt = 0) {
  if (!board) return
  // 首次加载时舞台可能还没完成布局（宽高为 0）：等它长出来再算，别把缩放锁在最小值
  if ((stage.clientWidth < 120 || stage.clientHeight < 120) && attempt < 25) {
    setTimeout(() => {
      if (!userAdjustedView) fitView(attempt + 1)
    }, 80)
    return
  }
  const z = fitZoom()
  view.zoom = z
  view.tx = (stage.clientWidth - board.width * z) / 2
  view.ty = (stage.clientHeight - board.height * z) / 2
  userAdjustedView = false
  applyView()
}

function applyView() {
  if (!board) return
  const wrap = document.getElementById('canvas-wrap')
  const wpx = board.width * view.zoom
  const hpx = board.height * view.zoom
  wrap.style.width = wpx + 'px'
  wrap.style.height = hpx + 'px'
  wrap.style.transform = `translate(${view.tx}px, ${view.ty}px)`

  const effectiveDpr = Math.min(
    deviceDpr,
    MAX_CANVAS_EDGE / wpx,
    MAX_CANVAS_EDGE / hpx,
    Math.sqrt(MAX_CANVAS_PIXELS / (wpx * hpx)),
  )
  const bw = Math.max(1, Math.floor(wpx * effectiveDpr))
  const bh = Math.max(1, Math.floor(hpx * effectiveDpr))
  // The integer backing sizes can round differently on each axis.
  backingScaleX = bw / wpx
  backingScaleY = bh / hpx
  if (boardCanvas.width !== bw || boardCanvas.height !== bh) {
    boardCanvas.width = bw
    boardCanvas.height = bh
    overlayCanvas.width = bw
    overlayCanvas.height = bh
  }
  boardCanvas.style.width = wpx + 'px'
  boardCanvas.style.height = hpx + 'px'
  overlayCanvas.style.width = wpx + 'px'
  overlayCanvas.style.height = hpx + 'px'

  document.getElementById('zoom-label').textContent = Math.round(view.zoom * 100) + '%'
  render()
}

/** 以某个屏幕点为中心缩放 */
function zoomAt(nextZoom, clientX, clientY) {
  if (!board) return
  const rect = stage.getBoundingClientRect()
  const ax = clientX - rect.left
  const ay = clientY - rect.top
  const bx = (ax - view.tx) / view.zoom
  const by = (ay - view.ty) / view.zoom
  view.zoom = clamp(nextZoom, minZoom(), MAX_ZOOM)
  view.tx = ax - bx * view.zoom
  view.ty = ay - by * view.zoom
  userAdjustedView = true
  applyView()
}

function zoomBy(factor) {
  const rect = stage.getBoundingClientRect()
  zoomAt(view.zoom * factor, rect.left + rect.width / 2, rect.top + rect.height / 2)
}

function focusBox(box) {
  if (!board) return
  view.tx = stage.clientWidth / 2 - (box.x + box.w / 2) * view.zoom
  view.ty = stage.clientHeight / 2 - (box.y + box.h / 2) * view.zoom
  userAdjustedView = true
  flash = { box, until: performance.now() + 1400 }
  applyView()
  tickFlash()
}

function tickFlash() {
  if (!flash) return
  renderOverlay()
  if (performance.now() < flash.until) requestAnimationFrame(tickFlash)
  else {
    flash = null
    renderOverlay()
  }
}

// 舞台上的滚轮缩放（shift+滚轮 = 横向平移，alt+滚轮 = 纵向平移）
stage.addEventListener(
  'wheel',
  (ev) => {
    if (!board) return
    ev.preventDefault()
    if (ev.shiftKey) {
      view.tx -= ev.deltaY
      applyView()
      return
    }
    if (ev.altKey) {
      view.ty -= ev.deltaY
      applyView()
      return
    }
    const factor = Math.exp(-ev.deltaY * 0.0016)
    zoomAt(view.zoom * factor, ev.clientX, ev.clientY)
  },
  { passive: false },
)

document.getElementById('zoom-in').addEventListener('click', () => zoomBy(1.2))
document.getElementById('zoom-out').addEventListener('click', () => zoomBy(1 / 1.2))
document.getElementById('zoom-fit').addEventListener('click', () => fitView())
document.getElementById('zoom-label').addEventListener('click', () => {
  const rect = stage.getBoundingClientRect()
  zoomAt(1, rect.left + rect.width / 2, rect.top + rect.height / 2)
})

// ---------- 渲染 ----------
function progressMap() {
  if (animating.size === 0) return undefined
  const now = performance.now()
  const m = new Map()
  for (const [id, a] of animating) {
    const t = Math.min(1, (now - a.start) / a.dur)
    m.set(id, 1 - Math.pow(1 - t, 3))
  }
  return m
}

let animFrameRunning = false
function scheduleAnim() {
  if (animating.size > 0 && !animFrameRunning) {
    animFrameRunning = true
    requestAnimationFrame(animFrame)
  }
}
function animFrame(now) {
  for (const [id, a] of animating) {
    if (now - a.start >= a.dur) animating.delete(id)
  }
  render()
  if (animating.size > 0) requestAnimationFrame(animFrame)
  else animFrameRunning = false
}

function render() {
  if (!board) return
  const t = performance.now()
  if (animating.size > 0) scheduleAnim()
  boardCtx.setTransform(backingScaleX, 0, 0, backingScaleY, 0, 0)
  boardCtx.clearRect(0, 0, board.width * view.zoom, board.height * view.zoom)
  const shown = { ...board, elements: [...board.elements, ...pendingEls] }
  renderBoard(boardCtx, shown, { images: imageCache, progress: progressMap(), scale: view.zoom })
  renderOverlay()
  void t
}

function renderOverlay() {
  if (!board) return
  const z = view.zoom
  const W = board.width * z
  const H = board.height * z
  overlayCtx.setTransform(backingScaleX, 0, 0, backingScaleY, 0, 0)
  overlayCtx.clearRect(0, 0, W, H)
  overlayCtx.setTransform(backingScaleX * z, 0, 0, backingScaleY * z, 0, 0)
  const lw = 1.5 / z

  // 选中的图元高亮
  if (tool === 'select' && selection.size > 0) {
    overlayCtx.strokeStyle = '#2563eb'
    overlayCtx.lineWidth = lw
    overlayCtx.setLineDash([4 / z, 3 / z])
    for (const el of board.elements) {
      if (!selection.has(el.id)) continue
      const b = elementBBox(el)
      overlayCtx.strokeRect(b.x - 3, b.y - 3, b.w + 6, b.h + 6)
    }
    overlayCtx.setLineDash([])
  }

  // 橡皮命中的图元标红
  if (eraseHits.size > 0) {
    overlayCtx.strokeStyle = '#dc2626'
    overlayCtx.lineWidth = lw
    overlayCtx.setLineDash([4 / z, 3 / z])
    for (const el of board.elements) {
      if (!eraseHits.has(el.id)) continue
      const b = elementBBox(el)
      overlayCtx.strokeRect(b.x - 3, b.y - 3, b.w + 6, b.h + 6)
    }
    overlayCtx.setLineDash([])
  }

  // 批注定位闪烁
  if (flash) {
    const b = flash.box
    overlayCtx.strokeStyle = '#f59e0b'
    overlayCtx.lineWidth = 2.5 / z
    overlayCtx.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8)
  }

  // 进行中的手势预览
  if (gesture?.preview) drawGhost(gesture.preview)

  // 框选 / 批注框
  if (gesture?.type === 'marquee' || gesture?.type === 'annotate-marquee') {
    const { x, y, w, h } = normRect(gesture.start, gesture.cur)
    const isAnno = gesture.type === 'annotate-marquee'
    overlayCtx.strokeStyle = isAnno ? '#f59e0b' : '#2563eb'
    overlayCtx.fillStyle = isAnno ? 'rgba(245,158,11,0.12)' : 'rgba(37,99,235,0.06)'
    overlayCtx.lineWidth = lw
    overlayCtx.setLineDash(isAnno ? [7 / z, 4 / z] : [4 / z, 3 / z])
    overlayCtx.fillRect(x, y, w, h)
    overlayCtx.strokeRect(x, y, w, h)
    overlayCtx.setLineDash([])
    if (isAnno) {
      overlayCtx.fillStyle = '#b45309'
      overlayCtx.font = `bold ${Math.max(11, 12 / z * 1)}px "Microsoft YaHei", sans-serif`
      overlayCtx.textAlign = 'left'
      overlayCtx.textBaseline = 'bottom'
      overlayCtx.fillText('松手写批注', x + 4 / z, y - 5 / z)
    }
  }
}

function drawGhost(el) {
  overlayCtx.save()
  overlayCtx.globalAlpha = 0.85
  try {
    // 此时 overlay 的变换里已经含 zoom，所以这里 scale 用 1
    renderBoard(overlayCtx, { ...board, grid: false, elements: [el] }, { scale: 1 })
  } catch {
    /* 忽略预览异常 */
  }
  overlayCtx.restore()
}

function preloadImages() {
  for (const el of board.elements) {
    if (el.kind !== 'image' || imageCache.has(el.id)) continue
    const img = new Image()
    img.onload = () => render()
    img.src = el.src
    imageCache.set(el.id, img)
  }
}

// ---------- 坐标换算 ----------
function toBoard(ev) {
  const rect = overlayCanvas.getBoundingClientRect()
  return {
    x: (ev.clientX - rect.left) / view.zoom,
    y: (ev.clientY - rect.top) / view.zoom,
  }
}

// ---------- 手势 ----------
let spaceDown = false

overlayCanvas.addEventListener('pointerdown', (ev) => {
  if (!board) return
  // 平移：空格 + 左键 / 中键拖
  if (spaceDown || ev.button === 1) {
    ev.preventDefault()
    try { overlayCanvas.setPointerCapture(ev.pointerId) } catch { /* 合成事件没有真实指针 */ }
    gesture = { type: 'pan', clientStart: { x: ev.clientX, y: ev.clientY }, viewStart: { tx: view.tx, ty: view.ty } }
    overlayCanvas.classList.add('panning-active')
    return
  }
  if (ev.button !== 0) return
  try { overlayCanvas.setPointerCapture(ev.pointerId) } catch { /* 合成事件没有真实指针 */ }
  const p = toBoard(ev)
  const layer = board.activeLayer

  if (tool === 'select') {
    const hit = topHit(p)
    if (hit) {
      if (ev.shiftKey) {
        selection.has(hit.id) ? selection.delete(hit.id) : selection.add(hit.id)
      } else if (!selection.has(hit.id)) {
        selection = new Set([hit.id])
      }
      gesture = { type: 'move', start: p, cur: p, moved: false }
    } else {
      selection = new Set()
      gesture = { type: 'marquee', start: p, cur: p }
    }
    updateCopyButton()
    renderOverlay()
    return
  }
  if (tool === 'annotate') {
    gesture = { type: 'annotate-marquee', start: p, cur: p }
    return
  }
  if (tool === 'eraser') {
    gesture = { type: 'erase', points: [p] }
    collectEraseHits(p)
    return
  }
  if (tool === 'text') {
    openTextInput(p)
    return
  }
  if (tool === 'pen') {
    gesture = { type: 'pen', points: [p], preview: penPreview([p]) }
    return
  }
  gesture = { type: tool, start: p, cur: p, preview: shapePreview(tool, p, p) }
})

overlayCanvas.addEventListener('pointermove', (ev) => {
  if (!gesture || !board) return
  if (gesture.type === 'pan') {
    view.tx = gesture.viewStart.tx + (ev.clientX - gesture.clientStart.x)
    view.ty = gesture.viewStart.ty + (ev.clientY - gesture.clientStart.y)
    userAdjustedView = true
    applyView()
    return
  }
  const p = toBoard(ev)
  gesture.cur = p

  if (gesture.type === 'move') {
    if (Math.abs(p.x - gesture.start.x) + Math.abs(p.y - gesture.start.y) > 2) gesture.moved = true
    renderOverlay()
  } else if (gesture.type === 'marquee' || gesture.type === 'annotate-marquee') {
    renderOverlay()
  } else if (gesture.type === 'erase') {
    gesture.points.push(p)
    collectEraseHits(p)
  } else if (gesture.type === 'pen') {
    gesture.points.push(p)
    gesture.preview = penPreview(gesture.points)
    renderOverlay()
  } else {
    gesture.preview = shapePreview(gesture.type, gesture.start, p)
    renderOverlay()
  }
})

overlayCanvas.addEventListener('pointerup', () => {
  if (!gesture || !board) return
  const g = gesture
  gesture = null
  overlayCanvas.classList.remove('panning-active')
  const layer = board.activeLayer

  if (g.type === 'pan') {
    render()
    return
  }
  if (g.type === 'move') {
    if (g.moved && selection.size > 0) {
      send({ type: 'op', op: { type: 'moveElements', ids: [...selection], dx: snap(g.cur.x - g.start.x), dy: snap(g.cur.y - g.start.y) } })
    }
    renderOverlay()
  } else if (g.type === 'marquee') {
    const { x, y, w, h } = normRect(g.start, g.cur)
    if (w > 4 && h > 4) {
      const box = { x: x - 3, y: y - 3, w: w + 6, h: h + 6 }
      selection = new Set(
        board.elements
          .filter((el) => {
            const b = elementBBox(el)
            return b.x < box.x + box.w && b.x + b.w > box.x && b.y < box.y + box.h && b.y + b.h > box.y
          })
          .map((el) => el.id),
      )
    }
    updateCopyButton()
    renderOverlay()
  } else if (g.type === 'annotate-marquee') {
    const r = normRect(g.start, g.cur)
    if (r.w < 8 || r.h < 8) {
      toast('请拖出一个区域再写批注')
      renderOverlay()
      return
    }
    openAnnoModal({ x: snap(r.x), y: snap(r.y), w: snap(r.w), h: snap(r.h) })
  } else if (g.type === 'erase') {
    if (eraseHits.size > 0) send({ type: 'op', op: { type: 'deleteElements', ids: [...eraseHits] } })
    eraseHits.clear()
    renderOverlay()
  } else if (g.type === 'pen') {
    const pts = g.points.map((p) => [snap(p.x), snap(p.y)])
    if (pts.length >= 2) commitElement({ id: uid(), kind: 'stroke', layer, points: pts, color, width, ...(dash ? { dash } : {}) })
  } else if (g.type === 'line' || g.type === 'arrow') {
    const el =
      g.type === 'line'
        ? { id: uid(), kind: 'line', layer, x1: snap(g.start.x), y1: snap(g.start.y), x2: snap(g.cur.x), y2: snap(g.cur.y), color, width, ...(dash ? { dash } : {}) }
        : { id: uid(), kind: 'arrow', layer, x1: snap(g.start.x), y1: snap(g.start.y), x2: snap(g.cur.x), y2: snap(g.cur.y), color, width }
    if (Math.abs(el.x2 - el.x1) + Math.abs(el.y2 - el.y1) > 3) commitElement(el)
  } else if (g.type === 'rect' || g.type === 'ellipse') {
    const r = normRect(g.start, g.cur)
    if (r.w > 3 && r.h > 3) {
      const el = {
        id: uid(), kind: g.type, layer,
        x: snap(r.x), y: snap(r.y), w: snap(r.w), h: snap(r.h),
        color, width, ...(dash ? { dash } : {}), ...(fillOn ? { fill: fillColor } : {}),
      }
      commitElement(el)
    }
  }
  render()
})

function commitElement(element) {
  pendingEls.push(element)
  render()
  send({ type: 'op', op: { type: 'addElement', element } })
}

function penPreview(points) {
  return { id: 'preview', kind: 'stroke', layer: board.activeLayer, points: points.map((p) => [p.x, p.y]), color, width }
}
function shapePreview(kind, a, b) {
  const r = normRect(a, b)
  if (kind === 'line' || kind === 'arrow') {
    return { id: 'preview', kind, layer: board.activeLayer, x1: a.x, y1: a.y, x2: b.x, y2: b.y, color, width }
  }
  return { id: 'preview', kind, layer: board.activeLayer, x: r.x, y: r.y, w: Math.max(r.w, 1), h: Math.max(r.h, 1), color, width, ...(fillOn ? { fill: fillColor } : {}) }
}

function topHit(p) {
  for (let i = board.elements.length - 1; i >= 0; i--) {
    const el = board.elements[i]
    const layerVisible = board.layers.find((l) => l.name === el.layer)?.visible !== false
    if (layerVisible && hitElement(el, p.x, p.y, 6 / view.zoom)) return el
  }
  return null
}

function collectEraseHits(p) {
  for (const el of board.elements) {
    if (el.layer !== board.activeLayer) continue
    if (hitElement(el, p.x, p.y, 4 / view.zoom + 2)) eraseHits.add(el.id)
  }
  renderOverlay()
}

// ---------- 文字工具 ----------
let textPos = null
function openTextInput(p) {
  textPos = p
  textInput.style.display = 'block'
  textInput.style.left = p.x * view.zoom + 'px'
  textInput.style.top = p.y * view.zoom + 'px'
  textInput.style.fontSize = fontSize * view.zoom + 'px'
  textInput.value = ''
  setTimeout(() => textInput.focus(), 0)
}
function commitText() {
  const content = textInput.value.trim()
  textInput.style.display = 'none'
  if (content && textPos) {
    commitElement({
      id: uid(), kind: 'text', layer: board.activeLayer,
      x: snap(textPos.x), y: snap(textPos.y), content, size: fontSize, color,
    })
  }
  textPos = null
}
textInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); commitText() }
  if (ev.key === 'Escape') { textInput.style.display = 'none'; textPos = null }
})
textInput.addEventListener('blur', () => { if (textInput.style.display === 'block') commitText() })

// ---------- 批注 ----------
const annoModal = document.getElementById('anno-modal')
const annoText = document.getElementById('anno-text')
let pendingAnnoBox = null

function openAnnoModal(box) {
  pendingAnnoBox = box
  document.getElementById('anno-region').textContent =
    `区域 (${box.x}, ${box.y}) ${box.w} × ${box.h} px`
  annoText.value = ''
  annoModal.classList.remove('hidden')
  setTimeout(() => annoText.focus(), 0)
}

function closeAnnoModal() {
  annoModal.classList.add('hidden')
  pendingAnnoBox = null
  renderOverlay()
}

function submitAnno() {
  const text = annoText.value.trim()
  if (!text) { warnEmptyAnno(); return }
  const box = pendingAnnoBox
  if (!box) return
  const n = board.elements.reduce((m, e) => (e.kind === 'annotation' && e.n > m ? e.n : m), 0) + 1
  const el = {
    id: uid(), kind: 'annotation', layer: annoLayerName(),
    x: box.x, y: box.y, w: box.w, h: box.h,
    text, n, status: 'open', author: 'human',
  }
  commitElement(el)
  closeAnnoModal()
  toast(`批注 #${n} 已提交给 agent`)
}

function warnEmptyAnno() {
  annoText.style.borderColor = '#dc2626'
  annoText.focus()
  setTimeout(() => (annoText.style.borderColor = ''), 1200)
}

function annoLayerName() {
  return board.layers.some((l) => l.name === '批注') ? '批注' : board.activeLayer
}

document.getElementById('anno-submit').addEventListener('click', submitAnno)
document.getElementById('anno-cancel').addEventListener('click', closeAnnoModal)
annoModal.addEventListener('click', (ev) => { if (ev.target === annoModal) closeAnnoModal() })
annoText.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); submitAnno() }
  else if (ev.key === 'Escape') closeAnnoModal()
})

function renderAnnoPanel() {
  if (!board) return
  const ul = document.getElementById('anno-list')
  ul.innerHTML = ''
  const annos = board.elements.filter((e) => e.kind === 'annotation').sort((a, b) => a.n - b.n)
  if (annos.length === 0) {
    const li = document.createElement('li')
    li.className = 'anno-empty'
    li.textContent = '还没有批注。用「📝 批注」工具框选一块区域并写说明。'
    ul.appendChild(li)
    return
  }
  for (const a of annos) {
    const li = document.createElement('li')
    if (a.status === 'resolved') li.classList.add('resolved')
    const head = document.createElement('div')
    head.className = 'anno-head'
    head.textContent = `#${a.n}`
    const who = document.createElement('span')
    who.className = 'anno-who'
    who.textContent = (a.author === 'human' ? '人类' : 'agent') + (a.status === 'resolved' ? ' · 已解决' : '')
    head.appendChild(who)

    const body = document.createElement('div')
    body.className = 'anno-text'
    body.textContent = a.text

    const actions = document.createElement('div')
    actions.className = 'anno-actions'

    const copyBtn = document.createElement('button')
    copyBtn.textContent = '复制引用'
    copyBtn.title = '复制成文字引用，可直接粘贴到对话框'
    copyBtn.addEventListener('click', (ev) => {
      ev.stopPropagation()
      const b = elementBBox(a)
      copyText(
        `[批注 #${a.n} · ${a.author === 'human' ? '人类' : 'agent'}] 区域 (${Math.round(b.x)},${Math.round(b.y)}) ${Math.round(b.w)}×${Math.round(b.h)}\n${a.text}`,
        `批注 #${a.n} 已复制，可直接粘贴到对话框`,
      )
    })

    const stateBtn = document.createElement('button')
    stateBtn.textContent = a.status === 'open' ? '✓ 已解决' : '↺ 重开'
    stateBtn.addEventListener('click', (ev) => {
      ev.stopPropagation()
      send({ type: 'op', op: { type: 'setAnnotationStatus', ids: [a.id], status: a.status === 'open' ? 'resolved' : 'open' } })
    })

    const delBtn = document.createElement('button')
    delBtn.textContent = '✕ 删除'
    delBtn.addEventListener('click', (ev) => {
      ev.stopPropagation()
      if (confirm(`删除批注 #${a.n}？`)) send({ type: 'op', op: { type: 'deleteElements', ids: [a.id] } })
    })

    actions.append(copyBtn, stateBtn, delBtn)
    li.append(head, body, actions)
    li.addEventListener('click', () => focusBox(elementBBox(a)))
    ul.appendChild(li)
  }
}

// ---------- 复制选区图 ----------
function updateCopyButton() {
  const btn = document.getElementById('copy-selection')
  btn.disabled = selection.size === 0 || !board
  btn.textContent = selection.size > 0 ? `复制选区图 (${selection.size})` : '复制选区图'
}

async function copySelectionImage() {
  if (!board || selection.size === 0) return
  const els = board.elements.filter((e) => selection.has(e.id))
  const u = unionBBox(els)
  if (!u) return
  const pad = 10
  const box = {
    x: clamp(u.x - pad, 0, board.width),
    y: clamp(u.y - pad, 0, board.height),
    w: 0,
    h: 0,
  }
  box.w = clamp(u.w + pad * 2, 1, board.width - box.x)
  box.h = clamp(u.h + pad * 2, 1, board.height - box.y)

  const scaleX = boardCanvas.width / board.width // backing pixels per board pixel
  const scaleY = boardCanvas.height / board.height
  const off = document.createElement('canvas')
  off.width = Math.max(1, Math.round(box.w * scaleX))
  off.height = Math.max(1, Math.round(box.h * scaleY))
  const octx = off.getContext('2d')
  octx.fillStyle = '#ffffff'
  octx.fillRect(0, 0, off.width, off.height)
  octx.drawImage(
    boardCanvas,
    box.x * scaleX, box.y * scaleY, box.w * scaleX, box.h * scaleY,
    0, 0, off.width, off.height,
  )

  try {
    const blob = await new Promise((r) => off.toBlob(r, 'image/png'))
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    toast('选区已复制成图片，可直接粘贴到对话框')
  } catch {
    // 剪贴板不可用：退化为下载
    const a = document.createElement('a')
    a.href = off.toDataURL('image/png')
    a.download = 'ui-draw-selection.png'
    a.click()
    toast('浏览器不允许写剪贴板，已改为下载图片')
  }
}

document.getElementById('copy-selection').addEventListener('click', copySelectionImage)

// ---------- 键盘 ----------
document.addEventListener('keydown', (ev) => {
  if (ev.target === textInput || ev.target === annoText) return
  const mod = ev.ctrlKey || ev.metaKey
  if (mod && ev.shiftKey && ev.key.toLowerCase() === 'c') {
    ev.preventDefault()
    copySelectionImage()
    return
  }
  if (mod && ev.key === '0') { ev.preventDefault(); fitView(); return }
  if (mod && (ev.key === '=' || ev.key === '+')) { ev.preventDefault(); zoomBy(1.2); return }
  if (mod && ev.key === '-') { ev.preventDefault(); zoomBy(1 / 1.2); return }
  if (mod && ev.key.toLowerCase() === 'z' && !ev.shiftKey) { ev.preventDefault(); send({ type: 'undo' }) }
  else if (mod && (ev.key.toLowerCase() === 'y' || (ev.shiftKey && ev.key.toLowerCase() === 'z'))) { ev.preventDefault(); send({ type: 'redo' }) }
  else if ((ev.key === 'Delete' || ev.key === 'Backspace') && selection.size > 0) {
    ev.preventDefault()
    send({ type: 'op', op: { type: 'deleteElements', ids: [...selection] } })
  } else if (ev.key === 'Escape') { selection.clear(); renderOverlay(); updateCopyButton() }
  else if (ev.code === 'Space') { spaceDown = true; overlayCanvas.classList.add('panning') }
  else {
    const keyMap = { v: 'select', p: 'pen', l: 'line', r: 'rect', o: 'ellipse', a: 'arrow', t: 'text', e: 'eraser', n: 'annotate' }
    const t = keyMap[ev.key.toLowerCase()]
    if (t && !mod) setTool(t)
  }
})
document.addEventListener('keyup', (ev) => {
  if (ev.code === 'Space') {
    spaceDown = false
    overlayCanvas.classList.remove('panning')
  }
})

// ---------- 粘贴图片 ----------
document.addEventListener('paste', (ev) => {
  const item = [...(ev.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'))
  if (!item || !board) return
  const blob = item.getAsFile()
  const reader = new FileReader()
  reader.onload = () => {
    const img = new Image()
    img.onload = () => {
      const w = Math.min(board.width * 0.6, img.width)
      const h = (w / img.width) * img.height
      commitElement({
        id: uid(), kind: 'image', layer: board.activeLayer,
        x: snap((board.width - w) / 2), y: snap((board.height - h) / 2), w: snap(w), h: snap(h), src: reader.result,
      })
    }
    img.src = reader.result
  }
  reader.readAsDataURL(blob)
})

// ---------- 工具栏 / 顶栏 ----------
function setTool(t) {
  tool = t
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t))
  overlayCanvas.classList.toggle('selecting', t === 'select')
  overlayCanvas.style.cursor = t === 'select' ? 'default' : 'crosshair'
  if (t !== 'select') { selection.clear(); updateCopyButton() }
  if (t === 'annotate') ensureAnnoLayer()
  renderOverlay()
}

function ensureAnnoLayer() {
  if (!board) return
  if (!board.layers.some((l) => l.name === '批注')) {
    send({ type: 'op', op: { type: 'addLayer', name: '批注' } })
    send({ type: 'op', op: { type: 'setActiveLayer', name: '批注' } })
    toast('已自动创建「批注」图层')
  } else if (board.activeLayer !== '批注') {
    send({ type: 'op', op: { type: 'setActiveLayer', name: '批注' } })
  }
}

document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)))

document.getElementById('inp-color').addEventListener('input', (e) => { color = e.target.value })
document.getElementById('inp-width').addEventListener('change', (e) => { width = Number(e.target.value) })
document.getElementById('inp-fill').addEventListener('input', (e) => { fillColor = e.target.value })
document.getElementById('inp-fill-on').addEventListener('change', (e) => { fillOn = !e.target.checked })
document.getElementById('inp-dash').addEventListener('change', (e) => { dash = e.target.checked })
document.getElementById('inp-size').addEventListener('change', (e) => { fontSize = Number(e.target.value) || 16 })

document.getElementById('btn-undo').addEventListener('click', () => send({ type: 'undo' }))
document.getElementById('btn-redo').addEventListener('click', () => send({ type: 'redo' }))
document.getElementById('btn-clear').addEventListener('click', () => {
  if (board && confirm(`清空「${board.activeLayer}」层？（可撤销）`)) {
    send({ type: 'op', op: { type: 'clear', layer: board.activeLayer } })
  }
})

// ---------- 图层面板 ----------
function renderLayersPanel() {
  if (!board) return
  const ul = document.getElementById('layer-list')
  ul.innerHTML = ''
  for (const layer of [...board.layers].reverse()) {
    const li = document.createElement('li')
    if (layer.name === board.activeLayer) li.classList.add('active')
    if (!layer.visible) li.classList.add('hidden-layer')
    const count = board.elements.filter((e) => e.layer === layer.name).length

    const eye = document.createElement('button')
    eye.textContent = layer.visible ? '👁' : '🚫'
    eye.title = layer.visible ? '隐藏' : '显示'
    eye.addEventListener('click', (ev) => {
      ev.stopPropagation()
      send({ type: 'op', op: { type: 'setLayerVisible', name: layer.name, visible: !layer.visible } })
    })

    const name = document.createElement('span')
    name.className = 'layer-name'
    name.textContent = `${layer.name} (${count})`
    name.title = '双击重命名，单击切换为当前图层'
    li.addEventListener('dblclick', () => {
      const newName = prompt('图层改名：', layer.name)
      if (newName && newName !== layer.name) send({ type: 'op', op: { type: 'renameLayer', name: layer.name, newName } })
    })

    const del = document.createElement('button')
    del.textContent = '✕'
    del.title = '删除图层'
    del.addEventListener('click', (ev) => {
      ev.stopPropagation()
      if (board.layers.length <= 1) { alert('至少保留一个图层'); return }
      if (confirm(`删除图层「${layer.name}」及其 ${count} 个图元？`)) {
        send({ type: 'op', op: { type: 'removeLayer', name: layer.name } })
      }
    })

    li.append(eye, name, del)
    li.addEventListener('click', () => send({ type: 'op', op: { type: 'setActiveLayer', name: layer.name } }))
    ul.appendChild(li)
  }
  document.getElementById('active-layer-name').textContent = board.activeLayer
}

document.getElementById('btn-add-layer').addEventListener('click', () => {
  const name = prompt('新图层名称：')
  if (name) send({ type: 'op', op: { type: 'addLayer', name } })
})

// ---------- 状态条 ----------
function setStatus(connected) {
  document.getElementById('conn-dot').className = 'dot ' + (connected ? 'on' : 'off')
  document.getElementById('disconnected-banner').classList.toggle('show', !connected)
  updateStatusText()
}
function updateStatusText() {
  if (!board) return
  document.getElementById('status-text').textContent =
    `${board.width}×${board.height} · 第 ${revision} 版 · ${board.elements.length} 图元`
}

// ---------- 启动 ----------
setTool('select')
// 舞台尺寸变化（窗口缩放、面板显隐、首次布局）时：没手动调过视图就重新适应
const ro = new ResizeObserver(() => {
  if (!board) return
  if (userAdjustedView) applyView()
  else fitView()
})
ro.observe(stage)
connectWs()
// WS 未连上前先拿一份初始状态
fetch('api/state')
  .then((r) => r.json())
  .then(applyState)
  .catch(() => setStatus(false))
