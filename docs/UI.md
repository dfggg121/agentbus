# agentbus 本地配套客户端 (`ui`)

`agentbus ui` 提供零第三方运行时/前端依赖、无构建步骤、仅限本机 loopback 的 Web 配套客户端，采用固定顶栏与左右独立滚动双栏布局，包含四个页签：

1. **项目看板**：新建项目支持关联受控本机项目文件夹并默认直发所选主 Agent（默认当前可用/Antigravity）自动拆解；新增 **读取已有项目** 入口，可在受控目录浏览器中选择允许根目录内的已有文件夹，自动扫描现有文件生成带 `已有` / `部分实现` / `缺失` 状态的卡片（汇总与卡片术语统一、非纯颜色表达），并可交给主 Agent 复核；每张卡片支持 **任务环节分组**（`研发组 dev` / `调试组 debug`）与项目内唯一 **模块代号 (`code`)**，卡片数 ≤ 4 时按分组显示完整卡片，≥ 5 时自动切换为紧凑小方形卡片网格（只显示功能名与负责 Agent，点击某张后在看板顶部展开完整详情并将其余分组下推）；每张卡片直接展示带可见标签的 **负责 Agent**（默认提示“请选择负责 Agent”）与 **模型**（展示“沿用 Agent 默认模型 (实际解析值)”），修改即刻持久化并显示保存状态、**撤销** 与 **恢复默认** 入口；支持 **完成** 按钮创建幂等的 `to = project.main_agent` 完成归档任务（不可 dispatch 的 `hermes` 保持 `open` 并提示 `待主 Agent 处理`，引导将开发临时/中间文件归档到 `<workspace>/.agentbus/dev-materials/<module-code>/` 并复制而非删除总线信封）；选中项目后直接可见 **向主 Agent 提要求** 追加/拆分卡片与 **重生成** 已完成/已有部分；空状态、项目详情与新建/读取/添加卡片表单互斥展示，核心控件不隐藏。
2. **模块看板**：模块列表提供清晰的列头与响应式行内标签（`负责 Agent` / `负责模型` / `归属状态` / `操作`，状态列仅展示 `默认` / `已改`，操作列独立承载 `恢复默认` 按钮），每行直接提供内联选择与统一语义的 `默认 (实际解析值)`；勾选多模块后显示两字段批量表单（**批量设置负责 Agent** / **批量设置负责模型**）与 **应用到所选** 按钮，执行前实时展示影响范围预览，混合选择明确列出实际去重 Agent 与模型值（如 `混合/多个值 (gemini-3.8-flash、gpt-5-codex)`）并保留 `保持各自当前值` 语义不伪造单一模型；本地覆盖写入 `<root>/module-owners.json`（保留未知字段、备份、不改仓库 `src/ui/modules.json`）；右侧保留模块调度入口，支持 `direct` 与 `conductor` 两种发送方式。
3. **自动路由规则**：按类别/关键字/优先级配置本地自动分配规则（持久化到 `<root>/project-routing.json`，默认为空、不写入公开仓库与个人模型偏好），支持规则启停、排序、试算预览与回退主 Agent。
4. **主从配置**：在同一台电脑上自动探测已安装的本地 agent（可执行文件位置、配置文件位置、当前角色与模型），支持可视化选择 1 个 `conductor` 与其余 `worker`、配置模型并在预览确认后安全写入配置。

> **定位说明**：本客户端仅解决**同一台电脑**的配置与派活入口，不做跨物理机通信，也不替代 `agentbus` CLI / MCP。
>
> **想法入卡**：对话中每提出一个新想法或结构，先在看板落卡；与本项目无关的另建独立卡；后续要并入原任务时更新原卡研发项，不要复制整段对话。完整规则见 [`TASK_CARDS.md`](TASK_CARDS.md)。

---

## 1. 启动方式

### 方式 A：CLI 启动（推荐，全平台通用）

```bash
# 随机空闲端口启动，不自动打开浏览器（脚本/无头/排障推荐）
node bin/bus.js ui --port 0 --no-open --root var/main

# 随机空闲端口启动并自动调用系统默认浏览器（交互终端 TTY 下生效）
node bin/bus.js ui --port 0 --root var/main

# 指定端口并允许页面按需直接触发 dispatch
node bin/bus.js ui --port 4310 --host 127.0.0.1 --root var/main --dispatch

# 隔离测试/多配置目录场景：显式指定 --home（不触碰默认用户主目录）
node bin/bus.js ui --port 0 --no-open --root var/test-root --home var/test-home
```

