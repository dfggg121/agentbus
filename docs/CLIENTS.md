# Supported Clients

`agentbus setup` automates MCP registration for 13 clients (7 core + 6 optional). Any stdio JSON-RPC 2.0 MCP client can also be configured manually.

> **Read-only inspection:** `agentbus setup --list [--home <dir>]` prints `id`, `label`, `format`, `config`, `optional`, and `installed` without creating directories or modifying files.

---

## Automatic Support Matrix

Core clients (`optional: false`) are always targeted when running `agentbus setup` without `--client`. Optional clients (`optional: true`) are **skipped** by default when not installed (no directories are created), and are configured either when their existing install directory is detected or when explicitly requested with `--client <id>`.

| Client ID | Product | Config Path | Format | Optional | Restart Required | Command |
|---|---|---|---|---|---|---|
| `codex` | OpenAI Codex CLI | `~/.codex/config.toml` | `toml` | No | No (next `codex` invocation) | `agentbus setup --client codex` |
| `claude` | Claude Code | `~/.claude.json` | `json-mcpServers` | No | No (next `claude` session) | `agentbus setup --client claude` |
| `gemini` | Gemini CLI | `~/.gemini/settings.json` | `json-mcpServers` | No | No (next `gemini` session) | `agentbus setup --client gemini` |
| `antigravity` | Google Antigravity | `~/.gemini/config/mcp_config.json` (fallback `~/.gemini/antigravity/mcp_config.json`) | `json-mcpServers` | No | Yes | `agentbus setup --client antigravity` |
| `cursor` | Cursor | `~/.cursor/mcp.json` | `json-mcpServers` | No | Yes | `agentbus setup --client cursor` |
| `opencode` | OpenCode | `~/.config/opencode/opencode.json` | `json-opencode` | No | No (next `opencode` run) | `agentbus setup --client opencode` |
| `claude-desktop` | Claude Desktop | Win: `%APPDATA%\Claude\claude_desktop_config.json`<br>macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`<br>Linux: `~/.config/Claude/claude_desktop_config.json` | `json-mcpServers` | No | Yes | `agentbus setup --client claude-desktop` |
| `windsurf` | Windsurf | `~/.codeium/windsurf/mcp_config.json` | `json-mcpServers` | Yes | Yes | `agentbus setup --client windsurf` |
| `kiro` | Kiro | `~/.kiro/settings/mcp.json` | `json-mcpServers` | Yes | Yes | `agentbus setup --client kiro` |
| `lmstudio` | LM Studio | `~/.lmstudio/mcp.json` | `json-mcpServers` | Yes | Yes | `agentbus setup --client lmstudio` |
| `cline` | Cline | VS Code ext: `<Code>/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`<br>CLI fallback: `~/.cline/data/settings/cline_mcp_settings.json` | `json-mcpServers` | Yes | Yes (IDE reload) | `agentbus setup --client cline` |
| `dsh` | DeepSeek Harness (DSH) | `~/.dsh/profiles/desktop/cordis.patch.yml` | `dsh-cordis` | Yes | **Yes** (`setup` never restarts DSH) | `agentbus setup --client dsh` |
| `hermes` | Hermes Agent | Win: `%LOCALAPPDATA%\hermes\config.yaml` (fallback `%USERPROFILE%\.hermes\config.yaml`)<br>macOS/Linux: `~/.hermes/config.yaml`<br>Override: `$HERMES_HOME/config.yaml` (via `hermes mcp add`) | `hermes-cli` | Yes | No (next `hermes` run) | `agentbus setup --client hermes` |

### Role & Dispatch Flags

```bash
# Worker role (default; 9 tools, dispatch disabled)
agentbus setup --client windsurf --root ~/.agentbus --allow /path/to/workspace --role worker

# Conductor role (15 tools, dispatch enabled)
agentbus setup --client codex --root ~/.agentbus --allow /path/to/workspace --role conductor --allow-dispatch

