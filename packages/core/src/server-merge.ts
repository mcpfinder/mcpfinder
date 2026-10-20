import type { DatabaseSync } from 'node:sqlite';
import type { SqlParam } from './db.js';
import { extractKeywords } from './categories.js';
import { normalizeRepositoryUrl, repositorySource } from './repository-url.js';
import { firstUsableRemoteUrl, usableRemoteUrl } from './remote-url.js';
import { envVarsFromJsonSchema } from './env-vars.js';
import {
  mergeRawEnvelope,
  parseRawEnvelope,
  rawPayloadForSource,
  RAW_SOURCE_ORDER,
  RETIRED_SOURCES,
} from './raw-envelope.js';
import type { RawEnvelope } from './raw-envelope.js';

function mergeSources(existing: string[], newSource: string): string[] {
  return [...new Set([...existing.filter((s) => !RETIRED_SOURCES.includes(s)), newSource])].sort();
}

export function mergeServerSources(db: DatabaseSync, serverId: string, newSource: string): void {
  const row = db.prepare('SELECT sources FROM servers WHERE id = ?').get(serverId) as
    | { sources: string }
    | undefined;
  if (!row) return;
  let existing: string[];
  try {
    const parsed = JSON.parse(row.sources || '[]');
    existing = Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string') : [];
  } catch {
    existing = [];
  }
  db.prepare('UPDATE servers SET sources = ? WHERE id = ?').run(
    JSON.stringify(mergeSources(existing, newSource)),
    serverId,
  );
}

