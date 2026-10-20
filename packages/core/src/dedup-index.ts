import type { DatabaseSync } from 'node:sqlite';
import { extractRepoKey, storedRepoKey } from './repository-url.js';

export interface DedupRow {
  id: string;
  slug: string;
  name: string;
  package_identifier: string | null;
  registry_type: string | null;
  repository_url: string | null;
  source: string | null;
}

type IncomingRow = Omit<DedupRow, 'source'> & { source?: string | null };

function canonicalNameToken(value: string): string {
  if (!value) return '';
  let token = value.toLowerCase().replace(/[^a-z0-9]+/g, '');
  for (;;) {
    const before = token;
    token = token.replace(/^(mcp|server)+/, '').replace(/(mcp|server)+$/, '');
    if (token === before) return token;
  }
}

function append(index: Map<string, string[]>, key: string | null, id: string): void {
  if (!key) return;
  const ids = index.get(key);
  if (ids) ids.push(id);
  else index.set(key, [id]);
}

function remove(index: Map<string, string[]>, key: string | null, id: string): void {
  if (!key) return;
  const ids = index.get(key);
  if (!ids) return;
  const next = ids.filter((candidate) => candidate !== id);
  if (next.length) index.set(key, next);
  else index.delete(key);
}

export class DedupIndex {
  private readonly rows = new Map<string, DedupRow>();
  private readonly repos = new Map<string, string[]>();
  private readonly packages = new Map<string, string[]>();
  private readonly slugs = new Map<string, string[]>();

  constructor(rows: DedupRow[]) {
    for (const row of rows) this.replace(row);
  }

  private replace(row: DedupRow): void {
    const previous = this.rows.get(row.id);
    this.rows.set(row.id, row);
    const previousRepo = previous ? storedRepoKey(previous.repository_url) : null;
    const nextRepo = storedRepoKey(row.repository_url);
    const previousPackage = previous?.package_identifier?.toLowerCase() ?? null;
    const nextPackage = row.package_identifier?.toLowerCase() ?? null;
    const previousSlug = previous && previous.source !== null && previous.source !== 'unknown'
      ? previous.slug
      : null;
    const nextSlug = row.source !== null && row.source !== 'unknown' ? row.slug : null;
    for (const [index, before, after] of [
      [this.repos, previousRepo, nextRepo],
      [this.packages, previousPackage, nextPackage],
      [this.slugs, previousSlug, nextSlug],
    ] as Array<[Map<string, string[]>, string | null, string | null]>) {
      if (before === after) continue;
      remove(index, before, row.id);
      append(index, after, row.id);
    }
  }

  find(
    repoUrl: string | null,
    packageIdentifier: string | null,
    registryType: string | null,
    slug: string,
    name?: string | null,
  ): string | null {
    const repoIds = this.repos.get(extractRepoKey(repoUrl) ?? '') ?? [];
    if (repoIds.length === 1) return repoIds[0];
    if (repoIds.length > 1) {
      const candidates = repoIds.map((id) => this.rows.get(id)!);
      if (packageIdentifier) {
        const packageName = packageIdentifier.toLowerCase();
        const hit = candidates.find(
          (candidate) => candidate.package_identifier?.toLowerCase() === packageName,
        );
        if (hit) return hit.id;
      }
      if (slug) {
        const hit = candidates.find((candidate) => candidate.slug === slug);
        if (hit) return hit.id;
      }
      if (name) {
        const token = canonicalNameToken(name);
        if (token) {
          const hit = candidates.find((candidate) => {
            const existing = canonicalNameToken(candidate.name);
            return existing &&
              (existing === token || existing.endsWith(token) || token.endsWith(existing));
          });
          if (hit) return hit.id;
        }
      }
      return null;
    }

    if (packageIdentifier) {
      const ids = this.packages.get(packageIdentifier.toLowerCase()) ?? [];
      const hit = ids
        .map((id) => this.rows.get(id)!)
        .find(
          (candidate) =>
            registryType === null ||
            candidate.registry_type === null ||
            candidate.registry_type === registryType,
        );
      if (hit) return hit.id;
    }

    if (slug) {
      const ids = this.slugs.get(slug) ?? [];
      if (ids.length === 1) return ids[0];
    }
    return null;
  }

  /** Apply the match-relevant subset of mergeServerData without another query. */
  merge(existingId: string, incoming: IncomingRow): void {
    const existing = this.rows.get(existingId);
    if (!existing) return;
    this.replace({
      ...existing,
      repository_url: existing.repository_url || incoming.repository_url,
      package_identifier: existing.package_identifier || incoming.package_identifier,
      registry_type: existing.registry_type || incoming.registry_type,
    });
  }

  /** Replace all source-owned matching keys after a stable-ID refresh. */
  refreshStable(existingId: string, incoming: IncomingRow): void {
    const existing = this.rows.get(existingId);
    if (!existing) return;
    this.replace({
      ...existing,
      ...incoming,
      id: existingId,
      source: incoming.source ?? existing.source,
    });
  }

  /** Apply the match-relevant subset of the registry upsert statement. */
  upsert(incoming: IncomingRow): void {
    const existing = this.rows.get(incoming.id);
    if (!existing) {
      this.replace({ ...incoming, source: incoming.source ?? null });
      return;
    }
    this.replace({
      ...existing,
      repository_url: incoming.repository_url ?? existing.repository_url,
    });
  }
}

export function buildDedupIndex(db: DatabaseSync): DedupIndex {
  const rows = db
    .prepare(
      `SELECT id, slug, name, package_identifier, registry_type, repository_url, source
       FROM servers`,
    )
    .all() as unknown as DedupRow[];
  return new DedupIndex(rows);
}
