# Protocol

Status: **v0.1 (stable enough to implement against)**. Schemas are versioned in the `schema` field, so future changes can be additive.

- Envelope: `agentbus/task@1`
- Artifact: `agentbus/artifact@1`
- Result: `agentbus/result@1`

---

## 1. Artifact

Registration stores metadata only. The file stays where it is.

```json
{
  "schema": "agentbus/artifact@1",
  "sha256": "208aeaff5517fa28b95461260074a111c1dd590732aec4f853ed5f788a8cae23",
  "bytes": 4194304,
  "name": "policy.bin",
  "uri": "file:///home/me/app/demo/refs/policy.bin",
  "registered_by": "hermes",
  "registered_at": "2026-11-23T08:03:27.214Z",
  "mtime": "2026-11-23T08:03:26.795Z"
}
```

Rules:

- `uri` is always an absolute `file://` URI (percent-encoded).
- `sha256` is lowercase hex and is recomputed from disk before every read and before every completion.
- `name` defaults to the basename.
- Registering the same content twice returns the same row (`reused: true`), even from a different path.

---

## 2. Task envelope

```json
{
  "schema": "agentbus/task@1",
  "id": "tmwszbfbh8d2f",
  "created_at": "2026-11-23T08:04:02.001Z",
  "from": "hermes",
  "to": "codex",
  "state": "open",
  "goal": "Build out/report.json following refs/SPEC.md",
  "constraints": ["do not modify refs"],
  "refs": [
    {
      "name": "SPEC.md",
      "uri": "file:///home/me/app/demo/refs/SPEC.md",
      "sha256": "c98581e6…",
      "bytes": 612,
      "note": "the requirements"
    }
  ],
  "acceptance": {
    "json": "true",
    "must_contain": "policy_sha256",
    "min_bytes": "40"
  },
  "result": null,
  "history": [
    { "at": "2026-11-23T08:04:02.001Z", "state": "open", "by": "hermes" }
  ]
}
```

`refs[].note` is free text and optional. `to` may be `"*"` to allow any claimant.

**Invariant: the envelope never contains payload bytes.** A conforming implementation must keep every line under 300 characters and must not embed any 40-byte substring of a referenced file. `test/accept.mjs` asserts this.

---

## 3. Result

```json
{
  "schema": "agentbus/result@1",
  "task": "tmwszbfbh8d2f",
  "state": "done",
  "result_sha256": "c300dca9…",
  "result_bytes": 172,
  "at": "2026-11-23T09:41:13.512Z"
}
```

The task's `result` field carries `{uri, sha256, bytes, by, at}`, where `sha256` is the hash of the produced file.

---

## 4. States and leases

```
        claim(by, ttl)                complete(by, lease)
open ─────────────────▶ claimed ─────────────────────────▶ done
  ▲                       │
  │  lease expired        └──────── fail(by, lease) ─────▶ failed
  └─── attempt += 1
```

| Rule | Detail |
|---|---|
| Who may claim | `to == by` or `to == "*"` |
| Lease token | 16 random bytes, hex |
| Default TTL | 900 s (`lease_ttl_s`) |
| Renewal | `heartbeat` extends expiry, never changes the token |
| Expiry | reclaimed lazily by the next `claim`/`heartbeat`/`complete`/`fail`/`list`/`show`/`verify` |
| Retries | `attempt` increments per reclaim; above `max_attempts` (default 3) the task becomes `failed` with `reason = lease_expired` |
| Terminal states | `done`, `failed` — any claim returns exit code 2 |

---

## 5. Acceptance keys

| Key | Meaning |
|---|---|
| `json` | `"true"` → the result must parse as JSON |
| `must_contain` | string or array of strings; all must appear in the result text |
| `must_not_contain` | string or array; none may appear |
| `min_bytes` / `max_bytes` | size bounds, numeric strings |
| `fields` | map; each key must equal the parsed JSON's top-level value (numbers compared numerically) |
| `allow_ref_drift` | `"true"` / `true` → complete proceeds with `complete_with_ref_drift` event and warning even if a ref changed |

Completion order is fixed: lease → re-hash every ref → result file exists → acceptance → persist → `done`. Failures in ref drift, acceptance, or `require_ref_read` persist a `kind=error` message and `blocked_at` before throwing.

---

## 6. MCP surface

Transport: newline-delimited JSON-RPC 2.0 over stdio (no `Content-Length` framing). `initialize` echoes a supported `protocolVersion` (`2025-06-18`, `2025-03-26`) or answers `2025-06-18`.

