# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Added
- Project board serial dispatch: `POST /api/projects/:id/dispatch` accepts `serial: true`; the UI uses it for “派发全部/派发选中”. Only the first dispatchable card is started, and the remaining cards are queued in card order and started only after the previous task reaches `done`. The response reports `summary.queued` and each queued result has `state: "queued"` plus `queue_position`; parallel dispatch remains available with `serial: false`.

### Tests
- Acceptance case 156 covers serial project dispatch ordering and the non-concurrent response summary.

### Docs
- Rewrite the Chinese project intro around two primary workflows: multi-agent discussion/collaboration through task messages and proposal cards, and the current project-board front end (`agentbus ui`).
- Add `docs/TASK_CARDS.md`: every new idea or structure lands as a card; unrelated ideas get an independent card first; later merge requests update the original card’s R&D fields (`goal` + `acceptance` + `paths`), with pointer summaries instead of copied conversations.
- Add a sanitized project-board screenshot (`docs/assets/agentbus-project-board.zh.png`) for the compact-card layout.

## [0.4.0] — 2026-11-28

### Added
- `agentbus adapt` and automatic preset adaptation in `agentbus setup`:
  - Presets for WorkBuddy, CodeBuddy, VS Code/Copilot, Trae, Qoder, OpenClaw, and Zed; each preset knows a config path and a JSON shape (`mcpServers`, `servers`, `mcp.servers`, `context_servers`, or OpenCode local).
  - `agentbus setup` without `--client` writes detected preset clients and runs the MCP probe; `--no-adapt` disables, `--auto` also enables it with explicit `--client`.
  - Global `npm install -g` runs a one-shot `postinstall-adapt.mjs` (presets only, never core configs); `AGENTBUS_NO_AUTO_ADAPT=1` opts out, `AGENTBUS_AUTO_ADAPT=1` forces it for local installs. Results land in `~/.agentbus/auto-adapt.json`; install failures never break npm.
  - Every preset write is timestamped-backup protected. A failed MCP probe removes the newly created file or restores the backup, and reports `rolled_back: true`.
  - Optional `--path <file> --format <fmt>` for unknown clients, and opt-in `--scan` for local `mcp*.json` discovery. JSONC/JSON5 configs are reported as manual and never rewritten.
  - Probe performs a real stdio `initialize` + `tools/list` + role-safe tool call: worker must expose 9 tools, conductor 15.
  - `setup --list` now includes read-only `presets` metadata.
- Acceptance cases 150-155: preset catalog read-only, WorkBuddy write/backup/probe/idempotence, OpenClaw nested merge, failed-probe rollback, and setup auto-adapt/no-adapt.

## [0.3.0] — 2026-11-27

### Added
- `agentbus ui` Project Board v5 (`src/ui/project.js`, `src/ui/server.js`, `src/ui/index.html`, `docs/UI.md`, `test/accept.mjs`):
  - **新增任务组件自动补全 (`auto_enrich`)**：手动加卡允许仅填写标题立即生成占位卡（自动生成稳定短代号 `PART_<HEX>` 并按关键字自动归入 `dev`/`debug` 分组），同时自动创建幂等的 `to = project.main_agent` 补全任务（`idempotency_key = enrich:<project_id>:<part_key>`），支持 `auto_enrich: false` 跳过。
  - **补全结果安全回填与重试**：任务完成后自动校验 `agentbus/part-enrich@1` JSON 并仅回填占位/空字段，严格保护用户手动编辑及 `manual_override` 字段；任务失败或校验失败时保留卡片、展示真实错误并支持 `POST /api/projects/:id/parts/:key/enrich` 重试补全。
  - **主 Agent 拆解/追加新卡自动同步入板**：主 Agent 拆解完成或追加卡片返回后，前端与读取接口自动同步入板（无需再手动点击合并），并对缺少字段的新增拆解卡自动触发补全（`POST /api/projects/:id/enrich-pending`），同时对 `hermes` 等不可直接派发的主 Agent 保持 `open` 与 `awaiting_main_agent: true`（待主 Agent 处理）。
