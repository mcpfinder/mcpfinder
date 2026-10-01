/**
 * Search engine using SQLite FTS5 for MCP server discovery.
 *
 * Ranking formula, per candidate row (see `searchServers`):
 *   5.0 for every query term found in the hosting-prefix-stripped name
 * + fts_relevance * 0.3
 * + log(use_count + 1) * 0.2
 * + (3.0 if official | 1.5 if verified | 0) * 0.15
 *
 * The name-match term dominates by design — a query word occurring in the name
 * is the strongest signal we have — which is exactly why it must not fire on
 * the reverse-DNS hosting prefix. See HOSTING_PREFIXES.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { SqlParam } from './db.js';
import type {
  ConfidenceBreakdown,
  McpServer,
  SearchResult,
  ServerDetail,
  ToolSummary,
  TrustSignals,
} from './types.js';
import { categorizeServer } from './categories.js';
import { looksLikeCredentialName } from './credential-hint.js';
import { parseRawEnvelope, rawPayloads } from './raw-envelope.js';

/**
 * Alias dictionary: common abbreviations → full terms.
 * Applied before FTS5 search to expand short queries.
 */
const SEARCH_ALIASES: Record<string, string> = {
  // SCM / Code
  gh: 'github',
  gl: 'gitlab',
  bb: 'bitbucket',
  git: 'git github',
  // Databases
  pg: 'postgres postgresql',
  db: 'database',
  mysql: 'mysql database',
  mongo: 'mongodb',
  redis: 'redis cache',
  sql: 'sql database',
  // Cloud / Infra
  k8s: 'kubernetes',
  aws: 'amazon aws',
  gcp: 'google cloud',
  az: 'azure microsoft',
  cf: 'cloudflare',
  // Languages / Runtimes
  js: 'javascript nodejs',
  ts: 'typescript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  // Communication
  email: 'email smtp gmail',
  msg: 'message messaging',
  // AI / ML
  llm: 'language model ai',
  ml: 'machine learning',
  cv: 'computer vision',
  // Common tools
  fs: 'filesystem file',
  ci: 'continuous integration',
  cd: 'continuous deployment',
  s3: 'amazon s3 storage',
};

/**
 * Hosting prefix: the leading reverse-DNS segment of a server name. It is a
 * namespace saying *where the server's code is hosted* — `io.github.<owner>/`
 * marks a server published from a GitHub repository, `ai.smithery/` one hosted
 * on Smithery — and it is assigned by the Official registry, which owns the
 * reverse-DNS namespace. It is not the registry a server was found in
 * (`io.github.*` entries all come from Official), and it says nothing about
 * what the server does.
 *
 * The owner segment deliberately stays: `com.cloudflare/...` really is
 * Cloudflare's, and a query for an owner (`cyanheads`) has to keep working.
 * There is, after this change, no way to search *by* the hosting namespace:
 * `registrySource` is an official|glama|smithery enum matched against the
 * `sources` column and no value of it selects `io.github.*`.
 *
 * Why this matters, measured on the published snapshot of 2026-08-27 (89,840
 * rows — the same corpus the timings further down were taken on): 19.6% of it
 * (17,636 rows) is named `io.github.%`, so for the query "github" 94.0% of the
 * 19,129 FTS hits collected the full name-match boost — 98.0% of them purely
 * through that prefix. A boost that fires on almost every candidate is a
 * constant, and the ranking collapses onto whatever noise is left. Stripping
 * the prefix before the name test restores it to a signal.
 *
 * Single source of truth for both the SQL and the JS path. `field` is load
 * bearing, not documentation: slugs come out of `slugify()`, which collapses
 * every non-alphanumeric run to a dash, so a dotted prefix can never occur in
 * a slug and a dashed one can never occur in a name. Applying the dashed forms
 * to names would demote a legitimate server actually called `io-github-...`.
 */
