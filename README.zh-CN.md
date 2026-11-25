# agentbus

**agent 之间交接任务，传地址，不传正文。**

`agentbus` 是一个本机多代理任务总线。任务信封里有目标、验收条款，以及指向所需资料的**指针**（`uri` + `sha256`）——没有正文。领取方自己按地址读盘，交回的成果在任务关闭前会重新核对哈希。

- 零第三方依赖；SQLite 用 Node 内置的 `node:sqlite`。
- 一个 MCP stdio 服务端，支持 Codex / Claude Code / Gemini CLI / Antigravity / Cursor / OpenCode / Claude Desktop，以及 Windsurf / Kiro / LM Studio / Cline / DeepSeek Harness (DSH) / Hermes Agent。
- 同样的能力有 CLI，cron、批处理、不支持 MCP 的 agent 也能用。
- 从不复制资料：登记一个 4MB 文件，数据库只增约 **48KB**。

---

## 为什么

手上不止一个 coding agent 的人都会遇到：每交接一次就重做一份"任务包"，把规格、日志、CSV、策略文件塞进去；下一个 agent 再从头读一遍。资料每跳复制一次，跳到第三手已经没人知道哪份是准的。

`agentbus` 只在盘上留一份，传的是一张收据：路径、大小、SHA-256。本仓库参考任务的实测：

| | 任务包（复制） | agentbus（指针） |
|---|---|---|
| 信封体积 | 4,195,256 B | **2,025 B** |
| 4MB 资料的副本数 | 每跳 1 份 | 0 |
| 能否发现资料已过期 | 不能 | 能——`sha256` 不符直接拒绝收工 |

---

## 安装

需要 **Node.js ≥ 22.13**（`node:sqlite` 无需实验 flag；Node 23.4+ 也可）。

### 离线 tarball（当前支持方式）

包暂未发布到 npm。先在源机器执行 `npm pack` 得到 `agentbus-mcp-<version>.tgz`，拷到目标机器后：

```bash
npm install -g ./agentbus-mcp-0.2.0.tgz
agentbus setup --client codex
```

不想全局安装时，用项目内前缀：

```bash
npm install --prefix ./agentbus-local ./agentbus-mcp-0.2.0.tgz
./agentbus-local/node_modules/.bin/agentbus setup --client codex
```

`npx agentbus-mcp ...` 只有在包正式发布到 npm 后才可用；本版本不把它作为主安装路径。

`setup` 会把 MCP 配置写进对应客户端的配置文件（先做带时间戳的备份），并打印改了哪些文件。支持的 id（核心 + 可选）：

```
核心: codex  claude  gemini  antigravity  cursor  opencode  claude-desktop
可选: windsurf  kiro  lmstudio  cline  dsh  hermes
```

可以一次配多个，或指定角色与 dispatch 权限：

```bash
agentbus setup --client codex --client claude --client gemini
agentbus setup --client codex --role conductor --allow-dispatch
agentbus setup --list   # 看 id、label、format、路径、installed、optional；只读不写盘
agentbus doctor         # 看当前配置状态
agentbus clients        # 只列 id
```

可选客户端未安装时默认跳过（不建目录）；显式传 `--client <id>` 才初始化。完整自动/手动矩阵（含 Trae / Qoder / CodeBuddy / VS Code / Zed / OpenClaw 及 DSH/Hermes 验证与回滚）：[`docs/CLIENTS.md`](docs/CLIENTS.md)。

默认总线目录是 `~/.agentbus`，只有该目录下的文件能作为引用。实际项目请显式放行：

```bash
agentbus setup --client codex --root ~/.agentbus --allow ~/projects/my-app
```

配完**重启客户端**才生效——MCP 服务是启动时加载的。

> 也可以一个项目一条总线：`--root .agentbus --allow .`

---

## 一分钟跑通

```bash
# 1. 登记文件：只存元数据与哈希，不复制
agentbus put ./specs/report.md --by planner

# 2. 建任务，用哈希指向前一步的资料
agentbus new --to codex \
  --goal "按 specs/report.md 产出 report.json" \
  --ref <第1步输出的sha256> \
  --from planner \
  --accept json=true --accept must_contain=total_kwh

# 3. 对方领取，并按地址自己读资料
agentbus claim <task-id> --by codex
agentbus ref   <task-id> --name report.md     # 小文件给正文，>64KB 只给 resource_link

# 4. 交回成果；总线重算引用哈希并逐条验收
agentbus done <task-id> --by codex --lease <token> --result ./out/report.json
```

