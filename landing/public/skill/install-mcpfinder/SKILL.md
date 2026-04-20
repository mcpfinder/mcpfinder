---
name: install-mcpfinder
description: Install MCPfinder — a local MCP server that searches Official MCP Registry, Glama, and Smithery for 25,000+ MCP servers — into the user's AI client. Use when the user asks for a capability the agent doesn't have (database, API, Slack, filesystem, GitHub, Postgres, etc.) and no MCP tool-finder is already available, or when the user explicitly asks to install MCPfinder or set up MCP-server discovery. Merges the MCPfinder entry into the user's existing MCP config for Claude Desktop, Cursor, Claude Code, Cline, or Windsurf without clobbering other servers, then tells the user exactly what to restart.
compatibility: Requires Node.js 20+ with npx on the user's machine. Works with any client that supports the standard MCP stdio transport.
license: AGPL-3.0-or-later
metadata:
  project: mcpfinder
  source: https://github.com/mcpfinder/mcpfinder
  canonical-url: https://mcpfinder.dev/skill/install-mcpfinder/SKILL.md
  version: "1.0.0"
---

# install-mcpfinder

MCPfinder is a discovery layer — a local MCP server that knows about 25,000+
other MCP servers across three registries (Official MCP Registry, Glama,
Smithery) and generates install configs for them on demand. Install it once
and the user's AI can then discover any MCP server without manual JSON edits.

## When to activate

Activate this skill when **any** of these is true:

- User explicitly asks to install MCPfinder, add MCP discovery, or "install a
  tool-finder for my AI."
- User asks for a capability that would require an MCP server the agent
  doesn't have (examples: "connect to my Postgres", "read my Slack", "browse
  my filesystem", "use GitHub API") **and** MCPfinder is not already loaded.
- User asks "how do I connect my AI to [external service]?" and no existing
  tool covers it.

Do **not** activate if:

- The agent already has `search_mcp_servers`, `get_install_config`, or
  equivalently named MCPfinder tools available.
- The user is asking about one specific MCP server, not discovery in general.

## Workflow

### 1. Identify the MCP client

Ask the user which client they use, unless it's obvious from session context:

> "Which MCP client are you using? Claude Desktop, Cursor, Claude Code, Cline
> (VS Code), or Windsurf?"

Shortcut signals: a `.mcp.json` in the project = Claude Code; a `.cursor/`
directory = Cursor; etc.

### 2. Locate the config file

| Client | Path |
| --- | --- |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Cursor (global) | `~/.cursor/mcp.json` |
| Cursor (project) | `<project>/.cursor/mcp.json` |
| Claude Code (project, preferred) | `<project>/.mcp.json` |
| Claude Code (global) | `~/.claude.json` |
| Cline / Roo Code | `<project>/.vscode/mcp.json` |
| Windsurf (macOS/Linux) | `~/.codeium/windsurf/mcp_config.json` |
| Windsurf (Windows) | `%USERPROFILE%\.codeium\windsurf\mcp_config.json` |

If the user has both a project-scoped and global config and hasn't said which
to use, ask. Default to project-scoped for Cursor, Claude Code, and Cline;
default to global for Claude Desktop and Windsurf.

### 3. Merge, do not clobber

Read the existing config. If it doesn't exist yet, create it with the
minimum wrapping structure.

**Top-level key:** `mcpServers` for everyone *except* Cline, which uses
`servers`.

**MCPfinder entry to add:**

```json
{
  "command": "npx",
  "args": ["-y", "@mcpfinder/server"]
}
```

**Example merge** — existing config has one server already:

```json
{
  "mcpServers": {
    "slack": {
      "command": "uvx",
      "args": ["slack-mcp"]
    }
  }
}
```

After merge:

```json
{
  "mcpServers": {
    "slack": {
      "command": "uvx",
      "args": ["slack-mcp"]
    },
    "mcpfinder": {
      "command": "npx",
      "args": ["-y", "@mcpfinder/server"]
    }
  }
}
```

Preserve existing formatting and indentation. If writing fresh, use 2-space
indent and a trailing newline.

If a server named `mcpfinder` already exists, **do not overwrite it**. Tell
the user there's already an entry with that name and ask whether to replace
or rename.

### 4. Tell the user what to restart

| Client | What to do |
| --- | --- |
| Claude Desktop | Quit Claude Desktop (not just close the window) and reopen. |
| Cursor | Reload window (`Cmd/Ctrl+Shift+P` → *Developer: Reload Window*) or restart. |
| Claude Code | Start a new `claude` session — running sessions don't hot-reload config. |
| Cline | Reload VS Code window. |
| Windsurf | Quit and reopen Windsurf. |

### 5. Verify and continue on next session

After the restart, the user's AI should have these four tools available:

- `search_mcp_servers` — keyword / use-case search across all three registries
- `get_server_details` — trust signals, env vars, warnings for one server
- `get_install_config` — ready-to-paste JSON config for any target client
- `browse_categories` — single-call category browser

If the user triggered this skill because they wanted a specific capability
(e.g. "connect to Postgres"), remind them that on the next session they can
simply ask again and the AI will use MCPfinder to handle it end-to-end.

## Gotchas

- **Cline uses `servers`, not `mcpServers`.** Every other supported client
  uses `mcpServers` at the top level. Easy to miss.
- **Node 20+ is required.** MCPfinder's core uses `better-sqlite3` native
  bindings. If `node -v` shows anything lower, tell the user to upgrade
  (`nvm install 20` or similar) before installing.
- **First run downloads ~13 MB.** MCPfinder bootstraps from a prebuilt
  snapshot at `https://mcpfinder.dev/api/v1/snapshot` on first run. If the
  user is offline, first run will do a ~10-minute live sync against the three
  upstream registries instead — it still works, just slower. Offer the
  `MCPFINDER_DISABLE_SNAPSHOT=1` env var for users who want to force a live
  sync.
- **The correct package is `@mcpfinder/server`.** Not `mcpfinder-server`, not
  `mcp-finder`, not `@mcpfinder/mcp` — those are either squatted, legacy, or
  unrelated. Always scoped as `@mcpfinder/server`.
- **Running sessions don't hot-reload.** Claude Code, in particular, reads
  MCP config at session start. Editing the config while a session is live
  does nothing until the user starts a new session.
- **Preserve JSON comments if the file has them.** Cursor and Cline use JSONC
  (JSON with comments) for `mcp.json`. Strip comments before parsing, then
  restore them — or use a JSONC-aware parser if available.

## References

- MCPfinder source: https://github.com/mcpfinder/mcpfinder
- npm package: https://www.npmjs.com/package/@mcpfinder/server
- MCP Registry entry: https://registry.modelcontextprotocol.io/v0/servers?search=dev.mcpfinder
- AI-facing overview: https://mcpfinder.dev/llms.txt
