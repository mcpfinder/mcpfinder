import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mcpf-core-test-'));
process.env.MCPFINDER_DATA_DIR = dir;

const { initDatabase, getServerDetails } = await import('../packages/core/dist/index.js');

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
  updated_at: '2026-03-01T00:00:00.000Z',
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
assert.equal(detail?.freshnessLabel, 'active');
assert.equal(detail?.installComplexity, 'low');
assert.equal(detail?.capabilityCount, 4);
assert.equal(detail?.secretCount, 0);
assert.equal(
  detail?.toolsExposed.find((tool) => tool.name === 'filesystem_prompt')?.kind,
  'prompt',
);

db.close();
rmSync(dir, { recursive: true, force: true });
console.log('core capability checks passed');
