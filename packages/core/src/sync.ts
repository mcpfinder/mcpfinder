/**
 * Sync engine for fetching servers from multiple MCP registries:
 * - Official MCP Registry
 * - Glama (glama.ai)
 * - Smithery (registry.smithery.ai)
 */
import type Database from 'better-sqlite3';
import type {
  RegistryListResponse,
  RegistryServerEntry,
  GlamaListResponse,
  GlamaServer,
  SmitheryListResponse,
  SmitheryServer,
} from './types.js';
import { getLastSyncTimestamp, updateSyncLog } from './db.js';
import { extractKeywords } from './categories.js';

const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io';
const GLAMA_BASE = 'https://glama.ai/api/mcp/v1';
const SMITHERY_BASE = 'https://registry.smithery.ai';
const PAGE_LIMIT = 100;

/** Delay helper for rate limiting */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate a slug from a server name.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Normalize a repository URL: lowercase, strip `.git` suffix, strip trailing slashes,
 * strip SCP-style `git@host:` prefix.
 * Returns null if the input is empty / not a usable URL.
 */
function normalizeRepoUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let u = url.trim().toLowerCase();
  if (!u) return null;
  // git@github.com:owner/repo[.git] -> https://github.com/owner/repo
  const scp = u.match(/^git@([^:]+):(.+)$/);
  if (scp) u = `https://${scp[1]}/${scp[2]}`;
  u = u.replace(/\.git$/, '').replace(/\/+$/, '');
  return u || null;
}

/**
 * Extract the canonical `owner/repo` tail from a known code-host URL.
 * Used as a cross-registry dedup key — matches GitHub, GitLab, Bitbucket.
 * Returns null if URL doesn't resemble a known code host.
 */
