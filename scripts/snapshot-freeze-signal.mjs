#!/usr/bin/env node
/**
 * The one place that files, updates and retires the snapshot-freeze issue.
 *
 * Two workflows raise this alarm — .github/workflows/snapshot.yml when a build
 * run cannot finish *and* the public manifest is no longer fresh (or the
 * freshness probe fails), and .github/workflows/snapshot-staleness.yml when
 * the published manifest stops moving — and they must converge on a *single*
 * thread, or the deduplication that makes the alarm bearable stops working.
 * Two near-verbatim copies of the label/list/comment dance in YAML were exactly
 * the kind of thing that drifts apart silently, so the whole protocol lives
 * here instead: label identity, title, throttling and duplicate reconciliation.
 *
 * Usage (everything comes from the environment, so multi-line bodies survive):
 *
 *   FREEZE_BODY=… FREEZE_SIGNATURE=… node scripts/snapshot-freeze-signal.mjs raise
 *   FREEZE_BODY=… FREEZE_SIGNATURE=… node scripts/snapshot-freeze-signal.mjs raise-unless-fresh
 *   FREEZE_BODY=…                    node scripts/snapshot-freeze-signal.mjs clear
 */
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { checkSnapshotStaleness } from './check-snapshot-staleness.mjs';
import { isMainModule } from './verify-snapshot-upload.mjs';

/**
 * Short probe for `raise-unless-fresh`. Load-bearing for `cancelled()`: the
 * runner's post-cancellation grace window cannot absorb the default 4 × 15 s
 * staleness ladder (~66 s). Two attempts × 5 s + 500 ms backoff is ~10.5 s
 * worst case. Probe failure still raises (fail closed).
 */
export const RAISE_UNLESS_FRESH_STALENESS_PROBE = { retries: 1, timeoutMs: 5_000 };

const execFile = promisify(execFileCallback);

export const FREEZE_LABEL = 'snapshot-freeze';
export const FREEZE_TITLE = 'Snapshot publication is frozen';
const FREEZE_LABEL_COLOR = 'b60205';
const FREEZE_LABEL_DESCRIPTION = 'Snapshot publication is frozen: stale data, not an outage';

/**
 * How often an *unchanged* alarm is allowed to repeat itself.
 *
 * The staleness monitor runs every two hours; commenting on every pass turns a
 * week-long stall into ~84 comments and buries the diagnostic body under a
 * column of identical restatements. Twelve hours is picked deliberately: it is
 * shorter than nothing (so the thread still proves the monitor is alive, and a
 * stall that outlives a working day gets a fresh timestamp) and long enough
 * that a month-long freeze stays readable at two comments a day. Any *change*
 * of signature — a different verdict, a different cause behind it, a different
 * failing step — bypasses the throttle entirely, because that is new
 * information rather than a repeat. Which is why the callers sign with the
 * *cause* of the verdict and never with its wording: the wording carries the
 * age, and an age that moves every two hours would defeat this entirely.
 */
export const REPEAT_COMMENT_INTERVAL_HOURS = 12;

const SIGNATURE_PREFIX = 'snapshot-freeze-signal:';

/**
 * The signature travels inside the comment as an HTML comment: invisible in
 * the rendered issue, and readable back through the API, so the *issue itself*
 * is the state store. Anything else would need somewhere to persist state
 * between two independent workflows, which is the complexity this avoids.
 */
export function signatureMarker(signature) {
  return `<!-- ${SIGNATURE_PREFIX} ${signature} -->`;
}

export function readSignature(body) {
  const match = /<!--\s*snapshot-freeze-signal:\s*(.*?)\s*-->/s.exec(body ?? '');
  return match ? match[1] : null;
}

/**
 * Decide whether an already-open freeze issue deserves another comment.
 *
 * `entries` is the issue body followed by its comments, oldest first, each
 * `{ body, createdAt }`. Only entries carrying a signature marker count: a
 * human's comment on the thread is not the monitor's own last word.
 */
export function decideFreezeComment({
  signature,
  entries = [],
  now = Date.now(),
  intervalHours = REPEAT_COMMENT_INTERVAL_HOURS,
}) {
  let last;
  for (const entry of entries) {
    if (readSignature(entry?.body) !== null) last = entry;
  }
  if (!last) return { comment: true, reason: 'no previous signal on this thread' };
  if (readSignature(last.body) !== signature) {
    return { comment: true, reason: 'the reported state changed' };
  }
  const at = Date.parse(last.createdAt ?? '');
  if (!Number.isFinite(at)) {
    return { comment: true, reason: 'the previous signal carries no readable timestamp' };
  }
  const ageHours = (now - at) / 3_600_000;
  if (ageHours >= intervalHours) {
    return { comment: true, reason: `the last identical signal is ${Math.round(ageHours)}h old` };
  }
  return {
    comment: false,
    reason: `unchanged since ${last.createdAt}, next repeat after ${intervalHours}h`,
  };
}

