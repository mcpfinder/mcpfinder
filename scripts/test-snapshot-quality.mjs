import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  baselineManifestErrors,
  currentSnapshotErrors,
  evaluateCurrentSnapshotQuality,
  evaluateSnapshotQuality,
  fetchPreviousManifest,
} from './snapshot-quality.mjs';
import { runSnapshotDedupChecks } from './snapshot-dedup-checks.mjs';
import { runSnapshotDbMigrationChecks } from './snapshot-db-migration-checks.mjs';
import { runSnapshotGlamaCrawlChecks } from './snapshot-glama-crawl-checks.mjs';
import { runSnapshotMergeChecks } from './snapshot-merge-checks.mjs';
import { runSnapshotGlamaCaptureChecks } from './snapshot-glama-capture-checks.mjs';

const dir = mkdtempSync(join(tmpdir(), 'mcpf-snapshot-quality-'));
const originalGlamaBudget = process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES;
// Glama requires an API key since 2026-08-26; without one every sync short-
// circuits before the first request. Give the crawl tests a stub credential.
const originalGlamaKey = process.env.GLAMA_API_KEY;
process.env.GLAMA_API_KEY = 'test-glama-key';
const glamaEmpty = { servers: [], pageInfo: { hasNextPage: false, endCursor: null } };

function runtime(fetchImpl, now = () => 0) {
  return { fetchImpl, now, sleep: async () => {} };
}

function syncLog(db, source) {
  return db
    .prepare('SELECT source, server_count, status, error FROM sync_log WHERE source = ?')
    .get(source);
}

// `serverCount` is a deduplicated row count; `counts.X` are raw per-registry
// record counts that overlap across registries. They deliberately sum to more
// than `serverCount` here, as the published manifest's do.
function healthyManifest(overrides = {}) {
  return {
    serverCount: 100,
    counts: { official: 60, glama: 50 },
    ...overrides,
  };
}

