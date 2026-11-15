/**
 * Per-client MCP config metadata and remote-server entry shapes. The single
 * source of truth for both core `getInstallCommand` and the MCP server's
 * `get_install_config` tool.
 */
import type { RemoteTransport } from './remote-headers.js';

export type ClientType =
  | 'claude-desktop'
  | 'cursor'
  | 'claude-code'
  | 'cline'
  | 'windsurf'
  | 'vscode'
  | 'generic';

export interface ClientInfo {
  displayName: string;
  configPaths: { mac: string; windows: string; linux: string };
  /** Key that holds the server map in the config file. */
  topLevelKey: 'mcpServers' | 'servers';
  postInstall: string;
  /** Extra guidance about where the config lives, when one path is not the whole story. */
  configNote?: string;
}

const CLINE_STORAGE = 'Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json';

export const CLIENTS: Record<ClientType, ClientInfo> = {
  'claude-desktop': {
    displayName: 'Claude Desktop',
    configPaths: {
      mac: '~/Library/Application Support/Claude/claude_desktop_config.json',
      windows: '%APPDATA%\\Claude\\claude_desktop_config.json',
      linux: '~/.config/Claude/claude_desktop_config.json',
    },
    topLevelKey: 'mcpServers',
    postInstall: 'Restart Claude Desktop to activate the new server.',
  },
  cursor: {
    displayName: 'Cursor',
    configPaths: {
      mac: '.cursor/mcp.json (project) or ~/.cursor/mcp.json (global)',
      windows: '.cursor\\mcp.json (project) or %USERPROFILE%\\.cursor\\mcp.json (global)',
      linux: '.cursor/mcp.json (project) or ~/.cursor/mcp.json (global)',
    },
    topLevelKey: 'mcpServers',
    postInstall: 'Cursor usually picks up config changes automatically; if the server does not appear, reload the window.',
  },
  'claude-code': {
    displayName: 'Claude Code',
    configPaths: {
      mac: '.mcp.json (project) or ~/.claude.json (global)',
      windows: '.mcp.json (project) or %USERPROFILE%\\.claude.json (global)',
      linux: '.mcp.json (project) or ~/.claude.json (global)',
    },
    topLevelKey: 'mcpServers',
    postInstall: 'The server will be available in the next Claude Code session.',
  },
  cline: {
    displayName: 'Cline',
    configPaths: {
      mac: `~/Library/Application Support/${CLINE_STORAGE}`,
      windows: `%APPDATA%\\${CLINE_STORAGE.replaceAll('/', '\\')}`,
      linux: `~/.config/${CLINE_STORAGE}`,
    },
    topLevelKey: 'mcpServers',
    postInstall: 'Cline reloads cline_mcp_settings.json automatically; if the server does not appear, reload the VS Code window.',
    configNote: "Open it from Cline's MCP Servers panel → Configure. Roo Code uses a different file and format.",
  },
  windsurf: {
    displayName: 'Windsurf',
    configPaths: {
      mac: '~/.codeium/windsurf/mcp_config.json',
      windows: '%USERPROFILE%\\.codeium\\windsurf\\mcp_config.json',
      linux: '~/.codeium/windsurf/mcp_config.json',
    },
    topLevelKey: 'mcpServers',
    postInstall: 'Restart Windsurf (or refresh its MCP servers panel) to activate the new server.',
    configNote: 'Windsurf Next uses ~/.codeium/windsurf-next/mcp_config.json. Devin Desktop (the Windsurf rebrand) uses ~/.config/devin/mcp_config.json and imports the Windsurf file.',
  },
  vscode: {
    displayName: 'VS Code',
    configPaths: { mac: '.vscode/mcp.json', windows: '.vscode\\mcp.json', linux: '.vscode/mcp.json' },
    topLevelKey: 'servers',
    postInstall: 'Reload the VS Code window to activate.',
  },
  generic: {
    displayName: 'MCP Client',
    configPaths: {
      mac: 'your MCP client config file',
      windows: 'your MCP client config file',
      linux: 'your MCP client config file',
    },
    topLevelKey: 'mcpServers',
    postInstall: "Refer to your client's docs for how to reload MCP config.",
  },
};

