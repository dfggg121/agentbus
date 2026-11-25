# agentbus 可视化模块面板 (`ui`)

`agentbus ui` 提供一个零第三方运行时依赖、无构建步骤的本地可视化面板，用于查看项目各技术模块的当前负责人与模型归属，并勾选模块向主控 agent（`conductor`）提交重做、深度优化、调整工作模型或只检查任务。

---

## 1. 启动方式

```bash
# 随机空闲端口启动（推荐），不自动打开浏览器，指定总线根目录
node bin/bus.js ui --port 0 --no-open --root var/main

# 指定端口并允许页面按需直接触发 dispatch
node bin/bus.js ui --port 4310 --host 127.0.0.1 --root var/main --dispatch
```

### 参数说明

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--port <n>` | `0` | 监听端口；`0` 表示由操作系统分配空闲端口 |
| `--host <addr>` | `127.0.0.1` | 绑定地址，仅允许 loopback（`127.0.0.1`、`localhost`、`::1`） |
| `--no-open` | `false` | 不自动调用系统浏览器（无头/非 TTY 环境建议显式指定；也可设 `AGENTBUS_NO_OPEN=1`） |
| `--root <dir>` | 读取 `config.json` / `AGENTBUS_ROOT` | 指定总线数据根目录（含 `agentbus.db` 与 `agents.json`） |
| `--dispatch` | `false` | 开启后默认随 `POST /api/requests` 触发 `dispatchTask`（仍可由请求体 `dispatch: false` 覆盖） |

启动成功后，`stdout` 会输出单行 JSON（含可点击的 `url`），进程前台阻塞运行，按 `Ctrl+C`（`SIGINT`/`SIGTERM`）清理连接并退出。

---

## 2. 端口与安全边界

1. **仅限 Loopback 绑定**：服务端在监听前严格校验 `--host`，拒绝 `0.0.0.0`、`::`、局域网 IP 及外部主机名，违反时以退出码 `1` 拒绝启动。
2. **GET 严格只读**：
   - `GET /`、`GET /api/modules`、`GET /api/agents`、`GET /api/tasks`、`GET /api/health` 均不写入数据库，也不在未初始化的 `--root` 下创建 `agentbus.db` 或目录。
   - 当 `agentbus.db` 存在时，任务列表通过 `openBusReadOnly`（`readOnly: true` + `PRAGMA query_only = ON`）与 `listTasksReadOnly` 查询，不触发 `reapExpiredLeases` 或旧信封同步写盘。
3. **POST 输入与权限校验**：
   - `POST /api/requests` 限制请求体大小上限为 `32 KB`（超限返回 HTTP `413` JSON）。
   - `module_ids` 必须全部命中 `src/ui/modules.json` 白名单；`action` 仅允许 `redo`、`optimize`、`adjust_model`、`inspect`。
   - `target_agent` 与 `target_model` 仅允许当前配置（`<root>/agents.json`）及公开产品模型目录（`KNOWN_MODELS`）中存在的项。
   - 不执行任意 shell 命令，也不提供任意本地文件路径读取接口；所有异常均返回结构化 JSON，不返回 500 HTML。

---

## 3. 新增或修改模块归属

模块静态清单位于 [`src/ui/modules.json`](../src/ui/modules.json)。每条记录包含：

```json
{
  "id": "ui",
  "label": "可视化模块面板",
  "layer": "interface",
  "layer_label": "接口与配置层",
  "paths": ["src/ui/server.js", "src/ui/index.html", "src/ui/modules.json"],
  "owner_agent": "antigravity",
  "owner_model": "未配置",
  "summary": "零依赖 loopback 只读模块看板、模型归属解析与 conductor 任务提交界面。",
  "status": "active"
}
```

- **静态清单不写死个人模型**：`src/ui/modules.json` 中的 `owner_model` 默认保留为 `"未配置"`，切勿将个人默认模型写入公开仓库源码。
- **本地配置优先解析**：运行时 `GET /api/modules` 会按 `--root` 读取本地 `agents.json`（及按需读取 `AGENTBUS_AGY_MODEL`），动态填充每个模块 `owner_agent` 对应的工作模型；若本地未配置，则展示为 `"未配置"`。
- 如需调整本机默认模型或主控 agent，请运行 `node bin/bus.js onboard --root <dir>` 或编辑 `<root>/agents.json`。

---

## 4. 请求如何转为 Conductor 任务

1. **控制台布局**：页面采用值班台双栏结构——顶部为紧凑项目状态栏（总线目录、Conductor、模块数与 DB 只读状态）；左侧按技术层次分组展示列对齐的行式模块清单（含负责人、工作模型、路径与状态）及底部只读近期任务快照；右侧为固定粘性“调度操作区”。
2. 用户在左侧勾选一个或多个模块，在右侧选择动作（`重做` / `深度优化` / `调整工作模型` / `只检查`）、目标 agent、目标模型与备注。
3. 页面在提交前展示将要创建的 conductor 任务摘要。
4. 提交后，`POST /api/requests` 通过 `validateAndBuildConductorRequest` 组装精简 `goal`（仅包含模块 `id`、路径、当前负责人/模型、动作、目标模型、用户备注与验收要求，不塞入仓库文件内容），再调用 `createTask` 创建 `to = <conductor>`（未配置 `conductor` 时为 `conductor`）的任务。
5. **默认不自动 dispatch**：`POST /api/requests` 默认仅创建任务，返回 HTTP `201` 与 `{ task_id, state, to, uri, dispatched: false, dispatch_command }`。仅当启动时传入 `--dispatch` 或页面显式勾选“立即派给主 agent”（请求体 `dispatch: true`）时，才调用 `dispatchTask`。

---

## 5. 失败排查

| 现象 | 常见原因 | 处理方式 |
|---|---|---|
| 启动报 `禁止绑定 0.0.0.0` | `--host` 传入了非 loopback 地址 | 改用 `--host 127.0.0.1` 或 `--host localhost` |
| `POST /api/requests` 返回 `413` | 请求体超过 32KB | 精简 `notes`，不要把代码或文件内容直接粘贴到备注 |
| 返回 `invalid_module_id` / `invalid_agent` / `invalid_model` | 模块 id 不在 `modules.json`，或选择的 agent/model 不在本地 `agents.json` 与已知目录中 | 通过 `GET /api/modules` 与 `GET /api/agents` 查看有效项后重试 |
| `dispatched: false` 且带 `dispatch_error` | 目标 conductor 适配器未配置或 CLI 不可用（任务本身已成功落库） | 检查返回值中的 `task_id`，排查适配器后用返回的 `dispatch_command` 手动派发 |
| 页面显示模型为 `未配置` | 当前 `--root` 下尚无 `agents.json` 或未配置该 agent 的模型 | 运行 `node bin/bus.js onboard --root <dir> --model <agent>=<model>` |