以下任一情况 `done` 都会失败：引用文件被改过（`drift`）、验收条款不满足、租约不属于调用方。**没有"我说完成了就算完成"这条路。**

在支持 MCP 的 agent 里，同样的流程是四个工具调用：`bus_register` → `bus_task_claim` → `bus_ref_read` → `bus_task_complete`。

---

## 工作方式

```
planner ──put──▶ artifacts(sha256, uri, bytes)        ← 只有元数据
        └─new──▶ tasks/<id>.json  {goal, refs[], acceptance}
                                 │
                     MCP: bus_task_claim（租约）
                                 ▼
                          执行方 agent
                     自己按地址读 refs
                                 │  写出结果文件
                                 ▼
        bus_task_complete → 重算 refs 哈希 → 跑验收 → done
```

- **状态**：`open → claimed(租约) → done | failed`；租约过期自动回 `open`，`attempt + 1`。
- **租约**：默认 900 秒，可用 `heartbeat` 续期；任何写操作都校验 token。
- **幂等**：`--key` 让建任务可以安全重试。
- **指针语义**：`bus_ref_read` 只内联 ≤64KB 的文件，更大的返回 MCP `resource_link`，由 agent 自己去取。
- **完整性**：读取时、收工前、`verify` 时三处都重算 SHA-256。

协议细节见 [`docs/PROTOCOL.md`](docs/PROTOCOL.md)。

---

## MCP 工具

| 工具 | 作用 |
|---|---|
| `bus_register` | 按路径登记文件，返回 `sha256`/`uri`/`bytes` |
| `bus_task_create` | 用 refs + 验收条款建任务（可带幂等键） |
| `bus_task_claim` | 领取任务，拿到租约 token 与完整 goal / refs / acceptance 信封 |
| `bus_task_heartbeat` | 续租 |
| `bus_ref_read` | 读引用（正文 / base64 / 大文件只给 `resource_link`） |
| `bus_task_complete` | 校验引用与验收、记录结果哈希、关闭任务 |
| `bus_task_fail` | 以失败关闭并写明原因（同步写入 `error` 消息） |
| `bus_task_message` | 任务内发送 `note` / `progress` / `question` / `blocked` / `answer` / `error` 消息 |
| `bus_task_inbox` | 拉取任务消息收件箱（`for_agent` / `since_id` / `mark_read`） |
| `bus_task_list` | 列任务（`state`/`to`/`limit`） |
| `bus_verify` | 全量重算引用与结果哈希，报告漂移 |
| `bus_task_dispatch` | **默认关闭**：主动唤起目标 agent 的 CLI 并等结果 |
| `bus_task_wait` | 等总线进入终态或收到新的 `question`/`blocked`/`error` 消息 |
| `bus_task_run` | 建任务并立刻派发 |

### 主动唤起（dispatch）

任务板需要有人去通知对方"来领活"。dispatch 把这一步去掉：`bus_task_dispatch`（或 `agentbus dispatch <id>`）直接起目标 agent 的 CLI，等它 claim/complete，然后返回结果哈希。

```bash
AGENTBUS_ENABLE_DISPATCH=1 agentbus dispatch <task-id> --cwd . --wait 600
```

默认关闭，因为这意味着总线获得了"起进程"的能力。内置 `codex` / `claude` / `gemini` / `antigravity` 四个适配器；其它 agent 用 `AGENTBUS_ADAPTER_<NAME>`（JSON `{command, args}`，`{prompt}` 会被替换）。

dispatch **只信总线，不信子进程**：子进程退出但没调 `bus_task_complete`，结果是 `state=claimed`，不算成功。

**线程（会话亲和）**：`--thread <name>` 保持同一段对话——首轮记下 agent 的会话 id，同线程的后续任务会 resume 它，而不是从零开始。Codex 的 `exec resume` 没有 `--approve-for-me`，所以 resume 分支带 `--dangerously-bypass-approvals-and-sandbox`；用线程前先看 SECURITY.md。

Antigravity 的坐标（`ANTIGRAVITY_LS_ADDRESS`、`ANTIGRAVITY_CSRF_TOKEN`）只活在它自己的运行时里。适配器先读导出的会话文件，没有就回退到运行中应用的 `daemon/hub_*.json`（里面有 CSRF 令牌和 HTTP 端口）。两边都没有时，在它的集成终端里跑一次：

