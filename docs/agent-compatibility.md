# Agent 接入说明

插件清单格式因 agent 而异；本仓库分别提供 ZCode、Claude Code、Codex 的原生市场目录。每个插件根目录的 `plugin.json` 遵循 Agent Plugins 规范，`skills/*/SKILL.md` 遵循 Agent Skills 规范；`ui-draw/mcp.json` 为支持该规范的客户端声明 stdio MCP server。

## 能力覆盖

| Agent | 插件市场 | Skill 位置 | MCP 接入 |
| --- | --- | --- | --- |
| ZCode | 原生市场 `marketplace.json` | 插件内 `skills/`，也可用 `~/.agents/skills/` | 插件内自动配置 |
| Claude Code | 原生 `.claude-plugin/marketplace.json` | 插件内 `skills/`，或 `~/.claude/skills/` | 插件内自动配置 |
| Codex | 原生 `.agents/plugins/marketplace.json` | 插件内 `skills/`，或 `~/.agents/skills/` | 插件内自动配置 |
| Cursor | 使用可移植 Agent Skills | `~/.agents/skills/` 或 `.agents/skills/` | Cursor MCP 设置 |
| Gemini CLI | 使用可移植 Agent Skills | `~/.agents/skills/` 或 `.agents/skills/` | `settings.json` 的 `mcpServers` |
| OpenCode | 使用可移植 Agent Skills | `~/.agents/skills/` 或 `.agents/skills/` | 稳定版 `mcp`；V2 `mcp.servers` |
| GitHub Copilot | 使用可移植 Agent Skills | `~/.agents/skills/`、`~/.copilot/skills/`、`.agents/skills/` 或 `.github/skills/` | `.mcp.json` 或 VS Code MCP 设置 |
| Cline | 使用可移植 Agent Skills | `~/.cline/skills/` 或 `.cline/skills/` | Cline MCP Servers 设置 |
| Roo Code | 使用可移植 Agent Skills | `~/.agents/skills/`、`~/.roo/skills/` 或对应项目目录 | `.roo/mcp.json` 或全局 MCP 设置 |
| Kilo Code | 使用可移植 Agent Skills | `~/.agents/skills/`、`~/.kilo/skills/` 或对应项目目录 | `kilo.json(c)` 的 `mcp` |
| Windsurf / Devin Desktop Cascade | 使用可移植 Agent Skills | `~/.codeium/windsurf/skills/` 或 `.devin/skills/` | Cascade 的 `mcp_config.json` |

这些 agent 支持 Agent Skills 标准，但插件商店、skill 安装位置和 MCP 配置仍由各 agent 决定。支持 skill 不代表会自动安装或连接 `ui-draw` MCP。表中“可移植”表示复用本仓库的 skill 内容，不表示宿主会识别本仓库的市场清单。Windsurf 一行指 Devin Desktop 的 Cascade；Devin Local 的配置流程不同。

**项目识别：** 有些插件宿主从插件目录启动 MCP，`process.cwd()` 因此不是用户项目。使用画板时，首次调用 `list_boards`（或直接 `setup_board`、`inspect_board`）请传 `project_dir`，值为当前用户项目的绝对目录；随后该 MCP 会话绑定该项目。也可以在 MCP 配置中设置固定的 `UI_DRAW_PROJECT_DIR`。画板的默认快照、设计包和工具中传入的相对文件路径都会以该项目为基准。

## 安装可移植 skill

默认写入 `~/.agents/skills`，适用于 Codex、Cursor、Gemini CLI、OpenCode、Roo Code、Kilo Code、ZCode 和支持该目录的 Copilot harness：

```bash
node scripts/install-skills.mjs ui-draw --target agents
```

Claude Code 的个人目录：

```bash
node scripts/install-skills.mjs ui-draw --target claude
```

GitHub Copilot 可选择个人或项目目录：

```bash
node scripts/install-skills.mjs ui-draw --target copilot
node scripts/install-skills.mjs ui-draw --target copilot --scope project --project /path/to/repo
```

Cline 与 Windsurf/Cascade 使用各自的 skill 目录：

```bash
node scripts/install-skills.mjs ui-draw --target cline
node scripts/install-skills.mjs ui-draw --target windsurf
```

Roo Code 和 Kilo Code 可沿用默认的 `agents` 目标，也可用 `--target roo`、`--target kilo` 安装到专属目录。所有目标都支持 `--scope project --project <项目目录>`。

