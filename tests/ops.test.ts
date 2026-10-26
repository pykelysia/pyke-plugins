import { describe, it, expect } from 'vitest'
import { applyOp, hitElement, elementBBox, translateElement, nextAnnotationNumber } from '../src/board/ops'
import { BoardService } from '../src/board/service'
import { defaultBoard } from '../src/board/types'

function rectEl(id = 'r1', layer = '草稿') {
  return { id, kind: 'rect' as const, layer, x: 100, y: 100, w: 200, h: 80, color: '#1f2937', width: 2 }
}

describe('applyOp', () => {
  it('addElement 落到指定图层并可通过图层校验', () => {
    const board = applyOp(defaultBoard(), { type: 'addElement', element: rectEl() })
    expect(board.elements).toHaveLength(1)
    expect(board.elements[0].layer).toBe('草稿')
  })

  it('不存在的图层报错', () => {
    expect(() => applyOp(defaultBoard(), { type: 'addElement', element: rectEl('r', '不存在的层') })).toThrow(/不存在/)
  })

  it('id 重复报错', () => {
    const b1 = applyOp(defaultBoard(), { type: 'addElement', element: rectEl() })
    expect(() => applyOp(b1, { type: 'addElement', element: rectEl() })).toThrow(/重复/)
  })

  it('moveElements 平移且不影响其他图元', () => {
    const b1 = applyOp(defaultBoard(), { type: 'addElements', elements: [rectEl('a'), rectEl('b')] })
    const b2 = applyOp(b1, { type: 'moveElements', ids: ['a'], dx: 10, dy: -5 })
    expect(b2.elements.find((e) => e.id === 'a')!.x).toBe(110)
    expect(b2.elements.find((e) => e.id === 'b')!.x).toBe(100)
    expect(b1.elements.find((e) => e.id === 'a')!.x).toBe(100) // 纯函数，不改入参
  })

  it('clear 只清指定图层', () => {
    const b1 = applyOp(defaultBoard(), { type: 'addElements', elements: [rectEl('a', '草稿'), rectEl('b', '线稿')] })
    const b2 = applyOp(b1, { type: 'clear', layer: '草稿' })
    expect(b2.elements.map((e) => e.id)).toEqual(['b'])
  })

  it('removeLayer 连带删除层上图元并修正 activeLayer', () => {
    let b = applyOp(defaultBoard(), { type: 'addElement', element: rectEl('a', '草稿') })
    b = applyOp(b, { type: 'removeLayer', name: '草稿' })
    expect(b.elements).toHaveLength(0)
    expect(b.activeLayer).toBe('线稿')
  })

  it('至少保留一个图层', () => {
    const board = { ...defaultBoard(), layers: [{ name: '唯一', visible: true }], activeLayer: '唯一' }
    expect(() => applyOp(board, { type: 'removeLayer', name: '唯一' })).toThrow(/至少保留/)
  })

  it('renameLayer 同步元素归属', () => {
    const b1 = applyOp(defaultBoard(), { type: 'addElement', element: rectEl('a', '草稿') })
    const b2 = applyOp(b1, { type: 'renameLayer', name: '草稿', newName: '草稿层' })
    expect(b2.elements[0].layer).toBe('草稿层')
    expect(b2.activeLayer).toBe('草稿层')
  })
})

describe('BoardService 历史', () => {
  it('undo/redo 回放', () => {
    const s = new BoardService()
    s.commit({ type: 'addElement', element: rectEl() })
    s.commit({ type: 'addElement', element: rectEl('r2') })
    expect(s.board.elements).toHaveLength(2)
    expect(s.undo()).toBe(true)
    expect(s.board.elements).toHaveLength(1)
    expect(s.redo()).toBe(true)
    expect(s.board.elements).toHaveLength(2)
  })

  it('空历史 undo 返回 false', () => {
    const s = new BoardService()
    expect(s.undo()).toBe(false)
    expect(s.redo()).toBe(false)
  })

  it('commit 后清空 redo 栈', () => {
    const s = new BoardService()
    s.commit({ type: 'addElement', element: rectEl() })
    s.undo()
    s.commit({ type: 'addElement', element: rectEl('r3') })
    expect(s.redo()).toBe(false)
    expect(s.board.elements.map((e) => e.id)).toEqual(['r3'])
  })

  it('订阅者收到 meta 与 changedIds', () => {
    const s = new BoardService()
    const seen: string[] = []
    s.subscribe((board, meta) => seen.push(meta?.op.type ?? 'undo'))
    s.commit({ type: 'addElement', element: rectEl() })
    s.undo()
    expect(seen).toEqual(['addElement', 'undo'])
  })
})

