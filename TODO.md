# MCPfinder — TODO

## Done 2026-04-20

- [x] Multi-registry sync in `@mcpfinder/core` (Official + Glama + Smithery)
- [x] Ranked FTS search with alias expansion and popularity weighting
- [x] Install-config generator for 6 platforms (Claude Desktop, Cursor, Claude Code, Cline, Windsurf, VS Code)
- [x] Published `@mcpfinder/core@1.0.0` and `@mcpfinder/server@1.0.0` to npm
- [x] Published `dev.mcpfinder/server@1.0.0` to the Official MCP Registry
- [x] Set up ed25519 keypair auth via `https://mcpfinder.dev/.well-known/mcp-registry-auth`
- [x] Purged pre-pivot code, scripts, scrape dumps, and legacy docs from the repo

## Immediate follow-ups

- [ ] Deprecate pre-1.0 npm versions (needs OTP — user-initiated):
  ```
  npm deprecate '@mcpfinder/server@"1.0.0-beta.1 - 1.0.0-beta.7"' "superseded by 1.0.0"
  npm deprecate '@mcpfinder/server@"<=0.4.2"' "legacy API client; upgrade to 1.0.0"
  npm deprecate '@mcpfinder/core@"1.0.0-beta.1 - 1.0.0-beta.6"' "superseded by 1.0.0"
  ```
- [ ] Decide the `beta` dist-tag: move to `1.0.0` (no-op upgrade path) OR remove entirely.
- [ ] Landing page (`mcpfinder-landing` Cloudflare Pages project) — source lives outside this repo. Update copy: `v0.4.1` → `v1.0.0`, `MIT` → `AGPL-3.0`, `500+` → `5000+`, registry list → `Official + Glama + Smithery`.

## Next

- [ ] **Release automation** — GH Actions workflow on version tag: `pnpm publish --access public` both packages + `mcp-publisher publish` for the MCP Registry. Secrets: `NPM_TOKEN`, `MCP_REGISTRY_PRIVATE_KEY`.
- [ ] **Web UI at findmcp.dev** — optional browse interface for humans. Mentioned in README roadmap.

## Later

- [ ] Publisher monetization (Stripe Connect) — idea deferred until there's sustained upstream demand. Old doc-level plan has been removed; fresh design required if/when we pick this up.
- [ ] Federate as a subregistry (expose our merged catalog via the MCP Registry OpenAPI).
- [ ] Observability (sync counts, errors, latencies) — currently only local logs.
