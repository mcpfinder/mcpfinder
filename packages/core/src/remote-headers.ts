/** Registry request headers belong to a remote endpoint, never to `env`. */
import type { McpServer, RegistryRemoteHeader, RegistryRemoteHeaderVariable } from './types.js';
import { looksLikeCredentialName } from './credential-hint.js';
import { parseRawEnvelope, rawPayloadForSource } from './raw-envelope.js';

type RemoteRow = Pick<McpServer, 'raw_data' | 'source' | 'remote_url'>;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const TEMPLATE = /\{([^{}]+)\}/g;
const PUBLIC_SCHEME = /^(?:Bearer|Basic|Token)$/i;
const SIMPLE_AUTH = /^(Bearer|Basic|Token)\s+\{[^{}]+\}$/i;
const VARIABLE_AUTH = /^\{scheme\}\s+\{[^{}]+\}$/i;

function scalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Exact Official endpoint; null means metadata cannot be verified. */
export function selectedRemoteHeaderDeclarations(row: RemoteRow): unknown[] | null {
  if (!row.remote_url) return null;
  const envelope = parseRawEnvelope(row.raw_data, row.source);
  const payload = envelope ? rawPayloadForSource(envelope, 'official') : null;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const server = (payload as Record<string, unknown>).server;
  if (!server || typeof server !== 'object' || Array.isArray(server)) return null;
  const remotes = (server as Record<string, unknown>).remotes;
  if (!Array.isArray(remotes)) return null;
  // A row's URL may come from another registry. Never borrow credentials from
  // a nearby Official endpoint with a different URL.
  const selected = remotes.find((remote) => remote && typeof remote === 'object' &&
    !Array.isArray(remote) && (remote as Record<string, unknown>).url === row.remote_url);
  if (!selected) return null;
  const headers = (selected as Record<string, unknown>).headers;
  if (headers === undefined) return [];
  return Array.isArray(headers) && headers.every((item) => header(item) !== null) ? headers : null;
}

function variable(raw: unknown, parentSecret: boolean, name: string): RegistryRemoteHeaderVariable | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  if ((data.isRequired !== undefined && typeof data.isRequired !== 'boolean') ||
      (data.isSecret !== undefined && typeof data.isSecret !== 'boolean')) return null;
  const result: RegistryRemoteHeaderVariable = {};
  if (typeof data.description === 'string') result.description = data.description;
  if (data.isRequired === true) result.isRequired = true;
  if (data.isSecret === true) result.isSecret = true;
  if (data.isSecret !== true && !parentSecret) {
    if (typeof data.value === 'string') result.value = data.value;
    if (scalar(data.default) !== undefined) result.default = scalar(data.default);
    if (typeof data.placeholder === 'string') result.placeholder = data.placeholder;
  } else if (data.isSecret !== true && name.toLowerCase() === 'scheme') {
    // A secret header can still publish its non-secret authentication scheme.
    if (typeof data.value === 'string' && PUBLIC_SCHEME.test(data.value)) result.value = data.value;
    if (typeof data.default === 'string' && PUBLIC_SCHEME.test(data.default)) result.default = data.default;
  }
  return result;
}

function publishedScheme(value: string, variables: Record<string, RegistryRemoteHeaderVariable>): string | null {
  const direct = SIMPLE_AUTH.exec(value);
  if (direct) return direct[1];
  if (!VARIABLE_AUTH.test(value)) return null;
  const scheme = variables.scheme;
  const candidate = scheme?.value ?? scheme?.default;
  return typeof candidate === 'string' && PUBLIC_SCHEME.test(candidate) ? candidate : null;
}

