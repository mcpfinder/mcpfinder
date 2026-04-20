#!/usr/bin/env node
/**
 * MCPfinder MCP Server
 * Your AI's app store for MCP tools — discover and install 10K+ MCP servers on demand.
 * Aggregates Official MCP Registry, Glama, and Smithery into a fast, searchable index.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  initDatabase,
  syncOfficialRegistry,
  syncGlamaRegistry,
  syncSmitheryRegistry,
  isSyncNeeded,
  getServerCount,
  searchServers,
  getServerDetails,
  listCategories,
  getServersByCategory,
  bootstrapFromSnapshot,
} from '@mcpfinder/core';
import type { RegistryEnvVar } from '@mcpfinder/core';

// Bootstrap from hosted snapshot on first run (much faster than live sync).
// Disable with MCPFINDER_DISABLE_SNAPSHOT=1; override URL with MCPFINDER_SNAPSHOT_BASE.
async function maybeBootstrap(): Promise<void> {
  if (process.env.MCPFINDER_DISABLE_SNAPSHOT) return;
  const result = await bootstrapFromSnapshot({
    baseUrl: process.env.MCPFINDER_SNAPSHOT_BASE,
  });
  if (result.ok) {
    process.stderr.write(
      `[mcpfinder] Bootstrapped from snapshot: ${result.servers} servers, ` +
        `${((result.bytesDownloaded ?? 0) / 1e6).toFixed(1)}MB in ${result.durationMs}ms ` +
        `(published ${result.publishedAt})\n`,
    );
  } else if (result.reason !== 'db-already-exists') {
    process.stderr.write(`[mcpfinder] Snapshot bootstrap skipped: ${result.reason}\n`);
  }
}

await maybeBootstrap();

// Initialize database
const db = initDatabase();

// Create MCP server
const server = new McpServer({
  name: 'mcpfinder',
  version: '1.0.2',
});

// ─── Platform Configuration ─────────────────────────────────────────────────

type Platform = 'claude-desktop' | 'cursor' | 'claude-code' | 'cline' | 'windsurf';

interface PlatformConfig {
  name: string;
  configPaths: { mac: string; windows: string; linux: string };
  postInstall: string;
  topLevelKey: string; // "mcpServers" or "servers"
}

const PLATFORMS: Record<Platform, PlatformConfig> = {
  'claude-desktop': {
    name: 'Claude Desktop',
    configPaths: {
      mac: '~/Library/Application Support/Claude/claude_desktop_config.json',
      windows: '%APPDATA%\\Claude\\claude_desktop_config.json',
      linux: '~/.config/Claude/claude_desktop_config.json',
    },
    postInstall: 'Restart Claude Desktop to activate the new server.',
    topLevelKey: 'mcpServers',
  },
  cursor: {
    name: 'Cursor',
    configPaths: {
      mac: '~/.cursor/mcp.json',
      windows: '%USERPROFILE%\\.cursor\\mcp.json',
      linux: '~/.cursor/mcp.json',
    },
    postInstall: 'Restart Cursor or reload the window to activate.',
    topLevelKey: 'mcpServers',
  },
  'claude-code': {
    name: 'Claude Code',
    configPaths: {
      mac: '.mcp.json (project-level) or ~/.claude.json (global)',
      windows: '.mcp.json (project-level) or %USERPROFILE%\\.claude.json (global)',
      linux: '.mcp.json (project-level) or ~/.claude.json (global)',
    },
    postInstall: 'The server will be available on the next Claude Code session.',
    topLevelKey: 'mcpServers',
  },
  cline: {
    name: 'Cline (VS Code)',
    configPaths: {
      mac: '.vscode/mcp.json',
      windows: '.vscode\\mcp.json',
      linux: '.vscode/mcp.json',
    },
    postInstall: 'Reload VS Code window to activate.',
    topLevelKey: 'servers',
  },
  windsurf: {
    name: 'Windsurf',
    configPaths: {
      mac: '~/.codeium/windsurf/mcp_config.json',
      windows: '%USERPROFILE%\\.codeium\\windsurf\\mcp_config.json',
      linux: '~/.codeium/windsurf/mcp_config.json',
    },
    postInstall: 'Restart Windsurf to activate the new server.',
    topLevelKey: 'mcpServers',
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatUseCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

function sourceBadges(sources: string[], useCount: number, verified: boolean): string {
  const badges: string[] = [];
  if (sources.includes('official')) badges.push('📦 Official');
  if (sources.includes('smithery')) {
    let badge = '🌟 Smithery';
    if (useCount > 0) badge += ` (${formatUseCount(useCount)} uses)`;
    if (verified) badge += ' ✓';
    badges.push(badge);
  }
  if (sources.includes('glama')) badges.push('🔍 Glama');
  return badges.length > 0 ? badges.join(' | ') : '';
}

function buildEnvMap(envVars: RegistryEnvVar[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const v of envVars) {
    env[v.name] = v.isSecret ? '<YOUR_VALUE>' : (v.description || '<VALUE>');
  }
  return env;
}

// Returns a CallToolResult with both a human-readable text block and a
// machine-readable `structuredContent` field. Clients that understand the
// MCP 2025-12-11 spec can read structuredContent directly; older clients
// fall back to the text block.
function makeTextResponse(text: string, structuredContent?: Record<string, unknown>) {
  const result: {
    content: Array<{ type: 'text'; text: string }>;
    structuredContent?: Record<string, unknown>;
  } = {
    content: [{ type: 'text' as const, text }],
  };
  if (structuredContent) result.structuredContent = structuredContent;
  return result;
}

async function ensureSync(): Promise<void> {
  const count = getServerCount(db);
  if (count === 0 || isSyncNeeded(db)) {
    const results = await Promise.allSettled([
      syncOfficialRegistry(db),
      syncGlamaRegistry(db),
      syncSmitheryRegistry(db),
    ]);
    const counts = results.map((r) => (r.status === 'fulfilled' ? r.value : 0));
    process.stderr.write(
      `[mcpfinder] Synced: Official=${counts[0]}, Glama=${counts[1]}, Smithery=${counts[2]} (${getServerCount(db)} total)\n`,
    );
  }
}

// ─── Output schemas (permissive — let record-shaped nested data through) ────

const nextActionsSchema = z.array(z.string());

const searchOutputSchema = {
  query: z.string(),
  results: z.array(z.record(z.string(), z.unknown())),
  next_actions: nextActionsSchema,
};

const detailsOutputSchema = {
  found: z.boolean(),
  server: z.record(z.string(), z.unknown()).optional(),
  name: z.string().optional(),
  next_actions: nextActionsSchema,
};

const installOutputSchema = {
  found: z.boolean(),
  autoInstallable: z.boolean().optional(),
  server: z.string().optional(),
  platform: z.string().optional(),
  installType: z.string().optional(),
  configFilePath: z.record(z.string(), z.string()).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  envVarsNeeded: z.array(z.record(z.string(), z.unknown())).optional(),
  safe_to_autoinstall: z.boolean().optional(),
  requires_user_secrets: z.boolean().optional(),
  warningFlags: z.array(z.string()).optional(),
  next_actions: nextActionsSchema,
};

const browseOutputSchema = {
  category: z.string().optional(),
  categories: z
    .array(z.object({ name: z.string(), count: z.number() }))
    .optional(),
  results: z.array(z.record(z.string(), z.unknown())).optional(),
  next_actions: nextActionsSchema,
};

// ─── Tool: search_mcp_servers ───────────────────────────────────────────────

server.registerTool(
  'search_mcp_servers',
  {
    description:
      'Call this first whenever the user needs a capability you do not already have. Use it when the user mentions an external service, a database, a filesystem, a SaaS tool, or asks "can you connect to X?". Examples: "connect to postgres" -> query "postgres"; "read my Slack" -> query "slack"; "browse local files" -> query "filesystem". If results are weak, retry with a broader term. After choosing a candidate, call get_server_details before recommending or installing it.',
    inputSchema: {
      query: z.string().default('').describe(
        'Search query — a keyword (e.g., "filesystem"), use case ("query databases"), or technology ("postgres"). ' +
          'Common aliases work: "gh" → github, "pg" → postgres, "k8s" → kubernetes, "db" → database. ' +
          'Leave empty to see the most popular servers.',
      ),
      limit: z.number().min(1).max(50).default(10).describe('Maximum results to return (default: 10, max: 50)'),
      transportType: z
        .enum(['stdio', 'streamable-http', 'sse', 'any'])
        .default('any')
        .describe('Filter by transport type'),
      registryType: z
        .enum(['npm', 'pypi', 'oci', 'any'])
        .default('any')
        .describe('Filter by package registry type'),
      registrySource: z
        .enum(['official', 'glama', 'smithery', 'any'])
        .default('any')
        .describe('Filter by registry source'),
    },
    outputSchema: searchOutputSchema,
  },
  async ({ query, limit, transportType, registryType, registrySource }) => {
    await ensureSync();

    const results = searchServers(db, query, limit, {
      transportType: transportType === 'any' ? undefined : transportType,
      registryType: registryType === 'any' ? undefined : registryType,
      registrySource: registrySource === 'any' ? undefined : registrySource,
    });

    if (results.length === 0) {
      return makeTextResponse(
        `No servers found for "${query}". Try a broader term, a synonym, or browse categories.`,
        {
          query,
          results: [],
          next_actions: ['browse_categories()', 'search_mcp_servers(query="<broader term>")'],
        },
      );
    }

    const formatted = results
      .map((r) => {
        const badges = sourceBadges(r.sources, r.useCount, r.verified);
        return (
          `${r.rank}. **${r.name}** (v${r.version || 'n/a'})\n` +
          `   ${r.description}\n` +
          `   Package: ${r.packageIdentifier || 'N/A'} | Transport: ${r.transportType || 'N/A'}` +
          (r.hasRemote ? ' | 🌐 Remote available' : '') +
          (badges ? `\n   ${badges}` : '')
        );
      })
      .join('\n\n');

    return makeTextResponse(
      query
        ? `Found ${results.length} MCP server(s) for "${query}":\n\n${formatted}\n\nCall get_server_details on the best candidate before recommending or installing it.`
        : `Top ${results.length} most popular MCP servers:\n\n${formatted}\n\nCall get_server_details on a candidate before recommending or installing it.`,
      {
        query,
        results: results.map((r) => ({
          name: r.name,
          packageIdentifier: r.packageIdentifier,
          registryType: r.registryType,
          transportType: r.transportType,
          hasRemote: r.hasRemote,
          sources: r.sources,
          updatedAt: r.updatedAt,
          confidenceScore: r.confidenceScore,
          confidenceBreakdown: r.confidenceBreakdown,
          recommendationReason: r.recommendationReason,
          warningFlags: r.warningFlags,
        })),
        next_actions: results.slice(0, 3).map((r) => `get_server_details(name="${r.name}")`),
      },
    );
  },
);

// ─── Tool: get_server_details ───────────────────────────────────────────────

server.registerTool(
  'get_server_details',
  {
    description:
      'Always call this before recommending or installing a server. It returns the metadata you need to judge safety and fit: install method, transport, environment variables, source count, trust signals, warnings, and any discovered tools/capabilities. Use it to warn the user about secrets, stale projects, or weak metadata before calling get_install_config.',
    inputSchema: {
      name: z
        .string()
        .describe('Server name (e.g., "io.modelcontextprotocol/filesystem") or slug (e.g., "filesystem")'),
    },
    outputSchema: detailsOutputSchema,
  },
  async ({ name }) => {
    await ensureSync();

    const detail = getServerDetails(db, name);
    if (!detail) {
      return makeTextResponse(`Server "${name}" not found. Search first with search_mcp_servers.`, {
        name,
        found: false,
        next_actions: ['search_mcp_servers(query="<keyword>")'],
      });
    }

    const envSection =
      detail.environmentVariables.length > 0
        ? '\n\n**Environment Variables:**\n' +
          detail.environmentVariables
            .map(
              (v) =>
                `- \`${v.name}\`: ${v.description || 'No description'}${v.isSecret ? ' (secret)' : ''}`,
            )
            .join('\n')
        : '';

    const badges = sourceBadges(detail.sources, detail.useCount, detail.verified);
    const toolSection =
      detail.toolsExposed.length > 0
        ? '\n\n**Tools Exposed:**\n' +
          detail.toolsExposed
            .slice(0, 15)
            .map((tool) => `- \`${tool.name}\`${tool.description ? `: ${tool.description}` : ''}`)
            .join('\n')
        : '';
    const warningsSection =
      detail.warningFlags.length > 0 ? `**Warnings:** ${detail.warningFlags.join(', ')}` : '';
    const trustSection = [
      `**Freshness:** ${detail.freshnessLabel}${detail.freshnessDays !== null ? ` (${detail.freshnessDays}d)` : ''}`,
      `**Install Complexity:** ${detail.installComplexity}`,
      `**Secrets Required:** ${detail.secretCount}`,
      `**Capabilities Discovered:** ${detail.capabilityCount}`,
      `**Trust Signals:** ${
        [
          detail.trustSignals.hasOfficialSource ? 'official' : '',
          detail.trustSignals.isVerified ? 'verified' : '',
          detail.trustSignals.multiSource ? 'multi-source' : '',
          detail.trustSignals.hasRepository ? 'repository' : '',
          detail.trustSignals.hasRemote ? 'remote' : '',
          detail.trustSignals.hasRecentUpdate ? 'recent-update' : '',
        ]
          .filter(Boolean)
          .join(', ') || 'none'
      }`,
    ].join('\n');

    const text = [
      `# ${detail.name}`,
      '',
      detail.description,
      '',
      `**Version:** ${detail.version || 'N/A'}`,
      `**Status:** ${detail.status}`,
      `**Package:** ${detail.packageIdentifier || 'N/A'} (${detail.registryType || 'unknown'})`,
      `**Transport:** ${detail.transportType || 'N/A'}`,
      `**Repository:** ${detail.repositoryUrl || 'N/A'}`,
      detail.hasRemote ? `**Remote URL:** ${detail.remoteUrl}` : '',
      `**Published:** ${detail.publishedAt || 'N/A'}`,
      `**Updated:** ${detail.updatedAt || 'N/A'}`,
      detail.categories.length > 0 ? `**Categories:** ${detail.categories.join(', ')}` : '',
      badges ? `**Sources:** ${badges}` : '',
      `**Source Count:** ${detail.sourceCount}`,
      `**Confidence:** ${detail.confidenceScore}${
        detail.confidenceBreakdown?.drivers?.length
          ? ` (${detail.confidenceBreakdown.drivers.join(', ')})`
          : ''
      }`,
      `**Why recommended:** ${detail.recommendationReason}`,
      detail.useCount > 0 ? `**Popularity:** ${formatUseCount(detail.useCount)} uses` : '',
      detail.verified ? '**Verified:** ✓' : '',
      trustSection,
      warningsSection,
      toolSection,
      envSection,
      '',
      'If this looks acceptable, call get_install_config to generate a client-specific JSON config snippet.',
    ]
      .filter(Boolean)
      .join('\n');

    return makeTextResponse(text, {
      found: true,
      server: {
        name: detail.name,
        registryType: detail.registryType,
        packageIdentifier: detail.packageIdentifier,
        transportType: detail.transportType,
        repositoryUrl: detail.repositoryUrl,
        remoteUrl: detail.remoteUrl,
        categories: detail.categories,
        sources: detail.sources,
        sourceCount: detail.sourceCount,
        useCount: detail.useCount,
        verified: detail.verified,
        confidenceScore: detail.confidenceScore,
        confidenceBreakdown: detail.confidenceBreakdown,
        recommendationReason: detail.recommendationReason,
        warningFlags: detail.warningFlags,
        trustSignals: detail.trustSignals,
        freshnessDays: detail.freshnessDays,
        freshnessLabel: detail.freshnessLabel,
        installComplexity: detail.installComplexity,
        secretCount: detail.secretCount,
        capabilityCount: detail.capabilityCount,
        environmentVariables: detail.environmentVariables,
        toolsExposed: detail.toolsExposed,
      },
      next_actions: [`get_install_config(name="${detail.name}", platform="claude-desktop")`],
    });
  },
);

// ─── Tool: get_install_config ───────────────────────────────────────────────

async function buildInstallConfigResponse(name: string, platform: Platform) {
  await ensureSync();

  const detail = getServerDetails(db, name);
  if (!detail) {
    return makeTextResponse(`Server "${name}" not found. Try searching with search_mcp_servers first.`, {
      name,
      found: false,
      next_actions: ['search_mcp_servers(query="<keyword>")'],
    });
  }

  const serverKey = detail.name.includes('/') ? detail.name.split('/').pop() || detail.name : detail.name;
  const envVars = detail.environmentVariables || [];
  const env = buildEnvMap(envVars);
  const platformInfo = PLATFORMS[platform];
  const isRemote = detail.hasRemote && detail.remoteUrl;

  let serverConfig: Record<string, unknown>;
  let installType: string;

  if (isRemote && detail.remoteUrl) {
    serverConfig = { url: detail.remoteUrl };
    if (Object.keys(env).length > 0) serverConfig.env = env;
    installType = 'remote';
  } else if (detail.registryType === 'npm' && detail.packageIdentifier) {
    serverConfig = { command: 'npx', args: ['-y', detail.packageIdentifier] };
    if (Object.keys(env).length > 0) serverConfig.env = env;
    installType = 'npm';
  } else if (detail.registryType === 'pypi' && detail.packageIdentifier) {
    serverConfig = { command: 'uvx', args: [detail.packageIdentifier] };
    if (Object.keys(env).length > 0) serverConfig.env = env;
    installType = 'pypi';
  } else if (detail.registryType === 'oci' && detail.packageIdentifier) {
    serverConfig = {
      command: 'docker',
      args: [
        'run',
        '-i',
        ...envVars.flatMap((v) => ['-e', `${v.name}=<YOUR_VALUE>`]),
        detail.packageIdentifier,
      ],
    };
    installType = 'docker';
  } else {
    const fallbackLines = [
      `# Install ${detail.name} on ${platformInfo.name}`,
      '',
      `Auto-config is not available for this server (registry type: ${detail.registryType || 'unknown'}).`,
      '',
      detail.repositoryUrl
        ? `Check the repository for manual install instructions: ${detail.repositoryUrl}`
        : 'No repository URL available.',
    ];
    if (envVars.length > 0) {
      fallbackLines.push('', '**Required environment variables:**');
      for (const v of envVars) {
        fallbackLines.push(
          `- \`${v.name}\`: ${v.description || 'No description'}${v.isSecret ? ' (secret)' : ''}`,
        );
      }
    }
    return makeTextResponse(fallbackLines.join('\n'), {
      found: true,
      autoInstallable: false,
      warningFlags: detail.warningFlags,
      next_actions: [],
    });
  }

  const wrapper: Record<string, unknown> = {
    [platformInfo.topLevelKey]: { [serverKey]: serverConfig },
  };
  const snippet = JSON.stringify(wrapper, null, 2);

  const configPath = `  macOS: ${platformInfo.configPaths.mac}\n  Windows: ${platformInfo.configPaths.windows}\n  Linux: ${platformInfo.configPaths.linux}`;

  const sections: string[] = [
    `# Install ${detail.name} on ${platformInfo.name}`,
    '',
    installType === 'remote'
      ? 'Hosted/remote server. No local package install is needed.'
      : `Local server run via ${installType === 'npm' ? 'npx' : installType === 'pypi' ? 'uvx' : 'docker'}.`,
    '',
    '## Config file',
    configPath,
    '',
    '## JSON to add',
    '```json',
    snippet,
    '```',
  ];

  if (envVars.length > 0) {
    sections.push('', '## Required environment variables');
    for (const v of envVars) {
      sections.push(
        `- \`${v.name}\`: ${v.description || 'No description'}${v.isSecret ? ' ⚠️ secret — replace <YOUR_VALUE> with your actual value' : ''}`,
      );
    }
  }

  sections.push('', '## After adding the config', platformInfo.postInstall);

  return makeTextResponse(sections.join('\n'), {
    found: true,
    autoInstallable: true,
    server: detail.name,
    platform,
    installType,
    configFilePath: platformInfo.configPaths,
    config: wrapper,
    envVarsNeeded: envVars,
    safe_to_autoinstall: envVars.length === 0,
    requires_user_secrets: envVars.some((v) => v.isSecret),
    warningFlags: detail.warningFlags,
    next_actions: [],
  });
}

server.registerTool(
  'get_install_config',
  {
    description:
      'Use this after get_server_details to generate a ready-to-paste JSON config snippet for the target client. Returns structured config, file paths, required env vars, restart guidance, and safety flags like requires_user_secrets and safe_to_autoinstall.',
    inputSchema: {
      name: z
        .string()
        .describe('Server name or slug (e.g., "filesystem", "io.modelcontextprotocol/filesystem")'),
      platform: z
        .enum(['claude-desktop', 'cursor', 'claude-code', 'cline', 'windsurf'])
        .default('claude-desktop')
        .describe('Target platform for install config'),
    },
    outputSchema: installOutputSchema,
  },
  async ({ name, platform }) => buildInstallConfigResponse(name, platform),
);

// ─── Tool: browse_categories ────────────────────────────────────────────────

server.registerTool(
  'browse_categories',
  {
    description:
      'Single-call category browser for broad discovery. Call with no `category` to list all categories with counts; call with a `category` to get the highest-signal servers in that category. Prefer search_mcp_servers when the user names a concrete technology like Slack, Postgres, GitHub, or Notion; use this when discovery is domain-driven (database, filesystem, communication, security, ai, etc.).',
    inputSchema: {
      category: z
        .string()
        .optional()
        .describe('Optional category name; omit to list all categories'),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(20)
        .describe('Maximum results when category is provided (default: 20, max: 50)'),
    },
    outputSchema: browseOutputSchema,
  },
  async ({ category, limit }) => {
    await ensureSync();

    if (!category) {
      const categories = listCategories(db);
      if (categories.length === 0) {
        return makeTextResponse(
          'No categories found. The database may be empty; try search_mcp_servers to trigger a sync.',
          {
            categories: [],
            next_actions: ['search_mcp_servers(query="filesystem")'],
          },
        );
      }
      const formatted = categories
        .map((c: { name: string; count: number }) => `- **${c.name}** (${c.count} servers)`)
        .join('\n');
      return makeTextResponse(
        `MCP Server Categories:\n\n${formatted}\n\nCall browse_categories(category="<name>") to see top servers in a category.`,
        {
          categories,
          next_actions: categories.slice(0, 3).map((c) => `browse_categories(category="${c.name}")`),
        },
      );
    }

    const servers = getServersByCategory(db, category.toLowerCase(), limit);
    if (servers.length === 0) {
      return makeTextResponse(
        `No servers found in category "${category}". Call browse_categories() with no argument to list available categories.`,
        {
          category,
          results: [],
          next_actions: ['browse_categories()'],
        },
      );
    }

    const formatted = servers
      .map((s, idx) => `${idx + 1}. **${s.name}** (v${s.version})\n   ${s.description}`)
      .join('\n\n');
    return makeTextResponse(
      `Servers in category "${category}" (${servers.length}):\n\n${formatted}\n\nCall get_server_details on a candidate before installation.`,
      {
        category,
        results: servers,
        next_actions: servers.slice(0, 3).map((s) => `get_server_details(name="${s.name}")`),
      },
    );
  },
);

// ─── Start the server ───────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
