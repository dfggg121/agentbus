# Contributing

Thanks for taking a look. This project is intentionally small; the bar for new surface area is high.

## Ground rules

1. **Zero runtime dependencies.** SQLite comes from `node:sqlite`. A PR that adds a dependency needs a very good reason.
2. **No shell-outs in library code.** Tests may spawn the CLI, nothing else.
3. **No payload storage.** The bus must never write referenced file contents into the database, logs, or envelopes.
4. **Pointer semantics are load-bearing.** `bus_ref_read` returns `resource_link` above the inline threshold. Do not "helpfully" inline large files.
5. **Exit codes are API.** `0` ok, `1` validation, `2` state/lease. Do not repurpose them.

## Development

```bash
git clone https://github.com/USERNAME/agentbus.git
cd agentbus
node --version          # must be >= 22.5
node test/accept.mjs    # 31 assertions
```

With the optional legacy fixtures (maintainers only):

```bash
AGENTBUS_COMPAT_DIR=/path/to/tasks node test/accept.mjs   # 32 assertions
```

The suite needs no install step, no framework, and no network.

## What a good PR includes

- A failing assertion first, then the fix. If the behaviour is not testable by `accept.mjs`, say why in the PR.
- Updates to `docs/PROTOCOL.md` when the wire format changes. The `schema` value must change if a field's meaning changes.
- A `CHANGELOG.md` entry under "Unreleased".
- No reformatting of untouched files.

## Adding a client adapter

`src/setup.js` keeps a `CLIENTS` table: id, label, config path, and format (`toml`, `json-mcpServers`, `json-opencode`). To add one:

1. Add the entry with a `file(home)` resolver that respects the `home` argument (tests run against a fake home).
2. Reuse an existing format unless the client genuinely differs.
3. Add a line to the compatibility table in both READMEs, marked **config only** until someone verifies a full loop.

Never write outside the resolved `home` during tests.

## Style

- ESM only, no build step.
- Two-space indent, single quotes, semicolons.
- Comments explain *why*, not *what*.
- Error messages: Chinese today (interactive users), English planned. Keep new messages consistent with the file you are editing.

## Review checklist (maintainers)

- [ ] `node test/accept.mjs` green on Linux, macOS, Windows
- [ ] `node --check` on every touched file
- [ ] no new files in `files` array of `package.json` forgot to be added
- [ ] `npm pack --dry-run` contains no `var/`, no backups, no test fixtures
- [ ] the diff does not weaken the drift check or the allowlist
