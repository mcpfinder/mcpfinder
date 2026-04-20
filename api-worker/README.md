# api-worker

Cloudflare Worker serving `mcpfinder.dev` support endpoints.

This Worker is no longer an MCP transport. The canonical MCPfinder interface is
the local stdio server installed via `npx -y @mcpfinder/server`.

## Endpoints

- `GET /api/v1/snapshot/manifest.json` — metadata for the latest published SQLite snapshot
- `GET /api/v1/snapshot/data.sqlite.gz` — compressed SQLite snapshot used for fast client bootstrap
- `GET /.well-known/mcp-registry-auth` — served elsewhere for MCP Registry publisher proof

## Running locally

```bash
npm install
npx wrangler dev -c wrangler.toml
```

## Deploying

```bash
npx wrangler deploy -c wrangler.toml
```

Always pass `-c wrangler.toml` explicitly.

## Bindings

- `MCP_DB_SNAPSHOTS` — R2 bucket containing `manifest.json` and `data.sqlite.gz`
