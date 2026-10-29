# ui-draw 🎨

给 coding agent 的**协作画板**：agent 通过 MCP 工具在画板上绘制完整界面和主要状态，人类可在浏览器里实时观看、共创批注；定稿后导出设计包，需要实现 UI 代码时先确认设计。

> 设计哲学：**提供画板使用方法，而非程序接口。** 每次工具调用 = 画板上的一个手势（选笔、落笔、拖动、抬笔），没有 `render(json)` 式的一次性渲染调用。绘画流程（草稿→完整界面→自查→按需批注修改）由配套 skill 教给 agent，而非服务端强制。

- **一个常驻服务**：用户级守护进程（默认 4680），所有 agent 共享，关掉会话也不退出
- **懒创建**：会话开始不建任何东西；agent 第一次真正调用画板工具时才注册项目、拉起服务
- **一个项目多块画布**：一个界面一块画布，`/p/<项目名>/<画布>/`；项目页 `/p/<项目名>/` 列出画布，根路径 `/` 是项目索引
- **存档在用户目录**：`~/.ui-draw/projects/<项目名>/boards/<画布>.json`，自动保存、自动恢复
- **26 个手势式工具** + 1 个 skill，开箱即用

---

## 安装

### 方式一：从原生插件市场安装（推荐）

```bash
git clone https://github.com/pykelysia/pyke-plugins.git
```

按使用的 agent 选择其原生市场入口：ZCode 选择仓库根目录；Claude Code 在仓库根目录执行 `claude plugin marketplace add .` 和 `claude plugin install ui-draw@pyke-plugins`；Codex 执行 `codex plugin marketplace add .` 和 `codex plugin add ui-draw@pyke-plugins`。仓库根目录包含各自的市场清单，插件文件位于 `plugins/ui-draw/`。也可用 `pykelysia/pyke-plugins` 代替本地目录。

> 插件会被复制到 agent 的插件缓存目录，其中不含 `node_modules`。**首次启动 MCP 进程时**，入口脚本 `scripts/run.mjs` 会自动执行一次 `npm install --omit=dev`（`dist/` 已随仓库提交，无需构建）。想提前装好，进入 `plugins/ui-draw/` 执行 `npm install`；只安装插件使用的话不必先装。
>
> 如果之前手动配过 ui-draw 的 MCP，二者选一即可（用户级配置优先于插件），避免重复。

### 方式二：一键脚本（不使用插件市场）

```bash
git clone https://github.com/pykelysia/pyke-plugins.git
cd ui-draw/plugins/ui-draw
node scripts/install.mjs
```

从仓库根目录也可以运行 `npm --prefix plugins/ui-draw run install:user`。脚本会：安装依赖并构建 → 写 `~/.zcode/cli/config.json` 的 `mcp.servers.ui-draw` → 把 skill 复制到 `~/.agents/skills/ui-draw` 并在 ZCode 配置中启用 → 拉起常驻守护进程。写完会提示你新开会话。

可加 `--no-config` / `--no-skill` / `--no-daemon` 跳过其中某一步。

### 方式三：其他支持 Agent Skills / MCP 的 agent

从仓库根目录运行以下命令构建插件，再将 skill 安装到 agent 支持的路径，并按其 MCP 格式配置 `plugins/ui-draw/scripts/run.mjs`。Codex、Cursor、Gemini CLI、OpenCode、Roo Code、Kilo Code 等可使用通用安装器；Cline 和 Windsurf/Cascade 用 `--target cline` 或 `--target windsurf`：

```bash
npm --prefix plugins/ui-draw install
npm --prefix plugins/ui-draw run build
node scripts/install-skills.mjs ui-draw --target agents
```

此安装器负责复制 skill，不写 MCP 配置。各 agent 的市场、skill 路径与 MCP 配置说明见仓库根目录 [docs/agent-compatibility.md](../../docs/agent-compatibility.md)。插件从自身目录启动时，首次调用 `list_boards`、`setup_board` 或 `inspect_board` 要传 `project_dir=当前项目绝对目录`，以便多项目画布隔离。

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

### 1. 一个项目多块画布 + 自动持久化

一个界面一块画布：`setup_board` 每次支起一块**新的**画布（旧的原样保留，可带 `title` 命名如「登录页」），`switch_board` / `list_boards` 在画布间切换，`clear scope=board` 才会清空当前画布。改动自动落盘到 `~/.ui-draw/projects/<项目名>/boards/<画布>.json`，下次任何 agent 进这个项目都自动落在最近更新的画布上接着画。旧版本的单 `board.json` 存档会自动迁移为第一块画布。

### 2. 批注是正式沟通通道

