import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
/**
 * 数据目录：默认在用户主目录下（跨项目共享一个守护进程）。
 * UI_DRAW_HOME 可覆盖（测试/多用户隔离用）。
 */
export function dataDir() {
    return process.env.UI_DRAW_HOME ? resolve(process.env.UI_DRAW_HOME) : join(homedir(), '.ui-draw');
}
export function projectsDir() {
    return join(dataDir(), 'projects');
}
export function projectDirOnDisk(slug) {
    return join(projectsDir(), slug);
}
export function runtimeFile() {
    return join(dataDir(), 'runtime.json');
}
export function indexFile() {
    return join(dataDir(), 'index.json');
}
export function lockFile() {
    return join(dataDir(), 'daemon.lock');
}
/**
 * 项目名 → URL/文件系统安全的段。
 * 保留中文等项目名本身（用户就靠它认项目），只把空格和非法字符换成 '-'。
 */
export function slugify(name) {
    const cleaned = name
        .normalize('NFKC')
        // eslint-disable-next-line no-control-regex
        .replace(/[\s<>:"/\\|?*\u0000-\u001f]+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '')
        .slice(0, 48);
    return cleaned || 'project';
}
