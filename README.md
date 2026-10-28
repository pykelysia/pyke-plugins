# ui-draw 🎨

给 coding agent 的**协作画板**：agent 通过 MCP 工具像人类设计师一样在画板上画 UI 线框，人类在浏览器里实时观看、直接上手共创批注，定稿后导出设计包，agent 依此实施 UI 代码。

> 设计哲学：**提供画板使用方法，而非程序接口。** 每次工具调用 = 画板上的一个手势（选笔、落笔、拖动、抬笔），没有 `render(json)` 式的一次性渲染调用。绘画流程（草稿→正稿→批注→修改）由配套 skill 教给 agent，而非服务端强制。

- **一个常驻服务**：用户级守护进程（默认 4680），所有 agent 共享，关掉会话也不退出
- **按项目分画板**：`http://127.0.0.1:4680/p/<项目名>/`，根路径 `/` 是项目索引
- **存档在用户目录**：`~/.ui-draw/projects/<项目名>/board.json`，自动保存、自动恢复
- **23 个手势式工具** + 1 个 skill，开箱即用

---

## 安装

### 方式一：作为 ZCode 插件（推荐）

```bash
git clone https://github.com/pykelysia/ui-draw.git
```

1. 打开 **设置 → 插件市场 → 添加 → 添加插件市场**
2. 粘贴（或选择）clone 下来的**仓库目录**（里面有 `.claude-plugin/marketplace.json`）
3. 到 **个人 → ui-draw-plugins → ui-draw**，点 **安装**
4. 新开一个任务即可使用

> 插件会被复制到 ZCode 的插件缓存目录，其中不含 `node_modules`。**首次调用工具时**，入口脚本 `scripts/run.mjs` 会自动执行一次 `npm install --omit=dev`（`dist/` 已随仓库提交，无需构建）。想提前装好就在仓库目录执行 `npm install`；只安装插件使用的话不必先装。
>
> 如果之前手动配过 ui-draw 的 MCP，二者选一即可（用户级配置优先于插件），避免重复。

### 方式二：一键脚本（不使用插件市场）

```bash
git clone https://github.com/pykelysia/ui-draw.git
cd ui-draw
node scripts/install.mjs
```

脚本会：安装依赖并构建 → 写 `~/.zcode/cli/config.json` 的 `mcp.servers.ui-draw` → 把 skill 复制到 `~/.agents/skills/ui-draw` 并在 ZCode 配置中启用 → 拉起常驻守护进程。写完会提示你新开会话。

可加 `--no-config` / `--no-skill` / `--no-daemon` 跳过其中某一步。

### 方式三：其他 agent（Claude Code / Cursor / 其他 MCP 客户端）

先 `npm install && npm run build`，然后加 MCP 配置：

```json
{
  "mcpServers": {
    "ui-draw": {
      "command": "node",
      "args": ["/absolute/path/to/ui-draw/dist/index.js"]
    }
  }
}
```

再把 `skills/ui-draw/SKILL.md` 复制到该 agent 的 skills 目录（如 `~/.agents/skills/ui-draw/SKILL.md`），或项目内 `.claude/skills/ui-draw/SKILL.md`。

---

## 用起来

对 agent 说：

> 帮我设计一个登录页，先在画板上画线框给我看，我框选批注后你再改，定稿后按设计实现页面。

它会支起画板、打开页面（优先在你的 agent 桌面内置浏览器里，失败回落到系统浏览器），从草稿画到正稿。你想改哪里，就用画板上的「📝 批注」工具框选一块区域、写一句话；写完在对话里说「按批注改吧」，agent 读取批注后动手。

```
agent 支起画板 ──► 草稿层起稿 ──► 看一眼自查 ──► 线稿层正稿
     │                                                  │
     ▼                                                  ▼
人类浏览器实时观看/框选批注 ◄── WS 双向同步 ── agent 按需读取批注（list_annotations）
                                                        │
                                                        ▼
                                          finalize_design 定稿
                                                        │
                                        design/ 设计包（PNG/SVG/JSON/DESIGN.md）
                                                        │
                                                        ▼
                                              agent 按设计实施 UI 代码
```

## 三件关键能力

### 1. 自动持久化（关掉再开，成果还在）

改动自动落盘到 `~/.ui-draw/projects/<项目名>/board.json`，下次任何 agent 进这个项目都自动恢复。画板非空时 `setup_board` 会拒绝执行（防误清空），要重来需 `force: true`。旧版本存在 `<项目>/.ui-draw/board.json` 的存档会自动迁移。

### 2. 批注是正式沟通通道

