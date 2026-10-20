/**
 * Generate installation commands for MCP servers.
 * Supports Claude Desktop, Cursor, Claude Code, Cline/Roo Code, Windsurf, and generic configurations.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { McpServer, RegistryEnvVar } from './types.js';
import { findServerByNameOrSlug } from './search.js';
import { usableRemoteUrl } from './remote-url.js';

export type ClientType =
  | 'claude-desktop'
  | 'cursor'
  | 'claude-code'
  | 'cline'
  | 'windsurf'
  | 'vscode'
  | 'generic';

export interface InstallConfig {
  client: ClientType;
  serverName: string;
  configFilePath: string;
  config: Record<string, unknown>;
  instructions: string;
  postInstallNote: string;
  envVarsNeeded: RegistryEnvVar[];
}

/** Platform metadata: config file paths and notes. */
const PLATFORM_INFO: Record<
  ClientType,
  { configPath: string; configPathWin?: string; displayName: string; postInstall: string }
> = {
  'claude-desktop': {
    configPath: '~/Library/Application Support/Claude/claude_desktop_config.json',
    configPathWin: '%APPDATA%\\Claude\\claude_desktop_config.json',
    displayName: 'Claude Desktop',
    postInstall: 'Restart Claude Desktop to activate the new server.',
  },
  cursor: {
    configPath: '.cursor/mcp.json (project) or ~/.cursor/mcp.json (global)',
    displayName: 'Cursor',
    postInstall: 'Cursor auto-detects config changes — no restart needed.',
  },
  'claude-code': {
    configPath: '.mcp.json (project) or ~/.claude.json (global)',
    displayName: 'Claude Code',
    postInstall: 'Claude Code will detect the new server automatically on next tool use.',
  },
  cline: {
    configPath: '.vscode/mcp.json or VS Code settings (Cline MCP config)',
    displayName: 'Cline / Roo Code',
    postInstall: 'Reload the VS Code window or restart Cline to activate.',
  },
  windsurf: {
    configPath: '~/.windsurf/mcp.json',
    displayName: 'Windsurf',
    postInstall: 'Restart Windsurf to activate the new server.',
  },
  vscode: {
    configPath: '.vscode/mcp.json',
    displayName: 'VS Code',
    postInstall: 'Reload the VS Code window to activate.',
  },
  generic: {
    configPath: 'your MCP client config file',
    displayName: 'MCP Client',
    postInstall: "Refer to your client's docs for how to reload MCP config.",
  },
};

/**
 * Coerce a registry-provided value into something that can sit in a config
 * file. Anything that is not a scalar (objects, arrays, null, NaN) is dropped
 * so the caller falls through to the next preference instead of emitting
 * `[object Object]`.
 */
function envValueToString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === 'boolean') return String(value);
  return undefined;
}

/**
 * Value to put in the `env` block of a generated config. Secrets always get a
 * placeholder the user must replace; everything else prefers a concrete value
 * published by the registry (`default`, then `placeholder`) and falls back to
 * `<VALUE>`. Descriptions are prose and belong in the "Required environment
 * variables" section, never in the JSON snippet.
 */
export function envPlaceholderValue(v: RegistryEnvVar): string {
  if (v.isSecret) return '<YOUR_VALUE>';
  return envValueToString(v.default) ?? envValueToString(v.placeholder) ?? '<VALUE>';
}

/** Build the `env` map of a generated config from registry env var definitions. */
export function buildEnvPlaceholders(envVars: RegistryEnvVar[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const v of envVars) {
    env[v.name] = envPlaceholderValue(v);
  }
  return env;
}

/**
 * Shown when a server has neither a known package nor a remote MCP endpoint.
 * A directory listing page (listing_url) is never offered as an MCP URL.
 */
export const NO_INSTALL_METHOD_NOTE =
  'No install method known: no package and no remote MCP endpoint is published for this server. See its listing or repository for setup instructions.';

/**
 * Generate install configuration for a specific MCP server and client.
 */