- `agentbus ui` Project Board v4 (`src/ui/project.js`, `src/ui/server.js`, `src/ui/index.html`, `test/accept.mjs`):
  - **Task Stage Grouping (`groups` & `part.group`)**: projects expose `groups` (`dev` 研发组 order 0, `debug` 调试组 order 1) with backward-compatible defaults for legacy projects; `parts[].group` is validated across `agentbus/project-plan@1`, `agentbus/project-plan-delta@1`, workspace scan, and `POST/PATCH` part endpoints (invalid values rejected; omitted values inferred by debug/regression keywords or defaulted to `dev`).
  - **Adaptive Full / Compact Card Board**: full cards rendered per group when part count `<= 4`; automatically switches to compact square cards (title + assigned agent + lightweight status dot) when part count `>= 5`; clicking any compact card opens its full detail panel at the top of the board, pushes groups downward, highlights the selected card, and provides a collapse button while preserving batch selection, dispatch, auto-route, and regeneration.
  - **Module Code (`part.code`), Completion Tasks (`POST /api/projects/:id/parts/:key/complete`), and Dev Materials Archive (`dev_materials_dir`)**: unique per-project 1-32 char module codes with stable uppercase-key fallback for legacy parts; idempotent completion task creation (`to = project.main_agent`, keeping non-dispatchable `hermes` as `open` / awaiting main agent) with `completion_task_id`, `completed_at`, and `completion_status` (`pending`/`done`/`failed`); guided archival into `<workspace>/.agentbus/dev-materials/<module-code>/` (`manifest.json`, copy-only for bus envelopes, formal repo files untouched).
- `agentbus ui` v3 redesign & workflows (`src/ui/module-owners.js`, `src/ui/workspace.js`, updated `src/ui/project.js`, `src/ui/server.js`, `src/ui/index.html`):
  - **Module Board inline & batch owner editing**: edit each module's owner agent/model directly in-row or batch-update selected modules, persisted locally under `<busRoot>/module-owners.json` (atomic write, backup, unknown-field preservation, reset to default, strict validation; never mutates `src/ui/modules.json`).
  - **Controlled local folder picker & Read Existing Project**: browse/inspect allowed roots (`GET /api/workspace/browse`, `POST /api/workspace/inspect`) with strict realpath/symlink/traversal/drive-root boundaries; `POST /api/projects/read-existing` and `POST /api/projects/:id/rescan` scan existing files into compact relative-path manifests (`<busRoot>/scans/`) and generate honest `existing` / `partial` / `missing` cards.
  - **Ask Main Agent for new cards & Regenerate parts**: `POST /api/projects/:id/ask-cards` + `POST /api/projects/:id/apply-delta` dispatch delta card requests to the project's main agent and merge results while protecting manually overridden cards; `POST /api/projects/:id/parts/:key/regenerate` creates a fresh regeneration task carrying relative paths and implementation summaries while preserving `task_history` and blocking duplicate active runs (`409 active_task_exists`).
  - **UI redesign**: daylight architectural workbench palette, single-line header, mutually exclusive create/read/part-editor forms (never stacked simultaneously), plain typographic status hierarchy without decorative pill clutter, and preserved independent dual-pane vertical scrolling across `1440×900`, `1280×800`, `1024×768`, and mobile viewports.
