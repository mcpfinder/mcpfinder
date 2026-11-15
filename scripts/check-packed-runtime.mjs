#!/usr/bin/env node
// Inspect package metadata and resolution paths without loading application code.
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { parse } = require('yaml');
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readManifest = root => JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

function locate(name, from) {
  const resolver = createRequire(path.join(from, 'package.json'));
  let root;
  for (const modules of resolver.resolve.paths(name) ?? []) {
    const candidate = path.join(modules, name);
    try {
      if (statSync(path.join(candidate, 'package.json')).isFile()) {
        root = realpathSync(candidate);
        break;
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
  }
  if (!root) return null;
  const manifest = readManifest(root);
  assert.equal(manifest.name, name);
  return { root, manifest };
}

export function checkPackedRuntime(serverArgument, lockArgument = path.join(repository, 'pnpm-lock.yaml')) {
  assert(serverArgument, 'Usage: node scripts/check-packed-runtime.mjs <installed-server-root> [audited-lock]');
  const serverRoot = realpathSync(serverArgument);
  const server = readManifest(serverRoot);
  const bundledNames = readManifest(path.join(repository, 'packages/mcp-server')).bundleDependencies;
  assert.equal(server.name, '@mcpfinder/server');
  assert.deepEqual(server.bundleDependencies, bundledNames, 'Packed bundle declarations changed');
  const lock = parse(readFileSync(lockArgument, 'utf8'));
  const importer = lock.importers['packages/mcp-server'];
  assert(importer, 'Audited server importer missing');
  const selected = [];
  const visited = new Set();

  function visit(name, reference, from, optional = false) {
    const snapshotKey = `${name}@${reference}`;
    const snapshot = lock.snapshots[snapshotKey];
    assert(snapshot, `Audited snapshot missing: ${snapshotKey}`);
    const version = reference.split('(')[0];
    assert(lock.packages[`${name}@${version}`], `Audited package missing: ${name}@${version}`);
    const found = locate(name, from);
    if (!found && optional) return;
    assert(found, `Cannot resolve ${name} from ${from}`);
    const { root, manifest } = found;
    const relative = path.relative(path.join(serverRoot, 'node_modules'), root);
    assert(relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative),
      `${name} escaped the server bundle: ${root}`);
    assert.equal(manifest.version, version, `Unaudited ${name} version from ${from}`);
    // The same version may appear at different nested paths. Check every actual
    // location, so a stale child cannot hide behind a previously checked sibling.
    const identity = `${root}\0${snapshotKey}`;
    if (visited.has(identity)) return;
    visited.add(identity);
    selected.push({ name, version, root, snapshot: snapshotKey });
    const edges = { ...snapshot.dependencies, ...snapshot.optionalDependencies };
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      assert(dependency in edges, `Unaudited runtime dependency ${dependency} in ${name}`);
    }
    // Peers absent from the snapshot were not installed by the audit. An optional
    // one may stay absent, but any copy that resolves would run unaudited.
    const audited = lock.packages[`${name}@${version}`];
    const peers = { ...audited.peerDependencies, ...manifest.peerDependencies };
    const peerMeta = { ...audited.peerDependenciesMeta, ...manifest.peerDependenciesMeta };
    for (const peer of Object.keys(peers)) {
      if (peer in edges) continue;
      assert(peerMeta[peer]?.optional, `Unaudited required peer ${peer} of ${name}`);
      const resolved = locate(peer, root);
      assert(!resolved, `Unaudited peer ${peer} of ${name} resolves at ${resolved?.root}`);
    }
    for (const [dependency, target] of Object.entries(snapshot.dependencies ?? {})) {
      visit(dependency, target, root);
    }
    for (const [dependency, target] of Object.entries(snapshot.optionalDependencies ?? {})) {
      visit(dependency, target, root, true);
    }
  }

  for (const name of bundledNames) {
    const dependency = importer.dependencies?.[name];
    assert(dependency, `Audited bundled root missing: ${name}`);
    visit(name, dependency.version, serverRoot);
  }
  const core = locate('@mcpfinder/core', serverRoot);
  assert(core, 'Cannot resolve @mcpfinder/core');
  assert.equal(core.manifest.version, server.version, 'Core/server coupled version mismatch');
  assert.equal(server.dependencies['@mcpfinder/core'], `^${server.version}`);
  assert.equal(Object.keys(core.manifest.dependencies ?? {}).length, 0, 'Core gained external runtime dependencies');
  assert(statSync(path.join(core.root, core.manifest.main)).isFile(), 'Core entrypoint missing');
  assert(statSync(path.join(serverRoot, server.main)).isFile(), 'Server entrypoint missing');
  return { status: 'PASS', server: server.version, auditedLock: path.resolve(lockArgument), selected };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(checkPackedRuntime(...process.argv.slice(2)), null, 2));
}
