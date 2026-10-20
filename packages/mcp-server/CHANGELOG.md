# Changelog — @mcpfinder/server

## 2.0.1 — 2026-10-20

### Fixed
- Glama servers are no longer reported as remote. Their only URL is the page in
  Glama's directory, not an MCP endpoint, so `get_install_config` used to hand
  out a web page as an MCP `url`. It is now shown as **Listing** in
  `get_server_details` (`listingUrl`), and `get_install_config` for a server
  with no package and no remote endpoint says "No install method known" and
  points to the repository and listing (`installType: "none"`,
  `repositoryUrl`, `listingUrl`). A local catalog from an earlier version is
  cleaned on first open.
- Two Official Registry entries that publish the same remote endpoint are
  merged into one result (conservative rule, see `@mcpfinder/core` 2.0.1).
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
