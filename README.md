# pyke-plugins

一个面向多种 coding agent 的插件市场。每个插件独立放在 `plugins/<plugin-name>/`，以 Agent Plugins 的 `plugin.json` 和 Agent Skills 的 `SKILL.md` 作为可移植内容；市场根目录按宿主格式提供目录清单。

## 当前插件

| 插件 | 能力 | 目录 |
| --- | --- | --- |
| [ui-draw](plugins/ui-draw/README.md) | MCP 协作画板与 UI 设计 skill | `plugins/ui-draw/` |

## 接入方式

仓库提供三种原生插件目录：ZCode 的 `marketplace.json`、Claude Code 的 `.claude-plugin/marketplace.json`、Codex 的 `.agents/plugins/marketplace.json`。对应插件目录也带有 ZCode、Claude Code 和 Codex 清单。添加新插件时，模板和校验步骤见下文。

其他支持 Agent Skills 的 agent 可以直接安装 skill 文件夹。默认目标 `~/.agents/skills` 可被 Codex、Cursor、Gemini CLI、OpenCode、Roo Code、Kilo Code 等 agent 使用；安装器还提供 Claude Code、GitHub Copilot、Cline 和 Windsurf/Cascade 等专属目录：

```bash
node scripts/install-skills.mjs ui-draw --target agents
```

`ui-draw` 还需要连接 MCP 服务才能调用画板工具。按 agent 查看 MCP 接入说明：[docs/agent-compatibility.md](docs/agent-compatibility.md)。复制 skill 不会改动 agent 的 MCP 配置。

### 原生插件市场安装

- **ZCode**：在「设置 → 插件市场 → 添加」中添加本仓库目录或 Git 仓库。
- **Claude Code**：在仓库根目录执行 `claude plugin marketplace add .`，再执行 `claude plugin install ui-draw@pyke-plugins`。
- **Codex**：在仓库根目录执行 `codex plugin marketplace add .`，再执行 `codex plugin add ui-draw@pyke-plugins`。

也可将上述 `.` 换成 `pykelysia/pyke-plugins`，从公开仓库安装市场。

## 添加一个 skill 插件

1. 将 `templates/skill-only-plugin/` 复制到 `plugins/<plugin-name>/`。
2. 更新可移植的 `plugin.json` 和三份 `.zcode-plugin/plugin.json`、`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`，并在 `skills/<skill-name>/SKILL.md` 写好 skill 内容。
3. 在根目录 `marketplace.json`、`.claude-plugin/marketplace.json` 和 `.agents/plugins/marketplace.json` 各添加一个条目。插件名、版本和本地来源目录保持一致。
4. 执行 `node scripts/validate-marketplaces.mjs` 检查市场与插件清单是否同步。

skill-only 插件不需要 `src/`、`dist/`、MCP 配置或构建流程。需要 MCP 或其他资源时，只把它们加进对应插件目录。

## 结构

```text
.
├── marketplace.json                    # ZCode 市场
├── .claude-plugin/marketplace.json     # Claude Code 市场
├── .agents/plugins/marketplace.json   # Codex 市场
├── plugins/
│   └── ui-draw/                        # 可独立安装的插件
│       ├── plugin.json                 # 可移植 Agent Plugins 清单
│       ├── mcp.json                    # 可移植 MCP 声明
│       ├── .zcode-plugin/plugin.json
│       ├── .claude-plugin/plugin.json
│       ├── .codex-plugin/plugin.json
│       ├── skills/ui-draw/SKILL.md
│       ├── src/                        # MCP 服务源码
│       ├── dist/                       # 随插件发布的构建产物
│       └── web/                        # 画板页面
├── templates/skill-only-plugin/       # 新 skill 插件起步模板
├── scripts/
│   ├── install-skills.mjs              # 面向共享 Skills 目录的安装器
│   └── validate-marketplaces.mjs       # 三类市场清单一致性检查
└── docs/agent-compatibility.md         # 各 agent 的 skill 与 MCP 接入方式
```
