import { ensureDaemon } from './lifecycle.js';
/**
 * MCP 侧到守护进程的代理客户端：状态、撤销历史、渲染都在守护进程里，
 * 多个 agent / 多个会话共享同一份。
 * 一个项目可有多块画布（一个界面一块）；每个 MCP 会话记住自己的活跃画布，
 * 默认落在项目里最近更新的那块上。
 */
export class HubClient {
    runtime;
    project;
    activeId;
    constructor(runtime, project, activeId) {
        this.runtime = runtime;
        this.project = project;
        this.activeId = activeId;
    }
    static async connect(projectDir) {
        const rt = await ensureDaemon();
        const info = await HubClient.register(rt, projectDir);
        const latest = [...(info.boards ?? [])].sort((a, b) => ((a.updatedAt ?? '') < (b.updatedAt ?? '') ? 1 : -1))[0];
        return new HubClient(rt, info, latest?.id ?? null);
    }
    static async register(rt, projectDir) {
        const res = await fetch(`http://127.0.0.1:${rt.port}/api/projects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectDir }),
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok)
            throw new Error(`注册项目失败：HTTP ${res.status}`);
        return (await res.json());
    }
    async refresh() {
        const rt = await ensureDaemon();
        if (rt.pid !== this.runtime.pid || rt.token !== this.runtime.token || rt.port !== this.runtime.port) {
            this.project = await HubClient.register(rt, this.project.projectDir);
            this.runtime = rt;
        }
        return this;
    }
    get base() {
        return `http://127.0.0.1:${this.runtime.port}`;
    }
    /** 本会话当前在哪块画布上作画 */
    get activeBoard() {
        return this.project.boards.find((b) => b.id === this.activeId) ?? null;
    }
    /** 所有画布级操作的前置：项目还没有画布时给出可执行的指引 */
    guardBoard() {
        const active = this.activeBoard;
        if (!active) {
            if (this.project.boards.length > 0) {
                throw new Error('当前画布不存在或已删除：用 list_boards 查看，再 switch_board 切换，或 setup_board 新建');
            }
            throw new Error(`项目「${this.project.name}」还没有画布：先用 setup_board 支起一块（可带 title 命名，如「登录页」）`);
        }
        return active;
    }
    get boardUrl() {
        return `${this.base}/p/${encodeURIComponent(this.project.slug)}/${encodeURIComponent(this.guardBoard().id)}/`;
    }
    get projectUrlBase() {
        return `${this.base}/p/${encodeURIComponent(this.project.slug)}/`;
    }
    /** 支起一块新画布并切过去（旧画布原样保留） */
    async createBoard(opts) {
        const res = await fetch(`${this.projectUrlBase}api/boards`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(opts),
            signal: AbortSignal.timeout(8000),
        });
        const body = (await res.json().catch(() => ({})));
        if (!res.ok || !body.board)
            throw new Error(body.error ?? `支起画布失败：HTTP ${res.status}`);
        this.project.boards = body.boards ?? this.project.boards;
        this.activeId = body.board.id;
        return body.board;
    }
    async listBoards() {
        const res = await fetch(`${this.projectUrlBase}api/boards`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok)
            throw new Error(`读取画布清单失败：HTTP ${res.status}`);
        const body = (await res.json());
        this.project.boards = body.boards ?? [];
        return this.project.boards;
    }
    async deleteBoard(idOrTitle) {
        const boards = await this.listBoards();
        const target = boards.find((b) => b.id === idOrTitle) ?? boards.find((b) => b.title === idOrTitle);
        if (!target)
            throw new Error(`画布「${idOrTitle}」不存在或已删除`);
        const res = await fetch(`${this.projectUrlBase}api/boards/${encodeURIComponent(target.id)}`, {
            method: 'DELETE',
            signal: AbortSignal.timeout(8000),
        });
        const body = (await res.json());
        if (!res.ok)
            throw new Error(body.error ?? `删除画布失败：HTTP ${res.status}`);
        this.project.boards = body.boards;
        if (this.activeId === target.id)
            this.activeId = null;
        return target;
    }
    /** 切换活跃画布（按 id 或标题） */
    async switchBoard(idOrTitle) {
        const boards = await this.listBoards();
        const hit = boards.find((b) => b.id === idOrTitle) ?? boards.find((b) => b.title === idOrTitle);
        if (!hit) {
            throw new Error(`没有叫「${idOrTitle}」的画布。现有：${boards.map((b) => b.title).join('、')}`);
        }
        this.activeId = hit.id;
        return hit;
    }
    boardUrlPath(path) {
        const board = this.guardBoard();
        return `${this.base}/p/${encodeURIComponent(this.project.slug)}/${encodeURIComponent(board.id)}${path}`;
    }
    async state() {
        const res = await fetch(this.boardUrlPath('/api/state'), { signal: AbortSignal.timeout(8000) });
        if (!res.ok) {
            if (res.status === 404) {
                await this.listBoards();
                throw new Error('当前画布已删除：用 list_boards 查看，再 switch_board 切换，或 setup_board 新建');
            }
            throw new Error(`读取画板失败：HTTP ${res.status}`);
        }
        return (await res.json());
    }
    async commit(op, actor = 'agent') {
        const res = await fetch(this.boardUrlPath('/api/op'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ op, actor }),
            signal: AbortSignal.timeout(15000),
        });
        const body = (await res.json().catch(() => ({})));
        if (!res.ok)
            throw new Error(body.error ?? `操作失败：HTTP ${res.status}`);
        return { revision: body.revision ?? 0 };
    }
    async undo() {
        return this.postAction('/api/undo');
    }
    async redo() {
        return this.postAction('/api/redo');
    }
    async postAction(path) {
        const res = await fetch(this.boardUrlPath(path), { method: 'POST', signal: AbortSignal.timeout(8000) });
        if (!res.ok)
            throw new Error(`操作失败：HTTP ${res.status}`);
        return (await res.json());
    }
    async restore(board) {
        const res = await fetch(this.boardUrlPath('/api/restore'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ board }),
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok)
            throw new Error(`恢复画板失败：HTTP ${res.status}`);
        return (await res.json());
    }
    async flush() {
        await fetch(this.boardUrlPath('/api/flush'), { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => { });
    }
    async screenshot(opts = {}) {
        const q = new URLSearchParams();
        if (opts.scale)
            q.set('scale', String(opts.scale));
        if (opts.region) {
            q.set('x', String(opts.region.x));
            q.set('y', String(opts.region.y));
            q.set('w', String(opts.region.w));
            q.set('h', String(opts.region.h));
        }
        if (opts.layer)
            q.set('layer', opts.layer);
        if (opts.hideAnnotations)
            q.set('annotations', 'hide');
        const qs = q.toString();
        const res = await fetch(this.boardUrlPath(`/api/screenshot.png${qs ? '?' + qs : ''}`), {
            signal: AbortSignal.timeout(20000),
        });
        if (!res.ok)
            throw new Error(`截图失败：HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
    }
    async svg() {
        const res = await fetch(this.boardUrlPath('/api/svg'), { signal: AbortSignal.timeout(15000) });
        if (!res.ok)
            throw new Error(`导出 SVG 失败：HTTP ${res.status}`);
        return await res.text();
    }
}