```bash
node <agentbus>/bin/bus.js agy-session --out <总线根目录>/antigravity-session.json
```

文件按 0600 落盘，应用重启即失效。注意端口每次重启都会变，不要硬编码。

Antigravity 是异步起会话的，`dispatch` 可能在任务还 `open` 时就返回。这时等总线，不要等子进程：

```bash
agentbus wait <task-id> --timeout 900
```

如果宿主需要在任务完成后被自动唤醒，用 `watch`（单进程、单任务、只读、默认 5 秒一次）：

```bash
agentbus watch <task-id> --interval 5 --timeout 3600
# done -> 0；failed/blocked/租约过期 -> 1；超时 -> 3
# dispatch --watch 让派发进程一直活到同样的终态
```

`watch` 只输出一行 JSON，不依赖 TTY/readline，不起 daemon，只做任务主键查询。宿主可以把它作为受监督的后台进程，退出时发通知。

新机器接线前先跑只读预检：

```bash
agentbus doctor --bootstrap --root ~/.agentbus --json
```

它会检查 Node/sqlite、总线根、allowed roots、`agents.json`、客户端二进制、可选的反重力 CDP、旧 MCP 进程；不会改配置、不会杀进程。

通过 MCP 调用时，`bus_task_dispatch` 最多阻塞 20 秒就返回（很多客户端对单次工具调用有超时），接着调 `bus_task_wait` 等总线即可——它只查状态、不起进程，可以放心长等。

### 导入：探测本机 agent 并分角色（onboard）

在一台新机器上，不用逐个手写配置：

```bash
agentbus onboard --conductor codex --allow /path/to/workspace
```

它会：

1. 扫 PATH 与已知安装位置，列出本机装了哪些 agent（Codex / Claude Code / Gemini / Antigravity / OpenCode）
2. 选一个 **conductor**（主 agent，能建任务、派活、验收），其余写成 **worker**
3. 交互式询问每个 agent 主要用哪个模型（回车=默认），答案存进总线根目录的 `agents.json`（已在 .gitignore，不进仓库）
4. 改写各家的 MCP 配置，注入 `AGENTBUS_ROLE`

角色不是摆设：worker 的 `tools/list` 只返回 8 个工具（`register` / `claim` / `heartbeat` / `ref_read` / `complete` / `fail` / `message` / `inbox`），调用 `bus_task_create` 或 `bus_task_dispatch` 会被直接拒绝；未知 `AGENTBUS_ROLE` 也回落为 `worker`。这样被派的 agent 没法自己再派活，避免回路。

模型只存本机：仓库里没有任何人的偏好值，只有"询问 + 存储 + 生效"这套机制。

### 健康冷却

某个 agent 因上游容量（例如 503 `No capacity available`）失败后，总线会给它记一段冷却（默认 900 秒，其它失败 120 秒）。冷却期内 `dispatch` 直接返回 `skipped: true` 并给出到期时间，不再干等；确认要重试加 `--force`。成功一次即清除。

### 并发与延迟

- **一条命令并发派发**：`agentbus dispatch <id1> <id2> ...` 或 MCP `bus_task_dispatch {ids:[...]}`。墙钟时间取最慢的那个。实测三个任务：逐个派 2,899ms，一次并发 910ms（3.2×）。
- **`bus_task_run`**：建任务并立刻派发，省掉 create→dispatch 一次往返。
- **MCP 的 dispatch 3 秒内返回**（不再阻塞 20 秒），随后用 `bus_task_wait` 等总线；等待期间主 agent 可以继续派别的活。
- **会话亲和**：同一 `--thread` 的第二轮走 `resume`，省掉重新读上下文的时间（实测 63.9s → 49.5s）。
- **轮询**：前 8 秒 150ms 一次，之后退避到 400ms；协议本身的开销约 0.19 秒/次（用 300ms 的假 agent 实测 825ms，扣掉 agent 自身两次 CLI 调用）。

真正占时间的是模型推理，不是总线：实测 Codex 45.5s、Antigravity 30s，通信开销不到 1%。要更快就并发、复用会话、选对模型。

### 会话复用与上限

