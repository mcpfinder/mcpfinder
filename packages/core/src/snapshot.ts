/**
 * Pre-built DB snapshot bootstrap.
 *
 * Downloads a gzipped SQLite file produced by a scheduled builder
 * and atomically installs it into the data dir. This replaces the ~11 min
 * cold-start sync with a ~5–10s download on first run.
 *
 * Protocol (served by api-worker):
 *   GET <base>/manifest.json   → { publishedAt, serverCount, sha256, sizeBytes, url }
 *   GET <base>/data.sqlite.gz  → gzipped SQLite file
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { getDataDir } from './db.js';

export const DEFAULT_SNAPSHOT_BASE = 'https://mcpfinder.dev/api/v1/snapshot';

export interface SnapshotManifest {
  publishedAt: string;
  serverCount: number;
  sha256: string;
  sizeBytes: number;
  /** Relative or absolute URL of the gzipped DB file. */
  url: string;
  /** Builder version / git SHA, for diagnostics. */
  builder?: string;
}

export interface BootstrapResult {
  ok: boolean;
  reason?: string;
  servers?: number;
  publishedAt?: string;
  bytesDownloaded?: number;
  durationMs?: number;
}

export interface BootstrapOptions {
  /** Base URL for snapshot endpoint; defaults to mcpfinder.dev. */
  baseUrl?: string;
  /** Destination DB path; defaults to <data-dir>/data.db. */
  dbPath?: string;
  /** If true, overwrite existing non-empty DB. */
  force?: boolean;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

async function fileExistsNonEmpty(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

/**
 * Fetch the snapshot manifest. Returns null on any error.
 */
export async function fetchSnapshotManifest(
  baseUrl: string = DEFAULT_SNAPSHOT_BASE,
  signal?: AbortSignal,
): Promise<SnapshotManifest | null> {
  const url = `${baseUrl.replace(/\/+$/, '')}/manifest.json`;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    return (await res.json()) as SnapshotManifest;
  } catch {
    return null;
  }
}

/**
 * Download the gzipped DB file, verify sha256, and atomically install at dbPath.
 */
export async function bootstrapFromSnapshot(opts: BootstrapOptions = {}): Promise<BootstrapResult> {
  const t0 = Date.now();
  const baseUrl = (opts.baseUrl ?? DEFAULT_SNAPSHOT_BASE).replace(/\/+$/, '');
  const dbPath = opts.dbPath ?? join(getDataDir(), 'data.db');

  if (!opts.force && (await fileExistsNonEmpty(dbPath))) {
    return { ok: false, reason: 'db-already-exists' };
  }

  const manifest = await fetchSnapshotManifest(baseUrl, opts.signal);
  if (!manifest) {
    return { ok: false, reason: 'manifest-fetch-failed' };
  }

  const dataUrl = manifest.url.startsWith('http')
    ? manifest.url
    : `${baseUrl}/${manifest.url.replace(/^\/+/, '')}`;

  const res = await fetch(dataUrl, { signal: opts.signal });
  if (!res.ok || !res.body) {
    return { ok: false, reason: `download-failed-${res.status}` };
  }

  await mkdir(dirname(dbPath), { recursive: true });
  const tmpPath = `${dbPath}.download-${process.pid}`;

  const hash = createHash('sha256');
  let bytesIn = 0;

  const gzStream = Readable.fromWeb(res.body as never);
  gzStream.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    bytesIn += chunk.length;
  });

  try {
    await pipeline(gzStream, createGunzip(), createWriteStream(tmpPath));
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    return { ok: false, reason: `decompress-failed: ${(err as Error).message}` };
  }

  const gotSha = hash.digest('hex');
  if (manifest.sha256 && gotSha !== manifest.sha256) {
    await unlink(tmpPath).catch(() => {});
    return { ok: false, reason: `sha256-mismatch (expected ${manifest.sha256}, got ${gotSha})` };
  }

  await rename(tmpPath, dbPath);

  return {
    ok: true,
    servers: manifest.serverCount,
    publishedAt: manifest.publishedAt,
    bytesDownloaded: bytesIn,
    durationMs: Date.now() - t0,
  };
}
