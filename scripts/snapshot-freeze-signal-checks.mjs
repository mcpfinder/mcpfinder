/**
 * The freeze alarm's own failure modes.
 *
 * Two workflows raise this signal, so the things that go wrong are not about
 * GitHub at all: a second thread opened by a race, a thread drowned in 84
 * identical two-hourly restatements, and a signature marker that stops being
 * readable back. Each is pinned here, and the CLI wiring the workflows actually
 * invoke is exercised end to end against a stubbed `gh` binary — never the real
 * repository.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  FREEZE_LABEL,
  FREEZE_TITLE,
  REPEAT_COMMENT_INTERVAL_HOURS,
  clearFreezeSignal,
  decideFreezeComment,
  raiseFreezeSignal,
  raiseFreezeSignalUnlessFresh,
  RAISE_UNLESS_FRESH_STALENESS_PROBE,
  readSignature,
  reconcileFreezeIssues,
  signatureMarker,
} from './snapshot-freeze-signal.mjs';

const execFileAsync = promisify(execFile);

/** A `gh` that answers from a scripted queue and records every invocation. */
function stubGh(responses) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    run: async (file, args) => {
      assert.equal(file, 'gh');
      calls.push(args);
      const next = queue.length > 1 ? queue.shift() : (queue[0] ?? '');
      if (next instanceof Error) throw next;
      return { stdout: typeof next === 'function' ? next(args) : next };
    },
  };
}

function issueList(numbers) {
  return JSON.stringify(numbers.map((number) => ({ number })));
}

function argOf(call, flag) {
  const i = call.indexOf(flag);
  return i === -1 ? null : call[i + 1];
}