- **同一任务的重试只占一条会话**：`threads` 表自动记 `task:<id>`，重试时沿用同一会话；任务进入 `done`/`failed` 后该行自动清理。
- **跨任务复用按客户端分策略**：`antigravity` 默认**禁止**（每轮重放全量历史，实测 36.6s→78.8s）；传 `--thread` 不会报错，而是"新开干净会话 + 用 `context@1` 账本接力"。`codex` 允许 `exec resume`（实测 63.9s→49.5s）。
- **上限表**：antigravity 20 步 / 1h / 空闲 30m / 3 次；codex 60 步 / 2h / 30m / 6 次。可用 `AGENTBUS_AGY_MAX_STEPS` 或 `AGENTBUS_THREAD_LIMITS_JSON` 覆盖。
- **作用域校验**：`cwd`、`model`、`last_ok` 任一不匹配就换新；秒败/模型失败/空对话不写表；降级模型切换不继承失败会话。
- **步数不再写死 0**：antigravity 读会话库、codex 读 JSONL/stdout、都没有则按每次 8 步估算（`step_source` 会写明来源）。
- **标题带日期**：新会话标题形如 `agentbus 11-24 tmw…`。

### 线程账本 `context@1`

`--thread <name>` 会在 `<busRoot>/contexts/<name>.json` 维护一份 ≤8KB 的账本：`contract_refs`、`decisions`、`latest_artifacts`、`avoid`。任务 `done` 才写产物与提议，失败只进 `avoid`；决策分 `proposed`/`confirmed`，必须由**另一个 agent** 确认才生效，未确认的提议不会顶掉已确认决策。新会话 prompt 只挂一行指针，正文仍不进任务信封。

### 归档会话

```
agentbus archive --title-contains <taskid>          # 默认只允许归档 state=done 的任务
agentbus archive --title-contains <taskid> --dry-run
agentbus archive <conversation-id> --port 9222 --force
agentbus archive --title-prefix <prefix> --force    # 仅限人工清理旧会话
agentbus onboard --archive-on-done                  # 持久开启：写进 agents.json，重启也生效
AGENTBUS_ARCHIVE_ON_DONE=1                          # 单次运行临时开启
```

**归档状态闸门（默认开启）**：默认只允许通过 `--title-contains <taskid>` 归档已完成（`state === 'done'`）的任务。若任务仍为 `open` / `claimed` 等未完成状态，会在调用 CDP 前直接拒绝并返回 `task_not_done`（退出码 `2`）；查无此任务返回 `not_a_task`（退出码 `1`）。`--title-prefix`（`title_prefix_requires_force`）与裸 `<conversation-id>`（`conversation_id_requires_force`）默认同样拒绝。`--dry-run` 允许对未完成任务做只读预览，输出 `task_id`、`task_state` 与 `would_archive` 且绝不点击。`--force` 仅限人工清理陈旧/卡死会话（返回带 `forced: true`）：对仍在运行的任务强行 `--force` 只会隐藏侧栏入口、不会停止任务本身，请谨慎使用。

走 CDP 点击侧边栏的 `归档对话` 按钮；应用需以 `--remote-debugging-port=<n>` 启动，否则明确报错而不是假装成功。

自动归档只在任务最终 `done` 时触发，由**完成任务的进程**执行（CLI `done` 或 MCP `bus_task_complete`），所以长任务即使派发进程早已退出也能归档。它按任务 id 匹配标题 `agentbus MM-DD <taskid>`，会把该任务因重试产生的重复会话一起归档；任务刚完成时侧边栏可能还没渲染出新行，会重试最多 6 次（约 10 秒）；按钮被 portal 到行外时按同一水平中心线关联标题。匹配不到只记 `row_not_found` 事件，不动其他对话，也不影响任务状态。

### 模型自动降级

`agents.json` 指定的模型失败时（`model_not_found`、`not supported`、`503 No capacity`），dispatch 会按顺序换下一个候选：配置值 → `AGENTBUS_FALLBACK_MODELS`（逗号分隔）→ 该 agent 的已知模型表 → 不传模型（用 CLI 默认）。每次尝试最多等 120 秒，模型类错误会立即中止等待、直接换下一个。返回里的 `attempts` 会列出每个模型的结果。

---

## 安全模型

