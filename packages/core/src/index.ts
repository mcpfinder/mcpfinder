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
export {
  initDatabase,
  closeDatabase,
  checkpointWal,
  getDataDir,
  getCatalogDbPath,
  getLastSyncTimestamp,
  getLastSuccessfulSyncTimestamp,
  getSnapshotInstalledAt,
  markSnapshotInstalled,
  updateSyncLog,
  SNAPSHOT_SOURCE,
} from './db.js';

// Sync
export {
  syncOfficialRegistry,
  syncGlamaRegistry,
  syncSmitheryRegistry,
  isSyncNeeded,
  getServerCount,
  DEFAULT_SNAPSHOT_FRESH_MINUTES,
} from './sync.js';

// Snapshot bootstrap (fast cold-start)
export {
  bootstrapFromSnapshot,
  fetchSnapshotManifest,
  DEFAULT_SNAPSHOT_BASE,
  DEFAULT_MANIFEST_TIMEOUT_MS,
  DEFAULT_STALL_TIMEOUT_MS,
} from './snapshot.js';
export type { SnapshotManifest, BootstrapResult, BootstrapOptions } from './snapshot.js';
export type { PromoteOutcome } from './snapshot-install.js';
export {
  readSnapshotState,
  readSnapshotStateSync,
  writeSnapshotState,
  publishSnapshotState,
  reconcileSnapshotPointer,
  snapshotStatePath,
  resolveCurrentDbPath,
  pointerNamesStandIn,
  versionedDbPath,
  variantDbPath,
  sweepSnapshotFiles,
  isValidSha256,
  DEFAULT_RETAIN_HOURS,
  DEFAULT_DOWNLOAD_STALE_HOURS,
} from './snapshot-state.js';
export type { SnapshotState, SweepOptions, PublishOutcome } from './snapshot-state.js';

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
export { getInstallCommand, buildEnvPlaceholders, envPlaceholderValue } from './install.js';
export type { ClientType } from './install.js';

// Credential-name hint (advisory only; never changes config values)
export { looksLikeCredentialName, possibleUnlabeledSecrets } from './credential-hint.js';
