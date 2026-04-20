/**
 * Core types for MCPfinder
 */

/** Raw server entry from the Official MCP Registry API */
export interface RegistryServerEntry {
  server: {
    $schema?: string;
    name: string;
    description?: string;
    version: string;
    repository?: {
      url: string;
      source: string;
    };
    packages?: RegistryPackage[];
    remotes?: RegistryRemote[];
  };
  _meta?: Record<string, RegistryMeta>;
}

export interface RegistryPackage {
  registryType: string; // npm | pypi | oci | nuget | mcpb
  identifier: string;
  transport: { type: string }; // stdio | streamable-http | sse
  environmentVariables?: RegistryEnvVar[];
}

export interface RegistryRemote {
  type: string;
  url: string;
}

export interface RegistryEnvVar {
  name: string;
  description?: string;
  format?: string;
  isSecret?: boolean;
}

export interface ToolSummary {
  name: string;
  description?: string;
  kind?: 'tool' | 'resource' | 'prompt' | 'unknown';
}

export interface TrustSignals {
  hasOfficialSource: boolean;
  isVerified: boolean;
  hasRepository: boolean;
  hasRemote: boolean;
  multiSource: boolean;
  hasRecentUpdate: boolean;
  requiresSecrets: boolean;
}

/**
 * Transparent breakdown of how `confidenceScore` was assembled, so an AI can
 * explain the ranking decision instead of citing a single opaque number. Each
 * component is the exact delta that contributed to the final score; positive
 * values lift confidence, negative values (under `penalties`) reduce it.
 */
export interface ConfidenceBreakdown {
  score: number; // final score, 0..1
  components: {
    base: number;        // starting point (all servers share this)
    official: number;    // lift for Official Registry presence
    verified: number;    // lift for verified publisher flag (Smithery)
    popularity: number;  // lift for community use_count tiers
    multiSource: number; // lift for appearing in >1 registry
    penalties: number;   // sum of penalties (<=0): staleness, missing install path, etc.
  };
  drivers: string[];     // ordered human-readable list, e.g. ["+official", "+popularity:100+", "-stale>18mo"]
}

export interface RegistryMeta {
  status?: string;
  publishedAt?: string;
  updatedAt?: string;
  isLatest?: boolean;
}

/** Registry API list response */
export interface RegistryListResponse {
  servers: RegistryServerEntry[];
  metadata?: {
    nextCursor?: string | null;
    total?: number;
  };
}

/** Our unified server record stored in SQLite */
export interface McpServer {
  id: string;
  slug: string;
  name: string;
  description: string;
  version: string;
  registry_type: string | null;
  package_identifier: string | null;
  transport_type: string | null;
  repository_url: string | null;
  repository_source: string | null;
  published_at: string | null;
  updated_at: string | null;
  status: string;
  popularity_score: number;
  categories: string; // JSON array
  keywords: string; // JSON array
  remote_url: string | null;
  has_remote: number;
  last_synced_at: string;
  sources: string; // JSON array
  raw_data: string; // Full JSON from source
  env_vars: string; // JSON array of env var definitions
  source: string; // 'official' | 'glama' | 'smithery'
  use_count: number;
  verified: number; // 0 or 1
  icon_url: string | null;
  deprecated_npm: number | null; // null = not checked, 0 = clean, 1 = deprecated on npm
  archived_repo: number | null;  // null = not checked, 0 = clean, 1 = archived on GitHub
}

/** Search result returned to MCP clients */
export interface SearchResult {
  name: string;
  description: string;
  version: string;
  registryType: string | null;
  packageIdentifier: string | null;
  transportType: string | null;
  repositoryUrl: string | null;
  hasRemote: boolean;
  rank: number;
  sources: string[];
  useCount: number;
  verified: boolean;
  iconUrl: string | null;
  updatedAt: string | null;
  publishedAt: string | null;
  sourceCount: number;
  confidenceScore: number;
  confidenceBreakdown: ConfidenceBreakdown;
  recommendationReason: string;
  warningFlags: string[];
  trustSignals: TrustSignals;
  freshnessDays: number | null;
  freshnessLabel: string;
  installComplexity: 'low' | 'medium' | 'high';
  secretCount: number;
  capabilityCount: number;
}

/** Server detail returned to MCP clients */
export interface ServerDetail {
  name: string;
  description: string;
  version: string;
  registryType: string | null;
  packageIdentifier: string | null;
  transportType: string | null;
  repositoryUrl: string | null;
  repositorySource: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  status: string;
  hasRemote: boolean;
  remoteUrl: string | null;
  categories: string[];
  environmentVariables: RegistryEnvVar[];
  sources: string[];
  useCount: number;
  verified: boolean;
  iconUrl: string | null;
  sourceCount: number;
  confidenceScore: number;
  confidenceBreakdown: ConfidenceBreakdown;
  recommendationReason: string;
  warningFlags: string[];
  trustSignals: TrustSignals;
  freshnessDays: number | null;
  freshnessLabel: string;
  installComplexity: 'low' | 'medium' | 'high';
  secretCount: number;
  capabilityCount: number;
  toolsExposed: ToolSummary[];
}

/** Category with server count */
export interface Category {
  name: string;
  count: number;
  keywords: string[];
}

// ─── Glama Registry Types ───────────────────────────────────────────────────

export interface GlamaServer {
  id: string;
  name: string;
  namespace: string;
  slug: string;
  description: string | null;
  repository: { url: string } | null;
  spdxLicense: string | null;
  tools: unknown[];
  url: string | null;
  environmentVariablesJsonSchema: unknown;
  attributes: Record<string, unknown>;
}

export interface GlamaListResponse {
  pageInfo: {
    endCursor: string | null;
    hasNextPage: boolean;
  };
  servers: GlamaServer[];
}

// ─── Smithery Registry Types ────────────────────────────────────────────────

export interface SmitheryServer {
  qualifiedName: string;
  displayName: string;
  description: string | null;
  useCount: number;
  verified: boolean;
  remote: boolean;
  isDeployed: boolean;
  iconUrl: string | null;
  homepage: string | null;
  createdAt: string;
}

export interface SmitheryListResponse {
  servers: SmitheryServer[];
  pagination: {
    currentPage: number;
    pageSize: number;
    totalPages: number;
    totalCount: number;
  };
}