# Repair missing agentbus entries for installed codex/antigravity/dsh/hermes
# (idempotent, backs up before write; other clients stay out of scope)
agentbus doctor --fix
```

- `--role <conductor|worker>`: defaults to `worker`; unknown values fall back to `worker`.
- `--allow-dispatch`: sets `AGENTBUS_ENABLE_DISPATCH=1` (otherwise `0`).
- Env injected into every configured client: `AGENTBUS_ROOT`, `AGENTBUS_ALLOWED_ROOTS`, `AGENTBUS_ROLE`, `AGENTBUS_ENABLE_DISPATCH`.

---

## Manual Support Matrix (GUI-only / JSONC / Ambiguous Paths)

These clients either manage MCP through their GUI, use JSONC (comments/trailing commas), or support multiple ambiguous paths, so `setup` does not overwrite them automatically.

| Client | Where to Configure in UI / CLI | Config Shape / Docs |
|---|---|---|
| **Trae** | `Settings` (gear icon) → `MCP` → `Add` → `Create Manually` (or project `.trae/mcp.json` with **Enable Project MCP**) | Standard `mcpServers.agentbus` JSON ([Trae MCP Docs](https://docs.trae.ai/ide/model-context-protocol)) |
| **Qoder** | `Ctrl+Shift+,` (Win/Linux) or `⌘⇧,` (macOS) → `MCP` → `My Servers` → `+ Add` | Standard `mcpServers.agentbus` JSON ([Qoder Docs](https://docs.qoder.com/)) |
| **CodeBuddy** | IDE MCP settings panel, or `codebuddy --mcp-config ./mcp.json`, or `~/.codebuddy/.mcp.json` | Standard `mcpServers.agentbus` JSON |
| **VS Code** | Command Palette (`Ctrl+Shift+P` / `⌘⇧P`) → `MCP: Add Server` or `Chat: Open Customizations` → `MCP Servers` (global `~/.copilot/mcp-config.json` or workspace `.mcp.json`) | Standard `mcpServers.agentbus` JSON ([VS Code MCP Docs](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)) |
| **Zed** | `Settings → AI → MCP Servers`, or Command Palette → `zed: open settings file` (`settings.json` JSONC) | Put `agentbus` under `"context_servers"` ([Zed Docs](https://zed.dev/docs/assistant/context-servers)) |
| **OpenClaw** | Control UI `Settings → MCP → Add server`, or CLI `openclaw mcp set agentbus '<json>'` (`~/.openclaw/openclaw.json`) | Put `agentbus` under `"mcp": { "servers": { ... } }` ([OpenClaw Docs](https://docs.openclaw.ai/)) |

### Example JSON Snippet (Trae / Qoder / CodeBuddy / VS Code)

```json
{
  "mcpServers": {
    "agentbus": {
      "command": "node",
      "args": ["/abs/path/to/agentbus/bin/bus.js", "mcp", "--root", "/abs/path/to/.agentbus"],
      "env": {
        "AGENTBUS_ROOT": "/abs/path/to/.agentbus",
        "AGENTBUS_ALLOWED_ROOTS": "/abs/path/to/workspace",
        "AGENTBUS_ROLE": "worker",
        "AGENTBUS_ENABLE_DISPATCH": "0"
      }
    }
  }
}
```

For **Zed** (`settings.json`), place the same `{ "command", "args", "env" }` object under `"context_servers": { "agentbus": { ... } }`.

---

## DSH & Hermes: Verification and Rollback

### DeepSeek Harness (`dsh`)

`setup --client dsh` writes a managed YAML list item between `# BEGIN agentbus-managed` and `# END agentbus-managed` inside `~/.dsh/profiles/desktop/cordis.patch.yml` for plugin `@deepseek-ai/dsh-mcp-client` (`transport: stdio`, `serverName: agentbus`), keeping existing plugins untouched and backing up the previous file first.

**Verify:**

```bash
node bin/bus.js doctor
# Check cordis.patch.yml contains "# BEGIN agentbus-managed" ... "# END agentbus-managed"
```

Then manually restart DSH so it reloads `cordis.patch.yml` (`setup` never restarts DSH automatically).

**Rollback:**

- Restore the timestamped backup created alongside the file (`cordis.patch.yml.bak-<timestamp>`), or
- Delete the `# BEGIN agentbus-managed` … `# END agentbus-managed` block from `~/.dsh/profiles/desktop/cordis.patch.yml` and restart DSH.

### Hermes Agent (`hermes`)

`setup --client hermes` does **not** edit `config.yaml` directly; it invokes `hermes mcp add agentbus ...` with non-interactive confirmation (`y\n`), checks for an existing `agentbus` entry first to stay idempotent, isolates state with `HERMES_HOME` when `--home <dir>` is passed, and verifies registration via `hermes mcp list`.

Default config path resolution (override with `HERMES_HOME`):

- **Windows:** `%LOCALAPPDATA%\hermes\config.yaml` (falls back to `%USERPROFILE%\.hermes\config.yaml` if not present)
- **macOS / Linux:** `~/.hermes/config.yaml`
- **Override:** `$HERMES_HOME/config.yaml` (when `--home <dir>` is passed, `HERMES_HOME` is isolated inside `<dir>`)

**Verify:**

```bash
hermes mcp list
node bin/bus.js doctor
```

If using an isolated home directory (`--home /tmp/fake-home`):

```bash
HERMES_HOME=/tmp/fake-home/.hermes hermes mcp list
```

**Rollback:**

```bash
# Remove via Hermes CLI:
hermes mcp remove agentbus

# Or restore the timestamped backup if one was created:
# Win:   %LOCALAPPDATA%\hermes\config.yaml.bak-<timestamp> -> %LOCALAPPDATA%\hermes\config.yaml
# Linux/macOS: ~/.hermes/config.yaml.bak-<timestamp> -> ~/.hermes/config.yaml
```
