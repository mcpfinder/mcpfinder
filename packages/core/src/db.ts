/**
 * SQLite database with FTS5 full-text search for MCP servers
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { usableRemoteUrl } from './remote-url.js';

/**
 * A value bindable to a SQLite statement parameter. Mirrors node:sqlite's
 * internal `SQLInputValue`; declared locally so callers can type loose
 * parameter arrays/objects without importing Node's non-exported type.
 */
export type SqlParam = null | number | bigint | string | Uint8Array;

/**
 * Wrap `fn` in a SQLite transaction, mirroring better-sqlite3's
 * `db.transaction(fn)` ergonomics: returns a callable with the same signature
 * that runs inside BEGIN/COMMIT, rolling back on any thrown error. `node:sqlite`
 * has no built-in transaction helper, so we provide one for callers (sync.ts).
 */
export function transaction<A extends unknown[], R>(
  db: DatabaseSync,
  fn: (...args: A) => R,
): (...args: A) => R {
  return (...args: A): R => {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '',
  registry_type TEXT,
  package_identifier TEXT,
  transport_type TEXT,
  repository_url TEXT,
  repository_source TEXT,
  published_at TEXT,
  updated_at TEXT,
  status TEXT DEFAULT 'active',
  popularity_score REAL DEFAULT 0,
  categories TEXT DEFAULT '[]',
  keywords TEXT DEFAULT '[]',
  remote_url TEXT,
  has_remote INTEGER DEFAULT 0,
  last_synced_at TEXT,
  sources TEXT DEFAULT '[]',
  raw_data TEXT,
  env_vars TEXT DEFAULT '[]',
  source TEXT DEFAULT 'official',
  use_count INTEGER DEFAULT 0,
  verified INTEGER DEFAULT 0,
  icon_url TEXT
);

CREATE INDEX IF NOT EXISTS idx_servers_slug ON servers(slug);
CREATE INDEX IF NOT EXISTS idx_servers_popularity ON servers(popularity_score DESC);
CREATE INDEX IF NOT EXISTS idx_servers_updated ON servers(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_servers_status ON servers(status);

-- Full-text search using FTS5 with porter stemmer
CREATE VIRTUAL TABLE IF NOT EXISTS servers_fts USING fts5(
  name,
  description,
  keywords,
  content=servers,
  content_rowid=rowid,
  tokenize='porter unicode61'
);

-- Triggers to keep FTS in sync with servers table
CREATE TRIGGER IF NOT EXISTS servers_ai AFTER INSERT ON servers BEGIN
  INSERT INTO servers_fts(rowid, name, description, keywords)
  VALUES (new.rowid, new.name, new.description, new.keywords);
END;

CREATE TRIGGER IF NOT EXISTS servers_ad AFTER DELETE ON servers BEGIN
  INSERT INTO servers_fts(servers_fts, rowid, name, description, keywords)
  VALUES ('delete', old.rowid, old.name, old.description, old.keywords);
END;

CREATE TRIGGER IF NOT EXISTS servers_au AFTER UPDATE ON servers BEGIN
  INSERT INTO servers_fts(servers_fts, rowid, name, description, keywords)
  VALUES ('delete', old.rowid, old.name, old.description, old.keywords);
  INSERT INTO servers_fts(rowid, name, description, keywords)
  VALUES (new.rowid, new.name, new.description, new.keywords);
END;

-- Sync metadata table
CREATE TABLE IF NOT EXISTS sync_log (
  source TEXT PRIMARY KEY,
  last_synced_at TEXT NOT NULL,
  last_successful_at TEXT,
  server_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'ok',
  error TEXT
);
`;

/**
 * Get the data directory for MCPfinder.
 * Uses MCPFINDER_DATA_DIR env var or defaults to ~/.mcpfinder/
 */
export function getDataDir(): string {
  const dir = process.env.MCPFINDER_DATA_DIR || join(homedir(), '.mcpfinder');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Nominal catalog DB path. It names the family of snapshot files in the data
 * dir rather than necessarily the file in use — `resolveCurrentDbPath` turns it
 * into the file this install is actually serving from.
 */
export function getCatalogDbPath(): string {
  return join(getDataDir(), 'data.db');
}

/**
 * Initialize and return a SQLite database with FTS5 schema.
 */
export function initDatabase(dbPath?: string): DatabaseSync {
  const path = dbPath || getCatalogDbPath();
  const db = new DatabaseSync(path);

  // Enable WAL mode for better concurrent read performance
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  // Create schema
  db.exec(SCHEMA_SQL);

  // Migrate: add new columns if they don't exist (for existing databases)
  migrateSchema(db);

  return db;
}

/**
 * Fold the write-ahead log back into the database and truncate it to zero.
 *
 * A registry crawl is applied as a *single* transaction, deliberately — see
 * sync.ts — so the WAL grows to the size of the entire write and stays that
 * big afterwards. Measured on a real install: a 323MB database beside a 40MB
 * `-wal` and a 1MB `-shm`. Truncating after the fact changes nothing about the
 * transaction's atomicity; it only stops the journal from occupying that space
 * until the next clean close.
 *
 * Best effort: a concurrent reader can hold the checkpoint off, and that is not
 * worth reporting — the next successful sync tries again.
 */
export function checkpointWal(db: DatabaseSync): void {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    /* busy, read-only, or already closed — the journal simply stays as it is */
  }
}

/**
 * Close a catalog handle the way SQLite wants: checkpoint first, then close.
 *
 * A clean close is what removes the `-wal`/`-shm` altogether. Explicit by
 * design — this library never registers process-wide shutdown hooks, so the
 * caller that knows it is done with a handle (catalog.ts, when it retires the
 * previous one) is the one that calls this. Throws whatever `close()` throws.
 */
export function closeDatabase(db: DatabaseSync): void {
  checkpointWal(db);
  db.close();
}

/**
 * Gracefully add columns that may not exist in older databases.
 */
function migrateSchema(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info('servers')").all() as Array<{ name: string }>;
  const existing = new Set(columns.map((c) => c.name));

  const migrations: Array<[string, string]> = [
    ['source', "TEXT DEFAULT 'official'"],
    ['use_count', 'INTEGER DEFAULT 0'],
    ['verified', 'INTEGER DEFAULT 0'],
    ['icon_url', 'TEXT'],
    // Deprecation signals set by enrichDeprecationFlags (build-time probe).
    // NULL = not checked yet, 0 = checked and clean, 1 = flagged.
    ['deprecated_npm', 'INTEGER DEFAULT NULL'],
    ['archived_repo', 'INTEGER DEFAULT NULL'],
    // ISO timestamp of the last deprecation/archived probe. Drives the rolling
    // re-probe window in enrichDeprecationFlags and is carried across snapshot
    // rebuilds so probes stay incremental. NULL = never timestamped.
    ['deprecated_npm_checked_at', 'TEXT DEFAULT NULL'],
    ['archived_repo_checked_at', 'TEXT DEFAULT NULL'],
  ];

  for (const [col, def] of migrations) {
    if (!existing.has(col)) {
      db.exec(`ALTER TABLE servers ADD COLUMN ${col} ${def}`);
    }
  }

  const syncColumns = db.prepare("PRAGMA table_info('sync_log')").all() as Array<{ name: string }>;
  if (!syncColumns.some((column) => column.name === 'last_successful_at')) {
    db.exec('ALTER TABLE sync_log ADD COLUMN last_successful_at TEXT');
  }
  db.exec(
    `UPDATE sync_log SET last_successful_at = last_synced_at
     WHERE status = 'ok' AND last_successful_at IS NULL`,
  );

  clearRetiredRemoteUrls(db);
  clearRetiredSourceData(db);
}

/**
 * Clear remote URLs on retired hosts (see remote-url.ts) that an older sync or
 * snapshot left behind. New data is already filtered at ingest, but a local
 * catalog built before Smithery was dropped still holds registry.smithery.ai /
 * server.smithery.ai / *.run.tools endpoints, and the upsert keeps an existing
 * remote_url when a refresh has none. Idempotent; a no-op once clean. Best
 * effort: a busy or read-only database is left as it is, and install configs
 * still refuse a retired URL at read time (install.ts).
 */
function clearRetiredRemoteUrls(db: DatabaseSync): void {
  try {
    const candidates = db
      .prepare(
        `SELECT id, remote_url FROM servers
         WHERE remote_url LIKE '%smithery.ai%' OR remote_url LIKE '%run.tools%'`,
      )
      .all() as Array<{ id: string; remote_url: string }>;
    const stale = candidates.filter((row) => usableRemoteUrl(row.remote_url) === null);
    if (stale.length === 0) return;
    const clear = db.prepare('UPDATE servers SET remote_url = NULL, has_remote = 0 WHERE id = ?');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of stale) clear.run(row.id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } catch {
    /* busy or read-only: try again on the next open */
  }
}

/**
 * Remove what the retired Smithery source left in a catalog built before 2.0.0,
 * so an upgraded install matches a fresh one: rows only Smithery listed are
 * deleted (nothing can refresh them), `smithery` is dropped from `sources`, and
 * the signals only Smithery supplied — `use_count`, `verified`, Smithery-hosted
 * icons — are reset. Fresh snapshots and new syncs never contain any of this,
 * so on them every statement matches nothing. Same best-effort rules as above.
 */
function clearRetiredSourceData(db: DatabaseSync): void {
  try {
    const legacy = db
      .prepare(`SELECT id, sources FROM servers WHERE sources LIKE '%"smithery"%'`)
      .all() as Array<{ id: string; sources: string }>;
    const needsSignalReset = db
      .prepare(
        `SELECT 1 FROM servers
         WHERE use_count <> 0 OR verified <> 0 OR icon_url LIKE '%smithery.ai%' LIMIT 1`,
      )
      .get();
    if (legacy.length === 0 && !needsSignalReset) return;
    const remove = db.prepare('DELETE FROM servers WHERE id = ?');
    const setSources = db.prepare('UPDATE servers SET sources = ? WHERE id = ?');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of legacy) {
        let sources: unknown;
        try {
          sources = JSON.parse(row.sources);
        } catch {
          continue;
        }
        if (!Array.isArray(sources)) continue;
        const kept = sources.filter((s) => typeof s === 'string' && s !== 'smithery');
        if (kept.length === 0) remove.run(row.id);
        else setSources.run(JSON.stringify(kept.sort()), row.id);
      }
      db.exec(`UPDATE servers SET use_count = 0 WHERE use_count <> 0`);
      db.exec(`UPDATE servers SET verified = 0 WHERE verified <> 0`);
      db.exec(`UPDATE servers SET icon_url = NULL WHERE icon_url LIKE '%smithery.ai%'`);
      db.exec(`DELETE FROM sync_log WHERE source = 'smithery'`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } catch {
    /* busy or read-only: try again on the next open */
  }
}

/**
 * Get the last attempted sync timestamp for throttling, regardless of status.
 */
export function getLastSyncTimestamp(db: DatabaseSync, source: string): string | null {
  const row = db
    .prepare('SELECT last_synced_at FROM sync_log WHERE source = ?')
    .get(source) as
    | { last_synced_at: string }
    | undefined;
  return row?.last_synced_at ?? null;
}

/**
 * Get the last successful timestamp only when the most recent attempt was
 * healthy. A failed latest attempt deliberately forces the next upstream sync
 * to run without an incremental cursor.
 */
export function getLastSuccessfulSyncTimestamp(db: DatabaseSync, source: string): string | null {
  const row = db
    .prepare("SELECT last_successful_at FROM sync_log WHERE source = ? AND status = 'ok'")
    .get(source) as
    | { last_successful_at: string | null }
    | undefined;
  return row?.last_successful_at ?? null;
}

/**
 * Update sync log for a source.
 */
export function updateSyncLog(
  db: DatabaseSync,
  source: string,
  serverCount: number,
  status: string = 'ok',
  error?: string,
): void {
  const attemptedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO sync_log (
       source, last_synced_at, last_successful_at, server_count, status, error
     ) VALUES (?, ?, CASE WHEN ? = 'ok' THEN ? ELSE NULL END, ?, ?, ?)
     ON CONFLICT(source) DO UPDATE SET
       last_synced_at = excluded.last_synced_at,
       last_successful_at = CASE
         WHEN excluded.status = 'ok' THEN excluded.last_synced_at
         ELSE sync_log.last_successful_at
       END,
       server_count = excluded.server_count,
       status = excluded.status,
       error = excluded.error`,
  ).run(source, attemptedAt, status, attemptedAt, serverCount, status, error ?? null);
}

/**
 * `sync_log` source under which a hosted-snapshot install is recorded. It is
 * not a registry: the row means "this DB was replaced wholesale by a published
 * snapshot at this time", which `isSyncNeeded` reads as freshness.
 */
export const SNAPSHOT_SOURCE = 'snapshot';

/** Stamp the DB as freshly populated from a hosted snapshot. */
export function markSnapshotInstalled(db: DatabaseSync, serverCount: number): void {
  updateSyncLog(db, SNAPSHOT_SOURCE, serverCount);
}

/** ISO timestamp of the last hosted-snapshot install, or null. */
export function getSnapshotInstalledAt(db: DatabaseSync): string | null {
  return getLastSyncTimestamp(db, SNAPSHOT_SOURCE);
}
