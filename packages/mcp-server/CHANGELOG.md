# Changelog — @mcpfinder/server

## 2.0.5 — 2026-11-24

### Security
- Bundled runtime dependencies raised past published advisories:
  `fast-uri` 3.1.9, `hono` 4.13.21, `@hono/node-server` 2.1.11 (from 1.19.x,
  within the MCP SDK's supported range), `ip-address` 10.7.6. `zod` < 4.6.6
  remains (GHSA-mrhx-c7xc-m3w5); moving to zod 4 is a separate change.

### Fixed
- A source repository the GitHub API answers 404 for (private or deleted) is no
  longer reported as `archived-repo`. It gets the new `repo-unavailable`
  warning flag (−0.05 confidence, driver `-repo-unavailable`) and no longer
  counts as `trustSignals.hasRepository`.
- A server whose repository URL changed no longer inherits the previous
  repository's archived/unavailable flag in the published catalog snapshot.
- `get_server_details` no longer prints the always-empty "verified" trust
  signal. `trustSignals.isVerified` and `confidenceBreakdown.components.verified`
  stay in structured output as deprecated, always false/0.

## 2.0.4 — 2026-11-15

### Fixed
- `get_install_config` for remote servers returns a config each client can
  load: Claude Desktop gets an `mcp-remote` stdio bridge (never a bare `url`)
  with a Connectors alternative and an honest OAuth note; Claude Code gets
  `type` + `url` and the `claude mcp add --transport …` command; Cline
  `streamableHttp`/`sse`; Windsurf `serverUrl`.
- Cline configs target `cline_mcp_settings.json` with `mcpServers` instead of
  VS Code's `.vscode/mcp.json`.
- `search_mcp_servers` ranks servers named for the query above keyword-stuffed
  stack generators (e.g. "postgres").

### Added
- `platform: "vscode"` for VS Code's native `.vscode/mcp.json` (`servers`).
- Requires `@mcpfinder/core` ^2.0.4.

## 2.0.3 — 2026-11-14

### Fixed
- Bundle the audited MCP SDK 1.32.2 and Zod runtime trees so consumers receive
  the fixed dependencies even in hosts with older locked SDK dependencies.
  The bundled graph includes Express 5.3.0, proxy-addr 2.0.8 and qs 6.17.1;
  workspace overrides alone do not protect published-package consumers.
- Include the first-party license alongside bundled third-party licenses.
- Requires `@mcpfinder/core` ^2.0.3. MCP tools and their public interfaces remain
  unchanged. High and lower dependency findings remain outside this Critical fix.

## 2.0.2 — 2026-11-02

### Fixed
- Remote install configs use HTTP `headers` from the selected Official Registry
  endpoint instead of attaching local `env` variables to its URL. Only required
  headers enter the default snippet; optional headers remain visible as
  `remoteHeaders`, so servers such as Arcmira can use host OAuth with the URL
  alone. Required secret headers receive placeholders and update
  `requires_user_secrets` / `safe_to_autoinstall` accordingly.
  Unsupported secret templates require the complete header value, including
  any authentication scheme, in the placeholder.
- Requires `@mcpfinder/core` ^2.0.2.

## 2.0.1 — 2026-10-20

### Fixed
- Glama servers are no longer reported as remote. Their only URL is the page in
  Glama's directory, not an MCP endpoint, so `get_install_config` used to hand
  out a web page as an MCP `url`. It is now shown as **Listing** in
  `get_server_details` (`listingUrl`), and `get_install_config` for a server
  with no package and no remote endpoint says "No install method known" and
  points to the repository and listing (`installType: "none"`,
  `repositoryUrl`, `listingUrl`). A local catalog from an earlier version is
  cleaned on first open. 2.0.0 clients pick up the fixed snapshot, but their
  own Glama sync writes the listing page back as a remote: please upgrade.
- The published catalog snapshot drops one of two Official Registry entries
  that publish the same remote endpoint (conservative rule, see
  `@mcpfinder/core` 2.0.1); a client gets this by adopting the snapshot. The
  dropped entry's name no longer resolves in the snapshot; a later local
  Official sync re-adds it if its publisher updates it.
- Requires `@mcpfinder/core` ^2.0.1.

## 2.0.0 — 2026-10-20

Smithery is no longer a source. Its registry API, MCP proxy and hosted server
URLs stop working on 2026-10-31 (https://smithery.ai/future). 1.x clients
call the Smithery API whenever they run a live sync; after 2026-10-31 that
call fails for that source (Official and Glama still sync). Please upgrade.

### Breaking
- The live sync calls only the Official MCP Registry and Glama; no request
  goes to any Smithery host.
- `search_mcp_servers` no longer accepts `registrySource: "smithery"`
  (allowed values: `official`, `glama`, `any`).
- The Smithery source badge is gone, and so are the popularity and verified
  signals (Smithery was their only source): `useCount` is 0, `verified` is
  false, and an empty query no longer returns "most popular" servers. It
  browses Official Registry entries first, then by most recent update.
- Requires `@mcpfinder/core` ^2.0.0.

### Fixed
- `get_install_config` never emits a remote URL on a retired Smithery host,
  even if an older local catalog still holds one.
- A local catalog built by 1.x is cleaned when first opened: Smithery-only
  servers are removed, and Smithery URLs, popularity and verified values are
  cleared (see the @mcpfinder/core changelog).

## 1.5.0 and earlier

See the git history at https://github.com/mcpfinder/mcpfinder.
