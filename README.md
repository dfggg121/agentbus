# agentbus

**Hand tasks between agents by reference, not by copy.**

`agentbus` is a local task bus for multi-agent workflows. A task envelope contains a goal, acceptance criteria, and **pointers** (`uri` + `sha256`) to the files the receiving agent needs — never the file contents. Agents claim tasks, read references from disk themselves, and hand back a result whose hash is verified before the task is marked done.

- Zero dependencies. SQLite through Node's built-in `node:sqlite`.
- One MCP stdio server — works with Codex, Claude Code, Gemini CLI, Antigravity, Cursor, OpenCode, Claude Desktop.
- The same operations are available as a CLI, so cron jobs, batch files, and non-MCP agents can use it.
- Never copies payloads. Registering a 4 MB artifact costs about **48 KB** of database.

---

## Why

If you run more than one coding agent, you know the pattern: every handoff recreates a "task package" that embeds the specs, the logs, the CSV, the policy file — and the next agent re-reads them from scratch. The payload is duplicated on every hop, and by the third hop nobody knows which copy is current.

`agentbus` keeps one copy on disk and passes a receipt: path, size, SHA-256. Measured on the reference task in this repo:

| | Task package (copy) | agentbus (pointer) |
|---|---|---|
| Envelope size | 4,195,256 B | **2,025 B** |
| Copies of the 4 MB payload | one per hop | 0 |
| Can detect a stale input | no | yes — `sha256` mismatch blocks completion |

---

## Install

Requires **Node.js ≥ 22.5** (for `node:sqlite`).

```bash
npx agentbus-mcp setup --client codex
```

`setup` writes the MCP server entry into the client's config (with a timestamped backup) and prints what it touched. Supported ids:

```
codex  claude  gemini  antigravity  cursor  opencode  claude-desktop
```

Pick several at once:

```bash
npx agentbus-mcp setup --client codex --client claude --client gemini
npx agentbus-mcp doctor      # show what is configured
npx agentbus-mcp clients     # list supported ids
```

By default the bus lives in `~/.agentbus` and only files inside it may be referenced. Pass `--allow` for the project you actually work in:

```bash
npx agentbus-mcp setup --client codex --root ~/.agentbus --allow ~/projects/my-app
```

Restart the client afterwards — MCP servers are loaded at startup.

> Tip: a per-project bus works well too: `--root .agentbus --allow .`

---

## 60-second tour

```bash
# 1. register a file: metadata + hash only, never a copy
agentbus put ./specs/report.md --by planner

# 2. create a task for another agent, pointing at that hash
agentbus new --to codex \
  --goal "Build report.json following specs/report.md" \
  --ref <sha256-from-step-1> \
  --from planner \
  --accept json=true --accept must_contain=total_kwh

# 3. the other agent claims it and reads the reference itself
agentbus claim <task-id> --by codex
agentbus ref   <task-id> --name report.md     # text if small, resource_link if > 64 KB

# 4. hand back a result; refs are re-hashed and acceptance rules enforced
agentbus done <task-id> --by codex --lease <token> --result ./out/report.json
```

`done` fails if any referenced file changed since registration (`drift`), if an acceptance rule does not match, or if the lease does not belong to the caller. There is no "trust me, it's done" path.

From an MCP-capable agent the same flow is four tool calls: `bus_register` → `bus_task_claim` → `bus_ref_read` → `bus_task_complete`.

---

## How it works

```
planner ──put──▶ artifacts(sha256, uri, bytes)        ← metadata only
        └─new──▶ tasks/<id>.json  {goal, refs[], acceptance}
                                 │
                     MCP: bus_task_claim (lease)
                                 ▼
                        executor agent
                     reads refs from disk itself
                                 │  writes result file
                                 ▼
        bus_task_complete → re-hash refs → run acceptance → done
```

- **States**: `open → claimed(lease) → done | failed`. Expired leases return the task to `open` with `attempt + 1`.
- **Leases**: 900 s default, renewable with `heartbeat`; every mutation checks the token.
- **Idempotency**: `--key` makes task creation safe to retry.
- **Pointer semantics**: `bus_ref_read` inlines only files up to 64 KB; larger ones return an MCP `resource_link` so the agent fetches them directly.
- **Integrity**: SHA-256 is recomputed on read, on completion, and during `verify`.

