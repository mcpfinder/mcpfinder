import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  currentSnapshotFallbackKey,
  snapshotBrotliDataKey,
  snapshotBrotliManifestUrl,
  snapshotDataKey,
  snapshotManifestUrl,
} from '../shared/snapshot-artifacts.js';
import {
  createSnapshotProofCache,
  getVerifiedCurrentFallback,
  loadCurrentSnapshotSha,
  resolveVerifiedCurrentFallback,
} from '../shared/snapshot-proof-cache.js';
import { runSnapshotFreezeChecks } from './snapshot-freeze-checks.mjs';
import {
  isMainModule,
  verifyOptionalBrotli,
  verifySnapshotUpload,
} from './verify-snapshot-upload.mjs';

const sha = 'a'.repeat(64);

const entrypointDir = await mkdtemp(join(tmpdir(), 'mcpfinder-preflight-main-'));
try {
  const scriptUrl = new URL('./verify-snapshot-upload.mjs', import.meta.url);
  const symlinkPath = join(entrypointDir, 'snapshot-preflight-link.mjs');
  await symlink(scriptUrl, symlinkPath);
  assert.equal(await isMainModule({ moduleUrl: scriptUrl.href, argv1: symlinkPath }), true);
  assert.equal(await isMainModule({ moduleUrl: scriptUrl.href, argv1: process.argv[1] }), false);
  assert.equal(
    await isMainModule({
      moduleUrl: scriptUrl.href,
      argv1: symlinkPath,
      realpathImpl: async () => {
        throw new Error('realpath unavailable');
      },
    }),
    false,
  );
  assert.equal(await realpath(symlinkPath), await realpath(new URL(scriptUrl)));
} finally {
  await rm(entrypointDir, { recursive: true, force: true });
}
assert.equal(snapshotManifestUrl(sha), `data.sqlite.gz?sha=${sha}`);
assert.deepEqual(snapshotDataKey(sha), {
  key: `snapshots/${sha}.sqlite.gz`,
  immutable: true,
});
assert.deepEqual(snapshotDataKey(undefined), { key: 'data.sqlite.gz', immutable: false });
for (const invalid of ['', 'A'.repeat(64), 'a'.repeat(63), '../manifest.json']) {
  assert.throws(() => snapshotDataKey(invalid), /64 lowercase hex/);
}

// Brotli artifacts are content-addressed by their own digest and exist only
// under the immutable prefix — there is no mutable `data.sqlite.br` twin.
const brSha = 'b'.repeat(64);
assert.equal(snapshotBrotliManifestUrl(brSha), `data.sqlite.br?sha=${brSha}`);
assert.deepEqual(snapshotBrotliDataKey(brSha), {
  key: `snapshots/${brSha}.sqlite.br`,
  immutable: true,
});
assert.throws(() => snapshotBrotliDataKey(undefined), /requires a sha/);
assert.throws(() => snapshotBrotliDataKey(null), /requires a sha/);
for (const invalid of ['', 'B'.repeat(64), 'b'.repeat(63), '../manifest.json']) {
  assert.throws(() => snapshotBrotliDataKey(invalid), /64 lowercase hex/);
}
assert.equal(currentSnapshotFallbackKey(sha, { sha256: sha }, sha), 'data.sqlite.gz');
assert.equal(currentSnapshotFallbackKey(sha, { sha256: sha }, `${sha}\n`), 'data.sqlite.gz');
assert.equal(currentSnapshotFallbackKey(sha, { sha256: 'b'.repeat(64) }, sha), null);
assert.equal(currentSnapshotFallbackKey(sha, { sha256: sha }, 'b'.repeat(64)), null);
assert.equal(currentSnapshotFallbackKey(sha, { sha256: sha }, 'invalid'), null);
assert.equal(currentSnapshotFallbackKey(sha, { sha256: sha }, `${sha}\n\n`), null);
assert.equal(currentSnapshotFallbackKey(sha, { sha256: sha }, null), null);
assert.equal(currentSnapshotFallbackKey('invalid', { sha256: sha }, sha), null);
assert.equal(currentSnapshotFallbackKey(sha, { sha256: 'invalid' }, sha), null);
assert.equal(currentSnapshotFallbackKey(sha, null, sha), null);