try {
  const {
    getLastSuccessfulSyncTimestamp,
    initDatabase,
    isSyncNeeded,
    syncOfficialRegistry,
    syncGlamaRegistry,
    updateSyncLog,
  } = await import('../packages/core/dist/index.js');
  const { fetchJsonPageWithRetry, fetchWithRetry, RegistryTransportError } = await import(
    '../packages/core/dist/registry-fetch.js'
  );

  // Exhausted transport retries are terminal and must not be multiplied by
  // the outer same-page malformed/body retry loop.
  let persistentNetworkCalls = 0;
  await assert.rejects(
    () =>
      fetchJsonPageWithRetry('https://example.invalid/network', {
        label: 'persistent network test',
        sleep: async () => {},
        fetchImpl: async () => {
          persistentNetworkCalls++;
          throw new Error('network unavailable');
        },
      }),
    (error) =>
      error instanceof RegistryTransportError &&
      /giving up after 4 attempts.*network unavailable/.test(error.message),
  );
  assert.equal(persistentNetworkCalls, 4);
  await runSnapshotDedupChecks();
  await runSnapshotDbMigrationChecks(dir);

  const officialEntry = (name, repo = null, description = '') => ({
    server: {
      name,
      version: '1.0.0',
      description,
      ...(repo
        ? { repository: { url: repo, source: repo.includes('gitlab.com') ? 'gitlab' : 'github' } }
        : {}),
    },
  });
  const glamaEntry = (id, repo, overrides = {}) => ({
    id,
    name: id,
    namespace: '',
    slug: id,
    description: '',
    repository: repo ? { url: repo } : null,
    spdxLicense: null,
    tools: [],
    url: null,
    environmentVariablesJsonSchema: null,
    attributes: {},
    ...overrides,
  });

  // Every registry follows all pagination metadata before recording healthy.
  const paginationDb = initDatabase(join(dir, 'pagination.sqlite'));
  let officialPage = 0;
  assert.equal(
    await syncOfficialRegistry(
      paginationDb,
      runtime(async () => {
        officialPage++;
        return Response.json({
          servers: [officialEntry(`official/${officialPage}`)],
          metadata: { nextCursor: officialPage === 1 ? 'official-next' : null, count: 1 },
        });
      }),
    ),
    2,
  );
  let glamaPage = 0;
  assert.equal(
    await syncGlamaRegistry(
      paginationDb,
      runtime(async () => {
        glamaPage++;
        return Response.json({
          servers: [glamaEntry(`glama-${glamaPage}`, null)],
          pageInfo: { hasNextPage: glamaPage === 1, endCursor: glamaPage === 1 ? 'glama-next' : null },
        });
      }),
    ),
    2,
  );
  assert.deepEqual([officialPage, glamaPage], [2, 2]);
  assert.equal(paginationDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 4);
  assert.deepEqual(
    paginationDb
      .prepare('SELECT source, COUNT(*) AS count FROM servers GROUP BY source ORDER BY source')
      .all()
      .map((row) => ({ ...row })),
    [
      { source: 'glama', count: 2 },
      { source: 'official', count: 2 },
    ],
  );
  for (const source of ['official', 'glama']) {
    assert.equal(syncLog(paginationDb, source).status, 'ok');
  }
  paginationDb.close();

  const officialVariableCountDb = initDatabase(join(dir, 'official-variable-page-count.sqlite'));
  let officialVariableCountCalls = 0;
  assert.equal(
    await syncOfficialRegistry(
      officialVariableCountDb,
      runtime(async () => {
        officialVariableCountCalls++;
        return officialVariableCountCalls === 1
          ? Response.json({
              servers: [officialEntry('official/variable-count')],
              metadata: { nextCursor: 'empty-terminal', count: 1 },
            })
          : Response.json({
              servers: [],
              metadata: { nextCursor: null, count: 0 },
            });
      }),
    ),
    1,
  );
  assert.equal(officialVariableCountCalls, 2);
  assert.equal(syncLog(officialVariableCountDb, 'official').status, 'ok');
  officialVariableCountDb.close();

  // Official nextCursor is `omitempty`; an exact-full page without it is a
  // legal terminal response, not evidence of truncation.
  const officialFullTerminalDb = initDatabase(join(dir, 'official-full-terminal.sqlite'));
  let officialFullTerminalCalls = 0;
  assert.equal(
    await syncOfficialRegistry(
      officialFullTerminalDb,
      runtime(async () => {
        officialFullTerminalCalls++;
        return Response.json({
          servers: Array.from({ length: 100 }, (_, index) =>
            officialEntry(`official/full-terminal-${index}`)),
          metadata: { count: 100 },
        });
      }),
    ),
    100,
  );
  assert.equal(officialFullTerminalCalls, 1);
  assert.equal(syncLog(officialFullTerminalDb, 'official').status, 'ok');
  officialFullTerminalDb.close();

  const officialRepeatDb = initDatabase(join(dir, 'official-repeated-cursor.sqlite'));
  let officialRepeatCalls = 0;
  await assert.rejects(
    () =>
      syncOfficialRegistry(
        officialRepeatDb,
        runtime(async () => {
          officialRepeatCalls++;
          return Response.json({
            servers: [],
            metadata: { nextCursor: 'stuck', count: 0 },
          });
        }),
      ),
    /repeated metadata\.nextCursor/,
  );
  assert.equal(officialRepeatCalls, 2);
  assert.equal(syncLog(officialRepeatDb, 'official').status, 'error');
  officialRepeatDb.close();

  const officialCountDb = initDatabase(join(dir, 'official-count-mismatch.sqlite'));
  await assert.rejects(
    () =>
      syncOfficialRegistry(
        officialCountDb,
        runtime(async () => Response.json({
          servers: [officialEntry('official/only-one')],
          metadata: { nextCursor: null, count: 2 },
        })),
      ),
    /metadata\.count 2 does not match 1 servers on this page/,
  );
  assert.equal(syncLog(officialCountDb, 'official').status, 'error');
  officialCountDb.close();

  for (const [name, payload, message] of [
    ['missing-metadata', { servers: [] }, /metadata must be an object/],
    ['missing-count', { servers: [], metadata: {} }, /metadata\.count/],
  ]) {
    const db = initDatabase(join(dir, `official-${name}.sqlite`));
    await assert.rejects(
      () => syncOfficialRegistry(db, runtime(async () => Response.json(payload))),
      message,
    );
    assert.equal(syncLog(db, 'official').status, 'error');
    db.close();
  }

  const officialOverwriteDb = initDatabase(join(dir, 'official-overwrite-health.sqlite'));
  await syncOfficialRegistry(
    officialOverwriteDb,
    runtime(async () => Response.json({
      servers: [officialEntry('official/healthy')],
      metadata: { count: 1 },
    })),
  );
  assert.equal(syncLog(officialOverwriteDb, 'official').status, 'ok');
  const healthyBeforeFailure = officialOverwriteDb
    .prepare("SELECT description, raw_data, sources FROM servers WHERE id = 'official/healthy'")
    .get();
  let overwriteCalls = 0;
  await assert.rejects(
    () =>
      syncOfficialRegistry(
        officialOverwriteDb,
        runtime(async () => {
          overwriteCalls++;
          return overwriteCalls === 1
            ? Response.json({
                servers: [
                  officialEntry('official/healthy', null, 'must roll back'),
                  officialEntry('official/partial'),
                ],
                metadata: { count: 2, nextCursor: 'next' },
              })
            : Response.json({ servers: [] });
        }),
      ),
    /metadata must be an object/,
  );
  assert.equal(syncLog(officialOverwriteDb, 'official').status, 'error');
  assert.equal(syncLog(officialOverwriteDb, 'official').server_count, 0);
  assert.equal(
    officialOverwriteDb.prepare(
      "SELECT COUNT(*) AS count FROM servers WHERE id = 'official/partial'",
    ).get().count,
    0,
  );
  assert.deepEqual(
    officialOverwriteDb
      .prepare("SELECT description, raw_data, sources FROM servers WHERE id = 'official/healthy'")
      .get(),
    healthyBeforeFailure,
  );
  officialOverwriteDb.close();

  const officialApplyDeadlineDb = initDatabase(join(dir, 'official-apply-deadline.sqlite'));
  await syncOfficialRegistry(
    officialApplyDeadlineDb,
    runtime(async () => Response.json({
      servers: [officialEntry('official/lkg', null, 'unchanged')],
      metadata: { count: 1 },
    })),
  );
  const officialLkg = officialApplyDeadlineDb
    .prepare("SELECT description, raw_data, sources FROM servers WHERE id = 'official/lkg'")
    .get();
  let officialApplyClock = 0;
  const lateOfficialEntry = officialEntry('official/new-during-late-apply');
  Object.defineProperty(lateOfficialEntry.server, 'description', {
    enumerable: true,
    get() { officialApplyClock = 8 * 60_000; return 'late apply'; },
  });
  await assert.rejects(
    () => syncOfficialRegistry(officialApplyDeadlineDb, {
      now: () => officialApplyClock,
      sleep: async () => {},
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ servers: [lateOfficialEntry], metadata: { count: 1 } }),
      }),
    }),
    /deadline exceeded/,
  );
  assert.equal(syncLog(officialApplyDeadlineDb, 'official').status, 'error');
  assert.equal(syncLog(officialApplyDeadlineDb, 'official').server_count, 0);
  assert.equal(
    officialApplyDeadlineDb.prepare(
      "SELECT COUNT(*) AS count FROM servers WHERE id = 'official/new-during-late-apply'",
    ).get().count,
    0,
  );
  assert.deepEqual(
    officialApplyDeadlineDb
      .prepare("SELECT description, raw_data, sources FROM servers WHERE id = 'official/lkg'")
      .get(),
    officialLkg,
  );
  officialApplyDeadlineDb.close();

  const attemptThrottleDb = initDatabase(join(dir, 'official-attempt-throttle.sqlite'));
  updateSyncLog(attemptThrottleDb, 'official', 0, 'error', 'temporary upstream failure');
  assert.equal(isSyncNeeded(attemptThrottleDb), false, 'recent failed attempt must be throttled');
  assert.equal(getLastSuccessfulSyncTimestamp(attemptThrottleDb, 'official'), null);
  let incrementalCalls = 0;
  await syncOfficialRegistry(
    attemptThrottleDb,
    runtime(async (requestUrl) => {
      incrementalCalls++;
      assert.equal(new URL(requestUrl).searchParams.get('updated_since'), null);
      return Response.json({ servers: [], metadata: { count: 0 } });
    }),
  );
  await syncOfficialRegistry(
    attemptThrottleDb,
    runtime(async (requestUrl) => {
      incrementalCalls++;
      assert.ok(new URL(requestUrl).searchParams.get('updated_since'));
      return Response.json({ servers: [], metadata: { count: 0 } });
    }),
  );
  updateSyncLog(attemptThrottleDb, 'official', 0, 'error', 'failure after a success');
  assert.equal(isSyncNeeded(attemptThrottleDb), false);
  assert.equal(getLastSuccessfulSyncTimestamp(attemptThrottleDb, 'official'), null);
  const failedAfterSuccess = attemptThrottleDb
    .prepare("SELECT status, last_successful_at FROM sync_log WHERE source = 'official'")
    .get();
  assert.equal(failedAfterSuccess.status, 'error');
  assert.ok(failedAfterSuccess.last_successful_at, 'historical success timestamp must be retained');
  await syncOfficialRegistry(
    attemptThrottleDb,
    runtime(async (requestUrl) => {
      incrementalCalls++;
      assert.equal(
        new URL(requestUrl).searchParams.get('updated_since'),
        null,
        'a failed latest attempt must force a full Official sync',
      );
      return Response.json({ servers: [], metadata: { count: 0 } });
    }),
  );
  assert.equal(incrementalCalls, 3);
  attemptThrottleDb.close();

  await runSnapshotMergeChecks(dir);

  await runSnapshotGlamaCaptureChecks(dir);

  // Glama retries a malformed page before any insert and can recover healthy.
  const recoveredDb = initDatabase(join(dir, 'glama-recovered.sqlite'));
  let recoveredCalls = 0;
  const recoveredRuntime = runtime(async () => {
    recoveredCalls++;
    return recoveredCalls === 1
      ? new Response('{broken json', { status: 200 })
      : Response.json(glamaEmpty);
  });
  assert.equal(await syncGlamaRegistry(recoveredDb, recoveredRuntime), 0);
  assert.equal(recoveredCalls, 2);
  assert.equal(syncLog(recoveredDb, 'glama').status, 'ok');
  recoveredDb.close();

  // Persistent malformed JSON exhausts the same-page retries and degrades.
  const malformedDb = initDatabase(join(dir, 'glama-malformed.sqlite'));
  let malformedCalls = 0;
  const malformedRuntime = runtime(async () => {
    malformedCalls++;
    return new Response('{broken json', { status: 200 });
  });
  assert.equal(await syncGlamaRegistry(malformedDb, malformedRuntime), 0);
  assert.equal(malformedCalls, 4);
  assert.equal(syncLog(malformedDb, 'glama').status, 'error');
  assert.match(syncLog(malformedDb, 'glama').error, /invalid JSON/i);
  malformedDb.close();

  // Structurally incomplete Glama pages must never look healthy.
  for (const [name, payload, message] of [
    ['missing-servers', { pageInfo: { hasNextPage: false } }, /servers must be an array/],
    [
      'missing-cursor',
      { servers: [], pageInfo: { hasNextPage: true, endCursor: null } },
      /endCursor is required/,
    ],
    ['missing-page-info', { servers: [] }, /pageInfo must be an object/],
  ]) {
    const db = initDatabase(join(dir, `glama-${name}.sqlite`));
    await syncGlamaRegistry(db, runtime(async () => Response.json(payload)));
    assert.equal(syncLog(db, 'glama').status, 'error');
    assert.match(syncLog(db, 'glama').error, message);
    db.close();
  }

  // Empty pages may legally continue only when their cursor makes progress.
  const emptyContinuationDb = initDatabase(join(dir, 'glama-empty-continuation.sqlite'));
  let emptyContinuationCalls = 0;
  await syncGlamaRegistry(
    emptyContinuationDb,
    runtime(async () => {
      emptyContinuationCalls++;
      return Response.json(
        emptyContinuationCalls === 1
          ? { servers: [], pageInfo: { hasNextPage: true, endCursor: 'next' } }
          : glamaEmpty,
      );
    }),
  );
  assert.equal(emptyContinuationCalls, 2);
  assert.equal(syncLog(emptyContinuationDb, 'glama').status, 'ok');
  emptyContinuationDb.close();

  const repeatedCursorDb = initDatabase(join(dir, 'glama-repeated-cursor.sqlite'));
  let repeatedCursorCalls = 0;
  await syncGlamaRegistry(
    repeatedCursorDb,
    runtime(async () => {
      repeatedCursorCalls++;
      return Response.json({
        servers: [],
        pageInfo: { hasNextPage: true, endCursor: 'repeated' },
      });
    }),
  );
  assert.equal(repeatedCursorCalls, 2);
  assert.equal(syncLog(repeatedCursorDb, 'glama').status, 'error');
  assert.match(syncLog(repeatedCursorDb, 'glama').error, /repeated pageInfo\.endCursor/);
  repeatedCursorDb.close();

  const missingGlamaIdDb = initDatabase(join(dir, 'glama-missing-server-id.sqlite'));
  await syncGlamaRegistry(
    missingGlamaIdDb,
    runtime(async () => Response.json({
      servers: [{ ...glamaEntry('omitted', null), id: undefined }],
      pageInfo: { hasNextPage: false, endCursor: null },
    })),
  );
  assert.equal(syncLog(missingGlamaIdDb, 'glama').status, 'error');
  assert.match(syncLog(missingGlamaIdDb, 'glama').error, /server id must be a non-empty string/);
  assert.equal(missingGlamaIdDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 0);
  missingGlamaIdDb.close();

  await runSnapshotGlamaCrawlChecks(dir);

  // Valid and invalid Glama budget configuration both leave auditable state.
  process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES = '30';
  const overrideDb = initDatabase(join(dir, 'override.sqlite'));
  let overrideCalls = 0;
  const overrideTimes = [0, 20 * 60_000];
  await syncGlamaRegistry(
    overrideDb,
    runtime(async () => {
      overrideCalls++;
      return Response.json(glamaEmpty);
    }, () => overrideTimes[Math.min(overrideCalls, overrideTimes.length - 1)]),
  );
  assert.equal(overrideCalls, 1);
  assert.equal(syncLog(overrideDb, 'glama').status, 'ok');
  overrideDb.close();

  process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES = '0';
  const invalidBudgetDb = initDatabase(join(dir, 'invalid-budget.sqlite'));
  assert.equal(await syncGlamaRegistry(invalidBudgetDb, runtime(async () => Response.json(glamaEmpty))), 0);
  assert.equal(syncLog(invalidBudgetDb, 'glama').status, 'error');
  assert.match(syncLog(invalidBudgetDb, 'glama').error, /integer between 1 and 40/);
  invalidBudgetDb.close();
  if (originalGlamaBudget === undefined) delete process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES;
  else process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES = originalGlamaBudget;

  // Official budget: unset keeps the 8-minute local default, a valid override
  // widens the deadline, and invalid values fail loudly with an audit trail.
  const originalOfficialBudget = process.env.MCPFINDER_OFFICIAL_SYNC_BUDGET_MINUTES;
  const officialOnePage = async () =>
    Response.json({ servers: [officialEntry('official/budget')], metadata: { nextCursor: null, count: 1 } });
  for (const [value, elapsedMin, ok] of [
    [undefined, 7, true],
    [undefined, 9, false],
    ['', 7, true],
    ['25', 20, true],
    ['25', 26, false],
  ]) {
    if (value === undefined) delete process.env.MCPFINDER_OFFICIAL_SYNC_BUDGET_MINUTES;
    else process.env.MCPFINDER_OFFICIAL_SYNC_BUDGET_MINUTES = value;
    const budgetDb = initDatabase(join(dir, `official-budget-${value ?? 'unset'}-${elapsedMin}.sqlite`));
    let calls = 0;
    const times = [0, elapsedMin * 60_000];
    const run = syncOfficialRegistry(
      budgetDb,
      runtime(async (...args) => { calls++; return officialOnePage(...args); },
        () => times[Math.min(calls, times.length - 1)]),
    );
    if (ok) assert.equal(await run, 1, `budget ${value} at ${elapsedMin} min`);
    else await assert.rejects(run, /deadline|budget/, `budget ${value} at ${elapsedMin} min`);
    assert.equal(syncLog(budgetDb, 'official').status, ok ? 'ok' : 'error');
    budgetDb.close();
  }
  for (const bad of ['0', '31', 'abc', '8.5', '-1']) {
    process.env.MCPFINDER_OFFICIAL_SYNC_BUDGET_MINUTES = bad;
    const badDb = initDatabase(join(dir, `official-budget-bad-${bad}.sqlite`));
    await assert.rejects(
      syncOfficialRegistry(badDb, runtime(officialOnePage)),
      /MCPFINDER_OFFICIAL_SYNC_BUDGET_MINUTES must be an integer between 1 and 30/,
    );
    assert.equal(syncLog(badDb, 'official').status, 'error');
    badDb.close();
  }
  // Official per-request timeout: validated like the budget, and the value
  // actually reaches the abort timer (a fetch that only settles on abort).
  const originalOfficialTimeout = process.env.MCPFINDER_OFFICIAL_REQUEST_TIMEOUT_SECONDS;
  delete process.env.MCPFINDER_OFFICIAL_SYNC_BUDGET_MINUTES;
  for (const bad of ['4', '121', 'abc', '7.5']) {
    process.env.MCPFINDER_OFFICIAL_REQUEST_TIMEOUT_SECONDS = bad;
    const badDb = initDatabase(join(dir, `official-timeout-bad-${bad}.sqlite`));
    await assert.rejects(
      syncOfficialRegistry(badDb, runtime(officialOnePage)),
      /MCPFINDER_OFFICIAL_REQUEST_TIMEOUT_SECONDS must be an integer between 5 and 120/,
    );
    assert.equal(syncLog(badDb, 'official').status, 'error');
    badDb.close();
  }
  process.env.MCPFINDER_OFFICIAL_REQUEST_TIMEOUT_SECONDS = '5';
  {
    const timeoutDb = initDatabase(join(dir, 'official-timeout-5.sqlite'));
    let firstAbortMs;
    const started = Date.now();
    let hangs = 1;
    const result = await syncOfficialRegistry(
      timeoutDb,
      runtime(async (_url, init) => {
        if (hangs-- > 0) {
          return new Promise((_, reject) => {
            init.signal.addEventListener('abort', () => {
              firstAbortMs = Date.now() - started;
              reject(new Error('aborted'));
            });
          });
        }
        return officialOnePage();
      }, Date.now),
    );
    assert.equal(result, 1);
    assert.ok(firstAbortMs >= 4_500 && firstAbortMs < 15_000, `abort after ${firstAbortMs} ms`);
    timeoutDb.close();
  }
  delete process.env.MCPFINDER_OFFICIAL_REQUEST_TIMEOUT_SECONDS;

  // A page that exhausts its transport retries resumes at the same cursor
  // with earlier pages kept; only after every resume round does the sync fail.
  for (const [failures, ok] of [[4, true], [8, true], [12, false]]) {
    const resumeDb = initDatabase(join(dir, `official-resume-${failures}.sqlite`));
    const urls = [];
    let page2Failures = failures;
    const run = syncOfficialRegistry(
      resumeDb,
      runtime(async (url) => {
        urls.push(String(url));
        const second = String(url).includes('cursor=official-next');
        if (second && page2Failures-- > 0) throw new Error('socket hang up');
        return Response.json({
          servers: [officialEntry(second ? 'official/resume-2' : 'official/resume-1')],
          metadata: { nextCursor: second ? null : 'official-next', count: 1 },
        });
      }),
    );
    if (ok) {
      assert.equal(await run, 2, `${failures} page-2 failures`);
      assert.equal(syncLog(resumeDb, 'official').status, 'ok');
    } else {
      await assert.rejects(run, /giving up after 4 attempts/);
      assert.equal(syncLog(resumeDb, 'official').status, 'error');
    }
    // Page 1 is fetched exactly once: resuming never restarts the crawl.
    assert.equal(urls.filter((u) => !u.includes('cursor=')).length, 1);
    resumeDb.close();
  }
  // Advancing clock: with less than the 5 s resume wait left, the original
  // transport error surfaces and no sleep runs past the deadline; HTTP 429 is
  // never resumed.
  {
    let clockMs = 0;
    let lateFailures = 0;
    const sleeps = [];
    const advancing = {
      now: () => clockMs,
      sleep: async (ms) => { sleeps.push(ms); clockMs += ms; },
      fetchImpl: async (url) => {
        if (String(url).includes('cursor=official-next')) {
          // Attempts 1-3 fail early (their backoffs fit); the 4th lands the
          // clock 3 s before the 8-minute deadline, so transport retries are
          // exhausted with less than the 5 s resume wait left.
          lateFailures++;
          if (lateFailures === 4) clockMs = 8 * 60_000 - 3_000;
          throw new Error('socket hang up');
        }
        return Response.json({
          servers: [officialEntry('official/late-1')],
          metadata: { nextCursor: 'official-next', count: 1 },
        });
      },
    };
    const lateDb = initDatabase(join(dir, 'official-resume-late.sqlite'));
    await assert.rejects(syncOfficialRegistry(lateDb, advancing), /giving up after 4 attempts/);
    assert.equal(lateFailures, 4, 'no resume round without room for its wait');
    assert.ok(clockMs <= 8 * 60_000, `clock ${clockMs} ran past the deadline`);
    assert.ok(!sleeps.includes(5_000), 'resume wait must not start without room for it');
    lateDb.close();

    let tooMany = 0;
    const rateDb = initDatabase(join(dir, 'official-resume-429.sqlite'));
    await assert.rejects(
      syncOfficialRegistry(
        rateDb,
        runtime(async () => {
          tooMany++;
          return new Response('slow down', { status: 429 });
        }),
      ),
      /HTTP 429/,
    );
    assert.equal(tooMany, 4, '429 gets one round of transport retries, no resume');
    rateDb.close();
  }
  if (originalOfficialTimeout === undefined) delete process.env.MCPFINDER_OFFICIAL_REQUEST_TIMEOUT_SECONDS;
  else process.env.MCPFINDER_OFFICIAL_REQUEST_TIMEOUT_SECONDS = originalOfficialTimeout;
  if (originalOfficialBudget === undefined) delete process.env.MCPFINDER_OFFICIAL_SYNC_BUDGET_MINUTES;
  else process.env.MCPFINDER_OFFICIAL_SYNC_BUDGET_MINUTES = originalOfficialBudget;

  // Registry deadline is checked after fetch and JSON parse, including a
  // terminal page that would otherwise be marked healthy.
  let deadlineNow = 0;
  await assert.rejects(
    () =>
      fetchJsonPageWithRetry('https://example.invalid/page', {
        label: 'deadline test',
        deadline: 100,
        now: () => deadlineNow,
        sleep: async (ms) => {
          deadlineNow += ms;
        },
        fetchImpl: async () => {
          deadlineNow = 100;
          return Response.json(glamaEmpty);
        },
      }),
    /registry deadline exceeded/,
  );

  // Exercise the real abort timer: no fake clock or global timer replacement.
  let requestSignalAborted = false;
  await assert.rejects(
    () =>
      fetchWithRetry('https://example.invalid/timeout', {
        label: 'request timeout test',
        timeoutMs: 15,
        retries: 0,
        fetchImpl: async (_url, init) =>
          await new Promise((_resolve, reject) => {
            init.signal.addEventListener(
              'abort',
              () => {
                requestSignalAborted = init.signal.aborted;
                reject(init.signal.reason ?? new Error('request aborted'));
              },
              { once: true },
            );
          }),
      }, async (response) => response.text()),
    /giving up after 1 attempts/,
  );
  assert.equal(requestSignalAborted, true);

  // Headers alone do not complete a request: the abort timer remains active
  // while a stalled body is being consumed.
  let bodySignalAborted = false;
  await assert.rejects(
    () =>
      fetchWithRetry(
        'https://example.invalid/stalled-body',
        {
          label: 'stalled body timeout test',
          timeoutMs: 15,
          retries: 0,
          fetchImpl: async (_url, init) =>
            new Response(
              new ReadableStream({
                start(controller) {
                  init.signal.addEventListener(
                    'abort',
                    () => {
                      bodySignalAborted = true;
                      controller.error(init.signal.reason ?? new Error('body aborted'));
                    },
                    { once: true },
                  );
                },
              }),
            ),
        },
        async (response) => response.text(),
      ),
  );
  assert.equal(bodySignalAborted, true);

  const terminalDeadlineDb = initDatabase(join(dir, 'terminal-deadline.sqlite'));
  let terminalNow = 0;
  await syncGlamaRegistry(terminalDeadlineDb, {
    now: () => terminalNow,
    sleep: async () => {},
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        terminalNow = 12 * 60_000;
        return glamaEmpty;
      },
    }),
  });
  assert.equal(syncLog(terminalDeadlineDb, 'glama').status, 'error');
  assert.match(syncLog(terminalDeadlineDb, 'glama').error, /deadline exceeded/);
  terminalDeadlineDb.close();

  // Previous manifest: only 404 is a soft no-baseline result.
  const noBaseline = await fetchPreviousManifest({
    url: 'https://example.invalid/manifest.json',
    requiredSources: ['official', 'glama'],
    fetchImpl: async () => new Response('', { status: 404 }),
    sleep: async () => {},
  });
  assert.equal(noBaseline, null);

  let transientCalls = 0;
  const recoveredBaseline = await fetchPreviousManifest({
    url: 'https://example.invalid/manifest.json',
    requiredSources: ['official', 'glama'],
    fetchImpl: async () => {
      transientCalls++;
      return transientCalls === 1
        ? new Response('', { status: 503 })
        : Response.json(healthyManifest());
    },
    sleep: async () => {},
  });
  assert.equal(transientCalls, 2);
  assert.equal(recoveredBaseline.serverCount, 100);

  let networkCalls = 0;
  const networkRecovered = await fetchPreviousManifest({
    url: 'https://example.invalid/manifest.json',
    requiredSources: ['official', 'glama'],
    fetchImpl: async () => {
      networkCalls++;
      if (networkCalls === 1) throw new TypeError('temporary network failure');
      return Response.json(healthyManifest());
    },
    sleep: async () => {},
  });
  assert.equal(networkCalls, 2);
  assert.equal(networkRecovered.serverCount, 100);

  await assert.rejects(
    () =>
      fetchPreviousManifest({
        url: 'https://example.invalid/manifest.json',
        requiredSources: ['official', 'glama'],
        retries: 1,
        fetchImpl: async () => new Response('', { status: 503 }),
        sleep: async () => {},
      }),
    /unavailable after 2 attempts/,
  );

  await assert.rejects(
    () =>
      fetchPreviousManifest({
        url: 'https://example.invalid/manifest.json',
        requiredSources: ['official', 'glama'],
        retries: 1,
        fetchImpl: async () => Response.json(healthyManifest({ counts: { official: 60 } })),
        sleep: async () => {},
      }),
    /counts\.glama must be a positive number/,
  );

  assert.deepEqual(
    baselineManifestErrors(healthyManifest({ counts: { official: 60, glama: 0 } }), [
      'official',
      'glama',
    ]),
    ['previous manifest counts.glama must be a positive number'],
  );

  const healthyLog = [
    { source: 'official', status: 'ok', error: null },
    { source: 'glama', status: 'ok', error: null },
  ];
  const invalidCurrent = evaluateCurrentSnapshotQuality({
    syncLog: healthyLog,
    requiredSources: ['official', 'glama'],
    current: { serverCount: 0, counts: { official: 60, glama: 0 } },
  });
  assert.equal(invalidCurrent.ok, false);
  assert.deepEqual(invalidCurrent.warnings, []);
  assert.match(invalidCurrent.errors.join('\n'), /current serverCount must be a positive number/);
  assert.match(invalidCurrent.errors.join('\n'), /current counts\.glama must be a positive number/);

  const invalidCurrentWithOverride = evaluateSnapshotQuality({
    syncLog: healthyLog,
    requiredSources: ['official', 'glama'],
    current: { serverCount: 0, counts: { official: 60, glama: 0 } },
    previous: null,
    allowRegression: true,
  });
  assert.equal(invalidCurrentWithOverride.ok, false);
  assert.match(invalidCurrentWithOverride.errors.join('\n'), /current serverCount/);

  const totalRegression = evaluateSnapshotQuality({
    syncLog: healthyLog,
    requiredSources: ['official', 'glama'],
    current: { serverCount: 94, counts: { official: 60, glama: 50 } },
    previous: healthyManifest(),
  });
  assert.equal(totalRegression.ok, false);
  assert.match(totalRegression.errors.join('\n'), /serverCount dropped/);

  const sourceRegression = evaluateSnapshotQuality({
    syncLog: healthyLog,
    requiredSources: ['official', 'glama'],
    current: { serverCount: 100, counts: { official: 60, glama: 37 } },
    previous: healthyManifest(),
  });
  assert.equal(sourceRegression.ok, false);
  assert.match(sourceRegression.errors.join('\n'), /counts\.glama dropped/);

  const firstRun = evaluateSnapshotQuality({
    syncLog: healthyLog,
    requiredSources: ['official', 'glama'],
    current: healthyManifest(),
    previous: null,
  });
  assert.equal(firstRun.ok, true);

  const overridden = evaluateSnapshotQuality({
    syncLog: healthyLog,
    requiredSources: ['official', 'glama'],
    current: { serverCount: 10, counts: { official: 6, glama: 4 } },
    previous: healthyManifest(),
    allowRegression: true,
  });
  assert.equal(overridden.ok, true);
  assert.equal(overridden.regressionOverridden, true);

  for (const unhealthyLog of [
    [{ source: 'official', status: 'error', error: 'upstream failed' }],
    [{ source: 'glama', status: 'ok', error: null }],
  ]) {
    const result = evaluateSnapshotQuality({
      syncLog: unhealthyLog,
      requiredSources: ['official', 'glama'],
      current: { serverCount: 10, counts: { official: 6, glama: 4 } },
      previous: healthyManifest(),
      allowRegression: true,
    });
    assert.equal(result.ok, false, 'override must not bypass errored/missing source health');
  }

  // ── The best-effort mechanism ────────────────────────────────────────────
  // No source is best-effort under the current policy (see the source-policy
  // block below); these cases exercise the parameterised `optionalSources`
  // mechanism itself, kept ready for a registry that closes permanently. A
  // best-effort source must warn, never block, while required sources gate.
  const glamaDownLog = [
    { source: 'official', status: 'ok', error: null },
    { source: 'glama', status: 'error', error: 'Glama API rejected GLAMA_API_KEY: HTTP 401' },
  ];
  const bestEffortRequired = ['official'];
  const bestEffortOptional = ['glama'];

  const glamaErrored = evaluateSnapshotQuality({
    syncLog: glamaDownLog,
    requiredSources: bestEffortRequired,
    optionalSources: bestEffortOptional,
    current: { serverCount: 60, counts: { official: 60, glama: 0 } },
    previous: healthyManifest(),
  });
  assert.equal(glamaErrored.ok, true, 'a failed best-effort source must not block publication');
  assert.equal(glamaErrored.errors.length, 0);
  assert.match(glamaErrored.warnings.join('\n'), /best-effort source glama is error/);
  assert.match(glamaErrored.warnings.join('\n'), /HTTP 401/);
  // The aggregate check is skipped, not recomputed against a doctored baseline:
  // 60 deduplicated servers against a baseline of 100 would otherwise read as a
  // 40% collapse even though only the best-effort source went away.
  assert.match(
    glamaErrored.warnings.join('\n'),
    /serverCount regression check skipped: best-effort source glama is unavailable/,
  );
  assert.doesNotMatch(glamaErrored.warnings.join('\n'), /discounting/);

  // Raw per-source counts may exceed the deduplicated serverCount (Glama's real
  // corpus is ~78k records inside a ~103k-server snapshot). Discounting used to
  // zero the baseline here and silently disable the aggregate gate entirely.
  const overlappingCounts = evaluateSnapshotQuality({
    syncLog: glamaDownLog,
    requiredSources: bestEffortRequired,
    optionalSources: bestEffortOptional,
    current: { serverCount: 60, counts: { official: 60, glama: 0 } },
    previous: healthyManifest({ serverCount: 100, counts: { official: 60, glama: 130 } }),
  });
  assert.equal(overlappingCounts.ok, true);
  assert.match(
    overlappingCounts.warnings.join('\n'),
    /serverCount regression check skipped: best-effort source glama is unavailable/,
  );

  // A skipped Glama (no GLAMA_API_KEY) behaves the same way.
  const glamaSkipped = evaluateSnapshotQuality({
    syncLog: [
      { source: 'official', status: 'ok', error: null },
      { source: 'glama', status: 'skipped', error: 'Glama API requires GLAMA_API_KEY; skipping' },
    ],
    requiredSources: bestEffortRequired,
    optionalSources: bestEffortOptional,
    current: { serverCount: 60, counts: { official: 60, glama: 0 } },
    previous: healthyManifest(),
  });
  assert.equal(glamaSkipped.ok, true);
  assert.match(glamaSkipped.warnings.join('\n'), /best-effort source glama is skipped/);

  // A zero count for a best-effort source passes both gates, since only the
  // required sources are checked for a positive count.
  assert.deepEqual(currentSnapshotErrors(
    { serverCount: 60, counts: { official: 60, glama: 0 } },
    bestEffortRequired,
  ), []);
  const zeroGlamaCurrent = evaluateCurrentSnapshotQuality({
    syncLog: glamaDownLog,
    requiredSources: bestEffortRequired,
    optionalSources: bestEffortOptional,
    current: { serverCount: 60, counts: { official: 60, glama: 0 } },
  });
  assert.equal(zeroGlamaCurrent.ok, true);
  assert.match(zeroGlamaCurrent.warnings.join('\n'), /best-effort source glama is error/);

  // A previous manifest with a healthy counts.glama is still a valid baseline.
  assert.deepEqual(baselineManifestErrors(healthyManifest(), bestEffortRequired), []);

  // A required source failing still blocks, even with another one demoted.
  const officialDown = evaluateSnapshotQuality({
    syncLog: [
      { source: 'official', status: 'error', error: 'upstream failed' },
      { source: 'glama', status: 'ok', error: null },
    ],
    requiredSources: bestEffortRequired,
    optionalSources: bestEffortOptional,
    current: { serverCount: 100, counts: { official: 60, glama: 40 } },
    previous: healthyManifest(),
  });
  assert.equal(officialDown.ok, false);
  assert.match(officialDown.errors.join('\n'), /required source official is error/);

  // Degraded mode is not a hole: the required per-source checks compare raw
  // against raw, so an Official collapse behind an absent Glama still fails.
  const officialCollapse = evaluateSnapshotQuality({
    syncLog: glamaDownLog,
    requiredSources: bestEffortRequired,
    optionalSources: bestEffortOptional,
    current: { serverCount: 20, counts: { official: 20, glama: 0 } },
    previous: healthyManifest(),
  });
  assert.equal(officialCollapse.ok, false);
  assert.match(officialCollapse.errors.join('\n'), /counts\.official dropped from 60 to 20/);
  assert.doesNotMatch(officialCollapse.errors.join('\n'), /serverCount dropped/);

  // With every best-effort source healthy the aggregate gate is live again, and
  // a real corpus collapse blocks publication whichever source caused it. The
  // manual MCPFINDER_SNAPSHOT_QUALITY_OVERRIDE remains the intentional escape.
  const healthyGlamaCollapse = evaluateSnapshotQuality({
    syncLog: healthyLog,
    requiredSources: bestEffortRequired,
    optionalSources: bestEffortOptional,
    current: { serverCount: 55, counts: { official: 60, glama: 5 } },
    previous: healthyManifest(),
  });
  assert.equal(healthyGlamaCollapse.ok, false);
  assert.match(healthyGlamaCollapse.errors.join('\n'), /serverCount dropped from 100 to 55/);
  assert.match(healthyGlamaCollapse.warnings.join('\n'), /best-effort counts\.glama dropped/);

  // A healthy but shrinking best-effort source warns instead of failing while
  // the deduplicated total holds steady.
  const glamaShrank = evaluateSnapshotQuality({
    syncLog: healthyLog,
    requiredSources: bestEffortRequired,
    optionalSources: bestEffortOptional,
    current: { serverCount: 97, counts: { official: 60, glama: 37 } },
    previous: healthyManifest(),
  });
  assert.equal(glamaShrank.ok, true);
  assert.equal(glamaShrank.errors.length, 0);
  assert.match(glamaShrank.warnings.join('\n'), /best-effort counts\.glama dropped/);

  // ── Source policy: both registries are required ────────────────────────────
  //
  // An incomplete snapshot never replaces a complete one. `manifest.json` is
  // the pointer swapped as the last publication step, so a failed gate leaves
  // the previous, complete snapshot serving: a failed build costs freshness
  // (visible in `publishedAt`), while a missing registry would silently cost
  // data. The builder must therefore list every registry as required and leave
  // the best-effort list empty.
  const builderSource = readFileSync(new URL('./build-snapshot.mjs', import.meta.url), 'utf8');
  const sourcePolicy = builderSource.slice(
    builderSource.indexOf('const requiredSources'),
    builderSource.indexOf('console.log(`[build-snapshot] out='),
  );
  assert.match(sourcePolicy, /const requiredSources = \['official'\];/);
  assert.match(sourcePolicy, /if \(!flag\('--no-glama'\)\) requiredSources\.push\('glama'\);/);
  // Smithery's API shuts down on 2026-10-31; it must not come back as a source.
  assert.doesNotMatch(sourcePolicy, /smithery/i);
  assert.doesNotMatch(builderSource, /syncSmitheryRegistry|enrichSmitheryRepoUrls/);
  assert.match(sourcePolicy, /const optionalSources = \[\];/);
  assert.doesNotMatch(
    sourcePolicy,
    /optionalSources\.push/,
    'no registry may be demoted to best-effort in the shipped build policy',
  );

  const allRequired = ['official', 'glama'];
  const allHealthyLog = allRequired.map((source) => ({ source, status: 'ok', error: null }));
  const fullCounts = { official: 60, glama: 40 };
  const fullCurrent = { serverCount: 100, counts: fullCounts };
  const fullPrevious = healthyManifest({ serverCount: 100, counts: fullCounts });

  const allHealthy = evaluateSnapshotQuality({
    syncLog: allHealthyLog,
    requiredSources: allRequired,
    optionalSources: [],
    current: fullCurrent,
    previous: fullPrevious,
  });
  assert.equal(allHealthy.ok, true);
  assert.equal(allHealthy.warnings.length, 0);

  // A failure of either registry blocks publication, and the count
  // override never buys a way past it.
  for (const [source, status, error] of [
    ['official', 'error', 'upstream failed'],
    ['official', 'degraded', 'sync budget exceeded'],
    ['glama', 'skipped', 'Glama API requires GLAMA_API_KEY; skipping Glama sync'],
    ['glama', 'degraded', 'sync budget exceeded'],
  ]) {
    const degradedLog = allHealthyLog.map((entry) =>
      entry.source === source ? { source, status, error } : entry,
    );
    const result = evaluateSnapshotQuality({
      syncLog: degradedLog,
      requiredSources: allRequired,
      optionalSources: [],
      current: fullCurrent,
      previous: fullPrevious,
      allowRegression: true,
    });
    assert.equal(result.ok, false, `an unhealthy ${source} must block publication`);
    assert.match(result.errors.join('\n'), new RegExp(`required source ${source} is ${status}`));
    assert.doesNotMatch(result.warnings.join('\n'), /best-effort/);
  }

  // A registry that never reported at all blocks too — same for both.
  for (const source of allRequired) {
    const result = evaluateCurrentSnapshotQuality({
      syncLog: allHealthyLog.filter((entry) => entry.source !== source),
      requiredSources: allRequired,
      optionalSources: [],
      current: fullCurrent,
    });
    assert.equal(result.ok, false, `a missing ${source} sync_log row must block publication`);
    assert.match(
      result.errors.join('\n'),
      new RegExp(`required source ${source} has no sync_log entry`),
    );
  }

  // And an `ok` sync that committed nothing blocks: counts.<source> = 0 is no
  // longer a publishable state for any registry.
  for (const source of allRequired) {
    const result = evaluateCurrentSnapshotQuality({
      syncLog: allHealthyLog,
      requiredSources: allRequired,
      optionalSources: [],
      current: { serverCount: 100, counts: { ...fullCounts, [source]: 0 } },
    });
    assert.equal(result.ok, false, `counts.${source} = 0 must block publication`);
    assert.match(
      result.errors.join('\n'),
      new RegExp(`current counts\\.${source} must be a positive number`),
    );
  }

  // ── GLAMA_API_KEY plumbing ───────────────────────────────────────────────
  const savedKey = process.env.GLAMA_API_KEY;
  process.env.GLAMA_API_KEY = 'secret-glama-key';
  const authDb = initDatabase(join(dir, 'glama-auth-header.sqlite'));
  let seenAuthorization = null;
  await syncGlamaRegistry(authDb, runtime(async (_url, init) => {
    seenAuthorization = new Headers(init.headers).get('authorization');
    return Response.json(glamaEmpty);
  }));
  assert.equal(seenAuthorization, 'Bearer secret-glama-key');
  assert.equal(syncLog(authDb, 'glama').status, 'ok');
  authDb.close();

  // A rejected key is a credential problem, not weather: one request only, and
  // the failure message must not echo the key or any request header.
  const rejectedDb = initDatabase(join(dir, 'glama-rejected-key.sqlite'));
  let rejectedCalls = 0;
  await syncGlamaRegistry(rejectedDb, runtime(async () => {
    rejectedCalls++;
    return Response.json({ error: { code: 'unauthorized' } }, { status: 401 });
  }));
  assert.equal(rejectedCalls, 1, '401 must not be retried');
  assert.equal(syncLog(rejectedDb, 'glama').status, 'error');
  assert.match(syncLog(rejectedDb, 'glama').error, /rejected GLAMA_API_KEY: HTTP 401/);
  assert.doesNotMatch(syncLog(rejectedDb, 'glama').error, /secret-glama-key|Bearer|authorization/i);
  rejectedDb.close();

  // No key at all: skip cleanly without issuing a request that can only 401.
  delete process.env.GLAMA_API_KEY;
  const noKeyDb = initDatabase(join(dir, 'glama-no-key.sqlite'));
  let noKeyCalls = 0;
  assert.equal(
    await syncGlamaRegistry(noKeyDb, runtime(async () => {
      noKeyCalls++;
      return Response.json(glamaEmpty);
    })),
    0,
  );
  assert.equal(noKeyCalls, 0);
  assert.equal(syncLog(noKeyDb, 'glama').status, 'skipped');
  assert.match(syncLog(noKeyDb, 'glama').error, /requires GLAMA_API_KEY; skipping/);
  assert.equal(noKeyDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 0);
  noKeyDb.close();
  // A blank secret (an undefined GitHub secret expands to '') is the same case.
  process.env.GLAMA_API_KEY = '   ';
  const blankKeyDb = initDatabase(join(dir, 'glama-blank-key.sqlite'));
  await syncGlamaRegistry(blankKeyDb, runtime(async () => Response.json(glamaEmpty)));
  assert.equal(syncLog(blankKeyDb, 'glama').status, 'skipped');
  blankKeyDb.close();
  process.env.GLAMA_API_KEY = savedKey;

  for (const previous of [
    healthyManifest({ serverCount: 0 }),
    healthyManifest({ counts: { official: 60 } }),
  ]) {
    const result = evaluateSnapshotQuality({
      syncLog: healthyLog,
      requiredSources: ['official', 'glama'],
      current: healthyManifest(),
      previous,
      allowRegression: true,
    });
    assert.equal(result.ok, false, 'override must not bypass invalid baseline');
  }
} finally {
  if (originalGlamaBudget === undefined) delete process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES;
  else process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES = originalGlamaBudget;
  if (originalGlamaKey === undefined) delete process.env.GLAMA_API_KEY;
  else process.env.GLAMA_API_KEY = originalGlamaKey;
  rmSync(dir, { recursive: true, force: true });
}

console.log('snapshot quality checks passed');
