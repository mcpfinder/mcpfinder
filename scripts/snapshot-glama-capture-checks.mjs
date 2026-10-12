/**
 * Record/replay checks for the split snapshot build (glama-capture-lib.mjs):
 * a recorded Glama crawl replays into the same rows, retries replay in order,
 * no request header (the API key) reaches the artifact, and every broken
 * capture fails closed with a Glama sync error.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { initDatabase, syncGlamaRegistry } from '../packages/core/dist/index.js';
import {
  HEADER_FILE,
  MAX_CAPTURE_AGE_MS,
  RESPONSES_FILE,
  createRecorder,
  loadReplay,
} from './glama-capture-lib.mjs';

const glamaEntry = (id) => ({
  id,
  name: id,
  namespace: '',
  slug: id,
  description: '',
  repository: { url: `https://github.com/example/${id}` },
  spdxLicense: null,
  tools: [],
  url: null,
  environmentVariablesJsonSchema: null,
  attributes: {},
});

const syncStatus = (db) =>
  db.prepare("SELECT status, server_count FROM sync_log WHERE source = 'glama'").get();

export async function runSnapshotGlamaCaptureChecks(dir) {
  const key = process.env.GLAMA_API_KEY;
  assert.ok(key, 'checks expect a (fake) GLAMA_API_KEY in the environment');

  // Upstream: two pages, the second answers 503 once before succeeding.
  const seenAuth = [];
  let page2Calls = 0;
  const upstream = async (url, init) => {
    seenAuth.push(new Headers(init?.headers).get('authorization'));
    const second = String(url).includes('after=');
    if (second && page2Calls++ === 0) return new Response('busy', { status: 503 });
    return Response.json({
      servers: second ? [glamaEntry('cap-c')] : [glamaEntry('cap-a'), glamaEntry('cap-b')],
      pageInfo: { hasNextPage: !second, endCursor: second ? null : 'cursor-1' },
    });
  };

  const capDir = join(dir, 'glama-capture');
  mkdirSync(capDir, { recursive: true });
  const recorder = createRecorder(capDir, upstream);
  const liveDb = initDatabase(join(dir, 'capture-live.sqlite'));
  const live = await syncGlamaRegistry(liveDb, { fetchImpl: recorder.fetch, sleep: async () => {} });
  assert.equal(live, 3);
  assert.equal(syncStatus(liveDb).status, 'ok');
  liveDb.close();
  const header = await recorder.finish({
    capturedAt: new Date().toISOString(),
    syncStatus: 'ok',
    servers: live,
  });
  assert.equal(header.responses, 3, 'page 1, page 2 (503), page 2 (200)');
  assert.ok(seenAuth.every((h) => h === `Bearer ${key}`), 'live crawl sent the key');

  // The key travels only as a request header and must not be in the artifact.
  const rawLines = gunzipSync(readFileSync(join(capDir, RESPONSES_FILE))).toString('utf8');
  const rawHeader = readFileSync(join(capDir, HEADER_FILE), 'utf8');
  assert.ok(!rawLines.includes(key) && !rawHeader.includes(key), 'API key leaked into capture');
  assert.doesNotMatch(rawLines, /authorization/i);

  // Replay reproduces the rows, including the retried page, with no network.
  const replay = await loadReplay(capDir);
  assert.equal(replay.header.servers, 3);
  const replayDb = initDatabase(join(dir, 'capture-replay.sqlite'));
  const replayed = await syncGlamaRegistry(replayDb, { fetchImpl: replay.fetch, sleep: async () => {} });
  assert.equal(replayed, 3);
  assert.equal(syncStatus(replayDb).status, 'ok');
  const ids = replayDb.prepare('SELECT id FROM servers ORDER BY id').all().map((r) => r.id);
  assert.equal(ids.length, 3);
  replayDb.close();

  // Replay is strictly sequential: an unexpected URL or a request past the end
  // throws instead of serving some other recorded page.
  const strict = await loadReplay(capDir);
  await assert.rejects(strict.fetch('https://glama.ai/api/mcp/v1/servers?unknown=1'), /diverged/);
  // Divergence is latched: the correct next URL no longer resynchronises.
  const firstUrl = JSON.parse(rawLines.split('\n')[0]).url;
  await assert.rejects(strict.fetch(firstUrl), /diverged/);
  assert.match(strict.verdict(), /diverged/);
  // End to end: a sync that diverges mid-crawl may retry, but the verdict stays failed.
  {
    const divergeDb = initDatabase(join(dir, 'capture-diverge.sqlite'));
    const rp = await loadReplay(capDir);
    let calls = 0;
    const skewed = async (url, init) => rp.fetch(calls++ === 1 ? `${url}&skew=1` : url, init);
    await syncGlamaRegistry(divergeDb, { fetchImpl: skewed, sleep: async () => {} }).catch(() => {});
    assert.notEqual(syncStatus(divergeDb).status, 'ok');
    assert.match(rp.verdict(), /diverged/);
    divergeDb.close();
  }
  const drained = await loadReplay(capDir);
  const urls = gunzipSync(readFileSync(join(capDir, RESPONSES_FILE)))
    .toString('utf8').trim().split('\n').map((l) => JSON.parse(l).url);
  for (const u of urls) await drained.fetch(u);
  assert.equal(drained.remaining(), 0);
  assert.equal(drained.verdict(), null);
  await assert.rejects(drained.fetch(urls[0]), /past the end/);
  assert.match(drained.verdict(), /past the end/);
  const partial = await loadReplay(capDir);
  await partial.fetch(urls[0]);
  assert.match(partial.verdict(), /served 1 of 3/);

  // Crawl restart: attempt 1 stages page 1 (old-a), then page 2 throws on every
  // transport attempt; the restarted attempt 2 sees a different page 1 (new-b)
  // and a terminal page 2. The replay must produce attempt 2's rows, exactly.
  {
    const restartDir = join(dir, 'glama-capture-restart');
    mkdirSync(restartDir, { recursive: true });
    let page1Calls = 0;
    let page2Throws = 4; // one full transport round (1 + 3 retries)
    const flaky = async (url) => {
      if (String(url).includes('after=')) {
        if (page2Throws-- > 0) throw new Error('socket hang up');
        return Response.json({ servers: [glamaEntry('terminal-c')], pageInfo: { hasNextPage: false, endCursor: null } });
      }
      page1Calls++;
      return Response.json({
        servers: [glamaEntry(page1Calls === 1 ? 'old-a' : 'new-b')],
        pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
      });
    };
    const rec = createRecorder(restartDir, flaky);
    const liveRestartDb = initDatabase(join(dir, 'capture-restart-live.sqlite'));
    const n = await syncGlamaRegistry(liveRestartDb, { fetchImpl: rec.fetch, sleep: async () => {} });
    assert.equal(syncStatus(liveRestartDb).status, 'ok', 'the live crawl recovers by restarting');
    const liveRows = liveRestartDb.prepare('SELECT id FROM servers ORDER BY id').all().map((r) => r.id);
    liveRestartDb.close();
    assert.ok(page1Calls >= 2, 'the crawl restarted from page 1');
    await rec.finish({ capturedAt: new Date().toISOString(), syncStatus: 'ok', servers: n });
    const rp = await loadReplay(restartDir);
    const replayRestartDb = initDatabase(join(dir, 'capture-restart-replay.sqlite'));
    await syncGlamaRegistry(replayRestartDb, { fetchImpl: rp.fetch, sleep: async () => {} });
    assert.equal(syncStatus(replayRestartDb).status, 'ok');
    const replayRows = replayRestartDb.prepare('SELECT id FROM servers ORDER BY id').all().map((r) => r.id);
    replayRestartDb.close();
    assert.deepEqual(replayRows, liveRows);
    assert.ok(!replayRows.includes('old-a'), 'rows of the discarded attempt must not be replayed');
    assert.equal(rp.remaining(), 0);
    assert.equal(rp.verdict(), null);
  }

  // A response that reflects the key is refused before it is written.
  {
    const leakDir = join(dir, 'glama-capture-leak');
    mkdirSync(leakDir, { recursive: true });
    const rec = createRecorder(leakDir, async () => new Response(`echo ${key}`), { forbidden: [key] });
    await assert.rejects(rec.fetch('https://glama.ai/x'), /reflects a secret/);
    await assert.rejects(
      rec.finish({ capturedAt: new Date().toISOString(), syncStatus: 'ok', servers: 0 }),
      /reflected a secret/,
    );
    assert.ok(!gunzipSync(readFileSync(join(leakDir, RESPONSES_FILE))).toString('utf8').includes(key));
  }

  // Multibyte text survives chunk boundaries (a ~200 KB body of 3-byte chars).
  {
    const wideDir = join(dir, 'glama-capture-wide');
    mkdirSync(wideDir, { recursive: true });
    const wide = 'zażółć gęślą jaźń — 你好 '.repeat(8000);
    const rec = createRecorder(wideDir, async () => new Response(wide));
    await rec.fetch('https://glama.ai/wide');
    await rec.finish({ capturedAt: new Date().toISOString(), syncStatus: 'ok', servers: 0 });
    const rp = await loadReplay(wideDir);
    assert.equal(await (await rp.fetch('https://glama.ai/wide')).text(), wide);
  }

  // Every broken capture fails closed with a reason.
  const variant = (name, { header = {}, lines, dropHeader = false } = {}) => {
    const d = join(dir, `glama-capture-${name}`);
    mkdirSync(d, { recursive: true });
    if (!dropHeader) writeFileSync(join(d, HEADER_FILE), JSON.stringify({ ...JSON.parse(rawHeader), ...header }));
    writeFileSync(join(d, RESPONSES_FILE), gzipSync(lines ? lines(rawLines) : rawLines));
    return d;
  };
  await assert.rejects(loadReplay(variant('missing', { dropHeader: true })), /missing or unreadable/);
  {
    const noBody = variant('no-gzip');
    rmSync(join(noBody, RESPONSES_FILE));
    await assert.rejects(loadReplay(noBody), /responses unreadable/);
    const badGzip = variant('bad-gzip');
    writeFileSync(join(badGzip, RESPONSES_FILE), 'not gzip');
    await assert.rejects(loadReplay(badGzip), /responses unreadable/);
  }
  await assert.rejects(loadReplay(variant('status', { header: { syncStatus: 'error' } })), /did not finish cleanly/);
  await assert.rejects(loadReplay(variant('version', { header: { v: 2 } })), /unsupported format/);
  const stale = new Date(Date.now() - MAX_CAPTURE_AGE_MS - 60_000).toISOString();
  await assert.rejects(loadReplay(variant('stale', { header: { capturedAt: stale } })), /outside the accepted window/);
  const future = new Date(Date.now() + 10 * 60_000).toISOString();
  await assert.rejects(loadReplay(variant('future', { header: { capturedAt: future } })), /outside the accepted window/);
  await assert.rejects(
    loadReplay(variant('truncated', { lines: (l) => l.split('\n').slice(0, 1).join('\n') + '\n' })),
    /truncated: 1 of 3/,
  );
  await assert.rejects(
    loadReplay(variant('malformed', { lines: (l) => l + '{"url":1}\n', header: { responses: 4 } })),
    /malformed/,
  );
}
