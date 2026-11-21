/**
 * skill 目录映射与复制：把 plugins/<name>/skills/* 安装到目标 agent 的 skill 目录。
 * 语义与 scripts/install-skills.mjs 保持一致；新增 zcode/cursor/gemini 三个
 * 目标（skill 目录与 agents 相同，差别只在 MCP 配置写入）。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { CliError, fail } from './util.mjs'

export const projectDirs = {
  agents: '.agents/skills',
  zcode: '.agents/skills',
  cursor: '.agents/skills',
  gemini: '.agents/skills',
  claude: '.claude/skills',
  copilot: '.github/skills',
  cline: '.cline/skills',
  windsurf: '.devin/skills',
  roo: '.roo/skills',
  kilo: '.kilo/skills',
}

const userDirs = () => {
  const home = homedir()
  return {
    agents: join(home, '.agents', 'skills'),
    zcode: join(home, '.agents', 'skills'),
    cursor: join(home, '.agents', 'skills'),
    gemini: join(home, '.agents', 'skills'),
    claude: join(home, '.claude', 'skills'),
    copilot: join(home, '.copilot', 'skills'),
    cline: join(home, '.cline', 'skills'),
    windsurf: join(home, '.codeium', 'windsurf', 'skills'),
    roo: join(home, '.roo', 'skills'),
    kilo: join(home, '.kilo', 'skills'),
  }
}

const targetList = () => Object.keys(projectDirs).join('|')

export function skillDestination({ target, scope = 'user', project } = {}) {
  if (!Object.hasOwn(projectDirs, target) || !['user', 'project'].includes(scope)) {
    fail(`Use --target ${targetList()} and --scope user|project.`, 2)
  }
  if (scope === 'project' && !project) {
    fail('Project scope requires --project <absolute-or-relative-project-directory>.', 2)
  }
  if (scope === 'project' && (!existsSync(resolve(project)) || !statSync(resolve(project)).isDirectory())) {
    fail(`Project directory does not exist: ${resolve(project)}`, 2)
  }
  return scope === 'user' ? userDirs()[target] : join(resolve(project), projectDirs[target])
}

/** 插件包含哪些 skill：skills/ 下带 SKILL.md 的子目录。 */
export function listPluginSkills(root, pluginName) {
  const skillsDir = join(root, 'plugins', pluginName, 'skills')
  if (!existsSync(skillsDir)) {
    fail(`No skills directory found for plugin: ${pluginName}`, 1)
  }
  const skills = readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, 'SKILL.md')))
    .map((entry) => ({ name: entry.name, source: join(skillsDir, entry.name) }))
  if (skills.length === 0) {
    fail(`No SKILL.md files found under ${skillsDir}`, 1)
  }
  return skills
}

export function installSkills({ root, pluginName, target, scope = 'user', project, force = false } = {}) {
  const destinationRoot = skillDestination({ target, scope, project })
  const skills = listPluginSkills(root, pluginName)

  const existing = skills.map((skill) => join(destinationRoot, skill.name)).filter(existsSync)
  if (existing.length > 0 && !force) {
    fail(`Already exists:\n${existing.join('\n')}\nUse --force only if you want to replace it.`, 1)
  }

  mkdirSync(destinationRoot, { recursive: true })
  const installed = []
  for (const skill of skills) {
    const destination = join(destinationRoot, skill.name)
    if (existsSync(destination)) {
      rmSync(destination, { recursive: true, force: true })
    }
    cpSync(skill.source, destination, { recursive: true, errorOnExist: true, force: false })
    console.log(`Installed ${pluginName}/${skill.name} -> ${destination}`)
    installed.push({ name: skill.name, destination })
  }
  return installed
}

/** 卸载用：移除该插件装到目标目录的 skill 副本，返回被删除的路径。 */
export function removeSkills({ root, pluginName, target, scope = 'user', project } = {}) {
  const destinationRoot = skillDestination({ target, scope, project })
  const removed = []
  for (const skill of listPluginSkills(root, pluginName)) {
    const destination = join(destinationRoot, skill.name)
    if (existsSync(destination)) {
      rmSync(destination, { recursive: true, force: true })
      removed.push(destination)
    }
  }
  return removed
}

/**
 * scripts/install-skills.mjs 的兼容入口：参数、输出与退出码保持原行为。
 * 仅接受最初的七个目标，不暴露 zcode/cursor/gemini。
 */
const LEGACY_TARGETS = new Set(['agents', 'claude', 'copilot', 'cline', 'windsurf', 'roo', 'kilo'])
const LEGACY_USAGE =
  'Usage: node scripts/install-skills.mjs <plugin-name> [--target agents|claude|copilot|cline|windsurf|roo|kilo] [--scope user|project] [--project <path>] [--force]'

export function runLegacyInstallSkills(argv, root) {
  const option = (name, fallback) => {
    const index = argv.indexOf(name)
    return index === -1 ? fallback : argv[index + 1]
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(LEGACY_USAGE)
    return
  }
  const pluginName = argv.find((arg) => !arg.startsWith('--'))
  try {
    if (!pluginName || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(pluginName)) {
      throw new CliError('Provide a plugin name from the plugins/ directory.', 2)
    }
    const target = option('--target', 'agents')
    const scope = option('--scope', 'user')
    if (!LEGACY_TARGETS.has(target) || !['user', 'project'].includes(scope)) {
      throw new CliError('Use --target agents|claude|copilot|cline|windsurf|roo|kilo and --scope user|project.', 2)
    }
    installSkills({
      root,
      pluginName,
      target,
      scope,
      project: option('--project'),
      force: argv.includes('--force'),
    })
    console.log('Reload or restart the target agent to discover the skill.')
  } catch (error) {
    if (error instanceof CliError) {
      console.error(error.message)
      process.exitCode = error.exitCode
    } else {
      throw error
    }
  }
}
