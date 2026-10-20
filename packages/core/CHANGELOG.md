# Changelog — @mcpfinder/core

## 2.0.1 — 2026-10-20

### Fixed
- Glama's `url` (`https://glama.ai/mcp/servers/<id>`) is the server's page in
  Glama's directory, not an MCP endpoint, and Glama's API publishes no
  endpoint. It was stored as `remote_url` with `has_remote = 1` (about 75,000
  rows). It is now kept as a listing link in the new `listing_url` column and
  never sets `remote_url` / `has_remote`; `usableRemoteUrl` also refuses such
  a page, and `getServerDetails` / search results never report one as
  `hasRemote`. Opening a catalog built by an earlier version moves these
  values out of `remote_url` (idempotent, best effort). The published
  snapshot is fixed for every version, but a 2.0.0 client's own Glama sync
  writes the page back into `remote_url`: upgrade to 2.0.1.
- `getInstallCommand` for a server with no package and no remote endpoint
  returns a "no install method known" result (`config.note` =
  `NO_INSTALL_METHOD_NOTE`, plus `repositoryUrl` / `listingUrl`). A package
  on an unsupported registry still gets the "unable to generate auto-config"
  note.

### Added
- `mergeSameRemoteOfficialEntries`: when the published snapshot is built
  (`scripts/build-snapshot.mjs`, on a catalog built from scratch), one of two
  Official entries that publish the same remote endpoint is dropped. URLs
  compare scheme-insensitively with a lowercase host, no default port and no
  trailing slash; path, query and any other port stay significant. Only
  groups of exactly two are merged; templated URLs (`{hostname}`) and URLs
  with credentials are skipped, and so is a pair whose publishers and
  descriptions look unrelated. The richer row is kept as it is (active status
  first); the dropped row must be Official-only, its package and env var
  names must be on the kept row, and the kept row needs a repository if the
  dropped one has one (a fork's different repository link is not kept). The dropped
  entry's name no longer resolves in the snapshot. Not run by
  `syncOfficialRegistry`: a client gets the result by adopting the snapshot,
  and its own later Official syncs re-add a dropped entry when its publisher
  updates it. On the 2026-10-20 catalog this drops 29 rows and skips 5 pairs.
- `listing_url` column, `ServerDetail.listingUrl`, `isDirectoryListingUrl`,
  `normalizeRemoteUrlKey`, `NO_INSTALL_METHOD_NOTE`.

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
  description) may persist until a new snapshot replaces the catalog. Merges
  ignore a retired source left in `sources`.

## 1.5.0 and earlier

See the git history at https://github.com/mcpfinder/mcpfinder.
