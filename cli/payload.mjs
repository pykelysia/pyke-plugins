/**
 * 插件稳定负载：带 MCP 的插件复制到 ~/.pyke-plugins/plugins/<name>/，
 * MCP 配置指向该目录，避免 npx 缓存被清理后失效。
 * 运行时只需要 dist/web/skills/scripts 与各清单，src 与 tests 不进负载。
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'

export function payloadHome() {
  return process.env.PYKE_PLUGINS_HOME ?? join(homedir(), '.pyke-plugins')
}

const EXCLUDED_TOP = new Set(['src', 'tests', 'node_modules'])
const EXCLUDED_FILES = new Set(['tsconfig.json'])

export function installPayload(pluginDir, pluginName) {
  const destination = join(payloadHome(), 'plugins', pluginName)
  if (existsSync(destination)) {
    rmSync(destination, { recursive: true, force: true })
  }
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(pluginDir, destination, {
    recursive: true,
    filter: (source) => {
      const rel = relative(pluginDir, source)
      if (!rel) return true
      const top = rel.split(/[\\/]/)[0]
      return !EXCLUDED_TOP.has(top) && !EXCLUDED_FILES.has(basename(source))
    },
  })
  return destination
}

export function removePayload(pluginName) {
  const destination = join(payloadHome(), 'plugins', pluginName)
  if (!existsSync(destination)) return false
  rmSync(destination, { recursive: true, force: true })
  return true
}
