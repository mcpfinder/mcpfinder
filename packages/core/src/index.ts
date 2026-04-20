/**
 * @mcpfinder/core — Shared types, database, sync engine, and search.
 */

// Types
export type {
  RegistryServerEntry,
  RegistryPackage,
  RegistryRemote,
  RegistryEnvVar,
  RegistryMeta,
  RegistryListResponse,
  McpServer,
  SearchResult,
  ServerDetail,
  Category,
  ToolSummary,
  TrustSignals,
  ConfidenceBreakdown,
  GlamaServer,
  GlamaListResponse,
  SmitheryServer,
  SmitheryListResponse,
} from './types.js';

// Database
export { initDatabase, getDataDir, getLastSyncTimestamp, updateSyncLog } from './db.js';

// Sync
export { syncOfficialRegistry, syncGlamaRegistry, syncSmitheryRegistry, isSyncNeeded, getServerCount } from './sync.js';

// Snapshot bootstrap (fast cold-start)
export { bootstrapFromSnapshot, fetchSnapshotManifest, DEFAULT_SNAPSHOT_BASE } from './snapshot.js';
export type { SnapshotManifest, BootstrapResult, BootstrapOptions } from './snapshot.js';

// Build-time enrichment (GitHub probe, post-sync dedup pass)
export { enrichSmitheryRepoUrls, enrichDeprecationFlags } from './enrich.js';
export type { EnrichResult, DeprecationEnrichResult } from './enrich.js';

// Search
export { searchServers, getServerDetails, findServerByNameOrSlug } from './search.js';

// Categories
export {
  extractKeywords,
  categorizeServer,
  listCategories,
  getServersByCategory,
} from './categories.js';

// Install
export { getInstallCommand } from './install.js';
export type { ClientType } from './install.js';
