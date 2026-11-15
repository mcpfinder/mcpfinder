/**
 * Search relevance regression suite.
 *
 * These checks pin ranking, not plumbing. They exist because a name-match boost
 * that fired on the reverse-DNS hosting prefix (`io.github.<owner>/<repo>`) made
 * `search_mcp_servers("github")` return five servers with nothing to do with
 * GitHub — NIST NVD, OpenAlex, arXiv, PubMed, OpenStreetMap — while the catalog
 * held three genuine GitHub servers. On the 89,840-row snapshot of 2026-08-27,
 * 19.6% of names start with `io.github.`, so 94.0% of the 19,129 hits for
 * "github" collected the full +5.0 boost (98.0% of those purely via the prefix)
 * and the boost degenerated into a constant. Nothing in the test suite noticed.
 *
 * The corpora below are built in code, small enough to reason about by hand, and
 * shaped to reproduce that collision: `<prefix><owner>/<not-github>` decoys with
 * high `use_count` against one genuine, less-used match.
 *
 * What these checks pin, and what they cannot:
 *
 * Stripping is *reliably* observable only when the query term occurs **in the
 * prefix itself**. The boost is an unanchored `LIKE '%term%'`, so cutting
 * `io.github.` off `io.github.cyanheads/orcid-server` changes nothing for the
 * term "orcid" — it matches either way. Any check meant to go red when a prefix
 * entry is deleted is therefore built around "github" or "smithery", the words
 * that live inside the prefixes.
 *
 * There is a second, unreliable channel, and it is worth naming so nobody
 * mistakes it for coverage: the detail scorer ranks by `indexOf`, so changing
 * how many characters are cut — including cutting none at all — shifts every
 * positional score in the JS path, even for a leaf term. That flips a result
 * only when two candidates sit within the shift of each other, which is a
 * property of the fixture's arithmetic rather than of the code under test. Some
 * mutations here die that way (the "cyanheads" edge fixture kills a wholesale
 * deletion of the `io.github.` rule by one point); others survive. Build new
 * checks on the first channel and treat the second as a bonus.
 *
 * On that basis every branch of the table is exercised, in both the SQL path
 * (`searchServers`) and the JS path (`findServerByNameOrSlug`):
 *   - `io.github.` / `ai.smithery/` / `ai.smithery.` in names
 *   - `io-github-` / `ai-smithery-` in slugs, and *not* in names
 *   - upper-case spellings, which SQLite `LIKE` folds and `startsWith` does not
 *
 * The accepted cost, asserted here in that direction: `ai.smithery/brave-search`
 * can no longer win the query "smithery" against a server genuinely named for
 * smithing, because its only "smithery" is provenance.
 *
 * The offsets are pinned unevenly, verified by mutation:
 *   - cutting one character too many is caught in both paths — the first real
 *     character of the leaf disappears and the token stops matching;
 *   - cutting one too few is caught in the JS path only, and only incidentally:
 *     the leftover `.` shifts every positional score by one, which the
 *     case-folding fixture below notices because its margin happens to be one
 *     point. Do not rely on it; it is not what that fixture is for.
 *   - cutting one too few in the SQL path is invisible and no fixture here can
 *     change that. The character left behind is the prefix's own `.` or `/`,
 *     and an unanchored `LIKE '%term%'` does not care what precedes the match.
 *     Saying so beats advertising coverage that does not exist.
 *
 * Several checks pit a fixture against a competitor whose score is a couple of
 * points worse, and spell that arithmetic out. That is deliberate: some of these
 * defects are latent (a wrong `stripHostingPrefix` on an upper-case *name* is
 * masked by the slug, which is always lower-case), and a test that only pins a
 * user-visible symptom would not catch them.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Topics chosen so no decoy mentions GitHub anywhere except in its hosting
// prefix — every "github" token they carry is provenance.
const DECOY_TOPICS = [
  'pubmed', 'arxiv', 'openalex', 'nist-nvd', 'openstreetmap', 'socrata',
  'congressgov', 'weather', 'wikipedia', 'crossref', 'orcid', 'datagov',
];

function insert(db, row) {
  db.prepare(`
    INSERT INTO servers (id, slug, name, description, keywords, sources, use_count, verified)
    VALUES (@id, @slug, @name, @description, @keywords, @sources, @use_count, @verified)
  `).run({
    keywords: '[]',
    sources: '["glama"]',
    use_count: 0,
    verified: 0,
    ...row,
  });
}

/**
 * Decoys share the `io.github.` prefix and one owner, so owner queries work.
 * `count` overshoots the 50-row candidate window of `findServerByNameOrSlug`
 * when asked to.
 */
