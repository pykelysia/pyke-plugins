import { defaultBoard } from './types.js';
export class OpError extends Error {
}
export const BOARD_MIN_SIZE = 200;
export const BOARD_MAX_WIDTH = 4096;
export const BOARD_MAX_HEIGHT = 16384;
export const BOARD_MAX_AREA = 33_554_432;
/** 统一限制画布尺寸，防止异常尺寸造成不可用的浏览器画布或过量内存分配。 */
export function validateBoardDimensions(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height))
        throw new OpError('画布宽高必须是整数');
    if (width < BOARD_MIN_SIZE || width > BOARD_MAX_WIDTH || height < BOARD_MIN_SIZE || height > BOARD_MAX_HEIGHT) {
        throw new OpError(`画布宽须为 ${BOARD_MIN_SIZE}–${BOARD_MAX_WIDTH}，高须为 ${BOARD_MIN_SIZE}–${BOARD_MAX_HEIGHT}`);
    }
    if (width * height > BOARD_MAX_AREA)
        throw new OpError(`画布面积不能超过 ${BOARD_MAX_AREA} 像素`);
}
function requireLayer(board, name) {
    const layer = board.layers.find((l) => l.name === name);
    if (!layer)
        throw new OpError(`图层「${name}」不存在`);
    return layer;
}
function clone(v) {
    return structuredClone(v);
}
export function applyOp(board, op) {
    const next = clone(board);
    switch (op.type) {
        case 'setup': {
            validateBoardDimensions(op.width, op.height);
            const fresh = defaultBoard();
            fresh.width = op.width;
            fresh.height = op.height;
            fresh.grid = op.grid ?? board.grid;
            return fresh;
        }
        case 'resize': {
            validateBoardDimensions(op.width, op.height);
            if (op.width < board.width || op.height < board.height)
                throw new OpError('画布只能扩大，不能缩小');
            next.width = op.width;
            next.height = op.height;
            return next;
        }
        case 'addElement':
        case 'addElements': {
            const elements = op.type === 'addElement' ? [op.element] : op.elements;
            if (elements.length === 0)
                return board;
            for (const el of elements) {
                requireLayer(next, el.layer);
                if (next.elements.some((e) => e.id === el.id)) {
                    throw new OpError(`图元 id 重复：${el.id}`);
                }
                validateElement(el);
            }
            next.elements.push(...clone(elements));
            return next;
        }
        case 'deleteElements': {
            const ids = new Set(op.ids);
            for (const id of ids) {
                if (!next.elements.some((e) => e.id === id)) {
                    throw new OpError(`图元 ${id} 不存在`);
                }
            }
            next.elements = next.elements.filter((e) => !ids.has(e.id));
            return next;
        }
        case 'moveElements': {
            const ids = new Set(op.ids);
            for (const id of ids) {
                if (!next.elements.some((e) => e.id === id)) {
                    throw new OpError(`图元 ${id} 不存在`);
                }
            }
            next.elements = next.elements.map((e) => (ids.has(e.id) ? translateElement(e, op.dx, op.dy) : e));
            return next;
        }
        case 'clear': {
            if (op.layer === undefined) {
                next.elements = [];
            }
            else {
                requireLayer(next, op.layer);
                next.elements = next.elements.filter((e) => e.layer !== op.layer);
            }
            return next;
        }
        case 'setActiveLayer':
            requireLayer(next, op.name);
            next.activeLayer = op.name;
            return next;
        case 'addLayer': {
            if (!op.name.trim())
                throw new OpError('图层名不能为空');
            if (next.layers.some((l) => l.name === op.name)) {
                throw new OpError(`图层「${op.name}」已存在`);
            }
            next.layers.push({ name: op.name, visible: true });
            return next;
        }
        case 'removeLayer': {
            if (next.layers.length <= 1)
                throw new OpError('至少保留一个图层');
            requireLayer(next, op.name);
            next.layers = next.layers.filter((l) => l.name !== op.name);
            next.elements = next.elements.filter((e) => e.layer !== op.name);
            if (next.activeLayer === op.name)
                next.activeLayer = next.layers[0].name;
            return next;
        }
        case 'renameLayer': {
            requireLayer(next, op.name);
            if (!op.newName.trim())
                throw new OpError('图层名不能为空');
            if (next.layers.some((l) => l.name === op.newName)) {
                throw new OpError(`图层「${op.newName}」已存在`);
            }
            next.layers = next.layers.map((l) => (l.name === op.name ? { ...l, name: op.newName } : l));
            next.elements = next.elements.map((e) => (e.layer === op.name ? { ...e, layer: op.newName } : e));
            if (next.activeLayer === op.name)
                next.activeLayer = op.newName;
            return next;
        }
        case 'setLayerVisible': {
            requireLayer(next, op.name);
            next.layers = next.layers.map((l) => (l.name === op.name ? { ...l, visible: op.visible } : l));
            return next;
        }
        case 'load':
            validateBoard(op.board);
            return clone(op.board);
        case 'setAnnotationStatus': {
            const ids = new Set(op.ids);
            for (const id of ids) {
                const el = next.elements.find((e) => e.id === id);
                if (!el)
                    throw new OpError(`图元 ${id} 不存在`);
                if (el.kind !== 'annotation')
                    throw new OpError(`图元 ${id} 不是批注`);
            }
            next.elements = next.elements.map((e) => e.kind === 'annotation' && ids.has(e.id) ? { ...e, status: op.status } : e);
            return next;
        }
    }
}
function validateBoard(board) {
    if (!Array.isArray(board.layers) || board.layers.length === 0)
        throw new OpError('画板数据缺少图层');
    if (!Number.isFinite(board.width) || !Number.isFinite(board.height)) {
        throw new OpError('画板尺寸非法');
    }
    if (!board.layers.some((l) => l.name === board.activeLayer)) {
        throw new OpError(`活跃图层「${board.activeLayer}」不在图层列表中`);
    }
    for (const el of board.elements)
        validateElement(el);
}
export function validateElement(el) {
    if (!el.id || typeof el.id !== 'string')
        throw new OpError('图元缺少 id');
    if (typeof el.layer !== 'string')
        throw new OpError('图元缺少图层');
    switch (el.kind) {
        case 'stroke':
            if (!Array.isArray(el.points) || el.points.length < 2)
                throw new OpError('stroke 至少需要 2 个点');
            break;
        case 'line':
        case 'arrow':
            if (![el.x1, el.y1, el.x2, el.y2].every(Number.isFinite))
                throw new OpError('坐标必须是数字');
            break;
        case 'rect':
        case 'ellipse':
        case 'image':
            if (![el.x, el.y, el.w, el.h].every(Number.isFinite))
                throw new OpError('坐标必须是数字');
            break;
        case 'annotation':
            if (![el.x, el.y, el.w, el.h].every(Number.isFinite))
                throw new OpError('坐标必须是数字');
            if (typeof el.text !== 'string' || el.text.trim().length === 0)
                throw new OpError('批注内容不能为空');
            if (!Number.isFinite(el.n))
                throw new OpError('批注缺少编号 n');
            break;
        case 'text':
            if (typeof el.content !== 'string' || el.content.length === 0)
                throw new OpError('文字内容不能为空');
            break;
    }
}
/** 一个 Op 影响到的图元 id（用于远端动画提示） */
export function opChangedIds(op) {
    switch (op.type) {
        case 'addElement':
            return [op.element.id];
        case 'addElements':
            return op.elements.map((e) => e.id);
        case 'deleteElements':
        case 'moveElements':
            return op.ids;
        case 'setAnnotationStatus':
            return op.ids;
        case 'clear':
            return [];
        case 'load':
            return op.board.elements.map((e) => e.id);
        default:
            return [];
    }
}
export function elementBBox(el) {
    switch (el.kind) {
        case 'stroke': {
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            for (const [x, y] of el.points) {
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
            }
            return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
        }
        case 'line':
        case 'arrow': {
            const x = Math.min(el.x1, el.x2);
            const y = Math.min(el.y1, el.y2);
            return { x, y, w: Math.abs(el.x2 - el.x1), h: Math.abs(el.y2 - el.y1) };
        }
        case 'rect':
        case 'ellipse':
        case 'image':
        case 'annotation':
            return { x: el.x, y: el.y, w: el.w, h: el.h };
        case 'text': {
            const lines = el.content.split('\n');
            const lineH = el.size * 1.4;
            const w = Math.max(...lines.map((l) => l.length)) * el.size * 0.7;
            return { x: el.x, y: el.y, w, h: lines.length * lineH };
        }
        default: {
            const never = el;
            throw new OpError(`未知图元类型：${JSON.stringify(never)}`);
        }
    }
}
export function translateElement(el, dx, dy) {
    const d = (n) => Math.round((n + dx) * 100) / 100;
    switch (el.kind) {
        case 'stroke':
            return { ...el, points: el.points.map(([x, y]) => [x + dx, y + dy]) };
        case 'line':
        case 'arrow':
            return { ...el, x1: d(el.x1), y1: el.y1 + dy, x2: d(el.x2), y2: el.y2 + dy };
        case 'rect':
        case 'ellipse':
        case 'image':
        case 'text':
        case 'annotation':
            return { ...el, x: d(el.x), y: el.y + dy };
        default: {
            const never = el;
            throw new OpError(`未知图元类型：${JSON.stringify(never)}`);
        }
    }
}
function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0)
        return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
