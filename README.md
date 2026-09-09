# MCPfinder

> The MCP server that helps AI agents discover, evaluate, and install other MCP servers.

MCPfinder is an AI-first discovery layer over the Official MCP Registry, Glama, and Smithery. Install it once, and your assistant can search for missing capabilities, inspect trust signals, review required secrets, and generate client-specific MCP config snippets.

## Canonical Use

- Canonical transport: `stdio` via `npx -y @mcpfinder/server`
- Canonical package: [`@mcpfinder/server`](https://www.npmjs.com/package/@mcpfinder/server)
- MCP Registry entry: [`dev.mcpfinder/server`](https://registry.modelcontextprotocol.io/v0/servers?search=dev.mcpfinder)
- Public HTTP endpoint: intentionally not advertised as canonical until its tool surface is fully identical to the local server

## Quick Install

### Claude Desktop

```json
{
  "mcpServers": {
    "mcpfinder": {
      "command": "npx",
      "args": ["-y", "@mcpfinder/server"]
    }
  }
}
```

### Cursor

```json
{
  "mcpServers": {
    "mcpfinder": {
      "command": "npx",
      "args": ["-y", "@mcpfinder/server"]
    }
  }
}
```

### Claude Code

```json
{
  "mcpServers": {
    "mcpfinder": {
      "command": "npx",
      "args": ["-y", "@mcpfinder/server"]
    }
  }
}
```

Supported install targets today:

- Claude Desktop
- Cursor
- Claude Code
- Cline / Roo Code
- Windsurf

### Install via Agent Skill (let your AI do it)

If your agent supports the [Agent Skills](https://agentskills.io) format
(Claude Code, GitHub Copilot in VS Code, OpenAI Codex, and others), you can
drop a one-line install and let the agent handle the config merge itself.

**Claude Code (global):**

```bash
mkdir -p ~/.claude/skills/install-mcpfinder && \
  curl -sSf -o ~/.claude/skills/install-mcpfinder/SKILL.md \
    https://mcpfinder.dev/skill/install-mcpfinder/SKILL.md
```

**VS Code (project-scoped):**

```bash
mkdir -p .agents/skills/install-mcpfinder && \
  curl -sSf -o .agents/skills/install-mcpfinder/SKILL.md \
    https://mcpfinder.dev/skill/install-mcpfinder/SKILL.md
```

Then tell your agent any of: *"install MCPfinder"*, *"connect my AI to
Postgres"*, *"I need a tool for [anything]"* — the skill activates, detects
your client, merges the config without clobbering, and tells you what to
restart.

## For AI Assistants

Use MCPfinder when the user needs a capability you do not already have.

- If the user mentions Slack, Postgres, GitHub, Notion, AWS, Google Drive, filesystems, browsers, APIs, or databases: call `search_mcp_servers`.
- Before recommending a server: call `get_server_details`.
- Before telling the user what to paste into config: call `get_install_config`.
- If the user only knows a domain, not a specific technology: call `browse_categories` (omit `category` to list; pass `category` for top servers).

Preferred workflow:

1. `search_mcp_servers(query="postgres")`
2. `get_server_details(name="...best candidate...")`
3. `get_install_config(name="...best candidate...", platform="claude-desktop")`
4. Tell the user what server you chose, why, which secrets are required, and what restart/reload step is needed.

## Tool Surface

| Tool | Purpose | When to call |
| --- | --- | --- |
| `search_mcp_servers` | Search by keyword, technology, or use case | First step when a capability is missing |
| `get_server_details` | Inspect metadata, trust signals, tools, warnings, env vars | Before recommending or installing |
| `get_install_config` | Generate a JSON config snippet for a target client | After selecting a server |
| `browse_categories` | Single-call category browser (omit `category` to list; pass `category` for top servers) | Domain-driven discovery |

## What MCPfinder Returns

MCPfinder is intentionally optimized for agent consumption.

- Human-readable text summaries
- Structured content for chaining follow-up calls
- Trust signals: source count, verification, popularity, recency
- Warning flags: stale projects, missing repository URL, unclear install path, single-source-only
- Install metadata: config snippet, target file paths, required environment variables, restart instructions

## Ranking and Recommendation

Search ranking uses:

- text relevance
- name-match boost — measured against the name with its *hosting prefix* removed
  (`io.github.<owner>/<repo>` → `<owner>/<repo>`, `ai.smithery/<slug>` →
  `<slug>`). That leading segment is a reverse-DNS namespace assigned by the
  Official registry to say where the server's code is hosted — `io.github.*`
  servers all come from Official, not from some "GitHub" registry — and it says
  nothing about what the server does. 19.6% of the catalog is named
  `io.github.%`, so scoring it turned the boost into a constant and buried every
  real match. The owner segment stays, so searching by owner still works. There
  is no way to search *by* the hosting namespace: `registrySource` filters on
  the registries an entry was found in (`official`/`glama`/`smithery`), which is
  a different thing.
- community usage (`useCount`)
- official registry presence
- verification signals

Each result is also annotated with:

- `confidenceScore`
- `recommendationReason`
- `warningFlags`
- `updatedAt`
- `sourceCount`

## Data Sources

MCPfinder aggregates:

- [Official MCP Registry](https://registry.modelcontextprotocol.io)
- [Glama](https://glama.ai/mcp/servers)
- [Smithery](https://smithery.ai)

Counts vary over time and differ depending on whether you count raw upstream records or merged/deduplicated entries. Snapshot metadata is the source of truth for the currently published local bootstrap dataset.

## Snapshots and Freshness

First run can bootstrap from a prebuilt SQLite snapshot instead of doing a slow live sync.
Normal startup therefore does not wait for all live registry budgets. The
sequential Official → Glama → Smithery cold crawl is a fallback for an empty DB
only when snapshot bootstrap is disabled or fails, preserving deterministic
cross-registry deduplication.

The download runs in the background: the MCP server answers `initialize`
immediately, tool calls arriving before the catalog exists — during the download
and during the handle switch alike — get a "still preparing" notice with progress
(`status: "preparing"`, distinct from a not-found result), and the verified file
is switched in without a restart. A
freshly installed snapshot counts as a fresh sync, so it does not immediately
trigger the live crawl it was meant to replace.

Each snapshot is stored as its own immutable file, `data-<sha16>.db`, selected
by a pointer at `data.db.snapshot.json`. Nothing is replaced in place, so the
several MCP clients that each run their own mcpfinder process against
`~/.mcpfinder` never pull a database out from under one another; superseded
files are swept only after `MCPFINDER_SNAPSHOT_RETAIN_HOURS` (default 48) of
being un-pointed-to and untouched, and the sweep unlinks the database file
alone — never its `-wal`/`-shm`, which a peer that still has the file open looks
up by name. That rule is unconditional: an orphaned journal, one whose database
is already gone, is left alone too, because nothing distinguishes it from the
journal of a peer that outlived its own file, and deleting the latter is
corruption. What keeps the residue small is that every successful sync ends with
`PRAGMA wal_checkpoint(TRUNCATE)`; the 40MB `-wal` measured beside a 323MB
database came from a single-transaction crawl whose journal was never trimmed at
all. What is left is a bounded leak after processes killed with `SIGKILL` — how
MCP clients usually stop stdio servers. Two limits follow: a removal is allowed
to fail — on the platforms and filesystems where an open file's name cannot be
taken away, stale snapshots stay until nothing holds them — and a journal can
outlive the database it belonged to. The install is re-checked daily: one
manifest request when nothing changed, plus a request for the DB when the
manifest advertises a newer digest — conditional (ETag) on the gzip endpoint,
unconditional on the brotli one, which is content-addressed by its own digest
and for which no ETag is ever recorded.

- snapshot manifest: `/api/v1/snapshot/manifest.json`
- snapshot database (gzip): use `manifest.url` (`data.sqlite.gz?sha=<sha256>`) as the content-addressed primary endpoint
- snapshot database (brotli): use `manifest.brotli.url` (`data.sqlite.br?sha=<brotli sha256>`)
- durable current fallback: `/api/v1/snapshot/data.sqlite.gz`, refreshed only after manifest publication
- scheduled build: [`.github/workflows/snapshot.yml`](.github/workflows/snapshot.yml)
- staleness monitor: [`.github/workflows/snapshot-staleness.yml`](.github/workflows/snapshot-staleness.yml)

### Two compressions of one database

Every build publishes the same SQLite file twice — gzip always, brotli when
that half of the pipeline succeeds (see the publication section below). Brotli
(quality 9, 16MB window) is about 21% smaller: measured at 36.8MB against
46.7MB gzip for the 238MB / 84,647-server database published on 2026-08-26.
Both figures scale with the corpus, so treat the manifest's `sizeBytes` and
`brotli.sizeBytes` as the live numbers rather than these. Compressing the
second artifact costs well under a minute of build time inside a 90-minute job,
and decompression is a fraction of a second. zstd compresses a further ~2MB but
needs Node 22.15+/23.8+. The 22.x floor now clears that bar, but Node 23.0-23.7
does not, so a third artifact would still have to carry a fallback for the gain
to be safe — not worth it while brotli already does the work.

```jsonc
{
  "publishedAt": "…", "serverCount": 84647,
  // gzip: the snapshot's identity — recorded in the client's pointer and
  // compared on every freshness check. Unchanged, and always published.
  "sha256": "<gz digest>", "sizeBytes": 46706108, "url": "data.sqlite.gz?sha=<gz digest>",
  // brotli: optional, additive, with its own digest and size. Absent whenever
  // the artifact could not be built, uploaded or verified.
  "brotli": { "url": "data.sqlite.br?sha=<br digest>", "sha256": "<br digest>", "sizeBytes": 36760000 }
}
```

Clients from the next release prefer brotli when the manifest announces it and fall back
to gzip on *any* brotli-side failure — 404, transport error, corrupt stream,
digest mismatch — so a bad brotli object costs bandwidth, never a working
bootstrap. Both URLs are resolved against the configured snapshot base and one
that points outside it is refused rather than fetched: the digest lives in the
same manifest as the URL, so it cannot vouch for the origin of the bytes.
Decompression is size-bounded against the manifest's `rawSizeBytes`, because
the bytes reach disk before the digest can be checked. Each artifact is
verified against its own digest, and the ETag
recorded in `data.db.snapshot.json` always describes the object that was
actually downloaded (a brotli install stores none, since that field is the gz
object's validator). Set `MCPFINDER_SNAPSHOT_NO_BROTLI=1` to stay on gzip.
Published clients 1.1.0 and 1.2.0 read only `sha256`/`sizeBytes`/`url` and are
unaffected by the extra fields.

Snapshot publishing is last-known-good: all requested registries must finish
with an `ok` sync status, and the merged total plus each per-source count may
not fall more than 5% below the currently published manifest. A failed gate
leaves the published R2 objects untouched. Only a confirmed missing manifest
(HTTP 404, including the first build) skips the count comparison. Transient,
malformed, or structurally incomplete baselines are retried and then fail
closed; source health is always required.

Publication uses a content-addressed handoff. The compressed databases are
uploaded first — `snapshots/<sha256>.sqlite.gz` and
`snapshots/<brotli sha256>.sqlite.br`, each keyed by its own digest; only then
is `manifest.json` replaced with a pointer URL such as
`data.sqlite.gz?sha=<sha256>`. The pointer therefore never announces an object
that is not already durable. Cached older
manifests continue to resolve to their exact immutable database.
Legacy manifests without `sha` keep using the existing `data.sqlite.gz` key.
Before advancing the manifest, CI downloads both new objects through the public
Worker endpoint and verifies each one's SHA-256 and the Worker's acknowledged
content address.

Only the gz half of that is a publication gate. **Brotli is best-effort through
the whole pipeline**, on purpose: by the time the brotli steps run, the gz
object is already durable in R2 and fit to publish, and a bandwidth
optimisation must never be able to withhold a working snapshot. A failed brotli
compression, upload, or preflight all end the same way — the `brotli` block is
dropped from `manifest.json` before the pointer is published, and the build
warns in the job log and the step summary. The published manifest thus never
advertises an artifact that is not in R2, and clients that see no block simply
download gzip. This also means the Worker deploy order is a non-event: until
`/api/v1/snapshot/data.sqlite.br` is live the preflight 404s on brotli, the
block is dropped, and every build still publishes.

The gzip preflight, by contrast, stays fatal: it prevents publication while an
older Worker still ignores the `sha` query or while the new R2 object is not
publicly readable. The
preflight is bounded to four attempts with 0.5/1.5/4.5-second backoff and a
per-attempt timeout covering both response headers and the complete body;
deterministic SHA/header/size mismatches fail immediately.

Immutable objects under `snapshots/` expire after 30 days; neither
`manifest.json` nor legacy `data.sqlite.gz` matches that lifecycle prefix.
Incomplete multipart uploads retain the existing 7-day abort policy.
After the manifest pointer is published, CI refreshes non-expiring
`data.sqlite.gz` with the same database and then publishes
`data.sqlite.gz.sha256` as the final commit marker. There is deliberately **no**
brotli twin of that durable pair: it exists to rescue a client whose manifest
digest has aged out of the 30-day immutable window, and a brotli client already
has that escape hatch — it falls back to the gz artifact, which does have one.
A second mutable key would add a divergence risk and no availability. If the current immutable
object later expires, the Worker serves this durable copy only when the
requested SHA, current manifest SHA, and marker SHA all match. A failed DB or
marker upload therefore cannot label stale bytes as a new snapshot. Older
cached SHA requests remain 404 after their 30-day history window.
The Worker coalesces concurrent current-proof reads and caches both positive
and malformed/missing proof results for five minutes; SHA-specific 404s are
also publicly cacheable for five minutes.
Actual R2 read failures remain distinct from missing or malformed proof: they
return an uncached 503 and are retried by the next request.

For an intentional corpus reset, manually dispatch the snapshot workflow with
`allow_quality_regression` enabled, or run the builder with
`--allow-quality-regression` (equivalently
`MCPFINDER_SNAPSHOT_QUALITY_OVERRIDE=1`). The override permits count drops but
never permits an errored or incomplete required source.

### Every registry is required

Official MCP Registry, Glama, and Smithery are all *required* sources: an
errored, missing, skipped, or degraded sync of any one of them blocks snapshot
publication. **An incomplete snapshot never replaces a complete one.**

The reason this is affordable is the shape of the publication handoff.
`manifest.json` is a pointer swapped as the very last step, and the database it
points at lives outside the 30-day `snapshots/` expiry prefix, so a build that
fails the gate simply does not touch it — clients keep bootstrapping from the
previous, complete snapshot. A failed build therefore means *staleness*, not
*unavailability*, and a complete snapshot from yesterday beats a fresh one with
a registry missing. Staleness is visible to everyone in the manifest's
`publishedAt`; a silently absent third of the corpus is visible to no one.

The gate is parameterised rather than hardcoded: `scripts/snapshot-quality.mjs`
still implements best-effort (`optionalSources`) handling, and it is still
tested. Nothing is listed there today. If a registry closes permanently, moving
its name from `requiredSources` to `optionalSources` in
`scripts/build-snapshot.mjs` demotes it — with the aggregate-count consequences
described below — instead of the gate having to be rebuilt under pressure.
`--no-glama` / `--no-smithery` drop a registry from a local build entirely; they
are for local runs, not for CI.

`counts` in `manifest.json` always carries all three sources, so a per-registry
regression stays visible to monitoring even though it now also fails the build.

When a source *is* demoted to best-effort, its absence legitimately shrinks the
corpus and the baseline cannot be corrected for it: `serverCount` in
`manifest.json` is a *deduplicated* row count while `counts.<source>` are *raw*
per-registry record counts that overlap across registries (they sum to more than
`serverCount`). Subtracting one from the other compares incomparable units. So
when a best-effort source is unhealthy the aggregate `serverCount` regression
check is **skipped entirely**, with a warning naming the source:

```
[build-snapshot] quality warning: serverCount regression check skipped:
best-effort source <name> is unavailable and its contribution to the
deduplicated baseline cannot be isolated
```

The per-source regression checks for the required sources still run (raw against
raw). With every source required — the current policy — the aggregate check runs
on every build against the undoctored previous `serverCount`, and a drop beyond
the 5% threshold blocks publication regardless of which source caused it. The
manual `MCPFINDER_SNAPSHOT_QUALITY_OVERRIDE` escape hatch remains the only way
to publish through a deliberate aggregate reset.

Glama requires `GLAMA_API_KEY` (create one at
<https://glama.ai/settings/api-keys>) since it closed its public API on
2026-08-26 — `GET /api/mcp/v1/servers` answers `401 unauthorized` without a key.
The key is sent as `Authorization: Bearer <key>` and is never logged, stored in
`raw_data`, or written to the manifest. Without it the sync is skipped before
any request, recording `status=skipped` in `sync_log` with
`Glama API requires GLAMA_API_KEY; skipping Glama sync` — which now fails the
publication gate, because a snapshot without Glama is not a complete snapshot. A
rejected key (401/403) is reported as a credential error and is never retried —
it is not a transient failure. In CI the key comes from the repo secret
`GLAMA_API_KEY`; an unset secret takes the skip path and no snapshot is
published.

> **Licensing:** Glama's API Data License requires *visible attribution to
> Glama on every page that displays this data*
> (<https://glama.ai/policies/terms-of-service>). Any surface rendering
> Glama-sourced servers must carry that attribution.

Glama keeps a 12-minute sync budget for normal local stdio use. The scheduled
snapshot job sets `MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES=30` because a full Glama
pagination regularly exceeds the local limit, while still leaving headroom
inside the job's 90-minute timeout. Custom values must be whole minutes from 1
through 40. HTTP 200 pages with truncated or malformed JSON are retried on the
same cursor before the source is marked as errored. The hard registry deadline
covers the terminal response body as well as transport and parsing: a page that
finishes after the budget is deliberately marked degraded, protecting the
snapshot job from silently exceeding its wall-clock budget.
An empty Glama page with `hasNextPage=true` is followed when it supplies a new,
non-empty cursor. Missing or repeated cursors fail safely as structural errors,
preventing upstream pagination loops.

Smithery paginates through a fixed seed, and the seeded ordering occasionally
returns the same `qualifiedName` on two different pages. That is a structural
error — a corpus counted twice is not a corpus — so the crawl restarts from page
one rather than committing what it has. Glama does the same for a cross-page
server id duplicate, and both registries also restart the whole crawl after
exhausted page-level transport retries (5xx, network/abort;
`RegistryTransportError`); a 401/403 credential rejection or HTTP 429 does
not — 429 is retried at page level, and restarting from page one would
amplify load. Restarts are capped at four attempts. Local stdio waits 500 ms
then 1 s then 2 s so a first-run live sync stays inside the SDK's 60 s
tool-call timeout. The snapshot job sets `MCPFINDER_CRAWL_RESTART_BASE_MS=15000`
(15 s then 30 s then 60 s) because the fault is transient upstream: the builds
of 2026-09-03 and 2026-09-04 still lost Smithery after three attempts at 500 ms
then 1 s, and the 2026-09-08 Glama HTTP 502 never restarted the crawl at all.
Restarts run only while the remaining registry budget can cover the next wait;
skipping a wait that would miss the deadline keeps the original fault rather
than reporting a budget overrun. Custom values must be whole milliseconds from
100 through 60000. Four full Smithery passes do not fit the 5-minute local
budget, so the snapshot job also sets `MCPFINDER_SMITHERY_SYNC_BUDGET_MINUTES=12`;
custom values must be whole minutes from 1 through 15.

### A frozen publication announces itself

Because a failed build is *staleness*, not *unavailability*, nothing breaks when
publication stops — which is exactly why it has to be announced. A red run is
visible only to whoever opens the Actions tab, and `publishedAt` is a pull-based
signal nobody polls; that combination once let a stalled publication go
unnoticed for six days.

Two independent signals now cover it, and when they alarm they file into the
same GitHub issue, deduplicated by the `snapshot-freeze` label:

1. **The build says it did not finish.** A final
   `if: (failure() || cancelled()) && steps.manifest-pointer.outcome != 'success'`
   step in `.github/workflows/snapshot.yml` still runs on those failures so it
   can name the failing step and link the run, but it calls
   `raise-unless-fresh` rather than `raise`. When the public manifest is
   still fresh under the same 18-hour criterion, it logs that and files
   nothing — a single failed 6-hourly cycle is a red Actions run, not a GitHub issue.
   It raises (or comments on the open thread) only when the probe says stale or
   unreadable — a stall already in progress — or when the probe itself fails.
   `cancelled()` is there because a job that trips `timeout-minutes`, loses its
   runner, or is stopped by hand is cancelled rather than failed, and those runs
   publish nothing. The pointer clause is there because a failure *after* the
   manifest pointer moved is not a freeze at all: `publishedAt` advanced and
   clients are already bootstrapping the new snapshot, so a broken
   durable-fallback upload files no issue — it closes an open one, on the same
   `publishedAt` criterion the staleness monitor would use two hours later, and
   reports itself in the run summary and the red run instead. The matching
   `if: success()` step closes the issue with the new `publishedAt`. The job
   carries a minimal `permissions` block (`contents: read`, `issues: write`,
   and `actions: read` so it can read back which step failed).
2. **The published manifest says nothing moved.**
   `.github/workflows/snapshot-staleness.yml` runs every two hours, fetches
   `https://mcpfinder.dev/api/v1/snapshot/manifest.json` the way a client would,
   and alarms when `publishedAt` is older than **18 hours** — three missed
   6-hourly builds, so a single failed cycle stays quiet. An unreachable
   endpoint, unparseable JSON, a `publishedAt` that is not an ISO-8601 instant,
   or a timestamp in the future are alarm states of their own, never a silent
   pass. The fetch retries on `[500, 1500, 4500]` ms with a 15s per-attempt
   timeout, so one 502 or DNS blip does not file an issue the next run closes.

Neither signal subsumes the other: the failure step cannot see a run that never
started or a green run whose bytes never reached R2, and the age monitor cannot
say which step broke. The threshold logic lives in
`scripts/check-snapshot-staleness.mjs` — dependency-free, and unit-tested by
`scripts/test-snapshot-artifacts.mjs` — rather than inline in YAML.
`MCPFINDER_SNAPSHOT_BASE_URL` repoints both the monitor and the upload preflight
at a staging Worker. Both signals go through one shared implementation,
`scripts/snapshot-freeze-signal.mjs`, which owns the label, the title, the
duplicate-thread reconciliation, and the throttle that keeps an unchanged alarm
to one comment per 12 hours instead of one per two-hour pass. "Unchanged" is
judged on the verdict's *cause* — `age-exceeded`, `http-502`,
`no-published-at`, the failing step names — not on its wording: the wording
carries the age, which moves on every pass, while a 502 that becomes a DNS
failure is a different incident and comments immediately.

Every alarm says, in the issue body, that the previous complete snapshot is
still being served. A freeze is a data stall; treating it as an outage is how a
monitor loses its audience.

**What neither signal covers.** The staleness monitor is itself a GitHub
scheduled workflow, so repository inactivity takes it down with the build it
watches: GitHub disables cron schedules in a repository idle for 60 days, and
that one switch silences both. The same applies to an Actions outage, a
manually disabled workflow, or an archived repository — a dead monitor produces
no red X and no issue, which is indistinguishable from a healthy one. Nothing
inside GitHub can close that gap. The only complete fix is an **external uptime
check** that fetches `/api/v1/snapshot/manifest.json` from outside GitHub and
alerts on `publishedAt` age. Until one exists, read the two signals above as
covering build and publication failures, not the disappearance of the schedule.

## Example Workflow

User request:

```text
I need my assistant to read data from PostgreSQL.
```

Agent workflow:

```text
search_mcp_servers(query="postgres")
get_server_details(name="io.example/postgres")
get_install_config(name="io.example/postgres", platform="cursor")
```

Agent response:

```text
I found a PostgreSQL MCP server with official registry presence and recent metadata.
It requires DATABASE_URL and runs via npx.
Add this JSON to ~/.cursor/mcp.json, then reload Cursor.
```

## Repository Layout

```text
mcpfinder/
├── packages/
│   ├── core/          # sync, SQLite search, trust signals, install-config generation
│   └── mcp-server/    # stdio MCP server
├── landing/           # static website and AI-facing public files
├── api-worker/        # snapshot/support worker for published bootstrap artifacts
└── scripts/           # snapshot builder and other support scripts
```

## Development

```bash
pnpm install
pnpm --filter @mcpfinder/core build
pnpm --filter @mcpfinder/server build
node packages/mcp-server/dist/index.js
```

### Dependency policy

`pnpm-workspace.yaml` enforces three supply-chain rules on every resolution:
`minimumReleaseAge: 10080` (no npm release younger than seven days),
`blockExoticSubdeps: true` (every transitive dep must resolve from the registry,
never a git URL or bare tarball), and `trustPolicy: no-downgrade` (reject a
version whose trust evidence is weaker than that of any version published
before it).

pnpm 11 also re-applies all three to the existing lockfile under
`--frozen-lockfile`, so CI enforces them on a lockfile someone else committed —
a violation fails the install outright.

Two consequences worth knowing before they surprise you:

- **A freshly published version will not resolve for a week.** That is the
  point. The packages listed under `overrides` are the exception: they are a
  hand-maintained set of security pins, so they appear in
  `minimumReleaseAgeExclude` and update the day a patch lands. Remove a package
  from `overrides` and remove it from that list too.
- **`trustPolicyExclude` carries exactly one pinned entry**, `undici-types@6.21.0`,
  with the evidence for why it is benign recorded in the file. Pin any future
  exemption to an exact version the same way, never to a bare package name.

## Current Limitations

- The local `stdio` server is the canonical interface. Install via `npx -y @mcpfinder/server`.
- There is no hosted HTTP MCP endpoint currently served at `mcpfinder.dev/mcp`. The `api-worker` package is reserved for snapshot support and will only be promoted to a canonical HTTP transport once it exposes the same tool contract as the stdio server.
- Tool metadata quality depends on upstream registries; some servers have rich details, others only partial metadata.
- Tool-level capability extraction is currently strongest for sources that expose tool manifests directly, especially Glama.

## Roadmap

These items are planned but not yet implemented. Informed largely by feedback
from AI agents consuming the tool surface.

- **Semantic search over tool descriptions.** Today's search ranks by keyword
  (FTS5) + popularity + source count. It doesn't help when a user describes a
  capability in prose that doesn't overlap lexically with the server's name or
  description. Plan: index `toolsExposed[*].description` (where upstream exposes
  it) into a lightweight embedding column, expose a `semanticQuery` parameter
  alongside the existing keyword `query`, and rank hybrid.
- **Hosted HTTP MCP endpoint at `mcpfinder.dev/mcp`.** Today only stdio is
  canonical. Serverless AI agents (Workers, Lambda, browser) can't spawn a
  subprocess; giving them an HTTP transport with the same 4-tool contract
  removes an entire class of blocker. Plan: port the MCP SDK streamable-http
  transport into `api-worker/`, re-use the same snapshot-backed database via
  R2 + Durable Objects, gate with a lightweight rate limit.
- **Capability-count enrichment for non-Glama rows.** `capabilityCount` is
  currently 0 for most Official/Smithery rows because those upstreams don't
  publish tool manifests in list responses. Plan: during the snapshot build,
  probe the downstream server's README or, for npm packages, parse the tarball's
  `package.json` for an `mcp.tools` hint; surface per-row confidence in the
  extracted list.
- **CI automation for npm + Registry publish.** Today the release playbook
  (`docs/publish-playbook.md`) is manual and consumes a fresh OTP per package.
  Plan: move to GitHub Actions with NPM automation tokens and a committed
  `mcp-publisher` login step triggered on `v*` tags.

## Links

- Website: [mcpfinder.dev](https://mcpfinder.dev)
- GitHub: [mcpfinder/mcpfinder](https://github.com/mcpfinder/mcpfinder)
- npm: [@mcpfinder/server](https://www.npmjs.com/package/@mcpfinder/server)
- MCP Registry: [`dev.mcpfinder/server`](https://registry.modelcontextprotocol.io/v0/servers?search=dev.mcpfinder)

Built by [Coder AI](https://coderai.dev) under [AGPL-3.0-or-later](LICENSE).