- `agentbus ui` Project Task Board & Auto-Routing (`src/ui/project.js`, `src/ui/routes.js`, "项目看板" + "自动路由规则" tabs): creates projects persisted under `<busRoot>/projects.json`, dispatches bootstrap decomposition tasks directly to the chosen main agent (`to = main_agent`, auto-dispatch by default), validates `agentbus/project-plan@1` output into editable/reorderable working-copy part cards without overwriting raw `plan.json`, supports configurable local routing rules (`<busRoot>/project-routing.json`) with fallback to main agent and manual-override preservation, and dispatches parts directly to each part's real agent with active-task deduplication.
- `agentbus ui` independent dual-pane vertical scrolling (`min-height: 0`, `overflow-y: auto`, `overscroll-behavior: contain`) with fixed top header/tabs and explicit `route_mode` (`direct` vs `conductor`) recipient semantics on the module board.
- `agentbus ui` companion client ("主从配置" tab + `src/ui/client.js` + portable Windows launcher `bin/agentbus-ui.bat`): extends the loopback-only web UI with read-only local agent detection (`GET /api/client-config`), dry-run diff/backup preview (`POST /api/client-config/preview`), and explicit apply (`POST /api/client-config/apply`) for selecting one client-level conductor, workers, dispatch toggle, and per-agent models while preserving unknown fields in `agents.json` and reusing `setupClients` backups.
- `agentbus ui`: loopback-only, zero-dependency local web dashboard for the project's technical modules, owner/model badges, multi-module selection, and a conductor rework/optimize/reassign-model request flow; default task creation only, explicit `--dispatch` opt-in.
- `agentbus watch <id>`: read-only, single-task watcher with a 5s default interval, stable exit codes (done 0, failed/blocked/stalled 1, timeout 3), and no TTY/readline dependency. `dispatch --watch` keeps the dispatcher alive until the task reaches the same state.
- `agentbus doctor --bootstrap`: read-only clean-machine preflight for Node/sqlite, bus root, allowed roots, `agents.json`, client binaries, optional Antigravity CDP, and stale MCP processes.
- Offline tarball install path documented; `package.json` no longer contains a `USERNAME` placeholder.
- `docs/PORTABILITY.md` with the clean-machine checklist and a Linux/macOS CI matrix.
- `agentbus archive <conversation-id> [--port] [--title-prefix] [--dry-run]`: archives a sidebar conversation over CDP. Fails loudly when the app was not started with `--remote-debugging-port`.
- `agentbus onboard --archive-on-done`: persists `archive_on_done: true` in `agents.json`, so auto-archive survives restarts without an env var. `AGENTBUS_ARCHIVE_ON_DONE=1` still works as a one-off override.
- `agentbus/context@1` thread ledger (≤8KB) at `<busRoot>/contexts/<thread>.json`, with `proposed`/`confirmed` decisions, supersede rules, and `avoid[]` for failures.
- `ref_read` audit events and `warn`/`strict` gate on completion (`acceptance.require_ref_read`, `AGENTBUS_STRICT_REF_AUDIT`).
- Per-client thread policies and `threads` scope columns (`cwd`, `model`, `last_ok`, `step_source`, `rotated_from`); `task:<id>` rows are removed on terminal states.
- `agentbus context [<thread> | confirm <thread> <decision-id> --by <agent>]` and `new --thread`.
- Acceptance suite extended to 59 assertions (threads scope, per-client limits, ledger, audit, archive dry-run/mock CDP).

### Changed
- Redesigned the `agentbus ui` dashboard from a card-grid template into a compact engineering console: row-aligned module list, sticky scheduler inspector, graphite/warm-white/amber palette, no gradient/glow/glass treatment. API and request semantics are unchanged.

### Docs
- README now opens with the task-bus positioning, a lifecycle SVG, a sanitized UI screenshot, and a compact "where it differs" table; added `docs/COMMENT_POST.md` with a task-receipt style comment version.
- Repository landing README is now Chinese (`README.md`); the previous English README moved to `README.en.md`, and the Chinese long-form intro remains at `docs/INTRO.zh-CN.md`. `README.zh-CN.md` is kept as a compatibility copy.
- Added an all-Chinese project introduction at `docs/INTRO.zh-CN.md` with Chinese lifecycle/pointer SVGs; `README.zh-CN.md` links to it and uses the Chinese assets. The English README remains unchanged.

### Fixed
- `agentbus ui` v5 review follow-up fixes (`src/ui/index.html`, `src/ui/project.js`, `test/accept.mjs`):
  - 修复手动新增卡片（`source === 'manual'` 且 `manual_override === false`）在卡片详情元信息中误显示「拆解计划」的问题，现正确显示「手动添加」。
  - 修复 `createProject`、`readExistingProject`、`askMainAgentAddCards` 与 `retryProjectBootstrap` 在 `main_agent` 为不可直接派发客户端（如 `hermes`）且 `auto_dispatch: true` 时产生 `dispatch_error` 的问题，现与 `addProjectPart`/`completeProjectPart` 一致跳过派发、保持任务 `open` 并标记 `awaiting_main_agent: true`。
  - 修复 `src/ui/project.js` 中多处 `hydrateProjectRecord` 调用未透传自定义 `env` 的问题，并修复 `applyProjectCardDelta` 覆盖非手动卡片时遗漏保留 `enrichment_*` 字段的问题（与 `mergeDeltaPartsIntoList` 共用合并逻辑）。