### 方式 B：Windows 一键启动脚本（可选入口）

在 Windows 资源管理器中双击仓库内的 [`bin/agentbus-ui.bat`](../bin/agentbus-ui.bat)，会自动以 `127.0.0.1` 随机端口启动本地服务并打开浏览器。脚本优先使用 `%AGENTBUS_ROOT%`；未设置时，若仓库内已有 `var\main` 就用当前仓库总线，否则回退到 `%USERPROFILE%\.agentbus`；不含任何硬编码用户路径。

### 参数说明

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--port <n>` | `0` | 监听端口；`0` 表示由操作系统分配空闲端口 |
| `--host <addr>` | `127.0.0.1` | 绑定地址，仅允许 loopback（`127.0.0.1`、`localhost`、`::1`） |
| `--no-open` | `false` | 不自动调用系统浏览器（无头/非 TTY 环境建议显式指定；也可设 `AGENTBUS_NO_OPEN=1`） |
| `--root <dir>` | 读取 `config.json` / `AGENTBUS_ROOT` | 指定总线数据根目录（含 `agentbus.db` 与 `agents.json`） |
| `--home <dir>` | 当前系统用户主目录 | 可选覆盖客户端配置探测与写入的主目录（测试/隔离场景常用） |
| `--dispatch` | `false` | 开启后默认随 `POST /api/requests` 触发 `dispatchTask`（仍可由请求体 `dispatch: false` 覆盖） |

启动成功后，`stdout` 会输出单行 JSON（含可点击的 `url`），进程前台阻塞运行，按 `Ctrl+C`（`SIGINT`/`SIGTERM`）清理连接并退出。

---

## 2. 主从配置步骤

1. 打开页面后切换到 **主从配置** 页签（或直接访问 `http://127.0.0.1:<port>/#setup`）。
2. 页面首次加载仅执行**只读探测**（复用 `detectAgents` / `describeClients` / `doctor` 逻辑），展示所有已支持客户端的：
   - agent id、名称、安装状态（未安装项标为 `未安装/可选` 或 `未安装`，绝不伪造已安装）；
   - 可执行文件位置（`bin`）与配置文件位置（`config`）；
   - 当前 MCP 角色（`conductor` / `worker` / `未配置`）、dispatch 开关与当前模型。
   - 若探测异常或配置文件损坏，页面会直接展示真实错误，不会静默清空列表。
3. 在“已安装客户端”分组中：
   - 勾选需要参与本次配置写入的客户端；
   - 选择 **1 个** 客户端作为 **Conductor（主控）**，其余勾选的已安装客户端自动设为 **Worker（从属）**；
   - 按需勾选“为 Conductor 开启主动派发（`AGENTBUS_ENABLE_DISPATCH=1`）”；Worker 始终为 `0`；
   - 为每个已安装客户端选择目标模型（选项来自公开模型目录 `KNOWN_MODELS` 与本地当前已配置项，允许选择“未指定（沿用默认）”）。
4. 点击 **预览配置变更（不写盘）**：查看待修改的文件列表、是否自动备份、角色与模型变更摘要及预检结果。此步骤不写入任何文件。
5. 确认无误后，点击 **应用配置（自动备份并写入）**：
   - 更新 `<root>/agents.json` 时会保留所有未知字段（如 `thread_limits` 或自定义键），仅更新 `conductor`、`models`、`archive_on_done` 与 `updated_at`，写入前自动生成 `.bak-<时间戳>` 备份；
   - 各客户端 MCP 配置复用 `setupClients` 写入与备份逻辑（例如 `cordis.patch.yml` 仅更新 `# BEGIN/END agentbus-managed` 区块，不直接覆盖整份文件）；
   - 若任一目标文件损坏、缺少配置目录或权限不足，预检会中止写入并返回明确错误原因与建议，不静默忽略部分失败。

### 重要限制：角色是客户端级，不是单对话级

