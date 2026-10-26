// 停止 ui-draw 守护进程（读取 ~/.ui-draw/runtime.json 里的 pid）
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const home = process.env.UI_DRAW_HOME ? resolve(process.env.UI_DRAW_HOME) : join(homedir(), '.ui-draw')
const runtimeFile = join(home, 'runtime.json')

if (!existsSync(runtimeFile)) {
  console.log('没有找到运行中的 ui-draw 守护进程。')
  process.exit(0)
}
const rt = JSON.parse(readFileSync(runtimeFile, 'utf-8'))
try {
  process.kill(rt.pid)
  console.log(`已停止 ui-draw 守护进程（pid ${rt.pid}，端口 ${rt.port}）。`)
} catch (err) {
  console.log(`停止失败（可能已经退出）：${err instanceof Error ? err.message : err}`)
}
