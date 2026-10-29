export const INK_DEFAULT = '#1f2937';
export const GRID_MINOR = 20;
export const GRID_MAJOR = 100;
export function renderBoard(ctx, board, opts = {}) {
    const scale = opts.scale ?? 1;
    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(-(opts.offsetX ?? 0), -(opts.offsetY ?? 0));
    // 画板底色
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, board.width, board.height);
    if (opts.drawGrid ?? board.grid)
        drawGrid(ctx, board, scale);
    for (const layer of board.layers) {
        if (!layer.visible)
            continue;
        if (opts.layerFilter && !opts.layerFilter(layer))
            continue;
        for (const el of board.elements) {
            if (el.layer !== layer.name)
                continue;
            if (opts.skipAnnotations && el.kind === 'annotation')
                continue;
            drawElement(ctx, el, opts);
        }
    }
    ctx.restore();
}
function drawGrid(ctx, board, scale) {
    ctx.save();
    ctx.lineWidth = 1 / scale;
    for (let x = GRID_MINOR; x < board.width; x += GRID_MINOR) {
        ctx.strokeStyle = x % GRID_MAJOR === 0 ? '#e3e8ef' : '#f0f3f7';
        ctx.beginPath();
        ctx.moveTo(x + 0.5 / scale, 0);
        ctx.lineTo(x + 0.5 / scale, board.height);
        ctx.stroke();
    }
    for (let y = GRID_MINOR; y < board.height; y += GRID_MINOR) {
        ctx.strokeStyle = y % GRID_MAJOR === 0 ? '#e3e8ef' : '#f0f3f7';
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5 / scale);
        ctx.lineTo(board.width, y + 0.5 / scale);
        ctx.stroke();
    }
    ctx.restore();
}
function progressOf(el, opts) {
    return opts.progress?.get(el.id) ?? 1;
}
export function drawElement(ctx, el, opts = {}) {
    const t = progressOf(el, opts);
    if (t <= 0)
        return;
    switch (el.kind) {
        case 'stroke':
            drawStroke(ctx, el, t);
            break;
        case 'line':
            drawLine(ctx, el, t);
            break;
        case 'rect':
            drawRect(ctx, el, t);
            break;
        case 'ellipse':
            drawEllipse(ctx, el, t);
            break;
        case 'arrow':
            drawArrow(ctx, el, t);
            break;
        case 'text':
            drawText(ctx, el, t);
            break;
        case 'image':
            drawImageEl(ctx, el, t, opts);
            break;
        case 'annotation':
            drawAnnotation(ctx, el, t);
            break;
    }
}
function applyStrokeStyle(ctx, color, width, dash) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash(dash ? [width * 3 + 6, width * 2 + 4] : []);
}
function drawStroke(ctx, el, t) {
    const n = Math.max(2, Math.ceil(el.points.length * t));
    const pts = el.points.slice(0, n);
    if (pts.length < 2)
        return;
    ctx.save();
    applyStrokeStyle(ctx, el.color, el.width, el.dash);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++)
        ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
    ctx.restore();
}
function drawLine(ctx, el, t) {
    ctx.save();
    applyStrokeStyle(ctx, el.color, el.width, el.dash);
    ctx.beginPath();
    ctx.moveTo(el.x1, el.y1);
    ctx.lineTo(el.x1 + (el.x2 - el.x1) * t, el.y1 + (el.y2 - el.y1) * t);
    ctx.stroke();
    ctx.restore();
}
function roundedRectPath(ctx, x, y, w, h, r) {
    const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
}
function drawRect(ctx, el, t) {
    const w = el.w * t;
    const h = el.h * t;
    if (Math.abs(w) < 0.5 || Math.abs(h) < 0.5)
        return;
    ctx.save();
    if (el.fill && el.fill !== 'transparent') {
        ctx.fillStyle = el.fill;
        roundedRectPath(ctx, el.x, el.y, w, h, el.radius ?? 0);
        ctx.fill();
    }
    applyStrokeStyle(ctx, el.color, el.width, el.dash);
    roundedRectPath(ctx, el.x, el.y, w, h, el.radius ?? 0);
    ctx.stroke();
    ctx.restore();
}
function drawEllipse(ctx, el, t) {
    const w = el.w * t;
    const h = el.h * t;
    if (w < 0.5 || h < 0.5)
        return;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(el.x + el.w / 2, el.y + el.h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
    if (el.fill && el.fill !== 'transparent') {
        ctx.fillStyle = el.fill;
        ctx.fill();
    }
    applyStrokeStyle(ctx, el.color, el.width, el.dash);
    ctx.stroke();
    ctx.restore();
}
function drawArrow(ctx, el, t) {
    const x2 = el.x1 + (el.x2 - el.x1) * t;
    const y2 = el.y1 + (el.y2 - el.y1) * t;
    ctx.save();
    applyStrokeStyle(ctx, el.color, el.width);
    ctx.beginPath();
    ctx.moveTo(el.x1, el.y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    // 实心箭头
    const angle = Math.atan2(el.y2 - el.y1, el.x2 - el.x1);
    const headLen = 10 + el.width * 2.5;
    const spread = Math.PI / 7;
    ctx.fillStyle = el.color;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - headLen * Math.cos(angle - spread), y2 - headLen * Math.sin(angle - spread));
    ctx.lineTo(x2 - headLen * Math.cos(angle + spread), y2 - headLen * Math.sin(angle + spread));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}
export const FONT_STACK = '"Microsoft YaHei", "PingFang SC", sans-serif';
export const LINE_HEIGHT = 1.4;
function drawText(ctx, el, t) {
    ctx.save();
    ctx.fillStyle = el.color;
    ctx.font = `${el.size}px ${FONT_STACK}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    if (t < 1)
        ctx.globalAlpha = Math.max(0.15, t);
    const lines = el.content.split('\n');
    const lineH = el.size * LINE_HEIGHT;
    lines.forEach((line, i) => {
        ctx.fillText(line, el.x, el.y + i * lineH);
    });
    ctx.restore();
}
function drawImageEl(ctx, el, t, opts) {
    const img = opts.images?.get(el.id);
    ctx.save();
    if (t < 1)
        ctx.globalAlpha = Math.max(0.15, t);
    if (img) {
        ctx.drawImage(img, el.x, el.y, el.w, el.h);
    }
    else {
        // 图片尚未解码完成：画占位框
        ctx.fillStyle = '#f3f4f6';
        ctx.fillRect(el.x, el.y, el.w, el.h);
        applyStrokeStyle(ctx, '#9ca3af', 1, true);
        ctx.strokeRect?.(el.x, el.y, el.w, el.h);
        ctx.fillStyle = '#6b7280';
        ctx.font = `14px ${FONT_STACK}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('图片加载中…', el.x + el.w / 2, el.y + el.h / 2);
    }
    ctx.restore();
}
const ANNOTATION_HUMAN = '#f59e0b';
const ANNOTATION_AGENT = '#2563eb';
export function annotationColor(author, override) {
    return override ?? (author === 'agent' ? ANNOTATION_AGENT : ANNOTATION_HUMAN);
}
function hexToRgba(hex, alpha) {
    let h = hex.replace('#', '');
    if (h.length === 3)
        h = h.split('').map((c) => c + c).join('');
    const n = Number.parseInt(h, 16);
    if (!Number.isFinite(n) || h.length !== 6)
        return `rgba(245, 158, 11, ${alpha})`;
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
/** 批注：半透明色块圈出区域 + 编号徽标 + 框下的一句说明 */
function drawAnnotation(ctx, el, t) {
    const base = annotationColor(el.author, el.color);
    const open = el.status !== 'resolved';
    ctx.save();
    ctx.globalAlpha = (open ? 1 : 0.45) * Math.min(1, Math.max(0.15, t));
    // 区域底色 + 虚线边框
    ctx.fillStyle = hexToRgba(base, 0.12);
    roundedRectPath(ctx, el.x, el.y, el.w, el.h, 6);
    ctx.fill();
    ctx.strokeStyle = base;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    roundedRectPath(ctx, el.x, el.y, el.w, el.h, 6);
    ctx.stroke();
    ctx.setLineDash([]);
    // 编号徽标（左上角）
    const r = 11;
    const bx = el.x + r + 2;
    const by = el.y + r + 2;
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fillStyle = base;
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 12px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(el.n), bx, by + 0.5);
    // 框下说明（单行，过长截断）
    const label = el.text.replace(/\s*\n\s*/g, ' ');
    const maxChars = 40;
    const shown = label.length > maxChars ? label.slice(0, maxChars) + '…' : label;
    const chipY = el.y + el.h + 6;
    const chipH = 22;
    const padX = 7;
    ctx.font = `12px ${FONT_STACK}`;
    const chipW = Math.min(ctx.measureText(shown).width + padX * 2, 420);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    roundedRectPath(ctx, el.x, chipY, chipW, chipH, 5);
    ctx.fill();
    ctx.strokeStyle = base;
    ctx.lineWidth = 1;
    roundedRectPath(ctx, el.x, chipY, chipW, chipH, 5);
    ctx.stroke();
    ctx.fillStyle = '#374151';
    ctx.textAlign = 'left';
    ctx.fillText(shown, el.x + padX, chipY + chipH / 2 + 0.5, chipW - padX * 2);
    ctx.restore();
}
