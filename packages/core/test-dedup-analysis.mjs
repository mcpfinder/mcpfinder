/**
 * Diagnostic: instrument findExistingServer to see WHY dedup collapses so much
 * but yields so few cross-registry sources.
 */
import { initDatabase, syncOfficialRegistry, syncGlamaRegistry, syncSmitheryRegistry, getServerCount } from './dist/index.js';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mcpf-dedup-'));
process.env.MCPFINDER_DATA_DIR = dir;
const db = initDatabase();

// Step 1: sync official
await syncOfficialRegistry(db);
const officialCount = getServerCount(db);
console.log(`[1] official sync: ${officialCount} servers`);

// Snapshot official IDs + slugs + repo URLs
const officialIds = new Set(db.prepare('SELECT id FROM servers').all().map(r => r.id));
const officialSlugs = new Set(db.prepare('SELECT slug FROM servers WHERE slug IS NOT NULL AND slug != ""').all().map(r => r.slug));
console.log(`    official ids=${officialIds.size} unique slugs=${officialSlugs.size}`);

// Step 2: sync glama
await syncGlamaRegistry(db);
const afterGlama = getServerCount(db);
console.log(`[2] after glama: ${afterGlama} servers (+${afterGlama - officialCount})`);

// Examine: which servers have 'glama' in sources?
const glamaPresent = db.prepare(`SELECT id, source, sources, repository_url FROM servers WHERE sources LIKE '%glama%'`).all();
const glamaInSourcesCount = glamaPresent.length;
const glamaPrimary = glamaPresent.filter(r => r.source === 'glama').length;
const glamaMergedIntoOther = glamaPresent.filter(r => r.source !== 'glama').length;
console.log(`    servers with 'glama' in sources: ${glamaInSourcesCount}`);
console.log(`    primary=glama: ${glamaPrimary}`);
console.log(`    primary!=glama but sources contains glama: ${glamaMergedIntoOther}`);

// Of glamaMergedIntoOther, how many ended up with primary=official?
const glamaMergedIntoOfficial = glamaPresent.filter(r => r.source === 'official').length;
console.log(`    merged into official: ${glamaMergedIntoOfficial}`);

// Sanity: of primary=glama rows, how many have slug that collides with an official slug?
const glamaRowsSlugs = db.prepare(`SELECT slug FROM servers WHERE source = 'glama'`).all().map(r => r.slug);
const glamaWithOfficialSlug = glamaRowsSlugs.filter(s => officialSlugs.has(s)).length;
console.log(`    primary=glama rows whose slug also exists in official: ${glamaWithOfficialSlug}  <-- these were NOT deduplicated`);

// Step 3: sync smithery
await syncSmitheryRegistry(db);
const afterSmithery = getServerCount(db);
console.log(`[3] after smithery: ${afterSmithery} servers (+${afterSmithery - afterGlama})`);

const smitheryPresent = db.prepare(`SELECT id, source, sources FROM servers WHERE sources LIKE '%smithery%'`).all();
const smitheryMergedIntoOfficial = smitheryPresent.filter(r => r.source === 'official').length;
const smitheryMergedIntoGlama = smitheryPresent.filter(r => r.source === 'glama').length;
console.log(`    smithery in sources: ${smitheryPresent.length}`);
console.log(`    smithery merged into official: ${smitheryMergedIntoOfficial}`);
console.log(`    smithery merged into glama: ${smitheryMergedIntoGlama}`);

// Multi-source breakdown
const multi = db.prepare(`SELECT sources, COUNT(*) c FROM servers GROUP BY sources ORDER BY c DESC LIMIT 20`).all();
console.log('\n  sources array distribution (top 20):');
for (const r of multi) console.log('   ', r.sources, '->', r.c);

// How many have >1 sources?
const multiCount = db.prepare(`SELECT COUNT(*) c FROM servers WHERE sources LIKE '%,%'`).get().c;
console.log(`\n  servers with >1 source: ${multiCount}`);

// Sample the overlap by picking a well-known server like 'github' or 'filesystem'
console.log('\n  example: rows with name containing "github" (primary sources):');
const ghRows = db.prepare(`SELECT id, name, slug, source, sources, repository_url FROM servers WHERE name LIKE '%github%' LIMIT 10`).all();
for (const r of ghRows) console.log(`    [${r.source}] ${r.id} slug=${r.slug} repo=${r.repository_url} srcs=${r.sources}`);

// Probe: find official "github" server's slug, then check if glama has any server with same slug
const officialGithub = db.prepare(`SELECT id, name, slug, repository_url FROM servers WHERE source='official' AND (name LIKE '%github%' OR slug LIKE '%github%') LIMIT 5`).all();
console.log('\n  official "github-ish" servers:');
for (const o of officialGithub) {
  console.log(`    ${o.id} slug=${o.slug} repo=${o.repository_url}`);
  const glamaSameSlug = db.prepare(`SELECT id, name, slug, repository_url FROM servers WHERE source='glama' AND slug = ? LIMIT 3`).all(o.slug);
  for (const g of glamaSameSlug) console.log(`      glama collision: ${g.id} slug=${g.slug} repo=${g.repository_url}`);
}

db.close();
rmSync(dir, { recursive: true, force: true });
