import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seedFlagsFromSnapshot } from './carry-over-flags.mjs';

const SCHEMA = `CREATE TABLE servers (
  id TEXT PRIMARY KEY, repository_url TEXT,
  archived_repo INTEGER, archived_repo_checked_at TEXT,
  deprecated_npm INTEGER, deprecated_npm_checked_at TEXT
)`;

const dir = mkdtempSync(join(tmpdir(), 'mcpf-carry-over-test-'));
let n = 0;

function run(prevRows, targetRows) {
  const prevPath = join(dir, `prev-${n++}.sqlite`);
  const prev = new DatabaseSync(prevPath);
  prev.exec(SCHEMA);
  const ins = prev.prepare('INSERT INTO servers VALUES (?, ?, ?, ?, ?, ?)');
  for (const r of prevRows) ins.run(r.id, r.url, r.archived, r.archivedAt, r.npm, r.npmAt);
  prev.close();

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const tins = db.prepare('INSERT INTO servers (id, repository_url) VALUES (?, ?)');
  for (const r of targetRows) tins.run(r.id, r.url);
  const changes = seedFlagsFromSnapshot(db, prevPath);
  const rows = Object.fromEntries(
    db.prepare('SELECT * FROM servers').all().map((r) => [r.id, { ...r }]),
  );
  db.close();
  return { changes, rows };
}

const T = '2026-11-20T00:00:00.000Z';
const GH = 'https://github.com/o/r';

try {
  // Post-split prev (contains a 2): same URL carries, changed URL does not.
  {
    const { changes, rows } = run(
      [
        { id: 'same', url: GH, archived: 1, archivedAt: T, npm: 0, npmAt: T },
        { id: 'moved', url: GH, archived: 2, archivedAt: T, npm: 1, npmAt: T },
        { id: 'nullurl', url: null, archived: 0, archivedAt: T, npm: 0, npmAt: T },
      ],
      [
        { id: 'same', url: GH },
        { id: 'moved', url: 'https://gitlab.com/o/r' },
        { id: 'nullurl', url: null },
        { id: 'new', url: GH },
      ],
    );
    assert.equal(changes, 3);
    assert.equal(rows.same.archived_repo, 1);
    assert.equal(rows.same.archived_repo_checked_at, T, 'post-split: archived=1 timestamp preserved');
    assert.equal(rows.moved.archived_repo, null, 'changed URL: archived_repo not carried');
    assert.equal(rows.moved.archived_repo_checked_at, null, 'changed URL: timestamp not carried');
    assert.equal(rows.moved.deprecated_npm, 1, 'changed URL: deprecated_npm still carried');
    assert.equal(rows.moved.deprecated_npm_checked_at, T);
    assert.equal(rows.nullurl.archived_repo, 0, 'null URL on both sides counts as unchanged');
    assert.equal(rows.nullurl.archived_repo_checked_at, T);
    assert.equal(rows.new.archived_repo, null);
    assert.equal(rows.new.deprecated_npm, null);
  }

  // Pre-split prev (no 2s): carried archived=1 rows are re-queued for probing.
  {
    const { rows } = run(
      [
        { id: 'a', url: GH, archived: 1, archivedAt: T, npm: 0, npmAt: T },
        { id: 'b', url: GH, archived: 0, archivedAt: T, npm: 0, npmAt: T },
      ],
      [{ id: 'a', url: GH }, { id: 'b', url: GH }],
    );
    assert.equal(rows.a.archived_repo, 1, 'pre-split: value 1 kept');
    assert.equal(rows.a.archived_repo_checked_at, null, 'pre-split: archived=1 timestamp cleared');
    assert.equal(rows.b.archived_repo_checked_at, T, 'pre-split: clean rows keep timestamp');
  }

  console.log('carry-over flags tests passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
