#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dataDir } from '../dist/hub/paths.js'
import { readActive, readRelease, releaseRoot, selectRelease, writeJson } from '../dist/hub/lifecycle.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const files = ['dist', 'web', 'package.json', 'package-lock.json']
const log = (message) => process.stderr.write(`[ui-draw] ${message}\n`)

function buildId(dir) {
  const hash = createHash('sha256')
  hash.update(`${process.platform}/${process.arch}/${process.versions.modules}\n`)
  function add(path) {
    const contents = readFileSync(join(dir, path))
    hash.update(`${path}\0${contents.length}\0`).update(contents)
  }
  function scan(path) {
    for (const entry of readdirSync(join(dir, path), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const child = `${path}/${entry.name}`
      if (entry.isDirectory()) scan(child)
      else add(child)
    }
  }
  scan('dist')
  scan('web')
  add('package.json')
  add('package-lock.json')
  const { version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('插件版本号无效')
  return `${version}-${hash.digest('hex').slice(0, 24)}`
}

function prepareRelease() {
  const release = { build: buildId(root) }
  const target = releaseRoot(release)
  if (readRelease(target)?.build === release.build) return release

  mkdirSync(dirname(target), { recursive: true })
  const stage = mkdtempSync(join(dirname(target), '.stage-'))
  try {
    for (const path of files) cpSync(join(root, path), join(stage, path), { recursive: true })
    if (buildId(stage) !== release.build) throw new Error('插件文件在准备运行时期间发生变化')
    if (!existsSync(join(stage, 'web', 'index.html'))) throw new Error('插件包缺少画板页面')

    log('准备独立运行目录并安装运行时依赖…')
    const win = process.platform === 'win32'
    const install = spawnSync(win ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: stage, shell: win, stdio: ['ignore', 'ignore', 'inherit'], timeout: 10 * 60_000,
    })
    if (install.status !== 0) throw install.error ?? new Error('运行时依赖安装失败')
    const check = spawnSync(process.execPath, [join(stage, 'dist', 'daemon.js'), '--check'], {
      cwd: stage, stdio: ['ignore', 'ignore', 'inherit'], timeout: 30_000, windowsHide: true,
    })
    if (check.status !== 0) throw check.error ?? new Error('守护进程启动预检失败')

    writeJson(join(stage, 'release.json'), release)
    try {
      renameSync(stage, target)
    } catch (err) {
      // Another launcher may have published the same fully prepared build.
      if (readRelease(target)?.build !== release.build) throw err
    }
    return release
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

async function main() {
  const home = dataDir()
  const cwd = process.cwd()
  process.env.UI_DRAW_HOME = home
  process.env.UI_DRAW_ORIGINAL_CWD = cwd
  process.env.UI_DRAW_LAUNCH_ROOT = root
  if (process.env.UI_DRAW_PROJECT_DIR) process.env.UI_DRAW_PROJECT_DIR = resolve(process.env.UI_DRAW_PROJECT_DIR)
  mkdirSync(home, { recursive: true })
  process.chdir(home)

  let release
  try {
    release = await selectRelease(prepareRelease())
  } catch (err) {
    release = readActive()
    if (!release) throw err
    log(`更新失败，继续使用 ${release.build}：${err.message}`)
  }
  const deployed = releaseRoot(release)
  if (process.argv.includes('--daemon')) {
    const { ensureDaemon: start } = await import(pathToFileURL(join(deployed, 'dist/hub/lifecycle.js')).href)
    const rt = await start()
    log(`画板服务 http://127.0.0.1:${rt.port}/`)
    return
  }
  await import(pathToFileURL(join(deployed, 'dist/index.js')).href)
}

main().catch((err) => {
  log(`启动失败：${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
