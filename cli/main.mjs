#!/usr/bin/env node
/**
 * pyke-plugins CLI：跨 agent 插件市场的命令行安装器。
 *
 *   list                          列出市场内的插件
 *   install <plugin> [options]    安装插件：复制 skill、落稳定负载并写入 MCP 配置
 *   uninstall <plugin> [options]  移除已安装的 skill、MCP 配置与稳定负载
 */
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CliError, fail, pkgRoot, readJsonIfExists } from './util.mjs'
import { installSkills, removeSkills } from './skills.mjs'
import { installPayload, payloadHome, removePayload } from './payload.mjs'
import { MCP_TARGETS, hasMcpWriter, pluginHasMcp, removeMcpConfig, writeMcpConfig } from './mcp-config.mjs'

const USAGE = `pyke-plugins — 跨 agent 插件市场的命令行安装器

用法：
  pyke-plugins list                                     列出市场内的插件
  pyke-plugins install <plugin> [options]               安装插件（skill + MCP 配置）
  pyke-plugins uninstall <plugin> [options]             移除已安装内容
  pyke-plugins help | --help | -h                       显示本帮助
  pyke-plugins --version | -v                           显示版本

install / uninstall 选项：
  --target <t>      目标 agent，默认 agents。可选：
                    agents（~/.agents/skills，通用目录）
                    zcode | cursor | gemini | claude | copilot
                    | cline | windsurf | roo | kilo
  --scope <s>       user（默认）或 project（需 --project <项目目录>）
  --project <path>  project scope 对应的项目目录
  --no-skill        只配置 MCP，不安装 skill（install）
  --no-mcp          只安装 skill，不写 MCP 配置（install）
  --force           覆盖已存在的 skill 目录（install）

说明：
  带 MCP 的插件会把负载（dist/web/scripts 等）复制到稳定目录
  ~/.pyke-plugins/plugins/<name>/，MCP 配置指向该目录（可用环境变量
  PYKE_PLUGINS_HOME 覆盖），不依赖 npx 缓存。skill-only 插件只安装 skill。`

const VALUE_OPTIONS = new Set(['--target', '--scope', '--project'])
const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/

function parseArgs(argv) {
  const positional = []
  const flags = new Set()
  const values = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (VALUE_OPTIONS.has(arg)) {
      const value = argv[++i]
      if (value === undefined) fail(`Option ${arg} requires a value.\n\n${USAGE}`, 2)
      values[arg.slice(2)] = value
    } else if (arg.startsWith('--')) {
      flags.add(arg.slice(2))
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags, values }
}

/** install 与 uninstall 共用的 scope/project 校验。 */
function checkScope({ scope, project }) {
  if (!['user', 'project'].includes(scope)) {
    fail(`Use --scope user|project.\n\n${USAGE}`, 2)
  }
  if (scope === 'project') {
    if (!project) {
      fail('Project scope requires --project <absolute-or-relative-project-directory>.', 2)
    }
    const resolved = resolve(project)
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      fail(`Project directory does not exist: ${resolved}`, 2)
    }
  }
}

function findPlugin(pluginName) {
  if (!pluginName || !PLUGIN_NAME_RE.test(pluginName)) {
    fail('Provide a plugin name. Run "pyke-plugins list" to see available plugins.', 2)
  }
  const pluginDir = join(pkgRoot, 'plugins', pluginName)
  if (!existsSync(pluginDir)) {
    fail(`Unknown plugin: ${pluginName}. Run "pyke-plugins list" to see available plugins.`, 2)
  }
  return pluginDir
}

function listPlugins() {
  const marketplace = readJsonIfExists(join(pkgRoot, 'marketplace.json'))
  const plugins = marketplace?.plugins
  if (!Array.isArray(plugins) || plugins.length === 0) {
    console.log('市场内暂无插件。')
    return
  }
  console.log(`市场 ${marketplace.name ?? pkgRoot} 内的插件：`)
  for (const plugin of plugins) {
    console.log(`  ${plugin.name}@${plugin.version ?? '?'}  ${plugin.description ?? ''}`)
  }
}

