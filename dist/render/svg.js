import { elementBBox } from '../board/ops.js';
import { FONT_STACK } from '../board/render.js';
/** 把画板序列化为矢量 SVG（仅可见图层） */
export function boardToSvg(board) {
    const parts = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${board.width}" height="${board.height}" viewBox="0 0 ${board.width} ${board.height}">`);
    parts.push(`<rect width="${board.width}" height="${board.height}" fill="#ffffff"/>`);
    const visible = new Set(board.layers.filter((l) => l.visible).map((l) => l.name));
    for (const el of board.elements) {
        if (!visible.has(el.layer))
            continue;
        // 批注是反馈记录，不进设计矢量图
        if (el.kind === 'annotation')
            continue;
        parts.push(elementToSvg(el));
    }
    parts.push('</svg>');
    return parts.join('\n');
}
function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function strokeAttrs(color, width, dash) {
    const d = dash ? ` stroke-dasharray="${width * 3 + 6} ${width * 2 + 4}"` : '';
    return `stroke="${esc(color)}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${d}`;
}
function elementToSvg(el) {
    switch (el.kind) {
        case 'stroke': {
            const pts = el.points.map(([x, y]) => `${round(x)},${round(y)}`).join(' ');
            return `<polyline points="${pts}" fill="none" ${strokeAttrs(el.color, el.width, el.dash)}/>`;
        }
        case 'line':
            return `<line x1="${round(el.x1)}" y1="${round(el.y1)}" x2="${round(el.x2)}" y2="${round(el.y2)}" ${strokeAttrs(el.color, el.width, el.dash)}/>`;
        case 'rect': {
            const fill = el.fill && el.fill !== 'transparent' ? `fill="${esc(el.fill)}"` : 'fill="none"';
            const rx = el.radius ? ` rx="${Math.min(el.radius, Math.min(el.w, el.h) / 2)}"` : '';
            return `<rect x="${round(el.x)}" y="${round(el.y)}" width="${round(el.w)}" height="${round(el.h)}"${rx} ${fill} ${strokeAttrs(el.color, el.width, el.dash)}/>`;
        }
        case 'ellipse': {
            const fill = el.fill && el.fill !== 'transparent' ? `fill="${esc(el.fill)}"` : 'fill="none"';
            return `<ellipse cx="${round(el.x + el.w / 2)}" cy="${round(el.y + el.h / 2)}" rx="${round(Math.abs(el.w / 2))}" ry="${round(Math.abs(el.h / 2))}" ${fill} ${strokeAttrs(el.color, el.width, el.dash)}/>`;
        }
        case 'arrow': {
            const angle = Math.atan2(el.y2 - el.y1, el.x2 - el.x1);
            const headLen = 10 + el.width * 2.5;
            const spread = Math.PI / 7;
            const p1x = el.x2 - headLen * Math.cos(angle - spread);
            const p1y = el.y2 - headLen * Math.sin(angle - spread);
            const p2x = el.x2 - headLen * Math.cos(angle + spread);
            const p2y = el.y2 - headLen * Math.sin(angle + spread);
            return (`<g>` +
                `<line x1="${round(el.x1)}" y1="${round(el.y1)}" x2="${round(el.x2)}" y2="${round(el.y2)}" ${strokeAttrs(el.color, el.width)}/>` +
                `<polygon points="${round(el.x2)},${round(el.y2)} ${round(p1x)},${round(p1y)} ${round(p2x)},${round(p2y)}" fill="${esc(el.color)}"/>` +
                `</g>`);
        }
        case 'text': {
            const lineH = el.size * 1.4;
            const lines = el.content.split('\n');
            const tspans = lines
                .map((line, i) => `<tspan x="${round(el.x)}" y="${round(el.y + i * lineH + el.size * 0.8)}">${esc(line)}</tspan>`)
                .join('');
            return `<text font-family='${FONT_STACK.replace(/"/g, '')}' font-size="${el.size}" fill="${esc(el.color)}">${tspans}</text>`;
        }
        case 'image':
            return `<image x="${round(el.x)}" y="${round(el.y)}" width="${round(el.w)}" height="${round(el.h)}" href="${esc(el.src)}"/>`;
        case 'annotation':
            // 由调用方过滤，这里兜底返回空串
            return '';
    }
}
function round(n) {
    return Math.round(n * 10) / 10;
}
/** SVG 里文字包围盒需要的时候用（导出 DESIGN.md 沿用估算） */
export function svgElementBBox(el) {
    return elementBBox(el);
}
