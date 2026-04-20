#!/usr/bin/env node
/**
 * Build a pre-synced DB snapshot for clients to bootstrap from.
 *
 * Output:
 *   dist/snapshot/data.sqlite         (uncompressed)
 *   dist/snapshot/data.sqlite.gz      (gzip, what clients download)
 *   dist/snapshot/manifest.json       (metadata + sha256 of the gz file)
 *
 * Usage (from repo root):
 *   node scripts/build-snapshot.mjs [--out=<dir>] [--no-glama] [--no-smithery]
 *
 * The script uses the built core package (packages/core/dist). Run
 *   pnpm --filter @mcpfinder/core build
 * first if it is stale.
 *
 * Upload step (done separately, e.g. in CI):
 *   wrangler r2 object put mcp-finder-db-snapshots/data.sqlite.gz \
 *     --file=dist/snapshot/data.sqlite.gz
 *   wrangler r2 object put mcp-finder-db-snapshots/manifest.json \
 *     --file=dist/snapshot/manifest.json
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

// Parse flags
const args = new Set(process.argv.slice(2));
const flag = (name) => args.has(name);
const argVal = (name) => {
  for (const a of args) if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  return null;
};
const outDir = resolve(repoRoot, argVal('--out') ?? 'dist/snapshot');

console.log(`[build-snapshot] out=${outDir}`);

// Fresh output dir
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// Load core from built package
const corePath = resolve(repoRoot, 'packages/core/dist/index.js');
try {
  await stat(corePath);
} catch {
  console.error(`[build-snapshot] core is not built at ${corePath}`);
  console.error(`                 run: pnpm --filter @mcpfinder/core build`);
  process.exit(1);
}

const {
  initDatabase,
  syncOfficialRegistry,
  syncGlamaRegistry,
  syncSmitheryRegistry,
  getServerCount,
  enrichSmitheryRepoUrls,
} = await import(corePath);

const dbPath = join(outDir, 'data.sqlite');
process.env.MCPFINDER_DATA_DIR = outDir;
const db = initDatabase(dbPath);

async function run(label, fn) {
  const t0 = Date.now();
  const n = await fn(db);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[build-snapshot] ${label}: +${n} (${dt}s, total=${getServerCount(db)})`);
  return n;
}

const counts = {};
counts.official = await run('official', syncOfficialRegistry);
if (!flag('--no-glama')) counts.glama = await run('glama   ', syncGlamaRegistry);
if (!flag('--no-smithery')) counts.smithery = await run('smithery', syncSmitheryRegistry);

// Fix 3 (build-only): GitHub probe enrichment for Smithery rows without a
// repo URL. Needs GITHUB_TOKEN; silently no-ops when absent.
let enrichStats = null;
if (!flag('--no-enrich')) {
  const t0 = Date.now();
  enrichStats = await enrichSmitheryRepoUrls(db);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[build-snapshot] enrich : probed=${enrichStats.probed} found=${enrichStats.repoFound} ` +
      `merged=${enrichStats.merged} rate-limited=${enrichStats.rateLimited} errors=${enrichStats.errors} (${dt}s)`,
  );
}

const serverCount = getServerCount(db);

// Collapse WAL so the file is self-contained
db.pragma('wal_checkpoint(TRUNCATE)');
db.exec('VACUUM');
db.close();

// Gzip the DB file
const gzPath = `${dbPath}.gz`;
await pipeline(createReadStream(dbPath), createGzip({ level: 9 }), createWriteStream(gzPath));

// Hash the gz file (clients verify this)
const hash = createHash('sha256');
for await (const chunk of createReadStream(gzPath)) hash.update(chunk);
const sha256 = hash.digest('hex');

const [rawSize, gzSize] = await Promise.all([
  stat(dbPath).then((s) => s.size),
  stat(gzPath).then((s) => s.size),
]);

const manifest = {
  publishedAt: new Date().toISOString(),
  serverCount,
  sha256,
  sizeBytes: gzSize,
  rawSizeBytes: rawSize,
  url: 'data.sqlite.gz',
  builder: process.env.GITHUB_SHA || 'local',
  counts,
  enrich: enrichStats,
};

await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log('[build-snapshot] manifest:');
console.log(JSON.stringify(manifest, null, 2));
console.log(`[build-snapshot] raw=${(rawSize / 1e6).toFixed(1)}MB gz=${(gzSize / 1e6).toFixed(1)}MB`);
