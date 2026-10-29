import { exec } from 'node:child_process'

/** 用系统默认浏览器打开 URL，返回是否成功（show_board opener=system 用） */
export function openInBrowser(url: string): Promise<{ ok: boolean; error?: string }> {
  const cmd =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`
  return new Promise((resolve) => {
    exec(cmd, (err) => {
      if (err) {
        console.error(`[ui-draw] 打开浏览器失败，请手动访问 ${url}`)
        resolve({ ok: false, error: err.message })
      } else {
        resolve({ ok: true })
      }
    })
  })
}
