import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { AnnotationElement } from '../board/types.js'
import { BOARD_MIN_SIZE, BOARD_MAX_WIDTH, BOARD_MAX_HEIGHT, hitElement, nextAnnotationNumber, validateBoardDimensions } from '../board/ops.js'
import { annotationsOf, formatAnnotations, inspectBoard } from '../board/describe.js'
import { boundedRasterScale, decodeImageSize } from '../render/raster.js'
import { defaultBoardSavePath, defaultDesignDir, loadBoardFile, saveBoardFile, writeDesignBundle } from '../persist.js'
import { HubClient } from '../hub/client.js'
import { slugify } from '../hub/paths.js'

const INK = '#1f2937'

function newId(): string {
  return 'e' + randomUUID().replace(/-/g, '').slice(0, 10)
}

interface Ctx {
  /** 懒连接守护进程（首次工具调用时拉起/复用） */
  client: (projectDir?: string) => Promise<HubClient>
}

type ContentBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

type TextResult = { content: ContentBlock[]; isError?: boolean }

function ok(text: string): TextResult {
  return { content: [{ type: 'text', text }] }
}

function fail(text: string): TextResult {
  return { content: [{ type: 'text', text: `❌ ${text}` }], isError: true }
}

function wrap<A extends Record<string, unknown>>(
  handler: (args: A, ctx: Ctx) => Promise<TextResult> | TextResult,
  ctx: Ctx,
) {
  return async (args: A): Promise<TextResult> => {
    try {
      return await handler(args, ctx)
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  }
}

const POINT = z.array(z.number()).length(2)
const POINTS = z.array(POINT).min(1)
const PROJECT_DIR = z.string().min(1).optional().describe('当前项目的绝对目录。插件市场宿主若从插件目录启动 MCP，首次调用时必须传入。')

function projectLine(client: HubClient): string {
  const board = client.activeBoard
  return `项目「${client.project.name}」· 画布「${board?.title ?? '？'}」· ${client.boardUrl}`
}

/** 画布尺寸解析：自定义 width/height 优先，其次预设，默认 desktop */
function boardSize(args: { preset?: 'desktop' | 'laptop' | 'tablet' | 'phone'; width?: number; height?: number }): [number, number] {
  const preset: Record<string, [number, number]> = {
    desktop: [1440, 900],
    laptop: [1280, 800],
    tablet: [820, 1180],
    phone: [390, 844],
  }
  if ((args.width === undefined) !== (args.height === undefined)) throw new Error('自定义画布须同时提供 width 和 height')
  const size = args.width !== undefined && args.height !== undefined ? [args.width, args.height] as [number, number] : (args.preset ? preset[args.preset] : preset.desktop)
  validateBoardDimensions(...size)
  return size
}

export function registerTools(server: McpServer, ctx: Ctx): void {
  // ---------- 画板 ----------

  server.registerTool(
    'setup_board',
    {
      description:
        '支起一块**新的**画布并切过去画（一个界面一块画布，旧画布原样保留，不会清空）。可选尺寸预设 desktop/laptop/tablet/phone 或自定义 width/height。画别的界面就再 setup_board；回到旧画布用 switch_board；想清空当前画布用 clear scope=board。项目里同标题的画布只能有一块。',
      inputSchema: {
        title: z.string().min(1).max(48).optional().describe('画布标题，建议用界面名（如「登录页」「设置页」）；不传自动编号'),
        preset: z.enum(['desktop', 'laptop', 'tablet', 'phone']).optional().describe('尺寸预设：desktop=1440×900, laptop=1280×800, tablet=820×1180, phone=390×844'),
        width: z.number().int().min(BOARD_MIN_SIZE).max(BOARD_MAX_WIDTH).optional().describe('自定义宽，需同时提供 height'),
        height: z.number().int().min(BOARD_MIN_SIZE).max(BOARD_MAX_HEIGHT).optional().describe('自定义高，需同时提供 width；宽高乘积不能超过 33554432'),
        grid: z.boolean().optional().describe('是否画浅网格（默认开，建议开着方便对齐）'),
        project_dir: PROJECT_DIR,
      },
    },
    wrap(async (args, c) => {
      const client = await c.client(args.project_dir)
      const [w, h] = boardSize(args)
      const meta = await client.createBoard({
        ...(args.title ? { title: args.title } : {}),
        width: w,
        height: h,
        grid: args.grid ?? true,
      })
      return ok(
        `新画布已支起：「${meta.title}」（${w}×${h}，网格${args.grid ?? true ? '开' : '关'}）。图层（底→顶）：草稿、线稿、批注，当前在「草稿」层。\n` +
          `本项目共 ${client.project.boards.length} 块画布——画别的界面再 setup_board，回旧画布用 switch_board。\n` +
          `${projectLine(client)}（用 show_board 让人类看到）。\n` +
          `画法提示：先在草稿层用细灰线(宽1 #9ca3af)打布局，正式线稿画到线稿层（switch 到「线稿」后再画）。`,
      )
    }, ctx),
  )

  server.registerTool(
    'resize_board',
    {
      description: '无损扩展当前画布：保留图元、图层与批注，可撤销；只允许扩大或保持宽高。长页面可保持宽度并增加高度，面积不超过 33554432 像素。',
      inputSchema: {
        width: z.number().int().min(BOARD_MIN_SIZE).max(BOARD_MAX_WIDTH).optional().describe('目标宽度，省略保持原宽'),
        height: z.number().int().min(BOARD_MIN_SIZE).max(BOARD_MAX_HEIGHT).optional().describe('目标高度，省略保持原高'),
      },
    },
    wrap(async (args, c) => {
      if (args.width === undefined && args.height === undefined) throw new Error('请指定 width 或 height')
      const client = await c.client()
      const { board } = await client.state()
      const width = args.width ?? board.width
      const height = args.height ?? board.height
      validateBoardDimensions(width, height)
      await client.commit({ type: 'resize', width, height })
      return ok(`画布已从 ${board.width}×${board.height} 扩展到 ${width}×${height}，原内容已保留（可撤销）。`)
    }, ctx),
  )

  server.registerTool(
    'switch_board',
    {
      description:
        '切换到本项目的另一块画布（按 id 或标题，如 switch_board board=登录页）。之后所有画板工具都落在这块画布上。项目里有哪些画布用 list_boards 看。',
      inputSchema: {
        board: z.string().min(1).describe('目标画布的 id 或标题'),
      },
    },
    wrap(async (args, c) => {
      const client = await c.client()
      const b = await client.switchBoard(args.board)
      const { board } = await client.state()
      return ok(
        `已切到画布「${b.title}」（id=${b.id}）：${board.width}×${board.height}，${board.elements.length} 个图元，当前图层「${board.activeLayer}」。之后的笔画都画在这块画布上。`,
      )
    }, ctx),
  )

  server.registerTool(
    'list_boards',
    {
      description: '列出本项目所有画布（id、标题、尺寸、图元数、更新时间，标注当前所在画布）。首次调用可传 project_dir 选择当前项目。一个界面一块画布：新界面用 setup_board 支新的，旧界面 switch_board 切回去。',
      inputSchema: { project_dir: PROJECT_DIR },
    },
    wrap(async (args, c) => {
      const client = await c.client(args.project_dir)
      const boards = await client.listBoards()
      if (boards.length === 0) {
        return ok(`项目「${client.project.name}」还没有画布。用 setup_board（可带 title，如「登录页」）支起第一块。`)
      }
      const active = client.activeBoard
      const lines = boards.map((b) => {
        const mark = b.id === active?.id ? ' ← 当前' : ''
        const when = b.updatedAt ? ` · ${(b.updatedAt.replace('T', ' ').slice(0, 16))}` : ''
        return `- 「${b.title}」（id=${b.id}）${b.width ?? '?'}×${b.height ?? '?'} · ${b.elements ?? '?'} 个图元${when}${mark}`
      })
      return ok(`项目「${client.project.name}」共 ${boards.length} 块画布：\n${lines.join('\n')}\n切换：switch_board board=<id 或标题>`)
    }, ctx),
  )

  server.registerTool(
    'show_board',
    {
      description:
        '把当前画布的页面呈现在人类眼前（每块画布一个地址，项目里其他画布用页面顶部的切换器或 list_boards 拿地址）。默认优先在 agent 桌面的内置浏览器里打开；环境没有内置浏览器能力时回落到系统默认浏览器。你自己看画面请用 look_at_board。',
      inputSchema: {
        opener: z
          .enum(['auto', 'desktop', 'system', 'none'])
          .optional()
          .describe('auto=优先应用内浏览器、失败回落系统浏览器（默认）；desktop=只用应用内浏览器；system=直接用系统默认浏览器；none=只返回地址'),
      },
    },
    wrap(async (args, c) => {
      const client = await c.client()
      const url = client.boardUrl
      const envOpener = process.env.UI_DRAW_OPENER
      const opener =
        args.opener ??
        (envOpener === 'system' || envOpener === 'desktop' || envOpener === 'none' ? envOpener : 'auto')
      const inDesktop = !!(
        process.env.ZCODE_APP_VERSION ||
        process.env.ZCODE_PROCESS_LABEL ||
        process.env.ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED
      )

      if (opener === 'none') return ok(`画板地址：${url}（${projectLine(client)}）`)

      if (opener === 'system' || (opener === 'auto' && !inDesktop)) {
        const { openInBrowser } = await import('../hub/open.js')
        const r = await openInBrowser(url)
        if (r.ok) {
          return ok(
            `已在系统默认浏览器打开画板：${url}\n（${projectLine(client)}）\n人类的每一次落笔都会同步；他框选写的批注用 list_annotations / inspect_board 读取。`,
          )
        }
        return ok(`⚠️ 自动打开浏览器失败（${r.error ?? '未知原因'}）。请把地址给人类手动打开：${url}`)
      }

      return ok(
        `画板地址：${url}\n（${projectLine(client)}）\n\n` +
          `👉 请立刻用你的**内置浏览器**（ZCode 桌面版的应用内浏览器）打开上面的地址，让人类能边聊边看画板。\n` +
          `如果你的环境没有内置浏览器能力，或打开失败：马上再调用一次 show_board 并传 opener="system"，改用系统默认浏览器；还不行就把地址直接告诉人类，请他手动打开。\n` +
          `人类的落笔会实时同步；他框选写的批注用 list_annotations / inspect_board 读取。`,
      )
    }, ctx),
  )

  // ---------- 画（每个工具 = 画板上的一个手势） ----------

  const drawDesc = (what: string, extra = '') =>
    `在画板上${what}（一次手势，画在当前图层）${extra}。返回图元 id。坐标建议取整并吸附 20px 网格。`

  server.registerTool(
    'draw_stroke',
    {
      description: drawDesc('徒手画一笔（像拿铅笔从落笔拖到抬笔）', '。适合画不规则轮廓、连线、圈画'),
      inputSchema: {
        points: POINTS.min(2).describe('笔迹经过的点 [[x,y],...]，至少 2 个'),
        color: z.string().optional().describe('笔色，默认 ' + INK),
        width: z.number().min(0.5).max(40).optional().describe('笔粗，默认 2；草稿建议 1'),
        dash: z.boolean().optional().describe('虚线'),
      },
    },
    wrap(async (args, c) => {
      const client = await c.client()
      const { board } = await client.state()
      const el = {
        id: newId(),
        kind: 'stroke' as const,
        layer: board.activeLayer,
        points: args.points as [number, number][],
        color: args.color ?? INK,
        width: args.width ?? 2,
        ...(args.dash ? { dash: args.dash } : {}),
      }
      await client.commit({ type: 'addElement', element: el })
      return ok(`已在「${el.layer}」层画了一笔（${el.points.length} 个点，${el.color}×${el.width}），图元 id：${el.id}`)
    }, ctx),
  )

  server.registerTool(
    'draw_line',
    {
      description: drawDesc('用直尺画一条直线（从 (x1,y1) 到 (x2,y2)）', '。分割线、连线用这个，别用手绘'),
      inputSchema: {
        x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(),
        color: z.string().optional(),
        width: z.number().min(0.5).max(40).optional(),
        dash: z.boolean().optional().describe('虚线（参考线用）'),
      },
    },
    wrap(async (args, c) => {
      const client = await c.client()
      const { board } = await client.state()
      const el = { id: newId(), kind: 'line' as const, layer: board.activeLayer, ...args, color: args.color ?? INK, width: args.width ?? 2 }
      await client.commit({ type: 'addElement', element: el })
      return ok(`已在「${el.layer}」层画了一条直线，图元 id：${el.id}`)
    }, ctx),
  )

  server.registerTool(
    'draw_rect',
    {
      description: drawDesc('拖出一个矩形', '。(x,y) 是左上角，w/h 是宽高；可带圆角 radius、填充 fill。按钮、输入框、卡片、容器都用它'),
      inputSchema: {
        x: z.number(), y: z.number(),
        w: z.number().min(1).describe('宽'), h: z.number().min(1).describe('高'),
        color: z.string().optional().describe('描边色'),
        width: z.number().min(0.5).max(40).optional().describe('描边粗细，默认 2'),
        fill: z.string().optional().describe('填充色（不传=透明）'),
        radius: z.number().min(0).max(200).optional().describe('圆角半径'),
        dash: z.boolean().optional().describe('虚线边框'),
      },
    },
    wrap(async (args, c) => {
      const client = await c.client()
      const { board } = await client.state()
      const el = { id: newId(), kind: 'rect' as const, layer: board.activeLayer, ...args, color: args.color ?? INK, width: args.width ?? 2 }
      await client.commit({ type: 'addElement', element: el })
      return ok(`已在「${el.layer}」层画了一个矩形 (${Math.round(el.x)},${Math.round(el.y)}) ${Math.round(el.w)}×${Math.round(el.h)}，图元 id：${el.id}`)
    }, ctx),
  )

  server.registerTool(
    'draw_ellipse',
    {
      description: drawDesc('拖出一个椭圆/圆', '。(x,y,w,h) 是外接矩形；正圆就 w=h'),
      inputSchema: {
        x: z.number(), y: z.number(), w: z.number().min(1), h: z.number().min(1),
        color: z.string().optional(),
        width: z.number().min(0.5).max(40).optional(),
        fill: z.string().optional(),
        dash: z.boolean().optional(),
      },
    },
    wrap(async (args, c) => {
      const client = await c.client()
      const { board } = await client.state()
      const el = { id: newId(), kind: 'ellipse' as const, layer: board.activeLayer, ...args, color: args.color ?? INK, width: args.width ?? 2 }
      await client.commit({ type: 'addElement', element: el })
      return ok(`已在「${el.layer}」层画了一个椭圆，图元 id：${el.id}`)
    }, ctx),
  )

  server.registerTool(
    'draw_arrow',
    {
      description: drawDesc('画一个带箭头的指引线', '。流程指向、批注标注用'),
      inputSchema: {
        x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(),
        color: z.string().optional(),
        width: z.number().min(0.5).max(40).optional(),
      },
    },
    wrap(async (args, c) => {
      const client = await c.client()
      const { board } = await client.state()
      const el = { id: newId(), kind: 'arrow' as const, layer: board.activeLayer, ...args, color: args.color ?? INK, width: args.width ?? 2 }
      await client.commit({ type: 'addElement', element: el })
      return ok(`已在「${el.layer}」层画了一个箭头，图元 id：${el.id}`)
    }, ctx),
  )

  server.registerTool(
    'write_text',
    {
      description: drawDesc('写下一段文字', '。(x,y) 是文字左上角。支持 \\n 换行。标题、按钮文案、标签、说明都用它，不要用笔手写文字'),
      inputSchema: {
        x: z.number(), y: z.number(),
        content: z.string().min(1).describe('文字内容，支持换行'),
        size: z.number().min(8).max(120).optional().describe('字号，默认 16；页面大标题建议 24-32'),
        color: z.string().optional(),
      },
    },
    wrap(async (args, c) => {
      const client = await c.client()
      const { board } = await client.state()
      const el = { id: newId(), kind: 'text' as const, layer: board.activeLayer, ...args, size: args.size ?? 16, color: args.color ?? INK }
      await client.commit({ type: 'addElement', element: el })
      return ok(`已在「${el.layer}」层写下文字「${args.content.split('\n')[0].slice(0, 20)}${args.content.length > 20 ? '…' : ''}」，图元 id：${el.id}`)
    }, ctx),
  )

  server.registerTool(
    'paste_reference',
    {
      description: drawDesc('把一张本地图片贴到画板上当参考（像把参考图夹在画板边）', '。常贴现有 UI 截图，供对照修改；建议先建一个「参考」图层再贴'),
      inputSchema: {
        path: z.string().describe('本地图片路径（png/jpg/webp/gif）；相对路径以当前项目为基准'),
        x: z.number(), y: z.number(),
        w: z.number().min(10).optional().describe('显示宽，缺省用图片原始尺寸（等比）'),
      },
    },
    wrap(async (args, c) => {
      const client = await c.client()
      const abs = resolve(client.project.projectDir, args.path)
      if (!existsSync(abs)) throw new Error(`图片不存在：${abs}`)
      const buf = readFileSync(abs)
      const ext = abs.toLowerCase()
      const mime = ext.endsWith('.png') ? 'image/png' : ext.endsWith('.webp') ? 'image/webp' : ext.endsWith('.gif') ? 'image/gif' : 'image/jpeg'
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`
      const nat = decodeImageSize(dataUrl)
      const w = args.w ?? nat.width
      const h = Math.round((w / nat.width) * nat.height)
      const { board } = await client.state()
      const el = { id: newId(), kind: 'image' as const, layer: board.activeLayer, x: args.x, y: args.y, w, h, src: dataUrl }
      await client.commit({ type: 'addElement', element: el })
      return ok(`已把参考图贴到「${el.layer}」层 (${Math.round(el.x)},${Math.round(el.y)}) ${w}×${h}，图元 id：${el.id}`)
    }, ctx),
  )

  // ---------- 批注（人机沟通的正式通道） ----------

  server.registerTool(
    'add_annotation',
    {
      description:
        '在画布上圈出一块区域并附一句说明（给人类看的批注/提问，编号自动分配）。批注画在「批注」层，人打开浏览器就能看到编号和说明；人类的回批也是批注，用 list_annotations 读。',
      inputSchema: {
        x: z.number(), y: z.number(), w: z.number().min(1), h: z.number().min(1),
        text: z.string().min(1).describe('说明文字，一句话说清问题或建议'),
        color: z.string().optional(),
      },
    },
    wrap(async (args, c) => {
      const client = await c.client()
      const { board } = await client.state()
      const layer = board.layers.some((l) => l.name === '批注') ? '批注' : board.activeLayer
      const el: AnnotationElement = {
        id: newId(),
        kind: 'annotation',
        layer,
        x: args.x, y: args.y, w: args.w, h: args.h,
        text: args.text,
        n: nextAnnotationNumber(board.elements),
        status: 'open',
        author: 'agent',
        ...(args.color ? { color: args.color } : {}),
      }
      await client.commit({ type: 'addElement', element: el })
      return ok(`已留批注 #${el.n}（${el.id}）区域 (${Math.round(el.x)},${Math.round(el.y)}) ${Math.round(el.w)}×${Math.round(el.h)}：「${el.text}」`)
    }, ctx),
  )

  server.registerTool(
    'list_annotations',
    {
      description:
        '读批注清单：人类在浏览器批注层圈出区域写下的说明都在这里，agent 也可以读自己的批注。默认只列待处理的；处理完一条用 resolve_annotation 标记。',
      inputSchema: {
        status: z.enum(['open', 'resolved', 'all']).optional().describe('默认 open（只看待处理）'),
      },
    },
    wrap(async (args, c) => {
      const client = await c.client()
      const { board } = await client.state()
      return ok(formatAnnotations(annotationsOf(board, args.status ?? 'open')))
    }, ctx),
  )

  server.registerTool(
    'resolve_annotation',
    {
      description: '把某条批注标记为已解决（可按编号 n 或图元 id 指定，可一次传多个）。标记后画布上会变淡，清单里不再算待处理。',
      inputSchema: {
        ids: z.array(z.string()).optional().describe('批注图元 id'),
        numbers: z.array(z.number()).optional().describe('批注编号 #n'),
      },
    },
    wrap(async (args, c) => {
      const client = await c.client()
      const wanted = new Set([...(args.ids ?? []), ...(args.numbers ?? []).map((n) => `#${n}`)])
      if (wanted.size === 0) throw new Error('需要 ids 或 numbers')
      const { board } = await client.state()
      const targets = annotationsOf(board, 'all').filter((a) => wanted.has(a.id) || wanted.has(`#${a.n}`))
      if (targets.length === 0) throw new Error('没找到匹配的批注')
      await client.commit({ type: 'setAnnotationStatus', ids: targets.map((a) => a.id), status: 'resolved' })
      return ok(`已标记 ${targets.length} 条批注为已解决：${targets.map((a) => `#${a.n}`).join('、')}`)
    }, ctx),
  )

  // ---------- 改 ----------

  server.registerTool(
    'erase',
    {
      description: '用橡皮在当前图层上划过：笔迹经过之处碰到的图元会被擦掉（整图元删除）。points 是划过的点序列。',
      inputSchema: {
        points: POINTS.describe('橡皮划过的点 [[x,y],...]（一个点也行=点一下擦）'),
      },
    },
    wrap(async (args, c) => {
      const client = await c.client()
      const { board } = await client.state()
      const targets = board.elements.filter(
        (el) => el.layer === board.activeLayer && args.points.some(([px, py]) => hitElement(el, px, py, 4)),
      )
      if (targets.length === 0) return ok('橡皮没碰到当前图层的任何图元。')
      await client.commit({ type: 'deleteElements', ids: targets.map((e) => e.id) })
      return ok(`擦掉了「${board.activeLayer}」层的 ${targets.length} 个图元：${targets.map((e) => `${e.id}(${e.kind})`).join('、')}`)
    }, ctx),
  )

  server.registerTool(
    'move_elements',
    {
      description: '把选中的图元挪动一段距离（像人用手指拖动元素调整布局）。dx/dy 为正表示向右/向下。',
      inputSchema: {
        ids: z.array(z.string()).min(1).describe('图元 id 列表（来自各画图工具的返回或 inspect_board）'),
        dx: z.number().describe('水平位移'),
        dy: z.number().describe('垂直位移'),
      },
    },
    wrap(async (args, c) => {
      const client = await c.client()
      await client.commit({ type: 'moveElements', ids: args.ids, dx: args.dx, dy: args.dy })
      return ok(`已把 ${args.ids.length} 个图元挪动了 (${Math.round(args.dx)},${Math.round(args.dy)})`)
    }, ctx),
  )

  server.registerTool(
    'delete_elements',
    {
      description: '删掉指定的图元（画错的单个元素用这个，比擦除精确）。',
      inputSchema: {
        ids: z.array(z.string()).min(1),
      },
    },
    wrap(async (args, c) => {
      const client = await c.client()
      await client.commit({ type: 'deleteElements', ids: args.ids })
      return ok(`已删除 ${args.ids.length} 个图元：${args.ids.join('、')}`)
    }, ctx),
  )

  server.registerTool(
    'undo_redo',
    {
      description: '反悔（undo）或重做（redo）上一步。人和你的操作在同一个历史里（按项目共享）。',
      inputSchema: {
        action: z.enum(['undo', 'redo']),
      },
    },
    wrap(async (args, c) => {
      const client = await c.client()
      const r = args.action === 'undo' ? await client.undo() : await client.redo()
      return r.ok
        ? ok(args.action === 'undo' ? '已撤销上一步。' : '已重做。')
        : ok(args.action === 'undo' ? '没有可撤销的操作了。' : '没有可重做的操作。')
    }, ctx),
  )

  server.registerTool(
    'clear',
    {
      description: '清空：scope=active 清当前图层，scope=layer 清指定图层，scope=board 清整块画板。慎用，可 undo。',
      inputSchema: {
        scope: z.enum(['active', 'layer', 'board']).default('active'),
        layer: z.string().optional().describe('scope=layer 时的图层名'),
      },
    },
    wrap(async (args, c) => {
      const client = await c.client()
      const { board } = await client.state()
      const layer = args.scope === 'board' ? undefined : (args.layer ?? board.activeLayer)
      await client.commit({ type: 'clear', layer })
      return ok(layer === undefined ? '已清空整块画板（可 undo）。' : `已清空「${layer}」层（可 undo）。`)
    }, ctx),
  )

  // ---------- 图层 ----------

  server.registerTool(
    'layers',
    {
      description:
        '图层操作（画板惯例：草稿层打草稿，线稿层画正式线框，批注层留给人类的意见）。action=list 查看全部；add 新建（新建后记得 switch 过去）；switch 换当前图层（之后所有绘制都落在这层）；rename 重命名；show/hide 显示隐藏；remove 删除（层上图元一并删除）。',
      inputSchema: {
        action: z.enum(['list', 'add', 'switch', 'rename', 'show', 'hide', 'remove']),
        name: z.string().optional().describe('目标图层名'),
        newName: z.string().optional().describe('rename 的新名字'),
      },
    },
    wrap(async (args, c) => {
      const client = await c.client()
      switch (args.action) {
        case 'list': {
          const { board } = await client.state()
          const lines = board.layers.map(
            (l) => `- ${l.name}${l.visible ? '' : '（隐藏）'}：${board.elements.filter((e) => e.layer === l.name).length} 个图元${l.name === board.activeLayer ? ' ← 当前' : ''}`,
          )
          return ok(`图层（底→顶）：\n${lines.join('\n')}`)
        }
        case 'add':
          if (!args.name) throw new Error('需要 name（新图层名）')
          await client.commit({ type: 'addLayer', name: args.name })
          return ok(`已新建图层「${args.name}」。用 action=switch 切换过去再画。`)
        case 'switch':
          if (!args.name) throw new Error('需要 name')
          await client.commit({ type: 'setActiveLayer', name: args.name })
          return ok(`当前图层已切到「${args.name}」，接下来的笔画都落在这层。`)
        case 'rename':
          if (!args.name || !args.newName) throw new Error('需要 name 和 newName')
          await client.commit({ type: 'renameLayer', name: args.name, newName: args.newName })
          return ok(`图层「${args.name}」已改名为「${args.newName}」。`)
        case 'show':
        case 'hide':
          if (!args.name) throw new Error('需要 name')
          await client.commit({ type: 'setLayerVisible', name: args.name, visible: args.action === 'show' })
          return ok(`图层「${args.name}」已${args.action === 'show' ? '显示' : '隐藏'}。`)
        case 'remove':
          if (!args.name) throw new Error('需要 name')
          await client.commit({ type: 'removeLayer', name: args.name })
          return ok(`已删除图层「${args.name}」及其上图元。`)
      }
    }, ctx),
  )

  // ---------- 看 ----------

  server.registerTool(
    'look_at_board',
    {
      description:
        '看一眼画板：返回当前画面的截图（PNG）。画几步就应看一眼自查布局。region 只看某个区域，scale 放大看细节（如 2 倍），layer 只看某一层（如只看批注层的人类意见）。',
      inputSchema: {
        layer: z.string().optional().describe('只看这一层（默认全部可见层）'),
        region: z
          .object({ x: z.number().min(-BOARD_MAX_HEIGHT).max(BOARD_MAX_HEIGHT), y: z.number().min(-BOARD_MAX_HEIGHT).max(BOARD_MAX_HEIGHT), w: z.number().min(1).max(BOARD_MAX_WIDTH), h: z.number().min(1).max(BOARD_MAX_HEIGHT) })
          .optional()
          .describe('只看这个矩形区域（画板坐标）'),
        scale: z.number().min(0.5).max(3).optional().describe('缩放倍率，默认 1；看细节用 2'),
      },
    },
    wrap(async (args, c) => {
      const client = await c.client()
      const { board, revision } = await client.state()
      const actualScale = boundedRasterScale(args.region?.w ?? board.width, args.region?.h ?? board.height, args.scale ?? 1)
      const png = await client.screenshot({
        scale: actualScale,
        ...(args.region ? { region: args.region } : {}),
        ...(args.layer ? { layer: args.layer } : {}),
      })
      const where = args.region
        ? `区域(${Math.round(args.region.x)},${Math.round(args.region.y)}) ${Math.round(args.region.w)}×${Math.round(args.region.h)}${args.scale && args.scale !== 1 ? ` ×${args.scale}` : ''}`
        : '全画板'
      return {
        content: [
          { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
          {
            type: 'text',
            text: `项目「${client.project.name}」· 画板 ${board.width}×${board.height} · 第 ${revision} 版 · ${where} · 实际倍率 ${actualScale}${args.layer ? ` · 只看「${args.layer}」层` : ''}`,
          },
        ],
      }
    }, ctx),
  )

  server.registerTool(
    'inspect_board',
    {
      description: '查看画板内容清单：所有图层与图元的 id、类型、坐标、文字。首次调用可传 project_dir 选择当前项目。要精确移动/删除某元素、或读人类在批注层写了什么，用这个。',
      inputSchema: { project_dir: PROJECT_DIR },
    },
    wrap(async (args, c) => {
      const client = await c.client(args.project_dir)
      const { board } = await client.state()
      const canvas = client.guardBoard()
      const others = client.project.boards.filter((b) => b.id !== canvas.id)
      const boardNote =
        others.length > 0
          ? `本项目共 ${client.project.boards.length} 块画布，其他：${others.map((b) => `「${b.title}」`).join('')}（switch_board 切换）`
          : '画新界面用 setup_board 支新画布'
      return ok(
        `${inspectBoard(board)}\n\n画布：「${canvas.title}」（id=${canvas.id}）· ${boardNote}\n项目：${client.project.name}（${client.project.projectDir}）\n画布地址：${client.boardUrl}`,
      )
    }, ctx),
  )

  // ---------- 存 ----------

  server.registerTool(
    'save_board',
    {
      description:
        '把当前画布另存一份快照文件（日常自动存档在用户目录，这里用于归档/迁移）。默认存到 <项目>/.ui-draw/<画布id>.json。',
      inputSchema: {
        path: z.string().optional().describe('保存路径（.json），相对路径以当前项目为基准；缺省当前项目下 .ui-draw/<画布id>.json'),
      },
    },
    wrap(async (args, c) => {
      const client = await c.client()
      const { board } = await client.state()
      const canvas = client.guardBoard()
      const abs = saveBoardFile(board, args.path ? resolve(client.project.projectDir, args.path) : defaultBoardSavePath(client.project.projectDir, canvas.id))
      await client.flush()
      return ok(`画布「${canvas.title}」已另存：${abs}（${board.elements.length} 个图元；日常自动存档在用户目录，每块画布一个文件）`)
    }, ctx),
  )

  server.registerTool(
    'load_board',
    {
      description: '把一份画板快照恢复到当前画布上（替换当前画布内容，可 undo）。',
      inputSchema: {
        path: z.string().describe('board.json 路径；相对路径以当前项目为基准'),
      },
    },
    wrap(async (args, c) => {
      const client = await c.client()
      const board = loadBoardFile(resolve(client.project.projectDir, args.path))
      await client.restore(board)
      return ok(`已恢复到画布「${client.guardBoard().title}」：${board.width}×${board.height}，${board.elements.length} 个图元，当前图层「${board.activeLayer}」。`)
    }, ctx),
  )

  server.registerTool(
    'finalize_design',
    {
      description:
        '设计定稿：把当前画布的设计包导出到项目目录（默认 design/<画布标题>/）——design.png（优先 2 倍，过大时自动降低倍率）、design.svg、board.json、DESIGN.md（含每个图元的精确坐标与文案的实施说明）。一块画布定稿一份设计包，互不覆盖。下一步写 UI 代码时就以这份设计为准。',
      inputSchema: {
        dir: z.string().optional().describe('导出目录，相对路径以当前项目为基准；缺省 <项目>/design/<画布标题>'),
      },
    },
    wrap(async (args, c) => {
      const client = await c.client()
      const { board } = await client.state()
      const canvas = client.guardBoard()
      const actualScale = boundedRasterScale(board.width, board.height, 2)
      const png = await client.screenshot({ scale: actualScale, hideAnnotations: true })
      const svg = await client.svg()
      const files = writeDesignBundle(board, args.dir ? resolve(client.project.projectDir, args.dir) : join(defaultDesignDir(client.project.projectDir), slugify(canvas.title)), png, svg)
      return ok(
        `画布「${canvas.title}」的设计已定稿导出（PNG 实际倍率 ${actualScale}）：\n${files.map((f) => `- ${f}`).join('\n')}\n\n实施 UI 时先读 DESIGN.md 拿精确坐标与文案，再对照 design.png 的视觉效果。`,
      )
    }, ctx),
  )
}
