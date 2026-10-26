import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Board } from './board/types.js'
import { renderPng } from './render/raster.js'
import { boardToSvg } from './render/svg.js'
import { designMarkdown } from './board/describe.js'

const FILE_VERSION = 1

export function saveBoardFile(board: Board, path: string): string {
  const abs = resolve(path)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, JSON.stringify({ version: FILE_VERSION, board }, null, 2), 'utf-8')
  return abs
}

export function loadBoardFile(path: string): Board {
  const abs = resolve(path)
  const raw = JSON.parse(readFileSync(abs, 'utf-8'))
  const board = raw?.board ?? raw
  if (!board || !Array.isArray(board.layers) || !Array.isArray(board.elements)) {
    throw new Error(`文件不是有效的画板数据：${abs}`)
  }
  return board as Board
}

/** 把设计包写入目录（PNG/SVG 由调用方渲染好传进来） */
export function writeDesignBundle(board: Board, dir: string, png: Buffer, svg: string): string[] {
  const absDir = resolve(dir)
  mkdirSync(absDir, { recursive: true })
  const pngPath = join(absDir, 'design.png')
  const svgPath = join(absDir, 'design.svg')
  const jsonPath = join(absDir, 'board.json')
  const mdPath = join(absDir, 'DESIGN.md')
  writeFileSync(pngPath, png)
  writeFileSync(svgPath, svg, 'utf-8')
  writeFileSync(jsonPath, JSON.stringify({ version: FILE_VERSION, board }, null, 2), 'utf-8')
  writeFileSync(mdPath, designMarkdown(board), 'utf-8')
  return [pngPath, svgPath, jsonPath, mdPath]
}

/** 本地渲染并导出设计包（测试/离线用；MCP 侧走守护进程渲染） */
export function finalizeDesign(board: Board, dir: string): string[] {
  const png = renderPng(board, { rasterScale: 2, skipAnnotations: true })
  return writeDesignBundle(board, dir, png, boardToSvg(board))
}

export function defaultSavePath(): string {
  return join(process.cwd(), '.ui-draw', 'board.json')
}

export function defaultDesignDir(): string {
  return join(process.cwd(), 'design')
}
