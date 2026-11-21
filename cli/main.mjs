#!/usr/bin/env node
/**
 * pyke-plugins CLI：跨 agent 插件市场的命令行安装器。
 *
 *   list                          列出市场内的插件
 *   install <plugin> [options]    安装插件：复制 skill、落稳定负载并写入 MCP 配置
 *   uninstall <plugin> [options]  移除已安装的 skill、MCP 配置与稳定负载
 */
import { join } from 'node:path'
import { CliError, pkgRoot, readJsonIfExists } from './util.mjs'

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

export function main(argv) {
  try {
    const [command = 'help'] = argv
    if (command === 'help' || command === '--help' || command === '-h') {
      console.log(USAGE)
    } else if (command === '--version' || command === '-v') {
      console.log(readJsonIfExists(join(pkgRoot, 'package.json'))?.version ?? '0.0.0')
    } else if (command === 'list') {
      listPlugins()
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