function header(raw: unknown): RegistryRemoteHeader | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.name !== 'string' || !HEADER_NAME.test(data.name)) return null;
  if ((data.isRequired !== undefined && typeof data.isRequired !== 'boolean') ||
      (data.isSecret !== undefined && typeof data.isSecret !== 'boolean')) return null;
  const result: RegistryRemoteHeader = { name: data.name };
  if (typeof data.description === 'string') result.description = data.description;
  if (data.isRequired === true) result.isRequired = true;
  if (data.isSecret === true) result.isSecret = true;
  const referencesSecret = typeof data.value === 'string' && data.variables &&
    typeof data.variables === 'object' && !Array.isArray(data.variables) &&
    Object.entries(data.variables as Record<string, unknown>).some(([name, rawVariable]) =>
      rawVariable && typeof rawVariable === 'object' &&
      (rawVariable as Record<string, unknown>).isSecret === true &&
      (data.value as string).includes(`{${name}}`));
  if (referencesSecret) result.isSecret = true;
  if (data.variables !== undefined) {
    if (!data.variables || typeof data.variables !== 'object' || Array.isArray(data.variables)) return null;
    const vars: Record<string, RegistryRemoteHeaderVariable> = {};
    for (const [name, rawVariable] of Object.entries(data.variables)) {
      const parsed = variable(rawVariable, result.isSecret === true, name);
      if (!parsed) return null;
      vars[name] = parsed;
    }
    result.variables = vars;
  }
  if (typeof data.value === 'string') {
    if (result.isSecret !== true) result.value = data.value;
    else if (/^(?:Bearer|Basic|Token) <YOUR_VALUE>$/i.test(data.value)) result.value = data.value;
    else {
      const scheme = publishedScheme(data.value, result.variables ?? {});
      if (scheme) result.value = `${scheme} <YOUR_VALUE>`;
      else result.description = [result.description, 'Supply the complete HTTP header value in the provider-required format.']
        .filter(Boolean).join(' ');
    }
  }
  if (result.isSecret !== true && scalar(data.default) !== undefined) result.default = scalar(data.default);
  if (result.isSecret !== true && typeof data.placeholder === 'string') result.placeholder = data.placeholder;
  return result;
}

/** Read sanitized Official headers, preserving unavailable metadata as unknown. */
export function remoteHeadersForRow(row: RemoteRow): { headers: RegistryRemoteHeader[]; known: boolean } {
  const declarations = selectedRemoteHeaderDeclarations(row);
  if (!declarations) return { headers: [], known: false };
  const headers: RegistryRemoteHeader[] = [];
  for (const declaration of declarations) {
    const parsed = header(declaration);
    if (!parsed) return { headers: [], known: false };
    headers.push(parsed);
  }
  return { headers, known: true };
}

export interface RemoteHeaderPlan {
  headers: Record<string, string>;
  requiredHeaders: RegistryRemoteHeader[];
  optionalHeaders: RegistryRemoteHeader[];
  requiredSecretHeaders: RegistryRemoteHeader[];
  possibleUnlabeledSecrets: string[];
  known: boolean;
  requiresUserSecrets: boolean | null;
  requiredSecretCount: number | null;
  safeToAutoinstall: boolean;
}

/** Render only required headers. An absent `isRequired` defaults to false. */
export function planRemoteHeaders(allHeaders: RegistryRemoteHeader[], known = true): RemoteHeaderPlan {
  // The public planner may receive raw registry objects directly. Sanitize
  // every returned declaration, not only the rendered config values.
  const validHeaders = allHeaders.map(header).filter((h): h is RegistryRemoteHeader => h !== null);
  known = known && validHeaders.length === allHeaders.length;
  const requiredHeaders = validHeaders.filter((h) => h.isRequired === true);
  const optionalHeaders = validHeaders.filter((h) => h.isRequired !== true);
  const requiredSecretHeaders: RegistryRemoteHeader[] = [];
  const possibleUnlabeledSecrets: string[] = [];
  const entries: Array<[string, string]> = [];
  let safeToAutoinstall = known;
  for (const h of requiredHeaders) {
    const secret = h.isSecret === true;
    let unresolved = false;
    let value: string;
    if (secret) {
      value = h.value ?? '<YOUR_VALUE>';
      unresolved = true;
    } else if (typeof h.value === 'string') {
      value = h.value.replace(TEMPLATE, (match, name: string) => {
        const variable = h.variables?.[name];
        if (!variable) { unresolved = true; return match; }
        if (typeof variable.value === 'string') return variable.value;
        if (scalar(variable.default) !== undefined) return String(variable.default);
        unresolved = true;
        return '<VALUE>';
      });
    } else if (scalar(h.default) !== undefined) {
      value = String(h.default);
    } else {
      value = '<VALUE>';
      unresolved = true;
    }
    if (secret) requiredSecretHeaders.push(h);
    else if (['authorization', 'proxy-authorization', 'cookie', 'x-auth'].includes(h.name.toLowerCase()) ||
      looksLikeCredentialName(h.name) ||
      [...(h.value ?? '').matchAll(TEMPLATE)].some((match) => looksLikeCredentialName(match[1]))) {
      possibleUnlabeledSecrets.push(h.name);
    }
    if (secret || unresolved || possibleUnlabeledSecrets.includes(h.name)) safeToAutoinstall = false;
    entries.push([h.name, value]);
  }
  return {
    headers: Object.fromEntries(entries), requiredHeaders, optionalHeaders,
    requiredSecretHeaders, possibleUnlabeledSecrets, known,
    requiresUserSecrets: known ? requiredSecretHeaders.length > 0 : null,
    requiredSecretCount: known ? requiredSecretHeaders.length : null,
    safeToAutoinstall,
  };
}
