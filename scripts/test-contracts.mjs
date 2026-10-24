import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve('.');

const serverManifest = JSON.parse(
  await readFile(resolve(root, 'packages/mcp-server/server.json'), 'utf8'),
);
const readme = await readFile(resolve(root, 'README.md'), 'utf8');
const serverSource = await readFile(resolve(root, 'packages/mcp-server/src/index.ts'), 'utf8');
const llms = await readFile(resolve(root, 'landing/public/llms.txt'), 'utf8');

assert.equal(serverManifest.name, 'dev.mcpfinder/server');
assert.ok(!('remotes' in serverManifest), 'server manifest should not advertise deprecated HTTP remotes');

const declaredTools = serverManifest._meta?.['io.modelcontextprotocol.registry/publisher-provided']?.tools ?? [];
const canonicalTools = [
  'search_mcp_servers',
  'get_server_details',
  'get_install_config',
  'browse_categories',
];
for (const toolName of canonicalTools) {
  assert.ok(declaredTools.includes(toolName), `server manifest should declare ${toolName}`);
  assert.ok(
    serverSource.includes(`'${toolName}'`),
    `server source should register ${toolName}`,
  );
}
assert.equal(
  declaredTools.length,
  canonicalTools.length,
  `server manifest should declare exactly ${canonicalTools.length} tools, got ${declaredTools.length}`,
);
for (const deprecated of ['get_install_command', 'list_categories', 'browse_category']) {
  assert.ok(
    !declaredTools.includes(deprecated),
    `server manifest should not advertise removed tool ${deprecated}`,
  );
  assert.ok(
    !serverSource.includes(`'${deprecated}'`),
    `server source should no longer register removed tool ${deprecated}`,
  );
}

assert.ok(
  serverSource.includes('structuredContent'),
  'server source should emit structuredContent for tool chaining',
);
assert.match(readme, /Canonical transport:\s+`stdio`/);
assert.match(readme, /get_install_config/);
assert.match(readme, /browse_categories/);
assert.match(llms, /Canonical transport:/);
assert.match(llms, /get_install_config/);
assert.match(llms, /^- https:\/\/mcpfinder\.dev\/best-mcp-servers-2026\/ — \S/m, 'llms.txt should describe the best-mcp-servers-2026 guide');

// Landing redirects: every landing page folder (landing/public/<page>/index.html)
// needs explicit 301s in _redirects, otherwise Workers static assets answer the
// slash-less URL and /<page>/index.html with a temporary 307.
const landingPublic = resolve(root, 'landing/public');
const redirectRules = new Set(
  (await readFile(resolve(landingPublic, '_redirects'), 'utf8'))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(/\s+/).join(' ')),
);
const landingPages = [];
for (const entry of await readdir(landingPublic, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  try {
    await access(resolve(landingPublic, entry.name, 'index.html'));
    landingPages.push(entry.name);
  } catch {
    // folder without index.html (e.g. assets) is not a landing page
  }
}
assert.ok(landingPages.length > 0, 'expected landing page folders under landing/public');
for (const page of landingPages) {
  for (const rule of [`/${page} /${page}/ 301`, `/${page}/index.html /${page}/ 301`]) {
    assert.ok(redirectRules.has(rule), `landing/public/_redirects should contain "${rule}"`);
  }
}
assert.ok(redirectRules.has('/index.html / 301'), 'landing/public/_redirects should 301 /index.html to /');
// Reverse direction: a page-shaped rule must not outlive its folder (it would 301 to a 404).
for (const rule of redirectRules) {
  const match = rule.match(/^\/([^/\s]+)(?:\/index\.html)? \/([^/\s]+)\/ 301$/);
  if (!match) continue;
  assert.ok(
    landingPages.includes(match[2]),
    `landing/public/_redirects rule "${rule}" points at /${match[2]}/ but landing/public/${match[2]}/index.html is missing`,
  );
}

console.log('contract checks passed');