function proofObject(text) {
  return { size: Buffer.byteLength(text), text: async () => text };
}
let proofNow = 0;
const proofGets = { manifest: 0, marker: 0, legacy: 0 };
const proofObjects = {
  'manifest.json': proofObject(JSON.stringify({ sha256: sha })),
  'data.sqlite.gz.sha256': proofObject(`${sha}\n`),
};
const loadProof = () =>
  loadCurrentSnapshotSha(async (key) => {
    if (key === 'manifest.json') proofGets.manifest++;
    else proofGets.marker++;
    return proofObjects[key];
  });
const getLegacy = async () => {
  proofGets.legacy++;
  return { key: 'data.sqlite.gz' };
};
const proofCache = createSnapshotProofCache({ ttlMs: 300_000, now: () => proofNow });
await Promise.all(
  Array.from({ length: 12 }, (_, index) =>
    getVerifiedCurrentFallback({
      requestedSha: index.toString(16).padStart(64, '0'),
      proofCache,
      loadProof,
      getLegacy,
    }),
  ),
);
assert.deepEqual(proofGets, { manifest: 1, marker: 1, legacy: 0 });
assert.equal(
  await getVerifiedCurrentFallback({
    requestedSha: 'b'.repeat(64),
    proofCache,
    loadProof,
    getLegacy,
  }),
  null,
);
assert.deepEqual(proofGets, { manifest: 1, marker: 1, legacy: 0 });
assert.deepEqual(
  await getVerifiedCurrentFallback({ requestedSha: sha, proofCache, loadProof, getLegacy }),
  { key: 'data.sqlite.gz' },
);
assert.deepEqual(proofGets, { manifest: 1, marker: 1, legacy: 1 });
proofNow = 300_000;
await getVerifiedCurrentFallback({
  requestedSha: 'c'.repeat(64),
  proofCache,
  loadProof,
  getLegacy,
});
assert.deepEqual(proofGets, { manifest: 2, marker: 2, legacy: 1 });

let malformedLoads = 0;
const malformedCache = createSnapshotProofCache({ ttlMs: 300_000, now: () => 0 });
const malformedProof = async () => {
  malformedLoads++;
  return loadCurrentSnapshotSha(async (key) =>
    key === 'manifest.json' ? proofObject('{broken json') : proofObject('not-a-sha'),
  );
};
await Promise.all(Array.from({ length: 8 }, () => malformedCache.get(malformedProof)));
assert.equal(await malformedCache.get(malformedProof), null);
assert.equal(malformedLoads, 1);

let rejectedLoads = 0;
const rejectingCache = createSnapshotProofCache({ ttlMs: 300_000, now: () => 0 });
const rejectingProof = async () => {
  rejectedLoads++;
  throw new Error('R2 unavailable');
};
assert.deepEqual(
  await resolveVerifiedCurrentFallback({
    requestedSha: sha,
    proofCache: rejectingCache,
    loadProof: rejectingProof,
    getLegacy,
  }),
  { object: null, storageUnavailable: true },
);
assert.deepEqual(
  await resolveVerifiedCurrentFallback({
    requestedSha: sha,
    proofCache: rejectingCache,
    loadProof: rejectingProof,
    getLegacy,
  }),
  { object: null, storageUnavailable: true },
);
assert.equal(rejectedLoads, 2, 'rejected proof loads must clear in-flight and never be cached');

