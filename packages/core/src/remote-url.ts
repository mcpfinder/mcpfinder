/**
 * Remote MCP endpoints on hosts that are known to be retired.
 *
 * Smithery's MCP proxy, API and hosted server URLs stop working on 2026-10-31
 * (https://smithery.ai/future): `server.smithery.ai/*`, `*.run.tools` and the
 * `registry.smithery.ai/servers/*` pages MCPfinder used to link stop working.
 * Official Registry and Glama entries can still advertise those URLs until
 * their publishers update them, so they are dropped at ingest instead of being
 * offered as an install target. A row whose only remote was retired keeps its
 * repository and package data and simply has no remote (`has_remote = 0`).
 */
const RETIRED_REMOTE_HOSTS = ['smithery.ai', 'run.tools'];

function isRetiredHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return RETIRED_REMOTE_HOSTS.some((retired) => host === retired || host.endsWith(`.${retired}`));
}

/**
 * True for a directory listing page rather than an MCP endpoint.
 *
 * Glama's API returns `url: https://glama.ai/mcp/servers/<id>` for every
 * server: the HTML page of that server in Glama's directory. MCPfinder used to
 * store it as `remote_url`, which marked ~75k servers as remote and handed the
 * page out as an MCP URL. It is a listing link (`listing_url`), never a remote.
 */
export function isDirectoryListingUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  return (host === 'glama.ai' || host === 'www.glama.ai') &&
    parsed.pathname.toLowerCase().startsWith('/mcp/servers/');
}

/**
 * The URL itself, or null when it is empty, unparsable, on a retired host, or
 * a directory listing page (see isDirectoryListingUrl).
 */
export function usableRemoteUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (isRetiredHost(parsed.hostname) || isDirectoryListingUrl(url)) return null;
  return url;
}

/** An http(s) listing/directory page URL worth keeping as `listing_url`, or null. */
export function listingUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return isRetiredHost(parsed.hostname) ? null : url;
  } catch {
    return null;
  }
}

/**
 * Comparison key for a remote URL: scheme-insensitive, lowercase host, no
 * default port, no trailing slash. Path and query stay significant (and
 * case-sensitive). Null for anything that is not an http(s) URL or that
 * carries credentials.
 */
export function normalizeRemoteUrlKey(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  // Credentials in the URL identify different accounts on one host: no key.
  if (parsed.username || parsed.password) return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  // URL already drops the scheme's own default port (https:443, http:80); any
  // other explicit port is significant.
  const port = parsed.port ? `:${parsed.port}` : '';
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${host}${port}${path}${parsed.search}`;
}

/** First usable `remotes[].url` of an Official Registry entry, or null. */
export function firstUsableRemoteUrl(remotes: unknown): string | null {
  if (!Array.isArray(remotes)) return null;
  for (const remote of remotes) {
    if (!remote || typeof remote !== 'object') continue;
    const url = usableRemoteUrl((remote as { url?: unknown }).url);
    if (url) return url;
  }
  return null;
}
