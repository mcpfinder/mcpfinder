import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const dir = mkdtempSync(join(tmpdir(), 'mcpf-install-config-'));
process.env.MCPFINDER_DATA_DIR = dir;
const originalGlamaKey = process.env.GLAMA_API_KEY;

const {
  buildEnvPlaceholders,
  envPlaceholderValue,
  getInstallCommand,
  looksLikeCredentialName,
  possibleUnlabeledSecrets,
  initDatabase,
  syncGlamaRegistry,
} = await import('../packages/core/dist/index.js');

/**
 * Drive the built MCP server as a real stdio process and return the
 * `structuredContent` of one `get_install_config` call. Speaks raw
 * newline-delimited JSON-RPC so the test needs no client SDK on the root
 * package's resolution path.
 */
async function callInstallConfigTool(dataDir, serverName, toolName = 'get_install_config') {
  const child = spawn(process.execPath, [resolve('.', 'packages/mcp-server/dist/cli.js')], {
    env: {
      ...process.env,
      MCPFINDER_DATA_DIR: dataDir,
      MCPFINDER_DISABLE_SNAPSHOT: '1',
      GLAMA_API_KEY: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const resolveResponse = pending.get(message.id);
    if (resolveResponse) {
      pending.delete(message.id);
      resolveResponse(message);
    }
  });
  const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);
  const request = (id, method, params) =>
    new Promise((resolvePending, rejectPending) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectPending(new Error(`mcp-server did not answer ${method} in time`));
      }, 30_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) rejectPending(new Error(`${method}: ${message.error.message}`));
        else resolvePending(message.result);
      });
      send({ jsonrpc: '2.0', id, method, params });
    });

  try {
    await request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mcpfinder-tests', version: '0.0.0' },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const result = await request(2, 'tools/call', {
      name: toolName,
      arguments:
        toolName === 'get_install_config'
          ? { name: serverName, platform: 'claude-desktop' }
          : { name: serverName },
    });
    // Attach the human-readable text so prose advisories can be asserted too.
    return { ...result.structuredContent, _text: result.content?.[0]?.text ?? '' };
  } finally {
    lines.close();
    child.stdin.end();
    child.kill();
  }
}

const insert = (db, overrides) => {
  db.prepare(`
    INSERT INTO servers (
      id, slug, name, description, version, registry_type, package_identifier,
      transport_type, repository_url, repository_source, published_at, updated_at,
      status, popularity_score, categories, keywords, remote_url, has_remote,
      last_synced_at, sources, raw_data, env_vars, source, use_count, verified, icon_url
    ) VALUES (
      @id, @slug, @name, @description, @version, @registry_type, @package_identifier,
      @transport_type, @repository_url, @repository_source, @published_at, @updated_at,
      @status, @popularity_score, @categories, @keywords, @remote_url, @has_remote,
      @last_synced_at, @sources, @raw_data, @env_vars, @source, @use_count, @verified, @icon_url
    )
  `).run({
    id: overrides.id ?? overrides.name,
    slug: overrides.slug,
    name: overrides.name,
    description: 'test server',
    version: '1.0.0',
    registry_type: overrides.registry_type,
    package_identifier: overrides.package_identifier,
    transport_type: 'stdio',
    repository_url: overrides.repository_url ?? null,
    repository_source: overrides.repository_source ?? null,
    published_at: null,
    updated_at: null,
    status: 'active',
    popularity_score: 0,
    categories: '[]',
    keywords: '[]',
    remote_url: null,
    has_remote: 0,
    last_synced_at: new Date().toISOString(),
    sources: JSON.stringify(overrides.sources ?? ['official']),
    raw_data: JSON.stringify(overrides.raw_data ?? {}),
    env_vars: JSON.stringify(overrides.env_vars),
    source: overrides.source ?? 'official',
    use_count: 0,
    verified: 0,
    icon_url: null,
  });
};

// Registry env vars carry prose descriptions for humans and, sometimes, a
// concrete value. Only the concrete value belongs in the generated `env` block
// (GitHub issue #10) — a description there is a syntactically valid but
// semantically wrong config.
const envVars = [
  { name: 'API_URL', description: 'Base URL. Defaults to production.', default: 'https://api.example.com' },
  { name: 'REGION', description: 'Deployment region.', placeholder: 'us-east-1' },
  { name: 'PROFILE', description: 'Named profile to use.' },
  { name: 'API_KEY', description: 'Your API key.', isSecret: true, default: 'never-use-this' },
  { name: 'PREFIX', description: 'Path prefix.', default: '' },
  { name: 'PORT', description: 'Port to bind.', default: 8080 },
  { name: 'DEBUG', description: 'Verbose logging.', default: false },
  { name: 'OPTIONS', description: 'Structured options.', default: { a: 1 } },
  // Credential-looking but unlabelled (GitHub issue #23): advisory only.
  { name: 'FOO_API_KEY', description: 'Foo key.' },
];