Protocol details: [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

---

## MCP tools

| Tool | Purpose |
|---|---|
| `bus_register` | Register a file by path; returns `sha256`, `uri`, `bytes` |
| `bus_task_create` | Create a task from refs + acceptance (optional idempotency key) |
| `bus_task_claim` | Claim a task and receive a lease token |
| `bus_task_heartbeat` | Extend a lease |
| `bus_ref_read` | Read a reference (text, base64, or `resource_link` when large) |
| `bus_task_complete` | Validate refs + acceptance, store the result hash, close the task |
| `bus_task_fail` | Close a task as failed with a reason |
| `bus_task_list` | List tasks (`state`, `to`, `limit`) |
| `bus_verify` | Re-hash every ref and result; report drift |
| `bus_task_dispatch` | **Opt-in**: start the target agent CLI for a task and wait for its result |

### Active dispatch

A task board needs someone to tell the other agent to pick work up. Dispatch removes that step: `bus_task_dispatch` (or `agentbus dispatch <id>`) starts the target agent's CLI, waits for it to claim/complete, and returns the result hash.

```bash
AGENTBUS_ENABLE_DISPATCH=1 agentbus dispatch <task-id> --cwd . --wait 600
```

It is off by default because it gives the bus the ability to start processes. Adapters ship for `codex`, `claude`, `gemini` and `antigravity`; anything else can be wired with `AGENTBUS_ADAPTER_<NAME>` (JSON `{command, args}` where `{prompt}` is substituted).

Dispatch trusts the bus, not the child process: if the spawned agent exits without calling `bus_task_complete`, the result is `state=claimed`, not success.

**Threads (session affinity).** `--thread <name>` keeps a conversation: the first run records the agent's session id, later tasks in the same thread resume it instead of starting cold. Codex's `exec resume` has no `--approve-for-me`, so resumed runs pass `--dangerously-bypass-approvals-and-sandbox` — see SECURITY.md before using threads.

Antigravity's coordinates (`ANTIGRAVITY_LS_ADDRESS`, `ANTIGRAVITY_CSRF_TOKEN`) live only inside its own runtime. The adapter reads an exported session file first, then falls back to the running app's `daemon/hub_*.json`, which carries the CSRF token and the HTTP port. If neither is found, run this inside Antigravity's integrated terminal:

```bash
node <agentbus>/bin/bus.js agy-session --out <bus-root>/antigravity-session.json
```

The file is written 0600 and expires when the app restarts. Note the port changes on every restart, so never hardcode it.

Antigravity starts conversations asynchronously, so `dispatch` can return while the task is still `open`. Wait on the bus instead of on the child process:

```bash
agentbus wait <task-id> --timeout 900
```

### Onboarding: detect agents, split roles

```bash
agentbus onboard --conductor codex --allow /path/to/workspace
```

It scans PATH and known install locations for Codex, Claude Code, Gemini CLI, Antigravity and OpenCode, picks one **conductor** (can create/dispatch/verify) and writes the rest as **worker**. It then asks which model each agent should default to and stores the answers in `agents.json` in the bus root (git-ignored), and rewrites each client's MCP config with `AGENTBUS_ROLE`.

Roles are enforced, not cosmetic: a worker's `tools/list` returns only six tools (register / claim / heartbeat / ref_read / complete / fail), and calling `bus_task_create` or `bus_task_dispatch` is rejected — a dispatched agent cannot dispatch further.

Model choices stay local: the repo ships the ask/store/apply mechanism, never anybody's preferences.

### Health cooldown

When an agent fails because of upstream capacity (e.g. `503 No capacity available`), the bus records a cooldown (900s for capacity, 120s otherwise). `dispatch` then returns `skipped: true` with the expiry instead of waiting; pass `--force` to retry anyway. One success clears it.

---

## Security model

- No network listener by default (stdio MCP). Optional HTTP mode binds `127.0.0.1` only.
- Reference paths must resolve inside `AGENTBUS_ALLOWED_ROOTS`. Symlinks and Windows junctions are resolved with `realpath` first, so escapes are rejected.
- Payloads are never stored in the database — only `uri`, `bytes`, `sha256`.
- No shell, no arbitrary file write, no credential access.
- Config edits made by `setup` are backed up as `<file>.bak-<timestamp>`.

Details and reporting: [`SECURITY.md`](SECURITY.md).

---

## Compatibility

| Client | Auto-config | Verified |
|---|---|---|
| OpenAI Codex CLI | `--client codex` | ✅ 2026-11 — full claim → complete loop |
| Claude Code | `--client claude` | config only |
| Gemini CLI | `--client gemini` | config only |
| Google Antigravity | `--client antigravity` | config only |
| Cursor | `--client cursor` | config only |
| OpenCode | `--client opencode` | config only |
| Claude Desktop | `--client claude-desktop` | config only |

Any MCP client that speaks stdio JSON-RPC works; `setup` just automates the common ones.

---

## Known limitations

- **Same machine only.** References are `file://` URIs. Cross-machine handoff needs an HTTP-backed artifact store; the envelope shape would not change.
- **CLI messages are currently Chinese.** English/localized messages are on the roadmap; MCP results are JSON and language-neutral.
- **No background daemon.** Lease expiry is reclaimed lazily on the next read/write.
- **Node ≥ 22.5 required**, since SQLite comes from `node:sqlite`.

---

## Related work

| Project | What it does | How it differs |
|---|---|---|
| [turnbus](https://github.com/jgreen01/turnbus) | SQLite message bus + MCP; wakes idle agent turns | messaging and wakeups, not artifact handoff |
| [multiagents](https://github.com/zetbrush/multiagents) | broker + orchestrator with roles and review loops | full team platform; agentbus is a thin bus |
| [agentmesh](https://github.com/BlueHeisenberg/agentmesh) | LAN mesh, mDNS + mTLS | cross-machine messaging; agentbus is local and file-centric |
| [A2A](https://github.com/a2aproject/A2A) | cross-vendor HTTP agent protocol | heavyweight for one machine; envelope fields map cleanly |

`agentbus` deliberately does one thing: **make a handoff auditable without duplicating the payload.**

---

## Development

```bash
git clone https://github.com/USERNAME/agentbus.git
cd agentbus
node test/accept.mjs     # 31 assertions, self-contained
```

The suite generates its own fixtures, spawns real CLI processes, opens the real SQLite database, and speaks real MCP over stdio. No test framework, no shell pipes (a piped exit code is a lie).

MIT licensed. Contributions welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md).
