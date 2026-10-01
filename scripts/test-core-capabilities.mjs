import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSearchRelevanceChecks } from './search-relevance-checks.mjs';

const dir = mkdtempSync(join(tmpdir(), 'mcpf-core-test-'));
process.env.MCPFINDER_DATA_DIR = dir;

const { initDatabase, getServerDetails, searchServers } = await import('../packages/core/dist/index.js');

const db = initDatabase();

db.prepare(`
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
`).run({
  id: 'io.example/filesystem',
  slug: 'filesystem',
  name: 'io.example/filesystem',
  description: 'Filesystem MCP server',
  version: '1.2.3',
  registry_type: 'npm',
  package_identifier: '@example/filesystem',
  transport_type: 'stdio',
  repository_url: 'https://github.com/example/filesystem',
  repository_source: 'github',
  published_at: '2026-01-01T00:00:00.000Z',
  // 31–180 days from now is `active`; a fixed 2026-03-01 stamp aged into
  // `aging` on 2026-08-28 and started failing CI without a product change.
  updated_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
  status: 'active',
  popularity_score: 0,
  categories: '["filesystem"]',
  keywords: '["filesystem","files"]',
  remote_url: null,
  has_remote: 0,
  last_synced_at: new Date().toISOString(),
  sources: '["official","glama"]',
  raw_data: JSON.stringify({
    primary: {
      capabilities: [
        { name: 'filesystem_prompt', type: 'prompt', description: 'Filesystem helper prompt' },
      ],
      _meta: {
        'io.modelcontextprotocol.registry/publisher-provided': {
          tools: ['read_file', 'write_file'],
        },
      },
    },
    bySource: {
      glama: {
        tools: [
          { name: 'read_file', description: 'Read a file from disk' },
          { name: 'list_directory', description: 'List files in a directory' },
        ],
      },
    },
  }),
  env_vars: JSON.stringify([
    { name: 'ROOT_PATH', description: 'Root path', isSecret: false },
  ]),
  source: 'official',
  use_count: 123,
  verified: 1,
  icon_url: null,
});

const detail = getServerDetails(db, 'filesystem');
assert.ok(detail, 'server detail should be found');
assert.equal(detail?.sourceCount, 2);
assert.ok(detail?.confidenceScore && detail.confidenceScore > 0.5);
assert.deepEqual(
  detail?.toolsExposed.map((tool) => tool.name).sort(),
  ['filesystem_prompt', 'list_directory', 'read_file', 'write_file'],
);
assert.equal(detail?.warningFlags.includes('single-source-only'), false);
assert.equal(detail?.trustSignals.hasOfficialSource, true);
assert.equal(detail?.trustSignals.multiSource, true);
assert.equal(detail?.trustSignals.requiresSecrets, false);
assert.equal(detail?.trustSignals.possibleUnlabeledSecrets, false);
assert.equal(detail?.freshnessLabel, 'active');
assert.equal(detail?.installComplexity, 'low');
assert.equal(detail?.capabilityCount, 4);
assert.equal(detail?.secretCount, 0);
assert.equal(
  detail?.toolsExposed.find((tool) => tool.name === 'filesystem_prompt')?.kind,
  'prompt',
);

// Unlabelled credential-like env var (GitHub issue #23): advisory signal in
// both details and search results.
db.prepare(`
  INSERT INTO servers (
    id, slug, name, description, registry_type, package_identifier, transport_type,
    status, sources, raw_data, env_vars, source, last_synced_at
  ) VALUES (
    'io.example/ghtool', 'ghtool', 'io.example/ghtool', 'Zyxwq credential test server', 'npm',
    '@example/ghtool', 'stdio', 'active', '["official"]', '{}', @env_vars, 'official', @now
  )
`).run({
  env_vars: JSON.stringify([{ name: 'GITHUB_TOKEN', description: 'GitHub token' }]),
  now: new Date().toISOString(),
});
const ghDetail = getServerDetails(db, 'ghtool');
assert.equal(ghDetail?.trustSignals.possibleUnlabeledSecrets, true);
assert.equal(ghDetail?.trustSignals.requiresSecrets, false);
const ghSearch = searchServers(db, 'Zyxwq').find((r) => r.slug === 'ghtool' || r.name === 'io.example/ghtool');
assert.ok(ghSearch, 'search should find the ghtool fixture');
assert.equal(ghSearch.trustSignals.possibleUnlabeledSecrets, true);
const fsSearch = searchServers(db, 'filesystem').find((r) => r.name === 'io.example/filesystem');
assert.equal(fsSearch?.trustSignals.possibleUnlabeledSecrets, false);

db.close();

await runSearchRelevanceChecks();

rmSync(dir, { recursive: true, force: true });
console.log('core capability checks passed');
