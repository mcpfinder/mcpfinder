/**
 * Build-time enrichment passes. These are costly probes that fit inside a
 * cron-driven snapshot builder (GitHub Actions) but shouldn't run in the
 * latency-sensitive client sync path.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { SqlParam } from './db.js';

export interface EnrichResult {
  probed: number;
  repoFound: number;
  merged: number;
  rateLimited: number;
  errors: number;
  durationMs: number;
}

/**
 * GitHub signals rate limiting with HTTP 403 or 429 plus either an exhausted
 * `x-ratelimit-remaining: 0` header (primary limit) or a `retry-after` header
 * (secondary / abuse limit). A 403 *without* those is a genuine error — a
 * blocked, suspended, or DMCA'd repo — not a rate limit.
 *
 * The previous check tested the regex `/rate/i` against the *value* of
 * `x-ratelimit-remaining`, which is always a number, so it never matched and
 * every rate-limited 403 was miscounted as an error.
 */
function isGitHubRateLimited(res: Response): boolean {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  return res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after');
}

/**
 * For every Smithery-only row whose `qualifiedName` looks like `owner/name`
 * but has no `repository_url`, probe GitHub for `github.com/owner/name`. If
 * the repo exists, record the URL and try to merge with an existing row that
 * already points at the same repo (typically from the Official registry).
 *
 * Requires a GitHub token (`GITHUB_TOKEN` in CI) — without it the
 * unauthenticated 60/hr limit will blow through after a minute. If no token
 * is present, the pass no-ops and returns zeros with a note in stderr.
 *
 * Safe to run multiple times: once a row has `repository_url` set it is
 * skipped on subsequent passes.
 */
export async function enrichSmitheryRepoUrls(
  db: DatabaseSync,
  opts: { token?: string; concurrency?: number; limit?: number } = {},
): Promise<EnrichResult> {
  const token = opts.token ?? process.env.GITHUB_TOKEN;
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 8, 16));
  const t0 = Date.now();
  const stats: EnrichResult = {
    probed: 0,
    repoFound: 0,
    merged: 0,
    rateLimited: 0,
    errors: 0,
    durationMs: 0,
  };

  if (!token) {
    process.stderr.write(
      '[enrich] GITHUB_TOKEN not set — skipping Smithery repo enrichment (unauth limit would throttle).\n',
    );
    stats.durationMs = Date.now() - t0;
    return stats;
  }

  // Candidates: primary=smithery, no repo URL, qualifiedName has `owner/name`
  const candidatesSql = `
    SELECT id, raw_data, slug, name, package_identifier, registry_type
    FROM servers
    WHERE source = 'smithery'
      AND (repository_url IS NULL OR repository_url = '')
    ${opts.limit ? `LIMIT ${opts.limit}` : ''}
  `;
  const rows = db.prepare(candidatesSql).all() as Array<{
    id: string;
    raw_data: string;
    slug: string;
    name: string;
    package_identifier: string | null;
    registry_type: string | null;
  }>;

  const queue: Array<{ id: string; owner: string; repo: string; slug: string; name: string }> = [];
  for (const r of rows) {
    let qn: string | null = null;
    try {
      const raw = JSON.parse(r.raw_data || '{}');
      qn = raw?.qualifiedName ?? null;
    } catch {
      /* ignore */
    }
    if (!qn || !qn.includes('/')) continue;
    const [owner, repo] = qn.split('/', 2);
    if (!owner || !repo) continue;
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(owner) || !/^[a-z0-9._-]+$/i.test(repo)) continue;
    queue.push({ id: r.id, owner, repo, slug: r.slug, name: r.name });
  }

  stats.probed = queue.length;
  if (queue.length === 0) {
    stats.durationMs = Date.now() - t0;
    return stats;
  }

  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'mcpfinder-builder',
  };

  const findByRepoUrl = db.prepare(
    `SELECT id FROM servers
     WHERE LOWER(repository_url) = ?
       AND id != ?
     LIMIT 1`,
  );
  const findMonorepoSiblings = db.prepare(
    `SELECT id, slug, name, package_identifier
     FROM servers
     WHERE LOWER(repository_url) = ?
       AND id != ?`,
  );
  const updateRepo = db.prepare('UPDATE servers SET repository_url = ? WHERE id = ?');
  const deleteRow = db.prepare('DELETE FROM servers WHERE id = ?');

  async function probeOne(item: (typeof queue)[number]): Promise<void> {
    const repoUrl = `https://github.com/${item.owner}/${item.repo}`.toLowerCase();
    try {
      const res = await fetch(`https://api.github.com/repos/${item.owner}/${item.repo}`, { headers });
      if (isGitHubRateLimited(res)) {
        stats.rateLimited++;
        return;
      }
      if (res.status === 404) return; // repo doesn't exist
      if (!res.ok) {
        stats.errors++;
        return;
      }
      stats.repoFound++;

      // Record the repo URL on the Smithery row
      updateRepo.run(repoUrl, item.id);

      // Try to merge with an existing row pointing at the same repo
      const exact = findByRepoUrl.get(repoUrl, item.id) as { id: string } | undefined;
      if (exact) {
        mergeInto(db, exact.id, item.id);
        deleteRow.run(item.id);
        stats.merged++;
        return;
      }

      // Try monorepo siblings — need secondary disambiguation
      const siblings = findMonorepoSiblings.all(repoUrl, item.id) as Array<{
        id: string;
        slug: string;
        name: string;
        package_identifier: string | null;
      }>;
      if (siblings.length === 0) return;
      const byPkg = item.name && siblings.find((s) => s.name?.toLowerCase() === item.name.toLowerCase());
      const bySlug = siblings.find((s) => s.slug === item.slug);
      const winner = byPkg ?? bySlug;
      if (winner) {
        mergeInto(db, winner.id, item.id);
        deleteRow.run(item.id);
        stats.merged++;
      }
    } catch {
      stats.errors++;
    }
  }

  // Run with fixed concurrency
  let idx = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push(
      (async () => {
        while (idx < queue.length) {
          const my = idx++;
          await probeOne(queue[my]);
        }
      })(),
    );
  }
  await Promise.all(workers);

  stats.durationMs = Date.now() - t0;
  return stats;
}