const expectedEnv = {
  API_URL: 'https://api.example.com',   // (a) default wins over description
  REGION: 'us-east-1',                  // (b) placeholder when there is no default
  PROFILE: '<VALUE>',                   // (c) neither — never the description
  API_KEY: '<YOUR_VALUE>',              // (d) secrets ignore their default
  PREFIX: '',                           // (e) empty default is a real value
  PORT: '8080',                         // non-string scalars become strings
  DEBUG: 'false',
  OPTIONS: '<VALUE>',                   // non-scalars never reach the config
  FOO_API_KEY: '<VALUE>',               // name heuristic never changes masking
};

// Unit level: the helper both install.ts paths and the MCP server share.
assert.deepEqual(buildEnvPlaceholders(envVars), expectedEnv);
assert.equal(envPlaceholderValue({ name: 'X', description: 'prose' }), '<VALUE>');
assert.equal(envPlaceholderValue({ name: 'X', isSecret: true }), '<YOUR_VALUE>');
assert.equal(envPlaceholderValue({ name: 'FOO_API_KEY' }), '<VALUE>');

// Credential-name heuristic (GitHub issue #23): precision over recall.
for (const name of [
  'GITHUB_TOKEN', 'OPENAI_API_KEY', 'STRIPE_SECRET_KEY', 'DB_PASSWORD', 'GOOGLE_CLIENT_SECRET',
  'WALLET_MNEMONIC', 'LND_MACAROON', 'AWS_SECRET_ACCESS_KEY', 'SLACK_BOT_TOKEN', 'openai-apikey',
  'REFRESH_TOKEN',
]) {
  assert.equal(looksLikeCredentialName(name), true, `${name} should look like a credential`);
}
for (const name of [
  'AUTOMOX_MCP_TOKEN_BUDGET', 'SHOPIFY_TOKEN_LEEWAY_SECONDS', 'GOOGLE_MERCHANTS_TOKEN_URL',
  'NG_TOKEN_SAVER_IDLE_MS', 'TURNSTILE_SITE_KEY', 'PUBLISHER_PUBLIC_URL', 'GOBOX_CLIENT_ID',
  'AGENTMEMORY_UTCP_AUTH_ENV', 'ASPOSE_WORDS_LICENSE_PATH', 'ROOT_PATH', 'LOG_LEVEL',
  'SSH_PRIVATE_KEY_FILE', 'STRIPE_PUBLIC_KEY', 'AWS_ACCESS_KEY_ID', 'SECRET_ID', 'SECRET_ARN',
  'TOKEN_EXPIRY', 'TOKEN_REFRESH_INTERVAL', 'PASSWORD_MIN_LENGTH', 'GOOGLE_APPLICATION_CREDENTIALS',
]) {
  assert.equal(looksLikeCredentialName(name), false, `${name} should not look like a credential`);
}
assert.deepEqual(possibleUnlabeledSecrets(envVars), ['FOO_API_KEY']);

// npm (npx) and pypi (uvx) install paths.
const db = initDatabase(join(dir, 'install-config.sqlite'));
insert(db, {
  name: 'io.example/npm-server',
  slug: 'npm-server',
  registry_type: 'npm',
  package_identifier: '@example/npm-server',
  env_vars: envVars,
});
insert(db, {
  name: 'io.example/pypi-server',
  slug: 'pypi-server',
  registry_type: 'pypi',
  package_identifier: 'example-pypi-server',
  env_vars: envVars,
});

for (const [slug, command] of [['npm-server', 'npx'], ['pypi-server', 'uvx']]) {
  const result = getInstallCommand(db, slug, 'claude-desktop');
  const serverConfig = result.config.mcpServers[slug];
  assert.equal(serverConfig.command, command);
  assert.deepEqual(serverConfig.env, expectedEnv, `${command} config env`);
  for (const v of envVars) {
    if (!v.description) continue;
    assert.ok(
      !JSON.stringify(serverConfig).includes(v.description),
      `${command} config must not embed the description of ${v.name}`,
    );
  }
  // The descriptions still reach the user as prose next to the snippet.
  assert.ok(result.envVarsNeeded.some((v) => v.description === 'Base URL. Defaults to production.'));
}

// The OCI path was already correct and stays untouched.
insert(db, {
  name: 'io.example/oci-server',
  slug: 'oci-server',
  registry_type: 'oci',
  package_identifier: 'example/oci-server',
  env_vars: envVars,
});
assert.deepEqual(
  getInstallCommand(db, 'oci-server', 'claude-desktop').config.mcpServers['oci-server'].args,
  ['run', '-i', ...envVars.flatMap((v) => ['-e', `${v.name}=<YOUR_VALUE>`]), 'example/oci-server'],
);
db.close();