function cmdInstall(argv) {
  const { positional, flags, values } = parseArgs(argv)
  if (positional.length > 1) fail(`Unexpected argument: ${positional[1]}\n\n${USAGE}`, 2)
  const pluginDir = findPlugin(positional[0])
  const pluginName = positional[0]
  const target = values.target ?? 'agents'
  const scope = values.scope ?? 'user'
  checkScope({ scope, project: values.project })

  const hasMcp = pluginHasMcp(pluginDir)
  const skipMcp = flags.has('no-mcp')
  const canWriteMcp = hasMcpWriter(target, scope)
  const skillTarget = MCP_TARGETS[target]?.skillTarget ?? target

  // 1. skill（先装：已存在且未 --force 时直接失败，不留下半成品）
  let skills = []
  if (!flags.has('no-skill')) {
    skills = installSkills({
      root: pkgRoot,
      pluginName,
      target: skillTarget,
      scope,
      project: values.project,
      force: flags.has('force'),
    })
  }

  // 2. 稳定负载 + MCP 配置（目标在该 scope 下有可写配置才落负载）
  if (hasMcp && !skipMcp && canWriteMcp) {
    const payloadDir = installPayload(pluginDir, pluginName)
    const runEntry = join(payloadDir, 'scripts', 'run.mjs').replaceAll('\\', '/')
    if (!existsSync(runEntry)) {
      fail(`Plugin ${pluginName} declares mcp.json but scripts/run.mjs is missing.`, 1)
    }
    console.log(`已复制插件负载 -> ${payloadDir}`)
    const skillFiles = skills.map((skill) => join(skill.destination, 'SKILL.md').replaceAll('\\', '/'))
    const configFile = writeMcpConfig({ target, scope, project: values.project, pluginName, runEntry, skillFiles })
    console.log(`已写入 MCP 配置 -> ${configFile}（原文件已备份）`)
  } else if (hasMcp && !skipMcp && target === 'copilot' && scope === 'user') {
    console.log('提示：copilot 的 MCP 配置需要项目级 .mcp.json；重跑并加 --scope project --project <仓库路径>。本次仅安装了 skill。')
  } else if (hasMcp && !skipMcp) {
    console.log(
      `提示：${target} 目标没有统一的 MCP 配置位置；如需 MCP 工具，` +
        '可改用 --target zcode|cursor|gemini|claude|copilot|cline|windsurf|roo|kilo 重新执行。',
    )
  } else if (hasMcp && skipMcp) {
    console.log('已按 --no-mcp 跳过 MCP 配置。')
  }

  console.log('完成。重启或刷新目标 agent 后生效。')
}

function cmdUninstall(argv) {
  const { positional, values } = parseArgs(argv)
  if (positional.length > 1) fail(`Unexpected argument: ${positional[1]}\n\n${USAGE}`, 2)
  const pluginDir = findPlugin(positional[0])
  const pluginName = positional[0]
  const target = values.target ?? 'agents'
  const scope = values.scope ?? 'user'
  checkScope({ scope, project: values.project })

  const skillTarget = MCP_TARGETS[target]?.skillTarget ?? target
  const removedSkills = removeSkills({
    root: pkgRoot,
    pluginName,
    target: skillTarget,
    scope,
    project: values.project,
  })
  for (const destination of removedSkills) console.log(`已移除 skill -> ${destination}`)

  if (pluginHasMcp(pluginDir)) {
    const skillFiles = removedSkills.map((destination) => join(destination, 'SKILL.md').replaceAll('\\', '/'))
    const changed = removeMcpConfig({ target, scope, project: values.project, pluginName, skillFiles })
    console.log(changed ? '已从 MCP 配置移除本插件条目（原文件已备份）。' : 'MCP 配置中没有本插件条目。')
    if (removePayload(pluginName)) console.log(`已移除插件负载 -> ${join(payloadHome(), 'plugins', pluginName)}`)
  }
  console.log('完成。')
}

export function main(argv) {
  try {
    const [command = 'help'] = argv
    if (command === 'help' || command === '--help' || command === '-h') {
      console.log(USAGE)
    } else if (command === '--version' || command === '-v') {
      console.log(readJsonIfExists(join(pkgRoot, 'package.json'))?.version ?? '0.0.0')
    } else if (command === 'list') {
      listPlugins()
    } else if (command === 'install') {
      cmdInstall(argv.slice(1))
    } else if (command === 'uninstall') {
      cmdUninstall(argv.slice(1))
    } else {
      throw new CliError(`未知子命令：${command}\n\n${USAGE}`, 2)
    }
  } catch (error) {
    if (error instanceof CliError) {
      console.error(error.message)
      process.exitCode = error.exitCode
    } else {
      throw error
    }
  }
}