/** 点是否落在图元上（橡皮擦 / 选择工具用）。tolerance 为额外容差 */
export function hitElement(el, px, py, tolerance = 6) {
    const own = el.kind === 'stroke' || el.kind === 'line' || el.kind === 'arrow' ? el.width / 2 : 0;
    const tol = tolerance + own;
    switch (el.kind) {
        case 'stroke': {
            for (let i = 0; i < el.points.length - 1; i++) {
                const [x1, y1] = el.points[i];
                const [x2, y2] = el.points[i + 1];
                if (distToSegment(px, py, x1, y1, x2, y2) <= tol)
                    return true;
            }
            return false;
        }
        case 'line':
            return distToSegment(px, py, el.x1, el.y1, el.x2, el.y2) <= tol;
        case 'arrow': {
            if (distToSegment(px, py, el.x1, el.y1, el.x2, el.y2) <= tol)
                return true;
            return pointInRect(px, py, elementBBox(el), 2);
        }
        case 'rect': {
            const { x, y, w, h } = el;
            // 命中四条边；有填充时命中内部
            if (el.fill && pointInRect(px, py, { x, y, w, h }, 0))
                return true;
            const edges = [
                [x, y, x + w, y],
                [x + w, y, x + w, y + h],
                [x + w, y + h, x, y + h],
                [x, y + h, x, y],
            ];
            return edges.some(([ax, ay, bx, by]) => distToSegment(px, py, ax, ay, bx, by) <= tol);
        }
        case 'ellipse': {
            const cx = el.x + el.w / 2;
            const cy = el.y + el.h / 2;
            const rx = Math.max(el.w / 2, 0.001);
            const ry = Math.max(el.h / 2, 0.001);
            const norm = ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2;
            if (el.fill && norm <= 1.02)
                return true;
            // 描边命中：椭圆参数方程上找最近点（采样 64 段足够）
            for (let i = 0; i < 64; i++) {
                const a1 = (i / 64) * Math.PI * 2;
                const a2 = ((i + 1) / 64) * Math.PI * 2;
                const p1x = cx + rx * Math.cos(a1);
                const p1y = cy + ry * Math.sin(a1);
                const p2x = cx + rx * Math.cos(a2);
                const p2y = cy + ry * Math.sin(a2);
                if (distToSegment(px, py, p1x, p1y, p2x, p2y) <= tol)
                    return true;
            }
            return false;
        }
        case 'text':
        case 'image':
            return pointInRect(px, py, elementBBox(el), 2);
        case 'annotation': {
            // 批注只在边框 / 编号徽标 / 框下说明条上可点中，不挡住下层设计元素
            if (px >= el.x - 6 && px <= el.x + 26 && py >= el.y - 6 && py <= el.y + 26)
                return true;
            if (py >= el.y + el.h + 2 && py <= el.y + el.h + 28 && px >= el.x - 2 && px <= el.x + Math.min(el.w, 420))
                return true;
            const edges = [
                [el.x, el.y, el.x + el.w, el.y],
                [el.x + el.w, el.y, el.x + el.w, el.y + el.h],
                [el.x + el.w, el.y + el.h, el.x, el.y + el.h],
                [el.x, el.y + el.h, el.x, el.y],
            ];
            return edges.some(([ax, ay, bx, by]) => distToSegment(px, py, ax, ay, bx, by) <= tolerance + 2);
        }
    }
}
/** 下一个批注编号：在已有最大编号上 +1（删除批注不回退编号，像评审意见一样稳定） */
export function nextAnnotationNumber(elements) {
    let max = 0;
    for (const el of elements) {
        if (el.kind === 'annotation' && Number.isFinite(el.n))
            max = Math.max(max, el.n);
    }
    return max + 1;
}
/** 把序号转成展示用编号（1→①…20→⑳，超出用 (21)） */
export function annotationLabel(n) {
    const circled = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
    return n >= 1 && n <= 20 ? circled[n - 1] : `(${n})`;
}
export function pointInRect(px, py, box, pad = 0) {
    return px >= box.x - pad && px <= box.x + box.w + pad && py >= box.y - pad && py <= box.y + box.h + pad;
}
export function rectsIntersect(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
/** 从上往下找第一个命中的图元（选择工具单击用） */
export function pickElement(elements, px, py, layerOrder) {
    for (let i = elements.length - 1; i >= 0; i--) {
        const el = elements[i];
        if (hitElement(el, px, py))
            return el;
    }
    // layerOrder 保留给未来按层过滤；当前按 elements 顺序即可
    void layerOrder;
    return null;
}
