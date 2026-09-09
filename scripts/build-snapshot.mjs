#!/usr/bin/env node
/**
 * Build a pre-synced DB snapshot for clients to bootstrap from.
 *
 * Output:
 *   dist/snapshot/data.sqlite         (uncompressed)
 *   dist/snapshot/data.sqlite.gz      (gzip, the compatibility artifact)
 *   dist/snapshot/data.sqlite.br      (brotli, ~21% smaller, preferred by new clients;
 *                                      best-effort — omitted from the manifest if it fails)
 *   dist/snapshot/data.sqlite.gz.sha256 (durable fallback commit marker)
 *   dist/snapshot/manifest.json       (metadata + a sha256 per artifact)
 *
 * Usage (from repo root):
 *   node scripts/build-snapshot.mjs [--out=<dir>] [--no-glama] [--no-smithery]
 *     [--allow-quality-regression]
 *
 * The script uses the built core package (packages/core/dist). Run
 *   pnpm --filter @mcpfinder/core build
 * first if it is stale.
 *
 * Upload step (done separately, e.g. in CI):
 *   wrangler r2 object put mcp-finder-db-snapshots/snapshots/<sha256>.sqlite.gz \
 *     --file=dist/snapshot/data.sqlite.gz
 *   wrangler r2 object put mcp-finder-db-snapshots/snapshots/<brSha256>.sqlite.br \
 *     --file=dist/snapshot/data.sqlite.br
 *   # Publish this mutable pointer only after the gz upload succeeds, and only
 *   # with a `brotli` block if that artifact is uploaded and verified too.
 *   wrangler r2 object put mcp-finder-db-snapshots/manifest.json \
 *     --file=dist/snapshot/manifest.json
 */
import { setDefaultResultOrder } from 'node:dns';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { constants as zlibConstants, createBrotliCompress, createGzip, gunzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateCurrentSnapshotQuality,
  evaluateSnapshotQuality,
  fetchPreviousManifest,
} from './snapshot-quality.mjs';
import { snapshotBrotliManifestUrl, snapshotManifestUrl } from '../shared/snapshot-artifacts.js';

// GitHub-hosted ubuntu-latest advertises AAAA records whose routes black-hole.
// Node's default DNS order tries those first; undici then sits on connect until
// the 20 s request abort. Two snapshot runs on 2026-09-09 burned Official's
// entire 8-minute budget in fetchWithRetry (no `official: +N` line) while the
// same registry answered a page in 0.7 s from a dual-stack Mac. IPv4-first is
// the standard Actions workaround (actions/runner#3213).
setDefaultResultOrder('ipv4first');

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
const allowQualityRegression =
  flag('--allow-quality-regression') || process.env.MCPFINDER_SNAPSHOT_QUALITY_OVERRIDE === '1';
// All three registries are required: an incomplete snapshot never replaces a
// complete one. A failed build simply leaves `manifest.json` untouched, so
// clients keep bootstrapping from the previous, complete snapshot — stale by a
// day at worst, and the staleness is visible in `publishedAt`. Missing servers
// would not be.
const requiredSources = ['official'];
if (!flag('--no-glama')) requiredSources.push('glama');
if (!flag('--no-smithery')) requiredSources.push('smithery');
// No source is best-effort today. The mechanism stays wired up (and tested, see
// scripts/snapshot-quality.mjs) so a registry that closes permanently can be
// demoted by moving one name here, rather than by rebuilding the gate under
// pressure.
const optionalSources = [];

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
  enrichDeprecationFlags,
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

// Published snapshot and manifest: last-known-good baseline for enrichment and
// publication quality checks.
const PREV_MANIFEST_URL = 'https://mcpfinder.dev/api/v1/snapshot/manifest.json';

// Start this request before registry sync so it does not extend the critical
// path. Convert rejection into a handled result immediately; only a confirmed
// 404 resolves to null, while exhausted transient/schema failures fail closed.
const previousManifestPromise = fetchPreviousManifest({
  url: PREV_MANIFEST_URL,
  requiredSources,
}).then(
  (manifest) => ({ manifest, error: null }),
  (error) => ({ manifest: null, error }),
);

/**
 * Seed deprecation/archived flags (and their probe timestamps) into the freshly
 * built DB from the previously published snapshot, keyed by stable server id.
 *
 * The DB is rebuilt from scratch every run, so without this the enrichment
 * probes would re-scan all ~25k repos each time and never finish within the
 * GitHub API budget. Carrying flags forward makes `enrichDeprecationFlags`
 * genuinely incremental — only new and stale rows get probed.
 *
 * Returns the number of rows seeded. Throws if the previous snapshot can't be
 * fetched (e.g. the very first build) — the caller treats that as a soft skip.
 */
