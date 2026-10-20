# Changelog — @mcpfinder/core

## 2.0.0 — 2026-10-20

Smithery is no longer a source. Its registry API, MCP proxy and hosted server
URLs (`registry.smithery.ai`, `server.smithery.ai`, `*.run.tools`) stop working
on 2026-10-31 (https://smithery.ai/future). The Official MCP Registry and
Glama remain.

### Breaking
- Removed exports: `syncSmitheryRegistry`, `enrichSmitheryRepoUrls`,
  `SmitheryServer`, `SmitheryListResponse`.
- `MCPFINDER_SMITHERY_SYNC_BUDGET_MINUTES` is no longer read.
- Popularity and verification signals are gone: Smithery was their only
  source, so `use_count` / `verified` (and the `verified` / `popularity` parts
  of the confidence breakdown) are always 0. An empty-query browse now orders
  Official Registry entries first, then by most recent update.

### Added
- `usableRemoteUrl` / `firstUsableRemoteUrl`: drop remote endpoints on retired
  hosts. Applied when Official / Glama data is ingested and merged, and when
  install configs are generated.
- Opening an older local catalog clears remote URLs on retired hosts
  (idempotent, best effort). Refreshing a row that still lists `smithery` in
  `sources` drops it and rebuilds the row from Official / Glama data.

## 1.5.0 and earlier

See the git history at https://github.com/mcpfinder/mcpfinder.
