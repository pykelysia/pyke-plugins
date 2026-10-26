import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { renderPng } from '../render/raster.js';
import { boardToSvg } from '../render/svg.js';
import { ProjectRegistry, ProjectRuntime } from './projects.js';
import { DAEMON_VERSION } from './version.js';
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
};
function findWebDir() {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        join(here, '..', '..', 'web'), // dist/hub/server.js → 项目根/web
        join(process.cwd(), 'web'),
    ];
    for (const c of candidates) {
        if (existsSync(join(c, 'index.html')))
            return c;
    }
    throw new Error('找不到 web/ 画板页面目录');
}
/**
 * ui-draw 守护进程：一个进程、一个端口，服务所有项目/所有 agent。
 * 画板按项目名挂在 /p/<项目名>/ 下，各自独立状态与撤销历史。
 */
export class HubServer {
    http = createServer((req, res) => this.handleHttp(req, res));
    wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    registry = new ProjectRegistry();
    runtimes = new Map();
    clients = new Map();
    port = 0;
    started = false;
    constructor() {
        this.http.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    }
    get url() {
        return `http://127.0.0.1:${this.port}`;
    }
    async start(from = 4680) {
        if (this.started)
            return this.port;
        this.started = true;
        this.port = await this.listen(from);
        // 启动时把已有项目都load一遍，导出/浏览时才不用等
        for (const meta of this.registry.list())
            this.ensureRuntime(meta.slug);
        return this.port;
    }
    listen(from) {
        return new Promise((ok, fail) => {
            const tryPort = (port) => {
                if (port > from + 20)
                    return fail(new Error('没有可用端口（4680-4700）'));
                const onError = () => {
                    this.http.removeListener('listening', onListening);
                    tryPort(port + 1);
                };
                const onListening = () => {
                    this.http.removeListener('error', onError);
                    ok(port);
                };
                this.http.once('error', onError);
                this.http.once('listening', onListening);
                this.http.listen(port, '127.0.0.1');
            };
            tryPort(from);
        });
    }
    async stop() {
        for (const rt of this.runtimes.values())
            rt.dispose();
        this.wss.close();
        await new Promise((ok) => this.http.close(() => ok()));
        this.started = false;
    }
    flushAll() {
        for (const rt of this.runtimes.values())
            rt.flush();
    }
    // ---------- 项目 ----------
    ensureRuntime(slug) {
        const existing = this.runtimes.get(slug);
        if (existing)
            return existing;
        const meta = this.registry.get(slug);
        if (!meta)
            return undefined;
        const rt = new ProjectRuntime(meta);
        this.runtimes.set(slug, rt);
        rt.onCommit((board) => {
            this.registry.touch(slug);
            this.broadcast(slug, {
                type: 'update',
                board,
                revision: rt.service.revision,
                actor: this.lastActor.get(slug) ?? 'agent',
                changedIds: this.lastChanged.get(slug) ?? [],
            });
        });
        return rt;
    }
    runtimesState() {
        return this.registry.list().map((meta) => {
            const rt = this.ensureRuntime(meta.slug);
            const board = rt?.service.board;
            return {
                slug: meta.slug,
                name: meta.name,
                projectDir: meta.projectDir,
                width: board?.width ?? 0,
                height: board?.height ?? 0,
                elements: board?.elements.length ?? 0,
                revision: rt?.service.revision ?? 0,
                activeLayer: board?.activeLayer ?? '',
                updatedAt: meta.updatedAt,
            };
        });
    }
    registerProject(projectDir) {
        const meta = this.registry.register(resolve(projectDir));
        const rt = this.ensureRuntime(meta.slug);
        return { meta, rt };
    }
    // ---------- HTTP ----------
    handleHttp(req, res) {
        Promise.resolve()
            .then(() => this.route(req, res))
            .catch((err) => json(res, 500, { error: err instanceof Error ? err.message : String(err) }));
    }
    async route(req, res) {
        const u = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
        const pathname = decodeURIComponent(u.pathname);
        if (pathname === '/api/health') {
            json(res, 200, { ok: true, name: 'ui-draw', version: DAEMON_VERSION, pid: process.pid });
            return;
        }
        if (pathname === '/api/projects') {
            if (req.method === 'POST') {
                const body = await readJson(req);
                if (!body?.projectDir || typeof body.projectDir !== 'string') {
                    json(res, 400, { error: '缺少 projectDir' });
                    return;
                }
                const { meta, rt } = this.registerProject(body.projectDir);
                json(res, 200, {
                    slug: meta.slug,
                    name: meta.name,
                    projectDir: meta.projectDir,
                    storePath: rt.storePath,
                    boardUrl: `${this.url}/p/${encodeURIComponent(meta.slug)}/`,
                });
                return;
            }
            json(res, 200, { projects: this.runtimesState() });
            return;
        }
        if (pathname === '/' || pathname === '') {
            this.serveProjectsIndex(res);
            return;
        }
        const m = pathname.match(/^\/p\/([^/]+)(\/.*)?$/);
        if (m) {
            const slug = m[1];
            const rest = m[2] || '/';
            const rt = this.ensureRuntime(slug);
            if (!rt) {
                res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`<h1>项目不存在</h1><p>${escapeHtml(slug)} 还没有注册。让 agent 在对应项目里调用任意 ui-draw 工具即可创建。</p>`);
                return;
            }
            if (rest === '/' || rest === '') {
                this.serveFile(res, 'index.html', 'text/html; charset=utf-8');
                return;
            }
            if (rest === '/api/state') {
                json(res, 200, {
                    board: rt.service.board,
                    revision: rt.service.revision,
                    project: { slug: rt.meta.slug, name: rt.meta.name, projectDir: rt.meta.projectDir, storePath: rt.storePath },
                });
                return;
            }
            if (rest === '/api/op' && req.method === 'POST') {
                const body = (await readJson(req));
                if (!body?.op) {
                    json(res, 400, { error: '缺少 op' });
                    return;
                }
                const actor = body.actor === 'human' ? 'human' : 'agent';
                this.trackChange(slug, body.op, actor);
                rt.service.commit(body.op, actor);
                json(res, 200, { ok: true, revision: rt.service.revision });
                return;
            }
            if ((rest === '/api/undo' || rest === '/api/redo') && req.method === 'POST') {
                this.trackChange(slug, { type: 'undo' }, 'agent');
                const done = rest === '/api/undo' ? rt.service.undo() : rt.service.redo();
                json(res, 200, { ok: done, revision: rt.service.revision });
                return;
            }
            if (rest === '/api/screenshot.png') {
                const q = u.searchParams;
                const png = renderPng(rt.service.board, {
                    rasterScale: clampNum(q.get('scale'), 0.5, 3, 1),
                    offsetX: clampNum(q.get('x'), -10000, 10000, 0),
                    offsetY: clampNum(q.get('y'), -10000, 10000, 0),
                    regionW: q.get('w') ? clampNum(q.get('w'), 1, 4096, rt.service.board.width) : undefined,
                    regionH: q.get('h') ? clampNum(q.get('h'), 1, 4096, rt.service.board.height) : undefined,
                    ...(q.get('layer') ? { layerFilter: (l) => l.name === q.get('layer') } : {}),
                    ...(q.get('annotations') === 'hide' ? { skipAnnotations: true } : {}),
                });
                res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
                res.end(png);
                return;
            }
            if (rest === '/api/svg') {
                const svg = boardToSvg(rt.service.board);
                res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
                res.end(svg);
                return;
            }
            if (rest === '/api/restore' && req.method === 'POST') {
                const body = (await readJson(req));
                if (!body?.board) {
                    json(res, 400, { error: '缺少 board' });
                    return;
                }
                rt.service.commit({ type: 'load', board: body.board }, 'agent');
                json(res, 200, { ok: true, revision: rt.service.revision });
                return;
            }
            if (rest === '/api/flush' && req.method === 'POST') {
                rt.flush();
                json(res, 200, { ok: true });
                return;
            }
            this.serveStatic(rest, res);
            return;
        }
        // 根路径静态资源（页面里用绝对路径引用）
        this.serveStatic(pathname, res);
    }
    serveStatic(rest, res) {
        const rel = rest.replace(/^\/+/, '');
        if (rel.startsWith('api/')) {
            res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: '未知接口' }));
            return;
        }
        this.serveFile(res, rel || 'index.html');
    }
    serveFile(res, rel, contentType) {
        let webDir;
        try {
            webDir = findWebDir();
        }
        catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(String(err));
            return;
        }
        const abs = normalize(join(webDir, rel));
        if (!abs.startsWith(webDir) || !existsSync(abs) || statSync(abs).isDirectory()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('not found');
            return;
        }
        const type = contentType ?? MIME[extname(abs)] ?? 'application/octet-stream';
        // 本地工具不为缓存付出代价：页面与脚本一律不缓存，
        // 且页面里的资源引用带时间戳，升级后立刻拿到新版本。
        if (rel === 'index.html') {
            const stamp = `${DAEMON_VERSION}-${process.pid}`;
            const html = readFileSync(abs, 'utf-8')
                .replace('href="/board.css"', `href="/board.css?v=${stamp}"`)
                .replace('src="/board.js"', `src="/board.js?v=${stamp}"`);
            res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
            res.end(html);
            return;
        }
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(readFileSync(abs));
    }
    serveProjectsIndex(res) {
        const projects = this.runtimesState();
        const rows = projects
            .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
            .map((p) => `<li>
        <a class="name" href="/p/${encodeURIComponent(p.slug)}/">${escapeHtml(p.name)}</a>
        <span class="meta">${p.width}×${p.height} · ${p.elements} 个图元 · ${escapeHtml(p.updatedAt.replace('T', ' ').slice(0, 16))}</span>
        <span class="dir">${escapeHtml(p.projectDir)}</span>
      </li>`)
            .join('\n');
        const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>ui-draw 项目</title>
<style>
:root{color-scheme:light}
body{font:14px/1.6 "Microsoft YaHei","PingFang SC",sans-serif;background:#eef1f5;color:#1f2937;margin:0;padding:40px 24px}
main{max-width:760px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:24px 28px;box-shadow:0 2px 18px rgba(15,23,42,.08)}
h1{font-size:20px;margin:0 0 4px}
p.sub{color:#6b7280;margin:0 0 20px;font-size:13px}
ul{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:10px}
li{border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:2px}
li:hover{border-color:#2563eb}
a.name{font-weight:700;color:#2563eb;text-decoration:none;font-size:15px}
span.meta{color:#6b7280;font-size:12px}
span.dir{color:#9ca3af;font-size:11px;font-family:ui-monospace,Consolas,monospace}
.empty{color:#6b7280;font-size:13px;border:1px dashed #e5e7eb;border-radius:10px;padding:16px}
</style></head>
<body><main>
<h1>🎨 ui-draw 项目</h1>
<p class="sub">所有 agent 共享这一个服务；每个项目一块画板，数据存放在用户目录 <code>~/.ui-draw/projects/</code>。</p>
${projects.length ? `<ul>${rows}</ul>` : '<div class="empty">还没有项目。让 agent 在项目里画一笔，这里就会出现入口。</div>'}
</main></body></html>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
    }
    // ---------- WebSocket ----------
    lastActor = new Map();
    lastChanged = new Map();
    trackChange(slug, op, actor = 'agent') {
        this.lastActor.set(slug, actor);
        const ids = [];
        if (op.type === 'addElement')
            ids.push(op.element.id);
        else if (op.type === 'addElements')
            ids.push(...op.elements.map((e) => e.id));
        else if (op.type === 'deleteElements' || op.type === 'moveElements' || op.type === 'setAnnotationStatus')
            ids.push(...op.ids);
        this.lastChanged.set(slug, ids);
    }
    handleUpgrade(req, socket, head) {
        const u = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
        const m = decodeURIComponent(u.pathname).match(/^\/p\/([^/]+)\/ws$/);
        if (!m) {
            socket.destroy();
            return;
        }
        const slug = m[1];
        const rt = this.ensureRuntime(slug);
        if (!rt) {
            socket.destroy();
            return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => this.onWs(ws, slug, rt));
    }
    onWs(ws, slug, rt) {
        let set = this.clients.get(slug);
        if (!set) {
            set = new Set();
            this.clients.set(slug, set);
        }
        set.add(ws);
        ws.send(JSON.stringify({ type: 'init', board: rt.service.board, revision: rt.service.revision, project: { slug, name: rt.meta.name } }));
        ws.on('message', (data) => {
            let msg;
            try {
                msg = JSON.parse(String(data));
            }
            catch {
                return;
            }
            const m = msg;
            try {
                if (m.type === 'op' && m.op) {
                    this.trackChange(slug, m.op, 'human');
                    rt.service.commit(m.op, 'human');
                    this.sendTo(ws, { type: 'ok', revision: rt.service.revision });
                }
                else if (m.type === 'undo') {
                    this.trackChange(slug, { type: 'undo' }, 'human');
                    rt.service.undo();
                }
                else if (m.type === 'redo') {
                    this.trackChange(slug, { type: 'redo' }, 'human');
                    rt.service.redo();
                }
            }
            catch (err) {
                this.sendTo(ws, { type: 'error', message: err instanceof Error ? err.message : String(err) });
            }
        });
        ws.on('close', () => set?.delete(ws));
    }
    sendTo(ws, msg) {
        if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify(msg));
    }
    broadcast(slug, msg) {
        const raw = JSON.stringify(msg);
        for (const ws of this.clients.get(slug) ?? []) {
            if (ws.readyState === WebSocket.OPEN)
                ws.send(raw);
        }
    }
}
function clampNum(raw, min, max, fallback) {
    const n = raw === null ? NaN : Number(raw);
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(max, Math.max(min, n));
}
function json(res, code, body) {
    const raw = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(raw);
}
function readJson(req) {
    return new Promise((ok, fail) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > 64 * 1024 * 1024) {
                fail(new Error('请求体过大'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            try {
                ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : null);
            }
            catch {
                ok(null);
            }
        });
        req.on('error', fail);
    });
}
function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
