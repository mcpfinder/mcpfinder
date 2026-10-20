/**
 * Remote MCP endpoints on hosts that are known to be retired.
 *
 * Smithery shut down its MCP proxy, API and hosted server URLs on 2026-10-31
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

/** The URL itself, or null when it is empty, unparsable, or on a retired host. */
export function usableRemoteUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  return isRetiredHost(parsed.hostname) ? null : url;
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
