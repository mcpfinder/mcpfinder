/**
 * Conservative name-based credential hint for environment variables.
 *
 * Registry `isSecret` is only ever present-and-true or absent; absence means
 * "unlabelled", not "not a secret". This heuristic flags names that very
 * likely hold a credential so callers can add an advisory. It is advisory
 * only: it must never change a generated config value (masking stays driven
 * by `isSecret` alone). Precision over recall.
 */

/** Single tokens that on their own denote a credential value. */
const CREDENTIAL_TOKENS = new Set([
  'APIKEY',
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'PASSPHRASE',
  'MNEMONIC',
  'MACAROON',
  'CREDENTIAL',
  'CREDENTIALS',
]);

/** Adjacent token pairs that denote a credential value (`X_KEY`). */
const CREDENTIAL_PAIRS = new Set(['API KEY', 'PRIVATE KEY', 'ACCESS KEY', 'SECRET KEY']);

/**
 * Qualifiers that, after the credential token, show the variable describes
 * the credential (where it lives, how long it lasts, ...) rather than holds it.
 */
const QUALIFIER_TOKENS = new Set([
  'URL',
  'URI',
  'ENDPOINT',
  'PATH',
  'FILE',
  'DIR',
  'BUDGET',
  'LIMIT',
  'TTL',
  'SECONDS',
  'MS',
  'LEEWAY',
  'ENV',
  'NAME',
  'HEADER',
  'TYPE',
  'COUNT',
  'ENABLED',
  'ID',
  'ARN',
  'EXPIRY',
  'EXPIRES',
  'EXPIRATION',
  'INTERVAL',
  'LENGTH',
  'MIN',
  'MAX',
  'TIMEOUT',
  'PREFIX',
  'FORMAT',
]);

/**
 * `*_APPLICATION_CREDENTIALS` (e.g. `GOOGLE_APPLICATION_CREDENTIALS`) is by
 * convention a path to a credentials file, not the credential itself.
 */
const PATH_LIKE_SUFFIX = ['APPLICATION', 'CREDENTIALS'];

/**
 * True when an env var name very likely holds a credential, e.g.
 * `GITHUB_TOKEN`, `OPENAI_API_KEY`, `DB_PASSWORD`; false for names like
 * `TOKEN_URL`, `PRIVATE_KEY_FILE`, `TURNSTILE_SITE_KEY`, `AWS_ACCESS_KEY_ID`,
 * `SECRET_ARN`, `TOKEN_EXPIRY`, `GOOGLE_APPLICATION_CREDENTIALS` or `PUBLIC_*`.
 * Tokens are split on `_` / `-`, case-insensitively.
 */
export function looksLikeCredentialName(name: string): boolean {
  const tokens = name.toUpperCase().split(/[_-]+/).filter(Boolean);
  if (tokens.includes('PUBLIC')) return false;
  const n = tokens.length;
  if (n >= 2 && tokens[n - 2] === PATH_LIKE_SUFFIX[0] && tokens[n - 1] === PATH_LIKE_SUFFIX[1]) {
    return false;
  }

  let first = -1;
  for (let i = 0; i < tokens.length && first < 0; i++) {
    if (CREDENTIAL_TOKENS.has(tokens[i])) first = i;
    else if (i > 0 && CREDENTIAL_PAIRS.has(`${tokens[i - 1]} ${tokens[i]}`)) first = i;
  }
  if (first < 0) return false;

  return !tokens.slice(first + 1).some((token) => QUALIFIER_TOKENS.has(token));
}

/** Names of env vars that look like credentials but are not marked `isSecret`. */
export function possibleUnlabeledSecrets(
  envVars: Array<{ name: string; isSecret?: boolean }>,
): string[] {
  return envVars.filter((v) => !v.isSecret && looksLikeCredentialName(v.name)).map((v) => v.name);
}