人类在浏览器用「📝 批注」工具**框选区域 + 写一句说明**，立即成为画板上的编号批注（① ② ③…）：

- 半透明色块 + 编号徽标 + 框下说明条，人和 agent 截图都看得见
- agent 用 `list_annotations` / `inspect_board` 读取，`resolve_annotation` 标记已解决
- agent 也能用 `add_annotation` 圈区域反问人类
- 批注层不挡住设计元素：只有边框、编号徽标、说明条可点中
- 人的复制出口：「复制引用」得到带坐标的文字引用；「复制选区图」（Ctrl+Shift+C）把选区裁剪成 PNG 进剪贴板，都可直接粘贴到对话框

### 3. 画布可缩放平移

滚轮以鼠标位置为锚点缩放（10%–600%）；空格 + 左键拖 / 中键拖平移；`Ctrl+0` 适应窗口、`Ctrl+±` 缩放；右下角有 `−` `100%` `＋` `适应`。

## 一个常驻服务，所有 agent 共享

- **常驻守护进程** `dist/daemon.js`：一个用户一份，默认端口 4680（被占用自动顺延），启动后一直活着
- **自动拉起**：任何 agent 第一次调用工具时，MCP 侧会复用已有实例，没有就用锁文件协调拉起 detached 进程；多个 agent 同时启动也只有一个服务
- **按项目名区分**：每个项目独立画板、独立撤销历史、独立批注；同项目多会话共享同一块板
- **数据在用户目录**：

```
~/.ui-draw/
├── runtime.json              # 守护进程端口与 pid
├── index.json                # 项目注册表
└── projects/<项目名>/
    └── board.json            # 自动保存（300ms 防抖 + 原子写）
```

| 环境变量 | 作用 |
| --- | --- |
| `UI_DRAW_HOME` | 数据根目录（默认 `~/.ui-draw`） |
| `UI_DRAW_PROJECT_DIR` | 强制指定项目目录（默认从工作目录向上找 git/package.json 根） |
| `UI_DRAW_OPENER` | `show_board` 默认打开方式：`desktop` / `system` / `none` / `auto` |

运维：`npm run daemon` 手动起服务，`npm run daemon:stop` 停掉。

## MCP 工具一览（每个 = 一个画板手势）

| 分组 | 工具 | 说明 |
| --- | --- | --- |
| 画板 | `setup_board` | 支起新板（非空时需 force 才会清空） |
| | `show_board` | 把画板呈现在人类眼前（优先应用内浏览器，失败回落系统浏览器） |
| 画 | `draw_stroke` | 徒手一笔（点序列） |
| | `draw_line` / `draw_rect` / `draw_ellipse` / `draw_arrow` | 工具画线/矩形/椭圆/箭头 |
| | `write_text` | 写文字（唯一正确的写字方式） |
| | `paste_reference` | 贴本地图片当参考（如现有 UI 截图） |
| 改 | `erase` | 橡皮划过删图元（当前层） |
| | `move_elements` / `delete_elements` | 挪动 / 精确删除 |
| | `undo_redo` / `clear` | 反悔 / 清空（层或整板） |
| 批注 | `add_annotation` | agent 圈区域提问/提建议（编号自动） |
| | `list_annotations` | 读待处理/已解决批注（含区域坐标） |
| | `resolve_annotation` | 按编号/id 标记已解决 |
| 图层 | `layers` | list/add/switch/rename/show/hide/remove |
| 看 | `look_at_board` | 截图看画板（可指定图层/区域/放大倍率） |
| | `inspect_board` | 图元清单 + 待处理批注 + 项目/存档信息 |
| 存 | `save_board` / `load_board` | 另存快照 / 从快照恢复（日常自动存档） |
| | `finalize_design` | 定稿导出设计包到项目 `design/` |

设计包：`design.png`（2 倍图，不含批注）、`design.svg`（矢量，不含批注）、`board.json`（可恢复）、`DESIGN.md`（图元精确坐标、文案清单、用色、过程批注）。

## 人类端（浏览器画板页）

对称完整编辑器：选择/铅笔/直线/矩形/椭圆/箭头/文字/橡皮/批注，笔色粗细虚实与填充，图层面板，框选与拖动，Delete 删除，Ctrl+Z/Y 撤销重做，Ctrl+V 粘贴图片，滚轮缩放与空格拖动平移。agent 的每一笔带"逐笔动画"实时呈现，顶部显示当前项目名。

## 架构

