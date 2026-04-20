/**
 * Build-time enrichment passes. These are costly probes that fit inside a
 * cron-driven snapshot builder (GitHub Actions) but shouldn't run in the
 * latency-sensitive client sync path.
 */
import type Database from 'better-sqlite3';

export interface EnrichResult {
  probed: number;
  repoFound: number;
  merged: number;
  rateLimited: number;
  errors: number;
  durationMs: number;
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
  db: Database.Database,
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
      if (res.status === 403 && /rate/i.test(res.headers.get('x-ratelimit-remaining') ?? '')) {
        stats.rateLimited++;
        return;
      }
      if (res.status === 429) {
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
 * Merge the `from` row into the `to` row: union sources, pick longer description,
 * fill in null fields, carry over use_count/verified/icon_url where present.
 */
function mergeInto(db: Database.Database, toId: string, fromId: string): void {
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
  db.prepare(`UPDATE servers SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
}
