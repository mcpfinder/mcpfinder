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
│   ├── analytics.js                        # GA4 (G-LPLFNBLWG4) + conversion events, included by every page
│   ├── llms.txt                            # short AI-facing discovery guide
│   ├── llms-full.txt                       # expanded AI-facing manual
│   ├── robots.txt
│   ├── sitemap.xml
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

## Analytics

Every HTML page includes `/analytics.js` (GA4 property 524776900,
`G-LPLFNBLWG4`). gtag.js is only fetched on `mcpfinder.dev`, so workers.dev
previews and local servers never report into production. Conversion events:

- `copy_install_snippet` (`snippet`, `copy_method`) — copying any element
  marked `data-snippet="…"`, or clicking the "click to copy" CTA.
- `click_install_link` (`destination`: `npm`) — following the npm package link.

`click_repo_link` (GitHub repo link, also in nav/footer) is tracked but is not
a conversion.

Add `data-snippet` to new install snippets so copies are counted. Never put
copied text or other user content into event params. `page_location` is sent
as origin + path + `utm_*`/`gclid`-style params only; other query params and
the fragment are dropped.

## Content state

Reconciled with the 1.0.0 release on 2026-04-20: version, license
(AGPL-3.0), registry list (Official + Glama + Smithery), AI-facing docs,
and canonical stdio positioning all match the code. Avoid hard-coding raw
server counts in copy unless they are driven from snapshot metadata or a
build-time source of truth.

The `.well-known/mcp-registry-auth` file is load-bearing — it's how
`mcp-publisher login http --domain=mcpfinder.dev` proves ownership. Don't
remove or rotate the pubkey without also rotating the local privkey at
`~/.config/mcpfinder-publish/privkey.hex`.