/**
 * Pick the thread everyone should converge on, and name the strays.
 *
 * Dedup is a list-then-create against a remote API, so two signals racing each
 * other — a build failing at the same moment the monitor is mid-check — can
 * both see nothing and both create. A shared `concurrency` group would fix that
 * by making the 10-minute monitor queue behind a 90-minute build, which trades
 * a rare duplicate for a routinely skipped check; GitHub keeps only one pending
 * run per group and drops the rest. So the race is left possible and made
 * self-healing instead: whoever signals next keeps the oldest thread (the one
 * carrying the history) and closes the strays, converging within one cycle.
 */
export function reconcileFreezeIssues(numbers) {
  const sorted = [...new Set(numbers)].filter(Number.isInteger).sort((a, b) => a - b);
  return { keep: sorted[0] ?? null, duplicates: sorted.slice(1) };
}

async function gh(args, { run }) {
  const { stdout } = await run('gh', args);
  return stdout.trim();
}

async function listOpenFreezeIssues({ run }) {
  const raw = await gh(
    ['issue', 'list', '--label', FREEZE_LABEL, '--state', 'open', '--limit', '50', '--json', 'number'],
    { run },
  );
  const parsed = raw ? JSON.parse(raw) : [];
  return parsed.map((issue) => issue.number);
}

async function readThread(number, { run }) {
  const raw = await gh(['issue', 'view', String(number), '--json', 'body,comments,createdAt'], { run });
  const parsed = raw ? JSON.parse(raw) : {};
  return [
    { body: parsed.body ?? '', createdAt: parsed.createdAt ?? null },
    ...(parsed.comments ?? []).map((comment) => ({
      body: comment.body ?? '',
      createdAt: comment.createdAt ?? null,
    })),
  ];
}

async function ensureLabel({ run }) {
  // `gh label create` errors when the label already exists, which is the
  // steady state and no reason to swallow an alarm.
  try {
    await gh(
      ['label', 'create', FREEZE_LABEL, '--color', FREEZE_LABEL_COLOR, '--description', FREEZE_LABEL_DESCRIPTION],
      { run },
    );
  } catch {
    // The steady state: the label already exists. Any other failure here
    // surfaces on the next `gh` call, which is not tolerated.
  }
}

async function closeDuplicates({ duplicates, keep, run, log }) {
  for (const number of duplicates) {
    log(`[snapshot-freeze] closing duplicate #${number} in favour of #${keep}`);
    await gh(
      ['issue', 'comment', String(number), '--body', `Duplicate freeze thread; consolidating on #${keep}.`],
      { run },
    );
    await gh(['issue', 'close', String(number), '--reason', 'not planned'], { run });
  }
}

/**
 * Build-workflow raise: file only when the public manifest is already stale
 * or unreadable. A single failed 6-hourly cycle while `publishedAt` is still
 * fresh is a red Actions run, not a GitHub issue — the 18-hour staleness
 * monitor is what files when publication actually stalls. Probe failures
 * raise anyway (fail closed for the alarm). An open issue is not cleared
 * here; that stays the all-clear path.
 */
export async function raiseFreezeSignalUnlessFresh({
  body,
  signature,
  staleness,
  now = Date.now(),
  intervalHours = REPEAT_COMMENT_INTERVAL_HOURS,
  run,
  log = console.log,
}) {
  let verdict;
  try {
    verdict = typeof staleness === 'function' ? await staleness() : staleness;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    log(`[snapshot-freeze] raising anyway: probe failed (${why})`);
    return raiseFreezeSignal({ body, signature, now, intervalHours, run, log });
  }
  if (verdict?.state === 'fresh') {
    log(`[snapshot-freeze] not raising: ${verdict.reason}`);
    return { action: 'skipped-fresh', reason: verdict.reason };
  }
  return raiseFreezeSignal({ body, signature, now, intervalHours, run, log });
}

