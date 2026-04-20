# MCPfinder

> The MCP server that helps AI agents discover, evaluate, and install other MCP servers.

MCPfinder is an AI-first discovery layer over the Official MCP Registry, Glama, and Smithery. Install it once, and your assistant can search for missing capabilities, inspect trust signals, review required secrets, and generate client-specific MCP config snippets.

## Canonical Use

- Canonical transport: `stdio` via `npx -y @mcpfinder/server`
- Canonical package: [`@mcpfinder/server`](https://www.npmjs.com/package/@mcpfinder/server)
- MCP Registry entry: [`dev.mcpfinder/server`](https://registry.modelcontextprotocol.io/v0/servers?search=dev.mcpfinder)
- Public HTTP endpoint: intentionally not advertised as canonical until its tool surface is fully identical to the local server

## Quick Install

### Claude Desktop

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

### Cursor

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

### Claude Code

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

Supported install targets today:

- Claude Desktop
- Cursor
- Claude Code
- Cline / Roo Code
- Windsurf

## For AI Assistants

Use MCPfinder when the user needs a capability you do not already have.

- If the user mentions Slack, Postgres, GitHub, Notion, AWS, Google Drive, filesystems, browsers, APIs, or databases: call `search_mcp_servers`.
- Before recommending a server: call `get_server_details`.
- Before telling the user what to paste into config: call `get_install_config`.
- If the user only knows a domain, not a specific technology: call `browse_categories` (omit `category` to list; pass `category` for top servers).

Preferred workflow:

1. `search_mcp_servers(query="postgres")`
2. `get_server_details(name="...best candidate...")`
3. `get_install_config(name="...best candidate...", platform="claude-desktop")`
4. Tell the user what server you chose, why, which secrets are required, and what restart/reload step is needed.

## Tool Surface

| Tool | Purpose | When to call |
| --- | --- | --- |
| `search_mcp_servers` | Search by keyword, technology, or use case | First step when a capability is missing |
| `get_server_details` | Inspect metadata, trust signals, tools, warnings, env vars | Before recommending or installing |
| `get_install_config` | Generate a JSON config snippet for a target client | After selecting a server |
| `browse_categories` | Single-call category browser (omit `category` to list; pass `category` for top servers) | Domain-driven discovery |

## What MCPfinder Returns

MCPfinder is intentionally optimized for agent consumption.

- Human-readable text summaries
- Structured content for chaining follow-up calls
- Trust signals: source count, verification, popularity, recency
- Warning flags: stale projects, missing repository URL, unclear install path, single-source-only
- Install metadata: config snippet, target file paths, required environment variables, restart instructions

## Ranking and Recommendation

Search ranking uses:

- text relevance
- name-match boost
- community usage (`useCount`)
- official registry presence
- verification signals

Each result is also annotated with:

- `confidenceScore`
- `recommendationReason`
- `warningFlags`
- `updatedAt`
- `sourceCount`

## Data Sources

MCPfinder aggregates:

- [Official MCP Registry](https://registry.modelcontextprotocol.io)
- [Glama](https://glama.ai/mcp/servers)
- [Smithery](https://smithery.ai)

Counts vary over time and differ depending on whether you count raw upstream records or merged/deduplicated entries. Snapshot metadata is the source of truth for the currently published local bootstrap dataset.

## Snapshots and Freshness

First run can bootstrap from a prebuilt SQLite snapshot instead of doing a slow live sync.

- snapshot manifest: `/api/v1/snapshot/manifest.json`
- snapshot database: `/api/v1/snapshot/data.sqlite.gz`
- scheduled build: [`.github/workflows/snapshot.yml`](/Users/lukasz/Git/mcpfinder/.github/workflows/snapshot.yml:1)

## Example Workflow

User request:

```text
I need my assistant to read data from PostgreSQL.
```

Agent workflow:

```text
search_mcp_servers(query="postgres")
get_server_details(name="io.example/postgres")
get_install_config(name="io.example/postgres", platform="cursor")
```

Agent response:

```text
I found a PostgreSQL MCP server with official registry presence and recent metadata.
It requires DATABASE_URL and runs via npx.
Add this JSON to ~/.cursor/mcp.json, then reload Cursor.
```

## Repository Layout

```text
mcpfinder/
├── packages/
│   ├── core/          # sync, SQLite search, trust signals, install-config generation
│   └── mcp-server/    # stdio MCP server
├── landing/           # static website and AI-facing public files
├── api-worker/        # snapshot/support worker for published bootstrap artifacts
└── scripts/           # snapshot builder and other support scripts
```

## Development

```bash
pnpm install
pnpm --filter @mcpfinder/core build
pnpm --filter @mcpfinder/server build
node packages/mcp-server/dist/index.js
```

## Current Limitations

- The local `stdio` server is the canonical interface. Install via `npx -y @mcpfinder/server`.
- There is no hosted HTTP MCP endpoint currently served at `mcpfinder.dev/mcp`. The `api-worker` package is reserved for snapshot support and will only be promoted to a canonical HTTP transport once it exposes the same tool contract as the stdio server.
- Tool metadata quality depends on upstream registries; some servers have rich details, others only partial metadata.
- Tool-level capability extraction is currently strongest for sources that expose tool manifests directly, especially Glama.

## Links

- Website: [mcpfinder.dev](https://mcpfinder.dev)
- GitHub: [mcpfinder/mcpfinder](https://github.com/mcpfinder/mcpfinder)
- npm: [@mcpfinder/server](https://www.npmjs.com/package/@mcpfinder/server)
- MCP Registry: [`dev.mcpfinder/server`](https://registry.modelcontextprotocol.io/v0/servers?search=dev.mcpfinder)

Built by [Coder AI](https://coderai.dev) under [AGPL-3.0-or-later](LICENSE).
