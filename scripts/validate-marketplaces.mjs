#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const fail = (message) => {
  console.error(`Marketplace validation failed: ${message}`)
  process.exit(1)
}
const versionedEntries = (entries, sourceOf, requireVersion = true) => {
  if (!Array.isArray(entries)) fail('plugins must be an array')
  const result = new Map()
  for (const entry of entries) {
    if (!entry?.name || (requireVersion && !entry?.version)) fail('every plugin entry needs name and, where supported, version')
    if (result.has(entry.name)) fail(`duplicate plugin entry: ${entry.name}`)
    result.set(entry.name, { version: entry.version, source: sourceOf(entry) })
  }
  return result
}
const normalizeLocalPath = (value) => {
  if (typeof value !== 'string' || !value.startsWith('./')) fail(`expected a local ./ path, got ${String(value)}`)
  const absolute = resolve(root, value)
  const rel = relative(root, absolute)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail(`plugin source escapes marketplace: ${value}`)
  return rel.split(sep).join('/')
}
const manifests = [
  {
    path: join(root, 'marketplace.json'),
    getEntries: (json) => versionedEntries(json.plugins, (entry) => normalizeLocalPath(entry.source)),
  },
  {
    path: join(root, '.claude-plugin', 'marketplace.json'),
    getEntries: (json) => versionedEntries(json.plugins, (entry) => normalizeLocalPath(entry.source)),
  },
  {
    path: join(root, '.agents', 'plugins', 'marketplace.json'),
    getEntries: (json) => versionedEntries(json.plugins, (entry) => {
      if (entry.source?.source !== 'local') fail(`Codex marketplace entry ${entry.name} must use a local source`)
      return normalizeLocalPath(entry.source.path)
    }, false),
  },
]

const catalogs = manifests.map(({ path, getEntries }) => {
  if (!existsSync(path)) fail(`missing ${relative(root, path)}`)
  const json = readJson(path)
  return { path, entries: getEntries(json) }
})
for (const catalog of catalogs.slice(1)) {
  if (catalog.entries.size !== catalogs[0].entries.size) fail(`${relative(root, catalog.path)} has a different plugin count`)
  for (const [name, expected] of catalogs[0].entries) {
    const actual = catalog.entries.get(name)
    if (!actual || actual.source !== expected.source || (actual.version && actual.version !== expected.version)) {
      fail(`${relative(root, catalog.path)} has plugin names, versions, or paths out of sync`)
    }
  }
}

for (const [name, entry] of catalogs[0].entries) {
  const pluginDir = resolve(root, entry.source)
  const localPath = relative(root, pluginDir)
  if (!localPath.startsWith(`plugins${sep}`) || !existsSync(pluginDir)) fail(`${name} must live in an existing plugins/<name> directory`)
  const pluginManifests = [
    join(pluginDir, 'plugin.json'),
    join(pluginDir, '.zcode-plugin', 'plugin.json'),
    join(pluginDir, '.claude-plugin', 'plugin.json'),
    join(pluginDir, '.codex-plugin', 'plugin.json'),
  ]
  for (const path of pluginManifests) {
    if (!existsSync(path)) fail(`${name} is missing ${relative(pluginDir, path)}`)
    const manifest = readJson(path)
    if (manifest.name !== name || manifest.version !== entry.version) {
      fail(`${relative(pluginDir, path)} name/version must match its marketplace entry`)
    }
  }
}

const listedDirs = new Set([...catalogs[0].entries.values()].map((entry) => entry.source))
const pluginDirs = readdirSync(join(root, 'plugins'), { withFileTypes: true }).filter((entry) => entry.isDirectory())
for (const dir of pluginDirs) {
  if (!listedDirs.has(`plugins/${dir.name}`)) fail(`plugins/${dir.name} is not listed in all marketplaces`)
}

console.log(`Validated ${catalogs[0].entries.size} plugin(s) across ${catalogs.length} marketplace manifests.`)
