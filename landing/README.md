# landing

Static one-pager served at `https://mcpfinder.dev`.

Originally sourced from the Cloudflare Pages project
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

## Deploy

```bash
cd landing
npx wrangler deploy
```

The Worker has the `mcpfinder.dev` Custom Domain. Wrangler disables its
`workers.dev` and preview URLs. Check the production domain after deploy;
do not use an alternate public Worker URL for verification.

## Earlier Pages cutover

The landing page started on the `mcpfinder-landing` Pages project. The
current Worker Custom Domain was attached after that cutover; do not add
the same hostname as a Worker Route in `wrangler.toml`.

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
as origin + known path (anything else becomes `/404`) + `utm_*`/`gclid`-style
params only (values with `@` or over 100 chars dropped); other query params and
the fragment are dropped. A same-origin `page_referrer` is cleaned the same way,
an external one is cut to its origin. Add new pages to `KNOWN_PATHS` in
`analytics.js`.

## Content state

Reconciled with the 1.0.0 release on 2026-04-20: version, license
(AGPL-3.0), registry list (Official + Glama; Smithery dropped 2026-10, its API shuts
down 2026-10-31), AI-facing docs,
and canonical stdio positioning all match the code. Avoid hard-coding raw
server counts in copy unless they are driven from snapshot metadata or a
build-time source of truth.

The `.well-known/mcp-registry-auth` file is load-bearing — it's how
`mcp-publisher login http --domain=mcpfinder.dev` proves ownership. Don't
remove or rotate the pubkey without also rotating the local privkey at
`~/.config/mcpfinder-publish/privkey.hex`.
