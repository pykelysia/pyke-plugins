#!/usr/bin/env node
import { resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { HubClient } from './hub/client.js'
import { resolveProjectDir } from './hub/project-dir.js'
import { DAEMON_VERSION } from './hub/version.js'
import { registerTools } from './mcp/tools.js'

/** 当前 agent 所在项目：可用 UI_DRAW_PROJECT_DIR 指定，否则从工作目录向上找项目根 */
function projectDir(): string {
  return process.env.UI_DRAW_PROJECT_DIR ? resolve(process.env.UI_DRAW_PROJECT_DIR) : resolveProjectDir(process.cwd())
}

async function main() {
  // 所有会话共享一个常驻守护进程（自动拉起），画板按项目名区分
  let clientPromise: Promise<HubClient> | null = null
  const client = () => {
    if (!clientPromise) {
      clientPromise = HubClient.connect(projectDir()).catch((err) => {
        clientPromise = null
        throw err
      })
    }
    return clientPromise
  }

  const server = new McpServer({ name: 'ui-draw', version: DAEMON_VERSION })
  registerTools(server, { client })
  await server.connect(new StdioServerTransport())

  // 预热：会话一开始就把守护进程/本项目画板准备好（失败不阻塞启动）
  client().catch((err) => console.error('[ui-draw] 连接后台服务失败：', err instanceof Error ? err.message : err))

  // MCP 进程随会话结束退出；守护进程继续常驻，画板与存档不受影响
  process.stdin.on('end', () => process.exit(0))
  process.stdin.on('close', () => process.exit(0))
  process.stdin.resume()
  console.error(`[ui-draw] MCP server 已启动（stdio）· 项目 ${projectDir()}`)
}

main().catch((err) => {
  console.error('[ui-draw] 启动失败：', err)
  process.exit(1)
})