/**
 * Probe external sources to flag servers that are end-of-life:
 *
 *   - npm: fetches `registry.npmjs.org/<pkg>` and marks rows whose latest
 *     version carries a `deprecated` string.
 *   - GitHub: fetches `api.github.com/repos/<owner>/<name>` and marks rows
 *     whose repo is `archived`.
 *
 * Each row's `deprecated_npm` / `archived_repo` column becomes 0 (clean after
 * probe) or 1 (flagged), and `*_checked_at` records the probe time.
 *
 * The probe is incremental: a row is (re)probed only when it has never been
 * flagged, has no probe timestamp, or its timestamp is older than the
 * staleness window. Each pass is capped at `maxProbes` rows — the snapshot
 * builder carries flags across rebuilds (see `carryOverFlags` in
 * build-snapshot.mjs), so the whole corpus is refreshed on a rolling basis
 * within the GitHub API budget instead of re-scanning 25k repos every run.
 * A `GITHUB_TOKEN` is required for the archived-repo pass.
 */
export interface DeprecationEnrichResult {
  npm: EnrichResult & { flagged: number };
  github: EnrichResult & { flagged: number };
}

/**
 * Default rolling re-probe windows and per-run caps. GITHUB_MAX_PROBES stays
 * under the Actions GITHUB_TOKEN budget (~1000 REST req/hr), and the modest
 * default GitHub concurrency keeps the request rate under GitHub's per-minute
 * secondary limit. At 4 runs/day the whole corpus refreshes well inside the
 * 30-day window.
 */
const NPM_STALE_DAYS = 14;
const NPM_MAX_PROBES = 4000;
const GITHUB_STALE_DAYS = 30;
const GITHUB_MAX_PROBES = 800;
const GITHUB_CONCURRENCY = 4;

export async function enrichDeprecationFlags(
  db: DatabaseSync,
  opts: {
    token?: string;
    npmConcurrency?: number;
    githubConcurrency?: number;
    npmStaleDays?: number;
    githubStaleDays?: number;
    npmMaxProbes?: number;
    githubMaxProbes?: number;
  } = {},
): Promise<DeprecationEnrichResult> {
  const token = opts.token ?? process.env.GITHUB_TOKEN;
  const npmConcurrency = Math.max(1, Math.min(opts.npmConcurrency ?? 24, 64));
  const githubConcurrency = Math.max(1, Math.min(opts.githubConcurrency ?? GITHUB_CONCURRENCY, 16));

  const npm = await probeNpmDeprecations(db, {
    concurrency: npmConcurrency,
    staleDays: opts.npmStaleDays ?? NPM_STALE_DAYS,
    maxProbes: opts.npmMaxProbes ?? NPM_MAX_PROBES,
  });
  const github = await probeGitHubArchived(db, {
    token,
    concurrency: githubConcurrency,
    staleDays: opts.githubStaleDays ?? GITHUB_STALE_DAYS,
    maxProbes: opts.githubMaxProbes ?? GITHUB_MAX_PROBES,
  });

  return { npm, github };
}