const workflow = await readFile(new URL('../.github/workflows/snapshot.yml', import.meta.url), 'utf8');
const parsedWorkflow = parseYaml(workflow);
function parsedUploadCommand(stepName, fileName = 'data.sqlite.gz') {
  const step = parsedWorkflow.jobs.build.steps.find((candidate) => candidate.name === stepName);
  assert.equal(typeof step?.run, 'string');
  const lines = step.run.trim().split('\n');
  assert.ok(lines.length >= 5, `${stepName} should remain an explicit multiline shell block`);
  for (const line of lines.slice(0, -1)) {
    assert.match(line, /\\\s*$/, `bare upload argument line would execute separately: ${line}`);
  }
  const command = step.run.replace(/\\\s*\n\s*/g, ' ').trim();
  assert.doesNotMatch(command, /\n/);
  assert.match(command, /^npx --yes wrangler@4 r2 object put /);
  assert.ok(command.includes(` --file=dist/snapshot/${fileName} `));
  assert.match(command, / --remote$/);
  return command;
}
const immutableCommand = parsedUploadCommand('Upload immutable database to R2');
const brotliCommand = parsedUploadCommand(
  'Upload immutable brotli database to R2',
  'data.sqlite.br',
);
const durableCommand = parsedUploadCommand('Update durable current fallback in R2');
const markerCommand = parsedUploadCommand(
  'Publish durable current commit marker in R2',
  'data.sqlite.gz.sha256',
);
assert.match(immutableCommand, /snapshots\/\$\{\{ steps\.snapshot\.outputs\.sha \}\}\.sqlite\.gz/);
assert.match(
  brotliCommand,
  /snapshots\/\$\{\{ steps\.snapshot\.outputs\.brsha \}\}\.sqlite\.br/,
  'the brotli object must be keyed by its own digest, not the snapshot identity',
);
assert.match(durableCommand, /mcp-finder-db-snapshots\/data\.sqlite\.gz/);
assert.match(markerCommand, /mcp-finder-db-snapshots\/data\.sqlite\.gz\.sha256/);
// Glama needs a key since 2026-08-26 and is a required source, so the secret
// must be wired through — without it every scheduled build fails the quality
// gate — and its crawl budget must stay at the deliberate 30 minutes.
const buildStep = parsedWorkflow.jobs.build.steps.find((step) => step.name === 'Build snapshot');
assert.equal(buildStep?.env?.GLAMA_API_KEY, '${{ secrets.GLAMA_API_KEY }}');
assert.equal(buildStep.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES, '30');
// Smithery restarts a stalled crawl across four attempts; four full passes do
// not fit the default 5-minute budget.
assert.equal(buildStep.env.MCPFINDER_SMITHERY_SYNC_BUDGET_MINUTES, '12');
// Local stdio keeps 500 ms because first-run live sync is gated on the
// SDK's 60 s tool-call timeout; the snapshot job uses the 15/30/60 s ladder.
assert.equal(buildStep.env.MCPFINDER_CRAWL_RESTART_BASE_MS, '15000');
assert.equal(parsedWorkflow.jobs.build['timeout-minutes'], 90);