async function carryOverFlags(targetDb, workDir, previousManifest) {
  if (!previousManifest) throw new Error('previous manifest is not available');
  const snapshotUrl = new URL(previousManifest.url, PREV_MANIFEST_URL).toString();
  const res = await fetch(snapshotUrl);
  if (!res.ok) throw new Error(`fetch previous snapshot: HTTP ${res.status}`);
  const prevPath = join(workDir, 'prev.sqlite');
  await writeFile(prevPath, gunzipSync(Buffer.from(await res.arrayBuffer())));

  targetDb.exec(`ATTACH DATABASE '${prevPath.replace(/'/g, "''")}' AS prev`);
  try {
    const prevCols = new Set(
      targetDb.prepare(`SELECT name FROM prev.pragma_table_info('servers')`).all().map((c) => c.name),
    );
    // Older snapshots predate the *_checked_at columns — carry whatever exists.
    const cols = [
      'archived_repo',
      'archived_repo_checked_at',
      'deprecated_npm',
      'deprecated_npm_checked_at',
    ].filter((c) => prevCols.has(c));
    if (cols.length === 0) return 0;
    const setClause = cols
      .map((c) => `${c} = (SELECT p.${c} FROM prev.servers p WHERE p.id = servers.id)`)
      .join(', ');
    const info = targetDb
      .prepare(`UPDATE servers SET ${setClause} WHERE id IN (SELECT id FROM prev.servers)`)
      .run();
    return info.changes;
  } finally {
    targetDb.exec('DETACH DATABASE prev');
    await rm(prevPath, { force: true });
  }
}

const counts = {};
counts.official = await run('official', syncOfficialRegistry);
if (!flag('--no-glama')) counts.glama = await run('glama   ', syncGlamaRegistry);
if (!flag('--no-smithery')) counts.smithery = await run('smithery', syncSmitheryRegistry);

function syncLogEntries() {
  return db
    .prepare('SELECT source, server_count, status, error FROM sync_log')
    .all();
}

async function rejectBadSnapshot(previous, current) {
  const quality = evaluateSnapshotQuality({
    syncLog: syncLogEntries(),
    requiredSources,
    optionalSources,
    current,
    previous,
    allowRegression: allowQualityRegression,
  });
  for (const warning of quality.warnings) {
    console.warn(`[build-snapshot] quality warning: ${warning}`);
  }
  if (!quality.ok) {
    db.close();
    await rm(outDir, { recursive: true, force: true });
    throw new Error(`snapshot quality gate failed:\n- ${quality.errors.join('\n- ')}`);
  }
}

async function rejectBadCurrentSnapshot(current) {
  const quality = evaluateCurrentSnapshotQuality({
    syncLog: syncLogEntries(),
    requiredSources,
    optionalSources,
    current,
  });
  for (const warning of quality.warnings) {
    console.warn(`[build-snapshot] quality warning: ${warning}`);
  }
  if (!quality.ok) {
    db.close();
    await rm(outDir, { recursive: true, force: true });
    throw new Error(`snapshot quality gate failed:\n- ${quality.errors.join('\n- ')}`);
  }
}

async function rejectBaselineFetch(error) {
  db.close();
  await rm(outDir, { recursive: true, force: true });
  throw new Error(`snapshot quality gate failed: ${error?.message ?? error}`);
}

// Fail fast on degraded registry state. Using the same counts as both sides
// disables only the regression portion of this first pass.
const postSyncState = { serverCount: getServerCount(db), counts };
await rejectBadCurrentSnapshot(postSyncState);

// Resolve the already-handled baseline request before enrichment. Its URL also
// selects the exact immutable DB used for flag carry-over.
const previousResult = await previousManifestPromise;
if (previousResult.error) await rejectBaselineFetch(previousResult.error);

// Carry deprecation/archived flags forward from the last published snapshot so
// the enrichment probes stay incremental (skipped with --no-carryover).
let carriedOver = 0;
if (!flag('--no-carryover')) {
  const c0 = Date.now();
  try {
    carriedOver = await carryOverFlags(db, outDir, previousResult.manifest);
    const cdt = ((Date.now() - c0) / 1000).toFixed(1);
    console.log(`[build-snapshot] carry  : ${carriedOver} rows seeded from previous snapshot (${cdt}s)`);
  } catch (err) {
    console.warn(`[build-snapshot] carry  : skipped (${err?.message ?? err})`);
  }
}

