import { Board, defaultBoard } from './types.js'
import { Op, applyOp, opChangedIds } from './ops.js'

export interface CommitMeta {
  op: Op
  actor: 'agent' | 'human'
  changedIds: string[]
}

const HISTORY_LIMIT = 100

/**
 * 画板状态服务：agent 工具与浏览器人类编辑共用。
 * 快照式撤销栈 —— past 存"操作之前"的状态，线框数据量小，简单可靠。
 */
export class BoardService {
  board: Board = defaultBoard()
  revision = 0
  private past: Board[] = []
  private future: Board[] = []
  private listeners = new Set<(board: Board, meta: CommitMeta | null) => void>()

  commit(op: Op, actor: 'agent' | 'human' = 'agent'): void {
    const next = applyOp(this.board, op)
    this.past.push(structuredClone(this.board))
    if (this.past.length > HISTORY_LIMIT) this.past.shift()
    this.future = []
    this.board = next
    this.revision++
    const meta: CommitMeta = { op, actor, changedIds: opChangedIds(op) }
    for (const fn of this.listeners) fn(this.board, meta)
  }

  undo(): boolean {
    if (this.past.length === 0) return false
    this.future.push(structuredClone(this.board))
    this.board = this.past.pop()!
    this.revision++
    for (const fn of this.listeners) fn(this.board, null)
    return true
  }

  redo(): boolean {
    if (this.future.length === 0) return false
    this.past.push(structuredClone(this.board))
    this.board = this.future.pop()!
    this.revision++
    for (const fn of this.listeners) fn(this.board, null)
    return true
  }

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  subscribe(fn: (board: Board, meta: CommitMeta | null) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  snapshot(): Board {
    return structuredClone(this.board)
  }

  /** 启动时恢复存档：直接替换状态，不产生撤销记录、不通知订阅者 */
  restore(board: Board): void {
    this.board = structuredClone(board)
    this.past = []
    this.future = []
  }
}
