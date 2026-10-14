#!/usr/bin/env node
/**
 * Validate the latest.json pointer the Macs write to the R2 bucket
 * mcpfinder-glama-capture (ops/glama-capture/glama-capture-launchd.sh).
 *
 *   node scripts/glama-capture-pointer.mjs <latest.json>
 *       prints the capture prefix ("<UTC ts>/") or exits 1 with ::error::
 *   node scripts/glama-capture-pointer.mjs <latest.json> --verify=<dir>
 *       checks <dir>/header.json and <dir>/responses.jsonl.gz against the
 *       pointer's checksums and capturedAt
 *
 * The age limit is the replay's own MAX_CAPTURE_AGE_MS (12 h), checked here so
 * a stale capture fails before the build instead of inside it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HEADER_FILE, MAX_CAPTURE_AGE_MS, RESPONSES_FILE } from './glama-capture-lib.mjs';

const PREFIX_RE = /^\d{8}T\d{6}Z\/$/;
const HEX_RE = /^[a-f0-9]{64}$/;

/** Returns the prefix, or throws with a human-readable reason. */
export function checkPointer(pointer, { now = Date.now() } = {}) {
  if (!pointer || typeof pointer !== 'object') throw new Error('latest.json is not a JSON object');
  if (pointer.v !== 1) throw new Error(`latest.json version ${pointer.v} is not supported`);
  if (typeof pointer.prefix !== 'string' || !PREFIX_RE.test(pointer.prefix)) {
    throw new Error(`latest.json prefix ${JSON.stringify(pointer.prefix)} is invalid`);
  }
  if (!HEX_RE.test(pointer.headerSha256 ?? '') || !HEX_RE.test(pointer.responsesSha256 ?? '')) {
    throw new Error('latest.json checksums are missing or invalid');
  }
  const t = Date.parse(pointer.capturedAt);
  if (!Number.isFinite(t)) throw new Error(`latest.json capturedAt ${pointer.capturedAt} is invalid`);
  const ageH = (now - t) / 3_600_000;
  if (now - t > MAX_CAPTURE_AGE_MS) {
    throw new Error(
      `latest Glama capture is ${ageH.toFixed(1)} h old (captured ${pointer.capturedAt} on ` +
        `${pointer.host ?? '?'}), older than ${MAX_CAPTURE_AGE_MS / 3_600_000} h — ` +
        'check LaunchAgent com.mcpfinder.glama-capture on aic-studio / aic-wfs-mini',
    );
  }
  if (t - now > 60_000) throw new Error(`latest.json capturedAt ${pointer.capturedAt} is in the future`);
  return pointer.prefix;
}

/** Throws unless the downloaded files match the pointer. */
export function verifyFiles(pointer, dir) {
  const sha = (f) => createHash('sha256').update(readFileSync(join(dir, f))).digest('hex');
  if (sha(HEADER_FILE) !== pointer.headerSha256) throw new Error(`${HEADER_FILE} checksum mismatch`);
  if (sha(RESPONSES_FILE) !== pointer.responsesSha256) throw new Error(`${RESPONSES_FILE} checksum mismatch`);
  const header = JSON.parse(readFileSync(join(dir, HEADER_FILE), 'utf8'));
  if (header.capturedAt !== pointer.capturedAt) {
    throw new Error(`header capturedAt ${header.capturedAt} does not match pointer ${pointer.capturedAt}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, ...rest] = process.argv.slice(2);
  const verifyArg = rest.find((a) => a.startsWith('--verify='));
  try {
    const pointer = JSON.parse(readFileSync(file, 'utf8'));
    const prefix = checkPointer(pointer);
    if (verifyArg) {
      verifyFiles(pointer, verifyArg.slice('--verify='.length));
      console.error(
        `[glama-capture] using ${prefix} captured ${pointer.capturedAt} on ${pointer.host ?? '?'} ` +
          `(${pointer.servers} servers, ${pointer.responsesBytes} bytes)`,
      );
    } else {
      process.stdout.write(prefix);
    }
  } catch (error) {
    // stderr: the workflow captures stdout as the prefix.
    console.error(`::error::Glama capture: ${error.message}`);
    process.exit(1);
  }
}
