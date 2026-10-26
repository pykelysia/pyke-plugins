import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

function isGitRoot(dir: string): boolean {
  const dotGit = join(dir, '.git')
  try {
    return existsSync(dotGit)
  } catch {
    return false
  }
}

function hasPackageJson(dir: string): boolean {
  try {
    const p = join(dir, 'package.json')
    return existsSync(p) && statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * 项目目录解析：优先最近的 git 根，其次最近的 package.json 所在目录，否则用当前目录。
 * 这样 agent 在子目录里工作时，仍然落在同一个项目画板上。
 */
export function resolveProjectDir(cwd: string): string {
  const start = resolve(cwd)
  let dir = start
  let pkgCandidate: string | null = null
  for (let i = 0; i < 6; i++) {
    if (isGitRoot(dir)) return dir
    if (!pkgCandidate && hasPackageJson(dir)) pkgCandidate = dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return pkgCandidate ?? start
}
