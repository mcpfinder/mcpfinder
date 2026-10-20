import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { reportSyncResults } = await import('../packages/mcp-server/dist/sync-report.js');
const { settleSequentially } = await import(
  '../packages/mcp-server/dist/sync-orchestration.js'
);
const messages = [];
const error = new Error('official transport exploded');
const counts = reportSyncResults(
  [
    { status: 'rejected', reason: error },
    { status: 'fulfilled', value: 42 },
    { status: 'rejected', reason: { code: 'BAD_JSON', cursor: 'page-7' } },
  ],
  (message) => messages.push(message),
);

assert.deepEqual(counts, [0, 42, 0]);
assert.equal(messages.length, 2);
assert.match(messages[0], /Official sync rejected:/);
assert.match(messages[0], /Error: official transport exploded/);
assert.match(messages[0], /test-sync-reporting\.mjs/);
assert.match(messages[1], /Registry 3 sync rejected:/);
assert.match(messages[1], /BAD_JSON/);
assert.match(messages[1], /page-7/);

const order = [];
const sequential = await settleSequentially([
  async () => {
    order.push('official');
    return 10;
  },
  async () => {
    order.push('glama');
    throw new Error('glama unavailable');
  },
  async () => {
    order.push('third');
    return 30;
  },
]);
assert.deepEqual(order, ['official', 'glama', 'third']);
assert.deepEqual(sequential.map((result) => result.status), [
  'fulfilled',
  'rejected',
  'fulfilled',
]);
assert.equal(sequential[0].value, 10);
assert.match(sequential[1].reason.message, /glama unavailable/);
assert.equal(sequential[2].value, 30);

console.log('sync reporting checks passed');

// ─── Crawl / sync_log atomicity ─────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'mcpf-sync-atomicity-'));
// syncGlamaRegistry short-circuits before any request without a key.
process.env.GLAMA_API_KEY = 'test-key';
const { initDatabase, syncOfficialRegistry, syncGlamaRegistry } =
  await import('../packages/core/dist/index.js');

const runtime = (fetchImpl, now = () => 0) => ({ fetchImpl, now, sleep: async () => {} });

/**
 * Records the SQL actually issued, in order, so an assertion can prove the
 * sync_log row is written between the same BEGIN and COMMIT as the server
 * rows rather than after the commit.
 */
function recordingDb(db, sql) {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'exec') {
        return (text) => {
          sql.push(text);
          return target.exec(text);
        };
      }
      if (prop === 'prepare') {
        return (text) => {
          const stmt = target.prepare(text);
          return new Proxy(stmt, {
            get(statement, key) {
              const member = Reflect.get(statement, key);
              if (typeof member !== 'function') return member;
              return (...args) => {
                if (key === 'run') sql.push(text);
                return member.apply(statement, args);
              };
            },
          });
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * The statements between the BEGIN that opened the transaction holding
 * `index` and the COMMIT/ROLLBACK that closed it — null when that statement
 * ran outside any transaction at all.
 */
function enclosingTransaction(sql, index) {
  let begin = -1;
  for (let i = index; i >= 0; i--) {
    if (sql[i] === 'BEGIN') {
      begin = i;
      break;
    }
    if (sql[i] === 'COMMIT' || sql[i] === 'ROLLBACK') return null;
  }
  if (begin === -1) return null;
  let end = sql.length - 1;
  for (let i = index; i < sql.length; i++) {
    if (sql[i] === 'COMMIT' || sql[i] === 'ROLLBACK') {
      end = i;
      break;
    }
  }
  return sql.slice(begin, end + 1);
}

const serverCount = (db) => db.prepare('SELECT COUNT(*) AS n FROM servers').get().n;
const syncLogRow = (db, source) =>
  db
    .prepare(
      'SELECT server_count, status, error, last_successful_at FROM sync_log WHERE source = ?',
    )
    .get(source);

/**
 * A clock that trips the registry's wall-clock budget the moment the apply
 * loop has written its first row. The pre-apply deadline check therefore
 * passes and the one at the end of the apply transaction throws, aborting a
 * transaction that has already staged and applied entries.
 */
function clockTrippedByFirstRow(db) {
  return () => (serverCount(db) > 0 ? 60 * 60_000 : 0);
}

const officialEntry = (name) => ({
  server: { name, version: '1.0.0', description: `${name} description` },
});
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
const registries = [
  {
    source: 'official',
    sync: syncOfficialRegistry,
    fetchImpl: async () =>
      Response.json({
        servers: [officialEntry('io.example/one'), officialEntry('io.example/two')],
        metadata: { count: 2 },
      }),
  },
  {
    source: 'glama',
    sync: syncGlamaRegistry,
    fetchImpl: async () =>
      Response.json({
        servers: [glamaEntry('glama-one'), glamaEntry('glama-two')],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
  },
];

for (const { source, sync, fetchImpl } of registries) {
  // A clean crawl commits both the server rows and the sync_log row, in one
  // transaction: no COMMIT separates them.
  const clean = initDatabase(join(dir, `${source}-clean.sqlite`));
  const sql = [];
  assert.equal(await sync(recordingDb(clean, sql), runtime(fetchImpl)), 2, source);
  assert.equal(serverCount(clean), 2, source);
  const cleanLog = syncLogRow(clean, source);
  assert.equal(cleanLog.status, 'ok', source);
  assert.equal(cleanLog.server_count, 2, source);
  assert.equal(cleanLog.error, null, source);
  assert.equal(typeof cleanLog.last_successful_at, 'string', source);

  const logIndex = sql.findIndex((text) => text.includes('INSERT INTO sync_log'));
  assert.notEqual(logIndex, -1, `${source}: no sync_log write recorded`);
  const applyTransaction = enclosingTransaction(sql, logIndex);
  assert.ok(applyTransaction, `${source}: sync_log written outside any transaction`);
  assert.equal(applyTransaction.at(-1), 'COMMIT', `${source}: apply transaction did not commit`);
  assert.ok(
    applyTransaction.some((text) => text.includes('INSERT INTO servers')),
    `${source}: sync_log did not commit with the server rows it describes`,
  );

  // An apply that aborts leaves neither the server rows nor an 'ok' log row:
  // the only trace is the error row the catch writes after the rollback.
  const aborted = initDatabase(join(dir, `${source}-aborted.sqlite`));
  assert.equal(
    await sync(aborted, runtime(fetchImpl, clockTrippedByFirstRow(aborted))).then(
      (applied) => applied,
      () => 0,
    ),
    0,
    source,
  );
  assert.equal(serverCount(aborted), 0, `${source}: rolled-back server rows persisted`);
  const abortedLog = syncLogRow(aborted, source);
  assert.equal(abortedLog.status, 'error', source);
  assert.equal(abortedLog.server_count, 0, source);
  assert.equal(abortedLog.last_successful_at, null, `${source}: rolled-back crawl logged as ok`);
  assert.match(abortedLog.error, /registry deadline exceeded/, source);
}

rmSync(dir, { recursive: true, force: true });

console.log('sync atomicity checks passed');
