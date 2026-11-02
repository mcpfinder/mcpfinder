import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { initDatabase } from '../packages/core/dist/index.js';

const dir = mkdtempSync(join(tmpdir(), 'mcpf-remote-headers-'));
const insert = (db, name, { remotes = [], selectedUrl = remotes[0]?.url ?? null, env = [], packageId = null, raw = null }) => {
  db.prepare(`INSERT INTO servers (
    id, slug, name, description, version, registry_type, package_identifier,
    transport_type, repository_url, repository_source, published_at, updated_at,
    status, popularity_score, categories, keywords, remote_url, has_remote,
    last_synced_at, sources, raw_data, env_vars, source, use_count, verified, icon_url
  ) VALUES (
    @id, @slug, @name, 'test server', '1.0.0', @registry_type, @package_identifier,
    'stdio', NULL, NULL, NULL, NULL,
    'active', 0, '[]', '[]', @remote_url, @has_remote,
    @last_synced_at, @sources, @raw_data, @env_vars, 'official', 0, 0, NULL
  )`).run({
    id: name, slug: name.split('/').at(-1), name,
    registry_type: packageId ? 'npm' : null, package_identifier: packageId,
    remote_url: selectedUrl, has_remote: selectedUrl ? 1 : 0,
    last_synced_at: new Date().toISOString(),
    sources: JSON.stringify(raw?.bySource ? ['official', 'glama'] : ['official']),
    raw_data: JSON.stringify(raw ?? { server: { name, version: '1.0.0', remotes } }),
    env_vars: JSON.stringify(env),
  });
};

