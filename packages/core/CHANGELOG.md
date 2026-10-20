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
- Opening a catalog built by 1.x cleans out what Smithery left (idempotent,
  best effort): rows only Smithery listed are deleted, `smithery` is dropped
  from `sources` (a row Smithery inserted first is handed to Official, or
  else Glama, as its primary `source`), `use_count` / `verified` /
  Smithery-hosted icons are reset, and remote URLs on retired hosts are
  cleared. Other fields Smithery supplied to merged rows (e.g. a longer
  description) stay until that row's next refresh or a new snapshot. Merges
  ignore a retired source left in `sources`.

## 1.5.0 and earlier

See the git history at https://github.com/mcpfinder/mcpfinder.