function extractRepoKey(url: string | null | undefined): string | null {
  const n = normalizeRepoUrl(url);
  if (!n) return null;
  const m = n.match(/\b(?:github|gitlab|bitbucket|codeberg)\.(?:com|org|io)\/([^/]+)\/([^/?#]+)/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Merge sources arrays. Returns sorted, deduplicated list.
 */
function mergeSources(existing: string[], newSource: string): string[] {
  const set = new Set(existing);
  set.add(newSource);
  return [...set].sort();
}

// ─── Official Registry Sync ─────────────────────────────────────────────────

/**
 * Normalize a registry entry into our database row format.
 */
function normalizeOfficialEntry(entry: RegistryServerEntry) {
  const s = entry.server;
  const metaKey = Object.keys(entry._meta || {}).find((k) =>
    k.includes('modelcontextprotocol'),
  );
  const meta = metaKey ? entry._meta![metaKey] : undefined;
  const pkg = s.packages?.[0];
  const remote = s.remotes?.[0];

  const slug = slugify(s.name);
  const keywords = extractKeywords(s.name, s.description || '');
  const envVars = pkg?.environmentVariables || [];

  return {
    id: s.name,
    slug,
    name: s.name,
    description: s.description || '',
    version: s.version,
    registry_type: pkg?.registryType || null,
    package_identifier: pkg?.identifier || null,
    transport_type: pkg?.transport?.type || null,
    repository_url: normalizeRepoUrl(s.repository?.url),
    repository_source: s.repository?.source || null,
    published_at: meta?.publishedAt || null,
    updated_at: meta?.updatedAt || null,
    status: meta?.status || 'active',
    popularity_score: 0,
    categories: JSON.stringify([]),
    keywords: JSON.stringify(keywords),
    remote_url: remote?.url || null,
    has_remote: remote ? 1 : 0,
    last_synced_at: new Date().toISOString(),
    sources: JSON.stringify(['official']),
    raw_data: JSON.stringify(entry),
    env_vars: JSON.stringify(envVars),
    source: 'official',
    use_count: 0,
    verified: 0,
    icon_url: null,
  };
}

/**
 * Sync servers from the Official MCP Registry.
 */
export async function syncOfficialRegistry(db: Database.Database): Promise<number> {
  const lastSync = getLastSyncTimestamp(db, 'official');

  let cursor: string | null = null;
  let totalUpserted = 0;

  const upsert = db.prepare(`
    INSERT INTO servers (
      id, slug, name, description, version, registry_type, package_identifier,
      transport_type, repository_url, repository_source, published_at, updated_at,
      status, popularity_score, categories, keywords, remote_url, has_remote,
      last_synced_at, sources, raw_data, env_vars, source, use_count, verified, icon_url
    ) VALUES (
      @id, @slug, @name, @description, @version, @registry_type, @package_identifier,
      @transport_type, @repository_url, @repository_source, @published_at, @updated_at,
      @status, @popularity_score, @categories, @keywords, @remote_url, @has_remote,
      @last_synced_at, @sources, @raw_data, @env_vars, @source, @use_count, @verified, @icon_url
    )
    ON CONFLICT(id) DO UPDATE SET
      description = CASE WHEN length(excluded.description) > length(servers.description) THEN excluded.description ELSE servers.description END,
      version = excluded.version,
      registry_type = COALESCE(excluded.registry_type, servers.registry_type),
      package_identifier = COALESCE(excluded.package_identifier, servers.package_identifier),
      transport_type = COALESCE(excluded.transport_type, servers.transport_type),
      repository_url = COALESCE(excluded.repository_url, servers.repository_url),
      repository_source = COALESCE(excluded.repository_source, servers.repository_source),
      published_at = COALESCE(excluded.published_at, servers.published_at),
      updated_at = COALESCE(excluded.updated_at, servers.updated_at),
      status = excluded.status,
      keywords = excluded.keywords,
      remote_url = COALESCE(excluded.remote_url, servers.remote_url),
      has_remote = MAX(excluded.has_remote, servers.has_remote),
      last_synced_at = excluded.last_synced_at,
      raw_data = excluded.raw_data,
      env_vars = CASE WHEN length(excluded.env_vars) > length(servers.env_vars) THEN excluded.env_vars ELSE servers.env_vars END
  `);

  do {
    const url = new URL(`${REGISTRY_BASE}/v0.1/servers`);
    url.searchParams.set('version', 'latest');
    url.searchParams.set('limit', String(PAGE_LIMIT));
    if (lastSync) url.searchParams.set('updated_since', lastSync);
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url.toString());
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Registry API error: ${res.status} ${res.statusText} — ${errText}`);
    }

    const data = (await res.json()) as RegistryListResponse;

    if (!data.servers || data.servers.length === 0) break;

    const insertBatch = db.transaction((entries: RegistryServerEntry[]) => {
      for (const entry of entries) {
        const row = normalizeOfficialEntry(entry);
        upsert.run(row);
        // Merge sources
        mergeServerSources(db, row.id, 'official');
      }
    });

    insertBatch(data.servers);
    totalUpserted += data.servers.length;

    cursor = data.metadata?.nextCursor ?? null;

    if (cursor) await delay(100);
  } while (cursor);

  updateSyncLog(db, 'official', totalUpserted);

  return totalUpserted;
}

// ─── Glama Registry Sync ────────────────────────────────────────────────────

/**
 * Normalize a Glama server entry into our database row format.
 */
function normalizeGlamaEntry(entry: GlamaServer) {
  const name = entry.namespace ? `${entry.namespace}/${entry.name}` : entry.name;
  const slug = slugify(entry.slug || name);
  const keywords = extractKeywords(name, entry.description || '');

  // Extract env vars from JSON schema if present
  let envVars: Array<{ name: string; description?: string }> = [];
  if (entry.environmentVariablesJsonSchema && typeof entry.environmentVariablesJsonSchema === 'object') {
    const schema = entry.environmentVariablesJsonSchema as Record<string, unknown>;
    const props = (schema.properties || {}) as Record<string, { description?: string }>;
    envVars = Object.keys(props).map((key) => ({
      name: key,
      description: props[key]?.description,
    }));
  }

  return {
    id: `glama:${entry.id}`,
    slug,
    name,
    description: entry.description || '',
    version: '',
    registry_type: null,
    package_identifier: null,
    transport_type: null,
    repository_url: normalizeRepoUrl(entry.repository?.url),
    repository_source: entry.repository?.url ? 'github' : null,
    published_at: null,
    updated_at: null,
    status: 'active',
    popularity_score: 0,
    categories: JSON.stringify([]),
    keywords: JSON.stringify(keywords),
    remote_url: entry.url || null,
    has_remote: entry.url ? 1 : 0,
    last_synced_at: new Date().toISOString(),
    sources: JSON.stringify(['glama']),
    raw_data: JSON.stringify(entry),
    env_vars: JSON.stringify(envVars),
    source: 'glama',
    use_count: 0,
    verified: 0,
    icon_url: null,
  };
}

/**
 * Sync servers from Glama registry.
 */
export async function syncGlamaRegistry(db: Database.Database): Promise<number> {
  let cursor: string | null = null;
  let totalUpserted = 0;

  const upsert = db.prepare(`
    INSERT INTO servers (
      id, slug, name, description, version, registry_type, package_identifier,
      transport_type, repository_url, repository_source, published_at, updated_at,
      status, popularity_score, categories, keywords, remote_url, has_remote,
      last_synced_at, sources, raw_data, env_vars, source, use_count, verified, icon_url
    ) VALUES (
      @id, @slug, @name, @description, @version, @registry_type, @package_identifier,
      @transport_type, @repository_url, @repository_source, @published_at, @updated_at,
      @status, @popularity_score, @categories, @keywords, @remote_url, @has_remote,
      @last_synced_at, @sources, @raw_data, @env_vars, @source, @use_count, @verified, @icon_url
    )
    ON CONFLICT(id) DO UPDATE SET
      description = CASE WHEN length(excluded.description) > length(servers.description) THEN excluded.description ELSE servers.description END,
      repository_url = COALESCE(excluded.repository_url, servers.repository_url),
      remote_url = COALESCE(excluded.remote_url, servers.remote_url),
      has_remote = MAX(excluded.has_remote, servers.has_remote),
      last_synced_at = excluded.last_synced_at,
      keywords = excluded.keywords,
      env_vars = CASE WHEN length(excluded.env_vars) > length(servers.env_vars) THEN excluded.env_vars ELSE servers.env_vars END
  `);

  try {
    do {
      const url = new URL(`${GLAMA_BASE}/servers`);
      url.searchParams.set('first', String(PAGE_LIMIT));
      if (cursor) url.searchParams.set('after', cursor);

      const res = await fetch(url.toString());
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Glama API error: ${res.status} ${res.statusText} — ${errText}`);
      }

      const data = (await res.json()) as GlamaListResponse;

      if (!data.servers || data.servers.length === 0) break;

      const insertBatch = db.transaction((entries: GlamaServer[]) => {
        for (const entry of entries) {
          const row = normalizeGlamaEntry(entry);
          // Try to find existing server by repo URL for dedup
          const existingId = findExistingServer(
            db,
            row.repository_url,
            row.package_identifier,
            row.registry_type,
            row.slug,
            row.name,
          );
          if (existingId) {
            mergeServerSources(db, existingId, 'glama');
            // Also update with richer data from Glama if applicable
            mergeServerData(db, existingId, row);
          } else {
            upsert.run(row);
            mergeServerSources(db, row.id, 'glama');
          }
        }
      });

      insertBatch(data.servers);
      totalUpserted += data.servers.length;

      cursor = data.pageInfo?.hasNextPage ? (data.pageInfo.endCursor ?? null) : null;

      if (cursor) await delay(100);
    } while (cursor);

    updateSyncLog(db, 'glama', totalUpserted);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateSyncLog(db, 'glama', totalUpserted, 'error', msg);
    process.stderr.write(`[mcpfinder] Glama sync error: ${msg}\n`);
  }

  return totalUpserted;
}

