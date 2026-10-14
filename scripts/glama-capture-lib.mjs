/**
 * Record/replay of Glama registry HTTP responses, so the Glama crawl can run
 * on a machine Glama answers (our Macs, ops/glama-capture/) while the merge, the
 * quality gate and publication stay in the GitHub-hosted build job.
 *
 * Why: since 2026-10-11 Glama answers GitHub-hosted runner IPs with HTTP 200
 * and an EMPTY body (probe run 38218078092), while our own network gets full
 * JSON. The Official registry is the opposite: ~95 s from GitHub-hosted, ~47
 * min from our network. Each crawl runs where it works and the bytes travel
 * through the R2 bucket mcpfinder-glama-capture.
 *
 * A capture is a directory with two files:
 *   header.json      {"v":1,"source":"glama","capturedAt":"<ISO>",
 *                     "syncStatus":"ok","servers":N,"responses":M}
 *   responses.jsonl.gz  one JSON object per fetch outcome, in request order:
 *                     {"url":"...","status":200,"contentType":"...","body":"..."}
 *                     or {"url":"...","error":"<message>"} for a thrown fetch
 * Only URL, status, content type and body are stored, never request or
 * response headers, so the API key (a request header) cannot reach the
 * artifact.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { createGunzip, createGzip } from 'node:zlib';

export const CAPTURE_VERSION = 1;
/** A capture older than this is refused: replaying it would publish stale data. */
export const MAX_CAPTURE_AGE_MS = 12 * 60 * 60_000;
export const HEADER_FILE = 'header.json';
export const RESPONSES_FILE = 'responses.jsonl.gz';

/**
 * Wrap `fetchImpl` so every fetch OUTCOME is appended, in order, to
 * `<dir>/responses.jsonl.gz`: a response line, or `{"url","error":"..."}` when
 * the fetch or body read threw (timeouts, resets). Recording failures too lets
 * the replay walk exactly the path the live crawl took, crawl restarts
 * included, instead of mixing pages from a discarded attempt.
 *
 * `forbidden` lists strings (the API key) that must never be written; a body
 * that reflects one fails the capture before anything reaches disk.
 */
