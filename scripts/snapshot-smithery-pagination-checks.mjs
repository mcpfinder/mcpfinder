import assert from 'node:assert/strict';
import { join } from 'node:path';

const PAGE_SIZE = 100;
const runtime = (fetchImpl, now = () => 0, sleep = async () => {}) => ({ fetchImpl, now, sleep });

const smitheryEntry = (qualifiedName) => ({
  qualifiedName,
  displayName: qualifiedName,
  description: '',
  useCount: 0,
  verified: false,
  remote: false,
  isDeployed: false,
  iconUrl: null,
  homepage: null,
  createdAt: '2026-01-01T00:00:00Z',
});

const officialEntry = (name) => ({
  server: { name, version: '1.0.0', description: 'official baseline' },
});

const payload = (currentPage, servers, totalPages, totalCount) => ({
  servers,
  pagination: { currentPage, pageSize: PAGE_SIZE, totalPages, totalCount },
});

// Collects stderr without echoing it, so per-duplicate skip lines stay out of
// the test output.
async function captureStderr(fn) {
  const originalWrite = process.stderr.write;
  let stderr = '';
  process.stderr.write = (chunk, ...rest) => {
    stderr += String(chunk);
    const callback = rest.find((arg) => typeof arg === 'function');
    if (callback) callback();
    return true;
  };
  try {
    return { result: await fn(), stderr };
  } finally {
    process.stderr.write = originalWrite;
  }
}

function syncLog(db) {
  return db
    .prepare("SELECT server_count, status, error FROM sync_log WHERE source = 'smithery'")
    .get();
}

