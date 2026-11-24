import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mcpf-categories-test-'));
process.env.MCPFINDER_DATA_DIR = dir;

const {
  initDatabase, categorizeServer, assignCategories, getServersByCategory, listCategories,
  syncOfficialRegistry, syncGlamaRegistry,
} =
  await import('../packages/core/dist/index.js');

// Whole words only: substrings no longer match.
assert.deepEqual(categorizeServer('acme/mailer', 'Send email from AI agents'), ['communication']);
assert.ok(!categorizeServer('acme/x', 'A digital legit tool').includes('git'));
assert.ok(!categorizeServer('acme/x', 'Read emails').includes('ai'));

// The registry namespace says nothing about the server.
assert.ok(!categorizeServer('io.github.acme/weather', 'Weather forecasts').includes('git'));
assert.ok(categorizeServer('io.github.acme/github-issues', 'Manage issues').includes('git'));

// Word forms and phrases.
assert.ok(categorizeServer('acme/x', 'Deploying containers to Kubernetes').includes('cloud'));
assert.ok(categorizeServer('acme/x', 'Read and write files').includes('filesystem'));
assert.ok(categorizeServer('acme/x', 'Scraping product pages').includes('web'));
assert.ok(categorizeServer('acme/x', 'Run a web search').includes('search'));
assert.ok(!categorizeServer('acme/x', 'Search your tickets').includes('search'));
assert.ok(categorizeServer('acme/x', 'Accept Stripe payments').includes('finance'));
assert.deepEqual(categorizeServer('acme/x', 'Global tsunami events from NOAA'), ['other']);

// A keyword's e-less stem only takes vowel-initial suffixes.
assert.ok(!categorizeServer('acme/x', 'Get a user by ID').includes('dev-tools'));
assert.ok(!categorizeServer('acme/x', 'Strip HTML tags').includes('finance'));
assert.ok(!categorizeServer('acme/x', 'Parse a CV').includes('security'));
assert.ok(categorizeServer('acme/x', 'Scraping product pages').includes('web'));
assert.ok(categorizeServer('acme/x', 'Data encryption at rest').includes('security'));

// assignCategories stores the same result in the categories column.
const db = initDatabase();
const insert = db.prepare(`
  INSERT INTO servers (id, slug, name, description, status, sources, raw_data, env_vars, source, last_synced_at, updated_at)
  VALUES (@id, @id, @name, @description, 'active', '["official"]', '{}', '[]', 'official', @now, @now)
`);
const now = new Date().toISOString();
insert.run({ id: 'a', name: 'io.github.acme/pg', description: 'Query a PostgreSQL database', now });
insert.run({ id: 'b', name: 'acme/mailer', description: 'Send email via SMTP', now });
insert.run({ id: 'c', name: 'acme/tsunami', description: 'Global tsunami events', now });
assert.equal(assignCategories(db), 3);
const stored = Object.fromEntries(
  db.prepare('SELECT id, categories FROM servers').all().map((r) => [r.id, JSON.parse(r.categories)]),
);
assert.deepEqual(stored.a, ['database']);
assert.deepEqual(stored.b, ['communication']);
assert.deepEqual(stored.c, ['other']);

// Browsing uses the same rule.
assert.deepEqual(getServersByCategory(db, 'database').map((r) => r.name), ['io.github.acme/pg']);
assert.deepEqual(getServersByCategory(db, 'ai'), []);
assert.deepEqual(getServersByCategory(db, 'no-such-category'), []);
assert.deepEqual(getServersByCategory(db, 'other').map((r) => r.name), ['acme/tsunami']);
assert.deepEqual(listCategories(db).map((c) => c.name).sort(), ['communication', 'database', 'other']);
assert.deepEqual(listCategories(db).find((c) => c.name === 'other'), { name: 'other', count: 1, keywords: [] });

// Limit keeps SQL LIMIT semantics: 0 → none, negative → all.
insert.run({ id: 'd', name: 'acme/mysql', description: 'MySQL database access', now });
assert.deepEqual(getServersByCategory(db, 'database', 0), []);
assert.equal(getServersByCategory(db, 'database', 1).length, 1);
assert.equal(getServersByCategory(db, 'database', -1).length, 2);

// Sync write paths that change a description clear stale stored categories,
// so getServerDetails falls back to categorizeServer.
const runtime = (body) => ({ fetchImpl: async () => Response.json(body), now: () => 0, sleep: async () => {} });
const officialFeed = (description) => ({
  servers: [{ server: {
    name: 'io.github.acme/thing', version: '1.0.0', description,
    repository: { url: 'https://github.com/acme/thing', source: 'github' },
  } }],
  metadata: { count: 1 },
});
const categoriesOf = (where) => JSON.parse(db.prepare(`SELECT categories FROM servers WHERE ${where}`).get().categories);
await syncOfficialRegistry(db, runtime(officialFeed('Send email')));
assignCategories(db);
const thing = "name = 'io.github.acme/thing'";
assert.deepEqual(categoriesOf(thing), ['communication']);
await syncOfficialRegistry(db, runtime(officialFeed('Send email')));
assert.deepEqual(categoriesOf(thing), ['communication'], 'unchanged description keeps categories');
await syncOfficialRegistry(db, runtime(officialFeed('Query a PostgreSQL database and more')));
assert.deepEqual(categoriesOf(thing), []);

// Merge path: a Glama entry for the same server carrying a longer description.
process.env.GLAMA_API_KEY ||= 'test-key';
assignCategories(db);
assert.deepEqual(categoriesOf(thing), ['database']);
await syncGlamaRegistry(db, runtime({
  servers: [{
    id: 'thing', name: 'thing', namespace: 'acme', slug: 'thing',
    description: 'Query a PostgreSQL database and send Slack messages to your team channels',
    repository: { url: 'https://github.com/acme/thing' }, spdxLicense: null, tools: [], url: null,
    environmentVariablesJsonSchema: null, attributes: {},
  }],
  pageInfo: { hasNextPage: false, endCursor: null },
}));
const merged = db.prepare(`SELECT description, categories FROM servers WHERE ${thing}`).get();
assert.deepEqual(JSON.parse(merged.categories), []);

db.close();
rmSync(dir, { recursive: true, force: true });
console.log('category checks passed');