const immutableUpload = workflow.indexOf('Upload immutable database to R2');
const brotliUpload = workflow.indexOf('Upload immutable brotli database to R2');
const preflight = workflow.indexOf('Verify immutable database through public endpoint');
const manifestUpload = workflow.indexOf('Publish manifest pointer to R2');
const durableFallback = workflow.indexOf('Update durable current fallback in R2');
const durableProof = workflow.indexOf('Publish durable current commit marker in R2');
// Both immutable objects must be durable and verified before the manifest —
// the pointer may never announce an artifact that is not there yet.
assert.ok(
  immutableUpload >= 0 &&
    brotliUpload > immutableUpload &&
    preflight > brotliUpload &&
    manifestUpload > preflight &&
    durableFallback > manifestUpload &&
    durableProof > durableFallback,
);
// The durable fallback stays gz-only on purpose: brotli clients fall back to
// the gz artifact, so a second mutable key would add divergence, not uptime.
assert.doesNotMatch(workflow, /mcp-finder-db-snapshots\/data\.sqlite\.br/);
const digestStep = parsedWorkflow.jobs.build.steps.find(
  (step) => step.id === 'snapshot',
);
assert.match(digestStep.run, /brsha=/);
// Brotli must not be able to block publication of a gz object that is already
// durable in R2 — the failure mode that froze snapshot publication once before.
const brotliStep = parsedWorkflow.jobs.build.steps.find(
  (step) => step.name === 'Upload immutable brotli database to R2',
);
assert.equal(brotliStep['continue-on-error'], true, 'the brotli upload must never fail the build');
assert.match(brotliStep.if, /steps\.snapshot\.outputs\.brsha != ''/);
// The digest step reads the brotli digest but must not throw over it.
assert.doesNotMatch(digestStep.run, /throw new Error\('invalid brotli/);
assert.doesNotMatch(digestStep.run, /brotli digest must differ/);
// Publication order is unchanged, and nothing brotli sits between the
// preflight and the manifest pointer.
assert.ok(manifestUpload > preflight);
assert.match(workflow, /timeout-minutes: 90/);
assert.doesNotMatch(workflow, /run: pnpm test(?:\s|$)/);
assert.doesNotMatch(workflow, /check:types/);

// The freeze alarm — both workflow signals, the age monitor's verdicts and the
// README paragraph that promises them — lives in its own module.
await runSnapshotFreezeChecks({ workflow, parsedWorkflow, durableProof });

const body = Buffer.from('immutable snapshot bytes');
const bodySha = createHash('sha256').update(body).digest('hex');
const manifest = {
  sha256: bodySha,
  sizeBytes: body.length,
  url: snapshotManifestUrl(bodySha),
};
const verified = await verifySnapshotUpload({
  manifest,
  baseUrl: 'https://mcpfinder.dev/api/v1/snapshot',
  fetchImpl: async (url, init) => {
    assert.match(url, new RegExp(`sha=${bodySha}$`));
    assert.equal(init.cache, 'no-store');
    const requestHeaders = new Headers(init.headers);
    assert.equal(requestHeaders.get('cache-control'), 'no-cache');
    assert.equal(requestHeaders.get('pragma'), 'no-cache');
    return new Response(body, { headers: { 'x-snapshot-sha': bodySha } });
  },
});
assert.equal(verified.sha256, bodySha);
assert.equal(verified.bytes, body.length);

await assert.rejects(
  () =>
    verifySnapshotUpload({
      manifest,
      baseUrl: 'https://mcpfinder.dev/api/v1/snapshot',
      fetchImpl: async () => new Response(body),
    }),
  /did not acknowledge requested sha/,
);
await assert.rejects(
  () =>
    verifySnapshotUpload({
      manifest,
      baseUrl: 'https://mcpfinder.dev/api/v1/snapshot',
      fetchImpl: async () =>
        new Response('wrong object', { headers: { 'x-snapshot-sha': bodySha } }),
    }),
  /sha256 mismatch/,
);

const immediateSleep = async () => {};
let transientCalls = 0;
assert.equal(
  (
    await verifySnapshotUpload({
      manifest,
      baseUrl: 'https://mcpfinder.dev/api/v1/snapshot',
      sleep: immediateSleep,
      fetchImpl: async () => {
        transientCalls++;
        return transientCalls === 1
          ? new Response('not ready', { status: 503 })
          : new Response(body, { headers: { 'x-snapshot-sha': bodySha } });
      },
    })
  ).sha256,
  bodySha,
);
assert.equal(transientCalls, 2);

let networkCalls = 0;
await verifySnapshotUpload({
  manifest,
  baseUrl: 'https://mcpfinder.dev/api/v1/snapshot',
  sleep: immediateSleep,
  fetchImpl: async () => {
    networkCalls++;
    if (networkCalls === 1) throw new Error('temporary network failure');
    return new Response(body, { headers: { 'x-snapshot-sha': bodySha } });
  },
});
assert.equal(networkCalls, 2);

let persistentCalls = 0;
const retrySleeps = [];
await assert.rejects(
  () =>
    verifySnapshotUpload({
      manifest,
      baseUrl: 'https://mcpfinder.dev/api/v1/snapshot',
      sleep: async (ms) => retrySleeps.push(ms),
      fetchImpl: async () => {
        persistentCalls++;
        return new Response('not ready', { status: 503 });
      },
    }),
  /failed after 4 attempts/,
);
assert.equal(persistentCalls, 4);
assert.deepEqual(retrySleeps, [500, 1_500, 4_500]);

let mismatchCalls = 0;
await assert.rejects(
  () =>
    verifySnapshotUpload({
      manifest,
      baseUrl: 'https://mcpfinder.dev/api/v1/snapshot',
      sleep: immediateSleep,
      fetchImpl: async () => {
        mismatchCalls++;
        return new Response(body, { headers: { 'x-snapshot-sha': 'b'.repeat(64) } });
      },
    }),
  /did not acknowledge requested sha/,
);
assert.equal(mismatchCalls, 1);

let stalledBodyAborted = false;
await assert.rejects(
  () =>
    verifySnapshotUpload({
      manifest,
      baseUrl: 'https://mcpfinder.dev/api/v1/snapshot',
      retries: 0,
      timeoutMs: 15,
      fetchImpl: async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init.signal.addEventListener(
                'abort',
                () => {
                  stalledBodyAborted = true;
                  controller.error(init.signal.reason ?? new Error('aborted'));
                },
                { once: true },
              );
            },
          }),
          { headers: { 'x-snapshot-sha': bodySha } },
        ),
    }),
  /failed after 1 attempts/,
);
assert.equal(stalledBodyAborted, true);