- `AGENTBUS_ROLE`（`conductor` / `worker`）与 `AGENTBUS_ENABLE_DISPATCH` 写入的是各客户端的全局 MCP 配置文件（如 `~/.codex/config.toml`、`~/.gemini/config/mcp_config.json`、`cordis.patch.yml` 等）。
- 因此角色对**整个客户端进程**生效，而不是单个对话窗口；同一客户端内的所有会话共享同一主从角色。

### 哪些客户端需要重启后生效

本客户端**不会自动重启**任何主程序。配置写入完成后，所有发生配置变更的客户端均需手动重启才能重新加载新的 MCP 环境变量：

- **CLI 类**：OpenAI Codex CLI（`codex`）、Claude Code（`claude`）、Gemini CLI（`gemini`）、OpenCode（`opencode`）、Hermes Agent（`hermes`）——重新启动新的 CLI/会话进程即可。
- **桌面/IDE 类**：Google Antigravity（`antigravity`）、Cursor（`cursor`）、Claude Desktop（`claude-desktop`）、DeepSeek Harness（`dsh`）、Windsurf（`windsurf`）、Kiro（`kiro`）、LM Studio（`lmstudio`）、Cline（`cline`）——完全退出并重新打开对应应用或重新加载 MCP Server。
- **Hermes 补充说明**：若 Hermes 配置文件中已存在 `agentbus` MCP 项，`setupClients` 默认跳过重复 `hermes mcp add` 并在结果 `note`/`warnings` 中提示；如需切换 Hermes 自身的 `AGENTBUS_ROLE`，请按提示先执行 `hermes mcp remove agentbus` 后重新添加或手动调整其环境变量。

---

## 3. HTTP API 与安全边界

### 端口与安全约束

1. **仅限 Loopback 绑定**：服务端在监听前严格校验 `--host`，拒绝 `0.0.0.0`、`::`、局域网 IP 及外部主机名，违反时以退出码 `1` 拒绝启动。
2. **零外部资源与零密钥接触**：不引入任何第三方 npm 依赖、CDN、外部字体或外部图片；不读取、不展示也不写入任何 token、API Key 或密码；不发起外部网络请求。
3. **GET 严格只读**：所有 `GET` 接口均不写入数据库、不修改配置文件、也不在未初始化的 `--root` 下创建 `agentbus.db` 或目录。
4. **POST 严格校验**：
   - 请求体上限 `32 KB`（超限返回 HTTP `413` JSON）。
   - 拒绝未知字段（禁止通过 HTTP 传入自定义 `home`、`root`、`path`、`bin`、`command` 等字段，杜绝路径注入、命令注入与任意文件写）。
   - `agent id` 必须命中 `listClients()` 白名单且已安装（拒绝为未安装客户端创建配置或伪造安装状态）。
   - 角色仅允许 `conductor` 或 `worker`，且有且仅有 1 个 `conductor`。
   - 模型仅允许该 agent 的 `KNOWN_MODELS`、本地当前已配置模型或明确留空（未指定）。

### API 清单

