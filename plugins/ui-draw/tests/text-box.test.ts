import { createCanvas } from '@napi-rs/canvas'
import { describe, expect, it } from 'vitest'
import { elementBBox, hitElement } from '../src/board/ops.js'
import { drawElement, textLines } from '../src/board/render.js'
import { BoardService } from '../src/board/service.js'
import { defaultBoard, type TextElement } from '../src/board/types.js'
import { boardToSvg } from '../src/render/svg.js'

const text: TextElement = {
  id: 'text-1', kind: 'text', layer: '草稿', x: 10, y: 10, content: 'Hello world', size: 20, color: '#000000',
}

describe('文本框', () => {
  it('旧文字可设定固定宽高，命中范围随尺寸变化并支持撤销重做', () => {
    const service = new BoardService()
    service.restore({ ...defaultBoard(), elements: [text] })
    service.commit({ type: 'resizeText', id: text.id, w: 48, h: 80 })
    const [resized] = service.board.elements
    expect(resized).toEqual({ ...text, w: 48, h: 80 })
    expect(elementBBox(resized)).toEqual({ x: 10, y: 10, w: 48, h: 80 })
    expect(hitElement(resized, 20, 80)).toBe(true)
    expect(hitElement(resized, 65, 25)).toBe(false)
    expect(service.undo()).toBe(true)
    expect(service.board.elements[0]).toEqual(text)
    expect(service.redo()).toBe(true)
    expect(service.board.elements[0]).toEqual(resized)
  })

  it('拒绝缺失或非法尺寸且不改变状态', () => {
    const service = new BoardService()
    expect(() => service.commit({ type: 'addElement', element: { ...text, w: 48 } })).toThrow(/文本框宽高/)
    service.commit({ type: 'addElement', element: text })
    expect(() => service.commit({ type: 'resizeText', id: text.id, w: 0, h: 80 })).toThrow(/文本框宽高/)
    expect(() => service.commit({ type: 'resizeText', id: text.id, w: 48, h: Infinity })).toThrow(/文本框宽高/)
    expect(service.board.elements).toEqual([text])
    expect(service.revision).toBe(1)
  })

  it('按宽度折行，保留手动换行、英文单词和组合字符', () => {
    const measure = (line: string) => Array.from(line).length * 10
    const content = 'abc de\r\n\r\n甲乙丙丁戊\n👩‍💻xy'
    expect(textLines({ ...text, content, w: 40, h: 240 }, measure))
      .toEqual(['abc', 'de', '', '甲乙丙丁', '戊', '👩‍💻x', 'y'])
    expect(textLines({ ...text, content, w: 40, h: 28 }, measure)).toEqual(['abc'])
  })

  it('画布与 SVG 按框宽换行并裁切，增高后可显示下一行', () => {
    const boxed = { ...text, content: 'WWWWWWWW', w: 82, h: 20 }
    const ctx = createCanvas(200, 120).getContext('2d')
    const hasInk = (x: number, y: number, w: number, h: number) =>
      ctx.getImageData(x, y, w, h).data.some((value, i) => i % 4 === 3 && value > 0)
    drawElement(ctx, boxed)
    expect(hasInk(10, 10, 82, 20)).toBe(true)
    expect(hasInk(10, 30, 190, 90)).toBe(false)
    expect(hasInk(92, 0, 108, 120)).toBe(false)
    drawElement(ctx, { ...boxed, h: 60 })
    expect(hasInk(10, 38, 82, 28)).toBe(true)

    const svg = boardToSvg({ ...defaultBoard(), elements: [{ ...boxed, h: 60 }] })
    expect(svg).toContain('<rect x="10" y="10" width="82" height="60"/>')
    expect(svg).toContain('clip-path="url(#text-box-')
    expect(svg.match(/<tspan /g)).toHaveLength(2)
  })
})
