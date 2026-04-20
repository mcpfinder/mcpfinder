/**
 * Search engine using SQLite FTS5 for MCP server discovery.
 * Ranking formula: fts_rank * 0.4 + log(useCount+1) * 0.3 + source_count * 0.2 + official_boost * 0.1
 */
import type Database from 'better-sqlite3';
import type { McpServer, SearchResult, ServerDetail, ToolSummary, TrustSignals } from './types.js';
import { categorizeServer } from './categories.js';

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
  db: Database.Database,
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
  const rows = db
    .prepare(
      `SELECT * FROM servers
       WHERE name LIKE ? COLLATE NOCASE
          OR slug LIKE ? COLLATE NOCASE
       ORDER BY use_count DESC
       LIMIT 50`,
    )
    .all(pattern, pattern) as McpServer[];

  if (rows.length > 0) {
    const qLower = query.toLowerCase();

    // Score each match — lower is better
    const scored = rows.map((r) => {
      const nameLower = (r.name || '').toLowerCase();
      const slugLower = (r.slug || '').toLowerCase();

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
  db: Database.Database,
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
  const nameMatchClauses = nameMatchTerms.map((_, i) => 
    `CASE WHEN LOWER(s.name) LIKE @nm${i} THEN 5.0 ELSE 0 END`
  ).join(' + ');

  // Multi-factor ranking:
  // - Name match boost (huge): does the query term appear in server NAME?
  // - FTS5 rank for text relevance
  // - log(use_count + 1) for popularity  
  // - Official registry boost
  let sql = `
    SELECT s.*,
           (rank * -1) as fts_relevance,
           (
             (${nameMatchClauses || '0'}) +
             (rank * -1) * 0.3 +
             (CASE WHEN s.use_count > 0 THEN log(s.use_count + 1) ELSE 0 END) * 0.2 +
             (CASE WHEN s.sources LIKE '%official%' THEN 3.0
              WHEN s.verified = 1 THEN 1.5
              ELSE 0 END) * 0.15
           ) as combined_score
    FROM servers_fts fts
    JOIN servers s ON s.rowid = fts.rowid
    WHERE servers_fts MATCH @query
  `;

  const params: Record<string, unknown> = { query: sanitized, limit };

  // Bind name-match parameters
  nameMatchTerms.forEach((term, i) => {
    params[`nm${i}`] = `%${term.toLowerCase()}%`;
  });

  if (filters?.transportType && filters.transportType !== 'any') {
    sql += ' AND s.transport_type = @transportType';
    params.transportType = filters.transportType;
  }

  if (filters?.registryType && filters.registryType !== 'any') {
    sql += ' AND s.registry_type = @registryType';
    params.registryType = filters.registryType;
  }

  if (filters?.registrySource && filters.registrySource !== 'any') {
    sql += ' AND s.sources LIKE @registrySource';
    params.registrySource = `%${filters.registrySource}%`;
  }

  sql += ' ORDER BY combined_score DESC LIMIT @limit';

  const rows = db.prepare(sql).all(params) as (McpServer & { fts_relevance: number; combined_score: number })[];

  return rows.map((row, idx) => formatSearchResult(row, idx));
}

/**
 * Get most popular servers (for empty query / onboarding).
 * Prioritizes: official > verified > high use_count > recent.
 */
function getPopularServers(
  db: Database.Database,
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

  const rows = db.prepare(sql).all(params) as McpServer[];

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
  const confidenceScore = getConfidenceScore(row, sources, warningFlags);
  const toolsExposed = extractTools(row);
  const trustSignals = getTrustSignals(row, sources);
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
  db: Database.Database,
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
  const confidenceScore = getConfidenceScore(row, sources, warningFlags);
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
    const raw = JSON.parse(row.raw_data || '{}') as Record<string, unknown>;
    const sources = getRawSources(raw);
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

function getRawSources(raw: Record<string, unknown>): Record<string, unknown>[] {
  if (isRawEnvelope(raw)) {
    const bySource = Object.values(raw.bySource).filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object'));
    const primary = raw.primary && typeof raw.primary === 'object' ? [raw.primary as Record<string, unknown>] : [];
    return [...primary, ...bySource];
  }
  return [raw];
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

function isRawEnvelope(value: unknown): value is { primary?: unknown; bySource: Record<string, unknown> } {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'bySource' in value &&
      (value as { bySource?: unknown }).bySource &&
      typeof (value as { bySource?: unknown }).bySource === 'object',
  );
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

function getConfidenceScore(row: McpServer, sources: string[], warningFlags: string[]): number {
  let score = 0.4;
  if (sources.includes('official')) score += 0.2;
  if (row.verified === 1) score += 0.15;
  if ((row.use_count || 0) >= 100) score += 0.15;
  else if ((row.use_count || 0) > 0) score += 0.1;
  if (sources.length > 1) score += 0.05;
  if (warningFlags.includes('stale-over-18-months')) score -= 0.15;
  if (warningFlags.includes('install-method-unclear')) score -= 0.1;
  if (warningFlags.includes('missing-repository-url')) score -= 0.05;
  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

function getTrustSignals(
  row: McpServer,
  sources: string[],
  envVars: Array<{ isSecret?: boolean }> = [],
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
