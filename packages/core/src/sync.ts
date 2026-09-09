/**
 * Sync engine for fetching servers from multiple MCP registries:
 * - Official MCP Registry
 * - Glama (glama.ai)
 * - Smithery (registry.smithery.ai)
 */
import type { DatabaseSync } from 'node:sqlite';
import type {
  RegistryEnvVar,
  RegistryListResponse,
  RegistryServerEntry,
  GlamaListResponse,
  GlamaServer,
  SmitheryListResponse,
  SmitheryServer,
} from './types.js';
import {
  getLastSuccessfulSyncTimestamp,
  getLastSyncTimestamp,
  getSnapshotInstalledAt,
  updateSyncLog,
  transaction,
  checkpointWal,
} from './db.js';
import { extractKeywords } from './categories.js';
import { envVarsFromJsonSchema } from './env-vars.js';
import {
  assertBeforeDeadline,
  delay,
  fetchJsonPageWithRetry,
  RegistryTransportError,
} from './registry-fetch.js';
import type { RegistryRuntime } from './registry-fetch.js';
import { buildDedupIndex } from './dedup-index.js';
import { CrawlStaging } from './crawl-staging.js';
import {
  extractRepoKey,
  normalizeRepositoryUrl,
  repositorySource,
} from './repository-url.js';
import {
  validateGlamaPage,
  validateOfficialPage,
  validateSmitheryPage,
} from './registry-page-validation.js';
import { mergeServerData, mergeServerSources } from './server-merge.js';

const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io';
const GLAMA_BASE = 'https://glama.ai/api/mcp/v1';
const SMITHERY_BASE = 'https://registry.smithery.ai';
const PAGE_LIMIT = 100;

/**
 * Wall-clock budget per registry. A degraded upstream that keeps responding
 * just slowly enough to dodge the per-request timeout still can't drag the
 * snapshot build into its 90-minute CI ceiling. Official overrun fails the
 * build (a snapshot missing Official servers is worse than no new snapshot);
 * Glama/Smithery overrun discards the current staged crawl, leaves the local
 * last-known-good data unchanged, and records a degraded sync_log status. All
 * three are required sources, so any degradation blocks snapshot publication
 * (see scripts/snapshot-quality.mjs).
 */
const OFFICIAL_SYNC_BUDGET_MS = 8 * 60_000;
const DEFAULT_GLAMA_SYNC_BUDGET_MINUTES = 12;
const MAX_GLAMA_SYNC_BUDGET_MINUTES = 40;
const DEFAULT_SMITHERY_SYNC_BUDGET_MINUTES = 5;
const MAX_SMITHERY_SYNC_BUDGET_MINUTES = 15;

/**
 * Cross-page duplicates and exhausted page-level transport retries (5xx,
 * network/abort) are intermittent upstream faults: the same crawl repeated
 * after a pause often paginates cleanly. Three attempts at 500 ms then 1 s
 * still lost the 2026-09-03 and 2026-09-04 Smithery builds — `qualifiedName`
 * duplicates survived every restart — and the 2026-09-08 Glama HTTP 502 never
 * restarted the crawl at all: page-level retries exhausted,
 * `RegistryTransportError` aborted the sync, and the quality gate withheld
 * publication. Up to four attempts is what those failures needed; a missed
 * cycle still costs every consumer a day of staleness. Credentials (401/403),
 * HTTP 429 (already retried at page level; restarting from page one would
 * amplify load), and a crossed `RegistryDeadlineError` do not restart.
 */
const MAX_GLAMA_CRAWL_ATTEMPTS = 4;
const MAX_SMITHERY_CRAWL_ATTEMPTS = 4;

