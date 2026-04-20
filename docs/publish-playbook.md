# Publishing `@mcpfinder/server` — runbook

This document describes the current publish pipeline for the `packages/`
monorepo (canonical as of 2026-04-20). For background on why the repo now
has two packages instead of one, see `CLAUDE.md`.

## Artifacts that go out at each release

1. **`@mcpfinder/core`** on npm (the library).
2. **`@mcpfinder/server`** on npm (the MCP server, depends on `@mcpfinder/core`).
3. **`dev.mcpfinder/server`** in the Official MCP Registry (points at the npm
   package + declares the HTTP endpoint as a remote).

Three pubs, three ways to fail. Do them in this order every time.

## Prerequisites (one-time)

- Ed25519 keypair at `~/.config/mcpfinder-publish/privkey.hex` (chmod 600).
  Public half lives as a static file at
  `mcpfinder-www/public/.well-known/mcp-registry-auth` and is served from the
  Cloudflare Pages project `mcpfinder-landing` at
  `https://mcpfinder.dev/.well-known/mcp-registry-auth`. If that file is ever
  lost on the deployed site, republish from the Pages project — without it
  `mcp-publisher login http` fails.
- `mcp-publisher` CLI installed (`brew install mcp-publisher`).
- npm account with publish rights on the `@mcpfinder` scope.

## Release steps

```bash
# 1. Bump versions. Keep them synchronized: packages/core, packages/mcp-server,
#    packages/mcp-server/server.json (top-level + packages[0]), and the
#    version string in packages/mcp-server/src/index.ts:~30.

# 2. Install + build.
pnpm install
pnpm --filter @mcpfinder/core build
pnpm --filter @mcpfinder/server build

# 3. Validate the registry manifest.
mcp-publisher validate packages/mcp-server/server.json

# 4. Publish core first (server depends on it).
cd packages/core
pnpm publish --access=public --no-git-checks --otp=XXXXXX

# 5. Publish server.
cd ../mcp-server
pnpm publish --access=public --no-git-checks --otp=XXXXXX

# 6. Publish to the Official MCP Registry.
PRIVKEY=$(cat ~/.config/mcpfinder-publish/privkey.hex)
mcp-publisher login http --domain=mcpfinder.dev --private-key="$PRIVKEY"
mcp-publisher publish

# 7. Verify.
npm view @mcpfinder/server dist-tags
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=dev.mcpfinder" \
  | python3 -c 'import sys,json; [print(s["server"]["name"], s["server"]["version"]) for s in json.load(sys.stdin)["servers"]]'
```

## Things that have bitten us

- **OTP expiry between publishes.** npm requires a fresh OTP per publish. Even
  a minute's delay between the two `pnpm publish` calls can require a new code.
- **MCP Registry login token expiry.** If `npm publish` takes long because of
  OTP, the `mcp-publisher login` token from earlier has likely expired. Just
  re-login before `publish`. The error is `token has invalid claims: token is
  expired`.
- **Cloudflare route precedence.** Adding a Worker route for `mcpfinder.dev/.well-known/*`
  does **not** win against the Pages custom-domain binding. The well-known
  pubkey must live inside the Pages deployment, not the Worker.
- **Workspace ref in `@mcpfinder/server`'s deps.** We use
  `"@mcpfinder/core": "workspace:^"`. `pnpm publish` rewrites it to a real
  semver range at publish time; `npm publish` doesn't and will ship a broken
  package. Always use `pnpm publish`.
- **Pre-1.0 dist-tags and deprecations.** After 1.0.0 was cut, the `beta`
  dist-tag still pointed at `1.0.0-beta.7`. Decide per release whether to
  remove or move it; pre-1.0 versions are deprecated with
  `npm deprecate '@mcpfinder/server@"<=0.4.2"' "..."`.

## Registry identity

```
npm name:         @mcpfinder/server
MCP Registry:     dev.mcpfinder/server
Auth domain:      mcpfinder.dev
Auth mechanism:   HTTP well-known (ed25519)
Repository:       https://github.com/lksrz/mcpfinder (subfolder: packages/mcp-server)
```

## CI automation (not set up yet)

Sketch of a future GitHub Actions workflow triggered on tag `v*`:

1. Checkout, Node 20, pnpm.
2. `pnpm install && pnpm -r build`.
3. `pnpm -F @mcpfinder/core publish --access=public --no-git-checks --otp=$NPM_OTP` — or use a granular automation token that bypasses 2FA (requires npm account setting).
4. Same for `@mcpfinder/server`.
5. `mcp-publisher login http --domain=mcpfinder.dev --private-key=$MCP_REGISTRY_PRIVATE_KEY && mcp-publisher publish packages/mcp-server/server.json`.

Secrets needed in the repo:
- `NPM_TOKEN` (granular, scope `@mcpfinder`, automation level to skip OTP).
- `MCP_REGISTRY_PRIVATE_KEY` (contents of `privkey.hex`, a hex string, no newline).
