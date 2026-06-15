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

/** Category definitions with their matching keywords */
const CATEGORY_DEFS: Array<{ name: string; keywords: string[] }> = [
  { name: 'filesystem', keywords: ['file', 'filesystem', 'directory', 'folder', 'path', 'disk', 'storage', 'fs'] },
  { name: 'database', keywords: ['database', 'sql', 'sqlite', 'postgres', 'mysql', 'mongo', 'redis', 'dynamodb', 'supabase', 'prisma', 'db', 'query'] },
  { name: 'api', keywords: ['api', 'rest', 'graphql', 'endpoint', 'webhook', 'http', 'request'] },
  { name: 'ai', keywords: ['ai', 'llm', 'embedding', 'openai', 'anthropic', 'gemini', 'machine-learning', 'ml', 'neural', 'gpt', 'claude'] },
  { name: 'web', keywords: ['web', 'browser', 'scrape', 'crawl', 'html', 'url', 'fetch', 'puppeteer', 'playwright', 'selenium'] },
  { name: 'git', keywords: ['git', 'github', 'gitlab', 'bitbucket', 'repo', 'commit', 'branch', 'version-control'] },
  { name: 'cloud', keywords: ['cloud', 'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'k8s', 'terraform', 'deploy', 'serverless', 'lambda'] },
  { name: 'search', keywords: ['search', 'brave', 'bing', 'elasticsearch', 'algolia', 'index'] },
  { name: 'monitoring', keywords: ['monitor', 'log', 'metric', 'alert', 'observability', 'trace', 'datadog', 'grafana', 'prometheus', 'sentry'] },
  { name: 'security', keywords: ['security', 'auth', 'encrypt', 'vault', 'secret', 'token', 'oauth', 'permission', 'ssl', 'tls'] },
  { name: 'communication', keywords: ['email', 'slack', 'discord', 'telegram', 'notification', 'message', 'chat', 'sms', 'twilio'] },
  { name: 'productivity', keywords: ['notion', 'todoist', 'calendar', 'task', 'project', 'jira', 'trello', 'asana', 'linear', 'schedule'] },
  { name: 'dev-tools', keywords: ['lint', 'format', 'test', 'debug', 'compile', 'build', 'ci', 'npm', 'package', 'cli', 'terminal'] },
  { name: 'data', keywords: ['csv', 'json', 'xml', 'yaml', 'parse', 'transform', 'etl', 'spreadsheet', 'excel', 'pandas'] },
  { name: 'media', keywords: ['image', 'video', 'audio', 'media', 'photo', 'pdf', 'document', 'convert', 'ffmpeg'] },
];

/**
 * Extract keywords from name and description for search indexing.
 */
export function extractKeywords(name: string, description: string): string[] {
  const text = `${name} ${description}`.toLowerCase();
  const words = text
    .replace(/[^\w\s-]/g, ' ')
    .split(/[\s/._-]+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  return [...new Set(words)];
}

/**
 * Categorize a server based on its name and description keywords.
 */
export function categorizeServer(name: string, description: string): string[] {
  const text = `${name} ${description}`.toLowerCase();
  const matched: string[] = [];
  for (const cat of CATEGORY_DEFS) {
    if (cat.keywords.some((kw) => text.includes(kw))) {
      matched.push(cat.name);
    }
  }
  return matched.length > 0 ? matched : ['other'];
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

  return CATEGORY_DEFS
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
  const catDef = CATEGORY_DEFS.find((c) => c.name === category);
  if (!catDef) return [];

  const conditions = catDef.keywords
    .map((_: string, i: number) => `(LOWER(name) LIKE @kw${i} OR LOWER(description) LIKE @kw${i})`)
    .join(' OR ');

  const params: Record<string, string | number> = { limit };
  catDef.keywords.forEach((kw: string, i: number) => {
    params[`kw${i}`] = `%${kw}%`;
  });

  const sql = `
    SELECT name, description, version FROM servers
    WHERE status = 'active' AND (${conditions})
    ORDER BY updated_at DESC NULLS LAST
    LIMIT @limit
  `;

  return db.prepare(sql).all(params) as Array<{ name: string; description: string; version: string }>;
}
