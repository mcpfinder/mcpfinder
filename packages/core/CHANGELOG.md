# Changelog — @mcpfinder/core

## 2.0.5 — 2026-11-24

### Fixed
- `enrichDeprecationFlags` stores a GitHub 404 (private or deleted repo) as
  `archived_repo = 2` instead of `1`. Search and details report it as the new
  `repo-unavailable` warning (−0.05 confidence, driver `-repo-unavailable`,
  `trustSignals.hasRepository = false`) rather than `archived-repo`.
- The retired verified-publisher signal no longer affects confidence, drivers
  or recommendation reasons. `trustSignals.isVerified` and
  `confidenceBreakdown.components.verified` are deprecated, always false/0.
- `categorizeServer` matches whole words (plus simple forms such as
  `files`, `deploying`, `encryption`) instead of substrings, and ignores the
  registry namespace/owner part of the name. "email" no longer lands in `ai`,
  "digital" in `git`, or every `io.github.*` server in `git`. Overly generic
  keywords (`ai`, `claude`, `query`, `request`, bare `search`) are gone.
  `getServersByCategory` uses the same rule instead of SQL `LIKE` (same
  `limit` semantics: `0` returns nothing, negative returns everything).
- Unmatched servers get the `other` category, which `listCategories` now
  lists and `getServersByCategory` accepts.
- Sync and merge writes that change a server's name or description reset its
  stored `categories` to `[]`, so details recompute them instead of showing
  stale ones.

### Added
- `finance` category (payments, banking, crypto, trading).
- `assignCategories(db)` stores each row's categories in the `categories`
  column; the snapshot build calls it, so snapshot consumers read categories
  instead of recomputing them.

## 2.0.4 — 2026-11-15

### Fixed
- `getInstallCommand` emits each client's own remote-server format. Claude
  Desktop's config file runs only stdio servers, so remote endpoints get an
  `npx -y mcp-remote <url>` bridge (header values in `env`, referenced from
  `--header Name:${MCP_HEADER_…}`; `--allow-http` for plain-HTTP URLs) plus a
  note to use Settings → Connectors when no headers are needed. Claude Code and
  VS Code get `type` + `url`, Cline `type: "streamableHttp" | "sse"` + `url`,
  Windsurf `serverUrl`, Cursor `url`. The transport comes from the selected
  Official remote (`remoteTransportForRow`), falling back to a `/sse` URL.
- Windsurf config path is `~/.codeium/windsurf/mcp_config.json` (was
  `~/.windsurf/mcp.json`).
- Cline configs target `cline_mcp_settings.json` with `mcpServers`; VS Code
  configs use `servers`.
- Search: the name-match boost is scaled by name focus (the share of the
  server's own name the query covers), so short keyword-stuffed entries such as
  `postgres-grafana-stack-generator` no longer outrank servers named for the
  term. "postgres" now returns Postgres servers first.

### Added
- `CLIENTS` (per-client paths, top-level key, post-install notes) and
  `buildRemoteServerEntry`, shared by core and `@mcpfinder/server`.

## 2.0.3 — 2026-11-14

### Changed
- Coupled release with `@mcpfinder/server` 2.0.3, which bundles its audited SDK
  and Zod runtime dependencies. Core remains dependency-free; its public API
  and catalog behavior are unchanged.

## 2.0.2 — 2026-11-02

### Fixed
- Remote install configs distinguish HTTP request headers from local package
  environment variables. `getServerDetails` exposes `remoteHeaders` for the
  selected Official Registry endpoint, including entries retained in older
  catalog snapshots. `getInstallCommand` renders only required headers and no
  process `env` for a remote URL; optional headers stay available as metadata.
  Secret header inputs receive placeholders, and simple published value
  templates such as `Bearer {api_key}` keep their declared prefix. Other secret
  templates use a placeholder for the entire header value, including its prefix.
- Same-endpoint Official Registry entries are not merged when dropping one
  would lose its remote header metadata.

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