export function mergeServerData(
  db: DatabaseSync,
  existingId: string,
  newRow: Record<string, unknown>,
  options: { stableIdRefresh?: boolean } = {},
): Record<string, unknown> | undefined {
  const existing = db.prepare('SELECT * FROM servers WHERE id = ?').get(existingId) as
    | Record<string, unknown>
    | undefined;
  if (!existing) return undefined;
  const updates = new Map<string, unknown>();
  const queueUpdate = (field: string, value: unknown): void => {
    updates.set(field, value);
  };
  const incomingSource = String(newRow.source || 'unknown');
  const stableSameSourceRefresh =
    options.stableIdRefresh === true && incomingSource === String(existing.source || 'unknown');
  const storedSources = parsedStringSet(existing.sources);
  const sourceSet = new Set([...storedSources].filter((s) => !RETIRED_SOURCES.includes(s)));
  sourceSet.add(incomingSource);
  if ([...storedSources].some((s) => RETIRED_SOURCES.includes(s))) {
    queueUpdate('sources', JSON.stringify([...sourceSet].sort()));
  }
  const multiSourceRefresh = stableSameSourceRefresh && sourceSet.size > 1;
  const exactSourceRefresh = stableSameSourceRefresh && !multiSourceRefresh;

  if (exactSourceRefresh) {
    for (const field of [
      'slug',
      'name',
      'description',
      'version',
      'registry_type',
      'package_identifier',
      'transport_type',
      'repository_url',
      'repository_source',
      'published_at',
      'updated_at',
      'status',
      'remote_url',
      'has_remote',
      'use_count',
      'verified',
      'icon_url',
      'last_synced_at',
    ]) {
      const incomingValue = newRow[field] ?? null;
      const existingValue = existing[field] ?? null;
      if (incomingValue === existingValue) continue;
      queueUpdate(field, incomingValue);
    }
  }

  if (multiSourceRefresh) {
    for (const field of ['slug', 'name']) {
      if (newRow[field] !== existing[field]) queueUpdate(field, newRow[field] ?? null);
    }
  }
  if (multiSourceRefresh && newRow.last_synced_at !== existing.last_synced_at) {
    queueUpdate('last_synced_at', newRow.last_synced_at ?? null);
  }

  if (!exactSourceRefresh &&
    typeof newRow.description === 'string' &&
    newRow.description.length > ((existing.description as string) || '').length
  ) {
    queueUpdate('description', newRow.description);
  }

  const existingRepositoryUrl =
    typeof existing.repository_url === 'string' && existing.repository_url
      ? existing.repository_url
      : null;
  const incomingRepositoryUrl =
    typeof newRow.repository_url === 'string' && newRow.repository_url
      ? newRow.repository_url
      : null;
  const retainedRepositoryUrl = existingRepositoryUrl || incomingRepositoryUrl;
  if (!exactSourceRefresh && !existingRepositoryUrl && incomingRepositoryUrl) {
    queueUpdate('repository_url', incomingRepositoryUrl);
  }
  // Treat repository URL and provenance as a pair. In particular, a secondary
  // package/name/slug match must not attach an incoming host label to a
  // different repository URL that was retained from the canonical row.
  const retainedRepositorySource = retainedRepositoryUrl
    ? repositorySource(retainedRepositoryUrl) ||
      (!existingRepositoryUrl && typeof newRow.repository_source === 'string'
        ? newRow.repository_source
        : existing.repository_source)
    : null;
  if (!exactSourceRefresh &&
    retainedRepositorySource &&
    retainedRepositorySource !== existing.repository_source
  ) {
    queueUpdate('repository_source', retainedRepositorySource);
  }

  if (!exactSourceRefresh) {
    for (const field of [
      'remote_url',
      'icon_url',
      'transport_type',
      'registry_type',
      'package_identifier',
    ]) {
      if (newRow[field] && !existing[field]) {
        queueUpdate(field, newRow[field]);
      }
    }
  }

  if (!exactSourceRefresh) {
    const mergedHasRemote = Math.max(
      Number(existing.has_remote) || 0,
      Number(newRow.has_remote) || 0,
      existing.remote_url ? 1 : 0,
      newRow.remote_url ? 1 : 0,
    );
    if (mergedHasRemote !== (Number(existing.has_remote) || 0)) {
      queueUpdate('has_remote', mergedHasRemote);
    }
    for (const field of ['use_count', 'verified']) {
      const merged = Math.max(Number(existing[field]) || 0, Number(newRow[field]) || 0);
      if (merged !== (Number(existing[field]) || 0)) {
        queueUpdate(field, merged);
      }
    }
  }

  if (!exactSourceRefresh &&
    typeof newRow.updated_at === 'string' &&
    (!existing.updated_at || String(newRow.updated_at) > String(existing.updated_at))
  ) {
    queueUpdate('updated_at', newRow.updated_at);
  }
  if (!exactSourceRefresh && typeof newRow.published_at === 'string' && !existing.published_at) {
    queueUpdate('published_at', newRow.published_at);
  }

  const priorEnvelope = parseRawEnvelope(existing.raw_data, String(existing.source || 'unknown'));
  const mergedEnvelope = mergeRawEnvelope(
    existing.raw_data,
    newRow.raw_data,
    incomingSource,
    String(existing.source || 'unknown'),
  );
  if (mergedEnvelope) {
    const mergedRawData = JSON.stringify(mergedEnvelope);
    queueUpdate('raw_data', mergedRawData);
    const currentKeywords = currentKeywordsFromEnvelope(
      mergedEnvelope,
      JSON.stringify([...sourceSet]),
      incomingSource,
      existing.keywords,
    );
    if (currentKeywords && currentKeywords !== existing.keywords) {
      queueUpdate('keywords', currentKeywords);
    }
    if (sourceSet.size > 1) {
      const aggregate = aggregateCurrentFields(mergedEnvelope, sourceSet);
      if (aggregate) {
        for (const [field, value] of Object.entries(aggregate)) queueUpdate(field, value);
      }
    }
  }
  if (typeof newRow.env_vars === 'string') {
    const mergedEnvVars = exactSourceRefresh
      ? newRow.env_vars
      : priorEnvelope && mergedEnvelope
        ? rebuildCurrentEnvVars(existing.env_vars, priorEnvelope, mergedEnvelope, sourceSet) ??
          mergeObjectArrayJson(existing.env_vars, newRow.env_vars, 'name')
        : mergeObjectArrayJson(existing.env_vars, newRow.env_vars, 'name');
    if (mergedEnvVars && mergedEnvVars !== existing.env_vars) {
      queueUpdate('env_vars', mergedEnvVars);
    }
  }
  if (updates.size > 0) {
    const values = [...updates.values(), existingId] as SqlParam[];
    const assignments = [...updates.keys()].map((field) => `${field} = ?`);
    db.prepare(`UPDATE servers SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
  }
  return { ...existing, ...Object.fromEntries(updates) };
}

function parsedStringSet(value: unknown): Set<string> {
  try {
    const parsed = JSON.parse(String(value || '[]')) as unknown;
    return new Set(Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []);
  } catch {
    return new Set();
  }
}

function rebuildCurrentEnvVars(
  existingEnvJson: unknown,
  priorEnvelope: RawEnvelope,
  currentEnvelope: RawEnvelope,
  sources: Set<string>,
): string | null {
  try {
    const existingEnv = JSON.parse(String(existingEnvJson || '[]')) as unknown;
    if (!Array.isArray(existingEnv)) return null;
    const previousBySource = envVarsBySource(priorEnvelope, sources);
    const currentBySource = envVarsBySource(currentEnvelope, sources);
    if (!previousBySource || !currentBySource) return null;
    const replacedNames = new Set(
      [...previousBySource.values()].flat().map((item) => String(item.name)),
    );
    const current = RAW_SOURCE_ORDER.flatMap((source) => currentBySource.get(source) ?? []);
    return mergeObjectArrayJson(
      JSON.stringify(existingEnv.filter((item) =>
        !item || typeof item !== 'object' ||
        !replacedNames.has(String((item as Record<string, unknown>).name)))),
      JSON.stringify(current),
      'name',
    );
  } catch {
    return null;
  }
}

function envVarsBySource(
  envelope: RawEnvelope,
  sources: Set<string>,
): Map<string, Array<Record<string, unknown>>> | null {
  const result = new Map<string, Array<Record<string, unknown>>>();
  for (const source of sources) {
    if (!RAW_SOURCE_ORDER.includes(source as (typeof RAW_SOURCE_ORDER)[number])) return null;
    const payload = rawPayloadForSource(envelope, source);
    const envVars = envVarsForPayload(source, payload);
    if (!envVars) return null;
    result.set(source, envVars);
  }
  return result;
}

function envVarsForPayload(
  source: string,
  payload: unknown,
): Array<Record<string, unknown>> | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (source === 'official') {
    if (!record.server || typeof record.server !== 'object') return null;
    const packages = (record.server as Record<string, unknown>).packages;
    if (packages === undefined) return [];
    if (!Array.isArray(packages)) return null;
    const first = packages[0];
    if (!first || typeof first !== 'object') return [];
    const envVars = (first as Record<string, unknown>).environmentVariables;
    if (envVars === undefined) return [];
    if (!Array.isArray(envVars)) return null;
    return envVars.filter(
      (item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'),
    );
  }
  // Same mapping the sync normalizer applies on insert — see env-vars.ts.
  const envVars = envVarsFromJsonSchema(record.environmentVariablesJsonSchema);
  return envVars as Array<Record<string, unknown>> | null;
}

function aggregateCurrentFields(
  envelope: RawEnvelope,
  sources: Set<string>,
): Record<string, unknown> | null {
  const contributions = new Map<string, SourceContribution>();
  for (const source of sources) {
    if (!RAW_SOURCE_ORDER.includes(source as (typeof RAW_SOURCE_ORDER)[number])) return null;
    const contribution = contributionForPayload(source, rawPayloadForSource(envelope, source));
    if (!contribution) return null;
    contributions.set(source, contribution);
  }
  const order = [
    envelope.primarySource,
    ...RAW_SOURCE_ORDER.filter((source) => source !== envelope.primarySource),
  ].filter((source, index, all) => sources.has(source) && all.indexOf(source) === index);
  const ordered = order.map((source) => contributions.get(source)!);
  const description = ordered.reduce(
    (best, item) => item.description.length > best.length ? item.description : best,
    '',
  );
  const repositoryUrl = ordered.find((item) => item.repository_url)?.repository_url ?? null;
  const remoteUrl = ordered.find((item) => item.remote_url)?.remote_url ?? null;
  const packageOwner = ordered.find((item) => item.package_identifier || item.registry_type ||
    item.transport_type);
  return {
    description,
    repository_url: repositoryUrl,
    repository_source: repositorySource(repositoryUrl),
    remote_url: remoteUrl,
    has_remote: remoteUrl ? 1 : 0,
    registry_type: packageOwner?.registry_type ?? null,
    package_identifier: packageOwner?.package_identifier ?? null,
    transport_type: packageOwner?.transport_type ?? null,
  };
}

interface SourceContribution {
  description: string;
  repository_url: string | null;
  remote_url: string | null;
  registry_type: string | null;
  package_identifier: string | null;
  transport_type: string | null;
}

function contributionForPayload(source: string, payload: unknown): SourceContribution | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (source === 'official') {
    if (!record.server || typeof record.server !== 'object') return null;
    const server = record.server as Record<string, unknown>;
    if (typeof server.name !== 'string') return null;
    if (server.repository !== undefined && server.repository !== null &&
      typeof server.repository !== 'object') return null;
    if (server.packages !== undefined && !Array.isArray(server.packages)) return null;
    if (server.remotes !== undefined && !Array.isArray(server.remotes)) return null;
    const repository = server.repository && typeof server.repository === 'object'
      ? server.repository as Record<string, unknown>
      : null;
    const packages = Array.isArray(server.packages) ? server.packages : [];
    const pkg = packages[0] && typeof packages[0] === 'object'
      ? packages[0] as Record<string, unknown>
      : null;
    const transport = pkg?.transport && typeof pkg.transport === 'object'
      ? pkg.transport as Record<string, unknown>
      : null;
    return {
      description: typeof server.description === 'string' ? server.description : '',
      repository_url: normalizeRepositoryUrl(
        typeof repository?.url === 'string' ? repository.url : null,
      ),
      remote_url: firstUsableRemoteUrl(server.remotes),
      registry_type: typeof pkg?.registryType === 'string' ? pkg.registryType : null,
      package_identifier: typeof pkg?.identifier === 'string' ? pkg.identifier : null,
      transport_type: typeof transport?.type === 'string' ? transport.type : null,
    };
  }
  if (source === 'glama') {
    if (typeof record.name !== 'string') return null;
    if (record.repository !== undefined && record.repository !== null &&
      typeof record.repository !== 'object') return null;
    const repository = record.repository && typeof record.repository === 'object'
      ? record.repository as Record<string, unknown>
      : null;
    return {
      description: typeof record.description === 'string' ? record.description : '',
      repository_url: normalizeRepositoryUrl(
        typeof repository?.url === 'string' ? repository.url : null,
      ),
      remote_url: usableRemoteUrl(record.url),
      registry_type: null,
      package_identifier: null,
      transport_type: null,
    };
  }
  return null;
}

function mergeObjectArrayJson(
  existingJson: unknown,
  incomingJson: unknown,
  key: string,
): string | null {
  try {
    const existing = JSON.parse(String(existingJson || '[]'));
    const incoming = JSON.parse(String(incomingJson || '[]'));
    if (!Array.isArray(existing) || !Array.isArray(incoming)) return null;
    const merged = new Map<string, Record<string, unknown>>();
    for (const item of [...existing, ...incoming]) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      const itemKey = typeof record[key] === 'string' ? String(record[key]) : JSON.stringify(record);
      merged.set(itemKey, { ...(merged.get(itemKey) || {}), ...record });
    }
    return JSON.stringify([...merged.values()]);
  } catch {
    return null;
  }
}

function currentKeywordsFromEnvelope(
  envelope: RawEnvelope,
  sourcesJson: unknown,
  incomingSource: string,
  existingKeywordsJson: unknown,
): string | null {
  try {
    const parsedSources = JSON.parse(String(sourcesJson || '[]')) as unknown;
    if (!Array.isArray(parsedSources)) return null;
    const requiredSources = new Set(
      parsedSources.filter((source): source is string => typeof source === 'string'),
    );
    requiredSources.add(incomingSource);
    const keywords: string[] = [];
    const seen = new Set<string>();
    let incomplete = [...requiredSources].some((source) =>
      !RAW_SOURCE_ORDER.includes(source as (typeof RAW_SOURCE_ORDER)[number]));
    for (const source of RAW_SOURCE_ORDER) {
      const payload = rawPayloadForSource(envelope, source);
      const hasPayload = payload !== undefined;
      if (!requiredSources.has(source) && !hasPayload) continue;
      const extracted = keywordsForSourcePayload(source, payload);
      if (!extracted) {
        incomplete = true;
        continue;
      }
      for (const keyword of extracted) {
        if (seen.has(keyword)) continue;
        seen.add(keyword);
        keywords.push(keyword);
      }
    }
    if (incomplete) {
      const existingKeywords = JSON.parse(String(existingKeywordsJson || '[]')) as unknown;
      if (!Array.isArray(existingKeywords)) return null;
      for (const keyword of existingKeywords) {
        if (typeof keyword !== 'string' || seen.has(keyword)) continue;
        seen.add(keyword);
        keywords.push(keyword);
      }
    }
    return JSON.stringify(keywords);
  } catch {
    return null;
  }
}

function keywordsForSourcePayload(
  source: (typeof RAW_SOURCE_ORDER)[number],
  payload: unknown,
): string[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (source === 'official') {
    if (!record.server || typeof record.server !== 'object') return null;
    const server = record.server as Record<string, unknown>;
    if (typeof server.name !== 'string') return null;
    return extractKeywords(
      server.name,
      typeof server.description === 'string' ? server.description : '',
    );
  }
  if (source === 'glama') {
    if (typeof record.name !== 'string') return null;
    const name = typeof record.namespace === 'string' && record.namespace
      ? `${record.namespace}/${record.name}`
      : record.name;
    return extractKeywords(name, typeof record.description === 'string' ? record.description : '');
  }
  return null;
}