async function callTool(name, toolName = 'get_install_config') {
  const child = spawn(process.execPath, [resolve('packages/mcp-server/dist/cli.js')], {
    env: { ...process.env, MCPFINDER_DATA_DIR: dir, MCPFINDER_DISABLE_SNAPSHOT: '1', GLAMA_API_KEY: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  lines.on('line', (line) => {
    const response = JSON.parse(line);
    pending.get(response.id)?.(response);
  });
  const request = (id, method, params) => new Promise((resolveRequest, rejectRequest) => {
    const timer = setTimeout(() => rejectRequest(new Error(`${method} timed out`)), 15_000);
    pending.set(id, (response) => {
      clearTimeout(timer);
      pending.delete(id);
      response.error ? rejectRequest(new Error(response.error.message)) : resolveRequest(response.result);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    await request(1, 'initialize', {
      protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'remote-header-tests', version: '1.0.0' },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const response = await request(2, 'tools/call', {
      name: toolName,
      arguments: toolName === 'get_install_config' ? { name, platform: 'cursor' } : { name },
    });
    return { ...response.structuredContent, text: response.content?.[0]?.text ?? '' };
  } finally {
    lines.close();
    child.stdin.end();
    child.kill();
  }
}

try {
  const db = initDatabase(join(dir, 'data.db'));
  const oauth = 'https://mcp.arcmira.com/mcp';
  const optional = { name: 'Authorization', description: 'Bearer <key>. Omit this header for OAuth sign-in.', isSecret: true };
  insert(db, 'io.github.arcmira/arcmira', {
    selectedUrl: oauth,
    env: [{ name: 'ARCMIRA_API_KEY', description: 'Optional account key.' }],
    raw: {
      primarySource: 'official',
      primary: { server: { name: 'io.github.arcmira/arcmira', remotes: [{ type: 'streamable-http', url: oauth, headers: [optional] }] } },
      bySource: { glama: { environmentVariablesJsonSchema: { type: 'object', properties: { ARCMIRA_API_KEY: { type: 'string' } }, required: [] } } },
    },
  });
  insert(db, 'io.example/required', { remotes: [{ type: 'streamable-http', url: 'https://example.com/required', headers: [
    { name: 'Authorization', description: 'API key bearer token.', isRequired: true, isSecret: true },
  ] }] });
  insert(db, 'io.example/templated', { remotes: [{ type: 'streamable-http', url: 'https://example.com/templated', headers: [
    { name: 'Authorization', isRequired: true, value: 'Bearer {api_key}', variables: { api_key: { isSecret: true, isRequired: true } } },
  ] }] });
  insert(db, 'io.example/unresolved', { remotes: [{ type: 'streamable-http', url: 'https://example.com/unresolved', headers: [
    { name: 'Authorization', description: 'Provide a bearer token.', isRequired: true, isSecret: true, value: 'Bearer {token}' },
  ] }] });
  insert(db, 'io.example/fixed', { remotes: [{ type: 'streamable-http', url: 'https://example.com/fixed', headers: [
    { name: 'X-Client', isRequired: true, value: 'mcpfinder' },
  ] }] });
  insert(db, 'io.example/plain', { remotes: [{ type: 'streamable-http', url: 'https://example.com/plain' }] });
  insert(db, 'io.example/unknown', { selectedUrl: 'https://example.com/unknown', raw: {} });
  insert(db, 'io.example/invalid', { remotes: [{ type: 'streamable-http', url: 'https://example.com/invalid', headers: [
    { name: 'Bad Header', isRequired: true, isSecret: true },
  ] }] });
  insert(db, 'io.example/optional-key', { remotes: [{ type: 'streamable-http', url: 'https://example.com/optional-key', headers: [
    { name: 'X-API-Key', description: 'Optional API key.', isRequired: false },
  ] }] });
  insert(db, 'io.example/unlabeled', { remotes: [{ type: 'streamable-http', url: 'https://example.com/unlabeled', headers: [
    { name: 'Authorization', description: 'Bearer token.', isRequired: true },
  ] }] });
  insert(db, 'io.example/unused-secret-var', { remotes: [{ type: 'streamable-http', url: 'https://example.com/unused', headers: [
    { name: 'X-Client', isRequired: true, value: 'public-client', variables: { unused: { isSecret: true } } },
  ] }] });
  insert(db, 'io.example/selected', {
    selectedUrl: 'https://example.com/second',
    env: [{ name: 'LOCAL_TOKEN', isSecret: true }, { name: 'SECOND_SECRET', isSecret: true }],
    packageId: '@example/selected',
    remotes: [
      { type: 'streamable-http', url: 'https://example.com/first', headers: [{ name: 'X-Wrong', isRequired: true, isSecret: true }] },
      { type: 'streamable-http', url: 'https://example.com/second', headers: [{ name: 'X-Right', isRequired: true, value: 'ok' }] },
    ],
  });
  insert(db, 'io.example/remote-secret-local-plain', {
    selectedUrl: 'https://example.com/remote-secret',
    packageId: '@example/remote-secret-local-plain',
    remotes: [{ type: 'streamable-http', url: 'https://example.com/remote-secret', headers: [
      { name: 'Authorization', isRequired: true, isSecret: true },
    ] }],
  });
  insert(db, 'io.example/local', { env: [{ name: 'LOCAL_TOKEN', isSecret: true }], packageId: '@example/local' });
  const now = new Date().toISOString();
  db.prepare("INSERT INTO sync_log (source, last_synced_at, last_successful_at, server_count, status) VALUES ('official', ?, ?, 14, 'ok')").run(now, now);
  db.close();

  const arcmira = await callTool('io.github.arcmira/arcmira');
  assert.deepEqual(arcmira.config.mcpServers.arcmira, { url: oauth });
  assert.deepEqual(arcmira.envVarsNeeded, []);
  assert.notEqual(arcmira.remoteHeaders[0].isRequired, true);
  assert.equal(arcmira.remoteHeadersKnown, true);
  assert.deepEqual(arcmira.possible_unlabeled_secrets, []);
  assert.equal(arcmira.safe_to_autoinstall, true);
  assert.equal(arcmira.requires_user_secrets, false);
  assert.match(arcmira.text, /Optional HTTP headers/);
  assert.match(arcmira.text, /Omit this header for OAuth sign-in/);
  assert.doesNotMatch(arcmira.text, /Required environment variables/);
  const arcmiraDetails = await callTool('io.github.arcmira/arcmira', 'get_server_details');
  assert.equal(arcmiraDetails.server.remoteHeaders[0].name, 'Authorization');
  assert.equal(arcmiraDetails.server.remoteHeadersKnown, true);
  assert.equal(arcmiraDetails.server.secretCount, 0);
  assert.match(arcmiraDetails.text, /Required remote secret headers:\*\* 0/);
  assert.match(arcmiraDetails.text, /Authorization.*optional.*secret/);

  const required = await callTool('io.example/required');
  assert.deepEqual(required.config.mcpServers.required.headers, { Authorization: '<YOUR_VALUE>' });
  assert.equal(required.requires_user_secrets, true);
  assert.equal(required.safe_to_autoinstall, false);
  assert.match(required.text, /Required HTTP headers/);
  assert.match(required.text, /complete header value in the published format/);
  assert.doesNotMatch(required.text, /Required environment variables/);
  const requiredDetails = await callTool('io.example/required', 'get_server_details');
  assert.equal(requiredDetails.server.secretCount, 1);
  assert.match(requiredDetails.text, /Required remote secret headers:\*\* 1/);
  assert.match(requiredDetails.text, /Authorization.*required.*secret/);

  const templated = await callTool('io.example/templated');
  assert.deepEqual(templated.config.mcpServers.templated.headers, { Authorization: 'Bearer <YOUR_VALUE>' });
  assert.equal(templated.requires_user_secrets, true);
  assert.equal(templated.safe_to_autoinstall, false);
  assert.deepEqual(templated.possible_unlabeled_secrets, []);
  assert.match(templated.text, /keep the surrounding header text in JSON/);

  const unresolved = await callTool('io.example/unresolved');
  assert.deepEqual(unresolved.config.mcpServers.unresolved.headers, { Authorization: 'Bearer <YOUR_VALUE>' });
  assert.equal(unresolved.requires_user_secrets, true);
  assert.equal(unresolved.safe_to_autoinstall, false);
  assert.match(unresolved.text, /keep the surrounding header text in JSON/);

  const fixed = await callTool('io.example/fixed');
  assert.deepEqual(fixed.config.mcpServers.fixed.headers, { 'X-Client': 'mcpfinder' });
  assert.equal(fixed.requires_user_secrets, false);
  assert.equal(fixed.safe_to_autoinstall, true);

  const plain = await callTool('io.example/plain');
  assert.deepEqual(plain.config.mcpServers.plain, { url: 'https://example.com/plain' });
  assert.deepEqual(plain.remoteHeaders, []);
  assert.equal(plain.remoteHeadersKnown, true);
  assert.equal(plain.safe_to_autoinstall, true);

  for (const name of ['unknown', 'invalid']) {
    const result = await callTool(`io.example/${name}`);
    assert.equal(result.remoteHeadersKnown, false, name);
    assert.equal(result.requires_user_secrets, null, name);
    assert.equal(result.safe_to_autoinstall, false, name);
    assert.match(result.text, /Header metadata is unavailable.*Verify authentication requirements manually/s, name);
    const detail = await callTool(`io.example/${name}`, 'get_server_details');
    assert.equal(detail.server.remoteHeadersKnown, false, name);
    assert.equal(detail.server.secretCount, null, name);
    assert.equal(detail.server.trustSignals.requiresSecrets, null, name);
    assert.equal(detail.server.installComplexity, 'high', name);
    assert.match(detail.text, /Required remote secret headers:\*\* unknown/, name);
  }

  const optionalKey = await callTool('io.example/optional-key');
  assert.deepEqual(optionalKey.config.mcpServers['optional-key'], { url: 'https://example.com/optional-key' });
  assert.deepEqual(optionalKey.possible_unlabeled_secrets, []);
  assert.equal(optionalKey.safe_to_autoinstall, true);
  assert.doesNotMatch(optionalKey.text, /possible credential/);

  const unlabeled = await callTool('io.example/unlabeled');
  assert.deepEqual(unlabeled.possible_unlabeled_secrets, ['Authorization']);
  assert.match(unlabeled.text, /Authorization.*possible credential/);
  assert.equal(unlabeled.requires_user_secrets, false);
  assert.equal(unlabeled.safe_to_autoinstall, false);

  const unusedSecretVariable = await callTool('io.example/unused-secret-var');
  assert.equal(unusedSecretVariable.requires_user_secrets, false);
  assert.equal(unusedSecretVariable.safe_to_autoinstall, true);
  assert.doesNotMatch(unusedSecretVariable.text, /⚠️ secret/);
  const unusedDetails = await callTool('io.example/unused-secret-var', 'get_server_details');
  assert.doesNotMatch(unusedDetails.text, /X-Client.*\(secret\)/);

  const selected = await callTool('io.example/selected');
  assert.deepEqual(selected.config.mcpServers.selected, { url: 'https://example.com/second', headers: { 'X-Right': 'ok' } });
  assert.deepEqual(selected.envVarsNeeded, []);
  assert.deepEqual(selected.remoteHeaders.map((h) => h.name), ['X-Right']);
  assert.equal(selected.requires_user_secrets, false);
  const selectedDetails = await callTool('io.example/selected', 'get_server_details');
  assert.equal(selectedDetails.server.selectedInstallType, 'remote');
  assert.equal(selectedDetails.server.secretCount, 0);
  assert.equal(selectedDetails.server.trustSignals.requiresSecrets, false);
  assert.equal(selectedDetails.server.trustSignals.possibleUnlabeledSecrets, false);
  assert.equal(selectedDetails.server.installComplexity, 'low');
  assert.match(selectedDetails.text, /Required remote secret headers:\*\* 0/);
  assert.match(selectedDetails.text, /Install Complexity:\*\* low/);
  assert.match(selectedDetails.text, /Requires Secrets:\*\* no/);
  assert.match(selectedDetails.text, /Default install method:\*\* Remote HTTP/);
  assert.match(selectedDetails.text, /Package \(local alternative\)/);

  const reverse = await callTool('io.example/remote-secret-local-plain');
  assert.equal(reverse.requires_user_secrets, true);
  const reverseDetails = await callTool('io.example/remote-secret-local-plain', 'get_server_details');
  assert.equal(reverseDetails.server.selectedInstallType, 'remote');
  assert.equal(reverseDetails.server.secretCount, 1);
  assert.equal(reverseDetails.server.trustSignals.requiresSecrets, true);
  assert.equal(reverseDetails.server.installComplexity, 'medium');
  assert.match(reverseDetails.text, /Requires Secrets:\*\* yes/);

  const local = await callTool('io.example/local');
  assert.deepEqual(local.config.mcpServers.local.env, { LOCAL_TOKEN: '<YOUR_VALUE>' });
  assert.equal(local.requires_user_secrets, true);
  assert.deepEqual(local.remoteHeaders, []);
  assert.equal(Object.hasOwn(local, 'remoteHeadersKnown'), false);
  const localDetails = await callTool('io.example/local', 'get_server_details');
  assert.equal(Object.hasOwn(localDetails.server, 'remoteHeadersKnown'), false);
  assert.equal(localDetails.server.selectedInstallType, 'npm');
  console.log('remote header MCP install tests passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