| Tool | Required | Optional |
|---|---|---|
| `bus_register` | `path` | `name`, `by` |
| `bus_task_create` | `to`, `goal`, `refs` | `constraints`, `acceptance`, `from`, `idempotency_key`, `thread` |
| `bus_task_claim` | `id`, `by` | `ttl_s` |
| `bus_task_heartbeat` | `id`, `by`, `lease_token` | `ttl_s` |
| `bus_ref_read` | `id`, `name` | `max_bytes`, `encoding`, `by` |
| `bus_task_complete` | `id`, `by`, `lease_token`, `result_path` | `fields` |
| `bus_task_fail` | `id`, `by`, `lease_token`, `reason` | — |
| `bus_task_recover` | `id`, `by`, `action` | `reason`, `to`, `result_path`, `allow_ref_drift`, `fields` |
| `bus_task_list` | — | `state`, `to`, `limit` |
| `bus_verify` | — | `id` |
| `bus_task_dispatch` | starts the target agent CLI, then waits | `id`, `ids`, `cwd`, `wait_s` (default 3 over MCP), `thread`, `force` |
| `bus_task_wait` | waits on bus state, stalled expiry, or new attention messages | `id`, `timeout_s`, `since_id` |
| `bus_task_run` | create + dispatch in one call | `to`, `goal`, `refs`, `acceptance`, `cwd`, `wait_s`, `thread` |
| `bus_task_message` | `id`, `by`, `body` | `kind`, `to`, `lease_token` |
| `bus_task_inbox` | `id` | `for_agent`, `since_id`, `mark_read`, `limit` |

`refs` accepts `["<sha256>", …]` or `[{"sha256": "...", "note": "..."}, …]`.

`bus_task_claim` returns the full task envelope (`goal`, `constraints`, `refs`, `acceptance`, `from`, `created_at`, `attempt`, `blocked_at`, `heartbeat_hint`, and `thread` when set) alongside `lease_token` and `lease_expires_at`, so `dispatch` prompts only pass a short pointer (`id=...`, `by=...`) and never inline `goal` text or shell-quoted payloads.

### Task recovery (`bus_task_recover` / `agentbus recover`)

Recovers stuck `open` or `claimed` tasks without requiring an active lease:

- `retry`: clears lease & `blocked_at`, returns to `open` (same `to`), increments `attempt`.
- `release`: same as `retry` without incrementing `attempt`.
- `fail`: transitions to `failed`, clears lease & `blocked_at`, records a `kind=error` message.
- `reassign`: changes `to` to the new agent, clears lease & `blocked_at`, returns to `open`.
- `adopt`: transitions `open`/`claimed` to `done` using an existing validated `result_path` (respects `acceptance`; `allow_ref_drift=true` records `recover_adopt` and permits drifted refs).

Minimal CLI example:

```bash
agentbus recover <id> --by hermes --action adopt --result /abs/path/report.json --allow-drift --reason "adopting verified output"
```

### Bidirectional task messages

`bus_task_message` (CLI: `agentbus message`) and `bus_task_inbox` (CLI: `agentbus inbox`) provide an in-task feedback channel stored in SQLite (`task_messages` table, never written into `tasks/<id>.json` envelopes):

- `kind`: `note`, `progress`, `question`, `blocked`, `answer`, `error`.
- **Lease guard**: when the current claimant (`claimed_by`) sends a message as a worker, a valid `lease_token` is required. The conductor/initiator may reply (`answer`) without a lease token.
- **Attention & unblock**: `question`, `blocked`, or `error` sets `tasks.blocked_at` (and `bus_task_fail` / non-zero `dispatch` exit automatically record an `error` message). A conductor `answer` clears `blocked_at`.
- **Early wakeup**: `bus_task_wait` returns early with `needs_attention: true` as soon as a new `question`, `blocked`, or `error` message (`seq > since_id`) arrives.
- **Cursor & read tracking**: `bus_task_inbox` supports `for_agent`, `since_id`, `mark_read`, and returns `last_seq`, `blocked`, `blocked_at`, and `messages`.

### Threads

- `task:<id>` is recorded automatically on first dispatch, so retries of the same task continue the same conversation (including after a 503). The row is deleted when the task reaches `done` or `failed`.
- Explicit `--thread <name>` is scope-checked: `cwd`, `model` and `last_ok` must match, or a fresh conversation is started and the ledger is snapshotted (`thread_rotated` event).
- Per-client limits (`CLIENT_THREAD_POLICIES`, overridable via `AGENTBUS_THREAD_LIMITS_JSON` or `AGENTBUS_<CLIENT>_MAX_*`):

  | client | max_steps | max_age_s | max_idle_s | max_uses | allow_cross_task |
  |---|---|---|---|---|---|
  | antigravity | 20 | 3600 | 1800 | 3 | false |
  | codex | 60 | 7200 | 1800 | 6 | true |
  | default | 40 | 7200 | 1800 | 10 | true |

- When `allow_cross_task` is false, `--thread` does not error: it starts a fresh conversation and attaches the `context@1` ledger pointer instead.
- `steps` comes from the conversation DB (Antigravity), Codex JSONL/stdout, or 8 steps per use (`fallback_uses`); it is never hard-coded to 0.
- New conversations are titled `agentbus MM-DD <task-id>`.

