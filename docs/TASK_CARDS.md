# 想法入卡与合并规则（`TASK_CARDS`）

本规则供主 Agent（`conductor`）与执行 Agent（`worker`）在日常协作和项目看板操作中直接遵循，目标是**想法不丢失、任务不混杂、上下文省 token**。

---

## 1. 触发条件：想法即刻落卡

- **同步落卡**：对话或讨论中每提出一个新想法、新结构、新方案，必须在项目看板**立即落一张卡**；不能只停留在聊天记录或 `bus_task_message` 消息里。
- **无关想法独立建卡**：若该想法**与当前项目无关**，必须先在看板新建**另一个项目**或独立卡存放，不得塞进原项目的卡片列表，避免污染原项目上下文与派发队列。

## 2. 最小卡规范（低开销启动）

落卡时只填最小必要字段，能定位即可：

- **必填字段**：
  - `title`：简短明确的标题
  - `goal`：一句话摘要（说明要做什么或验证什么）
  - **来源指针**：来源任务 `id`、对话标识，或已登记资料的 `uri + sha256`
- **后补字段**：负责 `agent`、模型 `model`、`paths`、`acceptance`、`code`（模块代号）可先留空或由后续补全填写。
- **两条禁令**：
  1. **不新开 agent 会话**：为了记下想法而建最小卡时，不要启动新的 agent 会话（UI/API 添加卡片时关闭自动补全 `auto_enrich: false`）。
  2. **不复制全文**：不要把整段对话、长日志或大段规格书复制进卡片 `goal` 或备注里。

## 3. 后续合并：并入原卡研发项

当用户后续明确指示“把这个技术/方案并进原任务”时，按以下规则合入，**不要新建重复卡**：

1. **定位原卡**：找到目标项目与原卡片 `key`，在**原卡**上更新研发项。
2. **字段口径**：只使用现有计划与卡片字段更新研发项：
   - `goal`：补充合入的技术要点与约束
   - `acceptance`：追加对应可验证验收条件
   - `paths`：补充涉及的项目相对路径
   - 同时保留来源独立卡的指针（任务 `id` 或 `uri + sha256`）与变更记录；**如发现现有字段不足以表达需求，先向主控或用户报告，不擅自修改协议字段**。
3. **复用现有合并路径**：
   - 经由主 Agent 讨论拆解出的增量，优先复用项目看板现有的 `card_requests`（`POST /api/projects/:id/ask-cards`）与 `apply-delta`（`POST /api/projects/:id/apply-delta`）合并路径；
   - 人工或已知精确改动的合并，直接局部更新工作副本（`PATCH /api/projects/:id/parts/:key`），不覆盖原始 `plan.json`。
4. **独立卡收尾**：合并完成后，将原独立卡标记或删除清理，避免后续被重复派发。

## 4. 省 token 纪律

- **摘要 + 指针**：每条想法只存一句摘要 + 来源指针；需要看原文时再按 `uri` 读盘。
- **按需单点读取**：一次只读当前需要的卡片或文档，不重读全仓代码，也不重放整段历史对话。
- **数据操作不调模型**：建最小卡、改负责人/模型、调分组（`dev` / `debug`）或调整顺序属于本地 JSON 数据操作，不触发模型推理。
- **增量定位合并**：合并时按 `part.key` 或 `request_id` 精确定位单张卡更新，不重新生成整套项目 `plan.json`。

## 5. 完成与状态真实性

- **验收 + 归档才算完成**：只有卡片的 `acceptance` 全部通过、且产物已按规范归档到 `<workspace>/.agentbus/dev-materials/<module-code>/` 后，才可触发完成归档（`POST /api/projects/:id/parts/:key/complete` 或点击 UI 卡片的**完成**）。
- **禁止伪装 `done`**：未完成、只做了一半或被暂停的想法卡，必须保留真实状态（`partial` 或 `planned`），不得伪装成 `done`。

---

## 6. 三步实操示例（想法 → 独立卡 → 合并回原卡研发项）

假设主项目 `p_demo` 中已有一张原研发卡 `key: "storage"`；讨论中突然提出一个新思路：“用本地 SQLite WAL 索引加速文件检索”（暂不确定是否直接纳入主项目）。

### 第 1 步：登记指针并落最小独立卡（不新开会话）

若思路源于某份参考笔记，先登记指针（可选）：

```bash
agentbus put ./specs/wal-index-note.md --by planner
# 记录返回的 uri 与 sha256
```

在项目看板切换到（或新建）独立想法项目 `p_ideas`，点击 **手动加卡**（对应 `POST /api/projects/p_ideas/parts`），只填最小字段且关闭 `auto_enrich`：

```json
{
  "title": "SQLite WAL 索引检索方案",
  "goal": "验证用本地 WAL 索引替代全目录扫描的可行性（来源：specs/wal-index-note.md，sha256=<哈希>）",
  "group": "dev",
  "implementation_status": "planned",
  "auto_enrich": false
}
```

> 此时只落一条轻量 JSON 记录，不新开 agent 会话，也不复制笔记全文。

### 第 2 步：独立评估与保持真实状态

在独立卡上完成小范围验证或讨论后，若尚未并入主项目，状态保持 `planned` 或 `partial`；若决定暂不采用，保留原卡记录与指针即可，不占用主项目串行派发队列。

### 第 3 步：合并回原卡研发项

用户确认“把 WAL 索引方案并进原项目 `p_demo` 的 `storage` 卡”后，按原卡 `key` 局部合并：

- **方式 A（直接局部更新原卡工作副本）**：通过 UI 编辑卡片或调用 `PATCH /api/projects/p_demo/parts/storage`，在现有 `goal`、`acceptance`、`paths` 中增量写入：
  - `goal`：追加“引入本地 SQLite WAL 索引（来源：独立卡及 specs/wal-index-note.md，sha256=<哈希>）”
  - `acceptance`：追加“WAL 索引在重复扫描时可正确命中且无锁冲突”
  - `paths`：追加 `"src/index.js"`
- **方式 B（交由主 Agent 生成增量再合并）**：在项目看板使用 **向主 Agent 提要求**（`POST /api/projects/p_demo/ask-cards` 生成 `card_requests`），完成后调用 `POST /api/projects/p_demo/apply-delta` 按增量合入原卡，无需重跑全项目拆解。

合并完成后，从 `p_ideas` 移除已并入的临时独立卡（`POST /api/projects/p_ideas/parts/<key>/delete`），原卡继续按正常验收与归档流程推进。
