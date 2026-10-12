#!/usr/bin/env node
/**
 * Run the real Glama sync and record every response for the build job to
 * replay (see glama-capture-lib.mjs). Runs on the self-hosted runners.
 *
 *   node scripts/glama-capture.mjs --out=<dir>
 *
 * Exits non-zero, writing no header, unless the sync finished with status ok:
 * the build job then fails its Glama sync and the quality gate keeps the
 * previous snapshot.
 */
import { setDefaultResultOrder } from 'node:dns';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecorder } from './glama-capture-lib.mjs';

setDefaultResultOrder('ipv4first');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.slice(2).find((a) => a.startsWith('--out='));
const outDir = resolve(repoRoot, outArg ? outArg.slice(6) : 'dist/glama-capture');
const corePath = resolve(repoRoot, 'packages/core/dist/index.js');
await stat(corePath);
const { initDatabase, syncGlamaRegistry } = await import(corePath);

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
const workDir = join(outDir, '.work');
await mkdir(workDir);
process.env.MCPFINDER_DATA_DIR = workDir;
const db = initDatabase(join(workDir, 'capture.sqlite'));

const startedAt = new Date().toISOString();
const recorder = createRecorder(outDir, fetch, { forbidden: [process.env.GLAMA_API_KEY] });
const t0 = Date.now();
let servers = 0;
let status = 'error';
try {
  servers = await syncGlamaRegistry(db, { fetchImpl: recorder.fetch });
  status = db.prepare("SELECT status FROM sync_log WHERE source = 'glama'").get()?.status ?? 'missing';
} finally {
  db.close();
  await rm(workDir, { recursive: true, force: true });
}
if (status !== 'ok') {
  console.error(`[glama-capture] sync status ${status}; not writing a capture header`);
  process.exit(1);
}
const header = await recorder.finish({ capturedAt: startedAt, syncStatus: status, servers });
console.log(
  `[glama-capture] servers=${servers} responses=${header.responses} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
);