export function createRecorder(dir, fetchImpl = fetch, { forbidden = [] } = {}) {
  const secrets = forbidden.filter((value) => typeof value === 'string' && value.length >= 8);
  const gzip = createGzip();
  const out = createWriteStream(join(dir, RESPONSES_FILE));
  gzip.pipe(out);
  let responses = 0;
  let refused = false;
  let chain = Promise.resolve();
  const append = (record) => {
    const line = JSON.stringify(record);
    for (const secret of secrets) {
      if (line.includes(secret)) {
        refused = true;
        throw new Error('Glama capture refused: a response reflects a secret');
      }
    }
    // Serialize writes and honour backpressure.
    chain = chain.then(async () => {
      if (!gzip.write(line + '\n')) await once(gzip, 'drain');
    });
    responses++;
    return chain;
  };
  const recordingFetch = async (url, init) => {
    let res;
    let body;
    try {
      res = await fetchImpl(url, init);
      // Read the body here so it stays under the caller's abort signal,
      // exactly like the sync's own consume step.
      body = await res.text();
    } catch (error) {
      await append({ url: String(url), error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    const contentType = res.headers.get('content-type') ?? '';
    await append({ url: String(url), status: res.status, contentType, body });
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: contentType ? { 'content-type': contentType } : {},
    });
  };
  const finish = async (fields) => {
    await chain;
    gzip.end();
    await once(out, 'close');
    // A refused (secret-reflecting) response was retried around by the sync;
    // the capture would then be missing a request, so it must not be used.
    if (refused) throw new Error('Glama capture refused: a response reflected a secret');
    const header = { v: CAPTURE_VERSION, source: 'glama', ...fields, responses };
    await writeFile(join(dir, HEADER_FILE), JSON.stringify(header) + '\n');
    return header;
  };
  return { fetch: recordingFetch, finish };
}

/**
 * Pull-based line iterator over the gzip'd responses. Unlike readline, which
 * eagerly queues up to 1,024 lines, this decompresses only as lines are
 * requested, so replay memory stays at roughly one page plus a stream buffer.
 * Stream errors (missing or corrupt file) reject the iteration.
 */
async function* readLines(path) {
  const source = createReadStream(path);
  const gunzip = createGunzip();
  // `.pipe()` does not forward errors: surface them through the iterator.
  source.on('error', (error) => gunzip.destroy(error));
  source.pipe(gunzip);
  // A StringDecoder, so a UTF-8 character split across chunks stays intact.
  gunzip.setEncoding('utf8');
  let rest = '';
  try {
    for await (const chunk of gunzip) {
      rest += chunk;
      let nl;
      while ((nl = rest.indexOf('\n')) !== -1) {
        const line = rest.slice(0, nl);
        rest = rest.slice(nl + 1);
        if (line) yield line;
      }
    }
    if (rest) yield rest;
  } finally {
    source.destroy();
    gunzip.destroy();
  }
}

function parseRecord(line, index) {
  const r = JSON.parse(line);
  const ok =
    typeof r.url === 'string' &&
    (typeof r.error === 'string' || (Number.isInteger(r.status) && typeof r.body === 'string'));
  if (!ok) throw new Error(`Glama capture line ${index} is malformed`);
  return r;
}

/**
 * Load a capture and return `{ header, fetch, remaining }`. Replay is strictly
 * sequential: the n-th request must be for the n-th recorded URL, and gets the
 * n-th recorded outcome (thrown errors are rethrown). Any divergence, or a
 * request past the end, throws, which the sync records as a failure, so the
 * quality gate refuses to publish. Lines are streamed from disk on demand, so
 * replay memory stays bounded like the live crawl's.
 */
export async function loadReplay(dir, { now = Date.now } = {}) {
  let header;
  try {
    header = JSON.parse(await readFile(join(dir, HEADER_FILE), 'utf8'));
  } catch (error) {
    throw new Error(`Glama capture missing or unreadable at ${dir}: ${error.message}`);
  }
  if (header.v !== CAPTURE_VERSION || header.source !== 'glama') {
    throw new Error(`Glama capture has unsupported format v=${header.v} source=${header.source}`);
  }
  if (header.syncStatus !== 'ok') {
    throw new Error(`Glama capture did not finish cleanly (syncStatus=${header.syncStatus})`);
  }
  const capturedAt = Date.parse(header.capturedAt);
  if (!Number.isFinite(capturedAt) || now() - capturedAt > MAX_CAPTURE_AGE_MS || capturedAt - now() > 60_000) {
    throw new Error(`Glama capture timestamp ${header.capturedAt} is outside the accepted window`);
  }
  const path = join(dir, RESPONSES_FILE);
  // Validation pass: complete, well-formed, and as long as the header says.
  let lines = 0;
  try {
    for await (const line of readLines(path)) parseRecord(line, ++lines);
  } catch (error) {
    if (/malformed/.test(error.message)) throw error;
    throw new Error(`Glama capture responses unreadable: ${error.message}`);
  }
  if (lines !== header.responses) {
    throw new Error(`Glama capture is truncated: ${lines} of ${header.responses} responses`);
  }

  const it = readLines(path);
  let served = 0;
  // Once the replay leaves the recorded path it stays failed: otherwise the
  // sync's own retries could resynchronise on a later record and finish "ok"
  // with a page skipped.
  let failure = null;
  const replayFetch = async (url) => {
    if (failure) throw new Error(failure);
    const next = await it.next();
    if (next.done) {
      failure = 'Glama replay: request past the end of the capture';
      throw new Error(failure);
    }
    const r = parseRecord(next.value, served + 1);
    served++;
    if (r.url !== String(url)) {
      failure = `Glama replay diverged from the capture at request ${served}`;
      throw new Error(failure);
    }
    if (typeof r.error === 'string') throw new Error(`replayed: ${r.error}`);
    return new Response(r.body, {
      status: r.status,
      headers: r.contentType ? { 'content-type': r.contentType } : {},
    });
  };
  /**
   * Why the replay is not faithful, or null. A sync that reported ok must be
   * overridden to an error when this is set or records remain unserved.
   */
  const verdict = () =>
    failure ?? (served !== header.responses ? `Glama replay served ${served} of ${header.responses} responses` : null);
  return { header, fetch: replayFetch, remaining: () => header.responses - served, verdict };
}