/**
 * Build the WHERE/ORDER/LIMIT tail shared by both deprecation probes: select
 * rows whose flag is unknown, untimestamped, or stale, prioritising
 * never-flagged rows, then never-timestamped, then the oldest timestamp.
 */
function staleSelectionClause(flagCol: string, checkedAtCol: string): string {
  return `(
           ${flagCol} IS NULL
           OR ${checkedAtCol} IS NULL
           OR ${checkedAtCol} < @cutoff
         )
       ORDER BY (${flagCol} IS NOT NULL),
                (${checkedAtCol} IS NOT NULL),
                ${checkedAtCol} ASC
       LIMIT @maxProbes`;
}

async function probeNpmDeprecations(
  db: DatabaseSync,
  opts: { concurrency: number; staleDays: number; maxProbes: number },
): Promise<EnrichResult & { flagged: number }> {
  const t0 = Date.now();
  const stats = { probed: 0, repoFound: 0, merged: 0, rateLimited: 0, errors: 0, durationMs: 0, flagged: 0 };

  const cutoff = new Date(Date.now() - opts.staleDays * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT id, package_identifier
       FROM servers
       WHERE registry_type = 'npm'
         AND package_identifier IS NOT NULL
         AND package_identifier != ''
         AND ${staleSelectionClause('deprecated_npm', 'deprecated_npm_checked_at')}`,
    )
    .all({ cutoff, maxProbes: opts.maxProbes }) as Array<{ id: string; package_identifier: string }>;

  if (rows.length === 0) {
    stats.durationMs = Date.now() - t0;
    return stats;
  }

  const update = db.prepare(
    'UPDATE servers SET deprecated_npm = ?, deprecated_npm_checked_at = ? WHERE id = ?',
  );
  const headers = { 'user-agent': 'mcpfinder-builder', accept: 'application/json' };

  async function probe(row: (typeof rows)[number]): Promise<void> {
    stats.probed++;
    const now = new Date().toISOString();
    try {
      const encoded = encodeURIComponent(row.package_identifier).replace(/%40/g, '@');
      const res = await fetch(`https://registry.npmjs.org/${encoded}`, { headers });
      if (res.status === 429) {
        stats.rateLimited++;
        return;
      }
      if (res.status === 404) {
        update.run(1, now, row.id); // package gone from npm = treat as deprecated
        stats.flagged++;
        return;
      }
      if (!res.ok) {
        stats.errors++;
        return;
      }
      const data = (await res.json()) as {
        'dist-tags'?: { latest?: string };
        versions?: Record<string, { deprecated?: string }>;
        time?: { unpublished?: unknown };
      };
      const latest = data['dist-tags']?.latest;
      const deprecated = Boolean(
        data.time?.unpublished || (latest && data.versions?.[latest]?.deprecated),
      );
      update.run(deprecated ? 1 : 0, now, row.id);
      if (deprecated) stats.flagged++;
    } catch {
      stats.errors++;
    }
  }

  let idx = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < opts.concurrency; w++) {
    workers.push(
      (async () => {
        while (idx < rows.length) {
          const my = idx++;
          await probe(rows[my]);
        }
      })(),
    );
  }
  await Promise.all(workers);

  stats.durationMs = Date.now() - t0;
  return stats;
}

