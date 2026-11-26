# GitHub 评论区展示稿（任务履历式）

下面两段可直接复制到 GitHub Issue / Discussion / PR 评论区。骨架是一条任务的真实交接收据：先看任务在总线里走过了什么状态，再说明它来自哪套机制。

---

## 1. 短版（5–8 行，可直接作为首条评论）

```markdown
**[Task Receipt #demo-01] `open` -> `claimed` -> `question/answer` -> `done`**
我的任务信封只有 `2,025 B`：4 MB 资料留在原盘，信封里只放 `goal`、验收条款和一条 `uri + sha256` 指针。`antigravity` 凭 `lease_token`（TTL 900s）领走任务并按指针读盘；中途发出 `kind=question` 挂起 `blocked_at`，主控 `codex` 回复 `answer` 清掉阻塞；交回结果前总线重算了所有引用的 SHA-256 并逐条核过 `acceptance`，任务才进入 `done`。

这是 **agentbus**（给本机已有 coding agent 用的 MCP + CLI 任务总线，零第三方依赖，基于 `node:sqlite`）。通过 `agentbus setup` 支持 Codex / Claude Code / Gemini CLI / Antigravity / Cursor / OpenCode / DSH / Hermes 等 13 类客户端，另有只读 loopback 模块归属面板（`agentbus ui`）。
源码与协议：https://github.com/dfggg121/agentbus
试跑自包含验收（114 项，当前 113 passed / 1 skipped）：`git clone https://github.com/dfggg121/agentbus.git && cd agentbus && node test/accept.mjs`
```

---

## 2. 技术版（15–25 行，含 `<details>` 折叠协议字段与生命周期细节）

```markdown
**[Task Receipt] 一条 4 MB 资料的任务，在总线里只占 2,025 B**

| 阶段 | 总线记录 | 约束与校验 |
|---|---|---|
| `bus_register` | `artifacts` 新增约 48 KB 元数据 | 文件留在原盘，`realpath` 校验必须落在 `AGENTBUS_ALLOWED_ROOTS` 内 |
| `bus_task_create` | 生成 `tasks/<id>.json`（`2,025 B`） | 仅存 `uri + sha256`，信封禁止嵌入超过 300 字符的行或引用正文 |
| `bus_task_claim` | 状态 `open -> claimed`，签发 `lease_token` | 默认 TTL 900s，可 `heartbeat` 续租；超时回 `open` 且 `attempt + 1` |
| `bus_ref_read` | 记录 `ref_read` 审计事件 | `<= 64 KB` 返回正文；`> 64 KB` 只返回 MCP `resource_link` 指针 |
| `bus_task_message` | 写入 `task_messages` 表（不污染信封） | `question`/`blocked`/`error` 置位 `blocked_at`；主控 `answer` 解阻 |
| `bus_task_complete` | 校验租约 -> 重算 ref 哈希 -> 验收 -> `done` | 源文件被改过直接报 `drift` 拒收；`acceptance` 逐字段比对 |

<details>
<summary>查看同一条任务的最小交接信封与本地接入方式</summary>

- **协议信封（`agentbus/task@1`）**：包含 `from`、`to`、`state`、`goal`、`constraints`、`refs[{name, uri, sha256, bytes}]`、`acceptance` 与 `history`；`lease_token` 只留在 SQLite，不写入任务 JSON。
- **权限隔离**：通过 `AGENTBUS_ROLE=worker` 限制被派发代理只看到 9 个工具（`register / claim / heartbeat / ref_read / complete / fail / recover / message / inbox`），不能自行再 `create` 或 `dispatch`。
- **现有工具接入**：`agentbus setup --client codex --client claude --client gemini` 写入各家配置并自动留存 `.bak-<timestamp>` 备份；`agentbus ui` 提供只读 loopback 面板展示 14 个模块的负责人与模型归属。

</details>

仓库：https://github.com/dfggg121/agentbus
本地只读自检：`git clone https://github.com/dfggg121/agentbus.git && cd agentbus && node bin/bus.js doctor --bootstrap --json`
```
