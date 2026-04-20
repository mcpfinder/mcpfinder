# landing

Static one-pager served at `https://mcpfinder.dev`.

Sourced from the currently-deployed Cloudflare Pages project
`mcpfinder-landing` (commit `864013f`, Feb 2026) and copied into this repo
on 2026-04-20 so the site lives alongside the code.

## Layout

```
landing/
├── public/
│   ├── index.html                          # one-pager, fully self-contained (inline CSS)
│   └── .well-known/
│       └── mcp-registry-auth              # ed25519 pubkey for the MCP Registry proof
└── wrangler.toml
```

## Deploy (preview on workers.dev)

```bash
cd landing
npx wrangler deploy
```

Deploys to `https://mcpfinder-landing-www.<account>.workers.dev`. Does
**not** take over `mcpfinder.dev` — the existing Pages project still owns
that domain. Use the preview URL to verify the site before cutover.

## Cutover from Pages to Workers

Current state: `mcpfinder.dev` is served by the Cloudflare Pages project
`mcpfinder-landing`. To switch to a Worker deploy:

1. Verify the preview URL looks right.
2. In the Cloudflare dashboard, detach the `mcpfinder.dev` custom domain
   from the `mcpfinder-landing` Pages project.
3. Uncomment the `routes` block in `wrangler.toml`.
4. `npx wrangler deploy` — the Worker now owns `mcpfinder.dev/*`.

Keep the old Pages project around for a rollback window. When you're
confident, delete it in the dashboard.

## What's NOT up to date

The snapshot reflects the Feb 2026 site copy. The page still advertises
`v0.4.1`, `MIT license`, and `500+ servers` — outdated vs the 1.0.0 /
AGPL-3.0 / 5000+ reality. Content refresh is tracked in the root `TODO.md`.

The `.well-known/mcp-registry-auth` file is load-bearing — it's how
`mcp-publisher login http --domain=mcpfinder.dev` proves ownership. Don't
remove or rotate the pubkey without also rotating the local privkey at
`~/.config/mcpfinder-publish/privkey.hex`.
