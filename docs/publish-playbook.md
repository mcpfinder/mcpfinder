# Publish playbook

Releases are manual. Every release ships to **all three** destinations below, in
one go. npm and the official MCP Registry must always carry the same version.

1. npm: `@mcpfinder/core`, then `@mcpfinder/server`
2. Official MCP Registry: `dev.mcpfinder/server`
3. Git: annotated `v<version>` tag on `main`

## 1. Bump the version

The version lives in these places. Bump them together:

- `packages/core/package.json`
- `packages/mcp-server/package.json` (including its `workspace:^<version>` core dependency)
- `packages/core/CHANGELOG.md` and `packages/mcp-server/CHANGELOG.md`
- `packages/mcp-server/server.json` (twice: top-level `version` and `packages[0].version`)
- `packages/mcp-server/manifest.json` (MCPB)
- `landing/public/.well-known/agents.json`
- `landing/public/index.html`: the hero eyebrow (`Open-source MCP server · v<version> · AGPL-3.0`),
  the footer line (`MCPfinder v<version> · last updated …`), `softwareVersion`
  (SoftwareApplication JSON-LD) and `version` (SoftwareSourceCode JSON-LD), plus their
  `dateModified`
- `landing/public/llms.txt` and `landing/public/llms-full.txt` (`Version:` and
  `Last-Updated:` headers)
- `landing/public/sitemap.xml`: `<lastmod>` of every page or file you changed above
  (`/`, `/llms.txt`, `/llms-full.txt`)

Redeploy the landing worker after the npm publish so the site shows the published version.

Complete the tests, package/consumer checks below and code review before any npm
publication. Commit the reviewed source on `main`; tag with
`git tag -a v<version> -m "v<version>"` and push the tag only as part of the
verified coupled release. A security fix may use its own descriptive commit title.

## 2. Prepare and verify both npm artifacts

Keep the repository's isolated linker and existing `node_modules` untouched.
Create two fresh source-only release checkouts of the same reviewed commit,
without private environment files or data. Use a normal frozen hoisted install
in the validation checkout for tests and the core artifact.
The server's standard `bundleDependencies` contains the SDK and Zod; pnpm 11
requires hoisted linking when packing these complete runtime trees.

```bash
# From the validation checkout; both paths must be absolute:
validation="$PWD"
server_stage=/absolute/path/to/fresh-server-checkout
artifacts=/absolute/path/to/empty-artifacts
pnpm --config.node-linker=hoisted install --frozen-lockfile --ignore-scripts --config.verify-store-integrity=true
pnpm test
mkdir "$artifacts"
(cd packages/core && pnpm --config.node-linker=hoisted pack --skip-manifest-obfuscation --pack-destination "$artifacts")
# Give server prepack the already validated core build, without installing over
# the validation checkout. Absolute modules-dir is required for every importer.
cp -R "$validation/packages/core/dist" "$server_stage/packages/core/dist"
(cd "$server_stage" && pnpm --config.node-linker=hoisted install --frozen-lockfile --ignore-scripts --config.verify-store-integrity=true --modules-dir="$server_stage/packages/mcp-server/node_modules")
(cd "$server_stage/packages/mcp-server" && pnpm --config.node-linker=hoisted pack --skip-manifest-obfuscation --pack-destination "$artifacts")
tar -xzOf "$artifacts/mcpfinder-server-<version>.tgz" package/package.json
```

- The server's package-local modules keep bundled tar paths contained. Run the
  full tests in the validation checkout, whose normal hoisted layout also serves
  core's development dependencies. Keep all validation logs outside both packages.
- Keep `packages/mcp-server/LICENSE` byte-identical to the root `LICENSE` and
  verify both artifacts contain it. Bundled third-party licenses can suppress
  pnpm's automatic workspace-license fallback.
- **Use `pnpm pack` + `npm publish`.** `pnpm pack` rewrites `workspace:^` into a real
  range. `pnpm publish --otp` fails with `ERR_PNPM_OTP_NON_INTERACTIVE`.