// Preflight verifies each artifact against its own digest, size and URL.
const brBody = Buffer.from('immutable brotli snapshot bytes');
const brBodySha = createHash('sha256').update(brBody).digest('hex');
const dualManifest = {
  ...manifest,
  brotli: {
    url: `data.sqlite.br?sha=${brBodySha}`,
    sha256: brBodySha,
    sizeBytes: brBody.length,
  },
};
const verifiedBrotli = await verifySnapshotUpload({
  manifest: dualManifest,
  baseUrl: 'https://mcpfinder.dev/api/v1/snapshot',
  artifact: 'brotli',
  fetchImpl: async (url) => {
    assert.match(url, new RegExp(`/data\\.sqlite\\.br\\?sha=${brBodySha}$`));
    return new Response(brBody, { headers: { 'x-snapshot-sha': brBodySha } });
  },
});
assert.equal(verifiedBrotli.sha256, brBodySha);
assert.equal(verifiedBrotli.bytes, brBody.length);

// Serving the gz bytes under the brotli digest must not pass.
await assert.rejects(
  () =>
    verifySnapshotUpload({
      manifest: dualManifest,
      baseUrl: 'https://mcpfinder.dev/api/v1/snapshot',
      artifact: 'brotli',
      fetchImpl: async () => new Response(body, { headers: { 'x-snapshot-sha': brBodySha } }),
    }),
  /sha256 mismatch/,
);
await assert.rejects(
  () =>
    verifySnapshotUpload({
      manifest,
      baseUrl: 'https://mcpfinder.dev/api/v1/snapshot',
      artifact: 'brotli',
    }),
  /no brotli artifact/,
);
await assert.rejects(
  () =>
    verifySnapshotUpload({
      manifest: { ...manifest, brotli: { ...dualManifest.brotli, sizeBytes: 0 } },
      baseUrl: 'https://mcpfinder.dev/api/v1/snapshot',
      artifact: 'brotli',
    }),
  /sizeBytes must be a positive safe integer/,
);
// The brotli block must never restate the snapshot identity as its own digest.
await assert.rejects(
  () =>
    verifySnapshotUpload({
      manifest: {
        ...manifest,
        brotli: { url: `data.sqlite.br?sha=${bodySha}`, sha256: bodySha, sizeBytes: 10 },
      },
      baseUrl: 'https://mcpfinder.dev/api/v1/snapshot',
      artifact: 'brotli',
    }),
  /must differ from the gz digest/,
);
// ─── Brotli verification is best-effort, and never blocks publication ───────
//
// By the time the preflight runs the gz object is durable in R2 and fit to
// publish. A brotli failure therefore drops the block from the manifest on
// disk — so the pointer cannot announce an object that is not there — warns,
// and returns rather than throwing.
{
  const written = [];
  const warnings = [];
  const outcome = await verifyOptionalBrotli({
    manifestPath: 'dist/snapshot/manifest.json',
    manifest: dualManifest,
    baseUrl: 'https://mcpfinder.dev/api/v1/snapshot',
    // What an undeployed Worker route looks like: 404 through every retry.
    fetchImpl: async () => new Response('nope', { status: 404 }),
    retries: 0,
    delay: async () => {},
    writeManifest: async (path, text) => written.push([path, text]),
    warn: async (message) => warnings.push(message),
  });
  assert.equal(outcome.verified, false);
  assert.equal(outcome.announced, true);
  assert.equal(warnings.length, 1, 'a silent brotli degradation is the failure mode to avoid');
  assert.equal(written.length, 1);
  const [[writtenPath, writtenText]] = written;
  assert.equal(writtenPath, 'dist/snapshot/manifest.json');
  const republished = JSON.parse(writtenText);
  assert.equal('brotli' in republished, false, 'a manifest may not announce a missing artifact');
  // The gz half of the manifest is untouched — it is the snapshot itself.
  assert.equal(republished.sha256, dualManifest.sha256);
  assert.equal(republished.url, dualManifest.url);
  assert.equal(republished.sizeBytes, dualManifest.sizeBytes);
  assert.deepEqual(Object.keys(republished), Object.keys(manifest));
}
// A manifest without a brotli block has nothing to verify and nothing to drop.
{
  let touched = false;
  const outcome = await verifyOptionalBrotli({
    manifestPath: 'dist/snapshot/manifest.json',
    manifest,
    baseUrl: 'https://mcpfinder.dev/api/v1/snapshot',
    fetchImpl: async () => {
      touched = true;
      return new Response('unused');
    },
    writeManifest: async () => {
      touched = true;
    },
    warn: async () => {
      touched = true;
    },
  });
  assert.deepEqual(outcome, { verified: false, announced: false });
  assert.equal(touched, false);
}
// A verified brotli artifact leaves the manifest exactly as built.
{
  let rewritten = false;
  const outcome = await verifyOptionalBrotli({
    manifestPath: 'dist/snapshot/manifest.json',
    manifest: dualManifest,
    baseUrl: 'https://mcpfinder.dev/api/v1/snapshot',
    fetchImpl: async () => new Response(brBody, { headers: { 'x-snapshot-sha': brBodySha } }),
    writeManifest: async () => {
      rewritten = true;
    },
    warn: async () => {
      rewritten = true;
    },
  });
  assert.deepEqual(outcome, { verified: true, announced: true });
  assert.equal(rewritten, false);
}