const HOSTING_PREFIXES: readonly { prefix: string; field: 'name' | 'slug' }[] = [
  { prefix: 'io.github.', field: 'name' },
  { prefix: 'ai.smithery/', field: 'name' },
  { prefix: 'ai.smithery.', field: 'name' },
  { prefix: 'io-github-', field: 'slug' },
  { prefix: 'ai-smithery-', field: 'slug' },
];

// The prefixes are interpolated into SQL as LIKE literals, so a quote would
// break out of the string and `%`/`_` would silently widen the pattern. The
// list is a constant, so this can only ever fire during development.
for (const { prefix } of HOSTING_PREFIXES) {
  if (/['%_]/.test(prefix)) throw new Error(`unsafe hosting prefix: ${prefix}`);
}

/**
 * SQL expression yielding `column` with its hosting prefix removed. `substr` is
 * 1-indexed, so the first character past the prefix is at `length + 1` —
 * derived from the string rather than hand-counted, because a wrong offset
 * silently over- or under-trims every name in that namespace.
 *
 * Case handling is free here: SQLite `LIKE` is case-insensitive over ASCII.
 */
function hostingPrefixSql(column: string, field: 'name' | 'slug'): string {
  const whens = HOSTING_PREFIXES.filter((p) => p.field === field).map(
    (p) => `WHEN ${column} LIKE '${p.prefix}%' THEN substr(${column}, ${p.prefix.length + 1})`,
  );
  return `CASE ${whens.join(' ')} ELSE ${column} END`;
}

/**
 * JS counterpart of {@link hostingPrefixSql}, for the scoring in
 * `findServerByNameOrSlug`. Matches case-insensitively so the two paths agree
 * on `IO.GITHUB.Foo/Bar` — `String.startsWith` alone would no-op on it and the
 * agreement would rest on callers happening to lowercase first.
 */
function stripHostingPrefix(value: string, field: 'name' | 'slug'): string {
  const lower = value.toLowerCase();
  for (const p of HOSTING_PREFIXES) {
    if (p.field === field && lower.startsWith(p.prefix)) return value.slice(p.prefix.length);
  }
  return value;
}

/**
 * Find a server by name, slug, or fuzzy match.
 *
 * Lookup priority:
 * 1. Exact match (id, slug, name, suffix /query)
 * 2. Fuzzy substring match with smart ranking:
 *    - Exact word boundary match (e.g. /puppeteer) ranks highest
 *    - Closer to start of name ranks higher (puppeteer-xxx > xxx-puppeteer)
 *    - Higher popularity (use_count) breaks ties
 * 3. FTS5 fallback for best semantic match
 */
export function findServerByNameOrSlug(
  db: DatabaseSync,
  nameOrSlug: string,
): McpServer | undefined {
  // Reject empty/whitespace queries
  const query = nameOrSlug.trim();
  if (!query) return undefined;

  // 1. Exact match (id, slug, name, or name ending with /query)
  let row = db
    .prepare(
      `SELECT * FROM servers
       WHERE id = ?
          OR slug = ?
          OR name = ?
          OR name LIKE ?
       LIMIT 1`,
    )
    .get(query, query, query, `%/${query}`) as McpServer | undefined;

  if (row) return row;

  // 2. Fuzzy substring match with smart ranking
  //    Score: exact word boundary > prefix > early position > late position
  //    Within each tier, sort by popularity (use_count)
  const pattern = `%${query}%`;
  // Candidate selection has to use the same criterion as the scoring below,
  // otherwise fifty popular `io.github.*` rows matching on nothing but their
  // hosting prefix fill the window and push out the row we are looking for.
  // Rows whose stripped name/slug matches therefore sort first; rows matching
  // only through the prefix stay eligible (so a literal `io.github.foo` lookup
  // still resolves) but can never take a slot from a real match. With that
  // ordering the 50-row window is only ever consumed by genuine matches, so it
  // stays at 50 rather than being widened.
  const strippedMatch =
    `${hostingPrefixSql('name', 'name')} LIKE @pattern` +
    ` OR ${hostingPrefixSql('slug', 'slug')} LIKE @pattern`;
  const rows = db
    .prepare(
      `SELECT * FROM servers
       WHERE name LIKE @pattern COLLATE NOCASE
          OR slug LIKE @pattern COLLATE NOCASE
       ORDER BY CASE WHEN ${strippedMatch} THEN 0 ELSE 1 END,
                use_count DESC
       LIMIT 50`,
    )
    .all({ pattern }) as unknown as McpServer[];

  if (rows.length > 0) {
    const qLower = query.toLowerCase();

    // Score each match — lower is better
    const scored = rows.map((r) => {
      // Scored on the hosting-prefix-stripped forms for the same reason the FTS
      // boost is: `io-github-` in a slug is provenance, not a match on "github".
      const nameLower = stripHostingPrefix(r.name || '', 'name').toLowerCase();
      const slugLower = stripHostingPrefix(r.slug || '', 'slug').toLowerCase();

      // Check both name and slug, take best score
      let score = 1000;

      for (const field of [nameLower, slugLower]) {
        if (!field) continue;
        const pos = field.indexOf(qLower);
        if (pos === -1) continue;

        // Extract the last segment after / for name matching
        const lastSegment = field.includes('/') ? field.split('/').pop()! : field;
        const segPos = lastSegment.indexOf(qLower);

        if (lastSegment === qLower) {
          // Exact match on last segment: /puppeteer → best
          score = Math.min(score, 0);
        } else if (segPos === 0) {
          // Prefix of last segment: puppeteer-xxx → very good
          score = Math.min(score, 10);
        } else if (field.charAt(pos - 1) === '-' || field.charAt(pos - 1) === '_' || field.charAt(pos - 1) === '/') {
          // Word boundary match: xxx-puppeteer or xxx/puppeteer → good
          score = Math.min(score, 20 + pos);
        } else {
          // Substring match: xxxpuppeteerxxx → ok, rank by position
          score = Math.min(score, 50 + pos);
        }
      }

      return { server: r, score };
    });

    // Sort by score (lower = better), then use_count (higher = better), then shorter name (simpler = better)
    scored.sort((a, b) =>
      a.score - b.score
      || (b.server.use_count || 0) - (a.server.use_count || 0)
      || (a.server.name || '').length - (b.server.name || '').length
    );

    return scored[0].server;
  }

  // 3. FTS5 fallback — best single match
  const sanitized = sanitizeFtsQuery(query);
  if (sanitized) {
    row = db
      .prepare(
        `SELECT s.* FROM servers_fts fts
         JOIN servers s ON s.rowid = fts.rowid
         WHERE servers_fts MATCH @q
         ORDER BY rank
         LIMIT 1`,
      )
      .get({ q: sanitized }) as McpServer | undefined;

    if (row) return row;
  }

  return undefined;
}

/**
 * Search for MCP servers using FTS5 full-text search.
 * Searches across name, description, and keywords with multi-factor ranking.
 */
/**
 * Expand a query using the alias dictionary.
 * Returns both the expanded query and whether aliases were used (for OR logic).
 * E.g., "gh issues" → { query: "github issues", hasAlias: true }
 */
function expandAliases(query: string): { query: string; hasAlias: boolean } {
  const words = query.toLowerCase().trim().split(/\s+/);
  let hasAlias = false;
  const expanded = words.map((w) => {
    if (SEARCH_ALIASES[w]) {
      hasAlias = true;
      return SEARCH_ALIASES[w];
    }
    return w;
  });
  return { query: expanded.join(' '), hasAlias };
}

export function searchServers(
  db: DatabaseSync,
  query: string,
  limit: number = 10,
  filters?: {
    transportType?: string;
    registryType?: string;
    registrySource?: string;
  },
): SearchResult[] {
  // Expand aliases before sanitizing
  const { query: expandedQuery, hasAlias } = expandAliases(query);
  const sanitized = sanitizeFtsQuery(expandedQuery, hasAlias);

  if (!sanitized) {
    // Fix #2: empty query → return top popular servers
    return getPopularServers(db, limit, filters);
  }

  // Extract primary search terms for name-match boosting
  // For aliases: use expanded terms; for regular queries: use original words
  const nameMatchTerms = expandedQuery
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);

  const params: Record<string, unknown> = { query: sanitized, limit };

  // Bind name-match parameters
  nameMatchTerms.forEach((term, i) => {
    params[`nm${i}`] = `%${term.toLowerCase()}%`;
  });

  // Filters narrow the candidate set, so they belong inside the CTE — every row
  // they drop is a row we neither strip nor score.
  let filterSql = '';

  if (filters?.transportType && filters.transportType !== 'any') {
    filterSql += ' AND s.transport_type = @transportType';
    params.transportType = filters.transportType;
  }

  if (filters?.registryType && filters.registryType !== 'any') {
    filterSql += ' AND s.registry_type = @registryType';
    params.registryType = filters.registryType;
  }

  if (filters?.registrySource && filters.registrySource !== 'any') {
    filterSql += ' AND s.sources LIKE @registrySource';
    params.registrySource = `%${filters.registrySource}%`;
  }

  // The boost tests the name with its hosting prefix cut off — see
  // HOSTING_PREFIXES for why the leading namespace is not a capability.
  // The CTE gives that value a single *name*, so the expression is written
  // once here instead of once per term. It is not computed once per row: the
  // CTE is deliberately left inlinable, so the planner re-derives match_name
  // at each reference. That is the cheaper of the two plans for realistic term
  // counts — the measurements behind that choice are on the query below.
  const nameMatchClauses = nameMatchTerms.map((_, i) =>
    `CASE WHEN h.match_name LIKE @nm${i} THEN 5.0 ELSE 0 END`
  ).join(' + ');

  // A query whose every word is a single character leaves no terms to boost by,
  // and then nothing downstream reads match_name. Don't strip and lower-case a
  // name for all 19k hits of a broad query so that the outer SELECT can ignore
  // it — the column is only projected when a term will actually test it.
  const matchNameSql = nameMatchTerms.length
    ? `,\n             LOWER(${hostingPrefixSql('s.name', 'name')}) AS match_name`
    : '';

  // Multi-factor ranking:
  // - Name match boost (huge): does the query term appear in server NAME?
  // - FTS5 rank for text relevance
  // - log(use_count + 1) for popularity
  // - Official registry boost
  //
  // `NOT MATERIALIZED` is a measurement, not a style choice. Timings on the
  // production snapshot (89,840 rows, node:sqlite, min of 9 runs), by number of
  // name-match terms — 1 and 2 terms are the alias-expanded shapes of the two
  // most common real queries:
  //
  //   query           | terms | MATERIALIZED | NOT MATERIALIZED | no hint
  //   ----------------+-------+--------------+------------------+--------
  //   github          |     1 |        56 ms |            39 ms |   40 ms
  //   git             |     2 |        62 ms |            48 ms |   49 ms
  //   pg fs           |     4 |        29 ms |            27 ms |   25 ms
  //   pg fs js ml     |     8 |        40 ms |            46 ms |   46 ms
  //
  // Read each row across, never down: the rows are different queries matching
  // different numbers of FTS hits, so the four-term row being faster than the
  // one-term row says nothing about term count — "github" alone matches 19,129
  // rows. What the table does show is that the winner flips somewhere between
  // the four- and eight-term query.
  //
  // The mechanism behind that flip: materializing forces the strip over every
  // FTS hit when the outer query keeps 10, a fixed cost paid once; inlining
  // re-derives match_name at each term reference, a cost that grows with the
  // term count. The dominant query is one word, so inlining wins where it
  // matters. No hint measures the
  // same — SQLite flattens a singly-referenced CTE by default — but the hint is
  // written out to state the intent: both forms are advisory, so this records
  // which plan was measured rather than guaranteeing the planner picks it.
  // Results are byte-identical across all three variants.
  const sql = `
    WITH hits AS NOT MATERIALIZED (
      SELECT s.rowid AS server_rowid,
             (rank * -1) AS fts_relevance${matchNameSql}
      FROM servers_fts fts
      JOIN servers s ON s.rowid = fts.rowid
      WHERE servers_fts MATCH @query${filterSql}
    )
    SELECT s.*,
           h.fts_relevance,
           (
             (${nameMatchClauses || '0'}) +
             h.fts_relevance * 0.3 +
             (CASE WHEN s.use_count > 0 THEN log(s.use_count + 1) ELSE 0 END) * 0.2 +
             (CASE WHEN s.sources LIKE '%official%' THEN 3.0
              WHEN s.verified = 1 THEN 1.5
              ELSE 0 END) * 0.15
           ) as combined_score
    FROM hits h
    JOIN servers s ON s.rowid = h.server_rowid
    ORDER BY combined_score DESC LIMIT @limit
  `;

  const rows = db.prepare(sql).all(params as Record<string, SqlParam>) as unknown as (McpServer & {
    fts_relevance: number;
    combined_score: number;
  })[];

  return rows.map((row, idx) => formatSearchResult(row, idx));
}

/**
 * Get most popular servers (for empty query / onboarding).
 * Prioritizes: official > verified > high use_count > recent.
 */
function getPopularServers(
  db: DatabaseSync,
  limit: number,
  filters?: { registrySource?: string },
): SearchResult[] {
  let sql = `SELECT * FROM servers WHERE status = 'active'`;
  const params: Record<string, unknown> = { limit };

  if (filters?.registrySource && filters.registrySource !== 'any') {
    sql += ' AND sources LIKE @registrySource';
    params.registrySource = `%${filters.registrySource}%`;
  }

  // Official first, then verified, then by popularity
  sql += ` ORDER BY
    CASE WHEN sources LIKE '%official%' THEN 0 ELSE 1 END,
    CASE WHEN verified = 1 THEN 0 ELSE 1 END,
    use_count DESC,
    updated_at DESC NULLS LAST
    LIMIT @limit`;

  const rows = db.prepare(sql).all(params as Record<string, SqlParam>) as unknown as McpServer[];

  return rows.map((row, idx) => formatSearchResult(row, idx));
}

/**
 * Format a database row into a SearchResult.
 */
function formatSearchResult(row: McpServer, idx: number): SearchResult {
  let sources: string[] = [];
  try {
    sources = JSON.parse(row.sources || '[]');
  } catch {
    sources = [];
  }

  const warningFlags = getWarningFlags(row, sources);
  const confidenceBreakdown = getConfidenceBreakdown(row, sources, warningFlags);
  const confidenceScore = confidenceBreakdown.score;
  const toolsExposed = extractTools(row);
  let envVars: Array<{ name?: string; isSecret?: boolean }> = [];
  try {
    const parsed = JSON.parse(row.env_vars || '[]');
    if (Array.isArray(parsed)) envVars = parsed;
  } catch {
    envVars = [];
  }
  const trustSignals = getTrustSignals(row, sources, envVars);
  const freshnessDays = getFreshnessDays(row);

  return {
    name: row.name,
    description: row.description,
    version: row.version,
    registryType: row.registry_type,
    packageIdentifier: row.package_identifier,
    transportType: row.transport_type,
    repositoryUrl: row.repository_url,
    hasRemote: row.has_remote === 1,
    rank: idx + 1,
    sources,
    useCount: row.use_count || 0,
    verified: row.verified === 1,
    iconUrl: row.icon_url,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    sourceCount: sources.length,
    confidenceScore,
    confidenceBreakdown,
    recommendationReason: getRecommendationReason(row, sources),
    warningFlags,
    trustSignals,
    freshnessDays,
    freshnessLabel: getFreshnessLabel(freshnessDays),
    installComplexity: getInstallComplexity(row, [], toolsExposed),
    secretCount: 0,
    capabilityCount: toolsExposed.length,
  };
}

/**
 * Get detailed information about a specific server by name or slug.
 */
export function getServerDetails(
  db: DatabaseSync,
  nameOrSlug: string,
): ServerDetail | null {
  const row = findServerByNameOrSlug(db, nameOrSlug);

  if (!row) return null;

  let envVars = [];
  try {
    envVars = JSON.parse(row.env_vars || '[]');
  } catch {
    envVars = [];
  }

  let categories: string[] = [];
  try {
    categories = JSON.parse(row.categories || '[]');
  } catch {
    categories = [];
  }
  if (categories.length === 0) {
    categories = categorizeServer(row.name, row.description);
  }

  let sources: string[] = [];
  try {
    sources = JSON.parse(row.sources || '[]');
  } catch {
    sources = [];
  }

  const warningFlags = getWarningFlags(row, sources);
  const confidenceBreakdown = getConfidenceBreakdown(row, sources, warningFlags);
  const confidenceScore = confidenceBreakdown.score;
  const toolsExposed = extractTools(row);
  const trustSignals = getTrustSignals(row, sources, envVars);
  const freshnessDays = getFreshnessDays(row);
  const secretCount = envVars.filter((envVar: { isSecret?: boolean }) => envVar.isSecret).length;

  return {
    name: row.name,
    description: row.description,
    version: row.version,
    registryType: row.registry_type,
    packageIdentifier: row.package_identifier,
    transportType: row.transport_type,
    repositoryUrl: row.repository_url,
    repositorySource: row.repository_source,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    status: row.status,
    hasRemote: row.has_remote === 1,
    remoteUrl: row.remote_url,
    categories,
    environmentVariables: envVars,
    sources,
    useCount: row.use_count || 0,
    verified: row.verified === 1,
    iconUrl: row.icon_url,
    sourceCount: sources.length,
    confidenceScore,
    confidenceBreakdown,
    recommendationReason: getRecommendationReason(row, sources),
    warningFlags,
    trustSignals,
    freshnessDays,
    freshnessLabel: getFreshnessLabel(freshnessDays),
    installComplexity: getInstallComplexity(row, envVars, toolsExposed),
    secretCount,
    capabilityCount: toolsExposed.length,
    toolsExposed,
  };
}

/**
 * Sanitize a query string for FTS5.
 * When useOr is true (alias expansion), joins with OR for broader matching.
 */
function sanitizeFtsQuery(query: string, useOr: boolean = false): string {
  const words = query
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => `"${w}"`);

  if (words.length === 0) return '';
  return useOr ? words.join(' OR ') : words.join(' ');
}

