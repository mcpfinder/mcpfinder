import assert from 'node:assert/strict';

export async function runSnapshotDedupChecks() {
  const { DedupIndex, buildDedupIndex } = await import('../packages/core/dist/dedup-index.js');
  const { extractRepoKey, normalizeRepositoryUrl, repositorySource } = await import(
    '../packages/core/dist/repository-url.js'
  );
  const { validateOfficialPage } = await import(
    '../packages/core/dist/registry-page-validation.js'
  );
  const row = (id, overrides = {}) => ({
    id,
    slug: id,
    name: id,
    package_identifier: null,
    registry_type: null,
    repository_url: null,
    source: 'official',
    ...overrides,
  });

  const singleRepo = new DedupIndex([
    row('single', { repository_url: 'https://github.com/acme/single.git' }),
  ]);
  assert.equal(singleRepo.find('https://github.com/acme/single', null, null, 'x'), 'single');

  const monorepo = new DedupIndex([
    row('alpha', {
      slug: 'alpha',
      name: 'MCP Alpha Server',
      package_identifier: '@acme/alpha',
      repository_url: 'https://github.com/acme/mono',
    }),
    row('beta', {
      slug: 'beta',
      name: 'Beta MCP',
      package_identifier: '@acme/beta',
      repository_url: 'https://github.com/acme/mono',
    }),
  ]);
  assert.equal(monorepo.find('https://github.com/acme/mono', null, null, 'other'), null);
  assert.equal(monorepo.find('https://github.com/acme/mono', '@ACME/BETA', null, ''), 'beta');
  assert.equal(monorepo.find('https://github.com/acme/mono', null, null, 'alpha'), 'alpha');
  assert.equal(monorepo.find('https://github.com/acme/mono', null, null, '', 'Alpha'), 'alpha');

  const fallback = new DedupIndex([
    row('package', { package_identifier: 'same-package', registry_type: 'npm' }),
    row('unique-slug', { slug: 'unique' }),
    row('duplicate-a', { slug: 'duplicate' }),
    row('duplicate-b', { slug: 'duplicate' }),
    row('unknown-slug', { slug: 'excluded', source: 'unknown' }),
    row('null-slug', { slug: 'excluded-null', source: null }),
  ]);
  assert.equal(fallback.find(null, 'SAME-PACKAGE', 'npm', ''), 'package');
  assert.equal(fallback.find(null, null, null, 'unique'), 'unique-slug');
  assert.equal(fallback.find(null, null, null, 'duplicate'), null);
  assert.equal(fallback.find(null, null, null, 'excluded'), null);
  assert.equal(fallback.find(null, null, null, 'excluded-null'), null);
  fallback.upsert(row('inserted', {
    slug: 'new-slug',
    repository_url: 'https://github.com/acme/new',
  }));
  assert.equal(fallback.find('https://github.com/acme/new', null, null, ''), 'inserted');

  const mutable = new DedupIndex([
    row('merge-target', { slug: 'merge-target' }),
    row('upsert-target', { repository_url: 'https://github.com/acme/old' }),
  ]);
  mutable.merge('merge-target', row('incoming', {
    repository_url: 'https://gitlab.com/acme/merged.git',
    package_identifier: '@acme/merged',
    registry_type: 'npm',
  }));
  assert.equal(mutable.find('https://gitlab.com/acme/merged', null, null, ''), 'merge-target');
  assert.equal(mutable.find(null, '@ACME/MERGED', 'npm', ''), 'merge-target');
  mutable.upsert(row('upsert-target', {
    repository_url: 'https://github.com/acme/new-location',
  }));
  assert.equal(mutable.find('https://github.com/acme/old', null, null, ''), null);
  assert.equal(mutable.find('https://github.com/acme/new-location', null, null, ''), 'upsert-target');
  mutable.refreshStable('upsert-target', row('upsert-target', {
    slug: 'refreshed-slug',
    name: 'Refreshed stable name',
    repository_url: 'https://github.com/acme/final-location',
    package_identifier: '@acme/refreshed',
    registry_type: 'npm',
  }));
  assert.equal(mutable.find('https://github.com/acme/new-location', null, null, ''), null);
  assert.equal(mutable.find(null, null, null, 'upsert-target'), null);
  assert.equal(
    mutable.find('https://github.com/acme/final-location', '@acme/refreshed', 'npm', ''),
    'upsert-target',
  );
  assert.equal(mutable.find(null, null, null, 'refreshed-slug'), 'upsert-target');

  assert.equal(
    normalizeRepositoryUrl('git@gitlab.com:Acme/Project.git'),
    'https://gitlab.com/acme/project',
  );
  assert.equal(repositorySource('https://gitlab.com/acme/project'), 'gitlab');
  assert.equal(
    normalizeRepositoryUrl('www.github.com/Acme/Project.git'),
    'https://github.com/acme/project',
  );
  assert.equal(repositorySource('https://www.github.com/acme/project'), 'github');
  assert.equal(extractRepoKey('github.com/Acme/Project'), 'acme/project');
  assert.equal(
    normalizeRepositoryUrl('//www.github.com/Acme/Project.git'),
    'https://github.com/acme/project',
  );
  assert.equal(repositorySource('//github.com/acme/project'), 'github');
  assert.equal(extractRepoKey('//github.com/Acme/Project'), 'acme/project');
  assert.equal(
    normalizeRepositoryUrl('https://github.com/Acme/Project.git/'),
    'https://github.com/acme/project',
  );
  assert.equal(normalizeRepositoryUrl('example.com/acme/project'), 'example.com/acme/project');
  assert.equal(repositorySource('https://example.com/acme/project'), null);
  assert.equal(extractRepoKey('example.com/acme/project'), null);

  // Upstream declares nextCursor with `omitempty`: even an exact-full page may
  // legally be terminal when the cursor is absent.
  assert.doesNotThrow(() => validateOfficialPage({
    servers: Array.from({ length: 100 }, () => ({})),
    metadata: { count: 100 },
  }));

  let buildQueries = 0;
  let buildSql = '';
  const queryBounded = buildDedupIndex({
    prepare(sql) {
      buildQueries++;
      buildSql = sql;
      return {
        all: () => [row('indexed', { repository_url: 'https://github.com/acme/indexed' })],
      };
    },
  });
  for (let index = 0; index < 100; index++) {
    queryBounded.find('https://github.com/acme/indexed', null, null, '');
  }
  assert.equal(buildQueries, 1);
  assert.doesNotMatch(buildSql, /LIKE/i);
}
