# MCPfinder — An App Store for Your AI 🔍

> **The MCP server that finds MCP servers.**

**Install once. Your AI finds and installs MCP servers for you.**

Every time you need a new tool — a database connector, file manager, API integration — you have to manually search GitHub, npm, or registries, find the right MCP server, figure out the config format, and paste it into a JSON file. 

MCPfinder eliminates all of that. Add it to your AI tool once, and from that point on your AI can **discover, evaluate, and install any MCP server on demand** from 5000+ options across three registries.

> **You:** "I need to connect to my PostgreSQL database"  
> **AI:** *(uses MCPfinder)* → finds `postgres-mcp-server` → generates config → done.

## Why MCPfinder?

- 🔍 **Your AI searches for you** — 5000+ servers, 3 registries, full-text search with ranking
- 📦 **Ready-to-paste configs** — for Claude Desktop, Cursor, Claude Code, Cline, Windsurf, VS Code
- ⭐ **Smart ranking** — popularity, relevance, recency, and cross-registry presence
- 🌐 **Remote servers supported** — hosted MCP servers work out of the box (no npm install needed)
- ⚡ **Zero config** — just add MCPfinder and start asking

## Quick Install

Add MCPfinder to your AI tool — pick your platform:

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "mcpfinder": {
      "command": "npx",
      "args": ["-y", "@mcpfinder/server"]
    }
  }
}
```
Restart Claude Desktop to activate.

### Cursor

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "mcpfinder": {
      "command": "npx",
      "args": ["-y", "@mcpfinder/server"]
    }
  }
}
```
Cursor auto-detects config changes — no restart needed.

### Claude Code (CLI)

Add to `.mcp.json` (project) or `~/.claude.json` (global):

```json
{
  "mcpServers": {
    "mcpfinder": {
      "command": "npx",
      "args": ["-y", "@mcpfinder/server"]
    }
  }
}
```

### Cline / Roo Code (VS Code)

Add to `.vscode/mcp.json`:

```json
{
  "mcpServers": {
    "mcpfinder": {
      "command": "npx",
      "args": ["-y", "@mcpfinder/server"]
    }
  }
}
```

### Windsurf

Add to `~/.windsurf/mcp.json`:

```json
{
  "mcpServers": {
    "mcpfinder": {
      "command": "npx",
      "args": ["-y", "@mcpfinder/server"]
    }
  }
}
```

> **Note:** First run syncs all registries (~1-2 min). After that, data is cached locally and refreshes automatically.

## What Can Your AI Do With MCPfinder?

| Tool | What it does | When to use |
|------|-------------|-------------|
| `search_mcp_servers` | Search 5000+ servers by keyword, use case, or technology | User needs a capability you don't have |
| `get_server_details` | Full details — description, env vars, popularity, sources | Evaluate a server before recommending it |
| `get_install_command` | Ready-to-paste config for any platform | User wants to install a specific server |
| `list_categories` | Browse categories with server counts | User isn't sure what they need |
| `browse_category` | Popular servers in a specific category | Explore a domain (database, AI, cloud, etc.) |

## How It Works

```
User: "I need to access my Slack workspace"
  ↓
AI calls search_mcp_servers("slack")
  ↓
MCPfinder searches 5000+ servers across 3 registries
  ↓
Returns ranked results (relevance × popularity × recency)
  ↓
AI calls get_install_command("slack-mcp", "cursor")
  ↓
Returns ready-to-paste JSON config + file path + env vars needed
  ↓
AI configures it (or shows user what to paste)
  ↓
Done — new capability added ✨
```

## Search & Ranking

**Full-text search** powered by SQLite FTS5. Results ranked by:
- **Relevance** (40%) — how well the query matches name/description
- **Popularity** (30%) — Smithery usage count (log-scaled)
- **Registry presence** (20%) — appears in multiple registries = more established
- **Recency** (10%) — recently updated servers ranked higher

**Filters:** transport type (`stdio`/`sse`/`http`), package type (`npm`/`pypi`/`docker`), registry source (`official`/`glama`/`smithery`).

## Data Sources

| Registry | Servers | Highlights |
|----------|---------|------------|
| [Official MCP Registry](https://registry.modelcontextprotocol.io) | ~2,000 | Packages, transport, env vars |
| [Glama](https://glama.ai/mcp/servers) | ~5,000 | Repository, license, tools metadata |
| [Smithery](https://smithery.ai) | ~3,500 | Popularity (useCount), verification, hosted/remote servers |

Servers appearing in multiple registries are **deduplicated** and **merged** — combining metadata from all sources. Data refreshes automatically every 15 minutes.

## Architecture

```
mcpfinder/
├── packages/
│   ├── core/          # SQLite + FTS5 database, multi-registry sync, search, install
│   └── mcp-server/    # MCP server (stdio) exposing tools
└── README.md
```

- **@mcpfinder/core** — Database, sync engine, ranked search, multi-platform install config generation
- **@mcpfinder/server** — MCP server you add to your AI tool

## Development

```bash
pnpm install
pnpm --filter @mcpfinder/core build
pnpm --filter @mcpfinder/server build
node packages/mcp-server/dist/index.js
```

## Roadmap

- [x] Official MCP Registry sync
- [x] Multi-registry support (Glama, Smithery)
- [x] Popularity ranking (Smithery useCount)
- [x] Source badges and deduplication
- [x] Multi-platform install configs (6 platforms)
- [x] Published to npm as `@mcpfinder/server@1.0.0`
- [x] Published to the Official MCP Registry as `dev.mcpfinder/server@1.0.0`
- [ ] Web UI at findmcp.dev

## Links

- **npm:** [@mcpfinder/server](https://www.npmjs.com/package/@mcpfinder/server)
- **MCP Registry:** [`dev.mcpfinder/server`](https://registry.modelcontextprotocol.io/v0/servers?search=dev.mcpfinder)
- **Website:** [mcpfinder.dev](https://mcpfinder.dev) · [findmcp.dev](https://findmcp.dev)
- **GitHub:** [lksrz/mcpfinder](https://github.com/lksrz/mcpfinder)

---

Built by [Coder AI](https://coderai.dev) · [AGPL-3.0 License](LICENSE)
