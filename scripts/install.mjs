#!/usr/bin/env node
/**
 * 一键安装（不走插件市场的手动路线）：
 *   1. 安装依赖并构建
 *   2. 把 ui-draw 写进 ~/.zcode/cli/config.json 的 mcp.servers
 *   3. 把 skill 复制到 ~/.agents/skills/ui-draw
 *   4. 拉起常驻守护进程
 *
 * 用法：node scripts/install.mjs [--no-config] [--no-skill] [--no-daemon]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = new Set(process.argv.slice(2))
const log = (msg) => console.log(`[ui-draw] ${msg}`)

function npm(argsArr) {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return spawnSync(npmCmd, argsArr, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
}

// 1. 依赖 + 构建
if (!existsSync(join(root, 'node_modules'))) {
  log('安装依赖…')
  const r = npm(['install', '--no-audit', '--no-fund'])
  if (r.status !== 0) process.exit(1)
}
log('构建…')
const b = npm(['run', 'build'])
if (b.status !== 0) process.exit(1)

const entry = join(root, 'dist', 'index.js')
const skillFile = join(homedir(), '.agents', 'skills', 'ui-draw', 'SKILL.md')

// 2. MCP 配置
if (!args.has('--no-config')) {
  const cfgDir = join(homedir(), '.zcode', 'cli')
  const cfgFile = join(cfgDir, 'config.json')
  mkdirSync(cfgDir, { recursive: true })
  let cfg = {}
  if (existsSync(cfgFile)) {
    const raw = readFileSync(cfgFile, 'utf-8')
    cfg = raw.trim() ? JSON.parse(raw) : {}
    writeFileSync(`${cfgFile}.bak-${Date.now()}`, raw, 'utf-8')
  }
  cfg.mcp ??= {}
  cfg.mcp.servers ??= {}
  cfg.mcp.servers['ui-draw'] = { command: 'node', args: [entry] }
  if (!args.has('--no-skill')) {
    cfg.skills ??= {}
    const skillKey = skillFile.replaceAll('\\', '/')
    cfg.skills[skillKey] = { ...cfg.skills[skillKey], enable: true }
  }
  writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n', 'utf-8')
  log(`已写入 MCP 配置：${cfgFile}`)
}

// 3. skill
if (!args.has('--no-skill')) {
  const destDir = dirname(skillFile)
  mkdirSync(destDir, { recursive: true })
  copyFileSync(join(root, 'skills', 'ui-draw', 'SKILL.md'), skillFile)
  log(`已安装 skill：${destDir}`)
}

// 4. 守护进程
if (!args.has('--no-daemon')) {
  const child = spawn(process.execPath, [join(root, 'dist', 'daemon.js')], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  log('已尝试启动常驻守护进程（若已在运行会自动退出）')
}

log('')
log('安装完成。新开一个会话即可使用 ui-draw 工具与 skill。')
log('画板服务/项目索引：http://127.0.0.1:4680/')
log('如果你走的是「插件市场」安装，这里不需要重复执行；插件首次运行会自动补齐依赖。')
