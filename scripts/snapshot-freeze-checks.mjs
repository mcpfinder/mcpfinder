/**
 * The frozen-publication alarm, end to end: the two workflow signals, the
 * classification the age monitor makes, and the README paragraph that promises
 * both. Split out of scripts/test-snapshot-artifacts.mjs to keep that file
 * under the repository's 1000-line ceiling.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import {
  STALENESS_THRESHOLD_HOURS,
  checkSnapshotStaleness,
  evaluateSnapshotFreshness,
  formatGithubOutputs,
  snapshotManifestJsonUrl,
  stalenessOutputs,
} from './check-snapshot-staleness.mjs';
import { runSnapshotFreezeSignalChecks } from './snapshot-freeze-signal-checks.mjs';

/** Read back a `$GITHUB_OUTPUT` file the way the Actions runner does. */
function parseGithubOutput(rendered) {
  const outputs = {};
  const lines = rendered.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const heredoc = /^([^=<]+)<<(.+)$/.exec(lines[i]);
    if (heredoc) {
      const [, key, delimiter] = heredoc;
      const value = [];
      while (++i < lines.length && lines[i] !== delimiter) value.push(lines[i]);
      outputs[key] = value.join('\n');
      continue;
    }
    const plain = /^([^=]+)=(.*)$/.exec(lines[i]);
    if (plain) outputs[plain[1]] = plain[2];
  }
  return outputs;
}

/**
 * `workflow` / `parsedWorkflow` are snapshot.yml as text and as YAML, and
 * `durableProof` is the index at which the durable-fallback proof appears in
 * it — the caller already read all three.
 */
