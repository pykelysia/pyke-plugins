#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const pluginName = args.find((arg) => !arg.startsWith('--'))
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}

if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/install-skills.mjs <plugin-name> [--target agents|claude|copilot|cline|windsurf|roo|kilo] [--scope user|project] [--project <path>] [--force]')
  process.exit(0)
}

if (!pluginName || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(pluginName)) {
  console.error('Provide a plugin name from the plugins/ directory.')
  process.exit(2)
}

const target = option('--target', 'agents')
const scope = option('--scope', 'user')
const projectArg = option('--project')
const force = args.includes('--force')
const projectDirs = {
  agents: '.agents/skills',
  claude: '.claude/skills',
  copilot: '.github/skills',
  cline: '.cline/skills',
  windsurf: '.devin/skills',
  roo: '.roo/skills',
  kilo: '.kilo/skills',
}
const userDirs = {
  agents: join(homedir(), '.agents', 'skills'),
  claude: join(homedir(), '.claude', 'skills'),
  copilot: join(homedir(), '.copilot', 'skills'),
  cline: join(homedir(), '.cline', 'skills'),
  windsurf: join(homedir(), '.codeium', 'windsurf', 'skills'),
  roo: join(homedir(), '.roo', 'skills'),
  kilo: join(homedir(), '.kilo', 'skills'),
}

if (!Object.hasOwn(projectDirs, target) || !['user', 'project'].includes(scope)) {
  console.error('Use --target agents|claude|copilot|cline|windsurf|roo|kilo and --scope user|project.')
  process.exit(2)
}
if (scope === 'project' && !projectArg) {
  console.error('Project scope requires --project <absolute-or-relative-project-directory>.')
  process.exit(2)
}
if (scope === 'project' && (!existsSync(resolve(projectArg)) || !statSync(resolve(projectArg)).isDirectory())) {
  console.error(`Project directory does not exist: ${resolve(projectArg)}`)
  process.exit(2)
}

const pluginDir = join(root, 'plugins', pluginName)
const skillsDir = join(pluginDir, 'skills')
if (!existsSync(skillsDir)) {
  console.error(`No skills directory found for plugin: ${pluginName}`)
  process.exit(1)
}

const destinationRoot = scope === 'user'
  ? userDirs[target]
  : join(resolve(projectArg), projectDirs[target])
const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, 'SKILL.md')))
  .map((entry) => ({ name: entry.name, source: join(skillsDir, entry.name) }))

if (skillDirs.length === 0) {
  console.error(`No SKILL.md files found under ${skillsDir}`)
  process.exit(1)
}

const existing = skillDirs
  .map((skill) => join(destinationRoot, skill.name))
  .filter(existsSync)
if (existing.length > 0 && !force) {
  console.error(`Already exists:\n${existing.join('\n')}\nUse --force only if you want to replace it.`)
  process.exit(1)
}

mkdirSync(destinationRoot, { recursive: true })
for (const skill of skillDirs) {
  const destination = join(destinationRoot, skill.name)
  if (existsSync(destination)) {
    rmSync(destination, { recursive: true, force: true })
  }
  cpSync(skill.source, destination, { recursive: true, errorOnExist: true, force: false })
  console.log(`Installed ${pluginName}/${skill.name} -> ${destination}`)
}

console.log('Reload or restart the target agent to discover the skill.')