- `agentbus ui` real-world dispatch & interaction bugs:
  - Fixed UI dispatch passing `wait_s: 3` to synchronous CLI adapters (`codex`/`claude`/`gemini`), which previously terminated agents after 5s with `adapter timeout after 5s` and triggered 120s cooldown; UI now runs real `dispatchTask` with a full work budget and an 800ms fast-fail probe while keeping synchronous semantics for explicit `wait_s` and tests.
  - Exposed per-agent `dispatchable` capability and prevented silent auto-dispatch failures on non-adapter MCP clients (e.g. `hermes`/`cursor`/`dsh`).
  - Fixed 4-second project polling calling `resetPartEditorForm()` and wiping user input mid-typing; polling now uses digest diffing and defers DOM refreshes while inline form controls are focused.
  - Fixed Module Board `adjust_model` submitting without a model when the target agent has no selectable models, allowed installed agents in module dispatch validation, added `/favicon.ico` 204 handling, and resolved project `plan_rel_path` in both `workspace_dir` and `pkgRoot`.
- CLI result output now uses `process.exitCode` instead of calling `process.exit()` immediately, so `agentbus list --limit 500` is not truncated to empty stdout on Linux/macOS (test 31). The agy daemon-dir test now uses the Windows `;` delimiter when simulating `win32`, so macOS/Linux CI exercises the same branch as Windows.
- Auto-archive no longer blocks task completion on the Antigravity stop button, retries until the finished row exposes archive, snapshots the conversation id before clearing threads, and records attempts/timeouts in `archive_on_done`.
- Auto-archive clicked the wrong row: the archive button is a sibling of the title node, so searching downward from the title always hit the first row's button in the list. Matching now associates each button with the sidebar title at the same vertical center (buttons are portalled), and archives every duplicate conversation for that task.
- Auto-archive missed freshly created conversations because the sidebar had not rendered them yet; it now retries until the finished row exposes archive, with an explicit 45 s / 15-attempt ceiling.
- Auto-archive never fired for long async tasks: it only ran in the dispatcher, which had already exited. It now runs in the process that completes the task (CLI `done` / MCP `bus_task_complete`).
- Active conversation rows hide their action button until hovered; archiving now moves a real mouse over the title and retries once.
- Unknown `AGENTBUS_ROLE` values exposed every tool, including dispatch. Any unrecognized role is now clamped to `worker` (least privilege) with one stderr warning.
- MCP `serverInfo.version` and `agentbus version` were hardcoded (`1.0.0` / `0.1.0`); both now read `package.json`.

### Changed
- `--thread` on Antigravity no longer reuses the conversation by default: it opens a fresh conversation and hands over via the ledger.
- `steps` is derived from Antigravity's conversation DB, Codex JSONL/stdout, or an 8-step-per-use fallback — no longer `0` for non-Antigravity agents.
- Failed, fast-failing, and empty conversations are no longer written to `threads`; a fallback model never inherits the failed session id.