export async function runSnapshotFreezeChecks({ workflow, parsedWorkflow, durableProof }) {
  // ─── A frozen publication must announce itself ──────────────────────────────
  //
  // Two signals, because neither covers the other: the build's failure step sees
  // a run that failed but not one that never started, and the staleness monitor
  // sees a manifest that stopped moving but cannot say which step broke.
  // `actions: read` is not decoration: without it `gh run view --json jobs` 403s
  // and every alarm reports "not recorded yet" while README promises the failing
  // step by name.
  assert.deepEqual(parsedWorkflow.jobs.build.permissions, {
    actions: 'read',
    contents: 'read',
    issues: 'write',
  });
  // The arithmetic justifying `timeout-minutes: 90` must match the budgets set
  // below it, or the next person to raise one has no reserve left to spend.
  const budgets = ['MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES', 'MCPFINDER_SMITHERY_SYNC_BUDGET_MINUTES'];
  const budgetMinutes = budgets.map((name) =>
    Number(parsedWorkflow.jobs.build.steps.find((step) => step.env?.[name])?.env[name]),
  );
  const [glamaBudget, smitheryBudget] = budgetMinutes;
  assert.ok(budgetMinutes.every(Number.isFinite));
  const budgetComment = /Registry budgets can consume (\d+) minutes \(Official (\d+) \+ Glama (\d+) \+\n\s*# Smithery (\d+)\); keep at least (\d+) minutes/.exec(workflow);
  assert.ok(budgetComment, 'the timeout comment must spell out the budget arithmetic');
  const [, total, official, glamaSaid, smitherySaid, reserve] = budgetComment.map(Number);
  assert.equal(glamaSaid, glamaBudget);
  assert.equal(smitherySaid, smitheryBudget);
  assert.equal(official + glamaSaid + smitherySaid, total);
  assert.equal(total + reserve, parsedWorkflow.jobs.build['timeout-minutes']);

  const freezeStep = parsedWorkflow.jobs.build.steps.find(
    (step) => step.name === 'Signal frozen publication',
  );
  // `failure()` alone is false for a cancelled job — a tripped `timeout-minutes`,
  // a dead runner, a manual stop — which are exactly the runs that publish
  // nothing. And once the pointer has moved nothing is frozen at all, so that
  // case must not reach this step: a `snapshot-freeze` issue would then assert
  // the opposite of what the published manifest says.
  assert.equal(
    freezeStep.if,
    "(failure() || cancelled()) && steps.manifest-pointer.outcome != 'success'",
  );
  // The alarm must say the previous snapshot is still served: a freeze is a data
  // stall, not an outage, and mislabelling it burns the on-call's trust.
  assert.match(freezeStep.run, /still being served/);
  assert.equal(freezeStep.env.GH_TOKEN, '${{ secrets.GITHUB_TOKEN }}');
  const pointerStep = parsedWorkflow.jobs.build.steps.find(
    (step) => step.name === 'Publish manifest pointer to R2',
  );
  assert.equal(pointerStep.id, 'manifest-pointer');
  assert.equal(freezeStep.env.POINTER, '${{ steps.manifest-pointer.outcome }}');
  assert.match(freezeStep.run, /no new snapshot was published/);
  // The failing step names are the build signature's stable half: the same
  // build dying in the same place is a repeat, a different step is not.
  assert.match(freezeStep.run, /export FREEZE_SIGNATURE="build:pointer=\$\{POINTER:-none\}:\$failed"/);

  // ─── A stumble after publication is not a freeze ────────────────────────────
  //
  // `publishedAt` advanced, so the criterion the whole alarm rests on says
  // publication is healthy. The run stays red and the summary says what broke,
  // but no freeze issue is filed — and an open one is closed, because leaving it
  // would have this signal and the staleness monitor disagree about a manifest
  // they both consider fresh.
  const postPublish = parsedWorkflow.jobs.build.steps.find(
    (step) => step.name === 'Report failure after publication',
  );
  assert.ok(postPublish, 'a failure after the pointer moved needs its own path');
  assert.equal(
    postPublish.if,
    "(failure() || cancelled()) && steps.manifest-pointer.outcome == 'success'",
  );
  assert.doesNotMatch(postPublish.run, /snapshot-freeze-signal\.mjs raise/);
  assert.match(postPublish.run, /snapshot-freeze-signal\.mjs clear/);
  // The user accepted the red run; the summary is what has to explain it.
  assert.match(postPublish.run, /GITHUB_STEP_SUMMARY/);
  assert.match(postPublish.run, /\*\*The snapshot was published\*\*/);
  assert.match(postPublish.run, /no freeze issue is filed/);
  // The two paths must partition the failure space: exactly one of them runs.
  assert.equal(
    freezeStep.if.replace("!=", '=='),
    postPublish.if,
    'the freeze and post-publication paths must differ only in the pointer test',
  );
  const unfreezeStep = parsedWorkflow.jobs.build.steps.find(
    (step) => step.name === 'Clear frozen-publication signal',
  );
  assert.equal(unfreezeStep.if, 'success()');
  assert.match(unfreezeStep.run, /publishedAt/);
  // Signalling runs last: it must observe the publication steps, not precede them.
  assert.ok(workflow.indexOf('Signal frozen publication') > durableProof);

  const staleness = await readFile(
    new URL('../.github/workflows/snapshot-staleness.yml', import.meta.url),
    'utf8',
  );
  const parsedStaleness = parseYaml(staleness);
  // `on:` parses as the YAML boolean true unless quoted — read it either way.
  const stalenessTriggers = parsedStaleness.on ?? parsedStaleness[true];
  assert.equal(stalenessTriggers.schedule.length, 1);
  assert.match(stalenessTriggers.schedule[0].cron, /^\d+ \*\/2 \* \* \*$/);
  // Manual dispatch matters: the first thing anyone does with a stall report is
  // re-run the check by hand.
  assert.ok('workflow_dispatch' in stalenessTriggers);
  assert.deepEqual(parsedStaleness.jobs.check.permissions, {
    contents: 'read',
    issues: 'write',
  });
  // The monitor must state its own blind spot: it is a scheduled workflow too, so
  // the disabled-cron mode it partly exists for takes it down as well. Documented
  // rather than fixed, because only an external check can close it.
  assert.match(staleness, /What this monitor cannot see/);
  assert.match(staleness, /external uptime\n\s*# check that fetches/);
  const stalenessSteps = parsedStaleness.jobs.check.steps;
  const checkStep = stalenessSteps.find((step) => step.id === 'staleness');
  assert.match(checkStep.run, /node scripts\/check-snapshot-staleness\.mjs/);
  const stalenessAlarm = stalenessSteps.find(
    (step) => step.name === 'Signal frozen publication',
  );
  // Without a status function an `if:` is implicitly ANDed with `success()`, so a
  // broken checker would skip both the alarm and the clear — a monitor failing
  // silently. `!cancelled()` keeps that fix while dropping the case `always()`
  // over-reached into: a *cancelled* monitor learned nothing about publication,
  // and filing "produced no verdict" for it is a false alarm that nothing clears
  // for another two hours.
  assert.equal(stalenessAlarm.if, "!cancelled() && steps.staleness.outputs.state != 'fresh'");
  assert.match(stalenessAlarm.run, /still being served/);
  assert.match(stalenessAlarm.env.STATE, /\|\| 'unreadable'/);
  assert.match(stalenessAlarm.env.REASON, /produced no verdict/);
  const stalenessClear = stalenessSteps.find(
    (step) => step.name === 'Clear frozen-publication signal',
  );
  assert.equal(stalenessClear.if, "!cancelled() && steps.staleness.outputs.state == 'fresh'");
  for (const step of [stalenessAlarm, stalenessClear]) {
    assert.doesNotMatch(step.if, /always\(\)/, 'a cancelled monitor must signal nothing');
  }

  // ─── One implementation of the signal, not two ──────────────────────────────
  //
  // The label/list/comment-or-create dance used to be copy-pasted into both
  // workflows, and the copies had to stay byte-compatible for dedup to work at
  // all. Both now shell out to the same script; neither may grow its own copy.
  // `raise` is a prefix of `raise-unless-fresh`, so the two workflows are
  // pinned on the exact action each one is supposed to invoke.
  assert.match(freezeStep.run, /node scripts\/snapshot-freeze-signal\.mjs raise-unless-fresh/);
  assert.match(workflow, /short probe \(2 attempts × 5 s/);
  assert.match(workflow, /That bound is load-bearing for `cancelled\(\)`/);
  assert.doesNotMatch(
    freezeStep.run,
    /node scripts\/snapshot-freeze-signal\.mjs raise(?!-unless-fresh)/,
  );
  assert.match(
    stalenessAlarm.run,
    /node scripts\/snapshot-freeze-signal\.mjs raise(?!-unless-fresh)/,
  );
  assert.doesNotMatch(staleness, /raise-unless-fresh/);
  for (const [file, text] of [
    ['snapshot.yml', workflow],
    ['snapshot-staleness.yml', staleness],
  ]) {
    assert.match(text, /node scripts\/snapshot-freeze-signal\.mjs clear/, file);
    assert.doesNotMatch(text, /gh issue create/, file);
    assert.doesNotMatch(text, /gh label create/, file);
    assert.match(text, /export FREEZE_BODY=/, file);
  }
  assert.match(freezeStep.run, /export FREEZE_SIGNATURE=/);
  // The cause is in the signature, not just the state: `unreadable` from a 502
  // and `unreadable` from a manifest that lost its `publishedAt` are different
  // incidents, and the second must not wait out a 12-hour throttle earned by the
  // first. The wording stays out of it — it carries the age, which moves on
  // every pass and would restate the same verdict 84 times a week.
  assert.match(stalenessAlarm.run, /export FREEZE_SIGNATURE="staleness:\$STATE:\$CAUSE"/);
  assert.match(stalenessAlarm.env.CAUSE, /steps\.staleness\.outputs\.cause \|\| 'no-verdict'/);
  // Independent concurrency groups are a deliberate choice, not an oversight:
  // sharing one would queue the 10-minute monitor behind a 90-minute build.
  assert.notEqual(parsedStaleness.concurrency.group, parsedWorkflow.concurrency.group);
  assert.match(staleness, /reconciles duplicate threads/);

  await runSnapshotFreezeSignalChecks();

  // ─── Freshness verdicts ─────────────────────────────────────────────────────
  //
  // 18 hours = three missed 6-hourly builds. A single failed build is noise the
  // next cycle repairs; alarming on it would train everyone to ignore this.
  assert.equal(STALENESS_THRESHOLD_HOURS, 18);
  assert.match(parseYaml(staleness).name, /staleness/);
  const now = Date.parse('2026-08-27T12:00:00.000Z');
  const at = (hoursAgo) => new Date(now - hoursAgo * 3_600_000).toISOString();
  assert.equal(
    evaluateSnapshotFreshness({ manifest: { publishedAt: at(6) }, now }).state,
    'fresh',
  );
  // Two missed cycles still ride it out; three do not.
  assert.equal(
    evaluateSnapshotFreshness({ manifest: { publishedAt: at(17.9) }, now }).state,
    'fresh',
  );
  assert.equal(
    evaluateSnapshotFreshness({ manifest: { publishedAt: at(18.2) }, now }).state,
    'stale',
  );
  assert.equal(evaluateSnapshotFreshness({ manifest: { publishedAt: at(24) }, now }).ageHours, 24);

  // ─── The signature's stable half ────────────────────────────────────────────
  //
  // `cause` has to satisfy two opposing demands: change when the problem
  // changes, and not otherwise. A stall that deepens by two hours is the same
  // incident and must stay quiet; a 502 that becomes a DNS failure, or a
  // manifest that stops carrying a timestamp, is a different one and must reach
  // the thread immediately.
  assert.equal(
    evaluateSnapshotFreshness({ manifest: { publishedAt: at(30) }, now }).cause,
    evaluateSnapshotFreshness({ manifest: { publishedAt: at(30) }, now: now + 7_200_000 }).cause,
    'a stall that only ages must not look like a new alarm',
  );
  assert.equal(evaluateSnapshotFreshness({ manifest: { publishedAt: at(30) }, now }).cause, 'age-exceeded');
  const causes = [
    [{ manifest: null }, 'not-an-object'],
    [{ manifest: {} }, 'no-published-at'],
    [{ manifest: { publishedAt: 'soon' } }, 'unparseable-timestamp'],
    [{ manifest: { publishedAt: at(-5) } }, 'future-timestamp'],
    [{ manifest: { publishedAt: at(3) } }, 'fresh'],
  ];
  for (const [input, cause] of causes) {
    assert.equal(evaluateSnapshotFreshness({ ...input, now }).cause, cause, cause);
  }
  assert.equal(new Set(causes.map(([, cause]) => cause)).size, causes.length);
  for (const [, cause] of causes) assert.match(cause, /^[a-z0-9-]+$/);
  // Transport failures keep their class through the retry ladder, and the class
  // distinguishes them: a signature built on `state` alone reported both of
  // these as plain `unreadable` and sat on the change for up to twelve hours.
  const probe = async (fetchImpl) =>
    (
      await checkSnapshotStaleness({
        url: 'https://example.invalid/manifest.json',
        now,
        sleep: async () => {},
        fetchImpl,
      })
    ).cause;
  assert.equal(
    await probe(async () => new Response('bad gateway', { status: 502 })),
    'http-502',
  );
  assert.equal(
    await probe(async () => {
      throw new Error('getaddrinfo ENOTFOUND mcpfinder.dev');
    }),
    'transport',
  );
  assert.equal(
    await probe(async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })),
    'malformed-body',
  );
  // Two passes of the same DNS outage carry different error text and must still
  // sign identically, or the throttle this cause exists to preserve is undone.
  assert.equal(
    await probe(async () => {
      throw new Error(`getaddrinfo EAI_AGAIN attempt ${Math.random()}`);
    }),
    'transport',
  );
  // And the workflow gets the cause as its own output, not buried in `reason`.
  const outputs = stalenessOutputs(
    evaluateSnapshotFreshness({ manifest: { publishedAt: at(30) }, now }),
  );
  assert.equal(outputs.cause, 'age-exceeded');
  assert.equal(outputs.state, 'stale');
  // Every unreadable shape is an alarm, never a silent pass.
  for (const manifest of [null, [], {}, { publishedAt: '' }, { publishedAt: 'soon' }]) {
    assert.equal(evaluateSnapshotFreshness({ manifest, now }).state, 'unreadable');
  }
  assert.equal(
    evaluateSnapshotFreshness({ error: new Error('HTTP 503'), now }).state,
    'unreadable',
  );
  // A pointer stamped in the future is a broken clock, not freshness.
  assert.equal(evaluateSnapshotFreshness({ manifest: { publishedAt: at(-5) }, now }).state, 'unreadable');
  assert.equal(evaluateSnapshotFreshness({ manifest: { publishedAt: at(-0.5) }, now }).state, 'fresh');

  assert.equal(
    snapshotManifestJsonUrl('https://mcpfinder.dev/api/v1/snapshot/'),
    'https://mcpfinder.dev/api/v1/snapshot/manifest.json',
  );
  // An unreachable endpoint is classified, not thrown: the monitor's job is to
  // report, and a crash would be one more silent failure channel.
  assert.deepEqual(
    (
      await checkSnapshotStaleness({
        url: 'https://mcpfinder.dev/api/v1/snapshot/manifest.json',
        sleep: async () => {},
        fetchImpl: async () => {
          throw new Error('getaddrinfo ENOTFOUND');
        },
      })
    ).state,
    'unreadable',
  );
  assert.equal(
    (
      await checkSnapshotStaleness({
        url: 'https://mcpfinder.dev/api/v1/snapshot/manifest.json',
        sleep: async () => {},
        fetchImpl: async () => new Response('nope', { status: 502 }),
      })
    ).state,
    'unreadable',
  );
  {
    const verdict = await checkSnapshotStaleness({
      url: 'https://mcpfinder.dev/api/v1/snapshot/manifest.json',
      now,
      fetchImpl: async (url, init) => {
        assert.equal(init.cache, 'no-store');
        return new Response(JSON.stringify({ publishedAt: at(3) }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    assert.equal(verdict.state, 'fresh');
    assert.equal(verdict.publishedAt, at(3));
  }

  // ─── `publishedAt` is remote input, and is treated as such ──────────────────
  //
  // `Date.parse` accepts parenthesised comments, and those may contain newlines,
  // so a lenient parse plus the plain `key=value` output form let a manifest
  // append outputs of its own — an injected `state=fresh` silences the alarm and
  // makes the clear step close the open issue. Both halves are closed: the
  // timestamp must be an ISO-8601 instant, and every output is written as a
  // heredoc under an unguessable delimiter.
  const injected = 'Aug 27 2026 (\nstate=fresh\n)';
  assert.ok(Number.isFinite(Date.parse(injected)), 'the premise: Date.parse accepts this');
  assert.equal(
    evaluateSnapshotFreshness({ manifest: { publishedAt: injected }, now }).state,
    'unreadable',
  );
  for (const bad of ['2026-08-27', '2026-08-27T12:00:00', 'Aug 27 2026', '2026-08-27T12:00:00Z ']) {
    assert.equal(
      evaluateSnapshotFreshness({ manifest: { publishedAt: bad }, now }).state,
      'unreadable',
      bad,
    );
  }
  for (const good of ['2026-08-27T12:00:00Z', '2026-08-27T12:00:00.123Z', '2026-08-27T14:00:00+02:00']) {
    assert.notEqual(
      evaluateSnapshotFreshness({ manifest: { publishedAt: good }, now }).state,
      'unreadable',
      good,
    );
  }
  {
    // Even if a hostile value reached the writer, it cannot terminate its block.
    // Parsed the way the runner parses $GITHUB_OUTPUT, the injected assignment
    // stays inside the value it came with instead of becoming an output.
    const rendered = formatGithubOutputs({
      state: 'stale',
      published_at: 'x\nstate=fresh\ny',
      reason: 'multi\nline',
    });
    const outputs = parseGithubOutput(rendered);
    assert.deepEqual(Object.keys(outputs).sort(), ['published_at', 'reason', 'state']);
    assert.equal(outputs.state, 'stale', 'the injected state=fresh must not win');
    assert.equal(outputs.published_at, 'x\nstate=fresh\ny');
    assert.equal(outputs.reason, 'multi\nline');
    const delimiters = rendered
      .split('\n')
      .filter((line) => line.includes('<<'))
      .map((line) => line.split('<<')[1]);
    assert.equal(new Set(delimiters).size, 3, 'each value gets its own delimiter');
    for (const delimiter of delimiters) assert.match(delimiter, /^ghadelim_[0-9a-f]{32}$/);
    // A value that guessed the delimiter gets a different one, not a break-out.
    const collide = formatGithubOutputs(
      { state: 'ghadelim_' + '0'.repeat(32) + '\nstate=fresh' },
      {
        randomBytesImpl: (() => {
          let call = 0;
          return () => Buffer.from((call++ === 0 ? '0' : '1').repeat(32), 'hex');
        })(),
      },
    );
    assert.equal(parseGithubOutput(collide).state, 'ghadelim_' + '0'.repeat(32) + '\nstate=fresh');
    assert.throws(() => formatGithubOutputs({ 'state\nreason': 'x' }));
  }

  // ─── One 502 is not evidence that publication stopped ───────────────────────
  //
  // Same ladder as the sibling preflight in verify-snapshot-upload.mjs: without
  // it a DNS blip files a freeze issue the next run closes, which is precisely
  // the cry-wolf churn the generous 18-hour threshold exists to avoid.
  {
    const slept = [];
    let attempts = 0;
    const flaky = await checkSnapshotStaleness({
      url: 'https://example.invalid/manifest.json',
      now,
      sleep: async (ms) => slept.push(ms),
      fetchImpl: async () => {
        attempts += 1;
        if (attempts < 3) return new Response('bad gateway', { status: 502 });
        return new Response(JSON.stringify({ publishedAt: at(3) }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    assert.equal(flaky.state, 'fresh');
    assert.deepEqual(slept, [500, 1_500]);
  }
  {
    // A permanent 4xx is not retried — it is a verdict, not noise.
    let attempts = 0;
    const forbidden = await checkSnapshotStaleness({
      url: 'https://example.invalid/manifest.json',
      now,
      sleep: async () => {},
      fetchImpl: async () => {
        attempts += 1;
        return new Response('nope', { status: 403 });
      },
    });
    assert.equal(forbidden.state, 'unreadable');
    assert.equal(attempts, 1);
  }
  {
    // A hung connection must abort, not sit until the job's timeout-minutes:
    // the alarm step reads this step's outputs, and a step that never finishes
    // produces none.
    const timers = [];
    const hung = await checkSnapshotStaleness({
      url: 'https://example.invalid/manifest.json',
      now,
      retries: 0,
      sleep: async () => {},
      setTimer: (fn, ms) => {
        timers.push(ms);
        fn();
        return 'timer';
      },
      clearTimer: () => {},
      fetchImpl: async (_url, init) => {
        assert.ok(init.signal instanceof AbortSignal, 'every attempt carries an AbortSignal');
        if (init.signal.aborted) throw new Error('The operation was aborted');
        throw new Error('unreachable');
      },
    });
    assert.equal(hung.state, 'unreadable');
    assert.deepEqual(timers, [15_000]);
  }

  // ─── README must describe what actually ships ───────────────────────────────
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  // Absolute developer-machine paths resolve to nothing on GitHub.
  assert.doesNotMatch(readme, /\/Users\//);
  assert.match(readme, /\]\(\.github\/workflows\/snapshot\.yml\)/);
  assert.match(readme, /\]\(\.github\/workflows\/snapshot-staleness\.yml\)/);
  // The README quotes the condition, so it has to be the condition that ships —
  // including the pointer clause that keeps a post-publication stumble out of
  // the freeze thread.
  assert.match(
    readme,
    /`if: \(failure\(\) \|\| cancelled\(\)\) && steps\.manifest-pointer\.outcome != 'success'`/,
  );
  assert.match(readme, /files no issue — it closes an open one/);
  // …and the throttle it promises is the cause-based one.
  assert.match(readme, /judged on the verdict's \*cause\*/);
  assert.match(readme, /actions: read/);
  assert.match(readme, /scripts\/snapshot-freeze-signal\.mjs/);
  assert.match(readme, /raise-unless-fresh/);
  assert.match(
    readme,
    /a single failed 6-hourly cycle is a red Actions run, not a GitHub issue/,
  );
  assert.match(readme, /still fresh under the same 18-hour criterion/);
  // The limits of the mechanism are documented, not glossed over.
  assert.match(readme, /What neither signal covers/);
  assert.match(readme, /\*\*external uptime\n?check\*\*/);

}