// The gz artifact keeps its own identity untouched by the brotli block.
assert.equal(
  (
    await verifySnapshotUpload({
      manifest: dualManifest,
      baseUrl: 'https://mcpfinder.dev/api/v1/snapshot',
      fetchImpl: async (url) => {
        assert.match(url, new RegExp(`/data\\.sqlite\\.gz\\?sha=${bodySha}$`));
        return new Response(body, { headers: { 'x-snapshot-sha': bodySha } });
      },
    })
  ).sha256,
  bodySha,
);

const lifecycle = JSON.parse(
  await readFile(new URL('../api-worker/r2-lifecycle.json', import.meta.url), 'utf8'),
);
assert.equal(lifecycle.rules.length, 2);
const expiry = lifecycle.rules.find((rule) => rule.deleteObjectsTransition);
assert.equal(expiry.conditions.prefix, 'snapshots/');
assert.equal(expiry.deleteObjectsTransition.condition.type, 'Age');
assert.equal(expiry.deleteObjectsTransition.condition.maxAge, 30 * 24 * 60 * 60);
assert.equal('data.sqlite.gz.sha256'.startsWith(expiry.conditions.prefix), false);
const multipart = lifecycle.rules.find((rule) => rule.abortMultipartUploadsTransition);
assert.deepEqual(multipart.conditions, {});
assert.equal(multipart.abortMultipartUploadsTransition.condition.maxAge, 7 * 24 * 60 * 60);

