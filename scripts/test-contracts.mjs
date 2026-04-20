import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

console.log('contract checks passed');
