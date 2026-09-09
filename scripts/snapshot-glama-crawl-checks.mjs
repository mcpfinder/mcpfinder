import assert from 'node:assert/strict';
import { join } from 'node:path';

const runtime = (fetchImpl, now = () => 0, sleep = async () => {}) => ({ fetchImpl, now, sleep });

const glamaEntry = (id) => ({
  id,
  name: id,
  namespace: '',
  slug: id,
  description: '',
  repository: null,
  spdxLicense: null,
  tools: [],
  url: null,
  environmentVariablesJsonSchema: null,
  attributes: {},
});

const page = (servers, hasNextPage, endCursor = null) => ({
  servers,
  pageInfo: { hasNextPage, endCursor },
});

function syncLog(db) {
  return db
    .prepare("SELECT server_count, status, error FROM sync_log WHERE source = 'glama'")
    .get();
}

export async function runSnapshotGlamaCrawlChecks(dir) {
  // syncGlamaRegistry short-circuits before any request without a key, so the
  // caller must supply a stub credential for these crawl paths to run at all.
  assert.ok(process.env.GLAMA_API_KEY, 'GLAMA_API_KEY must be set by the caller');
  const { initDatabase, syncOfficialRegistry, syncGlamaRegistry } =
    await import('../packages/core/dist/index.js');

  const transientDb = initDatabase(join(dir, 'glama-transient-duplicate.sqlite'));
  await syncOfficialRegistry(transientDb, runtime(async () => Response.json({
    servers: [{ server: { name: 'abandoned', version: '1.0.0', description: 'baseline' } }],
    metadata: { count: 1 },
  })));
  let transientAttempt = 0;
  let transientCalls = 0;
  assert.equal(
    await syncGlamaRegistry(transientDb, runtime(async (requestUrl) => {
      transientCalls++;
      const cursor = new URL(requestUrl).searchParams.get('after');
      if (!cursor) transientAttempt++;
      if (transientAttempt === 1) {
        return Response.json(cursor
          ? page([glamaEntry('abandoned')], false)
          : page([glamaEntry('abandoned'), glamaEntry('first-attempt-only')], true, 'first-next'));
      }
      return Response.json(cursor
        ? page([glamaEntry('final-b')], false)
        : page([glamaEntry('final-a')], true, 'final-next'));
    })),
    2,
  );
  assert.equal(transientAttempt, 2);
  assert.equal(transientCalls, 4);
  assert.equal(syncLog(transientDb).status, 'ok');
  assert.equal(syncLog(transientDb).server_count, 2);
  assert.equal(transientDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 3);
  assert.equal(
    transientDb.prepare("SELECT COUNT(*) AS count FROM servers WHERE id = 'glama:first-attempt-only'")
      .get().count,
    0,
  );
  const untouchedOfficial = transientDb
    .prepare("SELECT sources, raw_data FROM servers WHERE id = 'abandoned'")
    .get();
  assert.deepEqual(JSON.parse(untouchedOfficial.sources), ['official']);
  assert.doesNotMatch(untouchedOfficial.raw_data, /first-attempt-only|\"id\":\"abandoned\"/);
  transientDb.close();

  // Four attempts, so three restarts, so three waits. Unset env is the local
  // stdio ladder: 500 ms then 1 s then 2 s. The clock is deliberately not
  // zero — the schedule is a fixed ladder, not a function of wall time, and
  // pinning `now` at 0 would hide a regression that made it one. Inter-page
  // 100 ms pacing is filtered out.
  const restartBudget = process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES;
  const originalRestartBase = process.env.MCPFINDER_CRAWL_RESTART_BASE_MS;
  delete process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES;
  delete process.env.MCPFINDER_CRAWL_RESTART_BASE_MS;
  try {
  const persistentDb = initDatabase(join(dir, 'glama-persistent-duplicate.sqlite'));
  let persistentCalls = 0;
  const persistentRestartSleeps = [];
  await syncGlamaRegistry(persistentDb, runtime(async (requestUrl) => {
    persistentCalls++;
    const cursor = new URL(requestUrl).searchParams.get('after');
    return Response.json(cursor
      ? page([glamaEntry('persistent')], false)
      : page([glamaEntry('persistent')], true, 'next'));
  }, () => 1_772_000_000_123, async (ms) => {
    if (ms > 100) persistentRestartSleeps.push(ms);
  }));
  assert.equal(persistentCalls, 8);
  assert.deepEqual(persistentRestartSleeps, [500, 1_000, 2_000]);
  assert.equal(syncLog(persistentDb).status, 'error');
  assert.equal(syncLog(persistentDb).server_count, 0);
  assert.match(syncLog(persistentDb).error, /cross-page duplicate/);
  assert.equal(persistentDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 0);
  persistentDb.close();

  // Persistent HTTP 502 on the first page restarts the whole crawl: 4 crawls ×
  // 4 page-level transport retries = 16 fetches. Sleep is a no-op because those
  // page-level retries also sleep.
  const persistent502Db = initDatabase(join(dir, 'glama-persistent-502.sqlite'));
  let persistent502Calls = 0;
  await syncGlamaRegistry(persistent502Db, runtime(async () => {
    persistent502Calls++;
    return new Response('bad gateway', { status: 502 });
  }));
  assert.equal(persistent502Calls, 16);
  assert.equal(syncLog(persistent502Db).status, 'error');
  assert.equal(syncLog(persistent502Db).server_count, 0);
  assert.match(syncLog(persistent502Db).error, /HTTP 502|giving up after/);
  assert.doesNotMatch(syncLog(persistent502Db).error, /exceeded its .* budget/);
  assert.equal(persistent502Db.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 0);
  persistent502Db.close();

  // 502 on the first two crawls, then a valid terminal page: the third attempt
  // publishes. CI ladder so restart waits (15/30/60 s) do not overlap page-level
  // 500/1500/4500 ms retries.
  process.env.MCPFINDER_CRAWL_RESTART_BASE_MS = '15000';
  const recovered502Db = initDatabase(join(dir, 'glama-recovered-502.sqlite'));
  const recovered502Sleeps = [];
  assert.equal(
    await syncGlamaRegistry(recovered502Db, runtime(async () => {
      if (recovered502Sleeps.length < 2) return new Response('bad gateway', { status: 502 });
      return Response.json(page([glamaEntry('recovered-502')], false));
    }, () => 1_772_000_000_123, async (ms) => {
      if (ms >= 15_000) recovered502Sleeps.push(ms);
    })),
    1,
  );
  assert.equal(syncLog(recovered502Db).status, 'ok');
  assert.ok(syncLog(recovered502Db).server_count > 0);
  assert.deepEqual(recovered502Sleeps, [15_000, 30_000]);
  recovered502Db.close();
  delete process.env.MCPFINDER_CRAWL_RESTART_BASE_MS;

  // Credentials are not weather: a 401 must not restart the crawl.
  const unauthorizedDb = initDatabase(join(dir, 'glama-unauthorized.sqlite'));
  let unauthorizedCalls = 0;
  const unauthorizedSleeps = [];
  await syncGlamaRegistry(unauthorizedDb, runtime(async () => {
    unauthorizedCalls++;
    return new Response('unauthorized', { status: 401 });
  }, () => 1_772_000_000_123, async (ms) => {
    if (ms > 100) unauthorizedSleeps.push(ms);
  }));
  assert.equal(unauthorizedCalls, 1);
  assert.deepEqual(unauthorizedSleeps, []);
  assert.equal(syncLog(unauthorizedDb).status, 'error');
  assert.match(syncLog(unauthorizedDb).error, /rejected GLAMA_API_KEY|HTTP 401/);
  assert.equal(unauthorizedDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 0);
  unauthorizedDb.close();

  // 429 is retried at page level (4 fetches) and must not restart the crawl.
  const tooManyDb = initDatabase(join(dir, 'glama-429.sqlite'));
  let tooManyCalls = 0;
  await syncGlamaRegistry(tooManyDb, runtime(async () => {
    tooManyCalls++;
    return new Response('too many requests', { status: 429 });
  }));
  assert.equal(tooManyCalls, 4);
  assert.equal(syncLog(tooManyDb).status, 'error');
  assert.match(syncLog(tooManyDb).error, /HTTP 429/);
  tooManyDb.close();

  // A 60 s CI-ladder wait that would miss a 1-minute deadline must keep the
  // original 502, not rewrite it as a budget overrun. now() is pinned at 0 so
  // deadline is exactly 60 s: 15 s and 30 s fit, 60 s does not, so the fourth
  // crawl never starts (3 crawls × 4 transport retries = 12 fetches).
  process.env.MCPFINDER_CRAWL_RESTART_BASE_MS = '15000';
  process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES = '1';
  const skippedWaitDb = initDatabase(join(dir, 'glama-skipped-restart-wait.sqlite'));
  let skippedWaitCalls = 0;
  const skippedWaitSleeps = [];
  await syncGlamaRegistry(skippedWaitDb, runtime(async () => {
    skippedWaitCalls++;
    return new Response('bad gateway', { status: 502 });
  }, () => 0, async (ms) => {
    if (ms >= 15_000) skippedWaitSleeps.push(ms);
  }));
  assert.equal(skippedWaitCalls, 12);
  assert.deepEqual(skippedWaitSleeps, [15_000, 30_000]);
  assert.equal(syncLog(skippedWaitDb).status, 'error');
  assert.equal(syncLog(skippedWaitDb).server_count, 0);
  assert.match(syncLog(skippedWaitDb).error, /HTTP 502|giving up after/);
  assert.doesNotMatch(syncLog(skippedWaitDb).error, /exceeded its .* budget/);
  skippedWaitDb.close();
  delete process.env.MCPFINDER_CRAWL_RESTART_BASE_MS;
  delete process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES;

  process.env.MCPFINDER_CRAWL_RESTART_BASE_MS = '99';
  const restartLowDb = initDatabase(join(dir, 'glama-restart-base-low.sqlite'));
  assert.equal(await syncGlamaRegistry(restartLowDb, runtime(async () => Response.json(page([], false)))), 0);
  assert.equal(syncLog(restartLowDb).status, 'error');
  assert.match(syncLog(restartLowDb).error, /integer between 100 and 60000/);
  restartLowDb.close();
  process.env.MCPFINDER_CRAWL_RESTART_BASE_MS = 'abc';
  const restartMalformedDb = initDatabase(join(dir, 'glama-restart-base-malformed.sqlite'));
  await syncGlamaRegistry(restartMalformedDb, runtime(async () => Response.json(page([], false))));
  assert.equal(syncLog(restartMalformedDb).status, 'error');
  assert.match(syncLog(restartMalformedDb).error, /integer between 100 and 60000/);
  restartMalformedDb.close();
  delete process.env.MCPFINDER_CRAWL_RESTART_BASE_MS;
  } finally {
  if (restartBudget === undefined) delete process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES;
  else process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES = restartBudget;
  if (originalRestartBase === undefined) delete process.env.MCPFINDER_CRAWL_RESTART_BASE_MS;
  else process.env.MCPFINDER_CRAWL_RESTART_BASE_MS = originalRestartBase;
  }

  const stableIdDb = initDatabase(join(dir, 'glama-stable-id-priority.sqlite'));
  const repoA = 'https://github.com/acme/original';
  const repoB = 'https://github.com/acme/changed';
  const initial = {
    ...glamaEntry('stable'),
    repository: { url: repoA },
    description: 'old term',
    environmentVariablesJsonSchema: {
      properties: { OLD_TOKEN: { description: 'obsolete' } },
    },
  };
  await syncGlamaRegistry(stableIdDb, runtime(async () => Response.json(page([initial], false))));
  stableIdDb.prepare(
    "UPDATE servers SET last_synced_at = '2000-01-01T00:00:00.000Z' WHERE id = 'glama:stable'",
  ).run();
  await syncOfficialRegistry(stableIdDb, runtime(async () => Response.json({
    servers: [{ server: { name: 'other', version: '1.0.0', description: '',
      repository: { url: repoB, source: 'github' } } }], metadata: { count: 1 },
  })));
  const refreshed = {
    ...glamaEntry('stable'),
    repository: { url: repoB },
    description: 'fresh term',
    environmentVariablesJsonSchema: {
      properties: { NEW_TOKEN: { description: 'current' } },
    },
  };
  await syncGlamaRegistry(stableIdDb, runtime(async () => Response.json(page([refreshed], false))));
  const stable = stableIdDb.prepare(
    "SELECT raw_data, keywords, repository_url, repository_source, env_vars, last_synced_at " +
      "FROM servers WHERE id = 'glama:stable'",
  ).get();
  assert.match(stable.raw_data, /fresh term/);
  assert.ok(JSON.parse(stable.keywords).includes('fresh'));
  assert.ok(!JSON.parse(stable.keywords).includes('old'));
  assert.equal(stable.repository_url, repoB);
  assert.equal(stable.repository_source, 'github');
  assert.deepEqual(JSON.parse(stable.env_vars).map((item) => item.name), ['NEW_TOKEN']);
  assert.notEqual(stable.last_synced_at, '2000-01-01T00:00:00.000Z');
  assert.ok(!Number.isNaN(Date.parse(stable.last_synced_at)));
  assert.deepEqual(
    JSON.parse(stableIdDb.prepare("SELECT sources FROM servers WHERE id = 'other'").get().sources),
    ['official'],
  );
  await syncGlamaRegistry(stableIdDb, runtime(async () => Response.json(page([{
    ...glamaEntry('stable'), repository: null, description: 'repository removed',
  }], false))));
  const withoutRepository = stableIdDb.prepare(
    "SELECT repository_url, repository_source FROM servers WHERE id = 'glama:stable'",
  ).get();
  assert.equal(withoutRepository.repository_url, null);
  assert.equal(withoutRepository.repository_source, null);
  assert.deepEqual(JSON.parse(
    stableIdDb.prepare("SELECT env_vars FROM servers WHERE id = 'glama:stable'").get().env_vars,
  ), []);
  stableIdDb.close();

  const refreshedIndexDb = initDatabase(join(dir, 'glama-stable-index-refresh.sqlite'));
  const oldRepo = 'https://github.com/acme/old-index-key';
  const newRepo = 'https://github.com/acme/new-index-key';
  await syncGlamaRegistry(refreshedIndexDb, runtime(async () => Response.json(page([{
    ...glamaEntry('indexed-stable'),
    slug: 'old-index-slug',
    repository: { url: oldRepo },
  }], false))));
  await syncGlamaRegistry(refreshedIndexDb, runtime(async () => Response.json(page([
    {
      ...glamaEntry('indexed-stable'),
      slug: 'new-index-slug',
      repository: { url: newRepo },
      description: 'refreshed stable payload',
    },
    {
      ...glamaEntry('new-at-old-keys'),
      slug: 'old-index-slug',
      repository: { url: oldRepo },
      description: 'separate old-key payload',
    },
  ], false))));
  assert.equal(refreshedIndexDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 2);
  const refreshedStable = refreshedIndexDb.prepare(
    "SELECT repository_url, slug, sources, raw_data FROM servers WHERE id = 'glama:indexed-stable'",
  ).get();
  assert.equal(refreshedStable.repository_url, newRepo);
  assert.equal(refreshedStable.slug, 'new-index-slug');
  assert.deepEqual(JSON.parse(refreshedStable.sources), ['glama']);
  assert.doesNotMatch(refreshedStable.raw_data, /separate old-key payload/);
  const separateOldKey = refreshedIndexDb.prepare(
    "SELECT repository_url, slug, sources, raw_data FROM servers WHERE id = 'glama:new-at-old-keys'",
  ).get();
  assert.equal(separateOldKey.repository_url, oldRepo);
  assert.equal(separateOldKey.slug, 'old-index-slug');
  assert.deepEqual(JSON.parse(separateOldKey.sources), ['glama']);
  assert.match(separateOldKey.raw_data, /separate old-key payload/);
  refreshedIndexDb.close();

  const intraDb = initDatabase(join(dir, 'glama-intra-duplicate.sqlite'));
  let intraCalls = 0;
  await syncGlamaRegistry(intraDb, runtime(async () => {
    intraCalls++;
    return Response.json(page([glamaEntry('intra'), glamaEntry('intra')], false));
  }));
  assert.equal(intraCalls, 1);
  assert.equal(syncLog(intraDb).status, 'error');
  assert.match(syncLog(intraDb).error, /duplicate server id/);
  assert.equal(intraDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 0);
  intraDb.close();

  const originalBudget = process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES;
  process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES = '1';
  try {
    const deadlineDb = initDatabase(join(dir, 'glama-staged-deadline.sqlite'));
    let clock = 0;
    let deadlineCalls = 0;
    await syncGlamaRegistry(deadlineDb, runtime(
      async () => {
        deadlineCalls++;
        return Response.json(page([glamaEntry('staged-only')], true, 'next'));
      },
      () => clock,
      async () => { clock = 60_000; },
    ));
    assert.equal(deadlineCalls, 1);
    assert.equal(syncLog(deadlineDb).status, 'error');
    assert.equal(syncLog(deadlineDb).server_count, 0);
    assert.match(syncLog(deadlineDb).error, /discarded 1 staged servers/);
    assert.equal(deadlineDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 0);
    deadlineDb.close();

    const applyDeadlineDb = initDatabase(join(dir, 'glama-apply-deadline.sqlite'));
    await syncOfficialRegistry(applyDeadlineDb, runtime(async () => Response.json({
      servers: [{ server: { name: 'glama-lkg', version: '1.0.0', description: 'unchanged' } }],
      metadata: { count: 1 },
    })));
    let applyClock = 0;
    const applyEntry = glamaEntry('apply-deadline');
    Object.defineProperty(applyEntry, 'description', {
      enumerable: true,
      get() { applyClock = 60_000; return 'late apply'; },
    });
    await syncGlamaRegistry(applyDeadlineDb, runtime(
      async () => ({
        ok: true, status: 200, statusText: 'OK',
        json: async () => page([applyEntry], false),
      }),
      () => applyClock,
    ));
    assert.equal(syncLog(applyDeadlineDb).status, 'error');
    assert.match(syncLog(applyDeadlineDb).error, /deadline exceeded/);
    assert.equal(applyDeadlineDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 1);
    assert.deepEqual(JSON.parse(applyDeadlineDb.prepare('SELECT sources FROM servers').get().sources), ['official']);
    applyDeadlineDb.close();
  } finally {
    if (originalBudget === undefined) delete process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES;
    else process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES = originalBudget;
  }
}