- Inspect the canonical packed manifest: the core range must be `^<version>`,
  both bundles must be declared, and development scripts/public interfaces must
  remain intact. Do not strip manifest fields or manually edit tar contents.
- Verify the complete packed SDK/Zod dependency closure, licenses/notices and
  integrity against the audited lock. Check actual SDK → Express → proxy-addr
  and qs resolution; do not infer it from private workspace overrides.
- Test the actual two tarballs in fresh and older locked consumer hosts with
  npm 11, npm 12 and pnpm 11. For an unpublished core, npm fixtures can install
  both real tarballs together; pnpm fixtures can use a scoped override pointing
  only `@mcpfinder/core` to its actual tarball. Verify that the server uses that
  artifact. Never override third-party dependencies in these consumer proofs.
- Inspect entrypoint resolution without starting the MCP CLI: even `--help` or
  `--version` can start stdio and catalog synchronization. Use isolated synthetic
  transports/databases for the existing application tests.
- In each consumer fixture, run
  `node scripts/check-packed-runtime.mjs /absolute/path/to/installed/@mcpfinder/server`
  from the validation checkout. It reads package metadata and the audited lock;
  it checks every reachable bundled runtime dependency against the server
  importer's locked snapshots and requires resolution inside the bundle, without
  importing application code. The complete archive/closure/license audit remains required.
- **Both artifacts, consumer proofs and review must pass before publishing either
  package.** Do not publish core early just to make a consumer fixture resolve.

## 3. Publish to npm

Only after those checks are complete, authenticate and obtain fresh OTPs:

```bash
npm whoami                       # must print the account; if 401, run `npm login` first
npm publish "$artifacts/mcpfinder-core-<version>.tgz"   --access public --otp=<code>
npm publish "$artifacts/mcpfinder-server-<version>.tgz" --access public --otp=<code>
```

- **Publish core first, then server.** Server depends on it; both artifacts are
  already verified before this step.
- **Each publish needs a fresh OTP.**
- **A `404 Not Found - PUT` on publish usually means an expired npm session**, not a
  bad package or OTP. Check `npm whoami`.

## 4. Publish to the official MCP Registry

```bash
npm view @mcpfinder/server@<version> version   # wait until this resolves
cd packages/mcp-server
mcp-publisher validate
# The Registry JWT lives ~5 minutes, so log in fresh for every release:
PRIV=$(openssl pkey -in ~/.config/mcp-publisher/mcpfinder-registry-key.pem -outform DER | tail -c 32 | xxd -p -c 64)
mcp-publisher login http --domain mcpfinder.dev --private-key "$PRIV"
mcp-publisher publish
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=dev.mcpfinder" \
  | jq '.servers[] | {v: .server.version, latest: ._meta["io.modelcontextprotocol.registry/official"].isLatest}'
```

The Registry verifies the npm package and its `mcpName` (`dev.mcpfinder/server`
in `packages/mcp-server/package.json`). Publish only after npm serves the new
version. Confirm the new version is `isLatest: true`.

### Registry signing key

Namespace ownership of `dev.mcpfinder/*` is proven over HTTP. The ed25519
public key is served from `landing/public/.well-known/mcp-registry-auth`. The
private key is **not** in the repo. It lives in
`~/.config/mcp-publisher/mcpfinder-registry-key.pem` on the release machine;
back it up to the password manager.

If the key is lost, rotate it:

1. `openssl genpkey -algorithm Ed25519 -out <pem>`
2. Write the new public key:
   `echo "v=MCPv1; k=ed25519; p=$(openssl pkey -in <pem> -pubout -outform DER | tail -c 32 | base64)" > landing/public/.well-known/mcp-registry-auth`
3. Deploy the landing: `cd landing && npx wrangler deploy`. Production is the
   `mcpfinder-landing-www` worker on the `mcpfinder.dev` custom domain.
4. Confirm `curl https://mcpfinder.dev/.well-known/mcp-registry-auth` shows the
   new key, then commit the file.
