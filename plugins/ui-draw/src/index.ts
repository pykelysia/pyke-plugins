#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { HubClient } from './hub/client.js'
import { resolveProjectDir } from './hub/project-dir.js'
import { DAEMON_VERSION } from './hub/version.js'
import { registerTools } from './mcp/tools.js'

function isInside(dir: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(dir))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** 显式目录可覆盖插件进程的 cwd，供把 MCP 放在插件目录运行的宿主使用。 */
function projectDir(explicit?: string): string {
  if (explicit !== undefined && !isAbsolute(explicit)) throw new Error('project_dir 必须是当前项目的绝对目录。')
  const configured = explicit ?? process.env.UI_DRAW_PROJECT_DIR
  if (configured) {
    const dir = resolve(configured)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`项目目录不存在：${dir}`)
    return resolveProjectDir(dir)
  }
  const cwd = resolve(process.cwd())
  const pluginRoot = process.env.PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT ?? process.env.ZCODE_PLUGIN_ROOT
  if (pluginRoot && isInside(cwd, pluginRoot)) {
    throw new Error('MCP 进程运行在插件目录，无法确定当前项目；首次调用 list_boards 或 setup_board 时请传 project_dir=当前项目绝对目录。')
  }
  return resolveProjectDir(cwd)
}

async function main() {
  // 所有会话共享一个常驻守护进程（自动拉起），画板按项目名区分
  let clientPromise: Promise<HubClient> | null = null
  let clientDir: string | null = null
  const client = (explicitDir?: string) => {
    if (clientPromise) {
      if (explicitDir && projectDir(explicitDir) !== clientDir) {
        throw new Error(`当前 MCP 会话已绑定项目 ${clientDir}，不能切换到另一个项目。请新开会话。`)
      }
      return clientPromise
    }
    const dir = projectDir(explicitDir)
    clientDir = dir
    console.error(`[ui-draw] 当前项目：${dir}`)
    clientPromise = HubClient.connect(dir).catch((err) => {
      clientPromise = null
      clientDir = null
      throw err
    })
    return clientPromise
  }

  const server = new McpServer({ name: 'ui-draw', version: DAEMON_VERSION })
  registerTools(server, { client })
  await server.connect(new StdioServerTransport())

  // 懒创建：不预热。会话开始不注册项目、不拉守护进程，
  // agent 第一次真正调用画板工具时才连（没用到画板的对话不产生任何项目/画布）。
  // MCP 进程随会话结束退出；守护进程继续常驻，画板与存档不受影响
  process.stdin.on('end', () => process.exit(0))
  process.stdin.on('close', () => process.exit(0))
  process.stdin.resume()
  console.error('[ui-draw] MCP server 已启动（stdio）· 首次使用时识别项目')
}

main().catch((err) => {
  console.error('[ui-draw] 启动失败：', err)
  process.exit(1)
})