function seedDecoys(db, { owner = 'cyanheads', count = DECOY_TOPICS.length } = {}) {
  for (let i = 0; i < count; i++) {
    const topic = `${DECOY_TOPICS[i % DECOY_TOPICS.length]}${i >= DECOY_TOPICS.length ? i : ''}`;
    const name = `io.github.${owner}/${topic}-mcp-server`;
    insert(db, {
      id: name,
      // Slugs flatten every non-alphanumeric run to a dash, so the same prefix
      // only ever appears as `io-github-`.
      slug: `io-github-${owner}-${topic}-mcp-server`,
      name,
      description: `${topic} research and lookup tools`,
      // Decoys are the popular ones: the fix must win on relevance alone.
      use_count: 5000 + i * 100,
    });
  }
}

function names(results) {
  return results.map((r) => r.name);
}

/** Seeds the corpus the search-path checks share. */
function seedSearchCorpus(db) {
  seedDecoys(db);
  insert(db, {
    id: 'universal-mcp/github',
    slug: 'github',
    name: 'universal-mcp/GitHub Universal MCP Server',
    description: 'Manage GitHub repositories, issues and pull requests',
    // Deliberately less used than every decoy.
    use_count: 900,
  });
  insert(db, {
    id: 'com.example/postgres-mcp',
    slug: 'postgres-mcp',
    name: 'com.example/postgres-mcp',
    description: 'Query Postgres databases over MCP: run read-only SQL, list schemas and tables, and explain query plans',
    // No popularity edge: the live catalog has use_count 0 everywhere, and a
    // head start here would hide the stack-generator regression below.
  });
  // Stack generators: short, keyword-stuffed, official, and each naming
  // "postgres". Every one ties with the real server on the name boost, and BM25
  // length normalization favours them, so only name focus can order them below.
  for (const other of ['redis', 'grafana', 'kafka', 'minio']) {
    const name = `com.example/postgres-${other}-stack-generator`;
    const title = `Postgres + ${other[0].toUpperCase()}${other.slice(1)} Stack Generator`;
    insert(db, {
      id: name,
      slug: `postgres-${other}-stack-generator`,
      name,
      description: title,
      keywords: JSON.stringify(['postgres', other, 'stack', 'generator', 'postgres']),
      sources: '["official"]',
    });
  }
  insert(db, {
    id: 'com.example/slack',
    slug: 'slack',
    name: 'com.example/slack',
    description: 'Read channels, post messages and search history in a Slack workspace',
  });
  // Hyphenated query: the term must be tokenized like the name, or no leaf
  // token contains "brave-search" and the generator gets the fallback focus.
  insert(db, {
    id: 'com.example/brave-search',
    slug: 'brave-search',
    name: 'com.example/brave-search',
    description: 'Web and news results from the Brave Search API with freshness filters',
  });
  insert(db, {
    id: 'com.example/brave-search-reddit-stack-generator',
    slug: 'brave-search-reddit-stack-generator',
    name: 'com.example/brave-search-reddit-stack-generator',
    description: 'Brave Search + Reddit Stack Generator',
    keywords: JSON.stringify(['brave-search', 'reddit', 'stack', 'generator']),
    sources: '["official"]',
  });
  // One-letter part of a hyphenated query: `e` occurs in every token of this
  // generator's name (redis, webhook, generator), so it must not count as a
  // name match, and the real server's own `e` must not dilute its focus.
  insert(db, {
    id: 'com.example/e-commerce',
    slug: 'e-commerce',
    name: 'com.example/e-commerce',
    description: 'Manage storefront products, orders and customers for an online e-commerce shop',
  });
  insert(db, {
    id: 'com.example/e-commerce-redis-webhook-generator',
    slug: 'e-commerce-redis-webhook-generator',
    name: 'com.example/e-commerce-redis-webhook-generator',
    description: 'E-Commerce + Redis Webhook Generator',
    keywords: JSON.stringify(['e-commerce', 'redis', 'webhook', 'generator']),
    sources: '["official"]',
  });
  insert(db, {
    id: 'com.example/slack-webhook-relay-shape',
    slug: 'slack-webhook-relay-shape',
    name: 'com.example/slack-webhook-relay-shape',
    description: 'Slack webhook shape',
    sources: '["official"]',
  });
  // A vendor's own server: the term is only in the namespace and the leaf is
  // generic. It must keep the full boost against a name that lists the vendor.
  insert(db, {
    id: 'com.acmevendor/mcp',
    slug: 'acmevendor-mcp',
    name: 'com.acmevendor/mcp',
    description: 'Official server for the platform: projects, tables and storage',
  });
  insert(db, {
    id: 'com.example/acmevendor-backup-tool',
    slug: 'acmevendor-backup-tool',
    name: 'com.example/acmevendor-backup-tool',
    description: 'Acmevendor backups',
    sources: '["official"]',
  });
  insert(db, {
    id: 'com.example/filesystem',
    slug: 'filesystem',
    name: 'com.example/filesystem',
    description: 'Read and write local filesystem paths',
    use_count: 300,
  });
  // Upper-case hosting prefix. SQLite LIKE folds ASCII case, so this must be
  // stripped exactly like its lower-case siblings; if it is not, its 80k
  // use_count plus a spurious "github" boost puts it on top.
  insert(db, {
    id: 'IO.GITHUB.MegaCorp/Weather-Tools',
    slug: 'io-github-megacorp-weather-tools',
    name: 'IO.GITHUB.MegaCorp/Weather-Tools',
    description: 'Weather forecasts and station readings',
    use_count: 80000,
  });
  // Smithery, both spellings, each paired with a far more popular competitor
  // that carries the same topic word in its description only. The Smithery row
  // can only win via the name-match boost, and the boost can only fire if the
  // prefix was cut at exactly the right offset.
  insert(db, {
    id: 'ai.smithery/europepmc-server',
    slug: 'ai-smithery-europepmc-server',
    name: 'ai.smithery/europepmc-server',
    description: 'Biomedical fulltext retrieval',
    use_count: 100,
  });
  insert(db, {
    id: 'com.example/biolit-hub',
    slug: 'biolit-hub',
    name: 'com.example/biolit-hub',
    description: 'Search europepmc abstracts and citations',
    use_count: 90000,
  });
  insert(db, {
    id: 'ai.smithery.chembl-server',
    slug: 'ai-smithery-chembl-server',
    name: 'ai.smithery.chembl-server',
    description: 'Chemical bioactivity database access',
    use_count: 100,
  });
  insert(db, {
    id: 'com.example/chem-hub',
    slug: 'chem-hub',
    name: 'com.example/chem-hub',
    description: 'Lookup chembl compounds and assays',
    use_count: 90000,
  });
  // Same trap for the `io.github.` offset: the owner segment survives stripping,
  // so an owner query must still beat this.
  insert(db, {
    id: 'com.example/research-hub',
    slug: 'research-hub',
    name: 'com.example/research-hub',
    description: 'Aggregates cyanheads style research tooling',
    use_count: 50000,
  });
}