| 方法与路径 | 只读/写入 | 说明 |
|---|---|---|
| `GET /` | 只读 | 返回配套客户端单页 HTML（含项目看板、自动路由规则、模块看板与主从配置四页签，桌面端左右面板独立纵向滚动） |
| `GET /api/health` | 只读 | 返回服务健康状态、`root`、`db_exists`、`dispatch_default` |
| `GET /api/projects` | 只读 | 读取 `<root>/projects.json` 并通过 `openBusReadOnly` 融合真实总线任务状态与校验后的 `agentbus/project-plan@1` 计划（不建库、不写盘） |
| `POST /api/projects` | 写本地与任务库 | 新建项目记录到 `<root>/projects.json`（可选关联受控 `workspace_dir`），直接创建 `to = 所选主 Agent` 的拆解任务并默认自动 `dispatch`（异常时保留任务并返回真实错误） |
| `POST /api/projects/read-existing` | 写本地与任务库 | 严格校验 `workspace_dir` 在 `allowed_roots` 内后扫描本地目录，生成 `existing` / `partial` / `missing` 卡片，紧凑清单写入 `<root>/scans/` 并向所选主 Agent 发起复核任务 |
| `GET /api/projects/:id` | 只读 | 返回单个项目的实时任务状态、Plan 快照、追加卡片请求状态与工作副本卡片 |
| `POST /api/projects/:id/rescan` | 写本地 | 重新扫描项目关联的本地文件夹，刷新卡片的 `existing` / `partial` / `missing` 状态（不覆盖用户手工文案） |
| `POST /api/projects/:id/ask-cards` | 写本地与任务库 | 向项目主 Agent 提要求新增或拆分卡片，创建真实任务并自动派发 |
| `POST /api/projects/:id/apply-delta` | 写本地 | 校验并合并已完成追加卡片任务的 `agentbus/project-plan-delta@1` / `agentbus/project-plan@1` 产物，默认保护用户手工覆盖的卡片 |
| `POST /api/projects/:id/parts/:key/regenerate` | 写本地与任务库 | 重生成已完成或已有 part，携带相对路径与现有实现摘要创建新任务并自动派发，保留历史 `task_id`、不改原始 `plan.json`、活跃期返回 `409` 防重 |
| `POST /api/projects/:id/parts/:key/complete` | 写本地与任务库 | 幂等创建 `to = project.main_agent` 的模块完成与资料归档任务，记录 `completion_task_id` / `completed_at` / `completion_status`，`hermes` 等无适配器客户端保持 `open` 并标待主 Agent 处理 |
| `GET /api/workspace/browse?dir=...` | 只读 | 受控本机目录浏览器，仅列出 `allowed_roots` 内的子目录，自动过滤并拒绝符号链接逃逸 |
| `POST /api/workspace/inspect` | 只读 | 预览扫描指定允许目录的文件清单（相对路径、大小、短哈希、单行摘要）与初步模块状态 |
| `PATCH / POST /api/modules/owners` | 写本地 | 单卡或批量修改模块负责 Agent/模型，严格校验后备份并原子写入 `<root>/module-owners.json`（不改 `src/ui/modules.json`） |
| `POST /api/modules/owners/reset` | 写本地 | 将指定模块或全部模块恢复为 `src/ui/modules.json` 默认负责人 |
| `POST /api/projects/:id/retry-bootstrap` | 写本地与任务库 | 复用 `open` 拆解任务重新派发，或在失败/阻塞/Plan 无效后重建并自动派发新的拆解任务 |
| `POST /api/projects/:id/sync-plan` | 写本地与任务库 | 将已完成拆解任务的合法 `plan.json` 快照写入 `<root>/projects.json` 工作副本（不覆盖原 `plan.json`），并对缺字段新卡自动触发补全任务 |
| `POST /api/projects/:id/enrich-pending` | 写本地与任务库 | 为已入板但缺少核心字段的新增卡片幂等补发 `to = project.main_agent` 补全任务 |
| `POST /api/projects/:id/parts` | 写本地与任务库 | 新增部分卡片到工作副本（允许仅填标题先行落占位卡，默认创建幂等 `enrich:<project_id>:<part_key>` 补全任务，支持 `auto_enrich` 覆盖） |
| `POST /api/projects/:id/parts/:key/enrich` | 写本地与任务库 | 触发或重试卡片自动补全任务（`agentbus/part-enrich@1` JSON 结果只补空/占位字段，不覆盖手动项） |
| `PATCH /api/projects/:id/parts/:key` | 写本地 | 编辑工作副本中的部分卡片字段或手动指定 Agent/模型（标记 `manual_override`，不覆盖原始 `plan.json`） |
| `POST /api/projects/:id/parts/:key/delete` | 写本地 | 从工作副本删除指定部分卡片并清理依赖引用 |
| `POST /api/projects/:id/parts/reorder` | 写本地 | 按 `keys[]` 调整工作副本中部分卡片顺序 |
| `POST /api/projects/:id/auto-route` | 写本地（`dry_run` 只读） | 按 `<root>/project-routing.json` 自动分配 Agent/模型，未命中回退主 Agent；默认保留用户手动覆盖项，显式 `overwrite_manual: true` 才覆盖 |
| `POST /api/projects/:id/dispatch` | 写本地与任务库 | 为选中或全部 part 创建 `to = part.agent` 的真实任务并默认自动 `dispatch`；传 `serial: true` 时按卡片顺序串行执行（前一张 `done` 后才派下一张）；已有 `open/claimed` 活跃任务时自动跳过防重 |
| `GET /api/routing-rules` | 只读 | 读取 `<root>/project-routing.json` 与本机已安装 Agent 列表（损坏时显式报错不覆盖） |
| `POST / PATCH /api/routing-rules` | 写本地 | 严格校验后备份并原子写入 `<root>/project-routing.json`（保留未知字段、拒绝未安装 Agent 与非法模型） |
| `GET /api/modules` | 只读 | 返回技术模块清单与本地 `agents.json` 解析后的工作模型归属 |
| `GET /api/agents` | 只读 | 返回模块调度表单使用的 agent 与可选模型列表 |
| `GET /api/tasks?limit=N` | 只读 | 通过 `openBusReadOnly` 返回近期任务快照（不建库、不写盘） |
| `POST /api/requests` | 写任务库 | 校验并创建模块调度任务；支持 `route_mode: "direct"`（`to = target_agent`）与 `"conductor"`（`to = conductor` 转发，兼容旧调用默认） |
| `GET /api/client-config` | 只读 | 实时探测本机客户端安装状态、二进制/配置路径、当前角色与模型、配置错误 |
| `POST /api/client-config/preview` | 只读 | 校验主从/模型配置并执行 `setupClients(..., { dryRun: true })` 预检，返回待改文件、备份计划、变更摘要与错误，不写盘 |
| `POST /api/client-config/apply` | 写配置 | 预检通过后备份并原子更新 `agents.json`（保留未知字段）与目标客户端 MCP 配置，返回逐项 `changed / backup / warnings / restart_required` |
| `GET /api/meetings?project_id=...` | 只读 | 列出方案擂台会议（`agentbus/meeting@1`）摘要与评分/答辩/决策状态（不建库、不写盘） |
| `POST /api/meetings` | 写本地与任务库 | 创建方案会议并把 brief 登记为 `uri + sha256` 指针引用（校验 `proposer≠judge`、`quorum` 与 `rubric`） |
| `GET /api/meetings/:id` | 只读 | 返回会议详情（支持 `?view=anonymous` 与 `?view=internal` 视图分离，匿名视图绝不暴露作者） |
| `POST /api/meetings/:id/start` | 写本地与任务库 | 幂等为每个提案者创建隔离目录与独立提案任务（至少 2 个提案者、评委数 ≥ quorum） |
| `POST /api/meetings/:id/sync` | 写本地与任务库 | 校验已完成提案（`agentbus/proposal@1` 与 `design_ref` SHA-256），转入匿名评审并创建评委任务 |
| `POST /api/meetings/:id/votes` | 写本地 | 提交评委四维打分（禁止自评、拒绝伪造 `weighted_score`、防重复投票、分差不足触发答辩） |
| `POST /api/meetings/:id/debate` | 写本地与任务库 | 开展最多一轮基于指针信封的答辩（`start` / `critique` / `summarize` / `timeout`） |
| `POST /api/meetings/:id/decide` | 写本地与任务库 | 持久化 `agentbus/decision@1`，执行 `human_approved` 门控，批准后生成胜者实现任务并归档记录到 `dev-materials/meetings/<id>/` |

