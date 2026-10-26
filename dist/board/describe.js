import { annotationLabel, elementBBox } from './ops.js';
const KIND_CN = {
    stroke: '徒手笔迹',
    line: '直线',
    rect: '矩形',
    ellipse: '椭圆',
    arrow: '箭头',
    text: '文字',
    image: '图片',
    annotation: '批注',
};
function fmt(n) {
    return String(Math.round(n));
}
function elementLine(el) {
    const box = elementBBox(el);
    const at = `(${fmt(box.x)},${fmt(box.y)}) ${fmt(box.w)}×${fmt(box.h)}`;
    const parts = [`[${el.id}] ${KIND_CN[el.kind]} ${at}`];
    switch (el.kind) {
        case 'text':
            parts.push(`「${el.content.replace(/\n/g, ' / ')}」 ${el.size}px ${el.color}`);
            break;
        case 'stroke':
            parts.push(`${el.points.length} 个点 ${el.color}×${el.width}`);
            break;
        case 'rect':
        case 'ellipse':
            parts.push(`${el.color}×${el.width}` +
                `${el.fill && el.fill !== 'transparent' ? ` 填充=${el.fill}` : ''}` +
                `${el.kind === 'rect' && el.radius ? ` 圆角=${el.radius}` : ''}`);
            break;
        case 'image':
            parts.push(`参考图`);
            break;
        case 'annotation':
            parts.push(`#${el.n} ${el.status === 'open' ? '待处理' : '已解决'} ${el.author === 'human' ? '人类' : 'agent'}：${el.text.replace(/\n/g, ' / ')}`);
            break;
        default:
            parts.push(`${el.color}×${el.width}`);
    }
    return '- ' + parts.join(' · ');
}
export function annotationsOf(board, status = 'all') {
    return board.elements.filter((e) => e.kind === 'annotation' && (status === 'all' || e.status === status));
}
/** 给 agent 读的批注清单（每行可直接拿去改） */
export function formatAnnotations(list) {
    if (list.length === 0)
        return '批注：无';
    const lines = list.map((a) => {
        const box = elementBBox(a);
        const state = a.status === 'open' ? '待处理' : '已解决';
        const who = a.author === 'human' ? '人类' : 'agent';
        return `- ${annotationLabel(a.n)} #${a.n} ${state}（${who}）区域 (${fmt(box.x)},${fmt(box.y)}) ${fmt(box.w)}×${fmt(box.h)}，id=${a.id}\n  ${a.text.replace(/\n/g, '\n  ')}`;
    });
    return lines.join('\n');
}
/** inspect_board 工具的输出：给人读/给 agent 读的画板内容清单 */
export function inspectBoard(board) {
    const lines = [];
    lines.push(`画板 ${board.width}×${board.height}，网格${board.grid ? '开' : '关'}，共 ${board.elements.length} 个图元`);
    const open = annotationsOf(board, 'open');
    const resolved = annotationsOf(board, 'resolved');
    if (open.length + resolved.length > 0) {
        lines.push('');
        lines.push(`📌 批注：待处理 ${open.length} 条，已解决 ${resolved.length} 条`);
        if (open.length > 0) {
            lines.push('待处理批注（按编号逐条处理，处理后用 resolve_annotation 标记）：');
            lines.push(formatAnnotations(open));
        }
        if (resolved.length > 0) {
            lines.push(`已解决：${resolved.map((a) => `#${a.n}`).join('、')}`);
        }
    }
    lines.push('');
    lines.push('图层（底→顶）：');
    for (const l of board.layers) {
        const count = board.elements.filter((e) => e.layer === l.name).length;
        const mark = l.name === board.activeLayer ? '← 当前' : '';
        lines.push(`- ${l.name}${l.visible ? '' : '（隐藏）'}：${count} 个图元 ${mark}`);
    }
    for (const l of board.layers) {
        const els = board.elements.filter((e) => e.layer === l.name);
        if (els.length === 0)
            continue;
        lines.push('');
        lines.push(`「${l.name}」层：`);
        for (const el of els)
            lines.push(elementLine(el));
    }
    return lines.join('\n');
}
/** 定稿导出的结构化设计说明 */
export function designMarkdown(board) {
    const out = [];
    const today = new Date().toISOString().slice(0, 10);
    const annotations = annotationsOf(board, 'all');
    out.push(`# UI 设计说明（ui-draw 定稿）`);
    out.push('');
    out.push(`- 画板尺寸：${board.width} × ${board.height}（坐标原点在左上角）`);
    out.push(`- 导出日期：${today}`);
    out.push(`- 配图：design.png（2 倍图）、design.svg（矢量）、board.json（可恢复的画板数据）`);
    out.push('');
    out.push('> 坐标单位均为像素；实施 UI 时以 design.png 视觉效果为准，本说明提供精确坐标与文案。批注不计入设计图，仅作反馈记录。');
    out.push('');
    const visible = board.layers.filter((l) => l.visible);
    for (const l of visible) {
        const els = board.elements.filter((e) => e.layer === l.name && e.kind !== 'annotation');
        if (els.length === 0)
            continue;
        out.push(`## 图层「${l.name}」`);
        out.push('');
        out.push('| id | 类型 | 位置(x,y) | 尺寸(w×h) | 样式/内容 |');
        out.push('| --- | --- | --- | --- | --- |');
        for (const el of els) {
            const box = elementBBox(el);
            let style = '';
            switch (el.kind) {
                case 'text':
                    style = `${el.size}px ${el.color}，文案：${el.content.replace(/\n/g, ' ⏎ ')}`;
                    break;
                case 'stroke':
                    style = `${el.color} × ${el.width}`;
                    break;
                case 'rect':
                case 'ellipse':
                    style =
                        `描边 ${el.color} × ${el.width}` +
                            `${el.fill && el.fill !== 'transparent' ? `，填充 ${el.fill}` : ''}` +
                            `${el.kind === 'rect' && el.radius ? `，圆角 ${el.radius}px` : ''}`;
                    break;
                case 'image':
                    style = '参考图（视觉参照，不属于实现内容）';
                    break;
                default:
                    style = `${el.kind === 'line' || el.kind === 'arrow' ? `${el.color} × ${el.width}` : ''}`;
            }
            out.push(`| ${el.id} | ${KIND_CN[el.kind]} | ${fmt(box.x)}, ${fmt(box.y)} | ${fmt(box.w)} × ${fmt(box.h)} | ${style.replace(/\|/g, '\\|')} |`);
        }
        out.push('');
    }
    // 文案清单：实施时直接可用
    const texts = board.elements.filter((e) => e.kind === 'text');
    if (texts.length > 0) {
        out.push('## 文案清单');
        out.push('');
        for (const t of texts)
            out.push(`- (${fmt(t.x)},${fmt(t.y)}) ${t.size}px：${t.content.replace(/\n/g, ' ⏎ ')}`);
        out.push('');
    }
    const colors = new Set();
    for (const el of board.elements) {
        if (el.kind === 'annotation')
            continue;
        if ('color' in el)
            colors.add(el.color);
        if ('fill' in el && el.fill && el.fill !== 'transparent')
            colors.add(el.fill);
    }
    if (colors.size > 0) {
        out.push(`## 用色`);
        out.push('');
        out.push([...colors].join('、'));
        out.push('');
    }
    if (annotations.length > 0) {
        out.push(`## 过程批注（反馈记录）`);
        out.push('');
        for (const a of annotations) {
            const box = elementBBox(a);
            const who = a.author === 'human' ? '人类' : 'agent';
            out.push(`- ${annotationLabel(a.n)}（${who}，${a.status === 'open' ? '待处理' : '已解决'}）区域 (${fmt(box.x)}, ${fmt(box.y)}) ${fmt(box.w)} × ${fmt(box.h)}：${a.text.replace(/\n/g, ' ⏎ ')}`);
        }
        out.push('');
    }
    return out.join('\n');
}
