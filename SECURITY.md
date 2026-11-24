# Security

## Opt-in process execution

`bus_task_dispatch` starts a local CLI. It is off unless `AGENTBUS_ENABLE_DISPATCH=1` or `--allow-dispatch` is passed. It never sends task content over the network; the child process runs with the caller's OS permissions and the configured `cwd`.

## Archiving uses CDP (loopback only)

`agentbus archive` connects to `http://127.0.0.1:<port>/json` and a local WebSocket to click the sidebar archive button. It requires the target app to run with `--remote-debugging-port=<n>`; the port is not opened by agentbus, and no data leaves the machine. `--dry-run` matches the row without clicking. Agentbus refuses to claim success when the port is closed.

## Thread ledger and audit are advisory by default

`context@1` holds decisions and artifact pointers, not payloads, and is capped at 8KB. Only a `confirmed` decision (confirmed by an agent other than the proposer) can supersede an existing one. `ref_read` auditing defaults to `warn`: completion still succeeds with a warning. Set `acceptance.require_ref_read=true` or `AGENTBUS_STRICT_REF_AUDIT=strict` to reject completions that did not read their refs.

## What agentbus is

A local, single-user task bus. It stores task metadata and file hashes, and it exposes twelve narrowly scoped operations to MCP clients and the CLI. `bus_task_dispatch` / `bus_task_run` are off unless explicitly enabled. It is not a sandbox, a remote service, or a secrets manager.

## Default posture

- **No network listener.** MCP is stdio only. HTTP mode exists solely as `--http 127.0.0.1:<port>` and refuses non-loopback binds.
- **No shell execution by default.** No always-on tool spawns a process, runs a command, or evaluates code. `bus_task_dispatch` is the single exception and requires `AGENTBUS_ENABLE_DISPATCH=1` (or `--allow-dispatch`); see *Opt-in process execution* below.
- **No arbitrary writes.** The bus writes inside its own root: the SQLite database, `events`, and task/result records. Result files are written by the calling agent, not by the bus.
- **No payload storage.** Referenced file contents are never inserted into SQLite, logs, or envelopes — only `uri`, `bytes`, and `sha256`.
- **Path allowlist.** Every reference is resolved with `realpath` and must be inside `AGENTBUS_ALLOWED_ROOTS`. Symlinks and Windows junctions pointing outside are rejected.
- **Size cap.** Registration refuses files above `max_ref_bytes` (default 2 GiB).

## Integrity guarantees

| Threat | Control |
|---|---|
| Input changed after the task was written | SHA-256 recomputed at read and completion; mismatch blocks `done` (`drift`) |
| Result swapped after completion | `verify` re-hashes results; mismatch reports `bad` and exits 1 |
| Two agents doing the same task | Lease + token; only one claim can succeed |
| Retry creating duplicate tasks | `(from_agent, idempotency_key)` unique index |
| Agent claims a task not addressed to it | `to` must match `by` (or be `*`) |

## What it does not protect against

- A malicious agent that already has read access to the allowlisted directories. The bus constrains what it *records*, not what the OS lets the process read.
- Prompt injection inside referenced documents. A reference is data; agents should treat it as untrusted input.
- Local attackers with write access to the database file. File-system permissions are the boundary.
- Cross-machine transport (not implemented).

## Opt-in process execution (`bus_task_dispatch`)

Dispatch starts another agent's CLI so a caller can hand off work without a human relay. It is disabled unless `AGENTBUS_ENABLE_DISPATCH=1` is set (CLI: `--allow-dispatch`).

- Only the adapter table is executable: `codex`, `claude`, `gemini`, `antigravity`, or a name you provide via `AGENTBUS_ADAPTER_<NAME>`. The task's `to` field selects the adapter; it is not a free-form command line.
- The child runs with the bus's own user and environment. Treat enabling dispatch as equivalent to letting any MCP client run these agent CLIs.
- Success is decided by the bus, not the child: the task must reach `state=done` through `bus_task_complete`. A clean child exit without completion is reported as `state=claimed`.
- On Windows, `.cmd`/`.bat` adapters are launched through `cmd.exe /d /s /c` with explicit quoting; the prompt is passed on stdin, never interpolated into a shell string.
- Antigravity's adapter reads a session file written by `agy-session` inside Antigravity's own terminal. The file holds the CSRF token, is written 0600, is session-scoped, and must never be committed. Treat it like a password for the running app.
- **Threads are weaker than they look.** Codex's `exec resume` does not accept `--approve-for-me`, so resuming a conversation requires `--dangerously-bypass-approvals-and-sandbox`, which strips Codex's own sandbox for that run. If you are not willing to accept that, do not use `--thread` with Codex; use a fresh run with a pointer to the previous result instead.

## Reporting a vulnerability

Open a private security advisory on GitHub, or email the maintainer listed in `package.json`. Please include a minimal reproduction (Node version, platform, commands). Do not open a public issue for an unpatched vulnerability.

## Hardening checklist for shared machines

1. Use a per-user root (`~/.agentbus`), not a world-writable directory.
2. Keep `AGENTBUS_ALLOWED_ROOTS` as narrow as possible — the project directory, nothing above it.
3. Do not run the optional HTTP mode on untrusted networks.
4. Treat `setup` output as a config change: it writes MCP entries for agent CLIs that can then act on your files.