/**
 * Local stdio defaults to 500 ms / 1 s / 2 s so first-run live Glama+Smithery
 * sync stays inside the SDK's 60 s tool-call timeout. The snapshot job sets
 * `MCPFINDER_CRAWL_RESTART_BASE_MS=15000` (15 s / 30 s / 60 s): long enough
 * for a registry mid-reindex or a recovering edge, still small against a
 * multi-minute budget. Invalid or unbounded values fail closed. Restarts wait
 * only while the remaining registry budget covers the next delay; a sleep
 * that would miss the deadline rethrows the original fault rather than
 * reporting a budget overrun. Four attempts end the ladder at 4×base, so
 * there is no ceiling constant. Nor is there jitter — build-snapshot runs
 * Glama then Smithery sequentially under one `concurrency: snapshot` group.
 */
const DEFAULT_CRAWL_RESTART_BASE_MS = 500;
const MIN_CRAWL_RESTART_BASE_MS = 100;
const MAX_CRAWL_RESTART_BASE_MS = 60_000;

function getCrawlRestartBaseMs(): number {
  const raw = process.env.MCPFINDER_CRAWL_RESTART_BASE_MS;
  if (raw === undefined || raw === '') return DEFAULT_CRAWL_RESTART_BASE_MS;
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      'MCPFINDER_CRAWL_RESTART_BASE_MS must be an integer between ' +
        MIN_CRAWL_RESTART_BASE_MS +
        ' and ' +
        MAX_CRAWL_RESTART_BASE_MS,
    );
  }
  const ms = Number(raw);
  if (ms < MIN_CRAWL_RESTART_BASE_MS || ms > MAX_CRAWL_RESTART_BASE_MS) {
    throw new Error(
      'MCPFINDER_CRAWL_RESTART_BASE_MS must be an integer between ' +
        MIN_CRAWL_RESTART_BASE_MS +
        ' and ' +
        MAX_CRAWL_RESTART_BASE_MS,
    );
  }
  return ms;
}

function crawlRestartDelayMs(attempt: number, baseMs: number): number {
  return baseMs * 2 ** (attempt - 1);
}

function registryBudgetExceededMessage(
  source: string,
  budgetMinutes: number,
  staged: number,
): string {
  return (
    `${source} sync exceeded its ${budgetMinutes}-minute budget ` +
    `— discarded ${staged} staged servers; ` +
    'existing last-known-good database unchanged'
  );
}

// Smithery's unseeded reranker exposes only five pages. A fixed integer seed
// selects the documented stable deep-pagination path for the full catalogue.
const SMITHERY_PAGINATION_SEED = 20260820;

class SmitheryCrossPageDuplicateError extends Error {}
class GlamaCrossPageDuplicateError extends Error {}

function isTransientCrawlFault(
  err: unknown,
): err is
  | GlamaCrossPageDuplicateError
  | SmitheryCrossPageDuplicateError
  | RegistryTransportError {
  if (
    err instanceof GlamaCrossPageDuplicateError ||
    err instanceof SmitheryCrossPageDuplicateError
  ) {
    return true;
  }
  // 429 is retried at page level; restarting the whole crawl from page one
  // would re-issue every page against an upstream that just asked for less
  // traffic.
  return err instanceof RegistryTransportError && !/HTTP 429/.test(err.message);
}

/**
 * Restart after a transient crawl fault when another attempt remains and the
 * remaining budget covers the wait. Skipping a wait that would miss the
 * deadline rethrows the original error — that is not a budget overrun.
 * `registryBudgetExceededMessage` is only for the page-loop deadline.
 */
async function waitToRestartCrawl({
  err,
  crawlAttempt,
  maxAttempts,
  kind,
  restartBaseMs,
  now,
  deadline,
  runtime,
}: {
  err: unknown;
  crawlAttempt: number;
  maxAttempts: number;
  kind: 'cursor' | 'seeded';
  restartBaseMs: number;
  now: () => number;
  deadline: number;
  runtime: RegistryRuntime;
}): Promise<void> {
  if (!isTransientCrawlFault(err) || crawlAttempt >= maxAttempts) {
    throw err;
  }
  const wait = crawlRestartDelayMs(crawlAttempt, restartBaseMs);
  if (now() + wait >= deadline) {
    throw err;
  }
  const label = kind === 'cursor' ? 'cursor crawl' : 'seeded crawl';
  process.stderr.write(
    `[mcpfinder] ${err.message} — restarting ${label} (${crawlAttempt + 1}/${maxAttempts})\n`,
  );
  await delay(wait, runtime);
}