// ─── Smithery Registry Sync ─────────────────────────────────────────────────

/**
 * Normalize a Smithery server entry into our database row format.
 */
function normalizeSmitheryEntry(entry: SmitheryServer) {
  const slug = slugify(entry.qualifiedName);
  const keywords = extractKeywords(entry.displayName || entry.qualifiedName, entry.description || '');

  // Smithery stores a "homepage" field that is sometimes a real code repo and
  // sometimes a product landing page — only lift it into repository_url when it
  // looks like a known code host, so dedup keys stay clean.
  const homepageIsRepo = extractRepoKey(entry.homepage) !== null;
  const repoUrl = homepageIsRepo ? normalizeRepoUrl(entry.homepage) : null;

  return {
    id: `smithery:${entry.qualifiedName}`,
    slug,
    name: entry.displayName || entry.qualifiedName,
    description: entry.description || '',
    version: '',
    registry_type: null,
    package_identifier: null,
    transport_type: null,
    repository_url: repoUrl,
    repository_source: homepageIsRepo ? 'github' : null,
    published_at: entry.createdAt || null,
    updated_at: entry.createdAt || null,
    status: 'active',
    popularity_score: 0,
    categories: JSON.stringify([]),
    keywords: JSON.stringify(keywords),
    remote_url: entry.remote && entry.isDeployed ? `https://registry.smithery.ai/servers/${entry.qualifiedName}` : null,
    has_remote: entry.remote && entry.isDeployed ? 1 : 0,
    last_synced_at: new Date().toISOString(),
    sources: JSON.stringify(['smithery']),
    raw_data: JSON.stringify(entry),
    env_vars: JSON.stringify([]),
    source: 'smithery',
    use_count: entry.useCount || 0,
    verified: entry.verified ? 1 : 0,
    icon_url: entry.iconUrl || null,
  };
}

