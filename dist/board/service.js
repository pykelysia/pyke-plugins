import { defaultBoard } from './types.js';
import { applyOp, opChangedIds } from './ops.js';
const HISTORY_LIMIT = 100;
/**
 * 画板状态服务：agent 工具与浏览器人类编辑共用。
 * 快照式撤销栈 —— past 存"操作之前"的状态，线框数据量小，简单可靠。
 */
export class BoardService {
    board = defaultBoard();
    revision = 0;
    past = [];
    future = [];
    listeners = new Set();
    commit(op, actor = 'agent') {
        this.past.push(structuredClone(this.board));
        if (this.past.length > HISTORY_LIMIT)
            this.past.shift();
        this.future = [];
        this.board = applyOp(this.board, op);
        this.revision++;
        const meta = { op, actor, changedIds: opChangedIds(op) };
        for (const fn of this.listeners)
            fn(this.board, meta);
    }
    undo() {
        if (this.past.length === 0)
            return false;
        this.future.push(structuredClone(this.board));
        this.board = this.past.pop();
        this.revision++;
        for (const fn of this.listeners)
            fn(this.board, null);
        return true;
    }
    redo() {
        if (this.future.length === 0)
            return false;
        this.past.push(structuredClone(this.board));
        this.board = this.future.pop();
        this.revision++;
        for (const fn of this.listeners)
            fn(this.board, null);
        return true;
    }
    get canUndo() {
        return this.past.length > 0;
    }
    get canRedo() {
        return this.future.length > 0;
    }
    subscribe(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }
    snapshot() {
        return structuredClone(this.board);
    }
    /** 启动时恢复存档：直接替换状态，不产生撤销记录、不通知订阅者 */
    restore(board) {
        this.board = structuredClone(board);
        this.past = [];
        this.future = [];
    }
}
