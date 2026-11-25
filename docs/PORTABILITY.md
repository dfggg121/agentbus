# Portability and clean-machine checklist

`agentbus` has two layers with very different portability:

| Layer | Portable? | What it needs |
|---|---|---|
| Core CLI + MCP stdio server | Yes | Node.js >= 22.5, a writable bus root |
| Artifact pointers | Local only | `file://` refs; bus and files stay on one machine |
| Client auto-config (`setup`) | Mostly | The target client binary and its config directory |
| Agent dispatch | Per agent | Codex/Claude/Gemini/Antigravity/OpenCode installed and authenticated |
| Antigravity archive | Antigravity-specific | App launched with `--remote-debugging-port=<n>` |
| Completion watcher | Host-specific | The host process must keep the `watch` process alive and notify on exit |
| Linux/macOS | Implemented, not yet hardware-verified | Run the CI matrix and report the real result |

## Offline install on another machine

On the source machine:

```bash
cd agentbus
npm pack --pack-destination /tmp
sha256sum /tmp/agentbus-mcp-*.tgz
```

Copy the `.tgz` and its checksum to the target machine. On the target:

```bash
node --version          # must be >= 22.5
npm install -g ./agentbus-mcp-0.2.0.tgz
agentbus version
agentbus setup --list
```

Project-local alternative:

```bash
npm install --prefix ./agentbus-local ./agentbus-mcp-0.2.0.tgz
./agentbus-local/node_modules/.bin/agentbus setup --list
```

`npx agentbus-mcp` only works after the package is published to npm. The
offline tarball is the supported install path for now.

## Before using a real client

```bash
agentbus doctor --bootstrap --root ~/.agentbus
agentbus setup --client codex --root ~/.agentbus --allow /path/to/project
# restart the client, then verify the MCP process exists
agentbus list --root ~/.agentbus
```

`doctor --bootstrap` is read-only. It checks Node/sqlite, the bus root,
allowed roots, `agents.json`, client binaries, optional archive CDP, and stale
MCP processes. It never edits a client config, kills a process, or restarts an
application.

## Things that do not travel in the tarball

- `agents.json` (models, roles, `archive_on_done`) — machine- and account-specific.
- Client configs and credentials — intentionally never packaged.
- Existing bus database, refs, tasks, and results — create a new bus on the target.
- Antigravity daemon coordinates and CDP ports — runtime-specific.
- The Hermes-side notification adapter — host-specific; use the product `watch`
  command, not a copied Python path.
- Model names — `onboard` must choose models available on that account.

## Common failures after a move

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot find module ...bus.js` | tarball not installed / wrong prefix | run the installed `.bin/agentbus` |
| `node:sqlite` missing | Node < 22.5 | install Node 22.5+ |
| `find ref failed` / path outside allowed roots | project not allowed | `setup --allow <project>` |
| dispatch skipped | no conductor role or dispatch disabled | `setup --role conductor --allow-dispatch` |
| `dial tcp ... connection refused` | stale Antigravity session | re-export session / restart app |
| archive fails with CDP error | app not started with debug port | launch with `--remote-debugging-port=9222` or skip archive |
| MCP tool returns old behavior | client still runs old `bus.js mcp` child | restart the client; `doctor --bootstrap` flags stale processes |
| completion notification missing | no host watcher running | `agentbus watch <id>` in a supervised process |

## Release gate

A release is only called cross-machine ready after:

1. `npm pack` and a clean local install pass;
2. `node test/accept.mjs` passes on Windows;
3. the CI matrix passes on Linux and macOS (not merely platform-branch unit tests);
4. a second machine runs one real task end to end and leaves a verified result.
