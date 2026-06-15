#!/usr/bin/env node
/**
 * Build the MCPfinder MCPB bundle (for Smithery, or any MCPB-aware client).
 *
 * Produces a single self-contained, cross-platform bundle — no node_modules,
 * no symlinks, no native binaries — by inlining the server's deps with
 * esbuild-wasm, then zipping it into a .mcpb. This is only portable because the
 * SQLite engine is the built-in node:sqlite (no native addon to ship per-platform).
 *
 * We zip directly rather than using `mcpb pack`: Smithery requires every tool in
 * the manifest to carry an `inputSchema` object, which the official mcpb manifest
 * schema rejects ("Unrecognized key: inputSchema"). Smithery reads the manifest
 * itself, so its requirement wins for our publish target. (`mcpb info <file>`
 * still works to inspect the result.)
 *
 * Output:  mcpfinder-<version>.mcpb  (repo root; git-ignored)
 *
 * Usage (repo root):
 *   pnpm build:mcpb
 *   # or, if packages are already built:
 *   node scripts/build-mcpb.mjs [--out=<work-dir>]
 *
 * Bundle layout (matches packages/mcp-server/manifest.json server.entry_point):
 *   <root>/manifest.json
 *   <root>/package.json        (carries the version that index.js reads at runtime)
 *   <root>/server/cli.js       (thin launcher: silences node:sqlite warning, then imports index.js)
 *   <root>/server/index.js     (the whole server + deps, inlined)
 */
import * as esbuild from 'esbuild-wasm';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const serverDir = join(repoRoot, 'packages/mcp-server');

const args = new Set(process.argv.slice(2));
const argVal = (name) => {
  for (const a of args) if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  return null;
};

const pkg = JSON.parse(await readFile(join(serverDir, 'package.json'), 'utf8'));
const version = pkg.version;
const workDir = resolve(repoRoot, argVal('--out') ?? 'dist/mcpb');
const stageDir = join(workDir, 'stage');

console.log(`[build-mcpb] version=${version} stage=${stageDir}`);

await rm(workDir, { recursive: true, force: true });
await mkdir(join(stageDir, 'server'), { recursive: true });

await esbuild.initialize({ worker: false });

// 1) Bundle the server into one self-contained file. platform:node keeps the
//    node:* builtins (including node:sqlite) external; everything else inlines.
const bundled = await esbuild.build({
  entryPoints: [join(serverDir, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  write: false,
  logLevel: 'warning',
});
if (bundled.errors.length) throw new Error(`esbuild (index) failed: ${JSON.stringify(bundled.errors)}`);
await writeFile(join(stageDir, 'server/index.js'), bundled.outputFiles[0].text);

// 2) Transpile the thin launcher as-is (NOT bundled): it must stay a separate
//    module so its emitWarning patch is installed before the dynamic
//    import('./index.js') pulls in node:sqlite. Bundling would defeat that.
const launcher = await esbuild.build({
  entryPoints: [join(serverDir, 'src/cli.ts')],
  bundle: false,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  write: false,
  logLevel: 'warning',
});
if (launcher.errors.length) throw new Error(`esbuild (cli) failed: ${JSON.stringify(launcher.errors)}`);
await writeFile(join(stageDir, 'server/cli.js'), launcher.outputFiles[0].text);

// 3) Bundle-root package.json — index.js reads ../package.json for its version.
await writeFile(
  join(stageDir, 'package.json'),
  JSON.stringify({ name: 'mcpfinder', version, type: 'module' }, null, 2) + '\n',
);

// 4) manifest.json from the committed source, with version kept in lockstep.
const manifest = JSON.parse(await readFile(join(serverDir, 'manifest.json'), 'utf8'));
manifest.version = version;
await writeFile(join(stageDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// 5) Pack as a standard .mcpb zip (manifest.json at the archive root). See the
//    header note for why this is a plain zip and not `mcpb pack`.
const out = join(repoRoot, `mcpfinder-${version}.mcpb`);
await rm(out, { force: true });
execFileSync('zip', ['-X', '-r', '-q', out, 'manifest.json', 'package.json', 'server'], {
  cwd: stageDir,
  stdio: 'inherit',
});
console.log(`\n[build-mcpb] wrote ${out}`);