// Build-time enrichment passes (skipped with --no-enrich).
let enrichStats = null;
let deprecationStats = null;
if (!flag('--no-enrich')) {
  const t0 = Date.now();
  enrichStats = await enrichSmitheryRepoUrls(db);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[build-snapshot] enrich : probed=${enrichStats.probed} found=${enrichStats.repoFound} ` +
      `merged=${enrichStats.merged} rate-limited=${enrichStats.rateLimited} errors=${enrichStats.errors} (${dt}s)`,
  );

  // Deprecation flags: npm (fast, no token needed) + GitHub archived
  // (requires GITHUB_TOKEN, otherwise skipped with a stderr note).
  const d0 = Date.now();
  deprecationStats = await enrichDeprecationFlags(db);
  const dd = ((Date.now() - d0) / 1000).toFixed(1);
  console.log(
    `[build-snapshot] deprec : npm(probed=${deprecationStats.npm.probed} flagged=${deprecationStats.npm.flagged} ` +
      `errors=${deprecationStats.npm.errors}) archived(probed=${deprecationStats.github.probed} flagged=${deprecationStats.github.flagged} ` +
      `rate-limited=${deprecationStats.github.rateLimited} errors=${deprecationStats.github.errors}) (${dd}s)`,
  );
}

const serverCount = getServerCount(db);

// Last-known-good gate: a healthy sync can still be unexpectedly sparse due
// to upstream API behavior or enrichment merges. Refuse to replace the
// published manifest when total or per-source counts fall by more than 5%.
await rejectBadSnapshot(previousResult.manifest, { serverCount, counts });

// Collapse WAL so the file is self-contained
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.exec('VACUUM');
db.close();

const rawSize = await stat(dbPath).then((s) => s.size);

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

// Gzip the DB file. This artifact is the snapshot identity and the only one
// published clients before 1.3.0 know about — it never goes away.
const gzPath = `${dbPath}.gz`;
await pipeline(createReadStream(dbPath), createGzip({ level: 9 }), createWriteStream(gzPath));

// Brotli the same DB file. Quality 9 with a 16MB window compresses ~21% better
// than gzip in about 20s; q11 costs orders of magnitude more time for a
// marginal gain, so it is deliberately not used.
//
// Best-effort throughout: a brotli failure here leaves the manifest without a
// `brotli` block and the build publishes gzip alone. The manifest must never
// announce an artifact that does not exist, and a bandwidth optimisation must
// never be the reason a good snapshot goes unpublished.
const brPath = `${dbPath}.br`;
let brotli = null;
try {
  await pipeline(
    createReadStream(dbPath),
    createBrotliCompress({
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
        [zlibConstants.BROTLI_PARAM_LGWIN]: 24,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: rawSize,
      },
    }),
    createWriteStream(brPath),
  );
  brotli = {
    sha256: await sha256File(brPath),
    sizeBytes: await stat(brPath).then((s) => s.size),
  };
} catch (error) {
  console.warn(
    '::warning::[build-snapshot] brotli compression failed, publishing gzip only: ' +
      error.message,
  );
  // Cleanup is best-effort too: failing to remove a partial .br must not take
  // down a build whose gz artifact is already fit to publish.
  await rm(brPath, { force: true }).catch(() => {});
}

// Each artifact carries its own digest and size: clients verify the bytes they
// actually downloaded, never the other artifact's.
const sha256 = await sha256File(gzPath);
await writeFile(join(outDir, 'data.sqlite.gz.sha256'), `${sha256}\n`);

const gzSize = await stat(gzPath).then((s) => s.size);

const manifest = {
  publishedAt: new Date().toISOString(),
  serverCount,
  // `sha256`/`sizeBytes`/`url` describe the gz artifact and are the snapshot's
  // stable identity — clients record the sha in their pointer and compare it on
  // every freshness check, so it must not become the brotli digest.
  sha256,
  sizeBytes: gzSize,
  rawSizeBytes: rawSize,
  url: snapshotManifestUrl(sha256),
  // Optional and additive — omitted entirely when the artifact is not there.
  ...(brotli
    ? {
        brotli: {
          url: snapshotBrotliManifestUrl(brotli.sha256),
          sha256: brotli.sha256,
          sizeBytes: brotli.sizeBytes,
        },
      }
    : {}),
  builder: process.env.GITHUB_SHA || 'local',
  counts,
  carriedOver,
  enrich: enrichStats,
  deprecation: deprecationStats,
};

await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log('[build-snapshot] manifest:');
console.log(JSON.stringify(manifest, null, 2));
console.log(
  `[build-snapshot] raw=${(rawSize / 1e6).toFixed(1)}MB gz=${(gzSize / 1e6).toFixed(1)}MB ` +
    `br=${brotli ? `${(brotli.sizeBytes / 1e6).toFixed(1)}MB` : 'unavailable'}`,
);
