import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPackedRuntime } from './check-packed-runtime.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceServer = JSON.parse(readFileSync(path.join(repository, 'packages/mcp-server/package.json'), 'utf8'));
assert.deepEqual(sourceServer.bundleDependencies, ['@modelcontextprotocol/sdk', 'zod']);
assert.deepEqual(
  readFileSync(path.join(repository, 'packages/mcp-server/LICENSE')),
  readFileSync(path.join(repository, 'LICENSE')),
  'The server package license must match the root license',
);

// Metadata-only fixtures deliberately have no application code. Retain them for
// inspection; this test never starts the CLI, uses a database or removes files.
const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'mcpfinder-packed-runtime-'));
const graph = {
  '@modelcontextprotocol/sdk': { version: '1.32.2', dependencies: { express: '5.3.0', zod: '3.25.76' } },
  express: { version: '5.3.0', dependencies: { qs: '6.17.1', 'body-parser': '2.3.0', 'proxy-addr': '2.0.8' } },
  'body-parser': { version: '2.3.0', dependencies: { qs: '6.17.1' } },
  'proxy-addr': { version: '2.0.8' },
  qs: { version: '6.17.1' },
  zod: { version: '3.25.76' },
};

function writePackage(root, manifest) {
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
}

function makeFixture(name, { hostOnly = false, missingProxy = false } = {}) {
  const host = path.join(fixtureRoot, name);
  const server = path.join(host, 'node_modules/@mcpfinder/server');
  const bundled = path.join(server, 'node_modules');
  writePackage(server, {
    name: '@mcpfinder/server', version: '2.0.3', main: './index.js',
    bundleDependencies: sourceServer.bundleDependencies,
    dependencies: { '@mcpfinder/core': '^2.0.3', '@modelcontextprotocol/sdk': '^1.32.2', zod: '^3.23.8' },
  });
  writeFileSync(path.join(server, 'index.js'), 'throw new Error("Application must not execute");\n');
  const core = path.join(host, 'node_modules/@mcpfinder/core');
  writePackage(core, { name: '@mcpfinder/core', version: '2.0.3', main: './index.js' });
  writeFileSync(path.join(core, 'index.js'), 'throw new Error("Core must not execute");\n');
  const lock = { importers: { 'packages/mcp-server': { dependencies: {} } }, packages: {}, snapshots: {} };
  for (const [dependency, manifest] of Object.entries(graph)) {
    const key = `${dependency}@${manifest.version}`;
    lock.packages[key] = {};
    lock.snapshots[key] = { dependencies: manifest.dependencies ?? {} };
    if (dependency === 'proxy-addr' && missingProxy) continue;
    const modules = dependency === 'proxy-addr' && hostOnly ? path.join(host, 'node_modules') : bundled;
    writePackage(path.join(modules, dependency), { name: dependency, ...manifest });
  }
  for (const dependency of sourceServer.bundleDependencies) {
    lock.importers['packages/mcp-server'].dependencies[dependency] = { version: graph[dependency].version };
  }
  // pnpm's snapshot reference retains the exact resolved peer context.
  const sdkKey = '@modelcontextprotocol/sdk@1.32.2';
  lock.snapshots[`${sdkKey}(zod@3.25.76)`] = lock.snapshots[sdkKey];
  lock.importers['packages/mcp-server'].dependencies['@modelcontextprotocol/sdk'].version = '1.32.2(zod@3.25.76)';
  // A separate importer can legitimately use another version. It must not
  // influence the server's reachable, audited snapshot graph.
  lock.importers['api-worker'] = { dependencies: { zod: { version: '4.0.0' } } };
  lock.packages['zod@4.0.0'] = {};
  lock.snapshots['zod@4.0.0'] = {};
  const lockFile = path.join(host, 'pnpm-lock.yaml');
  writeFileSync(lockFile, JSON.stringify(lock)); // JSON is valid YAML.
  return { server, bundled, lock, lockFile };
}

const valid = makeFixture('positive');
assert.equal(checkPackedRuntime(valid.server, valid.lockFile).selected.length, Object.keys(graph).length);

const hostEscape = makeFixture('host-escape', { hostOnly: true });
assert.throws(() => checkPackedRuntime(hostEscape.server, hostEscape.lockFile), /escaped the server bundle/);

const staleBodyParser = makeFixture('body-parser-stale-qs');
writePackage(path.join(staleBodyParser.bundled, 'body-parser/node_modules/qs'), { name: 'qs', version: '6.15.2' });
assert.throws(() => checkPackedRuntime(staleBodyParser.server, staleBodyParser.lockFile), /Unaudited qs version/);

const missing = makeFixture('missing-runtime', { missingProxy: true });
assert.throws(() => checkPackedRuntime(missing.server, missing.lockFile), /Cannot resolve proxy-addr/);

const workspaceRange = makeFixture('unrewritten-workspace');
const workspaceManifest = JSON.parse(readFileSync(path.join(workspaceRange.server, 'package.json'), 'utf8'));
workspaceManifest.dependencies['@mcpfinder/core'] = 'workspace:^2.0.3';
writePackage(workspaceRange.server, workspaceManifest);
assert.throws(() => checkPackedRuntime(workspaceRange.server, workspaceRange.lockFile), /workspace:\^2\.0\.3/);

console.log(`packed runtime checks passed; retained metadata fixtures: ${fixtureRoot}`);