### Context ledger `agentbus/context@1`

Stored at `<busRoot>/contexts/<thread>.json`, capped at 8192 bytes, registered as the `thread_context.json` ref:

| field | meaning |
|---|---|
| `contract_refs[]` | `{name, uri, sha256}` of inputs that must not drift |
| `decisions[]` | `{id, statement, supersedes, status: proposed\|confirmed, proposed_by, confirmed_by, evidence_sha256}` |
| `latest_artifacts[]` | `{role, uri, sha256, task_id, summary}` |
| `avoid[]` | `{task_id, reason}` — failures only, never pollutes decisions |

Write points: `done` (artifacts + proposals), `failed` (avoid only), and rotation (snapshot before a new conversation). A supersede removes the old decision **only after the replacement is confirmed**; `confirmed_by` must differ from `proposed_by`.

### ref_read audit

`bus_ref_read` appends a `ref_read` event (`{name, sha256, bytes, mode}`). On `complete`, refs without a matching read are reported:

- `off` — skip;
- `warn` (default) — task still completes, `warnings: ["completed_without_bus_ref_read"]` + `complete_audit_warning` event;
- `strict` — rejected with exit 1, task stays `claimed`, `complete_audit_rejected` event; enable per task with `acceptance.require_ref_read=true` or globally with `AGENTBUS_STRICT_REF_AUDIT=strict`.

### Archiving conversations

`agentbus archive <conversation-id> [--port N] [--title-prefix P] [--title-contains T] [--dry-run]` finds the sidebar row over CDP and clicks `button[aria-label="归档对话"]`. Buttons are portalled outside the row, so matching pairs each button with the sidebar title at the same vertical center; a task id appearing in chat text can never select a different row. The app must run with `--remote-debugging-port=<n>`; an unreachable port is an explicit error. Auto-archive is enabled persistently with `agentbus onboard --archive-on-done` (stored as `archive_on_done` in `agents.json`) or per run with `AGENTBUS_ARCHIVE_ON_DONE=1`. It runs in the process that completes the task (CLI `done` or MCP `bus_task_complete`), archives every conversation titled `agentbus MM-DD <taskid>`, re-tries up to 6 times while the sidebar renders, hovers the active row once if its button is hidden, and only appends an `archive_on_done` event on failure.

### Roles

`AGENTBUS_ROLE` (set by `agentbus setup --role` or `agentbus onboard`, or by hand) trims the surface:

- `conductor` / `all` / unset: all 15 tools.
- `worker` (or any unrecognized role, falling back to least privilege): 9 tools — `bus_register`, `bus_task_claim`, `bus_task_heartbeat`, `bus_ref_read`, `bus_task_complete`, `bus_task_fail`, `bus_task_recover` (restricted to tasks where `by` is `from` or `to`), `bus_task_message`, `bus_task_inbox`. Calls to `bus_task_create`, `bus_task_list`, `bus_verify`, `bus_task_dispatch`, `bus_task_wait`, or `bus_task_run` are rejected with `isError: true`, so a dispatched agent cannot spawn its own fan-out.

Per-agent model choices live in `<bus root>/agents.json` (`{ "conductor": "codex", "models": { "antigravity": "gemini-4-neon" } }`), written by onboarding and read at dispatch time. The file is git-ignored; the protocol never carries preferences.

`agent_health` records cooldowns (`capacity/503` → 900 s, other failures → 120 s). A cooled-down agent is skipped unless `force` is set; a successful `done` clears the row.

Tool failures use `isError: true` inside `result`, with `structuredContent.error`. Protocol-level errors (`-32601`, `-32602`) are reserved for malformed requests.

### Pointer semantics for `bus_ref_read`

- ≤ `ref_read_inline_max` (default 65536 B): `{"type":"text","text":"…"}`, base64 for non-UTF-8.
- Above the limit: `{"type":"resource_link","uri":"file://…","name":…,"mimeType":…,"size":…}` and **no** payload text. `structuredContent` carries `{type, uri, sha256, bytes}`.
- Every read re-hashes the file; drift yields `isError`.

---

## 7. CLI exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | argument / path / drift / acceptance failure |
| 2 | state or lease disallows the operation |

stdout carries a single JSON document. Diagnostics go to stderr. This is deliberate: an agent can parse stdout blindly.

---

## 8. Environment

| Variable | Meaning |
|---|---|
| `AGENTBUS_ROOT` | default bus directory |
| `AGENTBUS_ALLOWED_ROOTS` | path-delimiter-separated allowlist |
| `AGENTBUS_AGENT` | default `--by` value |
| `AGENTBUS_COMPAT_DIR` | test-only: legacy envelopes for the compatibility assertion |
