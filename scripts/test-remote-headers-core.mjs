import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getInstallCommand, getServerDetails, initDatabase, searchServers,
  mergeSameRemoteOfficialEntries, planRemoteHeaders, buildRemoteServerEntry,
} from '../packages/core/dist/index.js';

const dir = mkdtempSync(join(tmpdir(), 'mcpf-remote-headers-core-'));
const db = initDatabase(join(dir, 'catalog.db'));

function insert(name, remotes, options = {}) {
  const official = { server: { name, remotes } };
  const raw = options.raw ?? official;
  db.prepare(`INSERT INTO servers
    (id, slug, name, description, remote_url, has_remote, sources, raw_data,
     source, env_vars, repository_url, registry_type, package_identifier)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(name, name.split('/').pop(), name, options.description ?? 'same endpoint',
      options.url ?? remotes?.[0]?.url ?? null, options.url || remotes?.[0]?.url ? 1 : 0,
      JSON.stringify(options.sources ?? ['official']), JSON.stringify(raw), options.source ?? 'official',
      JSON.stringify(options.env ?? []), options.repository ?? 'https://github.com/acme/mcp',
      options.registryType ?? null, options.packageIdentifier ?? null);
}

try {
  const optional = { name: 'Authorization', isSecret: true,
    description: 'Bearer <key>; omit for OAuth.' };
  insert('io.github.acme/oauth', [{ url: 'https://mcp.acme.test/mcp', headers: [optional] }], {
    env: [{ name: 'ARCMIRA_API_KEY', description: 'Optional OAuth alternative' }],
    raw: { primarySource: 'official', primary: {
      server: { name: 'io.github.acme/oauth', remotes: [
        { url: 'https://mcp.acme.test/mcp', headers: [optional] },
      ] },
    }, bySource: { glama: { environmentVariablesJsonSchema: { properties: {
      ARCMIRA_API_KEY: { type: 'string' },
    }, required: [] } } } },
    sources: ['official', 'glama'],
  });
  const oauth = getServerDetails(db, 'io.github.acme/oauth');
  assert.deepEqual(oauth.remoteHeaders, [optional]);
  assert.equal(oauth.remoteHeadersKnown, true);
  assert.equal(oauth.secretCount, 0);
  const oauthConfig = getInstallCommand(db, 'io.github.acme/oauth', 'cursor');
  assert.deepEqual(oauthConfig.config.mcpServers.oauth,
    { url: 'https://mcp.acme.test/mcp' });
  assert.deepEqual(oauthConfig.envVarsNeeded, []);
  assert.match(oauthConfig.instructions, /Optional HTTP header Authorization/);

  // A merged row may keep Glama as its primary payload, and older envelopes
  // may duplicate the primary in bySource. Both still expose Official headers.
  insert('io.github.acme/glama-primary', [{ url: 'https://merged.acme.test/mcp',
    headers: [optional] }], {
    raw: { primarySource: 'glama', primary: { name: 'Glama entry' }, bySource: {
      official: { server: { name: 'io.github.acme/glama-primary', remotes: [
        { url: 'https://merged.acme.test/mcp', headers: [optional] },
      ] } },
    } }, source: 'glama', sources: ['glama', 'official'],
  });
  assert.deepEqual(getServerDetails(db, 'io.github.acme/glama-primary').remoteHeaders, [optional]);
  insert('io.github.acme/legacy-envelope', [{ url: 'https://legacy-envelope.acme.test/mcp',
    headers: [optional] }], {
    raw: { primarySource: 'official', primary: { server: { name: 'old copy' } }, bySource: {
      official: { server: { name: 'io.github.acme/legacy-envelope', remotes: [
        { url: 'https://legacy-envelope.acme.test/mcp', headers: [optional] },
      ] } },
    } },
  });
  assert.deepEqual(getServerDetails(db, 'io.github.acme/legacy-envelope').remoteHeaders, [optional]);

  const nested = { name: 'Authorization', isRequired: true,
    value: 'Bearer {api_key}', variables: { api_key: {
      isSecret: true, default: 'actual-secret', placeholder: 'example-secret',
    } } };
  insert('io.github.acme/required', [
    { url: 'https://other.acme.test/mcp', headers: [optional] },
    { url: 'https://selected.acme.test/mcp', headers: [nested] },
  ], { url: 'https://selected.acme.test/mcp' });
  const required = getServerDetails(db, 'io.github.acme/required');
  assert.equal(required.remoteHeaders.length, 1);
  assert.equal(required.remoteHeaders[0].variables.api_key.default, undefined);
  assert.equal(required.secretCount, 1);
  const plan = planRemoteHeaders(required.remoteHeaders);
  assert.deepEqual(plan.headers, { Authorization: 'Bearer <YOUR_VALUE>' });
  assert.deepEqual(plan.requiredSecretHeaders.map((h) => h.name), ['Authorization']);
  assert.equal(plan.requiresUserSecrets, true);
  assert.equal(plan.safeToAutoinstall, false);
  assert.deepEqual(getInstallCommand(db, 'io.github.acme/required', 'cursor').config.mcpServers.required,
    { url: 'https://selected.acme.test/mcp', headers: { Authorization: 'Bearer <YOUR_VALUE>' } });

  const unknown = planRemoteHeaders([{ name: 'X-Scope', isRequired: true,
    value: 'scope={unknown}' }]);
  assert.deepEqual(unknown.headers, { 'X-Scope': 'scope={unknown}' });
  assert.equal(unknown.safeToAutoinstall, false);
  const fixed = planRemoteHeaders([{ name: 'X-Scope', isRequired: true, value: 'readonly' }]);
  assert.equal(fixed.safeToAutoinstall, true);
  assert.deepEqual(planRemoteHeaders([{ name: 'Authorization', isRequired: true, isSecret: true }]).headers,
    { Authorization: '<YOUR_VALUE>' });
  assert.deepEqual(planRemoteHeaders([{
    name: 'Authorization', isRequired: true, isSecret: true, value: 'published-secret',
  }]).headers, { Authorization: '<YOUR_VALUE>' });
  assert.deepEqual(planRemoteHeaders([{
    name: 'Authorization', isRequired: true, value: 'Bearer {token}',
    variables: { token: { isSecret: true, default: 'published-secret' } },
  }]).headers, { Authorization: 'Bearer <YOUR_VALUE>' });
  assert.deepEqual(planRemoteHeaders([{ name: 'Authorization', isSecret: true }]).headers, {});

  // A brace is not evidence that the surrounding literal is safe to publish.
  for (const exposed of ['private{credential}', 'sk-live-abcdef-{region}']) {
    const name = `io.github.acme/leak-${exposed.length}`;
    insert(name, [{ url: `https://leak-${exposed.length}.acme.test/mcp`, headers: [
      { name: 'Authorization', isRequired: true, isSecret: true, value: exposed,
        variables: { credential: { isSecret: true }, region: { isSecret: true } } },
    ] }]);
    const detail = getServerDetails(db, name);
    const config = getInstallCommand(db, name, 'cursor');
    assert.doesNotMatch(JSON.stringify(detail), /private\{|sk-live-abcdef/);
    assert.doesNotMatch(JSON.stringify(config), /private\{|sk-live-abcdef/);
    assert.equal(detail.secretCount, 1);
    assert.deepEqual(config.config.mcpServers[name.split('/').pop()].headers,
      { Authorization: '<YOUR_VALUE>' });
  }
  const unsafeNested = { name: 'Authorization', isRequired: true,
    value: 'sk-{token}', variables: { token: { isSecret: true, default: 'real-secret' } } };
  assert.deepEqual(planRemoteHeaders([unsafeNested]).headers, { Authorization: '<YOUR_VALUE>' });
  assert.equal(planRemoteHeaders([unsafeNested]).requiresUserSecrets, true);
  assert.doesNotMatch(JSON.stringify(planRemoteHeaders([unsafeNested])), /sk-\{token\}|real-secret/);
  assert.doesNotMatch(JSON.stringify(planRemoteHeaders([{
    name: 'Authorization', isRequired: true, isSecret: true, value: 'private{credential}',
  }])), /private\{credential\}/);
  insert('io.github.acme/unsafe-nested', [{ url: 'https://unsafe-nested.test/mcp', headers: [unsafeNested] }]);
  const unsafeDetail = getServerDetails(db, 'io.github.acme/unsafe-nested');
  assert.equal(unsafeDetail.remoteHeaders[0].value, undefined);
  assert.match(unsafeDetail.remoteHeaders[0].description, /complete HTTP header value/);
  assert.equal(unsafeDetail.secretCount, 1);
  assert.deepEqual(getInstallCommand(db, 'io.github.acme/unsafe-nested', 'cursor')
    .config.mcpServers['unsafe-nested'].headers, { Authorization: '<YOUR_VALUE>' });

  const schemeTemplate = { name: 'Authorization', isRequired: true, isSecret: true,
    value: '{scheme} {token}', variables: {
      scheme: { value: 'Bearer', default: 'private-secret', placeholder: 'private-example' },
      token: { isSecret: true, default: 'real-secret' },
    } };
  insert('io.github.acme/scheme', [{ url: 'https://scheme.test/mcp', headers: [schemeTemplate] }]);
  const schemeDetail = getServerDetails(db, 'io.github.acme/scheme');
  assert.equal(schemeDetail.remoteHeaders[0].variables.scheme.value, 'Bearer');
  assert.equal(schemeDetail.remoteHeaders[0].variables.scheme.default, undefined);
  assert.equal(schemeDetail.remoteHeaders[0].variables.scheme.placeholder, undefined);
  assert.deepEqual(getInstallCommand(db, 'io.github.acme/scheme', 'cursor')
    .config.mcpServers.scheme.headers, { Authorization: 'Bearer <YOUR_VALUE>' });
  const unmarkedToken = { name: 'Authorization', isRequired: true, isSecret: true,
    value: '{scheme} {token}', variables: {
      scheme: { default: 'Basic' }, token: { default: 'must-stay-hidden' },
    } };
  const unmarkedPlan = planRemoteHeaders([unmarkedToken]);
  assert.deepEqual(unmarkedPlan.headers, { Authorization: 'Basic <YOUR_VALUE>' });
  assert.doesNotMatch(JSON.stringify(unmarkedPlan), /must-stay-hidden/);
  for (const scheme of ['Basic', 'Token', 'bearer']) {
    const result = planRemoteHeaders([{ name: 'Authorization', isRequired: true, isSecret: true,
      value: `${scheme} {private-token}` }]);
    assert.deepEqual(result.headers, { Authorization: `${scheme} <YOUR_VALUE>` });
    assert.doesNotMatch(JSON.stringify(result), /private-token/);
  }
  insert('io.github.acme/bare-bearer', [{ url: 'https://bare-bearer.test/mcp', headers: [
    { name: 'Authorization', isRequired: true, isSecret: true, value: 'Bearer {private-token}' },
  ] }]);
  const bareBearer = getServerDetails(db, 'io.github.acme/bare-bearer');
  assert.equal(bareBearer.remoteHeaders[0].value, 'Bearer <YOUR_VALUE>');
  assert.deepEqual(getInstallCommand(db, 'io.github.acme/bare-bearer', 'cursor')
    .config.mcpServers['bare-bearer'].headers, { Authorization: 'Bearer <YOUR_VALUE>' });

  const invalidDirect = planRemoteHeaders([{ name: 'Bad Header', isRequired: true, isSecret: true }]);
  assert.deepEqual(invalidDirect.headers, {});
  assert.equal(invalidDirect.known, false);
  assert.equal(invalidDirect.safeToAutoinstall, false);
  assert.equal(invalidDirect.requiresUserSecrets, null);
  for (const invalid of [
    { name: 'Authorization', isRequired: 'true', isSecret: true },
    { name: 'Authorization', isRequired: true, isSecret: 'false' },
    { name: 'Authorization', isRequired: true, variables: { token: { isSecret: 'true' } } },
    { name: 'Authorization', isRequired: true, variables: { token: { isRequired: 'false' } } },
  ]) {
    const result = planRemoteHeaders([invalid]);
    assert.equal(result.known, false);
    assert.equal(result.safeToAutoinstall, false);
    assert.equal(result.requiresUserSecrets, null);
    assert.deepEqual(result.headers, {});
  }

  // Missing, mismatched, malformed and invalid raw headers remain unknown.
  insert('io.github.acme/known-empty', [{ url: 'https://known-empty.test/mcp' }]);
  assert.equal(getServerDetails(db, 'io.github.acme/known-empty').remoteHeadersKnown, true);
  for (const [suffix, remote, options] of [
    ['missing', [{ url: 'https://missing.test/mcp' }], { raw: { server: {} } }],
    ['mismatch', [{ url: 'https://elsewhere.test/mcp' }], { url: 'https://mismatch.test/mcp' }],
    ['malformed', [{ url: 'https://malformed.test/mcp', headers: {} }], {}],
    ['invalid', [{ url: 'https://invalid.test/mcp', headers: [
      { name: 'Bad Header', isRequired: true, isSecret: true },
    ] }], {}],
    ['invalid-flag', [{ url: 'https://invalid-flag.test/mcp', headers: [
      { name: 'Authorization', isRequired: 'false', isSecret: true },
    ] }], {}],
    ['invalid-variable-flag', [{ url: 'https://invalid-variable-flag.test/mcp', headers: [
      { name: 'Authorization', isRequired: true, value: 'Bearer {token}',
        variables: { token: { isSecret: 'true' } } },
    ] }], {}],
  ]) {
    const name = `io.github.acme/${suffix}-metadata`;
    insert(name, remote, options);
    const detail = getServerDetails(db, name);
    assert.equal(detail.remoteHeadersKnown, false, suffix);
    assert.equal(detail.secretCount, null, suffix);
    assert.equal(detail.trustSignals.requiresSecrets, null, suffix);
    assert.equal(detail.installComplexity, 'high', suffix);
    const config = getInstallCommand(db, name, 'cursor');
    assert.equal(config.remoteHeadersKnown, false, suffix);
    assert.match(config.instructions, /authentication requirements are unknown/i);
    assert.deepEqual(config.config.mcpServers[name.split('/').pop()], { url: options.url ?? remote[0].url });
  }

  const advisory = planRemoteHeaders([
    { name: 'Authorization', isRequired: true, value: 'Bearer {token}',
      variables: { token: {} } },
    { name: 'X-Auth', isRequired: false },
    { name: 'X-Region', isRequired: true, value: '{API_KEY}',
      variables: { API_KEY: {} } },
    { name: 'X-API-Key', isRequired: true },
    { name: 'X-Auth-Token', isRequired: true },
    { name: 'X-API-Key', isRequired: false },
    { name: 'X-Explicit', isRequired: true, value: '{TOKEN}',
      variables: { TOKEN: { isSecret: true } } },
  ]);
  assert.deepEqual(advisory.possibleUnlabeledSecrets,
    ['Authorization', 'X-Region', 'X-API-Key', 'X-Auth-Token']);
  assert.equal(advisory.requiredSecretCount, 1);
  const searchRequired = searchServers(db, 'unsafe-nested').find((r) => r.name === 'io.github.acme/unsafe-nested');
  assert.equal(searchRequired.secretCount, unsafeDetail.secretCount);
  assert.equal(searchRequired.trustSignals.requiresSecrets, unsafeDetail.trustSignals.requiresSecrets);
  const searchUnknown = searchServers(db, 'invalid-metadata').find((r) => r.name === 'io.github.acme/invalid-metadata');
  assert.equal(searchUnknown.installComplexity, 'high');
  assert.equal(searchUnknown.secretCount, null);

  insert('io.github.acme/legacy', [{ url: 'https://legacy.acme.test/mcp',
    headers: [{ name: 'X-Token', isRequired: true, isSecret: true, value: 'published-secret' }] }]);
  const legacy = getServerDetails(db, 'io.github.acme/legacy');
  assert.equal(legacy.remoteHeaders[0].value, undefined);
  assert.deepEqual(planRemoteHeaders(legacy.remoteHeaders).headers, { 'X-Token': '<YOUR_VALUE>' });
  insert('io.github.acme/malformed', [{ url: 'https://bad.acme.test/mcp' }], {
    raw: { primarySource: 'official', primary: { nonsense: true }, bySource: {} },
  });
  assert.deepEqual(getServerDetails(db, 'io.github.acme/malformed').remoteHeaders, []);

  insert('io.github.acme/local', [], { registryType: 'npm', packageIdentifier: '@acme/local',
    env: [{ name: 'LOCAL_TOKEN', isSecret: true }] });
  assert.deepEqual(getInstallCommand(db, 'io.github.acme/local', 'cursor').config.mcpServers.local.env,
    { LOCAL_TOKEN: '<YOUR_VALUE>' });
  assert.equal(Object.hasOwn(getServerDetails(db, 'io.github.acme/local'), 'remoteHeadersKnown'), false);
  insert('io.github.acme/dual', [{ url: 'https://dual.test/mcp', headers: [optional] }], {
    registryType: 'npm', packageIdentifier: '@acme/dual',
    env: [{ name: 'LOCAL_TOKEN', isSecret: true }],
  });
  const dual = getServerDetails(db, 'io.github.acme/dual');
  assert.equal(dual.secretCount, 1);
  assert.equal(dual.trustSignals.requiresSecrets, true);
  assert.equal(searchServers(db, 'dual').find((r) => r.name === 'io.github.acme/dual').secretCount, 1);
  assert.equal(getInstallCommand(db, 'io.github.acme/dual', 'cursor').config.mcpServers.dual.command, 'npx');

  // A same-URL duplicate cannot be dropped if it carries different header
  // requirements, even when all package/env names and descriptions match.
  insert('io.github.acme/duplicate-a', [{ url: 'https://duplicate.acme.test/mcp' }], {
    env: [{ name: 'REGION' }],
  });
  insert('com.acme/duplicate-b', [{ url: 'https://duplicate.acme.test/mcp',
    headers: [{ name: 'Authorization', isRequired: true, isSecret: true }] }]);
  const merge = mergeSameRemoteOfficialEntries(db);
  assert.ok(merge.skipped.some((s) => s.ids.includes('com.acme/duplicate-b') &&
    s.reason === 'would-lose-fields'));
  assert.ok(db.prepare('SELECT id FROM servers WHERE id=?').get('com.acme/duplicate-b'));
  insert('io.github.acme/duplicate-c', [{ url: 'https://duplicate-reverse.acme.test/mcp',
    headers: [{ name: 'Authorization', isRequired: true, isSecret: true }] }]);
  insert('com.acme/duplicate-d', [{ url: 'https://duplicate-reverse.acme.test/mcp' }], {
    env: [{ name: 'REGION' }],
  });
  const reverseMerge = mergeSameRemoteOfficialEntries(db);
  assert.ok(reverseMerge.skipped.some((s) => s.ids.includes('io.github.acme/duplicate-c') &&
    s.reason === 'would-lose-fields'));
  assert.ok(db.prepare('SELECT id FROM servers WHERE id=?').get('io.github.acme/duplicate-c'));

  // Per-client remote entry shapes.
  insert('io.github.acme/clients-auth', [{ type: 'streamable-http', url: 'https://clients.acme.test/mcp', headers: [
    { name: 'Authorization', isRequired: true, isSecret: true, value: 'Bearer {token}',
      variables: { token: { isSecret: true } } },
    { name: 'X-Client-Id', isRequired: true, value: 'acme' },
    { name: 'X-Trace', description: 'optional' },
  ] }]);
  insert('io.github.acme/clients-plain', [{ type: 'streamable-http', url: 'https://plain.acme.test/mcp' }]);
  insert('io.github.acme/clients-sse', [{ type: 'sse', url: 'https://sse.acme.test/events' }]);
  insert('io.github.acme/clients-sse-path', [], { url: 'https://inferred.acme.test/sse', raw: { server: {} } });
  const authHeaders = { Authorization: 'Bearer <YOUR_VALUE>', 'X-Client-Id': 'acme' };
  const authUrl = 'https://clients.acme.test/mcp';
  const expectedAuth = {
    'claude-desktop': { mcpServers: { 'clients-auth': {
      command: 'npx',
      args: ['-y', 'mcp-remote', authUrl,
        '--header', 'Authorization:${MCP_HEADER_AUTHORIZATION}',
        '--header', 'X-Client-Id:${MCP_HEADER_X_CLIENT_ID}'],
      env: { MCP_HEADER_AUTHORIZATION: 'Bearer <YOUR_VALUE>', MCP_HEADER_X_CLIENT_ID: 'acme' },
    } } },
    cursor: { mcpServers: { 'clients-auth': { url: authUrl, headers: authHeaders } } },
    generic: { mcpServers: { 'clients-auth': { url: authUrl, headers: authHeaders } } },
    'claude-code': { mcpServers: { 'clients-auth': { type: 'http', url: authUrl, headers: authHeaders } } },
    windsurf: { mcpServers: { 'clients-auth': { serverUrl: authUrl, headers: authHeaders } } },
    cline: { mcpServers: { 'clients-auth': { type: 'streamableHttp', url: authUrl, headers: authHeaders } } },
    vscode: { servers: { 'clients-auth': { type: 'http', url: authUrl, headers: authHeaders } } },
  };
  const plainUrl = 'https://plain.acme.test/mcp';
  const expectedPlain = {
    'claude-desktop': { mcpServers: { 'clients-plain': { command: 'npx', args: ['-y', 'mcp-remote', plainUrl] } } },
    cursor: { mcpServers: { 'clients-plain': { url: plainUrl } } },
    generic: { mcpServers: { 'clients-plain': { url: plainUrl } } },
    'claude-code': { mcpServers: { 'clients-plain': { type: 'http', url: plainUrl } } },
    windsurf: { mcpServers: { 'clients-plain': { serverUrl: plainUrl } } },
    cline: { mcpServers: { 'clients-plain': { type: 'streamableHttp', url: plainUrl } } },
    vscode: { servers: { 'clients-plain': { type: 'http', url: plainUrl } } },
  };
  for (const [client, expected] of Object.entries(expectedAuth)) {
    const result = getInstallCommand(db, 'io.github.acme/clients-auth', client);
    assert.deepEqual(result.config, expected, client);
    assert.deepEqual(getInstallCommand(db, 'io.github.acme/clients-plain', client).config, expectedPlain[client], client);
    assert.match(result.instructions, /Required HTTP header Authorization/, client);
    assert.match(result.instructions, /Optional HTTP header X-Trace/, client);
  }
  const desktop = getInstallCommand(db, 'io.github.acme/clients-auth', 'claude-desktop');
  assert.doesNotMatch(JSON.stringify(desktop.config), /"(?:url|serverUrl)"/);
  assert.match(desktop.instructions, /mcp-remote \(requires Node\.js\)/);
  assert.match(desktop.instructions, /Custom connectors cannot send custom HTTP headers/);
  assert.match(desktop.postInstallNote, /~\/\.mcp-auth/);
  assert.match(desktop.postInstallNote, /Replace placeholder values/);
  const desktopPlain = getInstallCommand(db, 'io.github.acme/clients-plain', 'claude-desktop');
  assert.match(desktopPlain.instructions, /Add custom connector .*recommended|recommended when no headers/);
  const code = getInstallCommand(db, 'io.github.acme/clients-auth', 'claude-code');
  assert.match(code.instructions, /claude mcp add --transport http clients-auth https:\/\/clients\.acme\.test\/mcp --header 'Authorization: Bearer <YOUR_VALUE>' --header 'X-Client-Id: acme'/);
  assert.match(code.postInstallNote, /\/mcp/);
  assert.equal(getInstallCommand(db, 'io.github.acme/clients-auth', 'windsurf').configFilePath, '~/.codeium/windsurf/mcp_config.json');
  assert.match(getInstallCommand(db, 'io.github.acme/clients-auth', 'windsurf').instructions, /devin\/mcp_config\.json/);
  assert.match(getInstallCommand(db, 'io.github.acme/clients-auth', 'cline').configFilePath,
    /saoudrizwan\.claude-dev\/settings\/cline_mcp_settings\.json$/);
  for (const name of ['clients-sse', 'clients-sse-path']) {
    const url = name === 'clients-sse' ? 'https://sse.acme.test/events' : 'https://inferred.acme.test/sse';
    assert.deepEqual(getInstallCommand(db, `io.github.acme/${name}`, 'claude-code').config.mcpServers[name], { type: 'sse', url });
    assert.deepEqual(getInstallCommand(db, `io.github.acme/${name}`, 'cline').config.mcpServers[name], { type: 'sse', url });
    assert.deepEqual(getInstallCommand(db, `io.github.acme/${name}`, 'vscode').config.servers[name], { type: 'sse', url });
    assert.match(getInstallCommand(db, `io.github.acme/${name}`, 'claude-code').instructions, /--transport sse/);
  }
  assert.deepEqual(buildRemoteServerEntry('claude-desktop', 'k', 'https://x.test/mcp', 'http', { 'X-A': '1', 'X.A': '2' }).entry, {
    command: 'npx',
    args: ['-y', 'mcp-remote', 'https://x.test/mcp', '--header', 'X-A:${MCP_HEADER_X_A}', '--header', 'X.A:${MCP_HEADER_X_A_2}'],
    env: { MCP_HEADER_X_A: '1', MCP_HEADER_X_A_2: '2' },
  });
  insert('io.github.acme/clients-http', [{ type: 'streamable-http', url: 'http://insecure.acme.test/mcp' }]);
  assert.deepEqual(getInstallCommand(db, 'io.github.acme/clients-http', 'claude-desktop').config.mcpServers['clients-http'].args,
    ['-y', 'mcp-remote', 'http://insecure.acme.test/mcp', '--allow-http']);
  // Stdio configs follow the client's top-level key.
  assert.equal(getInstallCommand(db, 'io.github.acme/local', 'vscode').config.servers.local.command, 'npx');
  assert.equal(getInstallCommand(db, 'io.github.acme/local', 'cline').config.mcpServers.local.command, 'npx');
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log('remote header core tests passed');
