import { stopRunningDaemon } from '../dist/hub/lifecycle.js'

try {
  const stopped = await stopRunningDaemon()
  console.log(stopped ? '已停止 ui-draw 守护进程。' : '没有找到运行中的 ui-draw 守护进程。')
} catch (err) {
  console.error(`停止失败：${err.message}`)
  process.exitCode = 1
}
