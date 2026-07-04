// state.mjs — CANONICAL state-cache writer for the agent-refs family.
// Vendored (copied) into each primitive's src/ and esbuild-inlined. agent-refs READS what
// this WRITES, so this file is the shared contract — do not diverge per package.
//
// Properties (all deliberate):
//   • atomic     — write "<file>.<pid>.tmp" then rename() over the target (POSIX-atomic).
//   • lock-free  — one file per (actor, concern); no writer ever shares a path → no RMW,
//                  no lock, no lost updates, no cross-agent contention.
//   • gated      — NO-OP unless the state dir already exists (config-by-convention:
//                  `agent-refs init` creates it, `--uninstall` removes it). So a primitive
//                  with no agent-refs installed behaves byte-identically.
//   • silent     — never throws, never networks; the cache is a cosmetic mirror of the refs
//                  (which remain the sole source of truth for correctness).
//
// Depends only on node:fs + node:path. ~30 lines. Zero runtime deps.

import { existsSync, writeFileSync, renameSync, rmSync, statSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

// Walk up from `start` to the git dir: a `.git` DIRECTORY for a normal checkout, or a
// `.git` FILE ("gitdir: <path>") for a linked worktree (resolved so each worktree is
// isolated). Returns the git dir, or null if not inside a repo.
export function gitDir(start = process.cwd()) {
  let d = start;
  for (;;) {
    const g = join(d, ".git");
    try {
      const st = statSync(g);
      if (st.isDirectory()) return g;
      if (st.isFile()) { const m = /gitdir:\s*(.+)/.exec(readFileSync(g, "utf8")); if (m) return m[1].trim(); }
    } catch { /* keep walking */ }
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

// The state dir, or null. Override via AGENT_REFS_STATE_DIR (tests/advanced); else derive.
export function stateDir() {
  if (process.env.AGENT_REFS_STATE_DIR) return process.env.AGENT_REFS_STATE_DIR;
  const g = gitDir();
  return g ? join(g, "agent-refs", "state") : null;
}

// URL/file-inert, reversible-enough filename for any actor id.
function safe(name) {
  return String(name)
    .replace(/[^A-Za-z0-9-]/g, (c) => "_" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"))
    .replace(/^-/, "_2D");
}

// Best-effort atomic write of <stateDir>/<actor>.<concern>.json. Silent no-op if the state
// dir is absent (not installed), the actor is unknown, or anything fails.
export function writeState(concern, payload = {}, { actor = process.env.AGENT_ID } = {}) {
  try {
    if (!actor) return;
    const dir = stateDir();
    if (!dir || !existsSync(dir)) return;                 // config-by-convention gate
    const file = join(dir, `${safe(actor)}.${concern}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ actor, concern, ...payload, at: new Date().toISOString() }));
    renameSync(tmp, file);                                 // atomic replace
  } catch { /* cosmetic — never disrupt the primitive */ }
}

// Remove a concern file (e.g. heartbeat `gone`, lease fully released). Silent.
export function clearState(concern, { actor = process.env.AGENT_ID } = {}) {
  try {
    if (!actor) return;
    const dir = stateDir();
    if (!dir) return;
    rmSync(join(dir, `${safe(actor)}.${concern}.json`), { force: true });
  } catch { /* silent */ }
}