describe('命中检测与几何', () => {
  it('矩形描边命中、内部不命中（无填充）', () => {
    const el = rectEl()
    expect(hitElement(el, 100, 140)).toBe(true) // 左边框
    expect(hitElement(el, 200, 140)).toBe(false) // 中间空白
    expect(hitElement(el, 100, 100)).toBe(true) // 角
  })

  it('有填充的矩形内部命中', () => {
    const el = { ...rectEl(), fill: '#fee' }
    expect(hitElement(el, 200, 140)).toBe(true)
  })

  it('文字包围盒命中', () => {
    const el = { id: 't', kind: 'text' as const, layer: '草稿', x: 50, y: 50, content: '登录', size: 16, color: '#000' }
    expect(hitElement(el, 55, 55)).toBe(true)
    expect(hitElement(el, 500, 500)).toBe(false)
  })

  it('translateElement 平移包围盒', () => {
    const el = rectEl()
    const moved = translateElement(el, 20, 10)
    const b = elementBBox(moved)
    expect(b.x).toBe(120)
    expect(b.y).toBe(110)
  })
})

describe('批注', () => {
  const anno = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 'a1',
    kind: 'annotation' as const,
    layer: '批注',
    x: 100,
    y: 100,
    w: 200,
    h: 100,
    text: '按钮换成次要样式',
    n: 1,
    status: 'open' as const,
    author: 'human' as const,
    ...over,
  })

  it('包围盒就是圈定区域', () => {
    expect(elementBBox(anno())).toEqual({ x: 100, y: 100, w: 200, h: 100 })
  })

  it('只有边框/徽标/说明条可点中，内部透给下层', () => {
    const el = anno()
    expect(hitElement(el, 250, 160)).toBe(false) // 内部（远离边框/徽标/说明条）
    expect(hitElement(el, 100, 150)).toBe(true) // 左边框
    expect(hitElement(el, 105, 105)).toBe(true) // 编号徽标
    expect(hitElement(el, 150, 214)).toBe(true) // 框下说明条
    expect(hitElement(el, 200, 350)).toBe(false)
  })

  it('编号递增，删除后不回退', () => {
    expect(nextAnnotationNumber([])).toBe(1)
    expect(nextAnnotationNumber([anno({ n: 3 }) as never, anno({ id: 'a2', n: 7 }) as never])).toBe(8)
  })

  it('批注内容不能为空', () => {
    expect(() =>
      applyOp(defaultBoard(), { type: 'addElement', element: anno({ text: '  ' }) as never }),
    ).toThrow(/批注内容/)
  })

  it('setAnnotationStatus 只改目标批注', () => {
    const b1 = applyOp(defaultBoard(), {
      type: 'addElements',
      elements: [anno({ id: 'a1' }) as never, anno({ id: 'a2', n: 2 }) as never],
    })
    const b2 = applyOp(b1, { type: 'setAnnotationStatus', ids: ['a1'], status: 'resolved' })
    const a1 = b2.elements.find((e) => e.id === 'a1')!
    const a2 = b2.elements.find((e) => e.id === 'a2')!
    expect(a1.kind === 'annotation' && a1.status).toBe('resolved')
    expect(a2.kind === 'annotation' && a2.status).toBe('open')
  })

  it('对非批注图元设状态会报错', () => {
    const b1 = applyOp(defaultBoard(), { type: 'addElement', element: rectEl('r9') })
    expect(() => applyOp(b1, { type: 'setAnnotationStatus', ids: ['r9'], status: 'resolved' })).toThrow(/不是批注/)
  })
})
