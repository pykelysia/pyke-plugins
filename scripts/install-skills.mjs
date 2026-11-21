#!/usr/bin/env node
// 兼容入口：等价于 npx pyke-plugins install <plugin> 的纯 skill 安装部分，
// 参数、输出与退出码保持原行为。
import { runLegacyInstallSkills } from '../cli/skills.mjs'
import { pkgRoot } from '../cli/util.mjs'

runLegacyInstallSkills(process.argv.slice(2), pkgRoot)
