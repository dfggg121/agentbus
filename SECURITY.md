# Security

## What agentbus is

A local, single-user task bus. It stores task metadata and file hashes, and it exposes nine narrowly scoped operations to MCP clients and the CLI. It is not a sandbox, a remote service, or a secrets manager.

## Default posture

- **No network listener.** MCP is stdio only. HTTP mode exists solely as `--http 127.0.0.1:<port>` and refuses non-loopback binds.
- **No shell execution.** No tool spawns a process, runs a command, or evaluates code.
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

## Reporting a vulnerability

Open a private security advisory on GitHub, or email the maintainer listed in `package.json`. Please include a minimal reproduction (Node version, platform, commands). Do not open a public issue for an unpatched vulnerability.

## Hardening checklist for shared machines

1. Use a per-user root (`~/.agentbus`), not a world-writable directory.
2. Keep `AGENTBUS_ALLOWED_ROOTS` as narrow as possible — the project directory, nothing above it.
3. Do not run the optional HTTP mode on untrusted networks.
4. Treat `setup` output as a config change: it writes MCP entries for agent CLIs that can then act on your files.
