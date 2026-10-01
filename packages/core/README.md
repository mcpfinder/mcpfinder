# @mcpfinder/core

> Shared library for MCPfinder: multi-registry sync, SQLite+FTS5 search, trust-signal enrichment, and install-config generation.

[![npm](https://img.shields.io/npm/v/@mcpfinder/core.svg)](https://www.npmjs.com/package/@mcpfinder/core)
[![license](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](https://www.gnu.org/licenses/agpl-3.0.en.html)

This is the internal library that powers [`@mcpfinder/server`](https://www.npmjs.com/package/@mcpfinder/server)
— the MCP server that discovers and installs other MCP servers from the
Official MCP Registry, Glama, and Smithery.

Most users should install `@mcpfinder/server`, not this package directly.
Use `@mcpfinder/core` only when you want to embed the search/enrichment engine
into a custom tool (e.g. a web UI, a bot, or a batch job).

## Install

```bash
npm install @mcpfinder/core
# or
pnpm add @mcpfinder/core
```

Node.js 22.15+ required (built-in `node:sqlite`, no native build step).

## Quick start

```ts
import {
  initDatabase,
  syncOfficialRegistry,
  syncGlamaRegistry,
  syncSmitheryRegistry,
  searchServers,
  getServerDetails,
} from '@mcpfinder/core';

const db = initDatabase(); // stores in ~/.mcpfinder/data.db by default

// Keep this order: each later registry's dedup index sees earlier inserts.
// A failed source is reported without preventing the remaining attempts.
for (const [source, sync] of [
  ['Official', syncOfficialRegistry],
  ['Glama', syncGlamaRegistry],
  ['Smithery', syncSmitheryRegistry],
] as const) {
  try {
    await sync(db);
  } catch (error) {
    console.error(`${source} sync failed`, error);
  }
}

const results = searchServers(db, 'postgres', 5);
for (const r of results) {
  console.log(r.name, r.confidenceScore, r.warningFlags);
}

const detail = getServerDetails(db, results[0].name);
```

## Snapshot bootstrap (fast cold start)

Skip the ~10 minute live sync by downloading a prebuilt snapshot:

```ts
import { bootstrapFromSnapshot } from '@mcpfinder/core';

await bootstrapFromSnapshot(); // downloads from https://mcpfinder.dev/api/v1/snapshot
```

`bootstrapFromSnapshot` never rejects — transport, filesystem, and verification
failures all come back as `{ ok: false, reason }`, so a caller running before an
MCP handshake cannot be killed by an unhandled rejection. The manifest request
uses a short absolute timeout; the DB download uses an *inactivity* budget
instead, aborting only after a stretch with no bytes received, so a slow but
healthy link is not cut off — identically for both compressions. `onProgress(bytes, total)`
reports transfer progress (`total` is the selected artifact's size); a throw
from it is swallowed, never escaping the stream handler.

### Two artifacts, one identity

The manifest publishes the same database gzipped and brotli-compressed:

```jsonc
{
  "sha256": "<gz digest>",     // the snapshot's identity
  "sizeBytes": 46706108,
  "url": "data.sqlite.gz?sha=<gz digest>",
  "brotli": { "url": "data.sqlite.br?sha=<br digest>", "sha256": "<br digest>", "sizeBytes": … }
}
```

Brotli is roughly 21% smaller — 36.8MB against 46.7MB gzip for the 238MB
database published on 2026-08-26 — and both sizes track the corpus, so read
them from the manifest rather than from any figure quoted here.
Behaviour:

- **`sha256` is the snapshot identity, always the gz digest.** It is what the
  pointer records and what every freshness check compares, whichever artifact
  was downloaded. `manifest.brotli.sha256` verifies downloaded bytes and
  nothing else.
- **`brotli` is optional both ways.** A manifest without it (anything published
  before brotli support) uses gzip; a malformed `brotli` block — bad digest, non-positive
  size, missing URL — is dropped by `fetchSnapshotManifest` rather than
  rejecting the manifest.
- **Brotli is preferred but never load-bearing.** A 404, transport error,
  corrupt stream or digest mismatch falls back to gzip and the bootstrap still
  succeeds; only the reason string of a total failure mentions both attempts.
  `MCPFINDER_SNAPSHOT_NO_BROTLI=1` opts out entirely.
- **The pointer's `etag` describes the gz object**, so it is replayed as
  `If-None-Match` only against the gz artifact, and a brotli install records no
  ETag rather than a validator for other bytes. It is also replayed only while
  the file it validates is still on disk: a validator claims "I already hold
  these bytes", and sending one on the repair path below — where we hold
  nothing — invites a truthful 304 that leaves nothing to install.
- **Artifact URLs may not leave the configured base.** Both `url` and
  `brotli.url` are resolved against `baseUrl` (`MCPFINDER_SNAPSHOT_BASE`) and an
  absolute URL is honoured only while it stays inside it. The digest that would
  catch substituted bytes comes from the same document as the URL, so it cannot
  vouch for the origin; the base URL is what does. An out-of-base `brotli.url`
  is skipped, an out-of-base `url` fails the bootstrap with
  `manifest-url-rejected`.
- **Decompression is size-bounded.** The bytes land on disk before the digest
  can be checked, so each artifact is capped at 1.5× the manifest's
  `rawSizeBytes` (or 50× the compressed size when a pre-`rawSizeBytes` manifest
  omits it), never below 16MB. Exceeding it aborts the attempt exactly like a
  corrupt stream — a fallback for brotli, a failed bootstrap for gzip. zlib's
  own `maxOutputLength` is not used: on a stream it caps a single output buffer,
  not the total.

The manifest's `sha256` is **mandatory** and must be a 64-character hex digest.
A manifest without one is rejected outright (`manifest-fetch-failed`) and the DB
is never fetched — unverifiable bytes are worse than no update.

### Versioned files, one pointer

Nothing is ever overwritten in place. A user normally runs several MCP clients
at once and each starts its *own* mcpfinder process against the same data dir,
so replacing `data.db` under them would unlink a peer's `-wal` without a
checkpoint (losing its committed rows) and would simply fail on Windows. Instead:

- the verified download becomes a new immutable file named after its digest,
  `data-<sha256[0:16]>.db`, written to a temp file first and promoted only after
  the checksum matches;
- a small pointer file, `<db>.snapshot.json`, records which file is current
  along with its provenance (`dbFile`, `sha256`, `publishedAt`, `etag`,
  `installedAt`, `checkedAt`). It is updated by writing beside it and renaming —
  atomic, and safe because nobody holds a pointer file open.

`resolveCurrentDbPath(nominalDbPath)` turns the nominal `<data-dir>/data.db`
into the file to open. Existing installs have no pointer or a pointer without
`dbFile`: their `data.db` is treated as the current database and is never
renamed, deleted or rewritten — it simply stays current until the first
successful download produces a versioned file for the pointer to move to.

`activate(dbPath)` is awaited after the new file is in place, with its path —
the hook where a caller opens the new database and retires its old handle. It
runs *before* the pointer is written, so a throw leaves the pointer on the
previous snapshot and the caller's existing handle untouched
(`activate-failed`). It is called again, with a different path, in one case
only: the install adopted a file a peer had put there and that file turned out
to have been swept out from under the switch (see [Retention](#retention)) — so
a caller must be able to take up a new path more than once per install. Nearly
always that means twice; a repair whose fresh variant name collides with a
peer's copy repeats the check on the new name, up to a small fixed cap.

Promotion to the sha-named file uses `link` + `unlink`, not `rename`: `link`
fails with `EEXIST` atomically instead of replacing, so two installers of the
same digest cannot strand each other on a ghost inode — the loser adopts the
file already there, once that file has proved it really is this snapshot, and
keeps its own download in hand until the caller has opened it (see
[Retention](#retention)). On filesystems without hard links (FAT/exFAT, some
network mounts) this falls back to `rename`, which is atomic but *not*
exclusive; there the check-then-rename window remains.

`publishSnapshotState` stands down for the pointer already in force in two
cases, both reported as `{ status: 'superseded' }`:

- **A newer snapshot.** A strictly newer `publishedAt` is never overwritten, so
  a process that started downloading an older snapshot before a peer installed a
  newer one cannot roll the data dir back and send everyone off to re-download
  45MB. That holds for a pointer **without** `dbFile` too — the pre-versioning
  shape. It stands for the legacy `data.db`, or for the versioned file of its own
  digest once one exists, and is ordered against whichever of those is actually
  on disk; skipping the comparison for it, as an earlier version did, let a
  *staler* snapshot overwrite a perfectly good pointer. Equal timestamps with
  different digests are broken by digest, so every peer picks the same winner.
- **The same digest in a different file.** Here `publishedAt` does *not* decide:
  a pointer naming a surviving file wins outright, however new the candidate
  claims to be. Repointing between two copies of one digest buys identical bytes
  while taking the file every peer is already serving from out of the sweep's
  protection. Re-stating the pointer already in force is not this case and keeps
  working — it is how `checkedAt` gets stamped.

So the pointer does not only move forward: on equal digests it prefers *staying
put*. What it never does is move to older data.

Both guards defer to a file that exists at the moment they look, which is
check-then-act against a `sweepSnapshotFiles` pass in another process. The
decision is therefore taken twice, pointer re-read included — enough to catch a
peer that has moved on, and a sweep that has already finished — but the window is
narrowed, not closed: a pass that read a file's mtime before the pointer came to
name it can unlink it afterwards, however many times we look. The residual
outcome is a pointer naming a file that is gone while an identical copy sat
unselected, and it is not terminal: the caller runs its own verified file, and
the next refresh refuses to call a pointer with no file at it up to date, so it
installs again and repairs the pointer — holding no file, it also sends no
`If-None-Match`, so that repair is a download and not a revalidation that could
answer 304 and install nothing. Losing the ordering race is likewise
cheap — the events being ordered are minutes to hours apart while the window is
milliseconds, and the loser keeps serving valid data until its next refresh.

**A file at the pointer's name is not evidence that the pointer is good.** Both
guards above once stood down for anything non-empty at that name, and that is
the same mistake the byte comparison below fixed one layer down. `initDatabase`
recreates any name it is handed as a schema-only database, so a file a sweep
unlinked out from under a peer comes back at the same name, non-empty, wearing a
verified digest — and this process's own `activate` is one of the things that
puts it back, on the way to discovering the substitution. Deferring to it is
what turns a recoverable race into a permanent wedge: the caller has already
repaired onto a file of its own and is publishing to say so, the pointer stays
on the stand-in, every later refresh reads a matching digest behind an existing
file and calls it up to date, and the sweep exempts that file at any age for
being current. The data dir serves an empty catalogue until a new digest is
published.

So the pointer is asked to show what it promises. `serverCount` comes from the
manifest for exactly those bytes, and a file at the pointer's name with no
servers in it at all cannot be that snapshot. The same predicate gates the
publish guards and the refresh's "already up to date" answer — a partial fix at
either site alone still wedges — and it is deliberately narrow:

- it accuses only on **demonstrably empty**, never on "suspiciously small". A
  genuine snapshot's rows are in its main file from the moment it is installed
  (a hard link to a fully materialised download), so it never reads as empty —
  including a legitimately *tiny* one, where the row is the whole difference:
  SQLite rounds a one-server catalogue and an empty stand-in up to the very same
  whole pages, so a length comparison could not tell them apart.
- a file it could not open, that is not SQLite, that has no `servers` table, or
  that was torn under the read, is **no verdict at all** and leaves the previous
  behaviour exactly as it was. So does a pointer that never recorded a
  `serverCount` — it promised nothing, and keeps the old treatment until an
  install replaces it. That last case is a known, accepted gap rather than a
  covered one: such a pointer stays wedgeable exactly as it was before this
  check existed. No path writes one today (`bootstrapFromSnapshot` always
  records the manifest's count), so the exposure is to pointers left by older
  versions and shrinks to nothing as they are replaced.
- the repair is a **repoint, never a delete**. The stand-in may be a peer's live
  database for all this process knows; it is refused by everything and reclaimed
  by the sweep on the ordinary clock.

The probe opens the file `immutable=1`, which matters more than it sounds: a
plain read-only open of a WAL-mode database *creates* its `-wal` and `-shm`, and
a read-only connection cannot remove them again. Nothing here ever deletes a
journal, so such a probe would poison the name for good — `promoteDownload`
reads stranded sidecars as "this name is taken" and sends every future install
of that digest to a variant. `immutable=1` takes no locks, builds no
shared-memory index, and creates nothing; it costs one open and one `LIMIT 1` on
a primary-key table, once per publish and once per refresh.

A pointer write that *fails* is reported (`pointer-write-failed`), never
swallowed: activation has already happened, so the caller must know the data dir
still selects the old file.

**What is and is not guaranteed.** A reader never observes a half-written or
vanished database: it opens a file that is complete before it is named. A file
another process is serving may well be *deleted* under it, and that is fine —
on POSIX an open file keeps working against its inode. What would not be fine
is losing its `-wal`/`-shm`, which SQLite reaches for by name, so those are
never removed while the database is there — and, once it is gone, only after
weeks (see [Retention](#retention)). The accepted trade-off is on the
write side — when process A switches to a newer snapshot, process B keeps
writing live sync results into the older file, and those writes are dropped when
B switches too. The published snapshot is the source of truth for the catalog,
so a dropped incremental crawl only costs a later re-sync.

### Retention

Superseded files are ~230MB unpacked, so `sweepSnapshotFiles(nominalDbPath)`
reclaims them. Two rules for what may go, and one absolute prohibition:

1. the pointer must not select it — the current database is never a candidate,
   at any age;
2. it must have been untouched for the full grace period
   (`MCPFINDER_SNAPSHOT_RETAIN_HOURS`, default 48). Sidecar mtimes count
   towards that, so a peer that is actively writing keeps its file young;
3. **a `-wal`/`-shm` is never unlinked.** Not alongside its database, not once
   the database is gone, not at any age. A peer that still has the database
   open is unaffected by losing the *name* — it holds the inode — but it looks
   its `-wal`/`-shm` up by name every time, so pulling those out from under it
   is precisely the corruption this layout exists to prevent.

Rule 3 used to be justified by the claim that sidecars are "kilobytes against
the ~230MB the database costs". That claim was wrong, and is retracted. A
registry crawl is applied as a **single transaction** — deliberately, so a
partial crawl can never land — which means the WAL grows to the size of the
entire write and stays that big until something checkpoints or closes the
database. Measured on a real install, before anything trimmed it:

```
~/.mcpfinder/data.db      323 MB
~/.mcpfinder/data.db-wal   40 MB
~/.mcpfinder/data.db-shm    1 MB
```

**Orphaned journals are not collected.** A `-wal`/`-shm` whose database file is
already gone looks exactly like the journal of a peer that is still running
against a file swept from under it, and unlinking the second one is corruption.
There is no age at which that ambiguity resolves — a peer that last wrote three
weeks ago may still be alive — so the sweep simply never touches a sidecar, and
the leak is documented rather than papered over.

What makes that acceptable is that the residue is now far smaller than the
numbers above. Every **successful** registry sync ends with
`PRAGMA wal_checkpoint(TRUNCATE)` (`checkpointWal`), which folds the journal back
into the database and truncates it to zero; the 40MB was measured precisely
because nothing ever trimmed it. This does not change the crawl's atomicity —
the truncation happens after the commit. A caller that knows it is finished with
a handle closes it explicitly through `closeDatabase` (checkpoint, then close),
which removes the journal outright; `catalog.ts` does that when it retires a
superseded handle. The library installs no `exit`/`SIGINT`/`SIGTERM` hooks of its
own — a library has no business changing a host application's signal
disposition — so what survives a process killed with `SIGKILL`, which is how MCP
clients usually stop stdio servers, is whatever accumulated since the last
checkpoint. That is the remaining, bounded leak.

Abandoned partial downloads are reclaimed on a shorter clock
(`MCPFINDER_SNAPSHOT_DOWNLOAD_STALE_HOURS`, default 6), which is what keeps a
peer's in-flight download safe. A superseded legacy `data.db` is eligible under
the same rules.

Two consequences worth knowing:

- **Removal can fail, and that is an ordinary outcome, never an error.**
  Whether unlinking a file another process holds open succeeds depends on the
  platform, the filesystem, and the share mode every one of those holders used;
  it is not worth predicting here, and nothing in this design depends on the
  answer. Either the name goes away while the peer keeps reading the object it
  already opened, or the file stays and a later sweep reclaims it once nothing
  holds it.
- **Sidecars can outlive their database.** A `data-<sha16>.db-wal` with no
  `data-<sha16>.db` beside it is the expected footprint of a swept file whose
  holder is still running. It is left alone for the whole orphan window above
  and only then reclaimed.

That second one has a sharp edge, because names come from digests and therefore
recur: a snapshot swept months ago can be published again under the same name.
Installing onto it would mean opening somebody else's journal as our own, and
deleting that journal is not an option either. So `promoteDownload` checks for
stranded sidecars at the target name and, when it finds them, installs to a
**variant name** — `data-<sha16>-<rand6>.db` — returning the name it actually
used so the pointer records the right one. Variant files are ordinary snapshot
files: the sweep reclaims them under the same rules. The pre-existing behaviour
is unchanged where the *database* is already there — the loser of a race adopts
the winner's file rather than overwriting it.

**The nominal `data.db` needs the same guard**, and gets it. Once a superseded
legacy `data.db` has been swept, its journal stays behind for its owner, and
anything that reopens *that* name — a client running an older release, or the
current code falling back to it after the pointer is deleted — would create a
fresh database beside a journal belonging to somebody else. (Verified locally:
SQLite maps the stale `-shm` by name and unlinks the abandoned `-wal` on close.)
So `resolveCurrentDbPath` refuses the nominal name when there is no database at
it but a journal is sitting there, and resolves to a variant — `data-<rand6>.db`,
the same mechanism `promoteDownload` uses — instead. The choice is made once per
process and remembered, so whoever opens the database and the sweep that decides
what is current cannot disagree. It costs one small, sweepable empty database
per process in that state, until a successful download writes a pointer that
names a file again.

Because the suffix is random, a variant name is not something a second peer can
guess. `promoteDownload` therefore scans the directory for a variant already
carrying the same digest and adopts a usable one before drawing a suffix of its
own — otherwise every peer meeting the same stranded journal writes an
independent full copy (`data-<sha>-p4kpz3.db` beside `data-<sha>-yk9r6t.db`).
Once a candidate has proved itself (below), adoption also touches its mtime,
because the sweep decides by mtime and the file being taken up is exactly the
one it would otherwise consider a leftover — in that order, so a candidate that
is refused is not also made unsweepable. `publishSnapshotState` backs this up: on equal digests a pointer
naming a file that is still there wins the tie outright, so the data dir is not
repointed from one copy of a digest to another while both are present — but two
publishers can still both read the same predecessor and rename their pointers in
sequence, so that is a strong preference, not an exclusion.

**A name is a candidate; the bytes behind it are the claim.** Adoption is what
lets a peer skip a second full download, and it used to rest entirely on the
file name: the digest prefix in `data-<sha16>.db` or `data-<sha16>-<rand6>.db`
was taken as evidence of what was inside. It is not. The sweep can unlink a file
while a peer still has it open, and `initDatabase` recreates any name it is
handed as an empty schema-only database — so a ~53KB stand-in ends up wearing a
verified digest in its name, and the next peer to adopt it activates a 0-server
catalogue whose pointer and digest both look perfectly healthy, right down to
its next refresh answering `snapshot-up-to-date`.

So every adoption site now asks the candidate to match the verified download the
installer is still holding: the same length, and the same bytes across windows
sampled at the start, the middle and the end (a file smaller than one window is
compared in full). Re-hashing 230MB would be proof; this is not, and does not
claim to be — it is the cheapest check that rules out everything that could
plausibly be sitting at one of these names, a stand-in database, a truncated
copy, a half-written one. The verified download is the reference rather than the
manifest's `sizeBytes`, which describes the *compressed* artifact; nothing has
to be passed in.

**That comparison has three answers, not two.** A `stat` that fails for a reason
other than "there is nothing there", a file that will not open, a read that
comes back short of what `stat` promised — an `EMFILE` under load, an `EIO`, a
network mount that blinked mid-read of a ~230MB file — none of those are
evidence about the bytes, so the comparison reports *indeterminate* rather than
"differs", and each caller decides what that means for it. `adopt` and the
variant claim want a positive match and get none, so they decline: the cost is
one more download, and declining also means the variant's mtime is not touched,
so a file we refused does not have its retention clock restarted.

No caller on this path spends that verdict on *destroying* anything, and there
is no longer one that could: the function that unlinked a stand-in was removed
once the sweep was shown to reclaim the same files on the ordinary retention
clock (see "replaced, never destroyed" below). What is left is a distinction
nobody currently needs, kept deliberately rather than collapsed — because it is
what these functions can honestly report, and because flattening it is exactly
what would make the next destructive caller easy to write and wrong. A momentary
`EMFILE`, an `EIO`, or a network mount that blinked while reading a peer's
genuine ~230MB snapshot must never read as proof that the file is a stand-in.

**And the download is kept until the adopted file is proved real.** The `utimes`
above only restarts the retention clock for sweeps that read the mtime *after*
it; a pass already walking the directory read it before and can unlink the file
at any point up to the end of that walk — the window is the whole in-flight
pass, not a millisecond. That used to be unrecoverable, because adoption
discarded the verified copy. So `promoteDownload` no longer consumes the temp
file on any path that adopts somebody else's file: it hands it back as `temp`,
and `bootstrapFromSnapshot` releases it only after `activate` has returned.
Before activating it **pins the adopted file open**, and afterwards it asks the
one question a pin can answer: **does this name still resolve to the object I
pinned?** Presence alone proves nothing after the fact, since the name is
occupied either way once `initDatabase` has run. Nor do the bytes, for the
reason above — the caller's own first write can rewrite them legitimately, and a
byte comparison here would call that a substitution and delete a live database.
Nor does a bare inode number: ext4 allocates inode numbers from a free list and
hands a just-freed one straight back to the next create at the same name, so an
identity comparison that works on APFS detects nothing at all on Linux. An
*open descriptor* is what closes that gap. POSIX frees an inode only once its
link count is zero **and** no descriptor refers to it, so while the pin is held
the number cannot be recycled: a sweep's `unlink` takes the name away but not
the object, and whatever is created at that name next is necessarily a different
file. Held open, the number is an identity — which makes the guard positive
about replacement and deliberately blind to writes.

The pin is also where the bytes are established, and the order is the point.
`promoteDownload` has already compared the candidate against the verified
download — but it did that through the *name*, and a sweep plus a peer's
`initDatabase` can put a different file at that name before the pin's `open`.
Pinning something already verified therefore pins whatever is there now, and
every later question is then answered faithfully about the stand-in: identity is
stable across `activate`, the guard says "still the object I pinned", and the
process serves an empty catalogue. So the comparison is taken **after** the
descriptor is in hand and **through** that descriptor, never by re-opening the
name, which would only move the window. Once the handle is held the object
behind it cannot be swapped, so those three 64KB reads bind the pin to verified
bytes for the whole life of the pin — a cost paid once per adoption, on a path
that has just moved ~230MB.

Anything short of a positive match means the caller may have opened a stand-in,
`indeterminate`, "could not pin it at all" and "the pinned bytes are not the
snapshot's" included — this is the one place that treats "could not tell" as a
reason to repair, because repairing unnecessarily costs a `link` of bytes
already on the disk while trusting wrongly leaves a live process serving an
empty catalogue. The retained copy is then installed under a fresh variant name
and activated instead. That is a name nothing else has ever seen, so no sweep
can be part-way through removing it — and in the event that it *is* taken, by a
suffix collision with a peer's copy of these very bytes, the temp is handed back
again and the same check runs on the new name, bounded by a hard cap on passes.

The stand-in left behind is replaced, never destroyed. Unlinking it looks tidier
and is the one thing on this path that can cost a peer its database: a peer
re-installing genuine bytes at a variant name we happened to draw is positive on
the identity check *and* on a byte comparison — a different inode, and moved
bytes because its own commit checkpointed its WAL into the main file — so no
number of positive answers tells it apart from a stand-in. Leaving it is bounded
instead: `adopt` and `claimVariant` both refuse it, `claimVariant` refuses it
*before* its `utimes` so nothing refreshes its retention clock, and
`sweepSnapshotFiles` reclaims it on the ordinary grace. That ordering is what
made the deletion unnecessary; before it, every passing peer touched a stand-in
it had just refused and the sweep could never age it out.

The guard does not assume a platform where unlinking an open file fails. Treat
the substitution as possible everywhere and the guard still answers, because
what it rests on is narrower than unlink semantics: an open handle keeps
the MFT record referenced, so the file ID cannot be recycled and a new file at
that name necessarily reports a different one. A filesystem reporting no
meaningful `dev`/`ino` reports the same meaningless pair twice, degrading the
check to "the name still resolves to a regular file". What the pin is blind to,
plainly: any change to the *contents* of the file it holds after the pin is
taken. Nothing on this path writes to a peer's database except the peer and the
caller we handed it to, so that blindness is the intended trade — but it is a
trade, and a corrupting writer at the same inode would go unnoticed here.

What is left is a repair, not a race: the caller may momentarily open an empty
database, and on a crash or an unlink the filesystem refused one abandoned empty
file may be left at the swept name — refused by every peer, and reclaimed by the sweep on
the usual clock once nothing touches it.

The sidecar probe in `promoteDownload` is still check-then-act, and so is the
variant scan. The canonical name is re-checked immediately before committing to
a variant, so a peer that installs it inside the window is normally adopted
rather than duplicated; the remaining gap is the few syscalls before `link`, and
losing it costs a second full copy of identical bytes under a variant name,
which the sweep reclaims on the usual clock. Closing any of this properly would
need a lock file, whose failure mode (a stuck lock from a killed process) is
worse than the one it removes.

### Refresh

Pass `refresh: true` to re-check an install. When the manifest's `sha256`
matches the pointer's *and the pointer's own file is still there and still holds
the catalogue it promises*, the call
returns `{ ok: false, reason: 'snapshot-up-to-date' }` after a **single**
manifest request — the DB endpoint is not touched. A pointer naming a file that
has gone — or one that came back as a schema-only stand-in, which is the same
event seen a moment later — is deliberately **not** up to date, whatever its
digest says:
`resolveCurrentDbPath` has fallen back to the nominal `data.db`, which is at
best an older database and at worst the empty one `initDatabase` created there
on the way past, and accepting the digest match would wedge the data dir — every
later check would match too, so nothing would ever install again until a new
digest was published. Re-installing costs one download and repairs the pointer,
which is what makes the pointer races above self-healing — and that repair
therefore never sends a validator, because a 304 would be an answer about bytes
it does not have and would wedge the data dir just as thoroughly.
When it differs, a **second** request
is made for the DB. Whether it is conditional depends on the artifact: the gz
request replays the pointer's ETag as `If-None-Match` — provided the pointer's
own file is still there — while a brotli request
never does: the pointer holds no brotli ETag, since that field describes the gz
object. A brotli install therefore stores no ETag at all, and its later
refreshes are unconditional until a gz download records one. If the conditional
gz request answers 304 — the documented window where the durable gz lags
manifest publication — the call returns `snapshot-not-yet-published` and
deliberately does *not* stamp `checkedAt`, so the next check retries instead of
being suppressed for a whole refresh interval. A 304 that answers no validator
at all is an origin or proxy misbehaving, and is reported as the failed download
it is (`download-failed-304`) rather than as a snapshot that merely lags. `force: true` re-downloads
unconditionally.

A failed brotli attempt makes the refresh two DB requests rather than one; both
count towards `bytesDownloaded`, which reports every compressed byte pulled over
the wire, abandoned attempts included, and `onProgress` reports the same running
total so the counter never rewinds when a fallback starts.

After installing a snapshot, call `markSnapshotInstalled(db, serverCount)`. It
records the install in `sync_log` under the `snapshot` source, which
`isSyncNeeded` treats as a fresh sync — otherwise the CI-built `sync_log` inside
the snapshot looks hours old and a full live sync fires seconds after the
download. That grace period is `MCPFINDER_SNAPSHOT_FRESH_MINUTES` (default 360);
once it lapses, normal staleness detection resumes.

| Env var | Default | Effect |
| --- | --- | --- |
| `MCPFINDER_SNAPSHOT_MANIFEST_TIMEOUT_MS` | `10000` | Timeout for the manifest request. |
| `MCPFINDER_SNAPSHOT_STALL_TIMEOUT_MS` | `60000` | Inactivity budget for the DB download. |
| `MCPFINDER_SNAPSHOT_RETAIN_HOURS` | `48` | Grace period before a superseded snapshot file may be swept. |
| `MCPFINDER_SNAPSHOT_DOWNLOAD_STALE_HOURS` | `6` | Grace period before an abandoned partial download may be swept. |
| `MCPFINDER_SNAPSHOT_FRESH_MINUTES` | `360` | How long an installed snapshot counts as a fresh sync in `isSyncNeeded`. |
| `MCPFINDER_SNAPSHOT_NO_BROTLI` | unset | Set to `1` to ignore the manifest's brotli artifact and always download gzip. |

Published snapshots use last-known-good semantics. The scheduled builder
requires every registry — Official, Glama, and Smithery — to have an `ok` row in
`sync_log`, and rejects total or per-source count drops above 5% relative to the
published manifest. An incomplete snapshot never replaces a complete one: an
errored, skipped, or budget-exceeded registry fails the gate, `manifest.json` is
left untouched, and clients keep bootstrapping from the previous, complete
snapshot. A failed build therefore costs freshness, not availability — and
staleness is visible in the manifest's `publishedAt`, whereas a missing registry
would not be. `counts` still carries all three sources so a per-registry shortfall
stays visible to monitoring.

The gate itself keeps a parameterised best-effort mode
(`optionalSources` in `scripts/snapshot-quality.mjs`, tested but empty today) for
a registry that closes permanently: a best-effort source only warns, and because
`counts.*` are raw upstream record counts while `serverCount` is a deduplicated
row count, its absence cannot be subtracted from the baseline — the aggregate
`serverCount` regression check is **skipped** for that run with an explicit
warning while the per-source raw-vs-raw checks on the required sources keep the
gate honest.
Official, Glama, and Smithery stage each complete crawl (spilled to a TEMP
SQLite table, so staging memory stays bounded regardless of corpus size) and
atomically apply only a fully validated terminal result. Upstream, structural, budget, or apply
failures discard/roll back staging, leave the existing last-known-good database
unchanged, and record `status=error` with a zero committed count. Controlled corpus resets can override
only the count-regression check with `--allow-quality-regression` or
`MCPFINDER_SNAPSHOT_QUALITY_OVERRIDE=1`.

`GLAMA_API_KEY` (from <https://glama.ai/settings/api-keys>) enables the Glama
sync; it is sent as `Authorization: Bearer <key>` and never logged, persisted in
`raw_data`, or written to the manifest. Without it `syncGlamaRegistry` skips
before issuing a request and records `status=skipped` — which fails the snapshot
publication gate, since Glama is a required source; a 401/403 is treated as a
credential error and is never retried. Glama's API Data License requires visible
Glama attribution on every page displaying this data
(<https://glama.ai/policies/terms-of-service>).

`MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES` can raise Glama's default 12-minute
wall-clock budget for batch builds. It accepts integer values from 1 through
40; invalid or unbounded values fail explicitly. The snapshot workflow uses 30
minutes within its 90-minute job timeout. Malformed HTTP 200 JSON pages are
retried at the same cursor before the sync records an error. The hard registry
budget includes consuming and parsing the terminal response body; a page that
finishes after its deadline is intentionally degraded rather than accepted as
healthy, keeping the enclosing job bounded.
Empty Glama pages may legally continue with a new non-empty cursor; missing or
previously seen continuation cursors are structural errors, preventing an
upstream pagination loop from running until the deadline. A cross-page server
ID duplicate or a `RegistryTransportError` after exhausted page-level transport
retries (5xx, network/abort) restarts the complete cursor crawl, up to four
attempts. Local stdio waits 500 ms then 1 s then 2 s; the snapshot job
sets `MCPFINDER_CRAWL_RESTART_BASE_MS=15000` (15 s then 30 s then 60 s).
Restarts run only while the remaining registry budget can cover the next wait;
intra-page or persistent duplicates fail closed. 401/403 remain credential
errors and are never retried, and HTTP 429 is not a crawl restart (page-level
retries already spent the 429 budget). Like Smithery,
Glama applies only the completed retry in one SQLite transaction.
Official requires the upstream `metadata` object and per-page `count`, validates
that count against returned records, and follows `nextCursor` until it is empty,
null, or omitted by the terminal response. Repeated cursors or any failure
overwrite prior health with `status=error`; the entire cursor result is committed
in one transaction. Smithery always supplies a fixed
integer `seed` to select deep pagination (the unseeded reranker stops at 500).
Its `totalCount`/`totalPages` telemetry may drift while the catalogue changes,
so completion follows actual pages rather than one sampled aggregate. Every
non-empty final page, including a short candidate, is confirmed by an empty
next-page probe; a non-empty page after a short candidate is a truncation/gap
error. A cross-page `qualifiedName` duplicate or a `RegistryTransportError`
after exhausted page-level transport retries (5xx, network/abort)
restarts the entire seeded crawl, up to four attempts. Local stdio waits
500 ms then 1 s then 2 s; the snapshot job sets
`MCPFINDER_CRAWL_RESTART_BASE_MS=15000` (15 s then 30 s then 60 s) — the fault
is intermittent upstream, and three attempts at 500 ms then 1 s still lost the
2026-09-03 and 2026-09-04 builds. Restarts run only while the remaining
registry budget can cover the next wait; HTTP 429 is not a crawl restart.
Persistent cross-page or any intra-page duplicate fails closed.
`MCPFINDER_SMITHERY_SYNC_BUDGET_MINUTES` can raise Smithery's default 5-minute
wall-clock budget, which four full crawl attempts no longer fit into. It
accepts integer values from 1 through 15; invalid or unbounded values fail
explicitly. The snapshot workflow uses 12 minutes.
`currentPage` identity, non-negative typed
pagination metadata, and the requested maximum result size remain structural;
echoed `pageSize`, `totalCount`, and `totalPages` are advisory and may drift,
including on the empty terminal probe. Each attempt is staged in a TEMP SQLite
table rather than on the JS heap — a ~78k-entry Glama crawl would otherwise
hold hundreds of MB of parsed objects next to the dedup index — and only the
fully validated final attempt is applied in one SQLite transaction, so
abandoned retries,
network errors, structural failures, and deadline crossings cannot leak partial
Smithery records or provenance into the database.
Cross-registry matching builds one in-memory index per
Glama/Smithery sync, preserving repo/package/slug dedup semantics without a
full SQLite scan for every upstream record. Merges retain the combined
`sources`, richer canonical fields, deterministic keyword/environment unions,
repository host provenance (including `www.*` and protocol-less known-host
URLs), and source-specific raw payloads in the existing
`raw_data` envelope, including across a later Official re-sync. The envelope
stores one payload under `primary` with an explicit `primarySource`; only other
sources live in `bySource`, avoiding a duplicated primary payload. Readers also
accept and canonicalize legacy duplicated envelopes, preferring the historically
refreshed `bySource[primarySource]` copy when the copies disagree.
Keyword unions are rebuilt in fixed Official → Glama → Smithery order from the
current payload retained for each source, so complete envelopes remove obsolete
source-only terms without dropping terms still provided elsewhere. For invalid
or historically incomplete envelopes, valid incoming payloads are retained and
their current terms are combined fail-safe with legacy keywords until every
listed source has a replaceable payload. Smithery repository enrichment uses
the same metadata merge before deleting a duplicate row, preserving raw
payloads, env vars, keywords, sources, and repository provenance; shared-repo
monorepos merge only on a unique secondary name/slug match.
When Glama or Smithery refreshes a single-source stable ID, source-owned fields
(including repository URL/provenance, environment variables, counts, and sync
timestamp) exactly follow the current payload, including explicit removal. For
a multi-source row, canonical description, repository/provenance, remote, and
package fields are deterministically rebuilt from current payloads: the primary
source is preferred for non-empty structured fields, then Official → Glama →
Smithery, while the longest current description wins. Official-package and
Glama-schema environment contributions are replaced per source and re-unioned
through the same schema mapping the insert path uses, so a merged row keeps
`default`, `format`, `writeOnly`-derived `isSecret`, and schema `required`
instead of collapsing to name/description; unattributable legacy/enrichment
entries are retained fail-safe. Note that `isSecret` is only ever `true` or
absent: an absent flag means *unlabelled*, not *non-secret* (most catalogue
env vars carry no flag). `looksLikeCredentialName` is a conservative,
advisory-only name heuristic for those (`trustSignals.possibleUnlabeledSecrets`
uses it); it never changes generated config values. Smithery
remains authoritative for its usage count, verification, and icon, so those
may decrease without clearing other-source metadata. Invalid or missing source
payloads retain existing aggregates rather than risking data loss.

`sync_log.last_synced_at` records every attempt and throttles local background
refreshes after both success and failure. `last_successful_at` advances only on
healthy syncs. Official uses it for `updated_since` only when the latest attempt
is also healthy, so a failure is throttled locally while its next allowed
attempt remains a full sync.

The previous manifest is optional only when its endpoint returns 404. Network,
5xx, JSON, or missing/zero count failures are retried and then fail closed.
Successful publication first uploads `snapshots/<sha256>.sqlite.gz` and
`snapshots/<brotli sha256>.sqlite.br`, then verifies both objects through the
public Worker endpoint, and only then atomically advances `manifest.json` to
`data.sqlite.gz?sha=<sha256>` plus the matching `brotli` block. Only the gz half
of that is a gate. Brotli is best-effort end to end: a failed compression, a
failed upload, or a failed verification drops the `brotli` block from the
manifest before the pointer is published and warns in the job log and summary,
so the published manifest never announces an object that is not in R2 and a
bandwidth optimisation can never withhold a working snapshot. The brotli
object is immutable-only: it has no durable mutable twin, because a client that
cannot fetch it falls back to the gz artifact, which does have one. Immutable
snapshot objects have a 30-day prefix-scoped R2 lifecycle. After manifest
publication, CI refreshes the non-expiring legacy key with the same current DB;
it then publishes a `.sha256` commit marker. The Worker may use the durable key
only when requested, manifest, and marker SHA all match, preventing a failed
fallback upload from presenting stale bytes as current.

## Exports

| Export | Purpose |
| --- | --- |
| `initDatabase(path?)` | Open (or create) the local SQLite DB with FTS5 schema. |
| `getLastSyncTimestamp / getLastSuccessfulSyncTimestamp` | Read the latest attempt or latest incrementally safe successful sync timestamp. |
| `syncOfficialRegistry / syncGlamaRegistry / syncSmitheryRegistry` | Live sync from upstream registries. |
| `bootstrapFromSnapshot` | Fast cold-start via prebuilt SQLite snapshot (brotli when offered, gzip otherwise or on any brotli failure); also refreshes an installed one. |
| `readSnapshotState / writeSnapshotState / snapshotStatePath` | Pointer + provenance of the installed snapshot (`dbFile`, `sha256`, `publishedAt`, `etag`). |
| `resolveCurrentDbPath / versionedDbPath` | Map the nominal `data.db` path to the file actually in use, and to a digest's file name. |
| `publishSnapshotState` | Move the pointer to a new snapshot — standing down for older data and for a second copy of one digest *while that pointer's file is still there, and still holds a catalogue,* on both of two looks, and reporting a failed write. |
| `pointerNamesStandIn` | Positive evidence that the file a pointer names holds no catalogue and so cannot be the snapshot it claims. |
| `sweepSnapshotFiles` | Reclaim superseded snapshot files and abandoned downloads, age-gated; a `-wal`/`-shm` is never removed, at any age. |
| `closeDatabase / checkpointWal` | Close a handle cleanly (checkpoint, then close) when the caller knows it is done with it, and truncate the WAL a single-transaction crawl left behind. |
| `reconcileSnapshotPointer` | Stamp `checkedAt` on the pointer *in force*, without rolling a peer's newer one back. |
| `variantDbPath` | Alternative home for a digest whose canonical name still has a peer's journal at it. |
| `markSnapshotInstalled / getSnapshotInstalledAt` | Record and read when a snapshot was installed, for `isSyncNeeded`. |
| `searchServers` | Ranked full-text search + filters. |
| `getServerDetails` | Full metadata for one server (env vars, tools, trust signals). |
| `listCategories / getServersByCategory` | Category browsing. |
| `getInstallCommand` | Generate client-specific JSON install config. |
| `buildEnvPlaceholders / envPlaceholderValue` | Fill an `env` block from registry env var definitions: `<YOUR_VALUE>` for secrets, otherwise `default`, then `placeholder`, then `<VALUE>`. |
| `looksLikeCredentialName / possibleUnlabeledSecrets` | Advisory name heuristic (`GITHUB_TOKEN`, `OPENAI_API_KEY` yes; `TOKEN_URL`, `*_KEY_FILE`, `SITE_KEY` no) for env vars the registry left unlabelled — absent `isSecret` means unlabelled, not non-secret. Never affects masking. |
| `enrichSmitheryRepoUrls / enrichDeprecationFlags` | Build-time enrichment passes (GitHub probe, npm/GitHub deprecation flags). |

Full TypeScript types are exported — see the `.d.ts` files in `dist/`.

## Links

- **Source + issues:** https://github.com/mcpfinder/mcpfinder
- **Higher-level server:** [`@mcpfinder/server`](https://www.npmjs.com/package/@mcpfinder/server)
- **Website:** https://mcpfinder.dev

## License

[AGPL-3.0-or-later](https://www.gnu.org/licenses/agpl-3.0.en.html)