function checkSearchPath(searchServers, db) {
  // The regression itself: a hosting prefix must not out-rank a real match.
  const github = searchServers(db, 'github', 5);
  assert.equal(
    github[0]?.name,
    'universal-mcp/GitHub Universal MCP Server',
    `"github" must surface the actual GitHub server, got: ${names(github).join(', ')}`,
  );
  // Independent of the assertion above: with the prefix no longer scoring, the
  // boost is a constant across the decoys, so what remains to order them is
  // popularity. If any of them were still collecting a name-match boost the
  // ordering below would not be monotonic.
  const decoyUse = github.filter((r) => r.name.toLowerCase().startsWith('io.github.')).map((r) => r.useCount);
  assert.ok(decoyUse.length >= 2, `expected several io.github.* decoys in the tail, got: ${names(github).join(', ')}`);
  assert.deepEqual(
    decoyUse,
    [...decoyUse].sort((a, b) => b - a),
    `unboosted decoys must fall back to popularity order, got: ${decoyUse.join(', ')}`,
  );

  // "gh" expands through SEARCH_ALIASES and must inherit the same ranking.
  assert.deepEqual(
    names(searchServers(db, 'gh', 5)),
    names(github),
    'alias "gh" must rank identically to "github"',
  );

  // Non-regression: queries that never collide with a hosting prefix keep their
  // result.
  assert.equal(searchServers(db, 'filesystem', 5)[0]?.name, 'com.example/filesystem');

  // Name focus: a name *about* the term beats short entries that merely list it
  // (live catalog: 95 `*-stack-generator` rows took "postgres" #1-#12).
  const postgres = searchServers(db, 'postgres', 5);
  assert.equal(
    postgres[0]?.name,
    'com.example/postgres-mcp',
    `"postgres" must surface the real server before stack generators, got: ${names(postgres).join(', ')}`,
  );
  assert.equal(
    searchServers(db, 'slack', 5)[0]?.name,
    'com.example/slack',
    'a focused name must beat a short official entry that lists the term',
  );
  assert.equal(
    searchServers(db, 'brave-search', 5)[0]?.name,
    'com.example/brave-search',
    'a hyphenated query must be tokenized like the name it is matched against',
  );
  assert.equal(
    searchServers(db, 'e-commerce', 5)[0]?.name,
    'com.example/e-commerce',
    'a one-character part of a hyphenated query must not match every name token',
  );
  assert.equal(
    searchServers(db, 'acmevendor', 5)[0]?.name,
    'com.acmevendor/mcp',
    "a term in the namespace with a generic leaf is the vendor's own server and keeps the full boost",
  );

  // Stripping removes the hosting namespace, never the owner segment — for
  // every prefix spelling, and regardless of case.
  const owner = searchServers(db, 'cyanheads', 5);
  assert.equal(
    owner[0]?.name,
    'io.github.cyanheads/datagov-mcp-server',
    `owner query must beat the popular competitor, got: ${names(owner).join(', ')}`,
  );
  assert.ok(
    owner.slice(0, 3).every((r) => r.name.startsWith('io.github.cyanheads/')),
    `owner query must return that owner's servers, got: ${names(owner).join(', ')}`,
  );
  assert.equal(
    searchServers(db, 'megacorp', 5)[0]?.name,
    'IO.GITHUB.MegaCorp/Weather-Tools',
    'upper-case names must be stripped and their owner segment still searchable',
  );
  assert.equal(
    searchServers(db, 'europepmc', 5)[0]?.name,
    'ai.smithery/europepmc-server',
    '`ai.smithery/` must be cut at the slash, leaving the topic matchable',
  );
  assert.equal(
    searchServers(db, 'chembl', 5)[0]?.name,
    'ai.smithery.chembl-server',
    '`ai.smithery.` must be cut at the dot, leaving the topic matchable',
  );
}