安装器只复制 skill 文件夹，不覆盖现有文件；确需替换时显式传 `--force`。完成后按目标 agent 的方式刷新或重启。

## 为其他 agent 连接 ui-draw MCP

服务入口是插件目录下的 `scripts/run.mjs`。首次运行会补齐运行时依赖。把下列 `<plugin-root>` 换成 `plugins/ui-draw` 的绝对路径。

### Cursor

在 `~/.cursor/mcp.json`（或项目的 `.cursor/mcp.json`）里合并：

```json
{
  "mcpServers": {
    "ui-draw": {
      "command": "node",
      "args": ["<plugin-root>/scripts/run.mjs"]
    }
  }
}
```

### Gemini CLI

在 Gemini CLI 的 `settings.json` 的 `mcpServers` 下添加：

```json
{
  "mcpServers": {
    "ui-draw": {
      "command": "node",
      "args": ["<plugin-root>/scripts/run.mjs"]
    }
  }
}
```

### OpenCode 稳定版

在 `opencode.json` 的 `mcp` 下直接添加服务名：

```json
{
  "mcp": {
    "ui-draw": {
      "type": "local",
      "command": ["node", "<plugin-root>/scripts/run.mjs"]
    }
  }
}
```

OpenCode V2 改为 `mcp.servers.ui-draw`，其余服务内容相同。

### GitHub Copilot

在工作区根目录 `.mcp.json` 的 `mcpServers` 下添加：

```json
{
  "mcpServers": {
    "ui-draw": {
      "command": "node",
      "args": ["<plugin-root>/scripts/run.mjs"]
    }
  }
}
```

### Cline、Roo Code、Windsurf/Cascade

这三者的本地 stdio 服务都接受 `mcpServers`、`command` 和 `args`。将上方 Cursor 的 `ui-draw` JSON 条目分别合并到：

- Cline：在 MCP Servers 面板打开配置文件；CLI 的用户配置是 `~/.cline/data/settings/cline_mcp_settings.json`。
- Roo Code：项目目录 `.roo/mcp.json`，或在 MCP 设置面板打开全局配置。
- Windsurf/Cascade：在 Cascade 的 MCPs 面板打开 `mcp_config.json`。这适用于 Cascade，不适用于 Devin Local。

### Kilo Code

在 `kilo.json` 或 `kilo.jsonc` 的 `mcp` 下直接添加服务名；本地服务使用 `type: "local"` 和命令数组，格式与上面的 OpenCode 稳定版示例相同。

每个目标配置文件都可能已有其他 server；只合并 `ui-draw` 这一项，保留其余配置。MCP 工具连上后，skill 才能按说明使用画板。

## 官方格式参考

- [ZCode 插件与市场](https://zcode.z.ai/cn/docs/plugin)
- [Agent Plugins 规范](https://agent-plugins.org/specification)
- [Claude Code 插件市场](https://code.claude.com/docs/en/plugin-marketplaces)
- [Codex 插件与本地市场](https://developers.openai.com/plugins/build/plugins)
- [Agent Skills in Cursor](https://cursor.com/docs/skills)
- [Gemini CLI Agent Skills](https://geminicli.com/docs/cli/skills/)
- [OpenCode Agent Skills](https://opencode.ai/docs/skills)
- [OpenCode 稳定版 MCP](https://opencode.ai/docs/mcp-servers/)、[OpenCode V2 MCP](https://dev.opencode.ai/v2/docs/mcp-servers/)
- [VS Code Agent Skills](https://code.visualstudio.com/docs/agent-customization/agent-skills)
- [VS Code MCP 配置](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
- [Cline Skills](https://github.com/cline/cline/blob/main/docs/customization/skills.mdx)、[Cline MCP](https://docs.cline.bot/mcp/mcp-overview)
- [Roo Code Skills](https://roocodeinc.github.io/Roo-Code/features/skills/)、[Roo Code MCP](https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo/)
- [Kilo Code Skills](https://kilo.ai/docs/customize/skills)、[Kilo Code MCP](https://kilo.ai/docs/automate/mcp/using-in-kilo-code)
- [Windsurf / Devin Desktop Cascade Skills](https://docs.devin.ai/desktop/cascade/skills)、[Cascade MCP](https://docs.devin.ai/desktop/cascade/mcp)