export async function runSnapshotSmitheryPaginationChecks(dir) {
  const { initDatabase, syncOfficialRegistry, syncSmitheryRegistry } =
    await import('../packages/core/dist/index.js');

  // A short page is only a candidate terminal. An empty probe confirms it even
  // when concurrently drifting telemetry still advertises additional pages.
  const shortTerminalDb = initDatabase(join(dir, 'smithery-short-terminal.sqlite'));
  let shortTerminalCalls = 0;
  assert.equal(
    await syncSmitheryRegistry(shortTerminalDb, runtime(async () => {
      shortTerminalCalls++;
      return Response.json(shortTerminalCalls === 1
        ? payload(1, [smitheryEntry('smithery/short')], 2, 101)
        : payload(2, [], 2, 101));
    })),
    1,
  );
  assert.equal(shortTerminalCalls, 2);
  assert.equal(syncLog(shortTerminalDb).status, 'ok');
  shortTerminalDb.close();

  const shortGapDb = initDatabase(join(dir, 'smithery-short-gap.sqlite'));
  let shortGapCalls = 0;
  await syncSmitheryRegistry(shortGapDb, runtime(async () => {
    shortGapCalls++;
    return Response.json(payload(
      shortGapCalls,
      [smitheryEntry(`smithery/gap-${shortGapCalls}`)],
      2,
      101,
    ));
  }));
  assert.equal(shortGapCalls, 2);
  assert.equal(syncLog(shortGapDb).status, 'error');
  assert.match(syncLog(shortGapDb).error, /followed a short page/);
  assert.equal(shortGapDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 0);
  shortGapDb.close();

  const intraDuplicateDb = initDatabase(join(dir, 'smithery-intra-duplicate.sqlite'));
  let intraDuplicateCalls = 0;
  await syncSmitheryRegistry(intraDuplicateDb, runtime(async () => {
    intraDuplicateCalls++;
    return Response.json(payload(1, [
      smitheryEntry('smithery/intra-duplicate'),
      smitheryEntry('smithery/intra-duplicate'),
    ], 1, 2));
  }));
  assert.equal(intraDuplicateCalls, 1);
  assert.equal(syncLog(intraDuplicateDb).status, 'error');
  assert.match(syncLog(intraDuplicateDb).error, /duplicate qualifiedName/);
  assert.equal(intraDuplicateDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 0);
  intraDuplicateDb.close();

  const missingNameDb = initDatabase(join(dir, 'smithery-missing-qualified-name.sqlite'));
  await syncSmitheryRegistry(missingNameDb, runtime(async () => Response.json(payload(
    1,
    [{ ...smitheryEntry('discarded'), qualifiedName: undefined }],
    1,
    1,
  ))));
  assert.equal(syncLog(missingNameDb).status, 'error');
  assert.match(syncLog(missingNameDb).error, /qualifiedName must be a non-empty string/);
  assert.doesNotMatch(syncLog(missingNameDb).error, /duplicate.*undefined/);
  assert.equal(missingNameDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 0);
  missingNameDb.close();

  const transientDuplicateDb = initDatabase(join(dir, 'smithery-transient-duplicate.sqlite'));
  await syncOfficialRegistry(transientDuplicateDb, runtime(async () => Response.json({
    servers: [officialEntry('ai.smithery/abandoned-only')],
    metadata: { count: 1 },
  })));
  let transientAttempt = 0;
  let transientCalls = 0;
  const { result: transientCount } =
    await captureStderr(() => syncSmitheryRegistry(transientDuplicateDb, runtime(async (requestUrl) => {
      transientCalls++;
      const page = Number(new URL(requestUrl).searchParams.get('page'));
      if (page === 1) transientAttempt++;
      if (page === 1) {
        const servers = transientAttempt === 1
          ? [
              smitheryEntry('abandoned/only'),
              ...Array.from({ length: PAGE_SIZE - 1 }, (_, index) =>
                smitheryEntry(`smithery/abandoned-${index}`)),
            ]
          : Array.from({ length: PAGE_SIZE }, (_, index) =>
              smitheryEntry(`smithery/transient-${index}`));
        return Response.json(payload(1, servers, 2, 101));
      }
      if (page === 2) {
        // Attempt 1 repeats all of page 1, past the skipped-duplicate cap.
        const servers = transientAttempt === 1
          ? [
              smitheryEntry('abandoned/only'),
              ...Array.from({ length: PAGE_SIZE - 1 }, (_, index) =>
                smitheryEntry(`smithery/abandoned-${index}`)),
            ]
          : [smitheryEntry('smithery/transient-100')];
        return Response.json(payload(2, servers, 2, 101));
      }
      return Response.json(payload(3, [], 2, 101));
    })));
  assert.equal(transientCount, 101);
  assert.equal(transientAttempt, 2);
  assert.equal(transientCalls, 5);
  assert.equal(syncLog(transientDuplicateDb).status, 'ok');
  assert.equal(syncLog(transientDuplicateDb).server_count, 101);
  assert.equal(transientDuplicateDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 102);
  const untouchedOfficial = transientDuplicateDb
    .prepare("SELECT sources, raw_data FROM servers WHERE id = 'ai.smithery/abandoned-only'")
    .get();
  assert.deepEqual(JSON.parse(untouchedOfficial.sources), ['official']);
  assert.doesNotMatch(untouchedOfficial.raw_data, /abandoned\/only/);
  assert.equal(
    transientDuplicateDb
      .prepare("SELECT COUNT(*) AS count FROM servers WHERE id = 'smithery:abandoned/only'")
      .get().count,
    0,
  );
  assert.equal(
    transientDuplicateDb
      .prepare(
        `SELECT COUNT(*) AS count FROM servers
         WHERE raw_data LIKE '%"qualifiedName":"smithery/abandoned-%'`,
      )
      .get().count,
    0,
  );
  transientDuplicateDb.close();

  const restartBudget = process.env.MCPFINDER_SMITHERY_SYNC_BUDGET_MINUTES;
  const originalRestartBase = process.env.MCPFINDER_CRAWL_RESTART_BASE_MS;
  delete process.env.MCPFINDER_SMITHERY_SYNC_BUDGET_MINUTES;
  delete process.env.MCPFINDER_CRAWL_RESTART_BASE_MS;
  try {
  // The upstream persistently repeats a qualifiedName on a later page (the
  // 2026-10 rajabohemia94729/fdfd builds). The later copy is skipped and
  // logged; a page of nothing but skipped duplicates is not the terminal.
  const persistentDuplicateDb = initDatabase(join(dir, 'smithery-persistent-duplicate.sqlite'));
  let persistentDuplicateCalls = 0;
  const persistentRestartSleeps = [];
  const { result: persistentDuplicateCount, stderr: persistentDuplicateStderr } =
    await captureStderr(() => syncSmitheryRegistry(persistentDuplicateDb, runtime(async (requestUrl) => {
      persistentDuplicateCalls++;
      const page = Number(new URL(requestUrl).searchParams.get('page'));
      if (page === 1) {
        return Response.json(payload(1, Array.from({ length: PAGE_SIZE }, (_, index) =>
          smitheryEntry(`smithery/persistent-${index}`)), 2, 101));
      }
      if (page === 2) {
        return Response.json(payload(2, [smitheryEntry('smithery/persistent-0')], 2, 101));
      }
      return Response.json(payload(3, [], 2, 101));
    }, () => 1_772_000_000_123, async (ms) => {
      if (ms > 100) persistentRestartSleeps.push(ms);
    })));
  assert.equal(persistentDuplicateCount, PAGE_SIZE);
  assert.equal(persistentDuplicateCalls, 3);
  assert.deepEqual(persistentRestartSleeps, []);
  assert.equal(syncLog(persistentDuplicateDb).status, 'ok');
  assert.equal(syncLog(persistentDuplicateDb).server_count, PAGE_SIZE);
  assert.match(
    persistentDuplicateStderr,
    /Smithery API: skipping cross-page duplicate qualifiedName smithery\/persistent-0 \(page 2\)/,
  );
  assert.match(persistentDuplicateStderr, /Smithery crawl: skipped 1 cross-page duplicate\(s\)/);
  assert.equal(
    persistentDuplicateDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count,
    PAGE_SIZE,
  );
  persistentDuplicateDb.close();

  // First occurrence wins, and a full raw page with skipped duplicates is
  // still a full page: the crawl continues instead of treating it as short.
  const firstWinsDb = initDatabase(join(dir, 'smithery-duplicate-first-wins.sqlite'));
  let firstWinsCalls = 0;
  const { result: firstWinsCount, stderr: firstWinsStderr } =
    await captureStderr(() => syncSmitheryRegistry(firstWinsDb, runtime(async (requestUrl) => {
      firstWinsCalls++;
      const page = Number(new URL(requestUrl).searchParams.get('page'));
      if (page === 1) {
        return Response.json(payload(1, [
          { ...smitheryEntry('dup/first-wins'), description: 'first occurrence' },
          ...Array.from({ length: PAGE_SIZE - 1 }, (_, index) =>
            smitheryEntry(`smithery/first-wins-1-${index}`)),
        ], 3, 201));
      }
      if (page === 2) {
        return Response.json(payload(2, [
          { ...smitheryEntry('dup/first-wins'), description: 'later occurrence' },
          smitheryEntry('smithery/first-wins-1-0'),
          smitheryEntry('smithery/first-wins-1-1'),
          ...Array.from({ length: PAGE_SIZE - 3 }, (_, index) =>
            smitheryEntry(`smithery/first-wins-2-${index}`)),
        ], 3, 201));
      }
      if (page === 3) {
        return Response.json(payload(3, [smitheryEntry('smithery/first-wins-last')], 3, 201));
      }
      return Response.json(payload(4, [], 3, 201));
    })));
  assert.equal(firstWinsCalls, 4);
  assert.equal(firstWinsCount, PAGE_SIZE + (PAGE_SIZE - 3) + 1);
  assert.equal(syncLog(firstWinsDb).status, 'ok');
  assert.equal(
    (firstWinsStderr.match(/skipping cross-page duplicate qualifiedName/g) ?? []).length,
    3,
  );
  assert.match(firstWinsStderr, /Smithery crawl: skipped 3 cross-page duplicate\(s\)/);
  const firstWins = firstWinsDb
    .prepare("SELECT description, raw_data FROM servers WHERE id = 'smithery:dup/first-wins'")
    .get();
  assert.equal(firstWins.description, 'first occurrence');
  assert.doesNotMatch(firstWins.raw_data, /later occurrence/);
  assert.equal(
    firstWinsDb.prepare("SELECT COUNT(*) AS count FROM servers WHERE id LIKE 'smithery:%'").get().count,
    firstWinsCount,
  );
  firstWinsDb.close();

  // Past the skipped-duplicate cap, pagination is looping or drifting: every
  // attempt fails, the restart ladder runs out and nothing is applied.
  const duplicateCapDb = initDatabase(join(dir, 'smithery-duplicate-cap.sqlite'));
  let duplicateCapCalls = 0;
  const duplicateCapSleeps = [];
  await captureStderr(() => syncSmitheryRegistry(duplicateCapDb, runtime(async (requestUrl) => {
    duplicateCapCalls++;
    const page = Number(new URL(requestUrl).searchParams.get('page'));
    return Response.json(payload(page, Array.from({ length: PAGE_SIZE }, (_, index) =>
      smitheryEntry(`smithery/looping-${index}`)), 3, 300));
  }, () => 1_772_000_000_123, async (ms) => {
    if (ms > 100) duplicateCapSleeps.push(ms);
  })));
  assert.equal(duplicateCapCalls, 8);
  assert.deepEqual(duplicateCapSleeps, [500, 1_000, 2_000]);
  assert.equal(syncLog(duplicateCapDb).status, 'error');
  assert.equal(syncLog(duplicateCapDb).server_count, 0);
  assert.match(syncLog(duplicateCapDb).error, /cross-page duplicate .* exceeds 25 skipped duplicates/);
  assert.equal(duplicateCapDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 0);
  duplicateCapDb.close();

  // Page 1 is full; pages 2 and 3 repeat `duplicates` of its names (10 on
  // page 2, the rest on page 3) next to fresh ones, then the empty terminal.
  const spreadDuplicatePage = (prefix, duplicates, page) => {
    const first = Array.from({ length: PAGE_SIZE }, (_, index) => `${prefix}/a-${index}`);
    const onPage2 = Math.min(duplicates, 10);
    if (page === 1) return payload(1, first.map(smitheryEntry), 3, 300);
    if (page === 2) {
      return payload(2, [
        ...first.slice(0, onPage2),
        ...Array.from({ length: PAGE_SIZE - onPage2 }, (_, index) => `${prefix}/b-${index}`),
      ].map(smitheryEntry), 3, 300);
    }
    if (page === 3) {
      return payload(3, [...first.slice(onPage2, duplicates), `${prefix}/c-0`].map(smitheryEntry), 3, 300);
    }
    return payload(page, [], 3, 300);
  };

  // Exactly the cap, spread across pages, is still a validated crawl.
  const atCapDb = initDatabase(join(dir, 'smithery-duplicate-at-cap.sqlite'));
  let atCapCalls = 0;
  const atCapSleeps = [];
  const { result: atCapCount, stderr: atCapStderr } =
    await captureStderr(() => syncSmitheryRegistry(atCapDb, runtime(async (requestUrl) => {
      atCapCalls++;
      return Response.json(spreadDuplicatePage(
        'at-cap', 25, Number(new URL(requestUrl).searchParams.get('page')),
      ));
    }, () => 1_772_000_000_123, async (ms) => {
      if (ms > 100) atCapSleeps.push(ms);
    })));
  assert.equal(atCapCalls, 4);
  assert.deepEqual(atCapSleeps, []);
  assert.equal(atCapCount, PAGE_SIZE + (PAGE_SIZE - 10) + 1);
  assert.equal(syncLog(atCapDb).status, 'ok');
  assert.equal(
    (atCapStderr.match(/skipping cross-page duplicate qualifiedName/g) ?? []).length,
    25,
  );
  assert.match(atCapStderr, /Smithery crawl: skipped 25 cross-page duplicate\(s\)/);
  atCapDb.close();

  // One past the cap fails every attempt and exhausts the restart ladder.
  const overCapDb = initDatabase(join(dir, 'smithery-duplicate-over-cap.sqlite'));
  let overCapCalls = 0;
  const overCapSleeps = [];
  const { stderr: overCapStderr } =
    await captureStderr(() => syncSmitheryRegistry(overCapDb, runtime(async (requestUrl) => {
      overCapCalls++;
      return Response.json(spreadDuplicatePage(
        'over-cap', 26, Number(new URL(requestUrl).searchParams.get('page')),
      ));
    }, () => 1_772_000_000_123, async (ms) => {
      if (ms > 100) overCapSleeps.push(ms);
    })));
  assert.equal(overCapCalls, 12);
  assert.deepEqual(overCapSleeps, [500, 1_000, 2_000]);
  assert.equal(syncLog(overCapDb).status, 'error');
  assert.equal(syncLog(overCapDb).server_count, 0);
  assert.match(
    syncLog(overCapDb).error,
    /cross-page duplicate qualifiedName over-cap\/a-25 \(page 3\) exceeds 25 skipped duplicates/,
  );
  assert.doesNotMatch(overCapStderr, /Smithery crawl: skipped/);
  assert.equal(overCapDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 0);
  overCapDb.close();

  // The skip counter is per attempt: attempt 1 exceeds the cap, attempt 2
  // repeats only a few names and must not inherit attempt 1's count.
  const counterResetDb = initDatabase(join(dir, 'smithery-duplicate-counter-reset.sqlite'));
  let counterResetAttempt = 0;
  let counterResetCalls = 0;
  const counterResetSleeps = [];
  const { result: counterResetCount, stderr: counterResetStderr } =
    await captureStderr(() => syncSmitheryRegistry(counterResetDb, runtime(async (requestUrl) => {
      counterResetCalls++;
      const page = Number(new URL(requestUrl).searchParams.get('page'));
      if (page === 1) counterResetAttempt++;
      return Response.json(spreadDuplicatePage(
        'counter-reset', counterResetAttempt === 1 ? 26 : 3, page,
      ));
    }, () => 1_772_000_000_123, async (ms) => {
      if (ms > 100) counterResetSleeps.push(ms);
    })));
  assert.equal(counterResetAttempt, 2);
  assert.equal(counterResetCalls, 3 + 4);
  assert.deepEqual(counterResetSleeps, [500]);
  assert.equal(counterResetCount, PAGE_SIZE + (PAGE_SIZE - 3) + 1);
  assert.equal(syncLog(counterResetDb).status, 'ok');
  assert.equal(syncLog(counterResetDb).server_count, counterResetCount);
  assert.equal(
    (counterResetStderr.match(/Smithery crawl: skipped \d+ cross-page duplicate\(s\)/g) ?? []).length,
    1,
  );
  assert.match(counterResetStderr, /Smithery crawl: skipped 3 cross-page duplicate\(s\)/);
  counterResetDb.close();

  // Persistent HTTP 502 on page 1 restarts the whole crawl four times.
  const persistent502Db = initDatabase(join(dir, 'smithery-persistent-502.sqlite'));
  let persistent502Calls = 0;
  await syncSmitheryRegistry(persistent502Db, runtime(async () => {
    persistent502Calls++;
    return new Response('bad gateway', { status: 502 });
  }));
  assert.equal(persistent502Calls, 16);
  assert.equal(syncLog(persistent502Db).status, 'error');
  assert.equal(syncLog(persistent502Db).server_count, 0);
  assert.match(syncLog(persistent502Db).error, /HTTP 502|giving up after/);
  assert.doesNotMatch(syncLog(persistent502Db).error, /exceeded its .* budget/);
  assert.equal(
    persistent502Db.prepare('SELECT COUNT(*) AS count FROM servers').get().count,
    0,
  );
  persistent502Db.close();

  // 429 is retried at page level (4 fetches) and must not restart the crawl.
  const tooManyDb = initDatabase(join(dir, 'smithery-429.sqlite'));
  let tooManyCalls = 0;
  await syncSmitheryRegistry(tooManyDb, runtime(async () => {
    tooManyCalls++;
    return new Response('too many requests', { status: 429 });
  }));
  assert.equal(tooManyCalls, 4);
  assert.equal(syncLog(tooManyDb).status, 'error');
  assert.match(syncLog(tooManyDb).error, /HTTP 429/);
  tooManyDb.close();

  // 502 on the first two crawls, then a validated catalogue on the third.
  // CI ladder so restart waits do not overlap page-level retry delays.
  process.env.MCPFINDER_CRAWL_RESTART_BASE_MS = '15000';
  const recovered502Db = initDatabase(join(dir, 'smithery-recovered-502.sqlite'));
  const recovered502Sleeps = [];
  let recovered502Page = 0;
  assert.equal(
    await syncSmitheryRegistry(recovered502Db, {
      now: () => 1_772_000_000_123,
      sleep: async (ms) => { if (ms >= 15_000) recovered502Sleeps.push(ms); },
      fetchImpl: async (requestUrl) => {
        if (recovered502Sleeps.length < 2) return new Response('bad gateway', { status: 502 });
        recovered502Page++;
        const page = Number(new URL(requestUrl).searchParams.get('page'));
        return Response.json(page === 1
          ? payload(1, [smitheryEntry('smithery/recovered-502')], 1, 1)
          : payload(2, [], 1, 1));
      },
    }),
    1,
  );
  assert.equal(recovered502Page, 2);
  assert.deepEqual(recovered502Sleeps, [15_000, 30_000]);
  assert.equal(syncLog(recovered502Db).status, 'ok');
  assert.ok(syncLog(recovered502Db).server_count > 0);
  recovered502Db.close();
  delete process.env.MCPFINDER_CRAWL_RESTART_BASE_MS;

  // Two consecutive duplicate attempts cost the 2026-08-26 20:02 build its
  // whole publication cycle; the third attempt is what turns that into a
  // recovered crawl. Unset env is the local stdio ladder (500 ms, then 1 s)
  // rather than hammering the same degraded upstream twice in 250 ms.
  // The clock is deliberately not zero: the ladder must not depend on wall
  // time, and `now: () => 0` would pass even if it did.
  const thirdAttemptDb = initDatabase(join(dir, 'smithery-third-attempt.sqlite'));
  let thirdAttempt = 0;
  let thirdAttemptCalls = 0;
  const restartSleeps = [];
  const { result: thirdAttemptCount } =
    await captureStderr(() => syncSmitheryRegistry(thirdAttemptDb, {
      now: () => 1_772_000_000_123,
      sleep: async (ms) => { if (ms > 100) restartSleeps.push(ms); },
      fetchImpl: async (requestUrl) => {
        thirdAttemptCalls++;
        const page = Number(new URL(requestUrl).searchParams.get('page'));
        if (page === 1) {
          thirdAttempt++;
          return Response.json(payload(1, Array.from({ length: PAGE_SIZE }, (_, index) =>
            smitheryEntry(`smithery/third-${index}`)), 2, 101));
        }
        if (page === 2) {
          // Attempts 1 and 2 repeat all of page 1, past the skipped-duplicate cap.
          return Response.json(payload(2, thirdAttempt < 3
            ? Array.from({ length: PAGE_SIZE }, (_, index) =>
                smitheryEntry(`smithery/third-${index}`))
            : [smitheryEntry('smithery/third-100')], 2, 101));
        }
        return Response.json(payload(3, [], 2, 101));
      },
    }));
  assert.equal(thirdAttemptCount, 101);
  assert.equal(thirdAttempt, 3);
  assert.equal(thirdAttemptCalls, 7);
  assert.deepEqual(restartSleeps, [500, 1_000]);
  assert.equal(syncLog(thirdAttemptDb).status, 'ok');
  assert.equal(syncLog(thirdAttemptDb).server_count, 101);
  assert.equal(
    thirdAttemptDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count,
    101,
  );
  assert.equal(
    thirdAttemptDb
      .prepare("SELECT COUNT(*) AS count FROM servers WHERE id = 'smithery:smithery/third-100'")
      .get().count,
    1,
  );
  thirdAttemptDb.close();

  // A 60 s CI-ladder wait that would miss a 1-minute deadline must keep the
  // original 502, not rewrite it as a budget overrun. now() is pinned at 0 so
  // deadline is exactly 60 s: 15 s and 30 s fit, 60 s does not.
  process.env.MCPFINDER_CRAWL_RESTART_BASE_MS = '15000';
  process.env.MCPFINDER_SMITHERY_SYNC_BUDGET_MINUTES = '1';
  const skippedWaitDb = initDatabase(join(dir, 'smithery-skipped-restart-wait.sqlite'));
  let skippedWaitCalls = 0;
  const skippedWaitSleeps = [];
  await syncSmitheryRegistry(skippedWaitDb, {
    now: () => 0,
    sleep: async (ms) => { if (ms >= 15_000) skippedWaitSleeps.push(ms); },
    fetchImpl: async () => {
      skippedWaitCalls++;
      return new Response('bad gateway', { status: 502 });
    },
  });
  assert.equal(skippedWaitCalls, 12);
  assert.deepEqual(skippedWaitSleeps, [15_000, 30_000]);
  assert.equal(syncLog(skippedWaitDb).status, 'error');
  assert.equal(syncLog(skippedWaitDb).server_count, 0);
  assert.match(syncLog(skippedWaitDb).error, /HTTP 502|giving up after/);
  assert.doesNotMatch(syncLog(skippedWaitDb).error, /exceeded its .* budget/);
  skippedWaitDb.close();
  delete process.env.MCPFINDER_CRAWL_RESTART_BASE_MS;
  delete process.env.MCPFINDER_SMITHERY_SYNC_BUDGET_MINUTES;
  } finally {
  if (restartBudget === undefined) delete process.env.MCPFINDER_SMITHERY_SYNC_BUDGET_MINUTES;
  else process.env.MCPFINDER_SMITHERY_SYNC_BUDGET_MINUTES = restartBudget;
  if (originalRestartBase === undefined) delete process.env.MCPFINDER_CRAWL_RESTART_BASE_MS;
  else process.env.MCPFINDER_CRAWL_RESTART_BASE_MS = originalRestartBase;
  }

  const stableIdDb = initDatabase(join(dir, 'smithery-stable-id-priority.sqlite'));
  const repoA = 'https://github.com/acme/smithery-original';
  const repoB = 'https://github.com/acme/smithery-changed';
  let stablePage = 0;
  await syncSmitheryRegistry(stableIdDb, runtime(async () => {
    stablePage++;
    return Response.json(stablePage === 1
      ? payload(1, [{ ...smitheryEntry('stable/item'), homepage: repoA,
          description: 'old smithery term', useCount: 50, verified: true,
          iconUrl: 'https://example.com/old-stable-icon.png' }], 1, 1)
      : payload(2, [], 1, 1));
  }));
  await syncOfficialRegistry(stableIdDb, runtime(async () => Response.json({
    servers: [{ server: { name: 'other-smithery', version: '1.0.0', description: '',
      repository: { url: repoB, source: 'github' } } }], metadata: { count: 1 },
  })));
  stablePage = 0;
  await syncSmitheryRegistry(stableIdDb, runtime(async () => {
    stablePage++;
    return Response.json(stablePage === 1
      ? payload(1, [{ ...smitheryEntry('stable/item'), homepage: repoB,
          description: 'fresh smithery term', useCount: 3, verified: false,
          iconUrl: null }], 1, 1)
      : payload(2, [], 1, 1));
  }));
  const stable = stableIdDb
    .prepare("SELECT raw_data, keywords, repository_url, repository_source, " +
      "use_count, verified, icon_url " +
      "FROM servers WHERE id = 'smithery:stable/item'").get();
  assert.match(stable.raw_data, /fresh smithery term/);
  assert.ok(JSON.parse(stable.keywords).includes('fresh'));
  assert.ok(!JSON.parse(stable.keywords).includes('old'));
  assert.equal(stable.repository_url, repoB);
  assert.equal(stable.repository_source, 'github');
  assert.equal(stable.use_count, 3);
  assert.equal(stable.verified, 0);
  assert.equal(stable.icon_url, null);
  assert.deepEqual(JSON.parse(
    stableIdDb.prepare("SELECT sources FROM servers WHERE id = 'other-smithery'").get().sources,
  ), ['official']);
  stablePage = 0;
  await syncSmitheryRegistry(stableIdDb, runtime(async () => {
    stablePage++;
    return Response.json(stablePage === 1
      ? payload(1, [{ ...smitheryEntry('stable/item'), homepage: null,
          description: 'repository removed' }], 1, 1)
      : payload(2, [], 1, 1));
  }));
  const withoutRepository = stableIdDb.prepare(
    "SELECT repository_url, repository_source FROM servers WHERE id = 'smithery:stable/item'",
  ).get();
  assert.equal(withoutRepository.repository_url, null);
  assert.equal(withoutRepository.repository_source, null);
  stableIdDb.close();

  const driftDb = initDatabase(join(dir, 'smithery-count-drift.sqlite'));
  let driftPage = 0;
  assert.equal(
    await syncSmitheryRegistry(driftDb, runtime(async () => {
      driftPage++;
      const start = (driftPage - 1) * PAGE_SIZE;
      if (driftPage === 4) return Response.json(payload(4, [], 3, 201));
      const length = driftPage < 3 ? PAGE_SIZE : 1;
      return Response.json(payload(
        driftPage,
        Array.from({ length }, (_, index) => smitheryEntry(`smithery/drift-${start + index}`)),
        driftPage === 1 ? 2 : 3,
        driftPage === 1 ? 200 : 201,
      ));
    })),
    201,
  );
  assert.equal(driftPage, 4);
  assert.equal(syncLog(driftDb).status, 'ok');
  driftDb.close();

  // A catalogue shrink can move the probe several pages beyond current
  // telemetry; an empty response is still an unambiguous terminal.
  const shrinkDb = initDatabase(join(dir, 'smithery-count-shrink.sqlite'));
  let shrinkPage = 0;
  assert.equal(
    await syncSmitheryRegistry(shrinkDb, runtime(async () => {
      shrinkPage++;
      return Response.json(shrinkPage < 3
        ? payload(shrinkPage, Array.from({ length: PAGE_SIZE }, (_, index) =>
            smitheryEntry(`smithery/shrink-${shrinkPage}-${index}`)), 3, 300)
        : payload(3, [], 1, 100));
    })),
    200,
  );
  assert.equal(shrinkPage, 3);
  assert.equal(syncLog(shrinkDb).status, 'ok');
  shrinkDb.close();

  const zeroMathDb = initDatabase(join(dir, 'smithery-zero-math.sqlite'));
  await syncSmitheryRegistry(zeroMathDb, runtime(async () =>
    Response.json({
      servers: [],
      pagination: { currentPage: 1, pageSize: 0, totalPages: 1, totalCount: 0 },
    })));
  assert.equal(syncLog(zeroMathDb).status, 'ok');
  assert.equal(syncLog(zeroMathDb).server_count, 0);
  zeroMathDb.close();

  const advisoryDb = initDatabase(join(dir, 'smithery-advisory-pagination.sqlite'));
  let advisoryPage = 0;
  assert.equal(
    await syncSmitheryRegistry(advisoryDb, runtime(async () => {
      advisoryPage++;
      const servers = advisoryPage === 1
        ? Array.from({ length: PAGE_SIZE }, (_, index) =>
            smitheryEntry(`smithery/advisory-${index}`))
        : advisoryPage === 2 ? [smitheryEntry('smithery/advisory-last')] : [];
      return Response.json({
        servers,
        pagination: {
          currentPage: advisoryPage,
          pageSize: advisoryPage === 1 ? 37 : 0,
          totalPages: 0,
          totalCount: advisoryPage === 1 ? 1 : 9999,
        },
      });
    })),
    101,
  );
  assert.equal(advisoryPage, 3);
  assert.equal(syncLog(advisoryDb).status, 'ok');
  advisoryDb.close();

  const oversizedDb = initDatabase(join(dir, 'smithery-oversized-page.sqlite'));
  await syncSmitheryRegistry(oversizedDb, runtime(async () => Response.json(payload(
    1,
    Array.from({ length: PAGE_SIZE + 1 }, (_, index) =>
      smitheryEntry(`smithery/oversized-${index}`)),
    2,
    PAGE_SIZE + 1,
  ))));
  assert.equal(syncLog(oversizedDb).status, 'error');
  assert.match(syncLog(oversizedDb).error, /exceeds requested page limit/);
  assert.equal(oversizedDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 0);
  oversizedDb.close();

  const loopDb = initDatabase(join(dir, 'smithery-page-loop.sqlite'));
  let loopCalls = 0;
  await syncSmitheryRegistry(loopDb, runtime(async () => {
    loopCalls++;
    return Response.json(payload(1, Array.from({ length: PAGE_SIZE }, (_, index) =>
      smitheryEntry(`smithery/loop-${loopCalls}-${index}`)), 2, 200));
  }));
  assert.equal(loopCalls, 2);
  assert.equal(syncLog(loopDb).status, 'error');
  assert.match(syncLog(loopDb).error, /currentPage 1 does not match 2/);
  loopDb.close();

  const noTerminalDb = initDatabase(join(dir, 'smithery-no-terminal.sqlite'));
  let clock = 0;
  await syncSmitheryRegistry(noTerminalDb, {
    now: () => clock,
    sleep: async () => { clock = 5 * 60_000; },
    fetchImpl: async () => Response.json(payload(1, Array.from({ length: PAGE_SIZE }, (_, index) =>
      smitheryEntry(`smithery/no-terminal-${index}`)), 1, 100)),
  });
  assert.equal(syncLog(noTerminalDb).status, 'error');
  assert.match(syncLog(noTerminalDb).error, /exceeded its 5-minute budget/);
  assert.match(syncLog(noTerminalDb).error, /discarded 100 staged servers/);
  assert.match(syncLog(noTerminalDb).error, /last-known-good database unchanged/);
  assert.equal(syncLog(noTerminalDb).server_count, 0);
  assert.equal(noTerminalDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 0);
  noTerminalDb.close();

  const applyDeadlineDb = initDatabase(join(dir, 'smithery-apply-deadline.sqlite'));
  await syncOfficialRegistry(applyDeadlineDb, runtime(async () => Response.json({
    servers: [{ server: { name: 'smithery-lkg', version: '1.0.0', description: 'unchanged' } }],
    metadata: { count: 1 },
  })));
  let applyClock = 0;
  const applyEntry = smitheryEntry('smithery/apply-deadline');
  await syncSmitheryRegistry(applyDeadlineDb, {
    now: () => applyClock,
    sleep: async () => {},
    fetchImpl: async (requestUrl) => {
      const currentPage = Number(new URL(requestUrl).searchParams.get('page'));
      // The crawl itself stages within budget; the clock crosses the deadline
      // only once the terminal probe has been served, so the failure lands on
      // the apply-time deadline check rather than on the crawl budget.
      if (currentPage > 1) applyClock = 5 * 60_000;
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => currentPage === 1
          ? payload(1, [applyEntry], 1, 1)
          : payload(2, [], 1, 1),
      };
    },
  });
  assert.equal(syncLog(applyDeadlineDb).status, 'error');
  assert.match(syncLog(applyDeadlineDb).error, /deadline exceeded/);
  assert.equal(applyDeadlineDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 1);
  assert.deepEqual(JSON.parse(applyDeadlineDb.prepare('SELECT sources FROM servers').get().sources), ['official']);
  applyDeadlineDb.close();

  // MCPFINDER_SMITHERY_SYNC_BUDGET_MINUTES overrides the wall-clock budget the
  // crawl above spends its attempts inside, so its parsing lives next to the
  // crawl it bounds. Four attempts do not fit in the default five minutes, so
  // batch builds raise it explicitly.
  const originalBudget = process.env.MCPFINDER_SMITHERY_SYNC_BUDGET_MINUTES;
  const originalRestartBaseEnv = process.env.MCPFINDER_CRAWL_RESTART_BASE_MS;
  const smitheryEmpty = payload(1, [], 0, 0);
  try {
    process.env.MCPFINDER_SMITHERY_SYNC_BUDGET_MINUTES = '12';
    const overrideDb = initDatabase(join(dir, 'smithery-override-budget.sqlite'));
    let overrideCalls = 0;
    const overrideTimes = [0, 8 * 60_000];
    await syncSmitheryRegistry(
      overrideDb,
      runtime(async () => {
        overrideCalls++;
        return Response.json(smitheryEmpty);
      }, () => overrideTimes[Math.min(overrideCalls, overrideTimes.length - 1)]),
    );
    assert.equal(overrideCalls, 1);
    assert.equal(syncLog(overrideDb).status, 'ok');
    overrideDb.close();

    process.env.MCPFINDER_SMITHERY_SYNC_BUDGET_MINUTES = '16';
    const outOfRangeDb = initDatabase(join(dir, 'smithery-out-of-range-budget.sqlite'));
    assert.equal(
      await syncSmitheryRegistry(
        outOfRangeDb,
        runtime(async () => Response.json(smitheryEmpty)),
      ),
      0,
    );
    assert.equal(syncLog(outOfRangeDb).status, 'error');
    assert.match(syncLog(outOfRangeDb).error, /integer between 1 and 15/);
    outOfRangeDb.close();

    process.env.MCPFINDER_SMITHERY_SYNC_BUDGET_MINUTES = 'twelve';
    const malformedDb = initDatabase(join(dir, 'smithery-malformed-budget.sqlite'));
    await syncSmitheryRegistry(
      malformedDb,
      runtime(async () => Response.json(smitheryEmpty)),
    );
    assert.equal(syncLog(malformedDb).status, 'error');
    assert.match(syncLog(malformedDb).error, /integer between 1 and 15/);
    malformedDb.close();

    // An unset budget falls back to the historical five minutes.
    delete process.env.MCPFINDER_SMITHERY_SYNC_BUDGET_MINUTES;
    const defaultBudgetDb = initDatabase(join(dir, 'smithery-default-budget.sqlite'));
    let defaultClock = 0;
    await syncSmitheryRegistry(defaultBudgetDb, {
      now: () => defaultClock,
      sleep: async () => { defaultClock = 5 * 60_000; },
      fetchImpl: async () => Response.json(
        payload(1, [smitheryEntry('smithery/default-budget')], 2, 101),
      ),
    });
    assert.match(syncLog(defaultBudgetDb).error, /exceeded its 5-minute budget/);
    defaultBudgetDb.close();

    process.env.MCPFINDER_CRAWL_RESTART_BASE_MS = '60001';
    const restartHighDb = initDatabase(join(dir, 'smithery-restart-base-high.sqlite'));
    assert.equal(
      await syncSmitheryRegistry(
        restartHighDb,
        runtime(async () => Response.json(smitheryEmpty)),
      ),
      0,
    );
    assert.equal(syncLog(restartHighDb).status, 'error');
    assert.match(syncLog(restartHighDb).error, /integer between 100 and 60000/);
    restartHighDb.close();
  } finally {
    if (originalBudget === undefined) delete process.env.MCPFINDER_SMITHERY_SYNC_BUDGET_MINUTES;
    else process.env.MCPFINDER_SMITHERY_SYNC_BUDGET_MINUTES = originalBudget;
    if (originalRestartBaseEnv === undefined) delete process.env.MCPFINDER_CRAWL_RESTART_BASE_MS;
    else process.env.MCPFINDER_CRAWL_RESTART_BASE_MS = originalRestartBaseEnv;
  }
}