人类在浏览器用「📝 批注」工具**框选区域 + 写一句说明**，立即成为画板上的编号批注（① ② ③…）：

- 半透明色块 + 编号徽标 + 框下说明条，人和 agent 截图都看得见
- agent 用 `list_annotations` / `inspect_board` 读取，`resolve_annotation` 标记已解决
- agent 也能用 `add_annotation` 圈区域反问人类
- 批注层不挡住设计元素：只有边框、编号徽标、说明条可点中
- 人的复制出口：「复制引用」得到带坐标的文字引用；「复制选区图」（Ctrl+Shift+C）把选区裁剪成 PNG 进剪贴板，都可直接粘贴到对话框

### 3. 画布可缩放平移，多画布随时切换

滚轮以鼠标位置为锚点缩放（10%–600%）；空格 + 左键拖 / 中键拖平移；`Ctrl+0` 适应窗口、`Ctrl+±` 缩放；右下角有 `−` `100%` `＋` `适应`。顶部有画布切换器，项目里有多块画布时一键跳转。

## 一个常驻服务，所有 agent 共享

- **常驻守护进程** `dist/daemon.js`：一个用户一份，默认端口 4680（被占用自动顺延），启动后一直活着
- **懒创建**：会话开始不注册项目、不建画布；agent 第一次调用画板工具时才拉起服务并注册项目（没用画板的对话不留痕迹）
- **自动拉起**：任何 agent 第一次调用工具时，MCP 侧会复用已有实例，没有就用锁文件协调拉起 detached 进程；多个 agent 同时启动也只有一个服务
- **按项目区分、项目内按画布区分**：每块画布独立内容、独立撤销历史、独立批注；同项目多会话默认落在最近更新的画布
- **数据在用户目录**：

```
~/.ui-draw/
├── runtime.json              # 守护进程端口与 pid
├── index.json                # 项目注册表
└── projects/<项目名>/
    ├── boards.json           # 画布索引（轻量摘要）
    └── boards/
        ├── 登录页.json        # 每块画布一个文件（300ms 防抖 + 原子写）
        └── 设置页.json
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
| 画布 | `setup_board` | 支起一块**新的**画布（旧画布保留，可带 title 命名）；不传 title 自动编号 |
| | `resize_board` | 无损扩大当前画布，可撤销；长页面保持宽度并增加高度 |
| | `switch_board` | 切换到本项目的另一块画布（按 id 或标题） |
| | `list_boards` | 列出项目所有画布（尺寸/图元数/更新时间，标注当前） |
| | `show_board` | 把当前画布呈现在人类眼前（优先应用内浏览器，失败回落系统浏览器） |
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
| 存 | `save_board` / `load_board` | 另存快照 / 从快照恢复进当前画布（日常自动存档） |
| | `finalize_design` | 定稿导出设计包到项目 `design/<画布标题>/`（一块画布一份，互不覆盖） |

画布宽度支持 200–4096px，高度支持 200–16384px，宽高乘积不超过 33,554,432 像素。新建时可自定义尺寸；`resize_board` 可以保留内容扩展宽高，不支持缩小。浏览器为控制内存会对大画布降采样，放大时可能变模糊。

设计包：`design.png`（优先 2 倍，大画布按内存预算自动降低倍率，不含批注）、`design.svg`（矢量，不含批注）、`board.json`（可恢复）、`DESIGN.md`（图元精确坐标、文案清单、用色、过程批注）。

## 人类端（浏览器画板页）

对称完整编辑器：选择/铅笔/直线/矩形/椭圆/箭头/文字/橡皮/批注，笔色粗细虚实与填充，图层面板，框选与拖动，Delete 删除，Ctrl+Z/Y 撤销重做，Ctrl+V 粘贴图片，滚轮缩放与空格拖动平移，顶部画布切换器。agent 的每一笔带"逐笔动画"实时呈现，顶部显示项目名与当前画布。

## 架构

```
┌─────────────┐  stdio (MCP)   ┌──────────────────────────────┐
│ agent A     │◄──────────────►│ MCP 代理（scripts/run.mjs）    │
└─────────────┘                │  → dist/index.js（26 个工具）   │
                               └──────────────┬───────────────┘
┌─────────────┐  stdio (MCP)                  │ HTTP/WS 127.0.0.1:4680
│ agent B     │◄──────────────►┄┄┄┄┄┄┄┄┄┄┄┄┄┤
└─────────────┘                               ▼
                               ┌──────────────────────────────┐