### Added — dispatch & onboarding
- `bus_task_dispatch` tool and `agentbus dispatch <id>`: start the target agent's CLI and wait until the task reaches `done`. Off by default (`AGENTBUS_ENABLE_DISPATCH=1` / `--allow-dispatch`).
- Built-in adapters: `codex`, `claude`, `gemini`, `antigravity`; extensible with `AGENTBUS_ADAPTER_<NAME>`.
- Dispatch result reports `state` from the bus, not the child's exit code.
- `--thread <name>` / `thread` argument: session affinity via a `threads` table; Codex threads resume the recorded session id. Resumed Codex runs use `--dangerously-bypass-approvals-and-sandbox` because `exec resume` lacks `--approve-for-me`.
- `agentbus onboard`: detects installed agents, picks a conductor, asks which model each agent should use, stores answers in a git-ignored `agents.json`, and writes `AGENTBUS_ROLE` into every client config.
- Role enforcement: workers only see register/claim/heartbeat/ref_read/complete/fail; create/dispatch/verify are rejected.
- `agent_health` cooldown: capacity failures (503) pause an agent for 900s, other failures 120s; `dispatch --force` overrides. One success clears it.
- Per-agent model is taken from `agents.json` and passed to the adapter (`codex -m`, `claude --model`, `gemini -m`, antigravity `--model`).
- `bus_task_wait`: waits on bus state without starting a process, so a conductor can dispatch quickly and then poll without hitting client-side MCP call timeouts.
- Fix: `tools/call` now awaits async handlers. Previously `bus_task_dispatch` returned `{}` over MCP (a Promise serialized as an empty object), which clients reported as `Unexpected response type`.
- Model fallback: when a model fails with `model_not_found` / `not supported` / `503`, dispatch tries the configured value → `AGENTBUS_FALLBACK_MODELS` → known models → CLI default; each attempt is capped at 120s and model errors abort the wait immediately. `attempts` lists every try.
- Acceptance suite grew to 36 assertions: worker role gating (6 tools + rejected create), `bus_task_wait` returning real content (guards the async-await regression), and cooldown short-circuit without spawning a process.
- Fan-out dispatch: `agentbus dispatch <id1> <id2> ...` / MCP `ids:[...]` runs tasks concurrently (3 tasks: 2,899ms sequential → 910ms, 3.2×). Each result is returned in order.
- `bus_task_run` combines create + dispatch into one round-trip.
- MCP dispatch default wait lowered to 3s; conductors poll via `bus_task_wait` instead of blocking a single call.
- Polling tightened to 150ms for the first 8s (backing off to 400ms); dispatches now report `elapsed_s`. Overhead measured ~0.19s per dispatch with a 300ms fake agent.
- Acceptance now 37 cases (adds fan-out structure).
- Retries of one task reuse one conversation: dispatch records `task:<id>` in `threads`, so repeated 503 attempts no longer create a new sidebar entry each time. Antigravity resumes via `send-message`, Codex via `exec resume`.
- Thread limits: `AGENTBUS_THREAD_MAX_AGE_S` (7200), `AGENTBUS_THREAD_MAX_STEPS` (40), `AGENTBUS_THREAD_MAX_USES` (40). Antigravity step counts are read from its conversation DB, others fall back to reuse count.
- New-conversation titles carry a date prefix (`agentbus 11-24 <id>`).
- Acceptance now 39 cases (adds thread reuse and expiry).

## [0.1.0] — 2026-11-23

First public release.

### Added

- Pointer-based task envelope (`agentbus/task@1`): goal, refs (`uri` + `sha256` + `bytes`), acceptance rules.
- Artifact registry that stores metadata only — registering a 4 MB file adds ~48 KB to the database.
- SQLite storage via Node's built-in `node:sqlite`, WAL mode, `BEGIN IMMEDIATE` transactions.
- Lease-based claiming with heartbeat, lazy expiry, and `attempt`/`max_attempts` handling.
- Idempotent task creation via `(from_agent, idempotency_key)` unique index.
- Acceptance checks: `json`, `must_contain`, `must_not_contain`, `min_bytes`, `max_bytes`, `fields`.
- MCP stdio server with nine tools: `bus_register`, `bus_task_create`, `bus_task_claim`, `bus_task_heartbeat`, `bus_ref_read`, `bus_task_complete`, `bus_task_fail`, `bus_task_list`, `bus_verify`.
- Pointer semantics in `bus_ref_read`: inline up to 64 KB, `resource_link` above it.
- CLI with JSON-only stdout and exit codes `0` / `1` / `2`.
- `agentbus setup` auto-configures Codex, Claude Code, Gemini CLI, Antigravity, Cursor, OpenCode, and Claude Desktop (with timestamped backups).
- `agentbus doctor` and `agentbus clients`.
- Path allowlist enforced through `realpath`, blocking symlink and junction escapes.
- Self-contained acceptance suite: 31 assertions (32 with optional legacy fixtures), no framework, no shell pipes.
- GitHub Actions matrix across Linux/macOS/Windows and Node 22/24/26.

### Known limitations

- Same-machine only (`file://` references).
- CLI messages are Chinese; English localization planned.
- No background daemon; lease expiry is reclaimed lazily.
