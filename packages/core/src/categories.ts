/**
 * Keyword-based categorization for MCP servers.
 * Categories are derived from server names and descriptions, not a fixed taxonomy.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Category } from './types.js';

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'that', 'this', 'as', 'are',
  'was', 'be', 'has', 'had', 'have', 'do', 'does', 'did', 'will', 'can',
  'could', 'would', 'should', 'may', 'might', 'shall', 'not', 'no',
  'mcp', 'server', 'tool', 'model', 'context', 'protocol',
]);

/**
 * Category definitions with their matching keywords.
 *
 * Keywords match whole words (see categorizeServer), so they must be specific:
 * words nearly every MCP description contains ("AI agents", "Claude", "tool",
 * "query", "request") would put most of the catalog into one category.
 * Multi-word keywords are written with a space.
 */
const CATEGORY_DEFS: Array<{ name: string; keywords: string[] }> = [
  { name: 'filesystem', keywords: ['file', 'filesystem', 'directory', 'folder', 'disk', 'storage', 'fs', 's3', 'dropbox', 'google drive', 'onedrive'] },
  { name: 'database', keywords: ['database', 'sql', 'sqlite', 'postgres', 'postgresql', 'mysql', 'mariadb', 'mongo', 'mongodb', 'redis', 'dynamodb', 'supabase', 'prisma', 'db', 'clickhouse', 'snowflake', 'bigquery', 'neo4j', 'cassandra'] },
  { name: 'api', keywords: ['api', 'rest', 'graphql', 'openapi', 'swagger', 'endpoint', 'webhook', 'http'] },
  { name: 'ai', keywords: ['llm', 'embedding', 'openai', 'anthropic', 'gemini', 'machine learning', 'ml', 'neural', 'gpt', 'inference', 'rag', 'vector', 'huggingface', 'ollama', 'prompt'] },
  { name: 'web', keywords: ['web', 'website', 'browser', 'scrape', 'scraping', 'crawl', 'html', 'url', 'puppeteer', 'playwright', 'selenium'] },
  { name: 'git', keywords: ['git', 'github', 'gitlab', 'bitbucket', 'repo', 'repository', 'commit', 'branch', 'pull request', 'version control'] },
  { name: 'cloud', keywords: ['cloud', 'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'k8s', 'terraform', 'deploy', 'serverless', 'lambda', 'cloudflare', 'vercel', 'devops'] },
  { name: 'search', keywords: ['web search', 'search engine', 'semantic search', 'full text search', 'brave', 'bing', 'elasticsearch', 'opensearch', 'meilisearch', 'typesense', 'algolia', 'tavily', 'exa', 'serp', 'perplexity'] },
  { name: 'monitoring', keywords: ['monitor', 'log', 'logs', 'logging', 'metric', 'alert', 'observability', 'trace', 'tracing', 'datadog', 'grafana', 'prometheus', 'sentry', 'uptime'] },
  { name: 'security', keywords: ['security', 'auth', 'authentication', 'encrypt', 'vault', 'secret', 'oauth', 'permission', 'ssl', 'tls', 'vulnerability', 'cve', 'pentest', 'malware', 'threat'] },
  { name: 'communication', keywords: ['email', 'gmail', 'outlook', 'slack', 'discord', 'telegram', 'whatsapp', 'notification', 'messaging', 'chat', 'sms', 'twilio', 'teams'] },
  { name: 'productivity', keywords: ['notion', 'todoist', 'calendar', 'task', 'todo', 'jira', 'trello', 'asana', 'linear', 'schedule', 'obsidian', 'evernote', 'confluence'] },
  { name: 'dev-tools', keywords: ['lint', 'linter', 'test', 'debug', 'debugger', 'compile', 'compiler', 'ci', 'npm', 'cli', 'terminal', 'shell', 'ide', 'vscode', 'code review', 'refactor'] },
  { name: 'data', keywords: ['csv', 'json', 'xml', 'yaml', 'parse', 'etl', 'spreadsheet', 'excel', 'pandas', 'analytics', 'dataset', 'google sheets'] },
  { name: 'finance', keywords: ['finance', 'financial', 'payment', 'stripe', 'paypal', 'invoice', 'accounting', 'bank', 'banking', 'crypto', 'cryptocurrency', 'blockchain', 'wallet', 'bitcoin', 'ethereum', 'solana', 'defi', 'token swap', 'trading', 'stock', 'forex', 'usdc'] },
  { name: 'media', keywords: ['image', 'video', 'audio', 'media', 'photo', 'pdf', 'ffmpeg', 'youtube', 'music', 'speech', 'transcribe', 'transcription'] },
];

/** Category for servers no keyword matches; browsable like the others. */
const OTHER_CATEGORY = 'other';

/** Suffixes accepted after a whole-word keyword: file→files, deploy→deployment, monitor→monitoring. */
const KEYWORD_SUFFIXES = ['', 's', 'es', 'ed', 'ing', 'ion', 'ions', 'ment', 'ments', 'er', 'ers'];
/** Suffixes accepted after a keyword with its trailing "e" dropped (scrape→scraping). */
const STEM_SUFFIXES = ['ing', 'ion', 'ions', 'ed', 'er', 'ers'];

/** Every accepted word form per keyword, built once. Multi-word keywords match as a phrase. */
const CATEGORY_MATCHERS = CATEGORY_DEFS.map((def) => {
  const words = new Set<string>();
  const phrases: string[] = [];
  for (const kw of def.keywords) {
    if (kw.includes(' ')) {
      phrases.push(` ${kw} `);
      continue;
    }
    for (const suffix of KEYWORD_SUFFIXES) words.add(kw + suffix);
    // scrape→scraping, scrape→scraper: the e-less stem only takes vowel-initial
    // suffixes, so "ide" never matches "id" and "stripe" never matches "strip".
    if (kw.endsWith('e')) {
      for (const suffix of STEM_SUFFIXES) words.add(kw.slice(0, -1) + suffix);
    }
  }
  return { name: def.name, words, phrases };
});

/**
 * The part of a server name that describes it. Registry names carry a
 * namespace ("io.github.acme/postgres-mcp"), Glama names an owner
 * ("acme/Postgres MCP"); neither says what the server does, and the
 * "github" in every io.github.* namespace would otherwise mark it as git.
 */
function nameForCategories(name: string): string {
  const slash = name.lastIndexOf('/');
  return slash >= 0 ? name.slice(slash + 1) : name;
}

/**
 * Extract searchable keywords from the name, description, and optional display title.
 */
export function extractKeywords(name: string, description: string, title = ''): string[] {
  const text = `${name} ${description} ${title}`.toLowerCase();
  const words = text
    .replace(/[^\w\s-]/g, ' ')
    .split(/[\s/._-]+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  return [...new Set(words)];
}

/**
 * Categorize a server by whole-word keyword matches in its name and description.
 * Substring matching put "email" under ai and "digital" under git.
 */
export function categorizeServer(name: string, description: string): string[] {
  const tokens = `${nameForCategories(name)} ${description}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const text = ` ${tokens.join(' ')} `;
  const matched = CATEGORY_MATCHERS
    .filter((cat) => tokens.some((t) => cat.words.has(t)) || cat.phrases.some((p) => text.includes(p)))
    .map((cat) => cat.name);
  return matched.length > 0 ? matched : [OTHER_CATEGORY];
}

/**
 * Store categorizeServer's result in every row's `categories` column, so
 * snapshot consumers read the categories instead of recomputing them.
 * Returns the number of rows updated.
 */
export function assignCategories(db: DatabaseSync): number {
  const rows = db.prepare('SELECT id, name, description FROM servers').all() as Array<{
    id: string;
    name: string;
    description: string;
  }>;
  const update = db.prepare('UPDATE servers SET categories = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const row of rows) update.run(JSON.stringify(categorizeServer(row.name, row.description)), row.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return rows.length;
}

/**
 * List all categories with their server counts.
 */
export function listCategories(db: DatabaseSync): Category[] {
  const rows = db
    .prepare("SELECT name, description FROM servers WHERE status = 'active'")
    .all() as Array<{ name: string; description: string }>;

  const counts = new Map<string, number>();
  for (const row of rows) {
    const cats = categorizeServer(row.name, row.description);
    for (const cat of cats) {
      counts.set(cat, (counts.get(cat) || 0) + 1);
    }
  }

  return [...CATEGORY_DEFS, { name: OTHER_CATEGORY, keywords: [] }]
    .map((def) => ({
      name: def.name,
      count: counts.get(def.name) || 0,
      keywords: def.keywords,
    }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count);
}

/**
 * Get servers in a specific category.
 */
export function getServersByCategory(
  db: DatabaseSync,
  category: string,
  limit: number = 20,
): Array<{ name: string; description: string; version: string }> {
  if (category !== OTHER_CATEGORY && !CATEGORY_DEFS.some((c) => c.name === category)) return [];
  // Same as SQL LIMIT: 0 returns nothing, a negative limit returns everything.
  if (limit === 0) return [];

  // Same rule as categorizeServer/listCategories; SQL LIKE would match substrings.
  const rows = db
    .prepare(
      `SELECT name, description, version FROM servers
       WHERE status = 'active'
       ORDER BY updated_at DESC NULLS LAST`,
    )
    .iterate() as Iterable<{ name: string; description: string; version: string }>;
  const result: Array<{ name: string; description: string; version: string }> = [];
  for (const row of rows) {
    if (!categorizeServer(row.name, row.description).includes(category)) continue;
    result.push({ name: row.name, description: row.description, version: row.version });
    if (limit > 0 && result.length >= limit) break;
  }
  return result;
}
