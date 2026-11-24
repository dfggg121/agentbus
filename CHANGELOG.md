# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Added
- `agentbus archive <conversation-id> [--port] [--title-prefix] [--dry-run]`: archives a sidebar conversation over CDP; `AGENTBUS_ARCHIVE_ON_DONE=1` archives the conversation once a task reaches `done`. Fails loudly when the app was not started with `--remote-debugging-port`.
- `agentbus/context@1` thread ledger (≤8KB) at `<busRoot>/contexts/<thread>.json`, with `proposed`/`confirmed` decisions, supersede rules, and `avoid[]` for failures.
- `ref_read` audit events and `warn`/`strict` gate on completion (`acceptance.require_ref_read`, `AGENTBUS_STRICT_REF_AUDIT`).
- Per-client thread policies and `threads` scope columns (`cwd`, `model`, `last_ok`, `step_source`, `rotated_from`); `task:<id>` rows are removed on terminal states.
- `agentbus context [<thread> | confirm <thread> <decision-id> --by <agent>]` and `new --thread`.
- Acceptance suite extended to 59 assertions (threads scope, per-client limits, ledger, audit, archive dry-run/mock CDP).

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
