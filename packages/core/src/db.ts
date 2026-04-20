/**
 * SQLite database with FTS5 full-text search for MCP servers
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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
 * Initialize and return a SQLite database with FTS5 schema.
 */
export function initDatabase(dbPath?: string): Database.Database {
  const path = dbPath || join(getDataDir(), 'data.db');
  const db = new Database(path);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create schema
  db.exec(SCHEMA_SQL);

  // Migrate: add new columns if they don't exist (for existing databases)
  migrateSchema(db);

  return db;
}

/**
 * Gracefully add columns that may not exist in older databases.
 */
function migrateSchema(db: Database.Database): void {
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
  ];

  for (const [col, def] of migrations) {
    if (!existing.has(col)) {
      db.exec(`ALTER TABLE servers ADD COLUMN ${col} ${def}`);
    }
  }
}

/**
 * Get the last sync timestamp for a source.
 */
export function getLastSyncTimestamp(db: Database.Database, source: string): string | null {
  const row = db.prepare('SELECT last_synced_at FROM sync_log WHERE source = ?').get(source) as
    | { last_synced_at: string }
    | undefined;
  return row?.last_synced_at ?? null;
}

/**
 * Update sync log for a source.
 */
export function updateSyncLog(
  db: Database.Database,
  source: string,
  serverCount: number,
  status: string = 'ok',
  error?: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO sync_log (source, last_synced_at, server_count, status, error)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(source, new Date().toISOString(), serverCount, status, error ?? null);
}
