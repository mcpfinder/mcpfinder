# @mcpfinder/core

> Shared library for MCPfinder: multi-registry sync, SQLite+FTS5 search, trust-signal enrichment, and install-config generation.

[![npm](https://img.shields.io/npm/v/@mcpfinder/core.svg)](https://www.npmjs.com/package/@mcpfinder/core)
[![license](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](https://www.gnu.org/licenses/agpl-3.0.en.html)

This is the internal library that powers [`@mcpfinder/server`](https://www.npmjs.com/package/@mcpfinder/server)
— the MCP server that discovers and installs other MCP servers from the
Official MCP Registry, Glama, and Smithery.

Most users should install `@mcpfinder/server`, not this package directly.
Use `@mcpfinder/core` only when you want to embed the search/enrichment engine
into a custom tool (e.g. a web UI, a bot, or a batch job).

## Install

```bash
npm install @mcpfinder/core
# or
pnpm add @mcpfinder/core
```

Node.js 20+ required (better-sqlite3 native bindings).

## Quick start

```ts
import {
  initDatabase,
  syncOfficialRegistry,
  syncGlamaRegistry,
  syncSmitheryRegistry,
  searchServers,
  getServerDetails,
} from '@mcpfinder/core';

const db = initDatabase(); // stores in ~/.mcpfinder/data.db by default

await Promise.all([
  syncOfficialRegistry(db),
  syncGlamaRegistry(db),
  syncSmitheryRegistry(db),
]);

const results = searchServers(db, 'postgres', 5);
for (const r of results) {
  console.log(r.name, r.confidenceScore, r.warningFlags);
}

const detail = getServerDetails(db, results[0].name);
```

## Snapshot bootstrap (fast cold start)

Skip the ~10 minute live sync by downloading a prebuilt snapshot:

```ts
import { bootstrapFromSnapshot } from '@mcpfinder/core';

await bootstrapFromSnapshot(); // downloads from https://mcpfinder.dev/api/v1/snapshot
```

## Exports

| Export | Purpose |
| --- | --- |
| `initDatabase(path?)` | Open (or create) the local SQLite DB with FTS5 schema. |
| `syncOfficialRegistry / syncGlamaRegistry / syncSmitheryRegistry` | Live sync from upstream registries. |
| `bootstrapFromSnapshot` | Fast cold-start via prebuilt SQLite snapshot. |
| `searchServers` | Ranked full-text search + filters. |
| `getServerDetails` | Full metadata for one server (env vars, tools, trust signals). |
| `listCategories / getServersByCategory` | Category browsing. |
| `getInstallCommand` | Generate client-specific JSON install config. |
| `enrichSmitheryRepoUrls / enrichDeprecationFlags` | Build-time enrichment passes (GitHub probe, npm/GitHub deprecation flags). |

Full TypeScript types are exported — see the `.d.ts` files in `dist/`.

## Links

- **Source + issues:** https://github.com/mcpfinder/mcpfinder
- **Higher-level server:** [`@mcpfinder/server`](https://www.npmjs.com/package/@mcpfinder/server)
- **Website:** https://mcpfinder.dev

## License

[AGPL-3.0-or-later](https://www.gnu.org/licenses/agpl-3.0.en.html)