/** Open the freeze issue, or add to the open one when it has something new to say. */
export async function raiseFreezeSignal({
  body,
  signature,
  now = Date.now(),
  intervalHours = REPEAT_COMMENT_INTERVAL_HOURS,
  run,
  log = console.log,
}) {
  await ensureLabel({ run });
  const { keep, duplicates } = reconcileFreezeIssues(await listOpenFreezeIssues({ run }));
  const marked = `${body}\n\n${signatureMarker(signature)}`;
  if (keep === null) {
    await gh(['issue', 'create', '--title', FREEZE_TITLE, '--label', FREEZE_LABEL, '--body', marked], {
      run,
    });
    // Re-list: if a concurrent signal created its own thread in the window
    // above, this is where the two converge.
    const after = reconcileFreezeIssues(await listOpenFreezeIssues({ run }));
    let moved = null;
    if (after.duplicates.length > 0) {
      // We may be the *loser* of that race: the thread that survives is the
      // oldest one, which is not necessarily the one just created here. Closing
      // ours as a duplicate without carrying its body over would leave this
      // alarm's diagnostics on a closed issue, reachable only through GitHub's
      // cross-reference — and the thread the on-call actually reads would say
      // nothing about the failure that raised it.
      //
      // Which of the two threads is ours is not worth asking `gh` about: the
      // ordinary throttle answers it. If the survivor already carries this
      // signature it is either ours or an identical restatement, and in both
      // cases it needs nothing added.
      const decision = decideFreezeComment({
        signature,
        entries: await readThread(after.keep, { run }),
        now,
        intervalHours,
      });
      if (decision.comment) {
        await gh(['issue', 'comment', String(after.keep), '--body', marked], { run });
        moved = decision.reason;
      }
    }
    await closeDuplicates({ duplicates: after.duplicates, keep: after.keep, run, log });
    if (moved) {
      log(`[snapshot-freeze] lost the create race; body moved to #${after.keep}: ${moved}`);
      return { action: 'commented', number: after.keep, reason: `lost the create race; ${moved}` };
    }
    return { action: 'created', number: after.keep };
  }
  await closeDuplicates({ duplicates, keep, run, log });
  const decision = decideFreezeComment({
    signature,
    entries: await readThread(keep, { run }),
    now,
    intervalHours,
  });
  if (!decision.comment) {
    log(`[snapshot-freeze] #${keep} left alone: ${decision.reason}`);
    return { action: 'throttled', number: keep, reason: decision.reason };
  }
  await gh(['issue', 'comment', String(keep), '--body', marked], { run });
  log(`[snapshot-freeze] commented on #${keep}: ${decision.reason}`);
  return { action: 'commented', number: keep, reason: decision.reason };
}

/**
 * The all-clear. Without it the freeze issue would need a human to close it,
 * and an alarm nobody closes is an alarm everyone learns to ignore.
 */
export async function clearFreezeSignal({ body, run, log = console.log }) {
  const numbers = await listOpenFreezeIssues({ run });
  for (const number of numbers) {
    await gh(['issue', 'comment', String(number), '--body', body], { run });
    await gh(['issue', 'close', String(number), '--reason', 'completed'], { run });
    log(`[snapshot-freeze] closed #${number}`);
  }
  return { closed: numbers };
}

async function main() {
  const action = process.argv[2];
  const body = process.env.FREEZE_BODY;
  if (!body) throw new Error('FREEZE_BODY is required');
  const run = (file, args) => execFile(file, args, { maxBuffer: 16 * 1024 * 1024 });
  if (action === 'raise' || action === 'raise-unless-fresh') {
    const signature = process.env.FREEZE_SIGNATURE;
    if (!signature) throw new Error('FREEZE_SIGNATURE is required to raise a freeze signal');
    if (action === 'raise-unless-fresh') {
      // Short probe is load-bearing for `cancelled()`: the runner's
      // post-cancellation grace window cannot absorb the default 4 × 15 s
      // staleness ladder. Probe failure still raises (fail closed).
      await raiseFreezeSignalUnlessFresh({
        body,
        signature,
        staleness: () => checkSnapshotStaleness(RAISE_UNLESS_FRESH_STALENESS_PROBE),
        run,
      });
      return;
    }
    await raiseFreezeSignal({ body, signature, run });
    return;
  }
  if (action === 'clear') {
    await clearFreezeSignal({ body, run });
    return;
  }
  throw new Error(
    `unknown action ${JSON.stringify(action)}; expected raise, raise-unless-fresh, or clear`,
  );
}

if (await isMainModule({ moduleUrl: import.meta.url })) {
  await main();
}
