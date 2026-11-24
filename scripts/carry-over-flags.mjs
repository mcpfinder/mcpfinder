/**
 * DB half of build-snapshot's flag carry-over: seed deprecation/archived flags
 * (and their probe timestamps) into the freshly built DB from a previously
 * published snapshot file at `prevPath`, keyed by stable server id.
 *
 * Returns the number of rows seeded.
 */
export function seedFlagsFromSnapshot(targetDb, prevPath) {
  targetDb.exec(`ATTACH DATABASE '${prevPath.replace(/'/g, "''")}' AS prev`);
  try {
    const prevCols = new Set(
      targetDb.prepare(`SELECT name FROM prev.pragma_table_info('servers')`).all().map((c) => c.name),
    );
    // Older snapshots predate the *_checked_at columns — carry whatever exists.
    // The archived_* state describes a repository, not a server: carry it only
    // while the repository URL is unchanged, so a server whose repo moved is
    // probed afresh instead of inheriting the old repo's archived/unavailable
    // state (and a fresh timestamp that would defer the re-check).
    const repoCols = prevCols.has('repository_url')
      ? ['archived_repo', 'archived_repo_checked_at'].filter((c) => prevCols.has(c))
      : [];
    const npmCols = ['deprecated_npm', 'deprecated_npm_checked_at'].filter((c) => prevCols.has(c));
    const sameId = 'p.id = servers.id';
    const sameRepo = `${sameId} AND p.repository_url IS servers.repository_url`;
    let changes = 0;
    for (const [cols, match] of [[npmCols, sameId], [repoCols, sameRepo]]) {
      if (cols.length === 0) continue;
      const setClause = cols
        .map((c) => `${c} = (SELECT p.${c} FROM prev.servers p WHERE ${match})`)
        .join(', ');
      const info = targetDb
        .prepare(`UPDATE servers SET ${setClause} WHERE EXISTS (SELECT 1 FROM prev.servers p WHERE ${match})`)
        .run();
      changes = Math.max(changes, Number(info.changes));
    }
    // Before archived_repo gained state 2, a GitHub 404 (private or deleted
    // repo) was stored as 1 = archived. While the previous snapshot has no 2
    // at all it predates that split, so clear the timestamp of its 1s: the
    // probe then re-checks them this run (ahead of merely stale rows) instead
    // of waiting out the 30-day window. Once any 2 is published this is a no-op.
    if (repoCols.includes('archived_repo_checked_at')) {
      const preSplit = !targetDb.prepare(`SELECT 1 FROM prev.servers WHERE archived_repo = 2 LIMIT 1`).get();
      if (preSplit) {
        targetDb.exec(`UPDATE servers SET archived_repo_checked_at = NULL WHERE archived_repo = 1`);
      }
    }
    return changes;
  } finally {
    targetDb.exec('DETACH DATABASE prev');
  }
}