```
┌─────────────┐  stdio (MCP)   ┌──────────────────────────────┐
│ agent A     │◄──────────────►│ MCP 代理（scripts/run.mjs）    │
└─────────────┘                │  → dist/index.js（23 个工具）   │
                               └──────────────┬───────────────┘
┌─────────────┐  stdio (MCP)                  │ HTTP/WS 127.0.0.1:4680
│ agent B     │◄──────────────►┄┄┄┄┄┄┄┄┄┄┄┄┄┤
└─────────────┘                               ▼
                               ┌──────────────────────────────┐
┌─────────────┐  HTTP/WS       │ 常驻守护进程（dist/daemon.js）  │
│ 人类浏览器    │◄──────────────►│  项目A 画板 │ 项目B 画板 │ …  │
│ /p/<项目>/   │                │  撤销历史   │ 撤销历史        │
└─────────────┘                │  无头渲染（@napi-rs/canvas）   │
                               │  ~/.ui-draw/projects/<项目>/  │
                               └──────────────────────────────┘
```

- **单一渲染源**：`src/board/render.ts` 一份渲染代码，浏览器画布与无头截图共用（构建时复制到 `web/shared/`）
- **单一状态源**：状态、撤销历史、批注都在守护进程里；MCP 只是代理，人机操作进同一条历史
- **按项目隔离**；同项目多 agent/会话共享

## 仓库结构（插件形态）

```
ui-draw/                          ← 仓库根 = 插件根 = 市场根
├── .zcode-plugin/plugin.json     ← ZCode 插件清单（skills + mcpServers）
├── .claude-plugin/
│   ├── plugin.json               ← 兼容 Claude Code 的插件清单
│   └── marketplace.json          ← 单插件市场清单（source: "./"）
├── .mcp.json                     ← MCP 启动入口：node ${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs
├── skills/ui-draw/SKILL.md       ← 教 agent「人类怎么用画板」
├── scripts/
│   ├── run.mjs                   ← 插件入口：补齐运行时依赖后启动 MCP
│   ├── install.mjs               ← 一键手动安装（写 MCP 配置 + 装 skill + 起服务）
│   ├── copy-shared.mjs           ← 构建时把渲染模块复制给浏览器端
│   └── stop-daemon.mjs           ← 停止常驻守护进程
├── src/                          ← TypeScript 源码
│   ├── index.ts                  ← MCP 代理入口
│   ├── daemon.ts                 ← 常驻守护进程入口
│   ├── hub/                      ← 多项目服务、项目注册、客户端、路径
│   ├── board/                    ← 状态、Op、撤销、渲染、描述
│   ├── render/                   ← 无头 PNG / SVG
│   └── mcp/tools.ts              ← 23 个工具定义
├── web/                          ← 人类端画板页（原生 canvas，无框架）
├── dist/                         ← 构建产物（随仓库提交，插件安装即可用）
├── tests/                        ← 单测 / 冒烟 / 端到端 / 联调服务
└── examples/                     ← 会话示例
```

`dist/` 与 `web/shared/` 是构建产物，但**随仓库提交**：插件被安装到缓存目录后没有构建环境，直接跑 `dist` 最省事。

## 开发

```bash
npm install
npm run build        # tsc + 复制共享渲染模块到 web/shared/
npm test             # 29 个单测（状态/历史/批注/项目注册/端口顺延/存档迁移）
npm run smoke        # 冒烟：画登录页线框 → 渲染/SVG/存档往返/设计包
npm run test:e2e     # 端到端：多 agent 共享服务、项目隔离、重启恢复、定稿
node tests/dev-board.mjs  # 临时多项目服务 + 示例画板（端口 4690），供浏览器联调
```

改动 `src/` 或 `web/` 后请 `npm run build` 并提交 `dist/`、`web/shared/`，否则插件安装到的版本还是旧代码。

## 常见问题

- **端口被占**：守护进程会自动顺延到 4681…4699，端口记录在 `~/.ui-draw/runtime.json`
- **项目名是 draft-xxxx**：说明 agent 的工作目录是 ZCode 的草稿工作区（没有 git/package.json）；用 `UI_DRAW_PROJECT_DIR` 可强制项目目录
- **想换项目画板**：`http://127.0.0.1:4680/` 是项目索引，点进去即可
- **升级后行为没变**：守护进程会按版本号自动替换；仍不放心就 `npm run daemon:stop` 后重启会话
- **卸载**：插件方式在 **设置 → 插件** 停用/卸载；手动方式删掉 `~/.zcode/cli/config.json` 里的 `mcp.servers.ui-draw` 和对应的 `skills` 条目、删除 `~/.agents/skills/ui-draw`，再 `npm run daemon:stop`。画板数据在 `~/.ui-draw`，按需自行删除

## License

[MIT](LICENSE)
