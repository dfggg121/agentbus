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

Completion order is fixed: lease → re-hash every ref → result file exists → acceptance → persist → `done`.

---

## 6. MCP surface

Transport: newline-delimited JSON-RPC 2.0 over stdio (no `Content-Length` framing). `initialize` echoes a supported `protocolVersion` (`2025-06-18`, `2025-03-26`) or answers `2025-06-18`.

| Tool | Required | Optional |
|---|---|---|
| `bus_register` | `path` | `name`, `by` |
| `bus_task_create` | `to`, `goal`, `refs` | `constraints`, `acceptance`, `from`, `idempotency_key` |
| `bus_task_claim` | `id`, `by` | `ttl_s` |
| `bus_task_heartbeat` | `id`, `by`, `lease_token` | `ttl_s` |
| `bus_ref_read` | `id`, `name` | `max_bytes`, `encoding` |
| `bus_task_complete` | `id`, `by`, `lease_token`, `result_path` | `fields` |
| `bus_task_fail` | `id`, `by`, `lease_token`, `reason` | — |
| `bus_task_list` | — | `state`, `to`, `limit` |
| `bus_verify` | — | `id` |
| `bus_task_dispatch` | starts the target agent CLI, then waits | `id`, `cwd`, `wait_s`, `thread`, `force` |

`refs` accepts `["<sha256>", …]` or `[{"sha256": "...", "note": "..."}, …]`.

### Roles

`AGENTBUS_ROLE` (set by `agentbus onboard`, or by hand) trims the surface:

- `conductor` / unset: all ten tools.
- `worker`: `bus_register`, `bus_task_claim`, `bus_task_heartbeat`, `bus_ref_read`, `bus_task_complete`, `bus_task_fail`. Calls to `bus_task_create`, `bus_task_list`, `bus_verify` or `bus_task_dispatch` are rejected with `isError: true`, so a dispatched agent cannot spawn its own fan-out.

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