const workerPackage = JSON.parse(
  await readFile(new URL('../api-worker/package.json', import.meta.url), 'utf8'),
);
assert.match(workerPackage.scripts['r2:lifecycle:apply'], /r2 bucket lifecycle set/);
assert.match(workerPackage.scripts['r2:lifecycle:apply'], /--force/);
assert.match(workerPackage.scripts['cf-typegen'], /--include-env=true/);
assert.match(workerPackage.scripts['check:types'], /--include-env=true/);
assert.match(workerPackage.scripts['cf-typegen'], /--env-file \.typegen\.env/);
const generatedWorkerTypes = await readFile(
  new URL('../api-worker/worker-configuration.d.ts', import.meta.url),
  'utf8',
);
const workerAppTypes = await readFile(new URL('../api-worker/src/types.ts', import.meta.url), 'utf8');
assert.match(generatedWorkerTypes, /MCP_DB_SNAPSHOTS:\s*R2Bucket/);
assert.doesNotMatch(generatedWorkerTypes, /MCP_REGISTRY_SECRET/);
assert.match(workerAppTypes, /Bindings = Cloudflare\.Env/);
// ─── Worker snapshot endpoints, exercised as behaviour ──────────────────────
//
// Asserted by calling the handlers, not by matching their source text: a regex
// over the file cannot tell a working 304 from a comment mentioning one, and it
// breaks the moment two functions swap places.
// Importing the .ts source directly relies on Node's type stripping, which is
// only on by default from 22.18/23.6. The packages declare engines >=22.15.0,
// so on an older-but-supported Node this must skip rather than crash the suite.
let getSnapshotBrotliData, getSnapshotData;
try {
  ({ getSnapshotBrotliData, getSnapshotData } = await import(
    '../api-worker/src/endpoints/snapshot.ts'
  ));
} catch (error) {
  if (error?.code !== 'ERR_UNKNOWN_FILE_EXTENSION') throw error;
  console.log(
    `[snapshot-artifacts] skipping Worker handler checks: Node ${process.version} ` +
      'cannot import TypeScript directly (needs >=22.18)',
  );
}

/** Minimal stand-in for the Hono context these handlers actually use. */
function workerContext({ bucket, sha, ifNoneMatch } = {}) {
  return {
    env: bucket === undefined ? {} : { MCP_DB_SNAPSHOTS: bucket },
    req: {
      query: (name) => (name === 'sha' ? sha : undefined),
      header: (name) => (name === 'if-none-match' ? ifNoneMatch : undefined),
    },
    json: (payload, status = 200, headers = {}) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      }),
  };
}

function r2Object(contents, etag = '"obj-v1"') {
  const bytes = Buffer.from(contents);
  return {
    body: bytes,
    size: bytes.length,
    etag,
    uploaded: new Date('2026-08-26T00:00:00.000Z'),
  };
}

/** A bucket that records every key it is asked for. */
function recordingBucket(objects) {
  const asked = [];
  return {
    asked,
    async get(key) {
      asked.push(key);
      return objects[key] ?? null;
    },
  };
}

