import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync, } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { dataDir, runtimeFile } from './paths.js';
import { DAEMON_VERSION, HUB_PROTOCOL } from './version.js';
const localRoot = fileURLToPath(new URL('../../', import.meta.url));
const TIMEOUT = 10_000;
function readJson(file) {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return null;
        throw err;
    }
}
export function writeJson(file, value) {
    const tmp = join(dirname(file), `.${randomUUID()}.tmp`);
    try {
        writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: 0o600 });
        renameSync(tmp, file);
    }
    finally {
        removeFile(tmp);
    }
}
function removeFile(file) {
    try {
        unlinkSync(file);
    }
    catch (err) {
        if (err.code !== 'ENOENT')
            throw err;
    }
}
export function readRelease(root = localRoot) {
    const release = readJson(join(root, 'release.json'));
    return release && /^\d+\.\d+\.\d+-[a-f0-9]{24}$/.test(release.build) ? release : null;
}
export function releaseRoot(release) {
    return join(dataDir(), 'releases', release.build);
}
function activeFile() {
    return join(dataDir(), 'active-release.json');
}
function launchFile() {
    return join(dataDir(), 'daemon-launch.json');
}
export function ownsLaunch(token) {
    return readJson(launchFile())?.token === token;
}
export function readActive() {
    const release = readJson(activeFile());
    if (!release)
        return null;
    if (!/^\d+\.\d+\.\d+-[a-f0-9]{24}$/.test(release.build) || readRelease(releaseRoot(release))?.build !== release.build) {
        throw new Error('ui-draw 活动版本的运行文件缺失或版本记录无效');
    }
    return release;
}
function newer(candidate, active) {
    const a = candidate.build.split('-')[0].split('.').map(Number);
    const b = active.build.split('-')[0].split('.').map(Number);
    const firstDifference = a.findIndex((part, index) => part !== b[index]);
    return firstDifference !== -1 && a[firstDifference] > b[firstDifference];
}
function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code !== 'ESRCH';
    }
}
// Publish a non-empty directory atomically. Only the contender that removes a dead
// owner's unique marker may reap the directory. rmdir cannot remove a new owner.
async function withLock(work) {
    mkdirSync(dataDir(), { recursive: true });
    const lock = join(dataDir(), 'lifecycle.lock');
    const owner = `${process.pid}-${randomUUID()}`;
    const claim = mkdtempSync(join(dataDir(), '.claim-'));
    writeFileSync(join(claim, owner), '');
    let acquired = false;
    try {
        const deadline = Date.now() + 4 * TIMEOUT;
        while (!acquired) {
            try {
                renameSync(claim, lock);
                acquired = true;
            }
            catch (err) {
                if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(err.code ?? ''))
                    throw err;
                let markers;
                try {
                    markers = readdirSync(lock);
                }
                catch (readErr) {
                    if (readErr.code !== 'ENOENT')
                        throw readErr;
                    markers = [];
                }
                if (markers.length === 0) {
                    try {
                        rmdirSync(lock);
                    }
                    catch (err) {
                        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(err.code ?? ''))
                            throw err;
                    }
                }
                const marker = markers[0];
                if (markers.length === 1 && /^\d+-[a-f0-9-]+$/.test(marker) && !alive(Number(marker.split('-')[0]))) {
                    releaseLock(lock, marker);
                }
                if (Date.now() >= deadline)
                    throw new Error('等待 ui-draw 版本切换超时');
                await sleep(75);
            }
        }
        // Invalidate a launch whose coordinator died before publishing readiness.
        removeFile(launchFile());
        return await work();
    }
    finally {
        releaseLock(acquired ? lock : claim, owner);
    }
}
function releaseLock(dir, owner) {
    try {
        unlinkSync(join(dir, owner));
        rmdirSync(dir);
    }
    catch (err) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(err.code ?? ''))
            throw err;
    }
}
export function readRuntime() {
    let rt;
    try {
        rt = readJson(runtimeFile());
    }
    catch (err) {
        if (err instanceof SyntaxError)
            return null;
        throw err;
    }
    return rt && Number.isSafeInteger(rt.pid) && rt.pid > 0 &&
        Number.isInteger(rt.port) && rt.port >= 4680 && rt.port <= 4700 &&
        typeof rt.version === 'string' ? rt : null;
}
async function healthy(rt, requireResponse = false) {
    try {
        const res = await fetch(`http://127.0.0.1:${rt.port}/api/health`, { signal: AbortSignal.timeout(800) });
        if (!res.ok)
            return false;
        const h = await res.json();
        return h.ok === true && h.name === 'ui-draw' && h.pid === rt.pid &&
            h.version === rt.version && h.protocol === rt.protocol && h.build === rt.build;
    }
    catch (err) {
        if (requireResponse && err.name === 'TimeoutError') {
            throw new Error('ui-draw 守护进程仍占用端口，健康检查超时，请稍后重试');
        }
        return false;
    }
}
export async function runningDaemon() {
    const rt = readRuntime();
    if (!rt || !await healthy(rt, true))
        return null;
    return rt;
}
function compatible(rt) {
    if (rt.protocol === HUB_PROTOCOL || (rt.protocol === undefined && rt.version === DAEMON_VERSION))
        return rt;
    throw new Error('ui-draw 服务协议已更新，请重新打开会话');
}
async function startDaemon(release, port) {
    const root = release ? releaseRoot(release) : localRoot;
    const token = randomUUID();
    writeJson(launchFile(), { token });
    const child = spawn(process.execPath, [join(root, 'dist', 'daemon.js')], {
        cwd: dataDir(),
        env: { ...process.env, UI_DRAW_HOME: dataDir(), UI_DRAW_DAEMON_TOKEN: token, UI_DRAW_DAEMON_PORT: String(port ?? 4680) },
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
    });
    let failure = null;
    child.once('error', (err) => { failure = err; });
    child.unref();
    try {
        const deadline = Date.now() + TIMEOUT;
        while (Date.now() < deadline) {
            if (failure)
                throw failure;
            if (child.exitCode !== null || child.signalCode !== null)
                throw new Error('ui-draw 新守护进程提前退出');
            const rt = readRuntime();
            if (rt?.pid === child.pid && rt?.token === token && rt?.build === release?.build && await healthy(rt))
                return rt;
            await sleep(75);
        }
        throw new Error('ui-draw 新守护进程健康检查超时');
    }
    catch (err) {
        if (child.pid && child.exitCode === null && child.signalCode === null) {
            // This process has never passed readiness. Reap our own child before rollback.
            const exited = new Promise((resolve) => child.once('exit', () => resolve()));
            child.ref();
            child.kill('SIGKILL');
            const timer = new AbortController();
            try {
                await Promise.race([
                    exited,
                    sleep(TIMEOUT, undefined, { signal: timer.signal }).then(() => { throw new Error('清理失败的守护进程超时'); }),
                ]);
            }
            finally {
                timer.abort();
                child.unref();
            }
        }
        throw err;
    }
    finally {
        removeFile(launchFile());
    }
}
async function stopDaemon(rt) {
    if (!rt.token)
        throw new Error('请先关闭旧版 MCP 会话，再运行 npm run daemon:stop 迁移旧版守护进程');
    const res = await fetch(`http://127.0.0.1:${rt.port}/api/shutdown`, {
        method: 'POST',
        headers: { authorization: `Bearer ${rt.token}` },
        signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) {
        const result = await res.json().catch(() => null);
        throw new Error(`ui-draw 守护进程拒绝停机（HTTP ${res.status}）${result?.error ? `，${result.error}` : ''}`);
    }
    await waitForExit(rt);
}
async function waitForExit(rt) {
    const deadline = Date.now() + TIMEOUT;
    while (alive(rt.pid)) {
        if (Date.now() >= deadline)
            throw new Error('ui-draw 守护进程退出超时');
        await sleep(75);
    }
    if (readRuntime()?.pid === rt.pid)
        removeFile(runtimeFile());
}
export async function stopRunningDaemon() {
    return withLock(async () => {
        const rt = await runningDaemon();
        if (!rt)
            return false;
        if (rt.token) {
            await stopDaemon(rt);
        }
        else {
            // The legacy API can flush individual canvases, but cannot drain its clients.
            // Callers must first close their old MCP sessions and stop browser edits.
            const base = `http://127.0.0.1:${rt.port}`;
            const request = async (path, method = 'GET') => {
                const res = await fetch(base + path, { method, signal: AbortSignal.timeout(TIMEOUT) });
                if (!res.ok)
                    throw new Error(`旧版 ui-draw 保存失败（HTTP ${res.status}）`);
                return await res.json();
            };
            const { projects } = await request('/api/projects');
            for (const { slug } of projects) {
                const path = `/p/${encodeURIComponent(slug)}/`;
                const { boards } = await request(path + 'api/boards');
                for (const { id } of boards)
                    await request(path + encodeURIComponent(id) + '/api/flush', 'POST');
            }
            if (!await healthy(rt))
                throw new Error('旧版 ui-draw 守护进程身份已变化');
            process.kill(rt.pid);
            await waitForExit(rt);
        }
        return true;
    });
}
async function switchRelease(candidate, active, rt) {
    if (rt)
        await stopDaemon(rt);
    let started;
    try {
        started = await startDaemon(candidate, rt?.port);
        writeJson(activeFile(), candidate);
        return started;
    }
    catch (err) {
        if (started)
            await stopDaemon(started);
        if (active)
            await startDaemon(active, rt?.port);
        throw err;
    }
}
/** Prepare an upgrade at launch. The first installation stays lazy until a tool is used. */
export async function selectRelease(candidate) {
    return withLock(async () => {
        const active = readActive();
        if (active && !newer(candidate, active))
            return active;
        const rt = await runningDaemon();
        if (rt && !rt.build) {
            console.error('[ui-draw] 旧版守护进程仍在运行。结束画板编辑及旧会话后运行 npm run daemon:stop，再启动新版。');
            return active ?? candidate;
        }
        if (rt || active)
            await switchRelease(candidate, active, rt);
        return candidate;
    });
}
export async function ensureDaemon() {
    return withLock(async () => {
        const rt = await runningDaemon();
        const active = readActive();
        const candidate = readRelease();
        if (rt) {
            if (rt.build && rt.build !== active?.build) {
                // A coordinator may exit between health verification and the pointer commit.
                if (active) {
                    await stopDaemon(rt);
                    return compatible(await startDaemon(active, rt.port));
                }
                if (!/^\d+\.\d+\.\d+-[a-f0-9]{24}$/.test(rt.build) || readRelease(releaseRoot({ build: rt.build }))?.build !== rt.build) {
                    throw new Error('守护进程运行目录无法验证');
                }
                writeJson(activeFile(), { build: rt.build });
            }
            if (rt.build && active && candidate && newer(candidate, active)) {
                return compatible(await switchRelease(candidate, active, rt));
            }
            return compatible(rt);
        }
        if (candidate && (!active || newer(candidate, active))) {
            return compatible(await switchRelease(candidate, active, null));
        }
        return compatible(await startDaemon(active));
    });
}
