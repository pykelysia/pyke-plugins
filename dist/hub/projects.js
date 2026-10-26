import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultBoard } from '../board/types.js';
import { BoardService } from '../board/service.js';
import { loadBoardFile } from '../persist.js';
import { indexFile, projectDirOnDisk, projectsDir, slugify } from './paths.js';
const FILE_VERSION = 1;
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
/** 一个项目的运行时状态：画板服务 + 存档 */
export class ProjectRuntime {
    meta;
    service = new BoardService();
    storePath;
    saveTimer = null;
    listeners = new Set();
    constructor(meta) {
        this.meta = meta;
        this.storePath = join(projectDirOnDisk(meta.slug), 'board.json');
        this.load();
        this.service.subscribe((board) => {
            this.scheduleSave();
            for (const fn of this.listeners)
                fn(board);
        });
    }
    load() {
        const legacy = join(this.meta.projectDir, '.ui-draw', 'board.json');
        try {
            if (existsSync(this.storePath)) {
                this.service.restore(loadBoardFile(this.storePath));
                return;
            }
            // 旧版本按项目目录存过档：迁移到用户目录
            if (existsSync(legacy)) {
                this.service.restore(loadBoardFile(legacy));
                this.flush();
                return;
            }
        }
        catch {
            this.service.restore(defaultBoard());
            return;
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
            mkdirSync(projectDirOnDisk(this.meta.slug), { recursive: true });
            const file = this.storePath;
            const tmp = `${file}.tmp`;
            const pick = {
                version: FILE_VERSION,
                board: this.service.board,
            };
            writeFileSync(tmp, JSON.stringify(pick, null, 2), 'utf-8');
            renameSync(tmp, file);
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