// Skipped wholesale when the handlers could not be imported (see above): the
// route-wiring assertions below are plain text and still run.
if (getSnapshotData && getSnapshotBrotliData) {
  const brotliSha = 'c'.repeat(64);
  const brotliBytes = 'brotli artifact bytes';

  // No R2 binding at all is a controlled 503, not a throw.
  assert.equal((await getSnapshotBrotliData(workerContext({ sha: brotliSha }))).status, 503);

  // `sha` is mandatory on the brotli endpoint, and must be well-formed.
  for (const badSha of [undefined, '', 'not-a-sha', 'C'.repeat(64)]) {
    const res = await getSnapshotBrotliData(
      workerContext({ bucket: recordingBucket({}), sha: badSha }),
    );
    assert.equal(res.status, 400, `sha=${String(badSha)} must be rejected`);
    assert.equal((await res.json()).error, 'invalid-snapshot-sha');
  }

  // A miss is a cacheable 404 — and never reaches for a mutable brotli key,
  // because there is none.
  const brotliMissBucket = recordingBucket({});
  const brotliMiss = await getSnapshotBrotliData(
    workerContext({ bucket: brotliMissBucket, sha: brotliSha }),
  );
  assert.equal(brotliMiss.status, 404);
  assert.match(brotliMiss.headers.get('cache-control'), /max-age=300/);
  assert.deepEqual(brotliMissBucket.asked, [`snapshots/${brotliSha}.sqlite.br`]);

  const brotliHitBucket = recordingBucket({
    [`snapshots/${brotliSha}.sqlite.br`]: r2Object(brotliBytes, '"br-v1"'),
  });
  const brotliHit = await getSnapshotBrotliData(
    workerContext({ bucket: brotliHitBucket, sha: brotliSha }),
  );
  assert.equal(brotliHit.status, 200);
  assert.equal(brotliHit.headers.get('content-encoding'), 'identity');
  assert.equal(brotliHit.headers.get('content-length'), String(brotliBytes.length));
  assert.equal(brotliHit.headers.get('x-snapshot-sha'), brotliSha);
  assert.equal(brotliHit.headers.get('etag'), '"br-v1"');
  assert.match(brotliHit.headers.get('cache-control'), /immutable/);
  assert.equal(await brotliHit.text(), brotliBytes);

  // Conditional revalidation still works on the brotli endpoint.
  const brotli304 = await getSnapshotBrotliData(
    workerContext({ bucket: brotliHitBucket, sha: brotliSha, ifNoneMatch: '"br-v1"' }),
  );
  assert.equal(brotli304.status, 304);
  assert.equal(brotli304.headers.get('etag'), '"br-v1"');
  assert.equal(await brotli304.text(), '');

  // The gz endpoint keeps its own contract: a storage failure while proving the
  // durable fallback is a 503, and its legacy key claims no content address.
  const throwingBucket = {
    async get(key) {
      if (key.startsWith('snapshots/')) return null;
      throw new Error('r2 unavailable');
    },
  };
  assert.equal(
    (await getSnapshotData(workerContext({ bucket: throwingBucket, sha: 'd'.repeat(64) }))).status,
    503,
  );
  const legacyBucket = recordingBucket({ 'data.sqlite.gz': r2Object('legacy gz', '"gz-v1"') });
  const legacyRes = await getSnapshotData(workerContext({ bucket: legacyBucket }));
  assert.equal(legacyRes.status, 200);
  assert.equal(legacyRes.headers.get('x-snapshot-sha'), null);
  assert.deepEqual(legacyBucket.asked, ['data.sqlite.gz']);
}

const workerIndex = await readFile(new URL('../api-worker/src/index.ts', import.meta.url), 'utf8');
assert.match(workerIndex, /apiV1\.get\('\/snapshot\/data\.sqlite\.gz', getSnapshotData\)/);
assert.match(
  workerIndex,
  /apiV1\.get\('\/snapshot\/data\.sqlite\.br', getSnapshotBrotliData\)/,
);
// The advertised brotli request must be copy-pasteable: without `sha` it 400s.
assert.match(workerIndex, /data\.sqlite\.br\?sha=/);

console.log('snapshot artifact checks passed');