// The MCP server path: assert the config it actually emits, not the source
// text that produces it. The server is spawned as a real stdio MCP process
// over a seeded database, with snapshot bootstrap disabled and a fresh
// sync_log so no tool call reaches the network.
const serverDir = join(dir, 'mcp-server-home');
mkdirSync(serverDir, { recursive: true });
const serverDb = initDatabase(join(serverDir, 'data.db'));
insert(serverDb, {
  name: 'io.example/npm-server',
  slug: 'npm-server',
  registry_type: 'npm',
  package_identifier: '@example/npm-server',
  env_vars: envVars,
});
// No registry type and no remote: get_install_config takes the
// non-auto-installable fallback branch.
insert(serverDb, {
  name: 'io.example/manual-server',
  slug: 'manual-server',
  registry_type: null,
  package_identifier: null,
  env_vars: envVars,
});
serverDb.prepare(
  `INSERT INTO sync_log (source, last_synced_at, last_successful_at, server_count, status)
   VALUES ('official', ?, ?, 1, 'ok')`,
).run(new Date().toISOString(), new Date().toISOString());
serverDb.close();

const installResult = await callInstallConfigTool(serverDir, 'npm-server');
assert.equal(installResult.installType, 'npm');
assert.deepEqual(
  installResult.config.mcpServers['npm-server'].env,
  expectedEnv,
  'mcp-server must emit the shared helper\'s env values',
);
assert.equal(installResult.requires_user_secrets, true, 'the secret must still be flagged');
assert.deepEqual(installResult.possible_unlabeled_secrets, ['FOO_API_KEY']);
const advisory = 'looks like a credential (not marked secret by the registry)';
const advisoryLines = installResult._text.split('\n').filter((line) => line.includes(advisory));
assert.equal(advisoryLines.length, 1, 'advisory only for unlabelled credential-like names');
assert.ok(advisoryLines[0].includes('`FOO_API_KEY`'));

const detailsResult = await callInstallConfigTool(serverDir, 'npm-server', 'get_server_details');
const detailAdvisoryLines = detailsResult._text.split('\n').filter((line) => line.includes(advisory));
assert.equal(detailAdvisoryLines.length, 1, 'details: advisory only for unlabelled credential-like names');
assert.ok(detailAdvisoryLines[0].includes('`FOO_API_KEY`'));
assert.ok(!detailAdvisoryLines[0].includes('`API_KEY`'), 'isSecret vars get no advisory');

const fallbackResult = await callInstallConfigTool(serverDir, 'manual-server');
assert.equal(fallbackResult.autoInstallable, false, 'manual-server should hit the fallback branch');
assert.deepEqual(fallbackResult.possible_unlabeled_secrets, ['FOO_API_KEY']);
const fallbackAdvisoryLines = fallbackResult._text.split('\n').filter((line) => line.includes(advisory));
assert.equal(fallbackAdvisoryLines.length, 1, 'fallback: advisory only for unlabelled credential-like names');
assert.ok(fallbackAdvisoryLines[0].includes('`FOO_API_KEY`'));
for (const v of envVars) {
  if (!v.description) continue;
  assert.ok(
    !JSON.stringify(installResult.config).includes(v.description),
    `mcp-server config must not embed the description of ${v.name}`,
  );
}

// Glama entries carry their env vars in a JSON schema — keep the fields the
// config generator needs instead of only name/description.
process.env.GLAMA_API_KEY = 'test-key';

const glamaEntry = (repositoryUrl = null) => ({
  id: 'env-schema',
  name: 'env-schema',
  namespace: '',
  slug: 'env-schema',
  description: 'glama server with an env schema',
  repository: repositoryUrl ? { url: repositoryUrl } : null,
  spdxLicense: null,
  tools: [],
  url: null,
  environmentVariablesJsonSchema: {
    type: 'object',
    required: ['API_URL'],
    properties: {
      API_URL: {
        type: 'string',
        description: 'Base URL. Defaults to production.',
        default: 'https://api.example.com',
        format: 'uri',
      },
      API_KEY: { type: 'string', description: 'Your API key.', writeOnly: true },
      PROFILE: { type: 'string', description: 'Named profile to use.' },
    },
  },
  attributes: {},
});

const runGlamaSync = (database, entry) =>
  syncGlamaRegistry(database, {
    now: () => 0,
    sleep: async () => {},
    fetchImpl: async () => Response.json({
      servers: [entry],
      pageInfo: { hasNextPage: false, endCursor: null },
    }),
  });

