import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getInstallCommand, getServerDetails, initDatabase, searchServers,
  mergeSameRemoteOfficialEntries, planRemoteHeaders,
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
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log('remote header core tests passed');