/**
 * The dashed spellings are hosting markers in generated slugs only, and the SQL
 * name expression must not know them. Kept in its own corpus because the
 * high-traffic competitor it needs would otherwise skew the shared one.
 */
function checkSqlNameSlugSplit(initDatabase, searchServers, dir) {
  const db = initDatabase(join(dir, 'name-slug.sqlite'));
  insert(db, {
    id: 'io-github-actions/workflow-runner',
    slug: 'gh-actions-workflow-runner',
    name: 'io-github-actions/workflow-runner',
    description: 'Dispatch and control workflow runs',
    use_count: 100,
  });
  insert(db, {
    id: 'com.example/ci-hub',
    slug: 'ci-hub',
    name: 'com.example/ci-hub',
    description: 'Helpers around io-github-actions workflows',
    use_count: 90000,
  });
  // The query term spans the dashed prefix, so it only survives in the name if
  // the name expression leaves that prefix alone. Strip it and the name-match
  // boost vanishes and the 90k-use competitor takes the slot.
  assert.equal(
    searchServers(db, 'io-github-actions', 5)[0]?.name,
    'io-github-actions/workflow-runner',
    'dashed prefixes must not be stripped from names in SQL either',
  );
  db.close();
}

/**
 * The two dotted Smithery spellings, in both paths. These are the only checks
 * that can kill the `ai.smithery/` and `ai.smithery.` rows of the prefix table,
 * for the reason given at the top of the file: the query term has to sit in the
 * prefix, so it has to be "smithery" itself. Hence the shape — a hugely popular
 * `ai.smithery/<something-unrelated>` against one modest server whose name
 * really contains the word.
 *
 * One database per spelling, so deleting one table row reddens one check and
 * names itself in the failure.
 */
