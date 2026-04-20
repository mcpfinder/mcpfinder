/**
 * Pre-built DB snapshot served from R2.
 *
 * A CI job (scripts/build-snapshot.mjs) produces:
 *   - data.sqlite.gz   (the SQLite DB, gzipped)
 *   - manifest.json    (publishedAt, sha256, serverCount, sizeBytes, url)
 *
 * and uploads both into the MCP_DB_SNAPSHOTS R2 bucket. Clients hit these
 * endpoints on first run to skip the ~11 min live sync.
 */
import type { AppContext } from '../types';

const GZ_KEY = 'data.sqlite.gz';
const MANIFEST_KEY = 'manifest.json';

// Cache manifest briefly; the gz file is content-addressed via sha256 so
// clients can verify. The manifest drives freshness, so keep it short.
const MANIFEST_CACHE_SECONDS = 300; // 5 min
const GZ_CACHE_SECONDS = 3600; // 1 h (sha256 guards against mismatch)

function r2(c: AppContext): R2Bucket | null {
  // Binding is optional until the R2 bucket is provisioned; return null if absent.
  return (c.env as unknown as { MCP_DB_SNAPSHOTS?: R2Bucket }).MCP_DB_SNAPSHOTS ?? null;
}

export async function getSnapshotManifest(c: AppContext) {
  const bucket = r2(c);
  if (!bucket) return c.json({ error: 'snapshot-not-configured' }, 503);

  const obj = await bucket.get(MANIFEST_KEY);
  if (!obj) return c.json({ error: 'snapshot-not-available' }, 404);

  const body = await obj.text();
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${MANIFEST_CACHE_SECONDS}`,
      etag: obj.etag,
    },
  });
}

export async function getSnapshotData(c: AppContext) {
  const bucket = r2(c);
  if (!bucket) return c.json({ error: 'snapshot-not-configured' }, 503);

  const ifNoneMatch = c.req.header('if-none-match');
  const obj = await bucket.get(GZ_KEY);
  if (!obj) return c.json({ error: 'snapshot-not-available' }, 404);

  if (ifNoneMatch && ifNoneMatch === obj.etag) {
    return new Response(null, { status: 304, headers: { etag: obj.etag } });
  }

  return new Response(obj.body, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-encoding': 'identity',
      'content-length': String(obj.size),
      'cache-control': `public, max-age=${GZ_CACHE_SECONDS}, immutable`,
      etag: obj.etag,
      'x-snapshot-uploaded': obj.uploaded.toISOString(),
    },
  });
}