- 默认不监听任何端口（stdio MCP）；可选 HTTP 模式只绑 `127.0.0.1`。
- 引用路径必须落在 `AGENTBUS_ALLOWED_ROOTS` 内；符号链接与 Windows Junction 先做 `realpath` 解析，越界一律拒绝。
- 资料正文永不入库，库里只有 `uri`、`bytes`、`sha256`。
- 不提供 shell、不写任意路径、不碰凭据。
- `setup` 改配置前会备份为 `<file>.bak-<timestamp>`。

详见 [`SECURITY.md`](SECURITY.md)。

---

## 兼容性

| 客户端 | 自动配置 | 验证程度 |
|---|---|---|
| OpenAI Codex CLI | `--client codex` | ✅ 2026-11，跑通完整 claim → complete |
| Claude Code | `--client claude` | 仅验证配置写入 |
| Gemini CLI | `--client gemini` | 仅验证配置写入 |
| Google Antigravity | `--client antigravity` | ✅ 2026-11，跑通完整 claim → complete |
| Cursor | `--client cursor` | 仅验证配置写入 |
| OpenCode | `--client opencode` | 仅验证配置写入 |
| Claude Desktop | `--client claude-desktop` | 仅验证配置写入 |
| Windsurf | `--client windsurf`（可选） | 仅验证配置写入 |
| Kiro | `--client kiro`（可选） | 仅验证配置写入 |
| LM Studio | `--client lmstudio`（可选） | 仅验证配置写入 |
| Cline (VS Code / CLI) | `--client cline`（可选） | 仅验证配置写入 |
| DeepSeek Harness (DSH) | `--client dsh`（可选） | Cordis YAML 块 + 解析校验 |
| Hermes Agent | `--client hermes`（可选） | `hermes mcp add` + `mcp list` |

> **Hermes 配置路径：** Windows 默认 `%LOCALAPPDATA%\hermes\config.yaml`（不存在时回退 `%USERPROFILE%\.hermes\config.yaml`），macOS/Linux 为 `~/.hermes/config.yaml`，设置 `HERMES_HOME` 时优先使用 `$HERMES_HOME/config.yaml`。

任何说 stdio JSON-RPC 的 MCP 客户端都能用；`setup` 自动化以上 13 家，Trae / Qoder / CodeBuddy / VS Code / Zed / OpenClaw 的手动步骤以及 DSH / Hermes 验证与回滚见 [`docs/CLIENTS.md`](docs/CLIENTS.md)。

---

## 已知限制

- **仅限本机。** 引用是 `file://` 地址。跨机需要一层 HTTP 资料库，信封结构不用改。
- **CLI 提示目前是中文。** 英文/多语言在路线图上；MCP 返回是 JSON，与语言无关。
- **没有后台守护进程。** 租约过期在下一次读/写时惰性回收。
- **要求 Node ≥ 22.13**（Node 23.4+ 也可），因为 SQLite 来自 `node:sqlite`。
- **当前先走离线 tarball。** npm 尚未发布，`npx agentbus-mcp` 不是本版本支持的安装方式。干净机器清单和分层边界见 [`docs/PORTABILITY.md`](docs/PORTABILITY.md)。

---

## 与同类项目的关系

| 项目 | 做什么 | 差异 |
|---|---|---|
| [turnbus](https://github.com/jgreen01/turnbus) | SQLite 消息总线 + MCP，能唤醒空闲会话 | 解决"消息与唤醒"，不解决"资料怎么给" |
| [multiagents](https://github.com/zetbrush/multiagents) | broker + 编排器，带角色与评审循环 | 完整团队平台；agentbus 只是一条细总线 |
| [agentmesh](https://github.com/BlueHeisenberg/agentmesh) | 局域网 mDNS + mTLS 组网 | 跨机通信；agentbus 是本机、以文件为中心 |
| [A2A](https://github.com/a2aproject/A2A) | 跨厂商 HTTP 协议 | 单机场景偏重；信封字段可平滑映射 |

`agentbus` 只做一件事：**让一次交接可审计，且不复制资料。**

---

## 开发

```bash
git clone https://github.com/dfggg121/agentbus.git
cd agentbus
node test/accept.mjs     # 自包含验收测试套件
```

自验套件自己生成测试资料、起真实 CLI 进程、打开真实 SQLite、用真实 MCP stdio 通信。不用测试框架，也不用 shell 管道（管道会把退出码吞掉，等于自欺）。

MIT 许可，欢迎提交——见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。