async function probeGitHubArchived(
  db: DatabaseSync,
  opts: { token?: string; concurrency: number; staleDays: number; maxProbes: number },
): Promise<EnrichResult & { flagged: number }> {
  const t0 = Date.now();
  const stats = { probed: 0, repoFound: 0, merged: 0, rateLimited: 0, errors: 0, durationMs: 0, flagged: 0 };

  if (!opts.token) {
    process.stderr.write(
      '[enrich] GITHUB_TOKEN not set — skipping archived-repo enrichment (unauth limit would throttle).\n',
    );
    stats.durationMs = Date.now() - t0;
    return stats;
  }

  const cutoff = new Date(Date.now() - opts.staleDays * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT id, repository_url
       FROM servers
       WHERE repository_url LIKE 'https://github.com/%'
         AND ${staleSelectionClause('archived_repo', 'archived_repo_checked_at')}`,
    )
    .all({ cutoff, maxProbes: opts.maxProbes }) as Array<{ id: string; repository_url: string }>;

  if (rows.length === 0) {
    stats.durationMs = Date.now() - t0;
    return stats;
  }

  const headers = {
    authorization: `Bearer ${opts.token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'mcpfinder-builder',
  };
  const update = db.prepare(
    'UPDATE servers SET archived_repo = ?, archived_repo_checked_at = ? WHERE id = ?',
  );
  // Once the API budget is exhausted, hammering the remaining rows just earns
  // more 403s — stop launching probes and let the next run pick them up.
  let rateLimitHit = false;

  async function probe(row: (typeof rows)[number]): Promise<void> {
    const now = new Date().toISOString();
    const m = row.repository_url.match(/^https:\/\/github\.com\/([^/]+)\/([^/#?]+)/i);
    if (!m) {
      // Unparseable owner/repo — can't probe; mark clean + timestamped so the
      // row ages out of the selection instead of being retried every run.
      update.run(0, now, row.id);
      return;
    }
    const [, owner, repoRaw] = m;
    const repo = repoRaw.replace(/\.git$/, '');
    stats.probed++;
    try {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
      if (isGitHubRateLimited(res)) {
        rateLimitHit = true;
        stats.rateLimited++;
        return;
      }
      if (res.status === 404) {
        update.run(1, now, row.id); // repo gone = treat as archived
        stats.flagged++;
        return;
      }
      if (!res.ok) {
        stats.errors++;
        return;
      }
      const data = (await res.json()) as { archived?: boolean };
      const archived = Boolean(data.archived);
      update.run(archived ? 1 : 0, now, row.id);
      if (archived) stats.flagged++;
    } catch {
      stats.errors++;
    }
  }

  let idx = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < opts.concurrency; w++) {
    workers.push(
      (async () => {
        while (idx < rows.length && !rateLimitHit) {
          const my = idx++;
          await probe(rows[my]);
        }
      })(),
    );
  }
  await Promise.all(workers);

  stats.durationMs = Date.now() - t0;
  return stats;
}

/**
 * Merge the `from` row into the `to` row: union sources, pick longer description,
 * fill in null fields, carry over use_count/verified/icon_url where present.
 */
function mergeInto(db: DatabaseSync, toId: string, fromId: string): void {
  const to = db.prepare('SELECT * FROM servers WHERE id = ?').get(toId) as Record<string, unknown>;
  const from = db.prepare('SELECT * FROM servers WHERE id = ?').get(fromId) as Record<string, unknown>;
  if (!to || !from) return;

  let toSources: string[] = [];
  let fromSources: string[] = [];
  try {
    toSources = JSON.parse((to.sources as string) || '[]');
    fromSources = JSON.parse((from.sources as string) || '[]');
  } catch {
    /* noop */
  }
  const mergedSources = [...new Set([...toSources, ...fromSources])].sort();

  const updates: string[] = ['sources = ?'];
  const vals: unknown[] = [JSON.stringify(mergedSources)];

  if (
    typeof from.description === 'string' &&
    (from.description as string).length > ((to.description as string) || '').length
  ) {
    updates.push('description = ?');
    vals.push(from.description);
  }

  const fillIfNull = [
    'repository_url',
    'remote_url',
    'icon_url',
    'transport_type',
    'registry_type',
    'package_identifier',
    'repository_source',
    'published_at',
    'updated_at',
  ];
  for (const f of fillIfNull) {
    if (from[f] && !to[f]) {
      updates.push(`${f} = ?`);
      vals.push(from[f]);
    }
  }

  // Popularity-ish fields: take max
  for (const f of ['use_count', 'verified', 'has_remote']) {
    const fromN = Number(from[f] ?? 0);
    const toN = Number(to[f] ?? 0);
    if (fromN > toN) {
      updates.push(`${f} = ?`);
      vals.push(fromN);
    }
  }

  vals.push(toId);
  db.prepare(`UPDATE servers SET ${updates.join(', ')} WHERE id = ?`).run(...(vals as SqlParam[]));
}
