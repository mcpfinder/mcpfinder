# api-worker — Project Instructions

## Role

Support Worker for `mcpfinder.dev`.

This Worker is not an MCP transport. The product surface lives in
`packages/mcp-server` and is consumed locally via stdio.

Keep this Worker limited to:

- snapshot hosting under `/api/v1/snapshot/*`
- domain-level support tasks that do not affect the MCP tool contract

## Endpoints

- `GET /api/v1/snapshot/manifest.json`
- `GET /api/v1/snapshot/data.sqlite.gz`

## Bindings

- `MCP_DB_SNAPSHOTS` — R2 bucket containing the published snapshot artifacts

## Conventions

- Do not reintroduce `/mcp`, `/api/v1/mcp`, or registry-style write/search endpoints here.
- No scraping or sync logic belongs in this Worker.
- Keep the Worker minimal and boring.
