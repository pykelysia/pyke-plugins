import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultBoard } from '../board/types.js';
import { BoardService } from '../board/service.js';
import { loadBoardFile } from '../persist.js';
import { boardsDirOnDisk, boardsIndexFile, boardFileOnDisk, indexFile, projectDirOnDisk, projectsDir, slugify } from './paths.js';
/** 项目注册表：projectDir ↔ slug，落盘在 ~/.ui-draw/index.json */
export class ProjectRegistry {
    projects = new Map();
    /** projectDir → slug，加速查重 */
    byDir = new Map();
    constructor() {
        mkdirSync(projectsDir(), { recursive: true });
        this.load();
    }
    load() {
        try {
            if (!existsSync(indexFile()))
                return;
            const raw = JSON.parse(readFileSync(indexFile(), 'utf-8'));
            for (const [slug, meta] of Object.entries(raw.projects ?? {})) {
                this.projects.set(slug, meta);
                this.byDir.set(meta.projectDir, slug);
            }
        }
        catch {
            // 索引损坏：从头再来（各项目存档文件仍在，重新注册即可找回）
        }
    }
    persist() {
        const out = { projects: Object.fromEntries(this.projects) };
        const file = indexFile();
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf-8');
        renameSync(tmp, file);
    }
    /** 注册（或取回）一个项目，返回稳定的 slug */
    register(projectDir) {
        const dir = projectDir;
        const known = this.byDir.get(dir);
        if (known) {
            const meta = this.projects.get(known);
            meta.updatedAt = new Date().toISOString();
            this.persist();
            return meta;
        }
        const name = dir.split(/[\\/]/).filter(Boolean).pop() || 'project';
        const base = slugify(name);
        let slug = base;
        let n = 2;
        // 不同路径的同名项目：加后缀区分，保证 slug 唯一
        while (this.projects.has(slug) && this.projects.get(slug).projectDir !== dir) {
            slug = `${base}-${n++}`;
        }
        const now = new Date().toISOString();
        const meta = { slug, name, projectDir: dir, createdAt: now, updatedAt: now };
        this.projects.set(slug, meta);
        this.byDir.set(dir, slug);
        this.persist();
        return meta;
    }
    get(slug) {
        return this.projects.get(slug);
    }
    list() {
        return [...this.projects.values()];
    }
    touch(slug) {
        const meta = this.projects.get(slug);
        if (!meta)
            return;
        meta.updatedAt = new Date().toISOString();
        this.persist();
    }
}
const STORE_VERSION = 2;
/** 旧版单画布存档迁移成第一块画布时用的标题 */
const MIGRATED_TITLE = '默认画布';
/**
 * 一块画布的运行时：BoardService + 存档文件。
 * 内容懒加载——只有真正用到这块画布（打开页面 / agent 工具调用）才会读文件。
 */
export class BoardRuntime {
    projectId;
    id;
    title;
    touch;
    service = new BoardService();
    storePath;
    saveTimer = null;
    listeners = new Set();
    constructor(projectId, id, title, touch) {
        this.projectId = projectId;
        this.id = id;
        this.title = title;
        this.touch = touch;
        this.storePath = boardFileOnDisk(projectId, id);
        this.load();
        this.service.subscribe((board) => {
            this.scheduleSave();
            this.touch(this);
            for (const fn of this.listeners)
                fn(board);
        });
    }
    load() {
        try {
            if (existsSync(this.storePath)) {
                const raw = JSON.parse(readFileSync(this.storePath, 'utf-8'));
                if (typeof raw?.title === 'string' && raw.title.trim())
                    this.title = raw.title;
                this.service.restore(raw?.board ?? raw);
                return;
            }
        }
        catch {
            // 存档损坏：从默认画布重来（画布清单还在，内容重置）
        }
        this.service.restore(defaultBoard());
    }
    onCommit(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }
    scheduleSave() {
        if (this.saveTimer)
            clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.flush();
        }, 300);
    }
    flush() {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        try {
            mkdirSync(boardsDirOnDisk(this.projectId), { recursive: true });
            const tmp = `${this.storePath}.tmp`;
            writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, id: this.id, title: this.title, board: this.service.board }, null, 2), 'utf-8');
            renameSync(tmp, this.storePath);
        }
        catch (err) {
            console.error(`[ui-draw] 存档失败 ${this.storePath}:`, err);
        }
    }
    dispose() {
        this.flush();
        try {
            unlinkSync(`${this.storePath}.tmp`);
        }
        catch {
            /* 忽略 */
        }
    }
}
/**
 * 一个项目的运行时状态：画布索引 + 按需打开的画布。
 * 构造只读轻量索引（boards.json），不读任何画布内容。
 */
