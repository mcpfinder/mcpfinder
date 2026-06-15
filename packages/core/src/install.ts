/**
 * Generate installation commands for MCP servers.
 * Supports Claude Desktop, Cursor, Claude Code, Cline/Roo Code, Windsurf, and generic configurations.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { McpServer, RegistryEnvVar } from './types.js';
import { findServerByNameOrSlug } from './search.js';

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

  if (row.has_remote && row.remote_url) {
    return generateRemoteConfig(serverKey, row.remote_url, envVars, client);
  }

  const platform = PLATFORM_INFO[client];
  return {
    client,
    serverName: serverKey,
    configFilePath: platform.configPath,
    config: {
      note: 'Unable to generate auto-config. Check the repository for installation instructions.',
      repositoryUrl: row.repository_url,
      registryType: row.registry_type,
      packageIdentifier: row.package_identifier,
    },
    instructions: `Could not auto-generate config. Check the repository: ${row.repository_url || 'N/A'}`,
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
  const env: Record<string, string> = {};
  for (const v of envVars) {
    env[v.name] = v.isSecret ? '<YOUR_VALUE>' : (v.description || '<VALUE>');
  }

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
  const env: Record<string, string> = {};
  for (const v of envVars) {
    env[v.name] = v.isSecret ? '<YOUR_VALUE>' : (v.description || '<VALUE>');
  }

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