function extractTools(row: McpServer): ToolSummary[] {
  try {
    const envelope = parseRawEnvelope(row.raw_data || '{}', row.source);
    const sources = envelope
      ? rawPayloads(envelope).filter(
          (value): value is Record<string, unknown> => Boolean(value && typeof value === 'object'),
        )
      : [];
    const tools = new Map<string, ToolSummary>();

    for (const sourcePayload of sources) {
      for (const tool of extractToolSummariesFromPayload(sourcePayload)) {
        const prev = tools.get(tool.name);
        tools.set(tool.name, {
          name: tool.name,
          description: tool.description || prev?.description,
          kind: tool.kind || prev?.kind,
        });
      }
    }

    return [...tools.values()];
  } catch {
    return [];
  }
}

function extractToolSummariesFromPayload(payload: Record<string, unknown>): ToolSummary[] {
  const found: ToolSummary[] = [];

  if (Array.isArray(payload.tools)) {
    for (const tool of payload.tools) {
      if (!tool || typeof tool !== 'object') continue;
      const record = tool as Record<string, unknown>;
      const name = typeof record.name === 'string'
        ? record.name
        : typeof record.id === 'string'
          ? record.id
          : null;
      if (!name) continue;
      found.push({
        name,
        description: typeof record.description === 'string' ? record.description : undefined,
        kind: 'tool',
      });
    }
  }

  if (Array.isArray(payload.capabilities)) {
    for (const capability of payload.capabilities) {
      if (!capability || typeof capability !== 'object') continue;
      const record = capability as Record<string, unknown>;
      const name = typeof record.name === 'string'
        ? record.name
        : typeof record.id === 'string'
          ? record.id
          : null;
      if (!name) continue;
      found.push({
        name,
        description: typeof record.description === 'string' ? record.description : undefined,
        kind: typeof record.type === 'string' && ['tool', 'resource', 'prompt'].includes(record.type)
          ? record.type as 'tool' | 'resource' | 'prompt'
          : 'unknown',
      });
    }
  }

  const meta = payload._meta;
  if (meta && typeof meta === 'object') {
    for (const value of Object.values(meta as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const metaRecord = value as Record<string, unknown>;
      if (Array.isArray(metaRecord.tools)) {
        for (const tool of metaRecord.tools) {
          if (typeof tool === 'string') {
            found.push({ name: tool, kind: 'tool' });
          } else if (tool && typeof tool === 'object') {
            const record = tool as Record<string, unknown>;
            const name = typeof record.name === 'string' ? record.name : null;
            if (!name) continue;
            found.push({
              name,
              description: typeof record.description === 'string' ? record.description : undefined,
              kind: 'tool',
            });
          }
        }
      }
      if (Array.isArray(metaRecord.toolHints)) {
        for (const hint of metaRecord.toolHints) {
          if (!hint || typeof hint !== 'object') continue;
          const record = hint as Record<string, unknown>;
          const name = typeof record.name === 'string' ? record.name : null;
          if (!name) continue;
          found.push({
            name,
            description: typeof record.description === 'string' ? record.description : undefined,
            kind: 'tool',
          });
        }
      }
    }
  }

  return found;
}

function getRecommendationReason(row: McpServer, sources: string[]): string {
  if (sources.includes('official') && row.verified === 1 && (row.use_count || 0) > 0) {
    return 'official registry presence, verified publisher metadata, and community usage';
  }
  if (sources.includes('official')) {
    return 'official registry presence and metadata completeness';
  }
  if (row.verified === 1) {
    return 'verified listing and strong discovery signals';
  }
  if ((row.use_count || 0) > 0) {
    return 'community usage and text relevance';
  }
  return 'text relevance and available metadata';
}

function getWarningFlags(row: McpServer, sources: string[]): string[] {
  const warnings: string[] = [];

  if (sources.length <= 1) warnings.push('single-source-only');
  if (!row.updated_at) warnings.push('missing-update-date');
  if (!row.repository_url) warnings.push('missing-repository-url');
  if (!row.package_identifier && row.has_remote !== 1) warnings.push('install-method-unclear');
  if (row.status && row.status !== 'active') warnings.push(`status:${row.status}`);

  // Build-time enrichment flags (null = never probed, 1 = flagged, 0 = clean).
  if (row.deprecated_npm === 1) warnings.push('deprecated-npm');
  if (row.archived_repo === 1) warnings.push('archived-repo');

  if (row.updated_at) {
    const updatedTime = Date.parse(row.updated_at);
    if (!Number.isNaN(updatedTime)) {
      const ageDays = (Date.now() - updatedTime) / (1000 * 60 * 60 * 24);
      if (ageDays > 540) warnings.push('stale-over-18-months');
      else if (ageDays > 365) warnings.push('stale-over-12-months');
    }
  }

  return warnings;
}

function getConfidenceBreakdown(
  row: McpServer,
  sources: string[],
  warningFlags: string[],
): ConfidenceBreakdown {
  const base = 0.4;
  const official = sources.includes('official') ? 0.2 : 0;
  const verified = row.verified === 1 ? 0.15 : 0;
  const useCount = row.use_count || 0;
  const popularity = useCount >= 100 ? 0.15 : useCount > 0 ? 0.1 : 0;
  const multiSource = sources.length > 1 ? 0.05 : 0;

  let penalties = 0;
  if (warningFlags.includes('stale-over-18-months')) penalties -= 0.15;
  if (warningFlags.includes('deprecated-npm')) penalties -= 0.2;
  if (warningFlags.includes('archived-repo')) penalties -= 0.1;
  if (warningFlags.includes('install-method-unclear')) penalties -= 0.1;
  if (warningFlags.includes('missing-repository-url')) penalties -= 0.05;

  const raw = base + official + verified + popularity + multiSource + penalties;
  const score = Math.max(0, Math.min(1, Number(raw.toFixed(2))));

  const drivers: string[] = [];
  if (official) drivers.push('+official');
  if (verified) drivers.push('+verified');
  if (popularity >= 0.15) drivers.push('+popularity:100+uses');
  else if (popularity > 0) drivers.push('+popularity:any-use');
  if (multiSource) drivers.push('+multi-source');
  if (warningFlags.includes('deprecated-npm')) drivers.push('-deprecated-npm');
  if (warningFlags.includes('archived-repo')) drivers.push('-archived-repo');
  if (warningFlags.includes('stale-over-18-months')) drivers.push('-stale>18mo');
  if (warningFlags.includes('install-method-unclear')) drivers.push('-install-unclear');
  if (warningFlags.includes('missing-repository-url')) drivers.push('-no-repo-url');

  return {
    score,
    components: {
      base,
      official,
      verified,
      popularity,
      multiSource,
      penalties: Number(penalties.toFixed(2)),
    },
    drivers,
  };
}

function getTrustSignals(
  row: McpServer,
  sources: string[],
  envVars: Array<{ name?: string; isSecret?: boolean }> = [],
): TrustSignals {
  const freshnessDays = getFreshnessDays(row);
  return {
    hasOfficialSource: sources.includes('official'),
    isVerified: row.verified === 1,
    hasRepository: Boolean(row.repository_url),
    hasRemote: row.has_remote === 1,
    multiSource: sources.length > 1,
    hasRecentUpdate: freshnessDays !== null && freshnessDays <= 180,
    requiresSecrets: envVars.some((envVar) => envVar.isSecret),
    possibleUnlabeledSecrets: envVars.some(
      (envVar) => !envVar.isSecret && looksLikeCredentialName(envVar.name ?? ''),
    ),
  };
}

function getFreshnessDays(row: McpServer): number | null {
  const candidate = row.updated_at || row.published_at;
  if (!candidate) return null;
  const time = Date.parse(candidate);
  if (Number.isNaN(time)) return null;
  return Math.max(0, Math.floor((Date.now() - time) / (1000 * 60 * 60 * 24)));
}

function getFreshnessLabel(freshnessDays: number | null): string {
  if (freshnessDays === null) return 'unknown';
  if (freshnessDays <= 30) return 'recent';
  if (freshnessDays <= 180) return 'active';
  if (freshnessDays <= 365) return 'aging';
  return 'stale';
}

function getInstallComplexity(
  row: McpServer,
  envVars: Array<{ isSecret?: boolean }> = [],
  toolsExposed: ToolSummary[] = [],
): 'low' | 'medium' | 'high' {
  const secretCount = envVars.filter((envVar) => envVar.isSecret).length;
  if (row.has_remote === 1 && secretCount === 0) return 'low';
  if (secretCount >= 2) return 'high';
  if (!row.package_identifier && row.has_remote !== 1) return 'high';
  if (row.registry_type === 'oci') return 'medium';
  if (toolsExposed.length > 15 || secretCount === 1) return 'medium';
  return 'low';
}