/**
 * Keep local stdio behavior at the historical 12-minute limit while allowing
 * the snapshot job to reserve more of its 90-minute ceiling for Glama. Reject
 * invalid values instead of silently turning a typo into an unbounded sync.
 */
function getGlamaSyncBudgetMinutes(): number {
  const raw = process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES;
  if (raw === undefined || raw === '') return DEFAULT_GLAMA_SYNC_BUDGET_MINUTES;
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      'MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES must be an integer between 1 and ' +
        MAX_GLAMA_SYNC_BUDGET_MINUTES,
    );
  }
  const minutes = Number(raw);
  if (minutes < 1 || minutes > MAX_GLAMA_SYNC_BUDGET_MINUTES) {
    throw new Error(
      'MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES must be an integer between 1 and ' +
        MAX_GLAMA_SYNC_BUDGET_MINUTES,
    );
  }
  return minutes;
}

/**
 * Smithery's five minutes covered a single ~109-page crawl with room to spare,
 * but not the four the restart budget now allows: the deadline would abort the
 * loop before the later attempts could run, making them dead code. Local stdio
 * keeps the historical five-minute limit; the snapshot job raises it. Reject
 * invalid values instead of silently turning a typo into an unbounded sync.
 */
function getSmitherySyncBudgetMinutes(): number {
  const raw = process.env.MCPFINDER_SMITHERY_SYNC_BUDGET_MINUTES;
  if (raw === undefined || raw === '') return DEFAULT_SMITHERY_SYNC_BUDGET_MINUTES;
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      'MCPFINDER_SMITHERY_SYNC_BUDGET_MINUTES must be an integer between 1 and ' +
        MAX_SMITHERY_SYNC_BUDGET_MINUTES,
    );
  }
  const minutes = Number(raw);
  if (minutes < 1 || minutes > MAX_SMITHERY_SYNC_BUDGET_MINUTES) {
    throw new Error(
      'MCPFINDER_SMITHERY_SYNC_BUDGET_MINUTES must be an integer between 1 and ' +
        MAX_SMITHERY_SYNC_BUDGET_MINUTES,
    );
  }
  return minutes;
}

/**
 * Glama closed its public API on 2026-08-26: `/api/mcp/v1/servers` answers 401
 * without a key minted at https://glama.ai/settings/api-keys. Verified against
 * the live API with a real key on 2026-08-26: `Authorization: Bearer <key>`
 * answers HTTP 200, while a bare `Authorization: <key>`, `x-api-key` and
 * `X-Api-Key` all answer 401. The key itself only ever reaches the request
 * header: it is never logged, persisted in raw_data, or written to the
 * snapshot manifest.
 */
function glamaAuthHeaders(): Record<string, string> | null {
  const key = process.env.GLAMA_API_KEY?.trim();
  if (!key) return null;
  return { authorization: `Bearer ${key}` };
}

export const GLAMA_MISSING_KEY_MESSAGE =
  'Glama API requires GLAMA_API_KEY; skipping Glama sync ' +
  '(create a key at https://glama.ai/settings/api-keys)';

