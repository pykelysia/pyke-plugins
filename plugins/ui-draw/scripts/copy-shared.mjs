// 把编译产物中浏览器需要的共享模块复制到 web/shared/，保证页面渲染与无头截图同一份代码
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dist = join(root, 'dist', 'board')
const target = join(root, 'web', 'shared')
mkdirSync(target, { recursive: true })
for (const f of ['render.js', 'ops.js', 'types.js']) {
  copyFileSync(join(dist, f), join(target, f))
}
console.log('已复制共享渲染模块到 web/shared/')
