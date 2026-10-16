// Is the running process older than the code on disk?
//
// Written 22 Aug 2026 after three separate bug reports in one session that all
// turned out to be a server started before the fix: a wrong date, a missing
// admin route, and a control that would not appear. Each one cost a round trip
// of "try restarting", which is a bad answer to give somebody three times.
//
// The trick is that a stale process can still read the working tree. It
// records the commit it booted from, and compares that against what is on
// disk right now — so the process that is out of date is the one that notices,
// which is exactly the process still answering requests.
//
// Deliberately shallow: this reads .git directly rather than shelling out to
// git. It runs on a status poll every ten seconds, it must never throw, and
// spawning a process for it would be absurd. When anything is unreadable —
// not a checkout, a packed ref, a worktree — it reports "unknown" and the UI
// says nothing, which is the right failure for a nicety.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * The commit currently checked out, or null.
 *
 * Handles the common case (a loose ref) and gives up on the rest. A repo whose
 * HEAD is packed reports null, which reads as "cannot tell" rather than as
 * "unchanged" — a false "unchanged" would be worse than no answer at all,
 * since it is the reassuring one.
 */
export function headCommit(rootDir) {
  try {
    const gitDir = path.join(rootDir, '.git');
    if (!existsSync(gitDir)) return null;
    const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return head.slice(0, 40) || null;   // detached
    const ref = head.slice(4).trim();
    const refFile = path.join(gitDir, ref);
    if (!existsSync(refFile)) return null;   // packed-refs; not worth parsing
    return readFileSync(refFile, 'utf8').trim().slice(0, 40) || null;
  } catch {
    return null;
  }
}

/**
 * Records the commit at boot and answers "am I stale" on demand.
 *
 * `stale` is only ever true when both commits are known and differ. Unknown on
 * either side means unknown, never stale: a warning that cannot be dismissed
 * by restarting would be worse than no warning.
 */
export function createVersionWatch(rootDir) {
  const bootCommit = headCommit(rootDir);
  const bootedAt = new Date().toISOString();

  return {
    bootCommit,
    bootedAt,
    info() {
      const diskCommit = headCommit(rootDir);
      return {
        boot_commit: bootCommit ? bootCommit.slice(0, 7) : null,
        disk_commit: diskCommit ? diskCommit.slice(0, 7) : null,
        booted_at: bootedAt,
        stale: Boolean(bootCommit && diskCommit && bootCommit !== diskCommit),
      };
    },
  };
}
