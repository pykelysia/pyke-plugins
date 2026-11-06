#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync } from 'node:fs';
import { HubServer } from './hub/server.js';
import { dataDir, runtimeFile } from './hub/paths.js';
import { ownsLaunch, readRelease, readRuntime, runningDaemon, writeJson } from './hub/lifecycle.js';
import { DAEMON_VERSION, HUB_PROTOCOL } from './hub/version.js';
async function main() {
    // Loading HubServer also loads the platform-specific canvas binding.
    if (process.argv.includes('--check'))
        return;
    mkdirSync(dataDir(), { recursive: true });
    if (await runningDaemon()) {
        console.error('[ui-draw daemon] 已有实例在运行，退出');
        return;
    }
    const build = readRelease()?.build;
    const launch = process.env.UI_DRAW_DAEMON_TOKEN;
    const token = launch ?? randomUUID();
    delete process.env.UI_DRAW_DAEMON_TOKEN;
    let stopping = false;
    const close = async () => {
        if (stopping)
            return;
        stopping = true;
        await server.stop();
        if (readRuntime()?.token === token)
            unlinkSync(runtimeFile());
        process.exit(0);
    };
    const report = (err) => console.error('[ui-draw daemon] 停止失败：', err);
    const server = new HubServer({ build, token, onShutdown: () => { void close().catch(report); } });
    const port = await server.start(Number(process.env.UI_DRAW_DAEMON_PORT ?? 4680), 4700);
    if (launch && !ownsLaunch(launch)) {
        await server.stop();
        return;
    }
    writeJson(runtimeFile(), { port, pid: process.pid, version: DAEMON_VERSION, protocol: HUB_PROTOCOL, build, token });
    console.error(`[ui-draw daemon] 已启动：http://127.0.0.1:${port}（pid ${process.pid}）`);
    const shutdown = () => { void server.drain().then(close).catch(report); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
main().catch((err) => {
    console.error('[ui-draw daemon] 启动失败：', err);
    process.exit(1);
});