### 项目拆解契约 (`agentbus/project-plan@1`)

主 Agent 完成项目拆解任务后，应将合法 JSON 写入 `out/projects/<project_id>/plan.json` 并作为 `bus_task_complete` 的 `result_path`：

```json
{
  "schema": "agentbus/project-plan@1",
  "project_id": "p_...",
  "title": "项目名称",
  "summary": "一句话说明",
  "parts": [
    {
      "key": "frontend",
      "title": "前端",
      "category": "frontend_ui",
      "goal": "要做的事",
      "paths": ["src/web"],
      "acceptance": ["可验证条件"],
      "agent": "antigravity",
      "model": "",
      "depends_on": []
    }
  ]
}
```

- `paths` 必须为相对项目路径（禁止绝对路径、URI 与 `..`）。
- 卡片在页面中编辑、新增、删除、排序或自动分配时，仅更新 `<root>/projects.json` 中的工作副本，绝不修改原始 `plan.json`。
- 拆解任务处于 `open / claimed / blocked / failed` 或 Plan 校验失败时，看板会展示真实状态与报错，并提供“重试拆解”与“手动添加卡片”，绝不伪造拆解卡片或把 `open` 标成已派发。
- **多卡派发顺序**：项目看板的“派发全部/派发选中”默认发送 `serial: true`，按卡片当前顺序串行执行：先启动第一张，等它真实 `done` 后才启动下一张；未轮到的卡片保持 `open` 并标记排队。需要并行时可调用 API 时显式传 `serial: false`。串行队列在 UI 进程内运行；进程退出后未派发卡片仍保持 `open`，可在看板手动继续派发。

