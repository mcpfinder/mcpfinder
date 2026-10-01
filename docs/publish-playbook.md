# Publish playbook

Releases are manual. Every release ships to **all three** destinations below, in
one go. npm and the official MCP Registry must always carry the same version.

1. npm: `@mcpfinder/core`, then `@mcpfinder/server`
2. Official MCP Registry: `dev.mcpfinder/server`
3. Git: annotated `v<version>` tag on `main`

## 1. Bump the version

The version lives in six places. Bump them together:

- `packages/core/package.json`
- `packages/mcp-server/package.json`
- `packages/mcp-server/server.json` (twice: top-level `version` and `packages[0].version`)
- `packages/mcp-server/manifest.json` (MCPB)
- `landing/public/.well-known/agents.json`

Run `pnpm test`, commit as `chore(release): v<version>`, tag with
`git tag -a v<version> -m "v<version>"`, and push `main` and the tag.

## 2. Publish to npm

```bash
npm whoami                       # must print the account; if 401, run `npm login` first
(cd packages/core && pnpm pack --pack-destination /tmp/mcpf)
(cd packages/mcp-server && pnpm pack --pack-destination /tmp/mcpf)
tar -xzOf /tmp/mcpf/mcpfinder-server-<version>.tgz package/package.json   # core dep must be ^<version>, not workspace:^
npm publish /tmp/mcpf/mcpfinder-core-<version>.tgz   --access public --otp=<code>
npm publish /tmp/mcpf/mcpfinder-server-<version>.tgz --access public --otp=<code>
```

- **Use `pnpm pack` + `npm publish`.** `pnpm pack` rewrites `workspace:^` into a real
  range. `pnpm publish --otp` fails with `ERR_PNPM_OTP_NON_INTERACTIVE`.
- **Publish core first.** Server depends on it.
- **Each publish needs a fresh OTP.**
- **A `404 Not Found - PUT` on publish usually means an expired npm session**, not a
  bad package or OTP. Check `npm whoami`.

## 3. Publish to the official MCP Registry

```bash
npm view @mcpfinder/server@<version> version   # wait until this resolves
cd packages/mcp-server
mcp-publisher validate
mcp-publisher publish                          # run `mcp-publisher login` first if the token expired
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=dev.mcpfinder" \
  | jq '.servers[] | {v: .server.version, latest: ._meta["io.modelcontextprotocol.registry/official"].isLatest}'
```

The Registry verifies the npm package and its `mcpName` (`dev.mcpfinder/server`
in `packages/mcp-server/package.json`). Publish only after npm serves the new
version. Confirm the new version is `isLatest: true`.
