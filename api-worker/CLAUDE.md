# api-worker — Project Instructions

## Role

Optional HTTP transport for `mcpfinder` served from Cloudflare Workers at
`https://mcpfinder.dev/mcp`. The canonical experience is the stdio server in
`packages/mcp-server` — this Worker exists as a "no Node.js required" fallback
and is advertised in `dev.mcpfinder/server`'s MCP Registry entry under
`remotes[].url`.

As of 2026-04-20 the Worker no longer runs a scheduled aggregator; the stdio
client talks to upstream registries (Official / Glama / Smithery) directly.
KV content is residual from earlier syncs and is considered eventually stale.
If and when we decide to retire the HTTP endpoint, see the "Retirement plan"
section below.

## Endpoints

- `GET/POST /mcp` — MCP protocol over streamable HTTP (main public surface).
- `GET/POST /api/v1/mcp` — same as `/mcp`, legacy alias.
- `GET /api/v1/mcp/sse` — legacy SSE variant (kept for old clients).
- `GET /api/v1/search?q=…&tag=…&limit=…` — plain keyword search over the KV
  snapshot (no ranking, no multi-registry merge; kept for UI demos).
- `GET /api/v1/tools/:id` — fetch a single tool manifest.
- `POST /api/v1/register` — HMAC-signed registration (legacy publisher flow;
  use with caution, contract may change).
- `GET /api/v1/events` — SSE stream for registry event notifications.
- `GET /.well-known/*` — served by the Pages project, not this Worker.

## Deploy

```bash
npx wrangler deploy -c wrangler.toml
```

Always pass `-c wrangler.toml` explicitly — deploying from the Cloudflare
dashboard or without the flag strips KV bindings.

## Bindings / secrets

- `MCP_TOOLS_KV` — tool manifests keyed by `tool:<uuid>`.
- `MCP_SEARCH_INDEX_KV` — reserved for future search index (currently unused).
- `MCP_MANIFEST_BACKUPS` — R2 bucket, legacy backups of registrations.
- `MCP_REGISTRY_SECRET` — HMAC secret for `/api/v1/register` (set via
  `npx wrangler secret put MCP_REGISTRY_SECRET`).

## Retirement plan (when we decide to)

1. Remove `remotes[]` from `packages/mcp-server/server.json`, bump version,
   `mcp-publisher publish`.
2. Update the landing page to drop the HTTP/SSE transport option.
3. Detach the Worker route from `mcpfinder.dev/*` in Cloudflare.
4. `wrangler delete` the Worker; drop `api-worker/` from the repo.
5. Keep KV namespaces around for a retention window in case rollback is needed.

Do none of this without explicit user authorization — it breaks any client
configured with `--transport http https://mcpfinder.dev/mcp`.

## Conventions

- No scraping scripts live here. Legacy one-off scripts were removed 2026-04-20.
- Don't add a `Co-Authored-By` line to commits.