/**
 * Sync servers from Smithery registry.
 */
export async function syncSmitheryRegistry(db: Database.Database): Promise<number> {
  let page = 1;
  let totalUpserted = 0;
  let hasMore = true;

  const upsert = db.prepare(`
    INSERT INTO servers (
      id, slug, name, description, version, registry_type, package_identifier,
      transport_type, repository_url, repository_source, published_at, updated_at,
      status, popularity_score, categories, keywords, remote_url, has_remote,
      last_synced_at, sources, raw_data, env_vars, source, use_count, verified, icon_url
    ) VALUES (
      @id, @slug, @name, @description, @version, @registry_type, @package_identifier,
      @transport_type, @repository_url, @repository_source, @published_at, @updated_at,
      @status, @popularity_score, @categories, @keywords, @remote_url, @has_remote,
      @last_synced_at, @sources, @raw_data, @env_vars, @source, @use_count, @verified, @icon_url
    )
    ON CONFLICT(id) DO UPDATE SET
      description = CASE WHEN length(excluded.description) > length(servers.description) THEN excluded.description ELSE servers.description END,
      repository_url = COALESCE(excluded.repository_url, servers.repository_url),
      remote_url = COALESCE(excluded.remote_url, servers.remote_url),
      has_remote = MAX(excluded.has_remote, servers.has_remote),
      last_synced_at = excluded.last_synced_at,
      keywords = excluded.keywords,
      use_count = MAX(excluded.use_count, servers.use_count),
      verified = MAX(excluded.verified, servers.verified),
      icon_url = COALESCE(excluded.icon_url, servers.icon_url)
  `);

  try {
    while (hasMore) {
      const url = new URL(`${SMITHERY_BASE}/servers`);
      url.searchParams.set('page', String(page));
      url.searchParams.set('pageSize', String(PAGE_LIMIT));

      const res = await fetch(url.toString());
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Smithery API error: ${res.status} ${res.statusText} — ${errText}`);
      }

      const data = (await res.json()) as SmitheryListResponse;

      if (!data.servers || data.servers.length === 0) break;

      const insertBatch = db.transaction((entries: SmitheryServer[]) => {
        for (const entry of entries) {
          const row = normalizeSmitheryEntry(entry);
          // Fix 2: prefer Official's ai.smithery/* mirror when it exists.
          // This single heuristic catches the largest slice of cross-registry
          // matches that Smithery's sparse repo URL can't surface.
          const existingId =
            findOfficialFromSmitheryQualifiedName(db, entry.qualifiedName) ??
            findExistingServer(
              db,
              row.repository_url,
              row.package_identifier,
              row.registry_type,
              row.slug,
              row.name,
            );
          if (existingId) {
            mergeServerSources(db, existingId, 'smithery');
            mergeServerData(db, existingId, row);
            // Always update use_count, verified, icon_url from Smithery
            db.prepare(`
              UPDATE servers SET
                use_count = MAX(use_count, ?),
                verified = MAX(verified, ?),
                icon_url = COALESCE(icon_url, ?)
              WHERE id = ?
            `).run(row.use_count, row.verified, row.icon_url, existingId);
          } else {
            upsert.run(row);
            mergeServerSources(db, row.id, 'smithery');
          }
        }
      });

      insertBatch(data.servers);
      totalUpserted += data.servers.length;

      hasMore = page < (data.pagination?.totalPages ?? 0);
      page++;

      if (hasMore) await delay(100);
    }

    updateSyncLog(db, 'smithery', totalUpserted);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateSyncLog(db, 'smithery', totalUpserted, 'error', msg);
    process.stderr.write(`[mcpfinder] Smithery sync error: ${msg}\n`);
  }

  return totalUpserted;
}

// ─── Deduplication Helpers ──────────────────────────────────────────────────

/**
 * Strip common MCP-ish prefixes/suffixes and non-alnum chars so that
 * `mcp-foo-server`, `foo-mcp`, `foo_server` and `Foo Server` all collapse
 * to the same token. Used to rescue monorepo matches when one side has no
 * package_identifier.
 */
function canonicalNameToken(s: string): string {
  if (!s) return '';
  let t = s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  for (;;) {
    const before = t;
    t = t.replace(/^(mcp|server)+/, '').replace(/(mcp|server)+$/, '');
    if (t === before) break;
  }
  return t;
}

/**
 * Find an existing server that should be considered "the same project" as the
 * candidate row. Tried keys, in decreasing reliability:
 *   1. Canonical repo key (`owner/repo` on github/gitlab/bitbucket/codeberg).
 *      When the repo hosts a monorepo (>1 existing row share it), we require a
 *      secondary signal — package_identifier, slug, or canonicalized name token —
 *      before merging. If the monorepo is ambiguous we skip, to avoid the bug
 *      where `waystation-ai/mcp` (12 distinct Official servers) would eat any
 *      incoming Glama/Smithery entry pointing at the same repo.
 *   2. `(package_identifier, registry_type)` — deterministic match when both
 *      sides ship the same package.
 *   3. Slug (only when unique) — weakest, but catches cases where neither URL
 *      nor package id exists.
 */
function findExistingServer(
  db: Database.Database,
  repoUrl: string | null,
  packageIdentifier: string | null,
  registryType: string | null,
  slug: string,
  name?: string | null,
): string | null {
  // 1) Repo URL match with monorepo disambiguation
  const repoKey = extractRepoKey(repoUrl);
  if (repoKey) {
    const tail = `/${repoKey}`;
    const candidates = db
      .prepare(
        `SELECT id, slug, name, package_identifier
         FROM servers
         WHERE LOWER(repository_url) LIKE ? OR LOWER(repository_url) LIKE ?`,
      )
      .all(`%${tail}`, `%${tail}.git`) as Array<{
      id: string;
      slug: string;
      name: string;
      package_identifier: string | null;
    }>;

    if (candidates.length === 1) return candidates[0].id;

    if (candidates.length > 1) {
      // Monorepo: need a secondary match inside the group
      if (packageIdentifier) {
        const hit = candidates.find(
          (c) =>
            c.package_identifier &&
            c.package_identifier.toLowerCase() === packageIdentifier.toLowerCase(),
        );
        if (hit) return hit.id;
      }
      if (slug) {
        const hit = candidates.find((c) => c.slug === slug);
        if (hit) return hit.id;
      }
      if (name) {
        const token = canonicalNameToken(name);
        if (token) {
          const hit = candidates.find((c) => {
            const ct = canonicalNameToken(c.name);
            return ct && (ct === token || ct.endsWith(token) || token.endsWith(ct));
          });
          if (hit) return hit.id;
        }
      }
      // Ambiguous — don't merge, safer to keep as a new row
      return null;
    }
  }

  // 2) Package identifier (+ registry type)
  if (packageIdentifier) {
    const row = db
      .prepare(
        `SELECT id FROM servers
         WHERE LOWER(package_identifier) = LOWER(?)
           AND (? IS NULL OR registry_type IS NULL OR registry_type = ?)
         LIMIT 1`,
      )
      .get(packageIdentifier, registryType, registryType) as { id: string } | undefined;
    if (row) return row.id;
  }

  // 3) Slug — require uniqueness within the DB to avoid tying unrelated servers
  if (slug) {
    const rows = db
      .prepare('SELECT id FROM servers WHERE slug = ? AND source != ? LIMIT 2')
      .all(slug, 'unknown') as Array<{ id: string }>;
    if (rows.length === 1) return rows[0].id;
  }

  return null;
}

/**
 * Smithery-specific heuristic: the Official registry re-publishes many Smithery
 * servers under `ai.smithery/<qualifiedName with / → ->`. If we see Smithery
 * `owner/name`, try that exact Official id first — it is by far the most common
 * cross-registry link and no other signal in Smithery carries it.
 */
function findOfficialFromSmitheryQualifiedName(
  db: Database.Database,
  qualifiedName: string | null | undefined,
): string | null {
  if (!qualifiedName) return null;
  const tail = qualifiedName.toLowerCase().replace(/\//g, '-').replace(/[^a-z0-9-]/g, '');
  if (!tail) return null;
  const row = db
    .prepare(
      `SELECT id FROM servers
       WHERE LOWER(name) = ? AND source = 'official'
       LIMIT 1`,
    )
    .get(`ai.smithery/${tail}`) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Merge a source into a server's sources list.
 */
function mergeServerSources(db: Database.Database, serverId: string, newSource: string): void {
  const row = db.prepare('SELECT sources FROM servers WHERE id = ?').get(serverId) as
    | { sources: string }
    | undefined;
  if (!row) return;

  let existing: string[];
  try {
    existing = JSON.parse(row.sources || '[]');
  } catch {
    existing = [];
  }

  const merged = mergeSources(existing, newSource);
  db.prepare('UPDATE servers SET sources = ? WHERE id = ?').run(JSON.stringify(merged), serverId);
}

/**
 * Merge richer data from a new source into an existing server.
 * Only updates fields that are currently empty/null with non-empty values.
 */
function mergeServerData(
  db: Database.Database,
  existingId: string,
  newRow: Record<string, unknown>,
): void {
  const existing = db.prepare('SELECT * FROM servers WHERE id = ?').get(existingId) as Record<string, unknown> | undefined;
  if (!existing) return;

  const updates: string[] = [];
  const values: unknown[] = [];

  // Merge description (prefer longer)
  if (
    typeof newRow.description === 'string' &&
    newRow.description.length > ((existing.description as string) || '').length
  ) {
    updates.push('description = ?');
    values.push(newRow.description);
  }

  // Merge nullable text fields
  const textFields = ['repository_url', 'remote_url', 'icon_url', 'transport_type', 'registry_type', 'package_identifier'];
  for (const f of textFields) {
    if (newRow[f] && !existing[f]) {
      updates.push(`${f} = ?`);
      values.push(newRow[f]);
    }
  }

  // Prefer newer updated/published dates when available
  if (typeof newRow.updated_at === 'string' && (!existing.updated_at || String(newRow.updated_at) > String(existing.updated_at))) {
    updates.push('updated_at = ?');
    values.push(newRow.updated_at);
  }
  if (typeof newRow.published_at === 'string' && !existing.published_at) {
    updates.push('published_at = ?');
    values.push(newRow.published_at);
  }

  // Merge env vars arrays rather than keeping only one source.
  if (typeof newRow.env_vars === 'string') {
    const mergedEnvVars = mergeJsonArrayStrings(existing.env_vars, newRow.env_vars, 'name');
    if (mergedEnvVars) {
      updates.push('env_vars = ?');
      values.push(mergedEnvVars);
    }
  }

  // Preserve source-specific raw payloads so search/details can extract tools later.
  const mergedRawData = mergeRawData(existing.raw_data, newRow.raw_data, String(newRow.source || 'unknown'));
  if (mergedRawData) {
    updates.push('raw_data = ?');
    values.push(mergedRawData);
  }

  if (updates.length > 0) {
    values.push(existingId);
    db.prepare(`UPDATE servers SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }
}

function mergeJsonArrayStrings(
  existingJson: unknown,
  incomingJson: unknown,
  key: string,
): string | null {
  try {
    const existing = Array.isArray(JSON.parse(String(existingJson || '[]')))
      ? JSON.parse(String(existingJson || '[]')) as Array<Record<string, unknown>>
      : [];
    const incoming = Array.isArray(JSON.parse(String(incomingJson || '[]')))
      ? JSON.parse(String(incomingJson || '[]')) as Array<Record<string, unknown>>
      : [];

    const merged = new Map<string, Record<string, unknown>>();
    for (const item of [...existing, ...incoming]) {
      const itemKey = typeof item?.[key] === 'string' ? String(item[key]) : JSON.stringify(item);
      const prev = merged.get(itemKey) || {};
      merged.set(itemKey, { ...prev, ...item });
    }
    return JSON.stringify([...merged.values()]);
  } catch {
    return null;
  }
}

function mergeRawData(existingRaw: unknown, incomingRaw: unknown, incomingSource: string): string | null {
  try {
    const existingParsed = existingRaw ? JSON.parse(String(existingRaw)) : null;
    const incomingParsed = incomingRaw ? JSON.parse(String(incomingRaw)) : null;
    const existingEnvelope: { primary: unknown; bySource: Record<string, unknown> } = isRawEnvelope(existingParsed)
      ? existingParsed
      : {
          primary: existingParsed,
          bySource: {} as Record<string, unknown>,
        };

    if (incomingParsed) {
      existingEnvelope.bySource[incomingSource] = incomingParsed;
      if (!existingEnvelope.primary) existingEnvelope.primary = incomingParsed;
    }

    return JSON.stringify(existingEnvelope);
  } catch {
    return null;
  }
}

function isRawEnvelope(value: unknown): value is { primary: unknown; bySource: Record<string, unknown> } {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'bySource' in value &&
      value.bySource &&
      typeof (value as { bySource: unknown }).bySource === 'object',
  );
}

// ─── Utility Functions ──────────────────────────────────────────────────────

/**
 * Check if sync is needed (no data or stale data).
 */
export function isSyncNeeded(db: Database.Database, maxAgeMinutes: number = 15): boolean {
  const lastSync = getLastSyncTimestamp(db, 'official');
  if (!lastSync) return true;

  const lastSyncDate = new Date(lastSync);
  const now = new Date();
  const diffMinutes = (now.getTime() - lastSyncDate.getTime()) / (1000 * 60);

  return diffMinutes >= maxAgeMinutes;
}

/**
 * Get total server count in the database.
 */
export function getServerCount(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM servers').get() as { count: number };
  return row.count;
}