/**
 * Generate a slug from a server name.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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
    repository_url: normalizeRepositoryUrl(s.repository?.url),
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
export async function syncOfficialRegistry(
  db: DatabaseSync,
  runtime: RegistryRuntime = {},
): Promise<number> {
  const lastSync = getLastSuccessfulSyncTimestamp(db, 'official');

  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  let totalUpserted = 0;
  const now = runtime.now ?? Date.now;
  const deadline = now() + OFFICIAL_SYNC_BUDGET_MS;

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
      remote_url = COALESCE(excluded.remote_url, servers.remote_url),
      has_remote = MAX(excluded.has_remote, servers.has_remote),
      last_synced_at = excluded.last_synced_at
  `);

  const staging = new CrawlStaging<RegistryServerEntry>(db, 'official');
  try {
    do {
      if (now() >= deadline) {
        throw new Error(
          `Official registry sync exceeded its ${OFFICIAL_SYNC_BUDGET_MS / 60_000}-minute budget ` +
            `(upstream too slow) — discarded ${staging.size} staged servers; ` +
            'existing last-known-good database unchanged',
        );
      }

      const url = new URL(`${REGISTRY_BASE}/v0.1/servers`);
      url.searchParams.set('version', 'latest');
      url.searchParams.set('limit', String(PAGE_LIMIT));
      if (lastSync) url.searchParams.set('updated_since', lastSync);
      if (cursor) url.searchParams.set('cursor', cursor);

      const { response: res, data, errorText } = await fetchJsonPageWithRetry<RegistryListResponse>(
        url.toString(),
        { label: 'Registry API', deadline, ...runtime },
      );
      if (!res.ok) {
        throw new Error(`Registry API error: ${res.status} ${res.statusText} — ${errorText ?? ''}`);
      }

      validateOfficialPage(data);
      const nextCursor = data.metadata.nextCursor || null;
      if (nextCursor && seenCursors.has(nextCursor)) {
        throw new Error(`Registry API: repeated metadata.nextCursor ${nextCursor}`);
      }
      if (nextCursor) seenCursors.add(nextCursor);
      staging.push(data.servers);
      cursor = nextCursor;
      if (cursor) await delay(100, runtime);
    } while (cursor);

    assertBeforeDeadline(deadline, runtime, 'Registry API');
    const existingIds = new Set(
      (db.prepare('SELECT id FROM servers').all() as Array<{ id: string }>).map((row) => row.id),
    );
    const applyCompletedCrawl = transaction(db, (entries: Iterable<RegistryServerEntry>) => {
      for (const entry of entries) {
        const row = normalizeOfficialEntry(entry);
        const existed = existingIds.has(row.id);
        upsert.run(row);
        if (existed) mergeServerData(db, row.id, row);
        existingIds.add(row.id);
        mergeServerSources(db, row.id, 'official');
      }
      assertBeforeDeadline(deadline, runtime, 'Registry API');
      // The log row commits with the rows it describes. Written after the
      // commit instead, a crash in the gap would leave a corpus that is
      // current but logged as never synced, and the next start would spend a
      // full crawl rebuilding data it already has.
      updateSyncLog(db, 'official', staging.size);
    });
    applyCompletedCrawl(staging.read());
    totalUpserted = staging.size;
    // The whole crawl landed in one transaction, so the WAL is now as big as
    // the write was. Trim it while the database is quiet — SQLite refuses to
    // checkpoint from inside an open transaction, so this stays out here.
    checkpointWal(db);
    return totalUpserted;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    totalUpserted = 0;
    // Outside the transaction by necessity: it has already rolled back, and a
    // write issued into a rolled-back transaction would vanish with it.
    updateSyncLog(db, 'official', 0, 'error', message);
    process.stderr.write(`[mcpfinder] Official sync error: ${message}\n`);
    throw error;
  } finally {
    staging.close();
  }
}

// ─── Glama Registry Sync ────────────────────────────────────────────────────

/**
 * Normalize a Glama server entry into our database row format.
 */
