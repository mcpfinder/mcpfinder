# MCPfinder — Project Instructions

## What this project is

**MCPfinder is an MCP server that finds MCP servers.** It gives AI agents a
local, searchable index of the MCP ecosystem across three registries:

- **Official MCP Registry** — `https://registry.modelcontextprotocol.io`
- **Glama** — `https://glama.ai/api/mcp/v1`
- **Smithery** — `https://registry.smithery.ai`

An AI client (Claude Desktop, Cursor, Windsurf, Cline, Claude Code, VS Code)
installs `@mcpfinder/server` via npx → the server syncs all three registries
into a local SQLite+FTS5 database → the AI can then search / browse / generate
install configs for any MCP server in the ecosystem on demand.

## Repo layout

```
mcpfinder/
├── packages/
│   ├── core/          # @mcpfinder/core — multi-registry sync, SQLite+FTS5, ranked search, install-config generator
│   └── mcp-server/    # @mcpfinder/server — stdio MCP server, wraps core, exposes tools to AI clients
├── api-worker/        # Cloudflare Worker: optional HTTP MCP endpoint at mcpfinder.dev/mcp
├── mcpfinder-www/     # Static landing page source (production served from separate Cloudflare Pages project `mcpfinder-landing`)
├── mcp-inspector/     # Dev tool (submodule) for debugging MCP sessions
└── docs/              # Publish playbook, architecture notes
```

## Tools exposed by `@mcpfinder/server`

1. `search_mcp_servers` — ranked full-text search with fuzzy matching and alias expansion
2. `get_server_details` — full metadata for one server (env vars, popularity, sources)
3. `get_install_command` — ready-to-paste config for the caller's platform
4. `list_categories` — category browse with counts
5. `browse_category` — top servers in a category

Tool names and schemas are the contract — changing them is a breaking change
for AI consumers. Add new tools rather than renaming existing ones.

## Development

```bash
pnpm install
pnpm --filter @mcpfinder/core build
pnpm --filter @mcpfinder/server build

# Run the stdio server locally (for integration with an MCP client)
node packages/mcp-server/dist/index.js
```

Node.js 20+ required (for `better-sqlite3` native bindings).

## Distribution

- **npm**: `@mcpfinder/server` (depends on `@mcpfinder/core`). Version `1.0.0+`.
- **Official MCP Registry**: published as `dev.mcpfinder/server`.
- **HTTP endpoint**: `https://mcpfinder.dev/mcp` (served by `api-worker/`).

Re-publish runbook: `docs/publish-playbook.md`.

Keypair for MCP Registry auth: `~/.config/mcpfinder-publish/privkey.hex`
(chmod 600, never in repo). Public half is served via
`https://mcpfinder.dev/.well-known/mcp-registry-auth` (static file in
`mcpfinder-www/public/.well-known/`, deployed to Cloudflare Pages project
`mcpfinder-landing` — not the api-worker).

## License

AGPL-3.0-or-later. Reflect this in `LICENSE`, `package.json` files, landing
page, and any promotional surface. Never promote under MIT by mistake.

## Conventions

- Don't add a "Co-Authored-By" line to commits.
- One-off scripts belong in `/tmp` or a gist, not in the repo.
- Scraping tooling is **not** part of this project — if you need data from a
  source, it comes through `packages/core/src/sync.ts` only.