function checkSmitheryNameBranches(initDatabase, searchServers, findServerByNameOrSlug, dir) {
  for (const prefix of ['ai.smithery/', 'ai.smithery.']) {
    const db = initDatabase(join(dir, `smithery-${prefix.slice(-1) === '/' ? 'slash' : 'dot'}.sqlite`));
    // Provenance only: "smithery" appears in the name's prefix and nowhere else
    // — not in the leaf, not in the description. It reaches FTS through the
    // prefix token and would out-rank anything on popularity if it were boosted.
    insert(db, {
      id: `${prefix}brave-search`,
      slug: 'ai-smithery-brave-search',
      name: `${prefix}brave-search`,
      description: 'Web index search and news lookup',
      use_count: 90000,
    });
    // The genuine one: "smithery" mid-word in name and slug, so the detail
    // scorer gives it 63 (substring hit at slug position 13) — deliberately
    // worse than the 53 the decoy would score if its prefix went unstripped,
    // and far worse than the 23 it would score from an unstripped slug.
    insert(db, {
      id: 'com.example/the-old-blacksmithery',
      slug: 'the-old-blacksmithery',
      name: 'com.example/the-old-blacksmithery',
      description: 'Smithery deployment helpers',
      use_count: 10,
    });

    // SQL path: the decoy's 90k popularity is worth ~2.3 points, the boost 5.0.
    // Leave `${prefix}` in the name expression and the decoy collects the boost
    // too, and popularity decides — the exact degeneration this delta fixes.
    assert.equal(
      searchServers(db, 'smithery', 5)[0]?.name,
      'com.example/the-old-blacksmithery',
      `\`${prefix}\` must not earn a name-match boost for "smithery" in searchServers`,
    );
    assert.equal(
      findServerByNameOrSlug(db, 'smithery')?.name,
      'com.example/the-old-blacksmithery',
      `\`${prefix}\` must not out-score a real "smithery" name in findServerByNameOrSlug`,
    );
    db.close();
  }
}