function normalizeGlamaEntry(entry: GlamaServer) {
  const name = entry.namespace ? `${entry.namespace}/${entry.name}` : entry.name;
  const slug = slugify(entry.slug || name);
  const keywords = extractKeywords(name, entry.description || '');

  // Extract env vars from JSON schema if present. The same mapping runs on the
  // merge path (server-merge.ts) so a deduplicated row keeps `default`,
  // `format` and the `writeOnly` secret flag the config generator needs.
  const envVars: RegistryEnvVar[] =
    envVarsFromJsonSchema(entry.environmentVariablesJsonSchema) ?? [];

  return {
    id: `glama:${entry.id}`,
    slug,
    name,
    description: entry.description || '',
    version: '',
    registry_type: null,
    package_identifier: null,
    transport_type: null,
    repository_url: normalizeRepositoryUrl(entry.repository?.url),
    repository_source: repositorySource(entry.repository?.url),
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
export async function syncGlamaRegistry(
  db: DatabaseSync,
  runtime: RegistryRuntime = {},
): Promise<number> {
  let totalUpserted = 0;
  let degradation: string | null = null;
  let budgetMinutes = DEFAULT_GLAMA_SYNC_BUDGET_MINUTES;
  let deadline = Number.POSITIVE_INFINITY;
  const now = runtime.now ?? Date.now;

  // Insert-only: the apply loop routes every id already present in `servers`
  // through mergeServerData, so this statement is reached exclusively for ids
  // the database has never seen. A UNIQUE violation here would mean that
  // invariant broke, and must abort (and roll back) the crawl rather than be
  // papered over by an ON CONFLICT branch that no longer does the merging.
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
  `);

  const authHeaders = glamaAuthHeaders();
  if (!authHeaders) {
    // Not a transient failure and not worth a request that can only 401.
    // Glama is a required source, so snapshot publication treats this
    // 'skipped' status as a gate failure; a local run can pass --no-glama.
    process.stderr.write(`[mcpfinder] ${GLAMA_MISSING_KEY_MESSAGE}\n`);
    updateSyncLog(db, 'glama', 0, 'skipped', GLAMA_MISSING_KEY_MESSAGE);
    return 0;
  }

  const staging = new CrawlStaging<GlamaServer>(db, 'glama');
  try {
    budgetMinutes = getGlamaSyncBudgetMinutes();
    deadline = now() + budgetMinutes * 60_000;
    const restartBaseMs = getCrawlRestartBaseMs();
    let crawlCompleted = false;
    crawlAttempts:
    for (let crawlAttempt = 1; crawlAttempt <= MAX_GLAMA_CRAWL_ATTEMPTS; crawlAttempt++) {
      let cursor: string | null = null;
      const seenCursors = new Set<string>();
      const seenServerIds = new Set<string>();
      staging.reset();

      try {
        while (true) {
          if (now() >= deadline) {
            degradation = registryBudgetExceededMessage('Glama', budgetMinutes, staging.size);
            process.stderr.write(`[mcpfinder] ${degradation}\n`);
            break crawlAttempts;
          }

          const url = new URL(`${GLAMA_BASE}/servers`);
          url.searchParams.set('first', String(PAGE_LIMIT));
          if (cursor) url.searchParams.set('after', cursor);

          const { response: res, data, errorText } =
            await fetchJsonPageWithRetry<GlamaListResponse>(url.toString(), {
              label: 'Glama API', deadline, headers: authHeaders, ...runtime,
            });
          if (res.status === 401 || res.status === 403) {
            // Credentials, not weather: never retried, and reported without
            // echoing the response body so no header value can leak.
            throw new Error(
              `Glama API rejected GLAMA_API_KEY: HTTP ${res.status} — ` +
                'the key is missing, expired, or lacks access',
            );
          }
          if (!res.ok) {
            throw new Error(`Glama API error: ${res.status} ${res.statusText} — ${errorText ?? ''}`);
          }

          validateGlamaPage(data);
          const pageServerIds = new Set<string>();
          for (const entry of data.servers) {
            if (typeof entry.id !== 'string' || entry.id.trim().length === 0) {
              throw new Error('Glama API: server id must be a non-empty string');
            }
            if (pageServerIds.has(entry.id)) {
              throw new Error(`Glama API: duplicate server id ${entry.id}`);
            }
            if (seenServerIds.has(entry.id)) {
              throw new GlamaCrossPageDuplicateError(
                `Glama API: cross-page duplicate server id ${entry.id}`,
              );
            }
            pageServerIds.add(entry.id);
          }
          for (const id of pageServerIds) seenServerIds.add(id);

          const nextCursor = data.pageInfo.hasNextPage ? data.pageInfo.endCursor! : null;
          if (nextCursor && seenCursors.has(nextCursor)) {
            throw new Error(`Glama API: repeated pageInfo.endCursor ${nextCursor}`);
          }
          if (nextCursor) seenCursors.add(nextCursor);
          staging.push(data.servers);

          if (!nextCursor) {
            crawlCompleted = true;
            break crawlAttempts;
          }
          cursor = nextCursor;
          await delay(100, runtime);
        }
      } catch (err) {
        await waitToRestartCrawl({
          err,
          crawlAttempt,
          maxAttempts: MAX_GLAMA_CRAWL_ATTEMPTS,
          kind: 'cursor',
          restartBaseMs,
          now,
          deadline,
          runtime,
        });
        continue;
      }
    }

    if (!degradation && !crawlCompleted) {
      throw new Error('Glama API: crawl ended without a validated terminal page');
    }
    if (!degradation && crawlCompleted) {
      assertBeforeDeadline(deadline, runtime, 'Glama API');
      const dedup = buildDedupIndex(db);
      assertBeforeDeadline(deadline, runtime, 'Glama API');
      const existingIds = new Set(
        (db.prepare('SELECT id FROM servers').all() as Array<{ id: string }>).map((row) => row.id),
      );
      const applyCompletedCrawl = transaction(db, (entries: Iterable<GlamaServer>) => {
        for (const entry of entries) {
          const row = normalizeGlamaEntry(entry);
          const stableIdMatch = existingIds.has(row.id);
          const existingId = stableIdMatch
            ? row.id
            : dedup.find(
                row.repository_url,
                row.package_identifier,
                row.registry_type,
                row.slug,
                row.name,
              );
          if (existingId) {
            mergeServerSources(db, existingId, 'glama');
            const mergedRow = mergeServerData(
              db,
              existingId,
              row,
              { stableIdRefresh: stableIdMatch },
            );
            if (stableIdMatch) dedup.refreshStable(existingId, (mergedRow ?? row) as typeof row);
            else dedup.merge(existingId, row);
          } else {
            upsert.run(row);
            mergeServerSources(db, row.id, 'glama');
            dedup.upsert(row);
            existingIds.add(row.id);
          }
        }
        assertBeforeDeadline(deadline, runtime, 'Glama API');
        // The log row commits with the rows it describes. Written after the
        // commit instead, a crash in the gap would leave a corpus that is
        // current but logged as never synced, and the next start would spend a
        // full crawl rebuilding data it already has.
        updateSyncLog(db, 'glama', staging.size);
      });
      applyCompletedCrawl(staging.read());
      totalUpserted = staging.size;
    }
    if (degradation) {
      // A degraded crawl applied nothing, so there is no transaction for this
      // row to be atomic with — only the clean 'ok' row above needs to be.
      updateSyncLog(db, 'glama', totalUpserted, 'error', degradation);
    }
    // One transaction per crawl means one WAL the size of the whole write.
    // SQLite refuses to checkpoint from inside an open transaction.
    if (!degradation) checkpointWal(db);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Outside the transaction by necessity: it has already rolled back, and a
    // write issued into a rolled-back transaction would vanish with it.
    updateSyncLog(db, 'glama', totalUpserted, 'error', msg);
    process.stderr.write(`[mcpfinder] Glama sync error: ${msg}\n`);
  } finally {
    staging.close();
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
  const repoUrl = homepageIsRepo ? normalizeRepositoryUrl(entry.homepage) : null;

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
    repository_source: homepageIsRepo ? repositorySource(entry.homepage) : null,
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
export async function syncSmitheryRegistry(
  db: DatabaseSync,
  runtime: RegistryRuntime = {},
): Promise<number> {
  let totalUpserted = 0;
  let degradation: string | null = null;
  let budgetMinutes = DEFAULT_SMITHERY_SYNC_BUDGET_MINUTES;
  let deadline = Number.POSITIVE_INFINITY;
  const now = runtime.now ?? Date.now;

  // Insert-only: the apply loop routes every id already present in `servers`
  // through mergeServerData, so this statement is reached exclusively for ids
  // the database has never seen. A UNIQUE violation here would mean that
  // invariant broke, and must abort (and roll back) the crawl rather than be
  // papered over by an ON CONFLICT branch that no longer does the merging.
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
  `);

  const staging = new CrawlStaging<SmitheryServer>(db, 'smithery');
  try {
    budgetMinutes = getSmitherySyncBudgetMinutes();
    deadline = now() + budgetMinutes * 60_000;
    const restartBaseMs = getCrawlRestartBaseMs();
    let crawlCompleted = false;
    crawlAttempts:
    for (let crawlAttempt = 1; crawlAttempt <= MAX_SMITHERY_CRAWL_ATTEMPTS; crawlAttempt++) {
      let page = 1;
      let shortPagePending = false;
      staging.reset();
      const seenQualifiedNames = new Set<string>();

      try {
        while (true) {
          if (now() >= deadline) {
            degradation = registryBudgetExceededMessage('Smithery', budgetMinutes, staging.size);
            process.stderr.write(`[mcpfinder] ${degradation}\n`);
            break crawlAttempts;
          }

          const url = new URL(`${SMITHERY_BASE}/servers`);
          url.searchParams.set('page', String(page));
          url.searchParams.set('pageSize', String(PAGE_LIMIT));
          url.searchParams.set('seed', String(SMITHERY_PAGINATION_SEED));

          const { response: res, data, errorText } =
            await fetchJsonPageWithRetry<SmitheryListResponse>(url.toString(), {
              label: 'Smithery API', deadline, ...runtime,
            });
          if (!res.ok) {
            throw new Error(
              `Smithery API error: ${res.status} ${res.statusText} — ${errorText ?? ''}`,
            );
          }

          validateSmitheryPage(data, page, PAGE_LIMIT);
          if (shortPagePending && data.servers.length > 0) {
            throw new Error(
              `Smithery API: non-empty page ${page} followed a short page; ` +
                'pagination is truncated or has a gap',
            );
          }

          const pageQualifiedNames = new Set<string>();
          for (const entry of data.servers) {
            if (typeof entry.qualifiedName !== 'string' || entry.qualifiedName.length === 0) {
              throw new Error('Smithery API: qualifiedName must be a non-empty string');
            }
            if (pageQualifiedNames.has(entry.qualifiedName)) {
              throw new Error(`Smithery API: duplicate qualifiedName ${entry.qualifiedName}`);
            }
            if (seenQualifiedNames.has(entry.qualifiedName)) {
              throw new SmitheryCrossPageDuplicateError(
                `Smithery API: cross-page duplicate qualifiedName ${entry.qualifiedName}`,
              );
            }
            pageQualifiedNames.add(entry.qualifiedName);
          }
          for (const qualifiedName of pageQualifiedNames) seenQualifiedNames.add(qualifiedName);

          if (data.servers.length === 0) {
            crawlCompleted = true;
            break crawlAttempts;
          }

          staging.push(data.servers);
          shortPagePending = data.servers.length < PAGE_LIMIT;
          page++;
          await delay(100, runtime);
        }
      } catch (err) {
        await waitToRestartCrawl({
          err,
          crawlAttempt,
          maxAttempts: MAX_SMITHERY_CRAWL_ATTEMPTS,
          kind: 'seeded',
          restartBaseMs,
          now,
          deadline,
          runtime,
        });
        continue;
      }
    }

    if (!degradation && !crawlCompleted) {
      throw new Error('Smithery API: crawl ended without a validated terminal page');
    }
    if (!degradation && crawlCompleted) {
      assertBeforeDeadline(deadline, runtime, 'Smithery API');
      const dedup = buildDedupIndex(db);
      assertBeforeDeadline(deadline, runtime, 'Smithery API');
      const existingIds = new Set(
        (db.prepare('SELECT id FROM servers').all() as Array<{ id: string }>).map((row) => row.id),
      );
      const applyCompletedCrawl = transaction(db, (entries: Iterable<SmitheryServer>) => {
        for (const entry of entries) {
          const row = normalizeSmitheryEntry(entry);
          // Prefer Official's ai.smithery/* mirror when it exists.
          const stableIdMatch = existingIds.has(row.id);
          const existingId = stableIdMatch
            ? row.id
            : dedup.findOfficialFromSmithery(entry.qualifiedName) ??
              dedup.find(
                row.repository_url,
                row.package_identifier,
                row.registry_type,
                row.slug,
                row.name,
              );
          if (existingId) {
            mergeServerSources(db, existingId, 'smithery');
            const mergedRow = mergeServerData(
              db,
              existingId,
              row,
              { stableIdRefresh: stableIdMatch },
            );
            if (stableIdMatch) dedup.refreshStable(existingId, (mergedRow ?? row) as typeof row);
            else dedup.merge(existingId, row);
          } else {
            upsert.run(row);
            mergeServerSources(db, row.id, 'smithery');
            dedup.upsert(row);
            existingIds.add(row.id);
          }
        }
        assertBeforeDeadline(deadline, runtime, 'Smithery API');
        // The log row commits with the rows it describes. Written after the
        // commit instead, a crash in the gap would leave a corpus that is
        // current but logged as never synced, and the next start would spend a
        // full crawl rebuilding data it already has.
        updateSyncLog(db, 'smithery', staging.size);
      });
      applyCompletedCrawl(staging.read());
      totalUpserted = staging.size;
    }
    if (degradation) {
      // A degraded crawl applied nothing, so there is no transaction for this
      // row to be atomic with — only the clean 'ok' row above needs to be.
      updateSyncLog(db, 'smithery', totalUpserted, 'error', degradation);
    }
    // One transaction per crawl means one WAL the size of the whole write.
    // SQLite refuses to checkpoint from inside an open transaction.
    if (!degradation) checkpointWal(db);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Outside the transaction by necessity: it has already rolled back, and a
    // write issued into a rolled-back transaction would vanish with it.
    updateSyncLog(db, 'smithery', totalUpserted, 'error', msg);
    process.stderr.write(`[mcpfinder] Smithery sync error: ${msg}\n`);
  } finally {
    staging.close();
  }

  return totalUpserted;
}

// ─── Utility Functions ──────────────────────────────────────────────────────

/**
 * Default freshness window for a DB installed from a hosted snapshot.
 * Override with MCPFINDER_SNAPSHOT_FRESH_MINUTES.
 */
export const DEFAULT_SNAPSHOT_FRESH_MINUTES = 360;

function minutesSince(iso: string | null): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  return (Date.now() - then) / (1000 * 60);
}