const glamaSchemaEnvVars = [
  {
    name: 'API_URL',
    description: 'Base URL. Defaults to production.',
    format: 'uri',
    default: 'https://api.example.com',
    isRequired: true,
  },
  { name: 'API_KEY', description: 'Your API key.', isSecret: true },
  { name: 'PROFILE', description: 'Named profile to use.' },
];

const envVarsOf = (database, id) =>
  JSON.parse(database.prepare('SELECT env_vars FROM servers WHERE id = ?').get(id).env_vars);

// Fresh single-source insert.
const glamaDb = initDatabase(join(dir, 'glama-env-vars.sqlite'));
await runGlamaSync(glamaDb, glamaEntry());

assert.deepEqual(envVarsOf(glamaDb, 'glama:env-schema'), glamaSchemaEnvVars);
assert.deepEqual(buildEnvPlaceholders(envVarsOf(glamaDb, 'glama:env-schema')), {
  API_URL: 'https://api.example.com',
  API_KEY: '<YOUR_VALUE>',
  PROFILE: '<VALUE>',
});
glamaDb.close();

// (a) A Glama entry that deduplicates onto an existing Official row goes
// through the merge path, which rebuilds env vars from the stored raw
// payloads. That rebuild used to keep only name/description, silently undoing
// issue #10 and unmasking secrets for every merged server.
const repoUrl = 'https://github.com/example/env-schema';
const officialEnvVars = [{ name: 'LEGACY_VAR', description: 'Official-only variable.' }];
const mergeDb = initDatabase(join(dir, 'glama-merge.sqlite'));
insert(mergeDb, {
  name: 'io.example/env-schema',
  slug: 'env-schema',
  registry_type: 'npm',
  package_identifier: '@example/env-schema',
  repository_url: repoUrl,
  repository_source: 'github',
  env_vars: officialEnvVars,
  raw_data: {
    server: {
      name: 'io.example/env-schema',
      description: 'official row for the same server',
      version: '1.0.0',
      repository: { url: repoUrl, source: 'github' },
      packages: [{
        registryType: 'npm',
        identifier: '@example/env-schema',
        transport: { type: 'stdio' },
        environmentVariables: officialEnvVars,
      }],
    },
  },
});

await runGlamaSync(mergeDb, glamaEntry(repoUrl));

assert.equal(
  mergeDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count,
  1,
  'the Glama entry must deduplicate onto the Official row',
);
const mergedRow = mergeDb.prepare('SELECT sources, env_vars FROM servers').get();
assert.deepEqual(JSON.parse(mergedRow.sources), ['glama', 'official']);
assert.deepEqual(
  JSON.parse(mergedRow.env_vars),
  [...officialEnvVars, ...glamaSchemaEnvVars],
  'a merged row must keep default/format/isSecret/isRequired from the Glama schema',
);

// (c) …and the config generated for the merged row still offers the concrete
// default and masks the writeOnly credential.
assert.deepEqual(
  getInstallCommand(mergeDb, 'env-schema', 'claude-desktop').config.mcpServers['env-schema'].env,
  {
    LEGACY_VAR: '<VALUE>',
    API_URL: 'https://api.example.com',
    API_KEY: '<YOUR_VALUE>',
    PROFILE: '<VALUE>',
  },
);
mergeDb.close();

// (b) Refreshing an already multi-source row (Glama primary, Smithery merged
// in earlier) takes the same rebuild path and must not degrade the fields.
const refreshDb = initDatabase(join(dir, 'glama-refresh.sqlite'));
insert(refreshDb, {
  id: 'glama:env-schema',
  name: 'env-schema',
  slug: 'env-schema',
  registry_type: null,
  package_identifier: null,
  source: 'glama',
  sources: ['glama', 'smithery'],
  env_vars: glamaSchemaEnvVars,
  raw_data: {
    primarySource: 'glama',
    primary: glamaEntry(),
    bySource: {
      smithery: {
        qualifiedName: 'example/env-schema',
        displayName: 'env-schema',
        description: 'smithery view of the same server',
        useCount: 5,
        verified: true,
        remote: false,
        isDeployed: false,
        iconUrl: null,
        homepage: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    },
  },
});

await runGlamaSync(refreshDb, glamaEntry());

assert.deepEqual(
  envVarsOf(refreshDb, 'glama:env-schema'),
  glamaSchemaEnvVars,
  'refreshing a multi-source row must preserve the schema-derived fields',
);
assert.deepEqual(buildEnvPlaceholders(envVarsOf(refreshDb, 'glama:env-schema')), {
  API_URL: 'https://api.example.com',
  API_KEY: '<YOUR_VALUE>',
  PROFILE: '<VALUE>',
});
refreshDb.close();

if (originalGlamaKey === undefined) delete process.env.GLAMA_API_KEY;
else process.env.GLAMA_API_KEY = originalGlamaKey;
rmSync(dir, { recursive: true, force: true });

console.log('install config checks passed');