function checkDetailPath(initDatabase, findServerByNameOrSlug, dir) {
  // `findServerByNameOrSlug` scores by match position, and `io-github-` in a
  // slug is a word-boundary hit at position 3 — better than a genuine match
  // deeper in the name. Candidate selection has to agree with that scoring:
  // 60 decoys is more than the 50-row window, so if the query still ordered by
  // popularity alone the genuine match would never reach the scorer.
  const detailDb = initDatabase(join(dir, 'detail.sqlite'));
  seedDecoys(detailDb, { count: 60 });
  insert(detailDb, {
    id: 'com.example/awesome-github-tools',
    slug: 'awesome-github-tools',
    name: 'com.example/awesome-github-tools',
    description: 'GitHub automation helpers',
    use_count: 10,
  });
  // Scores 51 (substring hit at slug position 1); the decoys score 10 via their
  // stripped slug, so a mis-cut prefix on either field hands the lookup to this.
  insert(detailDb, {
    id: 'com.example/xcyanheads-hub',
    slug: 'xcyanheads-hub',
    name: 'com.example/xcyanheads-hub',
    description: 'Unrelated aggregator',
    use_count: 20,
  });

  assert.equal(
    findServerByNameOrSlug(detailDb, 'github')?.name,
    'com.example/awesome-github-tools',
    'lookup for "github" must not resolve to a hosting prefix, even past the 50-row window',
  );
  assert.equal(
    findServerByNameOrSlug(detailDb, 'cyanheads')?.name,
    // Highest use_count of the 60 decoys — the last one seeded.
    'io.github.cyanheads/datagov59-mcp-server',
    'owner lookup must survive stripping, tie-broken by popularity as before',
  );
  // Rows that match only through their raw prefix stay reachable — they just
  // never take a candidate slot from a stripped match.
  assert.ok(
    findServerByNameOrSlug(detailDb, 'io.github.cyanheads')?.name.startsWith('io.github.cyanheads/'),
    'a literal hosting-prefix lookup must still resolve',
  );
  detailDb.close();

  // Smithery, in the JS path: the `ai-smithery-` slug spelling and the two
  // dotted name spellings.
  const smitheryDb = initDatabase(join(dir, 'smithery.sqlite'));
  for (const topic of DECOY_TOPICS.slice(0, 6)) {
    insert(smitheryDb, {
      id: `ai.smithery/${topic}-server`,
      slug: `ai-smithery-${topic}-server`,
      name: `ai.smithery/${topic}-server`,
      description: `${topic} lookup tools`,
      use_count: 5000,
    });
  }
  insert(smitheryDb, {
    id: 'ai.smithery.orcid-server',
    slug: 'ai-smithery-orcid-server',
    name: 'ai.smithery.orcid-server',
    description: 'Researcher identifier lookup',
    use_count: 30,
  });
  insert(smitheryDb, {
    id: 'com.example/awesome-smithery-tools',
    slug: 'awesome-smithery-tools',
    name: 'com.example/awesome-smithery-tools',
    description: 'Smithery deployment helpers',
    use_count: 10,
  });
  insert(smitheryDb, {
    id: 'com.example/xorcid-hub',
    slug: 'xorcid-hub',
    name: 'com.example/xorcid-hub',
    description: 'Unrelated aggregator',
    use_count: 40,
  });

  // Genuine match scores 28 (word-boundary hit in its slug). Leave the
  // `ai-smithery-` slugs unstripped and the decoys score 23 and take it.
  assert.equal(
    findServerByNameOrSlug(smitheryDb, 'smithery')?.name,
    'com.example/awesome-smithery-tools',
    'lookup for "smithery" must not resolve to an `ai-smithery-` slug prefix',
  );
  // Prefix cut one character too long and `orcid-server` stops being a prefix
  // of the stripped name (score 10), leaving xorcid-hub (score 51). A cut one
  // character short is NOT caught here: it leaves `-orcid-server`, still a
  // word-boundary hit at 21, and this check stays green.
  assert.equal(
    findServerByNameOrSlug(smitheryDb, 'orcid')?.name,
    'ai.smithery.orcid-server',
    '`ai.smithery.` must be cut at the dot in the JS path too',
  );
  smitheryDb.close();

  // Case folding and the name/slug split, isolated. Both are latent defects —
  // the production corpus masks them — so they are pinned by arithmetic.
  const edgeDb = initDatabase(join(dir, 'edge.sqlite'));
  // Slug deliberately carries no owner token, so only the name can match and
  // the always-lower-case slug cannot mask a case-sensitive strip. Stripped it
  // scores 50; left whole it scores 60 and loses to the 51 below.
  insert(edgeDb, {
    id: 'IO.GITHUB.Cyanheads/openalex-server',
    slug: 'openalex-server',
    name: 'IO.GITHUB.Cyanheads/openalex-server',
    description: 'Scholarly graph lookup',
    use_count: 100,
  });
  insert(edgeDb, {
    id: 'xcyanheads-tools',
    slug: 'xcyanheads-tools',
    name: 'xcyanheads-tools',
    description: 'Unrelated tools',
    use_count: 100,
  });
  assert.equal(
    findServerByNameOrSlug(edgeDb, 'cyanheads')?.name,
    'IO.GITHUB.Cyanheads/openalex-server',
    'the JS strip must fold case the way SQLite LIKE does',
  );

  // `io-github-` is a hosting marker in generated slugs only; a name that
  // genuinely starts that way must keep it. Stripped, this name scores 1000 and
  // the 67-point competitor below wins; kept, it scores 50 and wins.
  insert(edgeDb, {
    id: 'io-github-actions/runner',
    slug: 'gh-actions',
    name: 'io-github-actions/runner',
    description: 'Workflow runner control',
    use_count: 100,
  });
  insert(edgeDb, {
    id: 'com.example/toolsio-github-actionsx',
    slug: 'q-tools',
    name: 'com.example/toolsio-github-actionsx',
    description: 'Unrelated tools',
    use_count: 100,
  });
  assert.equal(
    findServerByNameOrSlug(edgeDb, 'io-github-actions')?.name,
    'io-github-actions/runner',
    'dashed prefixes are slug-only; a name starting with one must not be stripped',
  );
  edgeDb.close();
}

export async function runSearchRelevanceChecks() {
  const { initDatabase, searchServers, findServerByNameOrSlug } = await import(
    '../packages/core/dist/index.js'
  );
  const dir = mkdtempSync(join(tmpdir(), 'mcpf-search-relevance-'));

  try {
    const searchDb = initDatabase(join(dir, 'search.sqlite'));
    seedSearchCorpus(searchDb);
    checkSearchPath(searchServers, searchDb);
    searchDb.close();

    checkSqlNameSlugSplit(initDatabase, searchServers, dir);
    checkSmitheryNameBranches(initDatabase, searchServers, findServerByNameOrSlug, dir);
    checkDetailPath(initDatabase, findServerByNameOrSlug, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
