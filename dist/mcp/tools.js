import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hitElement, nextAnnotationNumber } from '../board/ops.js';
import { annotationsOf, formatAnnotations, inspectBoard } from '../board/describe.js';
import { decodeImageSize } from '../render/raster.js';
import { defaultDesignDir, defaultSavePath, loadBoardFile, saveBoardFile, writeDesignBundle } from '../persist.js';
const INK = '#1f2937';
function newId() {
    return 'e' + randomUUID().replace(/-/g, '').slice(0, 10);
}
function ok(text) {
    return { content: [{ type: 'text', text }] };
}
function fail(text) {
    return { content: [{ type: 'text', text: `❌ ${text}` }], isError: true };
}
function wrap(handler, ctx) {
    return async (args) => {
        try {
            return await handler(args, ctx);
        }
        catch (err) {
            return fail(err instanceof Error ? err.message : String(err));
        }
    };
}
const POINTS = z
    .array(z.tuple([z.number(), z.number()]))
    .min(1)
    .describe('点序列 [[x,y],...]，至少 1 个');
function projectLine(client) {
    return `项目「${client.project.name}」· 画板 ${client.boardUrl}`;
}
export function registerTools(server, ctx) {
    // ---------- 画板 ----------
    server.registerTool('setup_board', {
        description: '支起一块新画板（换新板，会清空当前内容！）。可选尺寸预设 desktop/laptop/tablet/phone 或自定义 width/height。每个项目一块画板、按项目名区分（多个 agent 共享同一个本地服务）；启动时会自动恢复上次的画板，此时 setup_board 会被拒绝，除非显式传 force=true 重来。',
        inputSchema: {
            preset: z.enum(['desktop', 'laptop', 'tablet', 'phone']).optional().describe('尺寸预设：desktop=1440×900, laptop=1280×800, tablet=820×1180, phone=390×844'),
            width: z.number().int().min(200).max(4096).optional().describe('自定义宽（优先于 preset）'),
            height: z.number().int().min(200).max(4096).optional().describe('自定义高'),
            grid: z.boolean().optional().describe('是否画浅网格（默认开，建议开着方便对齐）'),
            force: z.boolean().optional().describe('画板上已有内容时，必须显式设 true 才会清空重来'),
        },
    }, wrap(async (args, c) => {
        const client = await c.client();
        const { board } = await client.state();
        if (board.elements.length > 0 && !args.force) {
            return fail(`项目「${client.project.name}」的画板上已经有 ${board.elements.length} 个图元（自动恢复/自动存档在 ${client.storePath}）。\n` +
                `如果要接着画，直接用 draw_* / move_elements 等工具即可，不要重新支板。\n` +
                `确实要清空重来：setup_board 传 force=true，或 clear scope=board 后继续。`);
        }
        const preset = {
            desktop: [1440, 900],
            laptop: [1280, 800],
            tablet: [820, 1180],
            phone: [390, 844],
        };
        const [w, h] = args.width && args.height
            ? [args.width, args.height]
            : (args.preset ? preset[args.preset] : preset.desktop);
        await client.commit({ type: 'setup', width: w, height: h, grid: args.grid ?? true });
        return ok(`画板已支起：${w}×${h}，网格${args.grid ?? true ? '开' : '关'}。图层（底→顶）：草稿、线稿、批注，当前在「草稿」层。\n` +
            `${projectLine(client)}（用 show_board 让人类看到）。\n` +
            `画法提示：先在草稿层用细灰线(宽1 #9ca3af)打布局，正式线稿画到线稿层（switch 到「线稿」后再画）。`);
    }, ctx));
    server.registerTool('show_board', {
        description: '把画板页面呈现在人类眼前（按项目名区分的独立地址）。默认优先在 agent 桌面的内置浏览器里打开；环境没有内置浏览器能力时回落到系统默认浏览器。你自己看画面请用 look_at_board。',
        inputSchema: {
            opener: z
                .enum(['auto', 'desktop', 'system', 'none'])
                .optional()
                .describe('auto=优先应用内浏览器、失败回落系统浏览器（默认）；desktop=只用应用内浏览器；system=直接用系统默认浏览器；none=只返回地址'),
        },
    }, wrap(async (args, c) => {
        const client = await c.client();
        const url = client.boardUrl;
        const envOpener = process.env.UI_DRAW_OPENER;
        const opener = args.opener ??
            (envOpener === 'system' || envOpener === 'desktop' || envOpener === 'none' ? envOpener : 'auto');
        const inDesktop = !!(process.env.ZCODE_APP_VERSION ||
            process.env.ZCODE_PROCESS_LABEL ||
            process.env.ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED);
        if (opener === 'none')
            return ok(`画板地址：${url}（${projectLine(client)}）`);
        if (opener === 'system' || (opener === 'auto' && !inDesktop)) {
            const { openInBrowser } = await import('../hub/open.js');
            const r = await openInBrowser(url);
            if (r.ok) {
                return ok(`已在系统默认浏览器打开画板：${url}\n（${projectLine(client)}）\n人类的每一次落笔都会同步；他框选写的批注用 list_annotations / inspect_board 读取。`);
            }
            return ok(`⚠️ 自动打开浏览器失败（${r.error ?? '未知原因'}）。请把地址给人类手动打开：${url}`);
        }
        return ok(`画板地址：${url}\n（${projectLine(client)}）\n\n` +
            `👉 请立刻用你的**内置浏览器**（ZCode 桌面版的应用内浏览器）打开上面的地址，让人类能边聊边看画板。\n` +
            `如果你的环境没有内置浏览器能力，或打开失败：马上再调用一次 show_board 并传 opener="system"，改用系统默认浏览器；还不行就把地址直接告诉人类，请他手动打开。\n` +
            `人类的落笔会实时同步；他框选写的批注用 list_annotations / inspect_board 读取。`);
    }, ctx));
    // ---------- 画（每个工具 = 画板上的一个手势） ----------
    const drawDesc = (what, extra = '') => `在画板上${what}（一次手势，画在当前图层）${extra}。返回图元 id。坐标建议取整并吸附 20px 网格。`;
    server.registerTool('draw_stroke', {
        description: drawDesc('徒手画一笔（像拿铅笔从落笔拖到抬笔）', '。适合画不规则轮廓、连线、圈画'),
        inputSchema: {
            points: POINTS.describe('笔迹经过的点 [[x,y],...]，至少 2 个'),
            color: z.string().optional().describe('笔色，默认 ' + INK),
            width: z.number().min(0.5).max(40).optional().describe('笔粗，默认 2；草稿建议 1'),
            dash: z.boolean().optional().describe('虚线'),
        },
    }, wrap(async (args, c) => {
        const client = await c.client();
        const { board } = await client.state();
        const el = {
            id: newId(),
            kind: 'stroke',
            layer: board.activeLayer,
            points: args.points,
            color: args.color ?? INK,
            width: args.width ?? 2,
            ...(args.dash ? { dash: args.dash } : {}),
        };
        await client.commit({ type: 'addElement', element: el });
        return ok(`已在「${el.layer}」层画了一笔（${el.points.length} 个点，${el.color}×${el.width}），图元 id：${el.id}`);
    }, ctx));
    server.registerTool('draw_line', {
        description: drawDesc('用直尺画一条直线（从 (x1,y1) 到 (x2,y2)）', '。分割线、连线用这个，别用手绘'),
        inputSchema: {
            x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(),
            color: z.string().optional(),
            width: z.number().min(0.5).max(40).optional(),
            dash: z.boolean().optional().describe('虚线（参考线用）'),
        },
    }, wrap(async (args, c) => {
        const client = await c.client();
        const { board } = await client.state();
        const el = { id: newId(), kind: 'line', layer: board.activeLayer, ...args, color: args.color ?? INK, width: args.width ?? 2 };
        await client.commit({ type: 'addElement', element: el });
        return ok(`已在「${el.layer}」层画了一条直线，图元 id：${el.id}`);
    }, ctx));
    server.registerTool('draw_rect', {
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
    }, wrap(async (args, c) => {
        const client = await c.client();
        const { board } = await client.state();
        const el = { id: newId(), kind: 'rect', layer: board.activeLayer, ...args, color: args.color ?? INK, width: args.width ?? 2 };
        await client.commit({ type: 'addElement', element: el });
        return ok(`已在「${el.layer}」层画了一个矩形 (${Math.round(el.x)},${Math.round(el.y)}) ${Math.round(el.w)}×${Math.round(el.h)}，图元 id：${el.id}`);
    }, ctx));
    server.registerTool('draw_ellipse', {
        description: drawDesc('拖出一个椭圆/圆', '。(x,y,w,h) 是外接矩形；正圆就 w=h'),
        inputSchema: {
            x: z.number(), y: z.number(), w: z.number().min(1), h: z.number().min(1),
            color: z.string().optional(),
            width: z.number().min(0.5).max(40).optional(),
            fill: z.string().optional(),
            dash: z.boolean().optional(),
        },
    }, wrap(async (args, c) => {
        const client = await c.client();
        const { board } = await client.state();
        const el = { id: newId(), kind: 'ellipse', layer: board.activeLayer, ...args, color: args.color ?? INK, width: args.width ?? 2 };
        await client.commit({ type: 'addElement', element: el });
        return ok(`已在「${el.layer}」层画了一个椭圆，图元 id：${el.id}`);
    }, ctx));
    server.registerTool('draw_arrow', {
        description: drawDesc('画一个带箭头的指引线', '。流程指向、批注标注用'),
        inputSchema: {
            x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(),
            color: z.string().optional(),
            width: z.number().min(0.5).max(40).optional(),
        },
    }, wrap(async (args, c) => {
        const client = await c.client();
        const { board } = await client.state();
        const el = { id: newId(), kind: 'arrow', layer: board.activeLayer, ...args, color: args.color ?? INK, width: args.width ?? 2 };
        await client.commit({ type: 'addElement', element: el });
        return ok(`已在「${el.layer}」层画了一个箭头，图元 id：${el.id}`);
    }, ctx));
    server.registerTool('write_text', {
        description: drawDesc('写下一段文字', '。(x,y) 是文字左上角。支持 \\n 换行。标题、按钮文案、标签、说明都用它，不要用笔手写文字'),
        inputSchema: {
            x: z.number(), y: z.number(),
            content: z.string().min(1).describe('文字内容，支持换行'),
            size: z.number().min(8).max(120).optional().describe('字号，默认 16；页面大标题建议 24-32'),
            color: z.string().optional(),
        },
    }, wrap(async (args, c) => {
        const client = await c.client();
        const { board } = await client.state();
        const el = { id: newId(), kind: 'text', layer: board.activeLayer, ...args, size: args.size ?? 16, color: args.color ?? INK };
        await client.commit({ type: 'addElement', element: el });
        return ok(`已在「${el.layer}」层写下文字「${args.content.split('\n')[0].slice(0, 20)}${args.content.length > 20 ? '…' : ''}」，图元 id：${el.id}`);
    }, ctx));
    server.registerTool('paste_reference', {
        description: drawDesc('把一张本地图片贴到画板上当参考（像把参考图夹在画板边）', '。常贴现有 UI 截图，供对照修改；建议先建一个「参考」图层再贴'),
        inputSchema: {
            path: z.string().describe('本地图片路径（png/jpg/webp/gif）'),
            x: z.number(), y: z.number(),
            w: z.number().min(10).optional().describe('显示宽，缺省用图片原始尺寸（等比）'),
        },
    }, wrap(async (args, c) => {
        const client = await c.client();
        const abs = resolve(args.path);
        if (!existsSync(abs))
            throw new Error(`图片不存在：${abs}`);
        const buf = readFileSync(abs);
        const ext = abs.toLowerCase();
        const mime = ext.endsWith('.png') ? 'image/png' : ext.endsWith('.webp') ? 'image/webp' : ext.endsWith('.gif') ? 'image/gif' : 'image/jpeg';
        const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
        const nat = decodeImageSize(dataUrl);
        const w = args.w ?? nat.width;
        const h = Math.round((w / nat.width) * nat.height);
        const { board } = await client.state();
        const el = { id: newId(), kind: 'image', layer: board.activeLayer, x: args.x, y: args.y, w, h, src: dataUrl };
        await client.commit({ type: 'addElement', element: el });
        return ok(`已把参考图贴到「${el.layer}」层 (${Math.round(el.x)},${Math.round(el.y)}) ${w}×${h}，图元 id：${el.id}`);
    }, ctx));
    // ---------- 批注（人机沟通的正式通道） ----------
    server.registerTool('add_annotation', {
        description: '在画布上圈出一块区域并附一句说明（给人类看的批注/提问，编号自动分配）。批注画在「批注」层，人打开浏览器就能看到编号和说明；人类的回批也是批注，用 list_annotations 读。',
        inputSchema: {
            x: z.number(), y: z.number(), w: z.number().min(1), h: z.number().min(1),
            text: z.string().min(1).describe('说明文字，一句话说清问题或建议'),
            color: z.string().optional(),
        },
    }, wrap(async (args, c) => {
        const client = await c.client();
        const { board } = await client.state();
        const layer = board.layers.some((l) => l.name === '批注') ? '批注' : board.activeLayer;
        const el = {
            id: newId(),
            kind: 'annotation',
            layer,
            x: args.x, y: args.y, w: args.w, h: args.h,
            text: args.text,
            n: nextAnnotationNumber(board.elements),
            status: 'open',
            author: 'agent',
            ...(args.color ? { color: args.color } : {}),
        };
        await client.commit({ type: 'addElement', element: el });
        return ok(`已留批注 #${el.n}（${el.id}）区域 (${Math.round(el.x)},${Math.round(el.y)}) ${Math.round(el.w)}×${Math.round(el.h)}：「${el.text}」`);
    }, ctx));
    server.registerTool('list_annotations', {
        description: '读批注清单：人类在浏览器批注层圈出区域写下的说明都在这里，agent 也可以读自己的批注。默认只列待处理的；处理完一条用 resolve_annotation 标记。',
        inputSchema: {
            status: z.enum(['open', 'resolved', 'all']).optional().describe('默认 open（只看待处理）'),
        },
    }, wrap(async (args, c) => {
        const client = await c.client();
        const { board } = await client.state();
        return ok(formatAnnotations(annotationsOf(board, args.status ?? 'open')));
    }, ctx));
    server.registerTool('resolve_annotation', {
        description: '把某条批注标记为已解决（可按编号 n 或图元 id 指定，可一次传多个）。标记后画布上会变淡，清单里不再算待处理。',
        inputSchema: {
            ids: z.array(z.string()).optional().describe('批注图元 id'),
            numbers: z.array(z.number()).optional().describe('批注编号 #n'),
        },
    }, wrap(async (args, c) => {
        const client = await c.client();
        const wanted = new Set([...(args.ids ?? []), ...(args.numbers ?? []).map((n) => `#${n}`)]);
        if (wanted.size === 0)
            throw new Error('需要 ids 或 numbers');
        const { board } = await client.state();
        const targets = annotationsOf(board, 'all').filter((a) => wanted.has(a.id) || wanted.has(`#${a.n}`));
        if (targets.length === 0)
            throw new Error('没找到匹配的批注');
        await client.commit({ type: 'setAnnotationStatus', ids: targets.map((a) => a.id), status: 'resolved' });
        return ok(`已标记 ${targets.length} 条批注为已解决：${targets.map((a) => `#${a.n}`).join('、')}`);
    }, ctx));
    // ---------- 改 ----------
    server.registerTool('erase', {
        description: '用橡皮在当前图层上划过：笔迹经过之处碰到的图元会被擦掉（整图元删除）。points 是划过的点序列。',
        inputSchema: {
            points: POINTS.describe('橡皮划过的点 [[x,y],...]（一个点也行=点一下擦）'),
        },
    }, wrap(async (args, c) => {
        const client = await c.client();
        const { board } = await client.state();
        const targets = board.elements.filter((el) => el.layer === board.activeLayer && args.points.some(([px, py]) => hitElement(el, px, py, 4)));
        if (targets.length === 0)
            return ok('橡皮没碰到当前图层的任何图元。');
        await client.commit({ type: 'deleteElements', ids: targets.map((e) => e.id) });
        return ok(`擦掉了「${board.activeLayer}」层的 ${targets.length} 个图元：${targets.map((e) => `${e.id}(${e.kind})`).join('、')}`);
    }, ctx));
    server.registerTool('move_elements', {
        description: '把选中的图元挪动一段距离（像人用手指拖动元素调整布局）。dx/dy 为正表示向右/向下。',
        inputSchema: {
            ids: z.array(z.string()).min(1).describe('图元 id 列表（来自各画图工具的返回或 inspect_board）'),
            dx: z.number().describe('水平位移'),
            dy: z.number().describe('垂直位移'),
        },
    }, wrap(async (args, c) => {
        const client = await c.client();
        await client.commit({ type: 'moveElements', ids: args.ids, dx: args.dx, dy: args.dy });
        return ok(`已把 ${args.ids.length} 个图元挪动了 (${Math.round(args.dx)},${Math.round(args.dy)})`);
    }, ctx));
    server.registerTool('delete_elements', {
        description: '删掉指定的图元（画错的单个元素用这个，比擦除精确）。',
        inputSchema: {
            ids: z.array(z.string()).min(1),
        },
    }, wrap(async (args, c) => {
        const client = await c.client();
        await client.commit({ type: 'deleteElements', ids: args.ids });
        return ok(`已删除 ${args.ids.length} 个图元：${args.ids.join('、')}`);
    }, ctx));
    server.registerTool('undo_redo', {
        description: '反悔（undo）或重做（redo）上一步。人和你的操作在同一个历史里（按项目共享）。',
        inputSchema: {
            action: z.enum(['undo', 'redo']),
        },
    }, wrap(async (args, c) => {
        const client = await c.client();
        const r = args.action === 'undo' ? await client.undo() : await client.redo();
        return r.ok
            ? ok(args.action === 'undo' ? '已撤销上一步。' : '已重做。')
            : ok(args.action === 'undo' ? '没有可撤销的操作了。' : '没有可重做的操作。');
    }, ctx));
    server.registerTool('clear', {
        description: '清空：scope=active 清当前图层，scope=layer 清指定图层，scope=board 清整块画板。慎用，可 undo。',
        inputSchema: {
            scope: z.enum(['active', 'layer', 'board']).default('active'),
            layer: z.string().optional().describe('scope=layer 时的图层名'),
        },
    }, wrap(async (args, c) => {
        const client = await c.client();
        const { board } = await client.state();
        const layer = args.scope === 'board' ? undefined : (args.layer ?? board.activeLayer);
        await client.commit({ type: 'clear', layer });
        return ok(layer === undefined ? '已清空整块画板（可 undo）。' : `已清空「${layer}」层（可 undo）。`);
    }, ctx));
    // ---------- 图层 ----------
    server.registerTool('layers', {
        description: '图层操作（画板惯例：草稿层打草稿，线稿层画正式线框，批注层留给人类的意见）。action=list 查看全部；add 新建（新建后记得 switch 过去）；switch 换当前图层（之后所有绘制都落在这层）；rename 重命名；show/hide 显示隐藏；remove 删除（层上图元一并删除）。',
        inputSchema: {
            action: z.enum(['list', 'add', 'switch', 'rename', 'show', 'hide', 'remove']),
            name: z.string().optional().describe('目标图层名'),
            newName: z.string().optional().describe('rename 的新名字'),
        },
    }, wrap(async (args, c) => {
        const client = await c.client();
        switch (args.action) {
            case 'list': {
                const { board } = await client.state();
                const lines = board.layers.map((l) => `- ${l.name}${l.visible ? '' : '（隐藏）'}：${board.elements.filter((e) => e.layer === l.name).length} 个图元${l.name === board.activeLayer ? ' ← 当前' : ''}`);
                return ok(`图层（底→顶）：\n${lines.join('\n')}`);
            }
            case 'add':
                if (!args.name)
                    throw new Error('需要 name（新图层名）');
                await client.commit({ type: 'addLayer', name: args.name });
                return ok(`已新建图层「${args.name}」。用 action=switch 切换过去再画。`);
            case 'switch':
                if (!args.name)
                    throw new Error('需要 name');
                await client.commit({ type: 'setActiveLayer', name: args.name });
                return ok(`当前图层已切到「${args.name}」，接下来的笔画都落在这层。`);
            case 'rename':
                if (!args.name || !args.newName)
                    throw new Error('需要 name 和 newName');
                await client.commit({ type: 'renameLayer', name: args.name, newName: args.newName });
                return ok(`图层「${args.name}」已改名为「${args.newName}」。`);
            case 'show':
            case 'hide':
                if (!args.name)
                    throw new Error('需要 name');
                await client.commit({ type: 'setLayerVisible', name: args.name, visible: args.action === 'show' });
                return ok(`图层「${args.name}」已${args.action === 'show' ? '显示' : '隐藏'}。`);
            case 'remove':
                if (!args.name)
                    throw new Error('需要 name');
                await client.commit({ type: 'removeLayer', name: args.name });
                return ok(`已删除图层「${args.name}」及其上图元。`);
        }
    }, ctx));
    // ---------- 看 ----------
    server.registerTool('look_at_board', {
        description: '看一眼画板：返回当前画面的截图（PNG）。画几步就应看一眼自查布局。region 只看某个区域，scale 放大看细节（如 2 倍），layer 只看某一层（如只看批注层的人类意见）。',
        inputSchema: {
            layer: z.string().optional().describe('只看这一层（默认全部可见层）'),
            region: z
                .object({ x: z.number(), y: z.number(), w: z.number().min(1), h: z.number().min(1) })
                .optional()
                .describe('只看这个矩形区域（画板坐标）'),
            scale: z.number().min(0.5).max(3).optional().describe('缩放倍率，默认 1；看细节用 2'),
        },
    }, wrap(async (args, c) => {
        const client = await c.client();
        const { board, revision } = await client.state();
        const png = await client.screenshot({
            ...(args.scale ? { scale: args.scale } : {}),
            ...(args.region ? { region: args.region } : {}),
            ...(args.layer ? { layer: args.layer } : {}),
        });
        const where = args.region
            ? `区域(${Math.round(args.region.x)},${Math.round(args.region.y)}) ${Math.round(args.region.w)}×${Math.round(args.region.h)}${args.scale && args.scale !== 1 ? ` ×${args.scale}` : ''}`
            : '全画板';
        return {
            content: [
                { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
                {
                    type: 'text',
                    text: `项目「${client.project.name}」· 画板 ${board.width}×${board.height} · 第 ${revision} 版 · ${where}${args.layer ? ` · 只看「${args.layer}」层` : ''}`,
                },
            ],
        };
    }, ctx));
    server.registerTool('inspect_board', {
        description: '查看画板内容清单：所有图层与图元的 id、类型、坐标、文字。要精确移动/删除某元素、或读人类在批注层写了什么，用这个。',
        inputSchema: {},
    }, wrap(async (_args, c) => {
        const client = await c.client();
        const { board } = await client.state();
        return ok(`${inspectBoard(board)}\n\n项目：${client.project.name}（${client.project.projectDir}）\n画板地址：${client.boardUrl}\n自动存档：${client.storePath}`);
    }, ctx));
    // ---------- 存 ----------
    server.registerTool('save_board', {
        description: '把画板另存一份快照文件（日常自动存档在用户目录，这里用于归档/迁移）。默认存到 <项目>/.ui-draw/board.json。',
        inputSchema: {
            path: z.string().optional().describe('保存路径（.json），缺省当前项目下 .ui-draw/board.json'),
        },
    }, wrap(async (args, c) => {
        const client = await c.client();
        const { board } = await client.state();
        const abs = saveBoardFile(board, args.path ?? defaultSavePath());
        await client.flush();
        return ok(`画板已另存：${abs}（${board.elements.length} 个图元；日常自动存档仍在 ${client.storePath}）`);
    }, ctx));
    server.registerTool('load_board', {
        description: '把一份画板快照恢复到当前项目的画板上（替换当前内容，可 undo）。',
        inputSchema: {
            path: z.string().describe('board.json 路径'),
        },
    }, wrap(async (args, c) => {
        const client = await c.client();
        const board = loadBoardFile(args.path);
        await client.restore(board);
        return ok(`已恢复画板：${board.width}×${board.height}，${board.elements.length} 个图元，当前图层「${board.activeLayer}」。`);
    }, ctx));
    server.registerTool('finalize_design', {
        description: '设计定稿：把设计包导出到项目目录（默认 design/）——design.png（2 倍图）、design.svg、board.json、DESIGN.md（含每个图元的精确坐标与文案的实施说明）。下一步写 UI 代码时就以这份设计为准。',
        inputSchema: {
            dir: z.string().optional().describe('导出目录，缺省 <项目>/design'),
        },
    }, wrap(async (args, c) => {
        const client = await c.client();
        const { board } = await client.state();
        const png = await client.screenshot({ scale: 2, hideAnnotations: true });
        const svg = await client.svg();
        const files = writeDesignBundle(board, args.dir ?? defaultDesignDir(), png, svg);
        return ok(`设计已定稿导出：\n${files.map((f) => `- ${f}`).join('\n')}\n\n实施 UI 时先读 DESIGN.md 拿精确坐标与文案，再对照 design.png 的视觉效果。`);
    }, ctx));
}
