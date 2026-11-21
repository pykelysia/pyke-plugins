/**
 * 各 agent 的 MCP 配置写入：只合并/移除本插件这一项，写前备份，保留其余配置。
 * 配置文件路径与格式参照 docs/agent-compatibility.md。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readJsonIfExists, writeJsonWithBackup } from './util.mjs'

/** 各配置格式如何把服务条目并入配置对象（entry 形如 {command, args}）。 */
const FORMATS = {
  // Cursor / Gemini / Claude / Copilot / Cline / Roo / Windsurf 共用的 mcpServers 形态
  mcpServers: {
    apply(cfg, name, entry) {
      cfg.mcpServers ??= {}
      cfg.mcpServers[name] = entry
    },
    remove(cfg, name) {
      if (cfg.mcpServers?.[name] === undefined) return false
      delete cfg.mcpServers[name]
      return true
    },
  },
  // ZCode：mcp.servers 下注册服务；skills 下 enable 已安装的 skill 文件
  zcode: {
    apply(cfg, name, entry, ctx) {
      cfg.mcp ??= {}
      cfg.mcp.servers ??= {}
      cfg.mcp.servers[name] = entry
      if (ctx?.skillFiles?.length) {
        cfg.skills ??= {}
        for (const file of ctx.skillFiles) {
          cfg.skills[file] = { ...cfg.skills[file], enable: true }
        }
      }
    },
    remove(cfg, name, ctx) {
      let removed = false
      if (cfg.mcp?.servers?.[name] !== undefined) {
        delete cfg.mcp.servers[name]
        removed = true
      }
      for (const file of ctx?.skillFiles ?? []) {
        if (cfg.skills?.[file] !== undefined) {
          delete cfg.skills[file]
          removed = true
        }
      }
      return removed
    },
  },
  // Kilo Code：mcp 下 type:local + 命令数组（与 OpenCode 稳定版同构）
  kilo: {
    apply(cfg, name, entry) {
      cfg.mcp ??= {}
      cfg.mcp[name] = { type: 'local', command: [entry.command, ...entry.args] }
    },
    remove(cfg, name) {
      if (cfg.mcp?.[name] === undefined) return false
      delete cfg.mcp[name]
      return true
    },
  },
}

/**
 * 每个 target 的定义：
 *   skillTarget —— skill 装到 cli/skills.mjs 的哪个目录映射
 *   user/project —— 对应 scope 的 MCP 配置文件与格式；缺省表示该 scope 无可写配置
 */
export const MCP_TARGETS = {
  zcode: {
    skillTarget: 'zcode',
    user: { file: () => join(homedir(), '.zcode', 'cli', 'config.json'), format: 'zcode' },
  },
  cursor: {
    skillTarget: 'cursor',
    user: { file: () => join(homedir(), '.cursor', 'mcp.json'), format: 'mcpServers' },
    project: { file: (project) => join(resolve(project), '.cursor', 'mcp.json'), format: 'mcpServers' },
  },
  gemini: {
    skillTarget: 'gemini',
    user: { file: () => join(homedir(), '.gemini', 'settings.json'), format: 'mcpServers' },
    project: { file: (project) => join(resolve(project), '.gemini', 'settings.json'), format: 'mcpServers' },
  },
  claude: {
    skillTarget: 'claude',
    user: { file: () => join(homedir(), '.claude.json'), format: 'mcpServers' },
    project: { file: (project) => join(resolve(project), '.mcp.json'), format: 'mcpServers' },
  },
  copilot: {
    skillTarget: 'copilot',
    project: { file: (project) => join(resolve(project), '.mcp.json'), format: 'mcpServers' },
  },
  cline: {
    skillTarget: 'cline',
    user: {
      file: () => join(homedir(), '.cline', 'data', 'settings', 'cline_mcp_settings.json'),
      format: 'mcpServers',
    },
    project: { file: (project) => join(resolve(project), '.cline', 'mcp.json'), format: 'mcpServers' },
  },
  windsurf: {
    skillTarget: 'windsurf',
    user: { file: () => join(homedir(), '.codeium', 'windsurf', 'mcp_config.json'), format: 'mcpServers' },
    project: { file: (project) => join(resolve(project), '.windsurf', 'mcp_config.json'), format: 'mcpServers' },
  },
  roo: {
    skillTarget: 'roo',
    user: { file: () => join(homedir(), '.roo', 'mcp.json'), format: 'mcpServers' },
    project: { file: (project) => join(resolve(project), '.roo', 'mcp.json'), format: 'mcpServers' },
  },
  kilo: {
    skillTarget: 'kilo',
    user: { file: () => join(homedir(), '.kilo', 'kilo.json'), format: 'kilo' },
    project: { file: (project) => join(resolve(project), '.kilo', 'kilo.json'), format: 'kilo' },
  },
}

/** 插件是否声明 MCP（可移植 mcp.json 存在即视为声明）。 */
export function pluginHasMcp(pluginDir) {
  return existsSync(join(pluginDir, 'mcp.json'))
}

function resolveWriter(targetId, scope, project) {
  const target = MCP_TARGETS[targetId]
  if (!target) return null
  const spec = scope === 'project' ? target.project : target.user
  if (!spec) return null
  return { file: scope === 'project' ? spec.file(project) : spec.file(), format: spec.format }
}

/** 该 target 在该 scope 下是否有可写的 MCP 配置（决定是否需要落稳定负载）。 */
export function hasMcpWriter(targetId, scope = 'user') {
  const target = MCP_TARGETS[targetId]
  return Boolean(target && (scope === 'project' ? target.project : target.user))
}

/** 写入 MCP 配置；返回配置文件路径，目标无对应配置时返回 null。 */
export function writeMcpConfig({ target, scope = 'user', project, pluginName, runEntry, skillFiles = [] } = {}) {
  const writer = resolveWriter(target, scope, project)
  if (!writer) return null
  const cfg = readJsonIfExists(writer.file) ?? {}
  FORMATS[writer.format].apply(cfg, pluginName, { command: 'node', args: [runEntry] }, { skillFiles })
  writeJsonWithBackup(writer.file, cfg)
  return writer.file
}

/** 移除 MCP 配置中的本插件条目；返回是否发生了改动。 */
export function removeMcpConfig({ target, scope = 'user', project, pluginName, skillFiles = [] } = {}) {
  const writer = resolveWriter(target, scope, project)
  if (!writer) return false
  const cfg = readJsonIfExists(writer.file)
  if (cfg === undefined) return false
  const changed = FORMATS[writer.format].remove(cfg, pluginName, { skillFiles })
  if (changed) {
    writeJsonWithBackup(writer.file, cfg)
  }
  return changed
}
