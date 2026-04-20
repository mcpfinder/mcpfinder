#!/usr/bin/env node
/**
 * MCPfinder MCP Server
 * Your AI's app store for MCP tools — discover and install 25000+ MCP servers on demand.
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
} from '@mcpfinder/core';
import type { RegistryEnvVar } from '@mcpfinder/core';

// Initialize database
const db = initDatabase();

// Create MCP server
const server = new McpServer({
  name: 'mcpfinder',
  version: '1.0.0',
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

// ─── Tool: search_mcp_servers ───────────────────────────────────────────────

server.tool(
  'search_mcp_servers',
  'Use when the user needs a capability you don\'t have. Search 25000+ MCP servers by keyword, use case, or technology from Official MCP Registry, Glama, and Smithery. Returns ranked results with install info.',
  {
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
  async ({ query, limit, transportType, registryType, registrySource }) => {
    await ensureSync();

    const results = searchServers(db, query, limit, {
      transportType: transportType === 'any' ? undefined : transportType,
      registryType: registryType === 'any' ? undefined : registryType,
      registrySource: registrySource === 'any' ? undefined : registrySource,
    });

    if (results.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `No servers found for "${query}". Try a different search term or browse categories with list_categories.`,
          },
        ],
      };
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

    return {
      content: [
        {
          type: 'text' as const,
          text: query
            ? `Found ${results.length} MCP server(s) for "${query}":\n\n${formatted}\n\nUse get_server_details for full info, or get_install_command to generate install config for any platform.`
            : `Top ${results.length} most popular MCP servers:\n\n${formatted}\n\nUse search_mcp_servers with a query to find specific servers, or get_install_command to install any of these.`,
        },
      ],
    };
  },
);

// ─── Tool: get_server_details ───────────────────────────────────────────────

server.tool(
  'get_server_details',
  'Get full details about a specific MCP server before installing — description, tools, required environment variables, popularity, and source registries. Use this to evaluate a server before generating install config.',
  {
    name: z.string().describe('Server name (e.g., "io.modelcontextprotocol/filesystem") or slug (e.g., "filesystem")'),
  },
  async ({ name }) => {
    await ensureSync();

    const detail = getServerDetails(db, name);
    if (!detail) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Server "${name}" not found. Try searching with search_mcp_servers first.`,
          },
        ],
      };
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
      detail.useCount > 0 ? `**Popularity:** ${formatUseCount(detail.useCount)} uses` : '',
      detail.verified ? '**Verified:** ✓' : '',
      envSection,
      '',
      'Use get_install_command to generate ready-to-use config for any platform.',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      content: [{ type: 'text' as const, text }],
    };
  },
);

// ─── Tool: get_install_command ──────────────────────────────────────────────

server.tool(
  'get_install_command',
  'Generate ready-to-use install config for any MCP platform: Claude Desktop, Cursor, Claude Code, Cline (VS Code), or Windsurf. Returns the JSON config snippet, config file path (OS-specific), required env vars, and post-install instructions. Supports both local (npx/uvx/docker) and remote (SSE) servers.',
  {
    name: z.string().describe('Server name or slug (e.g., "filesystem", "io.modelcontextprotocol/filesystem")'),
    platform: z
      .enum(['claude-desktop', 'cursor', 'claude-code', 'cline', 'windsurf'])
      .default('claude-desktop')
      .describe('Target platform for install config'),
  },
  async ({ name, platform }) => {
    await ensureSync();

    const detail = getServerDetails(db, name);
    if (!detail) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Server "${name}" not found. Try searching with search_mcp_servers first.`,
          },
        ],
      };
    }

    const serverKey = detail.name.includes('/') ? (detail.name.split('/').pop() || detail.name) : detail.name;
    const envVars = detail.environmentVariables || [];
    const env = buildEnvMap(envVars);
    const platformInfo = PLATFORMS[platform];
    const isRemote = detail.hasRemote && detail.remoteUrl;

    let serverConfig: Record<string, unknown>;
    let installType: string;

    if (isRemote && detail.remoteUrl) {
      // Remote/hosted server — use SSE URL
      serverConfig = { url: detail.remoteUrl };
      if (Object.keys(env).length > 0) {
        serverConfig.env = env;
      }
      installType = 'remote';
    } else if (detail.registryType === 'npm' && detail.packageIdentifier) {
      serverConfig = { command: 'npx', args: ['-y', detail.packageIdentifier] };
      if (Object.keys(env).length > 0) {
        serverConfig.env = env;
      }
      installType = 'npm';
    } else if (detail.registryType === 'pypi' && detail.packageIdentifier) {
      serverConfig = { command: 'uvx', args: [detail.packageIdentifier] };
      if (Object.keys(env).length > 0) {
        serverConfig.env = env;
      }
      installType = 'pypi';
    } else if (detail.registryType === 'oci' && detail.packageIdentifier) {
      serverConfig = {
        command: 'docker',
        args: ['run', '-i', ...envVars.flatMap((v) => ['-e', `${v.name}=<YOUR_VALUE>`]), detail.packageIdentifier],
      };
      installType = 'docker';
    } else {
      // Fallback — no auto-config available
      const fallbackLines = [
        `# Install ${detail.name} on ${platformInfo.name}`,
        '',
        `⚠️ Auto-config not available for this server (registry type: ${detail.registryType || 'unknown'}).`,
        '',
        detail.repositoryUrl ? `Check the repository for manual install instructions: ${detail.repositoryUrl}` : 'No repository URL available.',
      ];
      if (envVars.length > 0) {
        fallbackLines.push('', '**Required environment variables:**');
        for (const v of envVars) {
          fallbackLines.push(`- \`${v.name}\`: ${v.description || 'No description'}${v.isSecret ? ' ⚠️ secret' : ''}`);
        }
      }
      return { content: [{ type: 'text' as const, text: fallbackLines.join('\n') }] };
    }

    // Build the config snippet with the platform's top-level key
    const wrapper: Record<string, unknown> = {
      [platformInfo.topLevelKey]: { [serverKey]: serverConfig },
    };
    const snippet = JSON.stringify(wrapper, null, 2);

    const configPath = `  macOS: ${platformInfo.configPaths.mac}\n  Windows: ${platformInfo.configPaths.windows}\n  Linux: ${platformInfo.configPaths.linux}`;

    // Build response
    const sections: string[] = [
      `# Install ${detail.name} on ${platformInfo.name}`,
      '',
      installType === 'remote'
        ? '🌐 **Remote server** — connects via SSE, no local install needed.'
        : `📦 **Local server** — runs via ${installType === 'npm' ? 'npx' : installType === 'pypi' ? 'uvx' : 'docker'}.`,
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
        sections.push(`- \`${v.name}\`: ${v.description || 'No description'}${v.isSecret ? ' ⚠️ secret — replace <YOUR_VALUE> with your actual key' : ''}`);
      }
    }

    sections.push('', '## After adding the config', platformInfo.postInstall);

    if (platform === 'claude-code') {
      sections.push('', '**Tip:** Use `.mcp.json` in your project root for project-level config, or `~/.claude.json` for global config.');
    }

    return {
      content: [{ type: 'text' as const, text: sections.join('\n') }],
    };
  },
);

// ─── Tool: list_categories ──────────────────────────────────────────────────

server.tool(
  'list_categories',
  'Explore available MCP servers by category when you\'re not sure what to search for. Returns all categories (database, filesystem, ai, security, etc.) with server counts. Great for discovery.',
  {},
  async () => {
    await ensureSync();

    const categories = listCategories(db);

    if (categories.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'No categories found. The database may be empty — try searching with search_mcp_servers to trigger a sync.',
          },
        ],
      };
    }

    const formatted = categories
      .map((c: { name: string; count: number }) => `- **${c.name}** (${c.count} servers)`)
      .join('\n');

    return {
      content: [
        {
          type: 'text' as const,
          text: `MCP Server Categories:\n\n${formatted}\n\nUse browse_category to see servers in a category, or search_mcp_servers for keyword search.`,
        },
      ],
    };
  },
);

// ─── Tool: browse_category ─────────────────────────────────────────────────

server.tool(
  'browse_category',
  'See the most popular and trusted MCP servers in a specific category (e.g., database, filesystem, api, ai, security). Servers are ranked by community usage. Use list_categories first to see available categories.',
  {
    category: z.string().describe('Category name from list_categories output'),
    limit: z.number().min(1).max(50).default(20).describe('Maximum results to return (default: 20, max: 50)'),
  },
  async ({ category, limit }) => {
    await ensureSync();

    const servers = getServersByCategory(db, category.toLowerCase(), limit);

    if (servers.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `No servers found in category "${category}". Use list_categories to see available categories.`,
          },
        ],
      };
    }

    const formatted = servers
      .map((s, idx) => `${idx + 1}. **${s.name}** (v${s.version})\n   ${s.description}`)
      .join('\n\n');

    return {
      content: [
        {
          type: 'text' as const,
          text: `Servers in category "${category}" (${servers.length}):\n\n${formatted}\n\nUse get_install_command to generate config for any of these servers.`,
        },
      ],
    };
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
