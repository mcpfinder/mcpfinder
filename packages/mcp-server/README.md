# @mcpfinder/server

> The MCP server that finds MCP servers. Your AI's app store for tools.

[![npm](https://img.shields.io/npm/v/@mcpfinder/server.svg)](https://www.npmjs.com/package/@mcpfinder/server)
[![license](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](https://www.gnu.org/licenses/agpl-3.0.en.html)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-dev.mcpfinder%2Fserver-D4FF00)](https://registry.modelcontextprotocol.io/v0/servers?search=dev.mcpfinder)

MCPfinder is a local MCP server that exposes a searchable index of 25,000+ MCP
servers across the **Official MCP Registry**, **Glama**, and **Smithery**.
Install it once as a capability on your AI client and from then on your
assistant can discover, inspect, and install any MCP server on demand — no
manual browsing required.

## Quick install

Add the snippet below to your client's MCP config file. First run downloads a
pre-built compressed snapshot from `https://mcpfinder.dev/api/v1/snapshot`, so
bootstrap is normally a single download instead of a 10-minute live sync. The
server prefers the brotli artifact — about 21% smaller than the gzip one — and
falls back to gzip if it cannot be fetched, decompressed or verified, which
makes that case two downloads. A brotli failure alone therefore never fails the
bootstrap; if *both* artifacts fail, the download has failed, and the server
falls back to a live sync rather than to nothing. Set
`MCPFINDER_SNAPSHOT_NO_BROTLI=1` to stay on gzip. Both sizes track the indexed
corpus and grow with it — the current figures are the `sizeBytes` and
`brotli.sizeBytes` fields of the snapshot manifest at
`https://mcpfinder.dev/api/v1/snapshot/manifest.json`.

The download does **not** block start-up: the server answers `initialize`
immediately and pulls the snapshot in the background, so a client's handshake
timeout can never kill it mid-download. A tool call that arrives while the
catalog is still empty — while the snapshot downloads *and* during the handle
switch that installs it — returns a short "still preparing" notice with progress
instead of hanging or answering "nothing found" — reported as `status:
"preparing"` with
`retry_after_seconds`, never as `found: false`, so a structured-output consumer
cannot mistake "not ready" for "does not exist". Once the file lands it is
verified (sha256) and switched in without a restart. A network failure at any
point is logged and degrades to a live sync — it never takes the server down.

### Several clients, one data dir

Claude Desktop, Cursor and Claude Code each start their own mcpfinder process
against `~/.mcpfinder`, so nothing is ever replaced in place. Each snapshot is
its own immutable file, `data-<sha16>.db`, and a pointer
(`<data-dir>/data.db.snapshot.json`) records which one is current; a process
only ever adds a file, and a peer serving an older one is left undisturbed.
Retention later deletes the superseded database file and, for a long time, only
that file: on POSIX a peer that still has it open keeps working against its
inode, while its `-wal`/`-shm` — the part whose loss actually corrupts — are
left alone. That holds even once the database is gone: an orphaned journal is
indistinguishable from one a still-running peer needs, so it is never collected.
They are not free — a crawl commits as one transaction, and a measured install
carried a 40MB `-wal` and a 1MB `-shm` beside a 323MB database — but the server
trims the WAL after every successful sync and closes a retired handle cleanly,
so a journal no longer sits inflated to the size of a whole crawl. A close that
fails is retried — three times quickly, then once a minute indefinitely on an
unref'd ticker — rather than abandoned: a stdio server lives as long as the
client that spawned it, so giving up would park a descriptor and a WAL lock on a
superseded file for days.
`SIGKILL`, which is how MCP clients usually stop stdio servers, cannot be
intercepted, so what accumulated since the last checkpoint is a known leak. See
[`@mcpfinder/core`](../core/README.md#retention) for the two things that follow:
a removal is allowed to fail, so stale snapshots linger wherever an open file's
name cannot be taken away, and sidecars can outlive the database they belong
to.
In-process the switch opens the new file *before* retiring the old handle, so
there is never a moment without a usable database and no tool call ever waits on
the swap. Installs from earlier versions keep running from their existing
`data.db` — it is never renamed or deleted — until the first newer snapshot
gives the pointer a versioned file to move to.

Superseded files are reclaimed only once they are both un-pointed-to and
untouched for `MCPFINDER_SNAPSHOT_RETAIN_HOURS` (default 48); the current file is
never removed, at any age. The
deliberate trade-off: if one process switches to a newer snapshot while another
is mid live-sync, that other process's sync results are dropped when it switches
too. The published snapshot is the catalog's source of truth, so this costs at
most one later re-sync.

Afterwards the installed snapshot is re-checked once a day (the staleness
threshold is polled four times per period, so a check landing marginally early
cannot push the refresh out to the next period). A check that finds nothing new
costs a **single** manifest request. When the manifest advertises a different
digest, a request for the DB follows: against the gzip endpoint it is
conditional (`If-None-Match`, using the ETag the pointer recorded — but only
while the file that ETag describes is still on disk, since a repair that
revalidates would get a 304 and install nothing), and either
transfers the file or answers 304; against the brotli endpoint it is
unconditional, because that artifact is content-addressed by its own digest and
no brotli ETag is ever stored. A brotli attempt that fails costs one further
request for the gzip artifact. The manifest request itself is always
unconditional. Deleting the pointer costs one extra download and sends the
process back to the nominal `data.db` name — safely: if that name has been swept
and only a peer's journal is left at it, `resolveCurrentDbPath` opens a variant
name rather than adopting the stranded journal.
When a live refresh is needed, registries run sequentially as Official → Glama
→ Smithery so each later dedup index sees earlier inserts. A failed source is
reported but does not prevent attempts for the remaining sources.
Normal cold start uses the snapshot and does not pay the sum of live registry
budgets. The sequential worst case applies only when snapshot bootstrap is
explicitly disabled or fails while starting from an empty database; the order
is retained for deterministic cross-registry deduplication.

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

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

Restart Claude Desktop.

### Cursor

`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

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

`.mcp.json` (project) or `~/.claude.json` (global) — same snippet as above.

### Cline / Roo Code (VS Code)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "mcpfinder": {
      "command": "npx",
      "args": ["-y", "@mcpfinder/server"]
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json` — same snippet as Cursor.

## Tools exposed

Four canonical tools, optimized for AI consumption (typed `outputSchema` +
`structuredContent` for chaining, warning flags, confidence breakdown):

| Tool | Purpose |
| --- | --- |
| `search_mcp_servers` | Ranked full-text search by keyword, technology, or use case. |
| `get_server_details` | Trust signals, env vars, tool manifest, warnings before install. |
| `get_install_config` | Ready-to-paste JSON config for Claude Desktop, Cursor, Claude Code, Cline, or Windsurf. |
| `browse_categories` | Single-call category browser (omit `category` to list; pass `category` for top servers). |

## What MCPfinder returns to your AI

- Ranked results with `confidenceScore` plus a transparent
  `confidenceBreakdown` (`base`, `official`, `verified`, `popularity`,
  `multiSource`, `penalties`).
- `warningFlags`: `deprecated-npm`, `archived-repo`, `stale-over-18-months`,
  `single-source-only`, `missing-repository-url`, `install-method-unclear`.
- Install metadata: target file path per OS, required env vars (secrets
  marked), `safe_to_autoinstall` and `requires_user_secrets` signals.
- The `env` block of a generated config carries values, never prose: secrets
  get `<YOUR_VALUE>`, other variables get the registry-published `default`,
  then `placeholder`, then `<VALUE>`. Descriptions stay in the "Required
  environment variables" section under the snippet.
- A registry `isSecret` flag is only ever present or absent, and absent means
  unlabelled, not non-secret. Unlabelled variables whose names look like
  credentials (`GITHUB_TOKEN`, `OPENAI_API_KEY`, ...) get an advisory in the
  env-var listings ("looks like a credential (not marked secret by the
  registry); treat it as one") and are listed in `get_install_config`'s
  `possible_unlabeled_secrets`. This is advisory only: their config value is
  still chosen exactly as for any unmarked variable (registry `default`, then
  `placeholder`, then `<VALUE>`); the heuristic never changes it, and `requires_user_secrets` keeps its registry-only meaning.

## Configuration

| Env var | Default | Effect |
| --- | --- | --- |
| `MCPFINDER_DATA_DIR` | `~/.mcpfinder/` | Where the local SQLite DB lives. |
| `MCPFINDER_DISABLE_SNAPSHOT` | unset | Set to `1` to skip snapshot bootstrap and do a live sync instead. |
| `MCPFINDER_SNAPSHOT_NO_BROTLI` | unset | Set to `1` to ignore the manifest's brotli artifact and always download gzip. |
| `MCPFINDER_SNAPSHOT_BASE` | `https://mcpfinder.dev/api/v1/snapshot` | Override the snapshot host for mirrors / testing. |
| `MCPFINDER_SNAPSHOT_REFRESH_HOURS` | `24` | How old an installed snapshot may get before it is re-checked against the manifest. `0` disables *periodic* re-checks only — an install with no snapshot yet always bootstraps. |
| `MCPFINDER_SNAPSHOT_RETAIN_HOURS` | `48` | Grace period before a superseded snapshot file is deleted. Raise it if you keep long-lived mcpfinder processes around. |
| `MCPFINDER_SNAPSHOT_DOWNLOAD_STALE_HOURS` | `6` | Grace period before an abandoned partial download is deleted. |
| `MCPFINDER_SNAPSHOT_MANIFEST_TIMEOUT_MS` | `10000` | Timeout for the small manifest request. |
| `MCPFINDER_SNAPSHOT_STALL_TIMEOUT_MS` | `60000` | Inactivity budget for the DB download — aborted only after this long with no bytes received, so a slow-but-healthy link is never cut off. |
| `MCPFINDER_SNAPSHOT_FRESH_MINUTES` | `360` | How long a freshly installed snapshot counts as a fresh sync before live registry refreshes resume. |
| `GLAMA_API_KEY` | unset | API key for Glama's registry ([create one](https://glama.ai/settings/api-keys)). Without it a live refresh skips Glama entirely — the sync is Official → Smithery, logged as `skipped`. Published snapshots always carry Glama data: every registry is required for publication, so a build that could not sync Glama publishes nothing and clients keep the previous, complete snapshot (check `publishedAt` and `counts` in the manifest). |

Glama's API Data License requires visible Glama attribution on every page
displaying data obtained through its API
(<https://glama.ai/policies/terms-of-service>) — any surface rendering servers
whose `sources` include `glama` must carry it.

## Links

- **Source + issues:** https://github.com/mcpfinder/mcpfinder
- **MCP Registry:** [`dev.mcpfinder/server`](https://registry.modelcontextprotocol.io/v0/servers?search=dev.mcpfinder)
- **Website:** https://mcpfinder.dev
- **AI-facing summary:** https://mcpfinder.dev/llms.txt

## License

[AGPL-3.0-or-later](https://www.gnu.org/licenses/agpl-3.0.en.html) — free for
personal, internal, and commercial use; modifications exposed as a network
service must be published under the same license.