┌─────────────┐  HTTP/WS       │ 常驻守护进程（dist/daemon.js）  │
│ 人类浏览器    │◄──────────────►│  项目A：登录页│设置页│ 项目B… │
│ /p/<项目>/<画布>/              │  各自独立撤销历史              │
└─────────────┘                │  无头渲染（@napi-rs/canvas）   │
                               │  ~/.ui-draw/projects/<项目>/  │
                               └──────────────────────────────┘
```

- **单一渲染源**：`src/board/render.ts` 一份渲染代码，浏览器画布与无头截图共用（构建时复制到 `web/shared/`）
- **单一状态源**：状态、撤销历史、批注都在守护进程里；MCP 只是代理，人机操作进同一条历史
- **按项目隔离、项目内按画布隔离**；同项目多 agent/会话共享，默认落在最近更新的画布

## 插件目录结构

```
plugins/ui-draw/                  ← 可单独安装的插件目录
├── plugin.json                   ← 可移植 Agent Plugins 清单
├── mcp.json                      ← 可移植 MCP 声明
├── .zcode-plugin/plugin.json     ← ZCode 插件清单
├── .claude-plugin/
│   └── plugin.json               ← Claude Code 插件清单
├── .codex-plugin/plugin.json     ← Codex 插件清单
├── .mcp.json                     ← Claude Code / ZCode MCP 启动入口
├── skills/ui-draw/SKILL.md       ← 教 agent「人类怎么用画板」
├── scripts/
│   ├── run.mjs                   ← 插件入口：补齐运行时依赖后启动 MCP
│   ├── install.mjs               ← 一键手动安装（写 MCP 配置 + 装 skill + 起服务）
│   ├── copy-shared.mjs           ← 构建时把渲染模块复制给浏览器端
│   └── stop-daemon.mjs           ← 停止常驻守护进程
├── src/                          ← TypeScript 源码
│   ├── index.ts                  ← MCP 代理入口
│   ├── daemon.ts                 ← 常驻守护进程入口
│   ├── hub/                      ← 多项目多画布服务、项目注册、客户端、路径
│   ├── board/                    ← 状态、Op、撤销、渲染、描述
│   ├── render/                   ← 无头 PNG / SVG
│   └── mcp/tools.ts              ← 26 个工具定义
├── web/                          ← 人类端画板页（原生 canvas，无框架）
├── dist/                         ← 构建产物（随仓库提交，插件安装即可用）
├── tests/                        ← 单测 / 冒烟 / 端到端 / 联调服务
└── examples/                     ← 会话示例
```

`dist/` 与 `web/shared/` 是构建产物，但**随仓库提交**：插件被安装到缓存目录后没有构建环境，直接跑 `dist` 最省事。

市场清单位于仓库根目录，分别适配 ZCode、Claude Code 与 Codex；一个插件目录可以承载一个或多个 skill，也可以附带 MCP server。

## 开发

```bash
cd plugins/ui-draw
npm install
npm run build        # tsc + 复制共享渲染模块到 web/shared/
npm test             # 单测（状态/历史/批注/项目注册/端口顺延/多画布/存档迁移）
npm run smoke        # 冒烟：画登录页线框 → 渲染/SVG/存档往返/设计包
npm run test:e2e     # 端到端：懒创建、多画布隔离切换、多 agent 共享服务、重启恢复、按画布定稿
node tests/dev-board.mjs  # 临时多项目服务 + 两块示例画布（端口 4690），供浏览器联调
```

改动 `src/` 或 `web/` 后请 `npm run build` 并提交 `dist/`、`web/shared/`，否则插件安装到的版本还是旧代码。

## 常见问题

- **端口被占**：守护进程会自动顺延到 4681…4699，端口记录在 `~/.ui-draw/runtime.json`
- **项目名是 draft-xxxx**：说明 agent 的工作目录是 ZCode 的草稿工作区（没有 git/package.json）；用 `UI_DRAW_PROJECT_DIR` 可强制项目目录
- **项目里没有画布**：正常——画布只在 agent 调用 `setup_board` 后才存在；对 agent 说「先在画板上画线框」即可
- **想换画布**：画板页顶部有画布切换器；`http://127.0.0.1:4680/` 是项目索引 → 项目页列出所有画布
- **升级后行为没变**：守护进程会按版本号自动替换；仍不放心就 `npm run daemon:stop` 后重启会话
- **卸载**：插件方式在 **设置 → 插件** 停用/卸载；手动方式删掉 `~/.zcode/cli/config.json` 里的 `mcp.servers.ui-draw` 和对应的 `skills` 条目、删除 `~/.agents/skills/ui-draw`，再 `npm run daemon:stop`。画板数据在 `~/.ui-draw`，按需自行删除

## License

[MIT](LICENSE)
