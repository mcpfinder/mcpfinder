import assert from 'node:assert/strict';
import { join } from 'node:path';

const runtime = (fetchImpl) => ({ fetchImpl, now: () => 0, sleep: async () => {} });

const officialEntry = (name, repo = null, description = '') => ({
  server: {
    name,
    version: '1.0.0',
    description,
    ...(repo
      ? { repository: { url: repo, source: repo.includes('gitlab.com') ? 'gitlab' : 'github' } }
      : {}),
  },
});

const glamaEntry = (id, repo, overrides = {}) => ({
  id,
  name: id,
  namespace: '',
  slug: id,
  description: '',
  repository: repo ? { url: repo } : null,
  spdxLicense: null,
  tools: [],
  url: null,
  environmentVariablesJsonSchema: null,
  attributes: {},
  ...overrides,
});

function syncLog(db, source) {
  return db
    .prepare('SELECT source, server_count, status, error FROM sync_log WHERE source = ?')
    .get(source);
}

export async function runSnapshotMergeChecks(dir) {
  const { initDatabase, syncOfficialRegistry, syncGlamaRegistry } =
    await import('../packages/core/dist/index.js');
  const { mergeRawEnvelope } = await import('../packages/core/dist/raw-envelope.js');

  const existingRaw = JSON.stringify(officialEntry('raw-helper', null, 'official payload'));
  const canonicalIncoming = JSON.stringify({
    primarySource: 'glama',
    primary: glamaEntry('raw-helper-canonical', null, { tools: [{ name: 'canonical-tool' }] }),
    bySource: {},
  });
  const canonicalMerged = mergeRawEnvelope(
    existingRaw,
    canonicalIncoming,
    'glama',
    'official',
  );
  assert.equal(canonicalMerged.bySource.glama.id, 'raw-helper-canonical');
  assert.equal(canonicalMerged.bySource.glama.primarySource, undefined);
  const legacyMerged = mergeRawEnvelope(
    existingRaw,
    JSON.stringify({
      primary: glamaEntry('raw-helper-stale', null),
      bySource: { glama: glamaEntry('raw-helper-legacy', null) },
    }),
    'glama',
    'official',
  );
  assert.equal(legacyMerged.bySource.glama.id, 'raw-helper-legacy');
  assert.equal(
    mergeRawEnvelope(existingRaw, JSON.stringify({
      primarySource: 'official', primary: officialEntry('wrong-source'), bySource: {},
    }), 'glama', 'official'),
    null,
  );

  const glamaGitlabDb = initDatabase(join(dir, 'glama-gitlab-source.sqlite'));
  await syncGlamaRegistry(
    glamaGitlabDb,
    runtime(async () => Response.json({
      servers: [glamaEntry('glama-gitlab', 'https://gitlab.com/acme/glama.git')],
      pageInfo: { hasNextPage: false, endCursor: null },
    })),
  );
  assert.equal(
    glamaGitlabDb.prepare('SELECT repository_source FROM servers').get().repository_source,
    'gitlab',
  );
  glamaGitlabDb.close();

  // Repository URL and provenance are merged atomically. A secondary slug
  // match must not label a retained GitLab URL as GitHub.
  for (const [name, incomingRepo] of [
    ['same', 'https://gitlab.com/acme/provenance'],
    ['divergent', 'https://github.com/other/provenance'],
  ]) {
    const provenanceDb = initDatabase(join(dir, `repository-provenance-${name}.sqlite`));
    await syncOfficialRegistry(
      provenanceDb,
      runtime(async () => Response.json({
        servers: [officialEntry('provenance', 'https://gitlab.com/acme/provenance')],
        metadata: { nextCursor: null, count: 1 },
      })),
    );
    provenanceDb.prepare('UPDATE servers SET repository_source = NULL').run();
    await syncGlamaRegistry(
      provenanceDb,
      runtime(async () => Response.json({
        servers: [glamaEntry('provenance', incomingRepo)],
        pageInfo: { hasNextPage: false, endCursor: null },
      })),
    );
    const repository = provenanceDb
      .prepare('SELECT repository_url, repository_source FROM servers')
      .get();
    assert.equal(repository.repository_url, 'https://gitlab.com/acme/provenance');
    assert.equal(repository.repository_source, 'gitlab');
    provenanceDb.close();
  }

  // Cross-source merge keeps provenance, richer fields, and source payloads.
  const mergeDb = initDatabase(join(dir, 'merge-provenance.sqlite'));
  const sharedRepo = 'https://gitlab.com/acme/shared';
  await syncOfficialRegistry(
    mergeDb,
    runtime(async () => Response.json({
      servers: [officialEntry('shared', null, 'obsolete retained')],
      metadata: { nextCursor: null, count: 1 },
    })),
  );
  await syncGlamaRegistry(
    mergeDb,
    runtime(async () => Response.json({
      servers: [glamaEntry('shared', sharedRepo, {
        description: 'a substantially richer Glama description retained',
        url: 'https://glama.ai/mcp/servers/shared',
        environmentVariablesJsonSchema: { properties: { GLAMA_TOKEN: { description: 'token' } } },
      })],
      pageInfo: { hasNextPage: false, endCursor: null },
    })),
  );
  const merged = mergeDb.prepare('SELECT * FROM servers').get();
  assert.equal(mergeDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 1);
  assert.deepEqual(JSON.parse(merged.sources), ['glama', 'official']);
  assert.match(merged.description, /substantially richer Glama/);
  assert.equal(merged.repository_url, sharedRepo);
  assert.equal(merged.repository_source, 'gitlab');
  assert.equal(merged.remote_url, 'https://glama.ai/mcp/servers/shared');
  assert.equal(merged.has_remote, 1);
  assert.equal(JSON.parse(merged.env_vars)[0].name, 'GLAMA_TOKEN');
  assert.deepEqual(JSON.parse(merged.keywords), [
    'shared',
    'obsolete',
    'retained',
    'substantially',
    'richer',
    'glama',
    'description',
  ]);
  const mergedRaw = JSON.parse(merged.raw_data);
  assert.equal(mergedRaw.primarySource, 'official');
  assert.equal(mergedRaw.primary.server.name, 'shared');
  assert.equal(mergedRaw.bySource.official, undefined);
  assert.equal(mergedRaw.bySource.glama.id, 'shared');
  assert.equal(mergedRaw.bySource.smithery, undefined);
  assert.equal((merged.raw_data.match(/obsolete retained/g) || []).length, 1);
  for (const source of ['official', 'glama']) {
    assert.equal(syncLog(mergeDb, source).status, 'ok');
  }
  await syncOfficialRegistry(
    mergeDb,
    runtime(async () => Response.json({
      servers: [
        {
          ...officialEntry('shared', sharedRepo, 'refreshed official payload'),
          server: {
            ...officialEntry('shared', sharedRepo, 'refreshed official payload').server,
            packages: [
              {
                registryType: 'npm',
                identifier: '@acme/shared',
                transport: { type: 'stdio' },
                environmentVariables: [{ name: 'OFFICIAL_TOKEN', description: 'official' }],
              },
            ],
          },
        },
      ],
      metadata: { nextCursor: null, count: 1 },
    })),
  );
  const refreshed = mergeDb
    .prepare("SELECT raw_data, keywords, env_vars, sources, repository_source FROM servers WHERE id = 'shared'")
    .get();
  const refreshedRaw = JSON.parse(refreshed.raw_data);
  assert.equal(refreshedRaw.primarySource, 'official');
  assert.equal(refreshedRaw.primary.server.description, 'refreshed official payload');
  assert.equal(refreshedRaw.bySource.official, undefined);
  assert.equal(refreshedRaw.bySource.glama.id, 'shared');
  assert.ok(JSON.parse(refreshed.keywords).includes('glama'));
  assert.ok(JSON.parse(refreshed.keywords).includes('refreshed'));
  assert.ok(JSON.parse(refreshed.keywords).includes('retained'));
  assert.ok(!JSON.parse(refreshed.keywords).includes('obsolete'));
  assert.deepEqual(
    JSON.parse(refreshed.env_vars).map((envVar) => envVar.name),
    ['OFFICIAL_TOKEN', 'GLAMA_TOKEN'],
  );
  assert.deepEqual(JSON.parse(refreshed.sources), ['glama', 'official']);
  assert.equal(refreshed.repository_source, 'gitlab');

  await syncGlamaRegistry(
    mergeDb,
    runtime(async () => Response.json({
      servers: [glamaEntry('shared', sharedRepo, { description: 'Glama replacement' })],
      pageInfo: { hasNextPage: false, endCursor: null },
    })),
  );
  const glamaRefreshed = mergeDb
    .prepare("SELECT raw_data, keywords FROM servers WHERE id = 'shared'")
    .get();
  const glamaRefreshedKeywords = JSON.parse(glamaRefreshed.keywords);
  assert.ok(glamaRefreshedKeywords.includes('replacement'));
  assert.ok(glamaRefreshedKeywords.includes('refreshed'));
  assert.ok(!glamaRefreshedKeywords.includes('substantially'));
  assert.equal(JSON.parse(glamaRefreshed.raw_data).bySource.glama.description, 'Glama replacement');
  mergeDb.close();

  const glamaPrimaryDb = initDatabase(join(dir, 'merge-glama-primary-refresh.sqlite'));
  const multiRepo = 'https://github.com/acme/multi-source-refresh';
  const refreshedMultiRepo = 'https://github.com/acme/multi-source-refreshed';
  await syncGlamaRegistry(
    glamaPrimaryDb,
    runtime(async () => Response.json({
      servers: [glamaEntry('glama-primary', multiRepo, {
        description: 'old glama-only wording',
        environmentVariablesJsonSchema: {
          properties: { OLD_GLAMA_TOKEN: { description: 'obsolete' } },
        },
      })],
      pageInfo: { hasNextPage: false, endCursor: null },
    })),
  );
  await syncOfficialRegistry(
    glamaPrimaryDb,
    runtime(async () => Response.json({
      servers: [{ server: {
        name: 'glama:glama-primary',
        version: '1.0.0',
        description: 'Official contribution',
        repository: { url: multiRepo, source: 'github' },
        packages: [{
          registryType: 'npm', identifier: '@acme/glama-primary', transport: { type: 'stdio' },
          environmentVariables: [{ name: 'OFFICIAL_TOKEN', description: 'preserve me' }],
        }],
        remotes: [{ type: 'streamable-http', url: 'https://example.com/official-remote' }],
      } }],
      metadata: { count: 1 },
    })),
  );
  const glamaPrimaryId = 'glama:glama-primary';
  await syncGlamaRegistry(
    glamaPrimaryDb,
    runtime(async () => Response.json({
      servers: [glamaEntry('glama-primary', refreshedMultiRepo, {
        description: 'fresh glama wording',
        environmentVariablesJsonSchema: {
          properties: { NEW_GLAMA_TOKEN: { description: 'current' } },
        },
      })],
      pageInfo: { hasNextPage: false, endCursor: null },
    })),
  );
  const glamaPrimary = glamaPrimaryDb.prepare('SELECT * FROM servers WHERE id = ?')
    .get(glamaPrimaryId);
  assert.equal(glamaPrimary.description, 'Official contribution');
  assert.equal(glamaPrimary.use_count, 0);
  assert.equal(glamaPrimary.verified, 0);
  assert.equal(glamaPrimary.icon_url, null);
  assert.equal(glamaPrimary.remote_url, 'https://example.com/official-remote');
  assert.equal(glamaPrimary.has_remote, 1);
  assert.equal(glamaPrimary.repository_url, refreshedMultiRepo);
  assert.equal(glamaPrimary.repository_source, 'github');
  assert.equal(glamaPrimary.package_identifier, '@acme/glama-primary');
  assert.equal(glamaPrimary.transport_type, 'stdio');
  assert.deepEqual(
    JSON.parse(glamaPrimary.env_vars).map((item) => item.name).sort(),
    ['NEW_GLAMA_TOKEN', 'OFFICIAL_TOKEN'],
  );
  const glamaPrimaryRaw = JSON.parse(glamaPrimary.raw_data);
  assert.equal(glamaPrimaryRaw.primary.description, 'fresh glama wording');
  assert.match(glamaPrimaryRaw.bySource.official.server.description, /Official contribution/);
  assert.ok(JSON.parse(glamaPrimary.keywords).includes('fresh'));
  glamaPrimaryDb.close();

  // Remote endpoints on retired Smithery hosts (https://smithery.ai/future:
  // server.smithery.ai, *.run.tools and registry.smithery.ai/servers/* stop
  // working on 2026-10-31) are never offered as an install target, whichever
  // registry advertises them. A usable remote listed after a retired one wins.
  const retiredDb = initDatabase(join(dir, 'merge-retired-remote.sqlite'));
  await syncOfficialRegistry(
    retiredDb,
    runtime(async () => Response.json({
      servers: [
        { server: {
          name: 'io.example/retired-first', version: '1.0.0', description: '',
          remotes: [
            { type: 'streamable-http', url: 'https://server.smithery.ai/acme/tool/mcp' },
            { type: 'streamable-http', url: 'https://mcp.example.com/mcp' },
          ],
        } },
        { server: {
          name: 'io.example/retired-only', version: '1.0.0', description: '',
          remotes: [{ type: 'sse', url: 'https://sse--acme.run.tools/' }],
        } },
        { server: {
          name: 'io.example/shared-remote', version: '1.0.0', description: '',
          repository: { url: 'https://github.com/acme/shared-remote', source: 'github' },
          remotes: [{ type: 'streamable-http', url: 'https://SERVER.Smithery.AI/acme/shared' }],
        } },
      ],
      metadata: { count: 3 },
    })),
  );
  await syncGlamaRegistry(
    retiredDb,
    runtime(async () => Response.json({
      servers: [
        glamaEntry('glama-retired', null, { url: 'https://registry.smithery.ai/servers/acme/x' }),
        glamaEntry('shared-remote', 'https://github.com/acme/shared-remote', {
          url: 'https://glama.example.com/mcp',
        }),
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    })),
  );
  const remoteOf = (id) => retiredDb
    .prepare('SELECT remote_url, has_remote FROM servers WHERE id = ?').get(id);
  assert.deepEqual({ ...remoteOf('io.example/retired-first') },
    { remote_url: 'https://mcp.example.com/mcp', has_remote: 1 });
  assert.deepEqual({ ...remoteOf('io.example/retired-only') }, { remote_url: null, has_remote: 0 });
  assert.deepEqual({ ...remoteOf('glama:glama-retired') }, { remote_url: null, has_remote: 0 });
  assert.deepEqual({ ...remoteOf('io.example/shared-remote') },
    { remote_url: 'https://glama.example.com/mcp', has_remote: 1 });
  assert.equal(
    retiredDb.prepare("SELECT COUNT(*) AS count FROM servers WHERE remote_url LIKE '%smithery%' OR remote_url LIKE '%run.tools%'").get().count,
    0,
  );
  retiredDb.close();

  const invalidRawDb = initDatabase(join(dir, 'merge-invalid-legacy-raw.sqlite'));
  await syncOfficialRegistry(
    invalidRawDb,
    runtime(async () => Response.json({
      servers: [officialEntry('legacy-raw', null, 'old payload')],
      metadata: { count: 1 },
    })),
  );
  invalidRawDb
    .prepare("UPDATE servers SET raw_data = '{broken', keywords = '[\"keep-me\"]'")
    .run();
  await syncGlamaRegistry(
    invalidRawDb,
    runtime(async () => Response.json({
      servers: [glamaEntry('legacy-raw', null, { description: 'incoming data' })],
      pageInfo: { hasNextPage: false, endCursor: null },
    })),
  );
  assert.deepEqual(
    JSON.parse(invalidRawDb.prepare('SELECT keywords FROM servers').get().keywords),
    ['legacy', 'raw', 'incoming', 'data', 'keep-me'],
  );
  assert.match(invalidRawDb.prepare('SELECT raw_data FROM servers').get().raw_data, /incoming data/);
  invalidRawDb.close();

  // Legacy duplicated envelopes are canonicalized without retaining the stale
  // primary copy. The bySource copy is the one refreshed by historical merges.
  const legacyDb = initDatabase(join(dir, 'merge-legacy-envelope.sqlite'));
  await syncOfficialRegistry(
    legacyDb,
    runtime(async () => Response.json({
      servers: [officialEntry('legacy-envelope', null, 'seed')],
      metadata: { count: 1 },
    })),
  );
  const stalePrimary = officialEntry('legacy-envelope', null, 'stale primary');
  const newerOfficial = officialEntry('legacy-envelope', null, 'newer official payload');
  legacyDb.prepare('UPDATE servers SET raw_data = ? WHERE id = ?').run(
    JSON.stringify({
      primary: stalePrimary,
      bySource: { official: newerOfficial },
    }),
    'legacy-envelope',
  );
  await syncGlamaRegistry(
    legacyDb,
    runtime(async () => Response.json({
      servers: [glamaEntry('legacy-envelope', null, { description: 'glama payload' })],
      pageInfo: { hasNextPage: false, endCursor: null },
    })),
  );
  const canonicalLegacy = JSON.parse(
    legacyDb.prepare("SELECT raw_data FROM servers WHERE id = 'legacy-envelope'").get().raw_data,
  );
  assert.equal(canonicalLegacy.primarySource, 'official');
  assert.equal(canonicalLegacy.primary.server.description, 'newer official payload');
  assert.equal(canonicalLegacy.bySource.official, undefined);
  assert.equal(canonicalLegacy.bySource.glama.description, 'glama payload');
  assert.doesNotMatch(JSON.stringify(canonicalLegacy), /stale primary/);
  legacyDb.close();
}
