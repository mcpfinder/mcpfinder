#!/usr/bin/env node
// Checks the freshness gate in ops/glama-capture/glama-capture-launchd.sh: runs a
// temp copy of the real wrapper with every external command stubbed by an exported
// bash function (the wrapper overwrites PATH, so PATH stubs would not apply).
// Nothing touches real credentials, ~/Library or the network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WRAPPER = join(dirname(fileURLToPath(import.meta.url)), '../ops/glama-capture/glama-capture-launchd.sh');

const STUBS = `
security() { echo dummy; }
shlock() { return 0; }
curl() { [ -f "$STUB_DIR/latest.json" ] || return 22; cat "$STUB_DIR/latest.json"; }
git() { case " $* " in *" rev-parse "*) echo abc1234 ;; esac; }
scutil() { echo test-host; }
npx() { : >"$STUB_DIR/npx-called"; return 1; }
node() { "$STUB_NODE" "$@"; }
export -f security shlock curl git scutil npx node
exec bash "$STUB_DIR/wrapper.sh"
`;

const root = mkdtempSync(join(tmpdir(), 'glama-wrapper-'));

const hoursAgo = (h) => JSON.stringify({ capturedAt: new Date(Date.now() - h * 3600_000).toISOString() });

// latest: the latest.json body curl returns; undefined makes curl fail.
function run(name, { role, latest, maxAgeMinutes }) {
  const dir = join(root, name);
  const base = join(dir, 'base');
  mkdirSync(join(base, 'repo/.git'), { recursive: true });
  writeFileSync(join(base, 'repo/package.json'), JSON.stringify({ packageManager: 'pnpm@0.0.0' }));
  copyFileSync(WRAPPER, join(dir, 'wrapper.sh'));
  if (latest !== undefined) writeFileSync(join(dir, 'latest.json'), latest);
  const log = join(dir, 'capture.log');
  const env = {
    PATH: process.env.PATH, HOME: dir, USER: 'test', ROLE: role, BASE: base, LOG: log,
    STUB_DIR: dir, STUB_NODE: process.execPath,
  };
  if (maxAgeMinutes !== undefined) env.MAX_AGE_MINUTES = String(maxAgeMinutes);
  const res = spawnSync('bash', ['-c', STUBS], { env, encoding: 'utf8' });
  assert.equal(res.error, undefined, name);
  return {
    status: res.status,
    captured: existsSync(join(dir, 'npx-called')),
    log: existsSync(log) ? readFileSync(log, 'utf8') : '',
    stderr: res.stderr,
  };
}

const cases = [
  // Default thresholds: primary 1320 min (22 h), fallback 1800 min (30 h).
  ['primary-21.9h', { role: 'primary', latest: hoursAgo(21.9) }, false, 1320],
  ['primary-22.1h', { role: 'primary', latest: hoursAgo(22.1) }, true],
  ['primary-missing', { role: 'primary' }, true],
  ['primary-invalid-json', { role: 'primary', latest: 'not json' }, true],
  ['fallback-29.9h', { role: 'fallback', latest: hoursAgo(29.9) }, false, 1800],
  ['fallback-30.1h', { role: 'fallback', latest: hoursAgo(30.1) }, true],
  ['override-captures-earlier', { role: 'primary', latest: hoursAgo(2), maxAgeMinutes: 60 }, true],
  ['override-skips-longer', { role: 'primary', latest: hoursAgo(23), maxAgeMinutes: 1500 }, false, 1500],
];

try {
  for (const [name, opts, expectCapture, skipThreshold] of cases) {
    const r = run(name, opts);
    const detail = `${name}\nlog:\n${r.log}\nstderr:\n${r.stderr}`;
    assert.equal(r.captured, expectCapture, detail);
    if (expectCapture) {
      assert.notEqual(r.status, 0, detail); // the npx stub stops the run right after the gate
      assert.match(r.log, new RegExp(`; ${opts.role} captures\\n`), detail);
    } else {
      assert.equal(r.status, 0, detail);
      assert.match(r.log, new RegExp(`; ${opts.role} skips\\n`), detail);
      assert.ok(r.log.includes(`(< ${skipThreshold} min)`), detail);
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`glama-capture wrapper: ${cases.length} gate cases passed`);
