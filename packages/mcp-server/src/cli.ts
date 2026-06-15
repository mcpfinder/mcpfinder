#!/usr/bin/env node
/**
 * Launcher entry point for the `mcpfinder` bin.
 *
 * Its only job is to silence the one `ExperimentalWarning` that `node:sqlite`
 * emits on first load, then hand off to the real server in index.ts.
 *
 * Why a launcher: for a *builtin* module, the experimental warning fires while
 * the ESM graph is being linked — before any imported module body runs. So a
 * static `import` of a suppressor can't catch it. By installing the
 * `emitWarning` filter here and pulling in index.ts via a *dynamic* import, the
 * whole index graph (including `node:sqlite`) is loaded at runtime, after the
 * filter is in place. This works regardless of how the bin is invoked (npx,
 * `node dist/cli.js`, Windows shim) — no `--disable-warning` flag needed.
 */
const originalEmitWarning = process.emitWarning.bind(process);

process.emitWarning = function patchedEmitWarning(
  warning: string | Error,
  ...rest: unknown[]
): void {
  const name =
    typeof warning === 'string'
      ? typeof rest[0] === 'string'
        ? (rest[0] as string)
        : (rest[0] as { type?: string } | undefined)?.type
      : warning?.name;
  const message = typeof warning === 'string' ? warning : warning?.message;

  if (name === 'ExperimentalWarning' && /\bSQLite\b/i.test(String(message ?? ''))) {
    return;
  }
  (originalEmitWarning as (...args: unknown[]) => void)(warning, ...rest);
} as typeof process.emitWarning;

await import('./index.js');