---

## 4. 新增或修改模块归属

模块静态清单位于 [`src/ui/modules.json`](../src/ui/modules.json)。

- **静态清单不写死个人模型**：`src/ui/modules.json` 中的 `owner_model` 默认保留为 `"未配置"`，切勿将个人默认模型写入公开仓库源码。
- **本地配置优先解析**：运行时 `GET /api/modules` 会按 `--root` 读取本地 `agents.json`（及按需读取 `AGENTBUS_AGY_MODEL`），动态填充每个模块 `owner_agent` 对应的工作模型；若本地未配置，则展示为 `"未配置"`。
- 如需调整本机默认模型或主控 agent，可直接使用本页面的 **主从配置** 页签，或运行 `node bin/bus.js onboard --root <dir>`。

---

## 5. 模块看板请求如何转为 Conductor 任务

1. 用户在 **模块看板** 左侧勾选一个或多个模块，在右侧选择动作（`重做` / `深度优化` / `调整工作模型` / `只检查`）、目标 agent、目标模型与备注。
2. 页面在提交前展示将要创建的 conductor 任务摘要。
3. 提交后，`POST /api/requests` 通过 `validateAndBuildConductorRequest` 组装精简 `goal`（仅包含模块 `id`、路径、当前负责人/模型、动作、目标模型、用户备注与验收要求，不塞入仓库文件内容），再调用 `createTask` 创建 `to = <conductor>` 的任务。
4. **默认不自动 dispatch**：`POST /api/requests` 默认仅创建任务，返回 HTTP `201` 与 `{ task_id, state, to, uri, dispatched: false, dispatch_command }`。仅当启动时传入 `--dispatch` 或页面显式勾选“立即派给主 agent”（请求体 `dispatch: true`）时，才调用 `dispatchTask`。

---

## 6. 失败排查

| 现象 | 常见原因 | 处理方式 |
|---|---|---|
| 启动报 `禁止绑定 0.0.0.0` | `--host` 传入了非 loopback 地址 | 改用 `--host 127.0.0.1` 或 `--host localhost` |
| `POST` 返回 `413` | 请求体超过 32KB | 精简请求内容，不要把大段文件内容粘贴到备注 |
| 返回 `invalid_agent` / `invalid_role` / `invalid_model` / `invalid_field` | 传入了未知客户端、非法角色、不在白名单内的模型或自定义路径字段 | 先通过 `GET /api/client-config` 查看已检测客户端与可选模型后重试 |
| 返回 `agent_not_installed` | 试图将未安装的客户端设为主控或写入其配置 | 仅选择“已安装客户端”分组中的项；未安装客户端请先安装后再刷新探测 |
| 预览或应用返回 `corrupted_config` / `corrupted_agents_config` | 目标 JSON/TOML/YAML 配置文件格式损坏 | 按返回的 `file` 与 `next` 提示手动修复或移走损坏文件后重试（系统不会覆盖损坏文件） |
| 预览或应用返回 `permission_denied` / `missing_config_dir` | 目标配置目录缺失（开启严格校验时）或文件/目录只读无写权限 | 检查目录是否存在及文件读写权限（Windows 可检查只读属性 `attrib -R`） |
| `dispatched: false` 且带 `dispatch_error` | 目标 conductor 适配器未配置或 CLI 不可用（任务本身已成功落库） | 检查返回值中的 `task_id`，排查适配器后用返回的 `dispatch_command` 手动派发 |
| 页面显示模型为 `未配置` | 当前 `--root` 下尚无 `agents.json` 或未配置该 agent 的模型 | 在 **主从配置** 页签选择模型并应用，或运行 `node bin/bus.js onboard --root <dir> --model <agent>=<model>` |