export class ProjectRuntime {
    meta;
    boards = [];
    open = new Map();
    indexTimer = null;
    /** hub 注入：任何画布有提交时回调（广播 / registry.touch） */
    onBoardCommit = null;
    constructor(meta) {
        this.meta = meta;
        this.loadIndex();
    }
    get boardCount() {
        return this.boards.length;
    }
    listBoards() {
        return this.boards.map((b) => ({ ...b }));
    }
    /** 最近更新的画布（新会话默认落在它上面，接续上次工作） */
    latestBoard() {
        return [...this.boards].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
    }
    findBoardMeta(idOrTitle) {
        return this.boards.find((b) => b.id === idOrTitle || b.title === idOrTitle);
    }
    /** 打开（或取回已打开的）一块画布；不存在返回 undefined */
    board(idOrTitle) {
        const meta = this.findBoardMeta(idOrTitle);
        if (!meta)
            return undefined;
        const existing = this.open.get(meta.id);
        if (existing)
            return existing;
        const rt = new BoardRuntime(this.meta.slug, meta.id, meta.title, (brt) => this.handleCommit(brt));
        this.open.set(meta.id, rt);
        return rt;
    }
    /** 支起一块新画布（一个界面一块画布），标题在项目内唯一 */
    createBoard(title, size) {
        const clean = title.trim();
        if (!clean)
            throw new Error('画布标题不能为空');
        if (this.boards.some((b) => b.title === clean)) {
            throw new Error(`项目里已有一块叫「${clean}」的画布：继续画它就 switch_board 切过去，要画新界面请换个标题`);
        }
        const base = slugify(clean);
        let id = base;
        let n = 2;
        while (this.boards.some((b) => b.id === id))
            id = `${base}-${n++}`;
        const rt = new BoardRuntime(this.meta.slug, id, clean, (brt) => this.handleCommit(brt));
        const fresh = defaultBoard();
        fresh.width = Math.round(size.width);
        fresh.height = Math.round(size.height);
        fresh.grid = size.grid;
        rt.service.restore(fresh);
        this.open.set(id, rt);
        const now = new Date().toISOString();
        this.boards.push({ id, title: clean, createdAt: now, updatedAt: now, width: fresh.width, height: fresh.height, elements: 0 });
        rt.flush();
        this.persistIndex();
        return rt;
    }
    handleCommit(brt) {
        const meta = this.boards.find((b) => b.id === brt.id);
        if (meta) {
            const b = brt.service.board;
            meta.title = brt.title;
            meta.updatedAt = new Date().toISOString();
            meta.width = b.width;
            meta.height = b.height;
            meta.elements = b.elements.length;
            this.scheduleIndexSave();
        }
        this.onBoardCommit?.(brt);
    }
    loadIndex() {
        const idx = boardsIndexFile(this.meta.slug);
        try {
            if (existsSync(idx)) {
                const raw = JSON.parse(readFileSync(idx, 'utf-8'));
                if (Array.isArray(raw?.boards)) {
                    this.boards = raw.boards.filter((b) => b && typeof b.id === 'string' && typeof b.title === 'string');
                    return;
                }
            }
        }
        catch {
            // 索引损坏：走重建
        }
        this.rebuildIndex();
    }
    /** 索引丢失/损坏时从磁盘重建：boards/ 目录优先，其次迁移旧版单画布存档 */
    rebuildIndex() {
        const dir = boardsDirOnDisk(this.meta.slug);
        const found = [];
        if (existsSync(dir)) {
            for (const f of readdirSync(dir).sort()) {
                if (!f.endsWith('.json') || f.endsWith('.tmp'))
                    continue;
                try {
                    const raw = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
                    const board = raw?.board ?? raw;
                    if (!board || !Array.isArray(board.layers) || !Array.isArray(board.elements))
                        continue;
                    const id = f.slice(0, -5);
                    const stat = statSync(join(dir, f));
                    found.push({
                        id,
                        title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : id,
                        createdAt: stat.birthtime.toISOString(),
                        updatedAt: stat.mtime.toISOString(),
                        width: board.width,
                        height: board.height,
                        elements: board.elements.length,
                    });
                }
                catch {
                    /* 跳过坏文件 */
                }
            }
        }
        if (found.length === 0) {
            // 旧版单画布存档：用户目录的 board.json，或更早版本存在项目目录里的
            const legacyHub = join(projectDirOnDisk(this.meta.slug), 'board.json');
            const legacyProject = join(this.meta.projectDir, '.ui-draw', 'board.json');
            for (const [src, removeAfter] of [
                [legacyHub, true],
                [legacyProject, false],
            ]) {
                if (!existsSync(src))
                    continue;
                try {
                    const board = loadBoardFile(src);
                    const id = slugify(MIGRATED_TITLE);
                    mkdirSync(dir, { recursive: true });
                    writeFileSync(boardFileOnDisk(this.meta.slug, id), JSON.stringify({ version: STORE_VERSION, id, title: MIGRATED_TITLE, board }, null, 2), 'utf-8');
                    const now = new Date().toISOString();
                    found.push({ id, title: MIGRATED_TITLE, createdAt: now, updatedAt: now, width: board.width, height: board.height, elements: board.elements.length });
                    if (removeAfter) {
                        try {
                            unlinkSync(src);
                        }
                        catch {
                            /* 迁移完成但旧文件删不掉：留着无碍 */
                        }
                    }
                    break;
                }
                catch {
                    /* 试下一个来源 */
                }
            }
        }
        this.boards = found;
        if (found.length > 0)
            this.persistIndex();
    }
    scheduleIndexSave() {
        if (this.indexTimer)
            clearTimeout(this.indexTimer);
        this.indexTimer = setTimeout(() => {
            this.indexTimer = null;
            this.persistIndex();
        }, 300);
    }
    persistIndex() {
        if (this.indexTimer) {
            clearTimeout(this.indexTimer);
            this.indexTimer = null;
        }
        try {
            mkdirSync(projectDirOnDisk(this.meta.slug), { recursive: true });
            const file = boardsIndexFile(this.meta.slug);
            const tmp = `${file}.tmp`;
            writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, boards: this.boards }, null, 2), 'utf-8');
            renameSync(tmp, file);
        }
        catch (err) {
            console.error(`[ui-draw] 画布索引写入失败 ${this.meta.slug}:`, err);
        }
    }
    flush() {
        for (const rt of this.open.values())
            rt.flush();
        this.persistIndex();
    }
    dispose() {
        for (const rt of this.open.values())
            rt.dispose();
        this.persistIndex();
        try {
            unlinkSync(`${boardsIndexFile(this.meta.slug)}.tmp`);
        }
        catch {
            /* 忽略 */
        }
    }
}
