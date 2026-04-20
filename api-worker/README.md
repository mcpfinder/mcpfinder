# api-worker

Cloudflare Worker that serves `mcpfinder.dev` — the optional HTTP transport
for mcpfinder. The canonical experience is the stdio client
(`@mcpfinder/server` via `npx`); this Worker exists so clients that can't
run Node.js locally have an HTTP fallback at `https://mcpfinder.dev/mcp`.

> **⚠ Tool-surface drift.** The HTTP endpoint currently exposes a legacy
> tool set (`search_mcp_servers`, `get_mcp_server_details`,
> `list_trending_servers`, `test_echo`) that predates the Feb 2026 registry
> pivot. The stdio client (`packages/mcp-server`) exposes the new surface
> (`search_mcp_servers`, `get_server_details`, `get_install_command`,
> `list_categories`, `browse_category`). These will be unified — tracked in
> the root `TODO.md`.

## Endpoints

- `GET/POST /mcp` — MCP over streamable HTTP. Main public surface.
- `GET/POST /api/v1/mcp` — same as `/mcp`, legacy alias.
- `GET /api/v1/mcp/sse` — legacy SSE variant.
- `GET /api/v1/search?q=…&tag=…&limit=…` — plain keyword search over the
  KV snapshot. No ranking, no multi-registry merge. Kept for simple UI calls.
- `GET /api/v1/tools/:id` — fetch a single tool manifest by UUID.
- `POST /api/v1/register` — HMAC-signed registration (legacy publisher flow).
- `GET /api/v1/events` — SSE stream of registration events.
- `GET /.well-known/mcp-registry-auth` — ed25519 public key for the MCP
  Registry publisher proof. **Served by the Pages project, not this Worker.**

## Running locally

```bash
npm install
npx wrangler dev -c wrangler.toml
```

Then:

```bash
claude mcp add --transport http mcpfinder-local http://localhost:8787/mcp
```

## Deploying

Always pass `-c wrangler.toml` explicitly:

```bash
npx wrangler deploy -c wrangler.toml
```

Deploying from the Cloudflare dashboard or without the flag strips KV bindings.

## Bindings and secrets

- `MCP_TOOLS_KV` — tool manifests keyed by `tool:<uuid>`. Residual from
  pre-pivot syncs; the Worker no longer refreshes this (stdio client syncs
  directly from upstream registries).
- `MCP_SEARCH_INDEX_KV` — reserved; not used currently.
- `MCP_MANIFEST_BACKUPS` — R2 bucket with historical registration backups.
- `MCP_REGISTRY_SECRET` — HMAC secret for `POST /api/v1/register`. Set with
  `npx wrangler secret put MCP_REGISTRY_SECRET`.