export function getInstallCommand(
  db: DatabaseSync,
  nameOrSlug: string,
  client: ClientType = 'claude-desktop',
): InstallConfig | null {
  const row = findServerByNameOrSlug(db, nameOrSlug);

  if (!row) return null;

  let envVars: RegistryEnvVar[] = [];
  try {
    envVars = JSON.parse(row.env_vars || '[]');
  } catch {
    envVars = [];
  }

  const serverKey = row.slug || row.name.split('/').pop() || row.name;

  if (row.registry_type === 'npm' && row.package_identifier) {
    return generateNpmConfig(serverKey, row.package_identifier, envVars, client);
  }

  if (row.registry_type === 'pypi' && row.package_identifier) {
    return generatePypiConfig(serverKey, row.package_identifier, envVars, client);
  }

  if (row.registry_type === 'oci' && row.package_identifier) {
    return generateDockerConfig(serverKey, row.package_identifier, envVars, client);
  }

  const remoteUrl = row.has_remote ? usableRemoteUrl(row.remote_url) : null;
  if (remoteUrl) {
    return generateRemoteConfig(serverKey, remoteUrl, envVars, client);
  }

  const platform = PLATFORM_INFO[client];
  return {
    client,
    serverName: serverKey,
    configFilePath: platform.configPath,
    config: {
      note: NO_INSTALL_METHOD_NOTE,
      repositoryUrl: row.repository_url,
      listingUrl: row.listing_url ?? null,
      registryType: row.registry_type,
      packageIdentifier: row.package_identifier,
    },
    instructions: [
      NO_INSTALL_METHOD_NOTE,
      row.repository_url ? `Repository: ${row.repository_url}` : null,
      row.listing_url ? `Listing: ${row.listing_url}` : null,
      !row.repository_url && !row.listing_url ? 'No repository or listing URL is known.' : null,
    ].filter(Boolean).join('\n'),
    postInstallNote: '',
    envVarsNeeded: envVars,
  };
}

function buildInstructions(
  mcpConfig: Record<string, unknown>,
  client: ClientType,
  prefix?: string,
): { instructions: string; configFilePath: string; postInstallNote: string } {
  const platform = PLATFORM_INFO[client];
  const json = JSON.stringify(mcpConfig, null, 2);
  const prefixStr = prefix ? `${prefix}\n\n` : '';

  const instructions =
    `${prefixStr}Add to your ${platform.displayName} config (${platform.configPath}):\n\n` +
    '```json\n' + json + '\n```' +
    (platform.configPathWin ? `\n\nOn Windows: ${platform.configPathWin}` : '');

  return {
    instructions,
    configFilePath: platform.configPath,
    postInstallNote: platform.postInstall,
  };
}

function generateNpmConfig(
  serverKey: string,
  packageId: string,
  envVars: RegistryEnvVar[],
  client: ClientType,
): InstallConfig {
  const env = buildEnvPlaceholders(envVars);

  const config: Record<string, unknown> = {
    command: 'npx',
    args: ['-y', packageId],
  };
  if (Object.keys(env).length > 0) {
    config.env = env;
  }

  const mcpConfig = { mcpServers: { [serverKey]: config } };
  const meta = buildInstructions(mcpConfig, client);

  return { client, serverName: serverKey, ...meta, config: mcpConfig, envVarsNeeded: envVars };
}

function generatePypiConfig(
  serverKey: string,
  packageId: string,
  envVars: RegistryEnvVar[],
  client: ClientType,
): InstallConfig {
  const env = buildEnvPlaceholders(envVars);

  const config: Record<string, unknown> = { command: 'uvx', args: [packageId] };
  if (Object.keys(env).length > 0) config.env = env;

  const mcpConfig = { mcpServers: { [serverKey]: config } };
  const meta = buildInstructions(mcpConfig, client, 'Install via uvx (recommended) or pip.');

  return { client, serverName: serverKey, ...meta, config: mcpConfig, envVarsNeeded: envVars };
}

function generateDockerConfig(
  serverKey: string,
  packageId: string,
  envVars: RegistryEnvVar[],
  client: ClientType,
): InstallConfig {
  const config: Record<string, unknown> = {
    command: 'docker',
    args: ['run', '-i', ...envVars.flatMap((v) => ['-e', `${v.name}=<YOUR_VALUE>`]), packageId],
  };

  const mcpConfig = { mcpServers: { [serverKey]: config } };
  const meta = buildInstructions(mcpConfig, client, 'Run via Docker container.');

  return { client, serverName: serverKey, ...meta, config: mcpConfig, envVarsNeeded: envVars };
}

function generateRemoteConfig(
  serverKey: string,
  remoteUrl: string,
  envVars: RegistryEnvVar[],
  client: ClientType,
): InstallConfig {
  const mcpConfig = { mcpServers: { [serverKey]: { url: remoteUrl } } };
  const meta = buildInstructions(mcpConfig, client, 'This is a hosted/remote MCP server — no local installation needed.');

  return { client, serverName: serverKey, ...meta, config: mcpConfig, envVarsNeeded: envVars };
}
