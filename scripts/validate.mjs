#!/usr/bin/env node
/** 仓库自检：插件清单、市场清单、skill 与 MCP 入口是否自洽 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
let failed = 0
const ok = (msg) => console.log(`✅ ${msg}`)
const bad = (msg) => {
  failed++
  console.error(`❌ ${msg}`)
}
const readJson = (p) => JSON.parse(readFileSync(p, 'utf-8'))

// 1. 插件清单
for (const manifestPath of ['.zcode-plugin/plugin.json', '.claude-plugin/plugin.json']) {
  const p = join(root, manifestPath)
  if (!existsSync(p)) {
    bad(`缺少 ${manifestPath}`)
    continue
  }
  let m
  try {
    m = readJson(p)
  } catch (err) {
    bad(`${manifestPath} 不是合法 JSON：${err.message}`)
    continue
  }
  if (m.name !== basename(root)) bad(`${manifestPath} 的 name「${m.name}」与目录名「${basename(root)}」不一致`)
  else ok(`${manifestPath}：name/version = ${m.name}@${m.version}`)
  if (!/^\d+\.\d+\.\d+/.test(m.version ?? '')) bad(`${manifestPath} 的 version 不是语义化版本`)

  const skills = typeof m.skills === 'string' ? resolve(root, m.skills) : null
  if (!skills || !statSync(skills).isDirectory()) {
    bad(`${manifestPath} 的 skills 目录不存在`)
  } else if (!existsSync(join(skills, m.name, 'SKILL.md'))) {
    bad(`skills/${m.name}/SKILL.md 不存在（目录名要与插件名一致）`)
  } else {
    ok(`skills/${m.name}/SKILL.md 存在`)
  }

  const mcpPath = typeof m.mcpServers === 'string' ? resolve(root, m.mcpServers) : null
  if (!mcpPath || !existsSync(mcpPath)) {
    bad(`${manifestPath} 的 mcpServers 指向的文件不存在`)
  } else {
    const cfg = readJson(mcpPath)
    const server = cfg.mcpServers?.['ui-draw']
    const entryArg = server?.args?.[0]?.replace('${CLAUDE_PLUGIN_ROOT}', root)
    if (!server || server.command !== 'node' || !entryArg || !existsSync(entryArg)) {
      bad(`.mcp.json 里 ui-draw 的启动入口无效`)
    } else {
      ok(`.mcp.json 启动入口有效：${entryArg.replace(root, '<仓库>')}`)
    }
  }
}

// 2. SKILL 前置元数据
const skillFile = join(root, 'skills', 'ui-draw', 'SKILL.md')
if (existsSync(skillFile)) {
  const text = readFileSync(skillFile, 'utf-8')
  if (!/^---[\s\S]*?\nname:\s*ui-draw[\s\S]*?\ndescription:\s*\S/.test(text)) {
    bad('SKILL.md 缺少 name/description 前置元数据')
  } else {
    ok('SKILL.md 前置元数据完整')
  }
}

// 3. 市场清单
const marketPath = join(root, '.claude-plugin', 'marketplace.json')
if (!existsSync(marketPath)) {
  bad('缺少 .claude-plugin/marketplace.json')
} else {
  const market = readJson(marketPath)
  if (!market.name) bad('marketplace 缺少 name')
  for (const entry of market.plugins ?? []) {
    // 规范：.claude-plugin/marketplace.json 的市场根是它的父目录
    const source = resolve(root, entry.source)
    if (!existsSync(join(source, '.zcode-plugin', 'plugin.json'))) {
      bad(`市场条目 ${entry.name} 的 source 未指向插件目录：${entry.source}`)
      continue
    }
    const meta = readJson(join(source, '.zcode-plugin', 'plugin.json'))
    if (entry.version !== meta.version) {
      bad(`市场条目 ${entry.name} 版本 ${entry.version} 与插件清单 ${meta.version} 不一致`)
    } else {
      ok(`市场「${market.name}」条目 ${entry.name}@${entry.version} → ${entry.source}`)
    }
  }
}

// 4. 构建产物（插件安装后直接使用）
for (const p of ['dist/index.js', 'dist/daemon.js', 'web/shared/render.js', 'web/index.html']) {
  if (!existsSync(join(root, p))) bad(`缺少构建产物 ${p}（先 npm run build）`)
  else ok(`${p} 存在`)
}

if (failed > 0) {
  console.error(`\n自检未通过：${failed} 项`)
  process.exit(1)
}
console.log('\n仓库自检通过。')
