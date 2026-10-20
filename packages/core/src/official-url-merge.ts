/**
 * Merge Official Registry entries that publish the same remote MCP endpoint.
 *
 * Some publishers list one hosted endpoint under two Official Registry names
 * (a re-namespaced re-publish, a fork of an Apify actor listing, a partner
 * listing next to the vendor's own). Both rows then point at the same server.
 * This pass drops one row of such a pair, under a deliberately conservative
 * rule:
 *
 * - URLs compare by normalizeRemoteUrlKey: scheme-insensitive, lowercase host,
 *   no default port, no trailing slash; path and query stay significant.
 * - Only groups of exactly two rows, both carrying the `official` source.
 * - Templated URLs (`{hostname}/mcp`) are skipped: different deployments.
 * - The pair must look related: a shared publisher token (registry namespace
 *   or GitHub owner), near-identical descriptions, or the same server name
 *   with somewhat similar descriptions. Otherwise it is skipped and reported.
 * - The dropped row must be Official-only (`sources = ["official"]`), so no
 *   other source's payload is lost, and must not be the only active row of
 *   the pair.
 *
 * The kept row is left as it is (its `sources` already include `official`); no
 * fields are copied over, so every field keeps its raw_data provenance. The
 * dropped entry's name no longer resolves.
 *
 * It runs once, at snapshot build time (scripts/build-snapshot.mjs), on a
 * catalog built from scratch. It is not part of a client's incremental sync:
 * a merge cannot be undone, and an incremental crawl only sees entries that
 * changed. A client gets the merged catalog by adopting the snapshot.
 */
import type { DatabaseSync } from 'node:sqlite';
import { normalizeRemoteUrlKey } from './remote-url.js';

interface CandidateRow {
  id: string;
  name: string;
  description: string;
  remote_url: string;
  repository_url: string | null;
  package_identifier: string | null;
  env_vars: string | null;
  sources: string;
  status: string | null;
  updated_at: string | null;
}

export interface OfficialUrlMergeResult {
  merged: Array<{ url: string; kept: string; removed: string }>;
  skipped: Array<{ url: string; ids: string[]; reason: 'templated-url' | 'group-larger-than-2' | 'unrelated' | 'would-drop-other-source' }>;
}

const GENERIC_TOKENS = new Set([
  'github', 'com', 'dev', 'app', 'net', 'org', 'xyz', 'site', 'www', 'mcp', 'api',
  'server', 'servers', 'cloud', 'tech', 'online', 'info', 'biz', 'gitlab',
]);

const TEMPLATE_RE = /[{}]|%7b|%7d/i;

function parseSources(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function githubOwner(url: string | null): string | null {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\//i.exec(url || '');
  return m ? m[1].toLowerCase() : null;
}

function publisherTokens(row: CandidateRow): Set<string> {
  const namespace = row.name.split('/')[0].toLowerCase();
  // Tokens of 3+ characters only: two-letter labels are TLDs and country
  // suffixes (`io`, `ai`, `uk`, `co`) that unrelated publishers share.
  const tokens = new Set(
    namespace.split(/[.\-_]/).filter((t) => t.length >= 3 && !GENERIC_TOKENS.has(t)),
  );
  const owner = githubOwner(row.repository_url);
  if (owner) tokens.add(owner);
  return tokens;
}

function nameToken(name: string): string {
  let t = (name.split('/').pop() || name).toLowerCase().replace(/[^a-z0-9]/g, '');
  for (;;) {
    const before = t;
    t = t.replace(/^(mcp|server)+/, '').replace(/(mcp|server)+$/, '');
    if (t === before) return t;
  }
}

function descriptionWords(description: string): Set<string> {
  return new Set((description.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length >= 4));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Exported for tests. */
export function looksRelated(a: CandidateRow, b: CandidateRow): boolean {
  const ta = publisherTokens(a);
  for (const t of publisherTokens(b)) if (ta.has(t)) return true;
  const similarity = jaccard(descriptionWords(a.description), descriptionWords(b.description));
  if (similarity >= 0.5) return true;
  const na = nameToken(a.name);
  return na.length > 0 && na === nameToken(b.name) && similarity >= 0.2;
}

function hasEnvVars(raw: string | null): boolean {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

/** Negative when `a` is the richer row. Deterministic (falls back to id). */
function compareRichness(a: CandidateRow, b: CandidateRow): number {
  const score = (r: CandidateRow) => [
    r.status === 'active' ? 1 : 0,
    parseSources(r.sources).length,
    r.package_identifier ? 1 : 0,
    r.repository_url ? 1 : 0,
    hasEnvVars(r.env_vars) ? 1 : 0,
    (r.description || '').length,
  ];
  const sa = score(a);
  const sb = score(b);
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sb[i] - sa[i];
  const ua = a.updated_at || '';
  const ub = b.updated_at || '';
  if (ua !== ub) return ua > ub ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function isOfficialOnly(row: CandidateRow): boolean {
  const sources = parseSources(row.sources);
  return sources.length === 1 && sources[0] === 'official';
}

/**
 * Run the pass on a freshly built catalog. Returns what was merged and what
 * was deliberately left alone.
 */
export function mergeSameRemoteOfficialEntries(db: DatabaseSync): OfficialUrlMergeResult {
  const rows = db.prepare(
    `SELECT id, name, description, remote_url, repository_url, package_identifier,
            env_vars, sources, status, updated_at
       FROM servers
      WHERE has_remote = 1 AND remote_url IS NOT NULL AND sources LIKE '%"official"%'`,
  ).all() as unknown as CandidateRow[];

  const groups = new Map<string, CandidateRow[]>();
  for (const row of rows) {
    if (!parseSources(row.sources).includes('official')) continue;
    // A templated host (`https://{hostname}/mcp`) does not parse as a URL;
    // group it by its literal text so it is reported as skipped.
    const key = normalizeRemoteUrlKey(row.remote_url) ??
      (TEMPLATE_RE.test(row.remote_url) ? row.remote_url.trim().toLowerCase() : null);
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const result: OfficialUrlMergeResult = { merged: [], skipped: [] };
  const remove = db.prepare('DELETE FROM servers WHERE id = ?');
  for (const [url, group] of [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (group.length < 2) continue;
    const ids = group.map((r) => r.id).sort();
    if (TEMPLATE_RE.test(url) || group.some((r) => TEMPLATE_RE.test(r.remote_url))) {
      result.skipped.push({ url, ids, reason: 'templated-url' });
      continue;
    }
    if (group.length > 2) {
      result.skipped.push({ url, ids, reason: 'group-larger-than-2' });
      continue;
    }
    const [a, b] = group;
    if (!looksRelated(a, b)) {
      result.skipped.push({ url, ids, reason: 'unrelated' });
      continue;
    }
    const [keep, drop] = compareRichness(a, b) <= 0 ? [a, b] : [b, a];
    if (!isOfficialOnly(drop)) {
      result.skipped.push({ url, ids, reason: 'would-drop-other-source' });
      continue;
    }
    remove.run(drop.id);
    result.merged.push({ url, kept: keep.id, removed: drop.id });
  }
  return result;
}