function snapshotFreshMinutes(): number {
  const raw = process.env.MCPFINDER_SNAPSHOT_FRESH_MINUTES;
  if (!raw) return DEFAULT_SNAPSHOT_FRESH_MINUTES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SNAPSHOT_FRESH_MINUTES;
}

/**
 * Check if sync is needed (no data or stale data).
 *
 * A DB installed from a hosted snapshot carries a `sync_log` written by the CI
 * builder, so its `official` timestamp is always older than `maxAgeMinutes` —
 * taken literally that would fire a full live sync seconds after a multi-MB
 * download. The install marker (source `snapshot`) therefore counts as a fresh
 * sync for its own, much longer window; once that expires the normal staleness
 * rule takes over again.
 */
export function isSyncNeeded(
  db: DatabaseSync,
  maxAgeMinutes: number = 15,
  snapshotMaxAgeMinutes: number = snapshotFreshMinutes(),
): boolean {
  const sinceSnapshot = minutesSince(getSnapshotInstalledAt(db));
  if (sinceSnapshot !== null && sinceSnapshot < snapshotMaxAgeMinutes) return false;

  const sinceSync = minutesSince(getLastSyncTimestamp(db, 'official'));
  if (sinceSync === null) return true;

  return sinceSync >= maxAgeMinutes;
}

/**
 * Get total server count in the database.
 */
export function getServerCount(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM servers').get() as { count: number };
  return row.count;
}
