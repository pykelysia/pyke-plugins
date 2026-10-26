/** 图层：底 → 顶排列 */
export interface Layer {
  name: string
  visible: boolean
}

export interface BaseElement {
  id: string
  layer: string
}

/** 徒手一笔：落笔→拖动→抬笔 收集到的点序列 */
export interface StrokeElement extends BaseElement {
  kind: 'stroke'
  points: [number, number][]
  color: string
  width: number
  dash?: boolean
}

export interface LineElement extends BaseElement {
  kind: 'line'
  x1: number
  y1: number
  x2: number
  y2: number
  color: string
  width: number
  dash?: boolean
}

export interface RectElement extends BaseElement {
  kind: 'rect'
  x: number
  y: number
  w: number
  h: number
  color: string
  width: number
  fill?: string
  radius?: number
  dash?: boolean
}

/** 用外接矩形表达的椭圆 */
export interface EllipseElement extends BaseElement {
  kind: 'ellipse'
  x: number
  y: number
  w: number
  h: number
  color: string
  width: number
  fill?: string
  dash?: boolean
}

export interface ArrowElement extends BaseElement {
  kind: 'arrow'
  x1: number
  y1: number
  x2: number
  y2: number
  color: string
  width: number
}

export interface TextElement extends BaseElement {
  kind: 'text'
  x: number
  y: number
  content: string
  size: number
  color: string
}

/** 贴入的参考图，src 为 dataURL */
export interface ImageElement extends BaseElement {
  kind: 'image'
  x: number
  y: number
  w: number
  h: number
  src: string
}

/**
 * 批注：在画布上圈出一个区域并附一段说明。
 * 人和 agent 都能留批注，agent 用 inspect_board / list_annotations 读取，处理后 resolve。
 */
export interface AnnotationElement extends BaseElement {
  kind: 'annotation'
  x: number
  y: number
  w: number
  h: number
  text: string
  /** 批注编号（展示为 ①②③） */
  n: number
  status: 'open' | 'resolved'
  author: 'human' | 'agent'
  /** 描边/徽标色，缺省按作者取色 */
  color?: string
}

export type Element =
  | StrokeElement
  | LineElement
  | RectElement
  | EllipseElement
  | ArrowElement
  | TextElement
  | ImageElement
  | AnnotationElement

export type ElementKind = Element['kind']

export interface Board {
  width: number
  height: number
  grid: boolean
  layers: Layer[]
  activeLayer: string
  /** 全局顺序即绘制顺序（后画的在上） */
  elements: Element[]
}

export const DEFAULT_LAYERS: Layer[] = [
  { name: '草稿', visible: true },
  { name: '线稿', visible: true },
  { name: '批注', visible: true },
]

export function defaultBoard(): Board {
  return {
    width: 1600,
    height: 1000,
    grid: true,
    layers: DEFAULT_LAYERS.map((l) => ({ ...l })),
    activeLayer: '草稿',
    elements: [],
  }
}
