#!/usr/bin/env node
// Checks for scripts/glama-capture-pointer.mjs (R2 latest.json validation).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPointer, verifyFiles } from './glama-capture-pointer.mjs';
import { MAX_CAPTURE_AGE_MS } from './glama-capture-lib.mjs';

const now = Date.parse('2026-10-14T12:00:00Z');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const header = JSON.stringify({ v: 1, capturedAt: '2026-10-14T09:00:00.000Z', servers: 3 }) + '\n';
const body = Buffer.from('gz-bytes');
const good = {
  v: 1, prefix: '20261014T091500Z/', capturedAt: '2026-10-14T09:00:00.000Z',
  headerSha256: sha(header), responsesSha256: sha(body), host: 't',
};

assert.equal(checkPointer(good, { now }), '20261014T091500Z/');
assert.throws(() => checkPointer(null, { now }), /not a JSON object/);
assert.throws(() => checkPointer({ ...good, v: 2 }, { now }), /version/);
for (const prefix of ['../x/', '20261014T091500Z', 'a/20261014T091500Z/', '']) {
  assert.throws(() => checkPointer({ ...good, prefix }, { now }), /prefix/);
}
assert.throws(() => checkPointer({ ...good, headerSha256: 'x' }, { now }), /checksums/);
assert.throws(() => checkPointer({ ...good, capturedAt: 'nope' }, { now }), /invalid/);
const stale = new Date(now - MAX_CAPTURE_AGE_MS - 1000).toISOString();
assert.throws(() => checkPointer({ ...good, capturedAt: stale }, { now }), /older than 12 h/);
const edge = new Date(now - MAX_CAPTURE_AGE_MS + 1000).toISOString();
assert.equal(checkPointer({ ...good, capturedAt: edge }, { now }), good.prefix);
const future = new Date(now + 120_000).toISOString();
assert.throws(() => checkPointer({ ...good, capturedAt: future }, { now }), /future/);

const dir = mkdtempSync(join(tmpdir(), 'gcp-'));
writeFileSync(join(dir, 'header.json'), header);
writeFileSync(join(dir, 'responses.jsonl.gz'), body);
verifyFiles(good, dir);
assert.throws(() => verifyFiles({ ...good, responsesSha256: sha('other') }, dir), /responses.jsonl.gz checksum/);
assert.throws(() => verifyFiles({ ...good, headerSha256: sha('other') }, dir), /header.json checksum/);
const h2 = JSON.stringify({ v: 1, capturedAt: '2026-10-14T08:00:00.000Z' }) + '\n';
writeFileSync(join(dir, 'header.json'), h2);
assert.throws(() => verifyFiles({ ...good, headerSha256: sha(h2) }, dir), /does not match pointer/);
console.log('glama-capture-pointer checks passed');