export interface RemoteEntry {
  /** Server entry to place under the client's top-level key. */
  entry: Record<string, unknown>;
  /** Client-specific guidance lines (alternatives, CLI equivalents). */
  notes: string[];
  /** Client-specific post-install guidance, replacing the generic note. */
  postInstall: string;
}

const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** POSIX single-quote a shell argument when it needs quoting. */
function shellQuote(value: string): string {
  return SHELL_SAFE.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Env var names used to pass header values to mcp-remote, de-duplicated. */
function headerEnvNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const base = `MCP_HEADER_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    let candidate = base;
    for (let i = 2; used.has(candidate); i++) candidate = `${base}_${i}`;
    used.add(candidate);
    return candidate;
  });
}

/**
 * Build the client-specific config entry for a remote MCP endpoint. `headers`
 * are the rendered values from `planRemoteHeaders().headers`.
 */
export function buildRemoteServerEntry(
  client: ClientType,
  serverKey: string,
  url: string,
  transport: RemoteTransport,
  headers: Record<string, string>,
): RemoteEntry {
  const headerEntries = Object.entries(headers);
  const withHeaders = (entry: Record<string, unknown>) =>
    headerEntries.length ? { ...entry, headers } : entry;
  const postInstall = CLIENTS[client].postInstall;

  switch (client) {
    case 'claude-desktop': {
      const envNames = headerEnvNames(headerEntries.map(([name]) => name));
      const entry: Record<string, unknown> = {
        command: 'npx',
        args: ['-y', 'mcp-remote', url,
          // mcp-remote refuses plain-HTTP endpoints without this flag.
          ...(url.startsWith('http:') ? ['--allow-http'] : []),
          ...headerEntries.flatMap(([name], i) => ['--header', `${name}:\${${envNames[i]}}`])],
      };
      if (headerEntries.length) {
        entry.env = Object.fromEntries(headerEntries.map(([, value], i) => [envNames[i], value]));
      }
      return {
        entry,
        notes: [
          'Claude Desktop\'s config file runs only local (stdio) servers, so this entry bridges to the remote endpoint through mcp-remote (requires Node.js).',
          headerEntries.length
            ? `Alternative: Settings → Connectors → Add custom connector with the URL ${url}. Custom connectors cannot send custom HTTP headers, so this only works if the server also supports OAuth sign-in without the required headers.`
            : `Alternative (recommended when no headers are needed): Settings → Connectors → Add custom connector with the URL ${url}; Claude handles any OAuth sign-in.`,
        ],
        postInstall: [
          headerEntries.length ? 'Replace placeholder values in `env` first.' : null,
          'Restart Claude Desktop to activate the new server.',
          'If the server uses OAuth (not known from registry metadata), mcp-remote opens a browser to sign in on first start and caches tokens in ~/.mcp-auth.',
        ].filter(Boolean).join(' '),
      };
    }
    case 'claude-code': {
      const command = ['claude', 'mcp', 'add', '--transport', transport, shellQuote(serverKey), shellQuote(url),
        ...headerEntries.flatMap(([name, value]) => ['--header', shellQuote(`${name}: ${value}`)])].join(' ');
      return {
        entry: withHeaders({ type: transport, url }),
        notes: [`Or add it with the CLI:\n\n\`\`\`sh\n${command}\n\`\`\``],
        postInstall: `${postInstall} If the server uses OAuth, run /mcp inside Claude Code to authenticate.`,
      };
    }
    case 'windsurf':
      return { entry: withHeaders({ serverUrl: url }), notes: [], postInstall };
    case 'cline':
      return {
        entry: withHeaders({ type: transport === 'sse' ? 'sse' : 'streamableHttp', url }),
        notes: [],
        postInstall,
      };
    case 'vscode':
      return { entry: withHeaders({ type: transport, url }), notes: [], postInstall };
    case 'cursor':
    case 'generic':
      return { entry: withHeaders({ url }), notes: [], postInstall };
  }
}
