import { existsSync } from 'node:fs'
import { createCanvas, GlobalFonts, Image } from '@napi-rs/canvas'
import { Board, ImageElement } from '../board/types.js'
import { Ctx2D, RenderOptions, renderBoard } from '../board/render.js'

// Limit whole-image allocations while retaining the entire canvas. Return the actual
// scale so callers can report when a requested 2x export is reduced.
export const MAX_RASTER_PIXELS = 33_554_432
export const MAX_RASTER_SIDE = 32_766

export function boundedRasterScale(width: number, height: number, requested: number): number {
  const sideLimit = Math.min(MAX_RASTER_SIDE / width, MAX_RASTER_SIDE / height)
  const areaLimit = Math.sqrt((MAX_RASTER_PIXELS - 100_000) / (width * height))
  return Math.floor((Math.min(requested, sideLimit, areaLimit) + 1e-10) * 10000) / 10000
}

let fontsRegistered = false

/** 注册中文字体（微软雅黑），保证无头渲染中文不乱码 */
export function ensureFonts(): void {
  if (fontsRegistered) return
  fontsRegistered = true
  const candidates = [
    'C:/Windows/Fonts/msyh.ttc',
    'C:/Windows/Fonts/msyh.ttf',
    'C:/Windows/Fonts/simhei.ttf',
    'C:/Windows/Fonts/simsun.ttc',
  ]
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        GlobalFonts.registerFromPath(path, 'Microsoft YaHei')
        return
      } catch {
        // 尝试下一个候选
      }
    }
  }
  // 非最佳路径：交给 skia 系统回退
}

/** 把画板里的 ImageElement 解码成 napi Image 缓存（同步解码） */
export function buildImageCache(board: Board): Map<string, unknown> {
  const cache = new Map<string, unknown>()
  for (const el of board.elements) {
    if (el.kind !== 'image') continue
    try {
      const img = new Image()
      img.src = dataUrlToBuffer(el.src)
      cache.set(el.id, img)
    } catch {
      // 解码失败则渲染占位框
    }
  }
  return cache
}

export function dataUrlToBuffer(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(',')
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  return Buffer.from(base64, 'base64')
}

export function decodeImageSize(dataUrl: string): { width: number; height: number } {
  const img = new Image()
  img.src = dataUrlToBuffer(dataUrl)
  return { width: img.width, height: img.height }
}

export interface RasterOptions extends RenderOptions {
  /** 导出倍率（截图清晰度），默认 1 */
  rasterScale?: number
  /** 只渲染的区域尺寸（配合 offsetX/offsetY），默认整块画板 */
  regionW?: number
  regionH?: number
}

/** 无头渲染画板为 PNG Buffer */
export function renderPng(board: Board, opts: RasterOptions = {}): Buffer {
  ensureFonts()
  const { rasterScale = 1, regionW, regionH, ...rest } = opts
  const region = {
    x: rest.offsetX ?? 0,
    y: rest.offsetY ?? 0,
    w: regionW ?? board.width,
    h: regionH ?? board.height,
  }
  const actualScale = boundedRasterScale(region.w, region.h, rasterScale)
  if (!(actualScale > 0)) throw new Error('截图区域过大，无法生成位图')
  const canvas = createCanvas(Math.max(1, Math.round(region.w * actualScale)), Math.max(1, Math.round(region.h * actualScale)))
  const ctx = canvas.getContext('2d')
  const images = rest.images ?? buildImageCache(board)
  renderBoard(ctx as unknown as Ctx2D, board, {
    ...rest,
    images,
    scale: (rest.scale ?? 1) * actualScale,
    offsetX: region.x,
    offsetY: region.y,
  })
  return canvas.encodeSync('png')
}
