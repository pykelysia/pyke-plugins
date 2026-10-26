import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { dataDir, lockFile, runtimeFile } from './paths.js';
import { DAEMON_VERSION } from './version.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function readRuntime() {
    try {
        if (!existsSync(runtimeFile()))
            return null;
        const rt = JSON.parse(readFileSync(runtimeFile(), 'utf-8'));
        return rt?.port ? rt : null;
    }
    catch {
        return null;
    }
}
async function healthOf(port) {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
        if (!res.ok)
            return null;
        return (await res.json());
    }
    catch {
        return null;
    }
}
/** 端口上是否已经没有任何服务（等旧守护进程真正退出） */
async function portDown(port, timeoutMs = 4000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (!(await healthOf(port)))
            return true;
        await sleep(150);
    }
    return false;
}
function daemonEntry() {
    // dist/hub/client.js → dist/daemon.js
    return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'daemon.js');
}
function spawnDaemon() {
    const child = spawn(process.execPath, [daemonEntry()], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: process.env,
    });
    child.unref();
}
/**
 * 保证用户级守护进程在运行：
 * - 已有健康实例 → 复用（多 agent 因此共享同一端口）
 * - 否则用锁文件协调，拉起一个 detached 进程
 */
export async function ensureDaemon() {
    mkdirSync(dataDir(), { recursive: true });
    const existing = readRuntime();
    if (existing) {
        const h = await healthOf(existing.port);
        if (h?.ok) {
            if (h.version === DAEMON_VERSION)
                return existing;
            // 版本不一致（刚升级过）：停掉旧守护进程，等端口释放后重新拉起
            try {
                if (h.pid)
                    process.kill(h.pid);
            }
            catch {
                /* 已经退出 */
            }
            await portDown(existing.port);
        }
    }
    const lock = lockFile();
    let acquired = false;
    try {
        const fd = openSync(lock, 'wx');
        writeSync(fd, String(process.pid));
        closeSync(fd);
        acquired = true;
    }
    catch {
        // 别的 agent 正在启动，等它
    }
    if (acquired || staleLock(lock)) {
        if (!acquired) {
            try {
                unlinkSync(lock);
            }
            catch {
                /* 忽略 */
            }
            try {
                const fd = openSync(lock, 'wx');
                writeSync(fd, String(process.pid));
                closeSync(fd);
                acquired = true;
            }
            catch {
                /* 继续等 */
            }
        }
        if (acquired)
            spawnDaemon();
    }
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
        await sleep(150);
        const rt = readRuntime();
        if (rt && (await healthOf(rt.port))?.ok)
            return rt;
    }
    throw new Error(`无法启动 ui-draw 后台服务（数据目录 ${dataDir()}）。可以手动运行：node ${daemonEntry()}`);
}
function staleLock(lock) {
    try {
        return Date.now() - statSync(lock).mtimeMs > 10_000;
    }
    catch {
        return false;
    }
}
/**
 * MCP 侧到守护进程的代理客户端：状态、撤销历史、渲染都在守护进程里，
 * 多个 agent / 多个会话共享同一份。
 */
export class HubClient {
    base;
    project;
    constructor(base, project) {
        this.base = base;
        this.project = project;
    }
    static async connect(projectDir) {
        const rt = await ensureDaemon();
        const base = `http://127.0.0.1:${rt.port}`;
        const res = await fetch(`${base}/api/projects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectDir }),
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok)
            throw new Error(`注册项目失败：HTTP ${res.status}`);
        const info = (await res.json());
        return new HubClient(base, info);
    }
    get boardUrl() {
        return this.project.boardUrl;
    }
    get storePath() {
        return this.project.storePath;
    }
    projectUrl(path) {
        return `${this.base}/p/${encodeURIComponent(this.project.slug)}${path}`;
    }
    async state() {
        const res = await fetch(this.projectUrl('/api/state'), { signal: AbortSignal.timeout(8000) });
        if (!res.ok)
            throw new Error(`读取画板失败：HTTP ${res.status}`);
        return (await res.json());
    }
    async commit(op, actor = 'agent') {
        const res = await fetch(this.projectUrl('/api/op'), {
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
        const res = await fetch(this.projectUrl(path), { method: 'POST', signal: AbortSignal.timeout(8000) });
        if (!res.ok)
            throw new Error(`操作失败：HTTP ${res.status}`);
        return (await res.json());
    }
    async restore(board) {
        const res = await fetch(this.projectUrl('/api/restore'), {
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
        await fetch(this.projectUrl('/api/flush'), { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => { });
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
        const res = await fetch(this.projectUrl(`/api/screenshot.png${qs ? '?' + qs : ''}`), {
            signal: AbortSignal.timeout(20000),
        });
        if (!res.ok)
            throw new Error(`截图失败：HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
    }
    async svg() {
        const res = await fetch(this.projectUrl('/api/svg'), { signal: AbortSignal.timeout(15000) });
        if (!res.ok)
            throw new Error(`导出 SVG 失败：HTTP ${res.status}`);
        return await res.text();
    }
}