export async function runSnapshotFreezeSignalChecks() {
  // ─── The marker is the state store ────────────────────────────────────────
  assert.equal(readSignature(`x ${signatureMarker('staleness:stale')} y`), 'staleness:stale');
  assert.equal(readSignature('an ordinary human comment'), null);
  // A body carrying a newline must still round-trip: the build signal embeds
  // the failing step names, and those are free text.
  assert.equal(readSignature(signatureMarker('build:pointer=none:A, B')), 'build:pointer=none:A, B');

  // ─── Throttling: an unchanged alarm must not restate itself every 2h ──────
  const now = Date.parse('2026-08-27T12:00:00.000Z');
  const ago = (hours) => new Date(now - hours * 3_600_000).toISOString();
  const entry = (signature, hours) => ({ body: signatureMarker(signature), createdAt: ago(hours) });
  assert.equal(REPEAT_COMMENT_INTERVAL_HOURS, 12);
  assert.equal(decideFreezeComment({ signature: 's:stale', entries: [], now }).comment, true);
  // Two hours later, same verdict: silence. This is the ~84-comments-a-week case.
  assert.equal(
    decideFreezeComment({ signature: 's:stale', entries: [entry('s:stale', 2)], now }).comment,
    false,
  );
  // Still alarming after half a day: one heartbeat, so the thread also proves
  // the monitor itself is alive.
  assert.equal(
    decideFreezeComment({ signature: 's:stale', entries: [entry('s:stale', 12.5)], now }).comment,
    true,
  );
  // A changed verdict is new information and bypasses the throttle entirely.
  assert.equal(
    decideFreezeComment({ signature: 's:unreadable', entries: [entry('s:stale', 0.1)], now })
      .comment,
    true,
  );
  // Only the monitor's own comments count as its last word; a human replying on
  // the thread must not extend the quiet window.
  assert.equal(
    decideFreezeComment({
      signature: 's:stale',
      entries: [entry('s:stale', 2), { body: 'looking into it', createdAt: ago(0.1) }],
      now,
    }).comment,
    false,
  );
  // An unreadable timestamp fails open: better a duplicate comment than silence.
  assert.equal(
    decideFreezeComment({
      signature: 's:stale',
      entries: [{ body: signatureMarker('s:stale'), createdAt: 'nonsense' }],
      now,
    }).comment,
    true,
  );

  // ─── Duplicate threads converge on the oldest ─────────────────────────────
  assert.deepEqual(reconcileFreezeIssues([]), { keep: null, duplicates: [] });
  assert.deepEqual(reconcileFreezeIssues([9, 3, 7, 3]), { keep: 3, duplicates: [7, 9] });

  // ─── raise: nothing open yet ──────────────────────────────────────────────
  {
    const gh = stubGh([
      '', // label create
      issueList([]), // list: nothing open
      '', // issue create
      issueList([41]), // re-list after create
    ]);
    const result = await raiseFreezeSignal({
      body: 'the build did not finish',
      signature: 'build:pointer=none:Build snapshot',
      now,
      run: gh.run,
      log: () => {},
    });
    assert.equal(result.action, 'created');
    const create = gh.calls.find((call) => call[0] === 'issue' && call[1] === 'create');
    assert.ok(create, 'a freeze issue must be created when none is open');
    assert.equal(argOf(create, '--title'), FREEZE_TITLE);
    assert.equal(argOf(create, '--label'), FREEZE_LABEL);
    assert.match(argOf(create, '--body'), /the build did not finish/);
    // The marker must ship with the very first body, or the next signal has no
    // state to compare against and comments unconditionally forever.
    assert.equal(
      readSignature(argOf(create, '--body')),
      'build:pointer=none:Build snapshot',
    );
    assert.equal(argOf(gh.calls[0], '--color').length, 6);
  }

  // ─── raise: the create-create race self-heals ─────────────────────────────
  //
  // We won this one: the surviving thread is the one just created here, so it
  // already says what this signal came to say and gets nothing added.
  {
    const gh = stubGh([
      '',
      issueList([]), // both signals saw nothing…
      '', // …so both created
      issueList([12, 15]), // and now there are two
      JSON.stringify({ body: signatureMarker('s:stale'), createdAt: ago(0), comments: [] }),
      '',
      '',
    ]);
    const result = await raiseFreezeSignal({
      body: 'b',
      signature: 's:stale',
      now,
      run: gh.run,
      log: () => {},
    });
    assert.equal(result.number, 12, 'the oldest thread carries the history and survives');
    assert.equal(result.action, 'created');
    assert.equal(
      gh.calls.some((call) => call[1] === 'comment' && call[2] === '12'),
      false,
      'the surviving thread is ours; restating the same body on it is noise',
    );
    const closed = gh.calls.filter((call) => call[0] === 'issue' && call[1] === 'close');
    assert.deepEqual(
      closed.map((call) => call[2]),
      ['15'],
    );
    assert.equal(argOf(closed[0], '--reason'), 'not planned');
  }

  // ─── raise: losing the create race must not lose the diagnostics ──────────
  //
  // The thread that survives is the oldest, which may be the *other* signal's.
  // Closing ours as a duplicate without moving its body over would leave this
  // alarm readable only on a closed issue — the on-call opens #12 and finds no
  // trace of the failure that woke them.
  {
    const gh = stubGh([
      '',
      issueList([]),
      '',
      issueList([12, 15]), // #12 is the winner, and it is not ours
      JSON.stringify({
        body: signatureMarker('build:pointer=none:Build snapshot'),
        createdAt: ago(0),
        comments: [],
      }),
      '',
      '',
      '',
    ]);
    const result = await raiseFreezeSignal({
      body: 'the public manifest is unreadable',
      signature: 'staleness:unreadable:http-502',
      now,
      run: gh.run,
      log: () => {},
    });
    const moved = gh.calls.find((call) => call[1] === 'comment' && call[2] === '12');
    assert.ok(moved, 'the losing signal must carry its body to the surviving thread');
    assert.match(argOf(moved, '--body'), /the public manifest is unreadable/);
    assert.equal(readSignature(argOf(moved, '--body')), 'staleness:unreadable:http-502');
    // …and the returned value must describe that, not claim a thread that is
    // about to be closed as a duplicate.
    assert.equal(result.action, 'commented');
    assert.equal(result.number, 12);
    assert.match(result.reason, /create race/);
    assert.deepEqual(
      gh.calls.filter((call) => call[1] === 'close').map((call) => call[2]),
      ['15'],
    );
  }

  // ─── raise: open thread, unchanged verdict, two hours later ───────────────
  {
    const gh = stubGh([
      '',
      issueList([7]),
      JSON.stringify({
        body: signatureMarker('staleness:stale'),
        createdAt: ago(2),
        comments: [],
      }),
    ]);
    const result = await raiseFreezeSignal({
      body: 'still stale',
      signature: 'staleness:stale',
      now,
      run: gh.run,
      log: () => {},
    });
    assert.equal(result.action, 'throttled');
    assert.equal(
      gh.calls.some((call) => call[1] === 'comment'),
      false,
      'an unchanged alarm must add no comment',
    );
  }

  // ─── raise: open thread, the verdict changed ──────────────────────────────
  {
    const gh = stubGh([
      '',
      issueList([7]),
      JSON.stringify({
        body: signatureMarker('staleness:stale'),
        createdAt: ago(0.5),
        comments: [],
      }),
      '',
    ]);
    const result = await raiseFreezeSignal({
      body: 'now unreadable',
      signature: 'staleness:unreadable',
      now,
      run: gh.run,
      log: () => {},
    });
    assert.equal(result.action, 'commented');
    const comment = gh.calls.find((call) => call[0] === 'issue' && call[1] === 'comment');
    assert.equal(comment[2], '7');
    assert.equal(readSignature(argOf(comment, '--body')), 'staleness:unreadable');
  }

  // ─── clear: every open thread is commented on and closed ──────────────────
  {
    const gh = stubGh([issueList([3, 4]), '', '', '', '']);
    const result = await clearFreezeSignal({
      body: 'publication resumed',
      run: gh.run,
      log: () => {},
    });
    assert.deepEqual(result.closed, [3, 4]);
    assert.deepEqual(
      gh.calls.filter((call) => call[1] === 'close').map((call) => argOf(call, '--reason')),
      ['completed', 'completed'],
    );
  }

  // ─── raise-unless-fresh: a still-fresh manifest is a red X, not an issue ──
  {
    const gh = stubGh(['should not be called']);
    const lines = [];
    const result = await raiseFreezeSignalUnlessFresh({
      body: 'the build did not finish',
      signature: 'build:pointer=none:Build snapshot',
      staleness: { state: 'fresh', reason: 'the published snapshot is 4.4h old' },
      now,
      run: gh.run,
      log: (line) => lines.push(line),
    });
    assert.equal(result.action, 'skipped-fresh');
    assert.equal(result.reason, 'the published snapshot is 4.4h old');
    assert.equal(gh.calls.length, 0, 'a fresh publishedAt must not call gh, including to clear');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[snapshot-freeze\] not raising: the published snapshot is 4.4h old/);
  }

  {
    const gh = stubGh([
      '',
      issueList([]),
      '',
      issueList([41]),
    ]);
    const result = await raiseFreezeSignalUnlessFresh({
      body: 'the build did not finish',
      signature: 'build:pointer=none:Build snapshot',
      staleness: { state: 'stale', reason: 'the published snapshot is 19h old' },
      now,
      run: gh.run,
      log: () => {},
    });
    assert.equal(result.action, 'created');
    assert.ok(gh.calls.find((call) => call[0] === 'issue' && call[1] === 'create'));
  }

  {
    const gh = stubGh([
      '',
      issueList([]),
      '',
      issueList([42]),
    ]);
    const result = await raiseFreezeSignalUnlessFresh({
      body: 'the public manifest is unreadable',
      signature: 'build:pointer=none:Build snapshot',
      staleness: { state: 'unreadable', reason: 'HTTP 502' },
      now,
      run: gh.run,
      log: () => {},
    });
    assert.equal(result.action, 'created');
    assert.ok(gh.calls.find((call) => call[0] === 'issue' && call[1] === 'create'));
  }

  {
    const gh = stubGh([
      '',
      issueList([]),
      '',
      issueList([43]),
    ]);
    const lines = [];
    const result = await raiseFreezeSignalUnlessFresh({
      body: 'the build did not finish',
      signature: 'build:pointer=none:Build snapshot',
      staleness: async () => {
        throw new Error('getaddrinfo ENOTFOUND mcpfinder.dev');
      },
      now,
      run: gh.run,
      log: (line) => lines.push(line),
    });
    assert.equal(result.action, 'created');
    assert.match(lines[0], /\[snapshot-freeze\] raising anyway: probe failed \(getaddrinfo ENOTFOUND mcpfinder.dev\)/);
    assert.ok(gh.calls.find((call) => call[0] === 'issue' && call[1] === 'create'));
  }

  {
    const gh = stubGh(['should not be called']);
    const result = await raiseFreezeSignalUnlessFresh({
      body: 'the build did not finish',
      signature: 'build:pointer=none:Build snapshot',
      staleness: async () => ({ state: 'fresh', reason: 'the published snapshot is 4.4h old' }),
      now,
      run: gh.run,
      log: () => {},
    });
    assert.equal(result.action, 'skipped-fresh');
    assert.equal(gh.calls.length, 0);
  }

  // ─── The CLI the workflows actually invoke, against a stubbed `gh` ────────
  const dir = await mkdtemp(join(tmpdir(), 'mcpfinder-freeze-gh-'));
  try {
    // Extensionless stub next to a CommonJS package.json, so `require` works
    // regardless of this repository's own module type.
    await writeFile(join(dir, 'package.json'), '{"type":"commonjs"}');
    await writeFile(join(dir, 'list.json'), issueList([]));
    await writeFile(
      join(dir, 'gh'),
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        'const args = process.argv.slice(2);',
        "fs.appendFileSync(process.env.GH_STUB_LOG, JSON.stringify(args) + '\\n');",
        "if (args[0] === 'issue' && args[1] === 'list') {",
        "  process.stdout.write(fs.readFileSync(path.join(process.env.GH_STUB_DIR, 'list.json'), 'utf8'));",
        '}',
        '',
      ].join('\n'),
    );
    await chmod(join(dir, 'gh'), 0o755);
    const log = join(dir, 'calls.log');
    await writeFile(log, '');
    const body = 'line one\nline two — with an em dash and `backticks`';
    await execFileAsync(process.execPath, ['scripts/snapshot-freeze-signal.mjs', 'raise'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GH_STUB_LOG: log,
        GH_STUB_DIR: dir,
        FREEZE_BODY: body,
        FREEZE_SIGNATURE: 'cli:test',
      },
    });
    const calls = (await readFile(log, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const created = calls.find((call) => call[0] === 'issue' && call[1] === 'create');
    assert.ok(created, 'the CLI must reach `gh issue create`');
    assert.equal(argOf(created, '--title'), FREEZE_TITLE);
    // Multi-line bodies survive the env → argv handoff intact: they are passed
    // as one argument, never through a shell.
    assert.match(argOf(created, '--body'), /line one\nline two/);
    assert.equal(readSignature(argOf(created, '--body')), 'cli:test');

    // `clear` needs no signature and closes what the stub reports as open.
    await writeFile(join(dir, 'list.json'), issueList([99]));
    await writeFile(log, '');
    await execFileAsync(process.execPath, ['scripts/snapshot-freeze-signal.mjs', 'clear'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GH_STUB_LOG: log,
        GH_STUB_DIR: dir,
        FREEZE_BODY: 'resumed',
      },
    });
    const clearCalls = (await readFile(log, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      clearCalls.filter((call) => call[1] === 'close').map((call) => call[2]),
      ['99'],
    );

    // raise-unless-fresh against a local fresh manifest must not call gh.
    const publishedAt = new Date().toISOString();
    const server = createServer((req, res) => {
      if (req.url === '/manifest.json' || req.url?.endsWith('/manifest.json')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ publishedAt }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      await writeFile(log, '');
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ['scripts/snapshot-freeze-signal.mjs', 'raise-unless-fresh'],
        {
          cwd: new URL('..', import.meta.url).pathname,
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            GH_STUB_LOG: log,
            GH_STUB_DIR: dir,
            FREEZE_BODY: 'build did not finish',
            FREEZE_SIGNATURE: 'cli:fresh',
            MCPFINDER_SNAPSHOT_BASE_URL: `http://127.0.0.1:${port}`,
          },
        },
      );
      assert.match(`${stdout}\n${stderr}`, /\[snapshot-freeze\] not raising:/);
      const freshCalls = (await readFile(log, 'utf8')).split('\n').filter(Boolean);
      assert.equal(freshCalls.length, 0, 'a fresh publishedAt must not call gh');
    } finally {
      server.close();
    }

    // An unknown action is a hard error, not a silent no-op: a typo in the
    // workflow must not look like a delivered alarm.
    await assert.rejects(
      execFileAsync(process.execPath, ['scripts/snapshot-freeze-signal.mjs', 'shout'], {
        cwd: new URL('..', import.meta.url).pathname,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_STUB_LOG: log, GH_STUB_DIR: dir, FREEZE_BODY: 'x' },
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // The build workflow's CLI action is pinned here so a rename cannot leave
  // snapshot.yml calling a switch that no longer exists. The function tests
  // above cover behaviour; this does not fetch mcpfinder.dev.
  const freezeSource = await readFile(new URL('./snapshot-freeze-signal.mjs', import.meta.url), 'utf8');
  assert.match(freezeSource, /if \(action === 'raise' \|\| action === 'raise-unless-fresh'\)/);
  assert.deepEqual(RAISE_UNLESS_FRESH_STALENESS_PROBE, { retries: 1, timeoutMs: 5_000 });
  assert.match(freezeSource, /checkSnapshotStaleness\(RAISE_UNLESS_FRESH_STALENESS_PROBE\)/);
}
