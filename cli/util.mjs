import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 包根目录：npm 包与仓库同构（bin/、cli/、plugins/、marketplace.json）。 */
export const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))

export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

export function fail(message, exitCode = 1) {
  throw new CliError(message, exitCode)
}

/** 读 JSON；文件不存在返回 undefined，空文件返回 {}，损坏时报清晰错误。 */
export function readJsonIfExists(file) {
  if (!existsSync(file)) return undefined
  const raw = readFileSync(file, 'utf-8')
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new CliError(`Cannot parse ${file}: ${error.message}\n修复或移除该文件后重试。`, 1)
  }
}

/** 覆盖写 JSON 前先落一份 .bak-<ts> 备份；统一 2 空格缩进与结尾换行。 */
export function writeJsonWithBackup(file, value) {
  if (existsSync(file)) copyFileSync(file, `${file}.bak-${Date.now()}`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}
