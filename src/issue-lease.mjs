#!/usr/bin/env node
// gh-issue-lease — an atomic, GitHub-native mutex for multi-agent work.
//
// The lock IS a git ref: `refs/leases/issue-<N>`. Creating a ref is atomic on
// GitHub's backend, so the FIRST writer gets HTTP 201 and everyone else gets 422
// "Reference already exists". That one fact is the whole primitive — a real
// server-side mutex with no database and nothing to run.
//
// IDENTITY IS STRICT AND AGENT-AGNOSTIC. The owner of a lease is `AGENT_ID`, a
// unique label the LAUNCHER sets per logical agent. Child sub-agents/threads/procs
// INHERIT it through the environment, so a parent and the helpers it spawns are ONE
// owner (they never block each other), while two independent agents are always two
// owners (real collisions are caught). There is no host/user/session fallback: an
// unset AGENT_ID means "no identity", and we FAIL CLOSED (refuse to claim) rather
// than guess — guessing would either split a parent from its own children or merge
// two independent agents. AGENT_ID is just an env var, so Claude, Codex, a human, or
// a CI job all participate identically.
//
// Commands:
//   claim <N>     0 won · 1 held · 3 no AGENT_ID · (degraded→0, proceed unlocked)
//   next [flags]  atomically pop the next unclaimed open issue (0 won/degraded · 3 no
//                 AGENT_ID · 10 queue drained); prints the bare issue number to stdout
//   mine          the issues I currently hold (owner === my AGENT_ID)
//   release <N>   drop the lease
//   renew <N>     re-stamp your lease clock (heartbeat for long tasks)
//   status [<N>]  who holds what
//   reap          delete expired + closed-issue leases
//   guard-push <branch>   pre-push gate: 0 allowed · 1 blocked (the UNIVERSAL teeth)
//   hook          generic provider hook: claim+heartbeat the current branch's issue
//   codex-hook    Codex `notify` adapter (tolerates Codex's JSON argv; = hook)
//   claude-hook [--block] Claude Code adapter (SessionStart claim; PreToolUse can DENY)
//
// PROVIDER HOOKS DIFFER IN POWER, ON PURPOSE. Claude's PreToolUse can DENY an edit;
// Codex's notify can only observe (it fires after a turn, cannot block). So the real
// enforcement is `guard-push` in a git pre-push hook — it binds Claude, Codex, humans
// and CI identically. Provider hooks are convenience on top of that universal gate.
//
// Env: AGENT_ID (required to claim), AGENT_LEASE_TTL_MIN (default 240),
//      ISSUE_LEASE_NAMESPACE (default "leases"), GH_ISSUE_LEASE_MAX_RETRY (default 5).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { realpathSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { writeState, clearState } from "./state.mjs";

const DEFAULT_TTL_MIN = Number(process.env.AGENT_LEASE_TTL_MIN) || 240;
const NAMESPACE = (process.env.ISSUE_LEASE_NAMESPACE || "leases").replace(/^\/+|\/+$/g, "");
const MAX_RETRY = Number(process.env.GH_ISSUE_LEASE_MAX_RETRY) || 5;

// ---------- pure, unit-tested helpers ----------

export function refShort(n) { return `${NAMESPACE}/issue-${n}`; }        // for git/ref/<this>
export function refFull(n) { return `refs/${NAMESPACE}/issue-${n}`; }    // for creating

// Strict identity: AGENT_ID or nothing. Trimmed; blank → null ("no identity").
export function resolveOwner(env = process.env) {
  const id = (env.AGENT_ID || "").trim();
  return id || null;
}

export function parseLeaseMessage(message) {
  try { const m = JSON.parse(message); return { owner: m.owner ?? null, ttlMin: m.ttlMin ?? DEFAULT_TTL_MIN, issue: m.issue ?? null }; }
  catch { return { owner: null, ttlMin: DEFAULT_TTL_MIN, issue: null }; }
}

export function isExpired(claimedAtISO, ttlMin, nowMs) {
  const claimed = Date.parse(claimedAtISO);
  if (Number.isNaN(claimed)) return true; // unreadable clock → treat as reclaimable
  return nowMs - claimed > ttlMin * 60_000;
}

// Positive-integer issue numbers only — this becomes the ref name.
export function normalizeIssue(n) {
  const x = Number(n);
  return Number.isInteger(x) && x > 0 ? x : null;
}

// Backoff with jitter so a herd of agents self-spaces instead of retrying in lockstep.
export function backoffMs(attempt, rng = Math.random) {
  const base = Math.min(1000 * 2 ** attempt, 30_000);
  return Math.round(base / 2 + rng() * (base / 2));
}

// Extract the issue number from a branch (`<type>/<N>-<slug>` or `issue-<N>`).
// Returns null for non-issue branches — they are not gated.
export function issueFromBranch(branch) {
  const m = String(branch).match(/(?:^|\/)(?:issue-)?(\d+)-/) || String(branch).match(/issue-(\d+)/);
  return m ? Number(m[1]) : null;
}

// PURE decision: given who I am and the current lease holder, may I push this branch?
// Fail-open on "no holder" (a missing claim is not a conflict) and on unknown holder
// only when it's me. Blocks when someone else holds it, or when a lease exists but I
// have no identity to prove it's mine.
export function pushDecision({ me, holder }) {
  if (!holder) return { allow: true };
  if (me && holder.owner === me) return { allow: true };
  const why = !me
    ? `issue is leased by ${holder.owner || "another agent"} and AGENT_ID is unset, so ownership can't be verified`
    : `issue is leased by ${holder.owner || "another agent"}`;
  return { allow: false, reason: why };
}

// PURE decision: what should the provider hook (e.g. Claude) do, given identity, the
// issue, whether it's a blocking call, and the claim outcome?
//   no-identity : AGENT_ID unset → warn, never block (the git layer is the backstop)
//   noop        : not an issue branch, or gh degraded → do nothing
//   deny        : someone else holds it AND this is a blocking (edit) call
//   warn        : someone else holds it, non-blocking call
//   held        : I hold it (fresh, stolen, or already mine)
export function hookDecision({ me, n, block, claim }) {
  if (!me) return { kind: "no-identity" };
  if (!n) return { kind: "noop" };
  if (!claim || claim.result === "degraded") return { kind: "noop" };
  if (claim.result === "held" && claim.holder && claim.holder.owner !== me)
    return { kind: block ? "deny" : "warn", issue: n, holder: claim.holder.owner };
  return { kind: "held", issue: n, owner: me };
}

// PURE: scan an issue body for blocker references, returning de-duped issue numbers.
// Matches (case-insensitive): `blocked by #N`, `blocked-by #N`, `depends on #N`,
// `depends-on #N`, and UNCHECKED GitHub task-list lines `- [ ] … #N` (a checked
// `- [x] #N` is deliberately NOT a blocker). Total & network-free: empty/nullish → [].
export function parseBlockers(body) {
  if (!body) return [];
  const text = String(body);
  const nums = new Set();
  const phrase = /(?:blocked[ -]by|depends[ -]on)\s*:?\s*#(\d+)/gi;
  for (let m; (m = phrase.exec(text)); ) nums.add(Number(m[1]));
  for (const line of text.split(/\r?\n/)) {
    const box = line.match(/^\s*[-*]\s*\[ \]/); // literal space ⇒ unchecked only
    if (!box) continue;
    const rest = line.slice(box[0].length);
    for (let m, re = /#(\d+)/g; (m = re.exec(rest)); ) nums.add(Number(m[1]));
  }
  return [...nums];
}

// PURE, injectable core of the `next` verb — no network. Walks candidates in order,
// optionally skipping any with an OPEN blocker, and attempts to claim each via the
// injected `claimFn` (the real one is `claim`). Returns a result kind:
//   degraded    — the queue is genuinely unreachable (proceed unlocked)
//   no-identity — a claim reported AGENT_ID is unset (fail closed)
//   won         — first winnable candidate (carries its number)
//   empty       — a FULL pass found every candidate definitively held (queue drained)
// `listIssues()` → array of {number, body, …} OR a {degraded:true} sentinel.
// `isBlockerOpen(n)` → boolean (only consulted when skipBlocked).
//
// LIVENESS has TWO failure modes, both handled here:
//  1. Transient (`degraded` from claimFn) — a rate-limit on issue A must not abandon a
//     still-free issue B. So a `degraded` claim is a SOFT-skip: keep walking the pass,
//     and if the pass wins nothing while any transient was seen, re-list + retry (backoff).
//  2. INDEX LAG — GitHub's label-filtered issue list is EVENTUALLY CONSISTENT: a freshly
//     created issue takes ~5s to appear, so a single read can return `[]` (or a subset)
//     that is indistinguishable from a genuinely drained backlog. Therefore a clean
//     no-win pass (zero candidates OR every candidate definitively held, no transients)
//     may NEVER declare `empty`/drained on one read. It must CONFIRM: wait `confirmDelayMs`
//     and re-list, and only reach `empty` after the confirm window (spanning the passes)
//     elapses still finding nothing claimable. A genuinely-empty backlog still reaches
//     exit-10 — just after the confirm, not on the first read.
// Result kinds: won | empty (drained, confirmed) | degraded (lister down / all-transient)
// | no-identity. Confirm window ≈ (maxPasses-1) × confirmDelayMs ≥ observed ~5s lag.
export function nextWalk({ listIssues, claimFn, isBlockerOpen, skipBlocked = false, maxPasses = 4, sleep = () => {}, confirmDelayMs = 3000 }) {
  for (let pass = 0; pass < maxPasses; pass++) {
    const last = pass === maxPasses - 1;
    const issues = listIssues();
    if (!issues || issues.degraded) {                 // lister down this pass
      if (last) return { kind: "degraded" };
      sleep(backoffMs(pass));
      continue;
    }
    let sawDegraded = false;
    for (const it of issues) {
      if (skipBlocked) {
        let blocked = false;
        for (const b of parseBlockers(it.body)) { if (isBlockerOpen(b)) { blocked = true; break; } }
        if (blocked) continue;
      }
      const r = claimFn(it.number);
      if (r.result === "won") return { kind: "won", number: it.number };
      if (r.result === "no-identity") return { kind: "no-identity" };
      if (r.result === "degraded") { sawDegraded = true; continue; } // SOFT-skip, keep walking
      // held / expired-then-lost → try the next candidate
    }
    if (sawDegraded) {                                 // transient in play → backoff & retry
      if (last) return { kind: "degraded" };
      sleep(backoffMs(pass));
      continue;
    }
    // Clean no-win pass (zero candidates, or every candidate held) — could be index lag.
    if (last) return { kind: "empty" };                // confirm window elapsed → truly drained
    sleep(confirmDelayMs);                             // CONFIRM-BEFORE-DRAIN: wait out lag, re-list
  }
  return { kind: "empty" };                             // defensive; loop always returns first
}

// ---------- gh plumbing (the only I/O; everything above is pure) ----------

function ghRaw(args, input) {
  const r = spawnSync("gh", args, { input, encoding: "utf8" });
  return { status: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
// A transient is anything worth retrying: 5xx, network resets, AND the rate-limit family.
// GitHub's SECONDARY rate limit / abuse-detection (a burst of ref+commit writes from a
// racing fleet) surfaces as 403/429 with "secondary rate limit"/"abuse" wording or a
// `Retry-After` header — those MUST retry, never be mistaken for a business error.
export function isTransient(err) {
  return /rate limit|secondary rate|abuse|retry[- ]after|\b(?:5\d\d|429)\b|timeout|timed out|EAI_AGAIN|ECONNRESET|temporarily/i.test(err);
}
// If GitHub told us how long to wait, honor it (bounded), else null → caller backs off.
export function retryAfterMs(err, capMs = 30_000) {
  const m = /retry[- ]after[:"\s]+(\d+)/i.exec(String(err));
  if (!m) return null;
  return Math.min(Math.max(Number(m[1]), 1) * 1000, capMs);
}
const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB → skip */ } };

// `{owner}`/`{repo}` are filled by gh from the current repo — no slug lookup, one
// fewer subprocess on every single call.
function gh(method, path, body, { retry = MAX_RETRY } = {}) {
  const args = ["api", "--method", method, `repos/{owner}/{repo}/${path}`];
  if (body) args.push("--input", "-");
  const input = body ? JSON.stringify(body) : undefined;
  let last;
  for (let attempt = 0; attempt <= retry; attempt++) {
    last = ghRaw(args, input);
    if (last.status === 0) return last;
    if (/already exists/i.test(last.err)) return last;     // terminal business error
    if (!isTransient(last.err) || attempt === retry) return last;
    const ra = retryAfterMs(last.err);                     // honor GitHub's Retry-After if given
    sleep(ra != null ? ra : backoffMs(attempt));
  }
  return last;
}

let TREE = null;
// Any existing tree sha works as the lease commit's tree (it carries no files).
// `commits/HEAD` returns the default branch tip's tree in ONE call.
function baseTree() {
  if (TREE) return TREE;
  const r = gh("GET", "commits/HEAD");
  if (r.status !== 0) throw new Error("gh unavailable");
  return (TREE = JSON.parse(r.out).commit.tree.sha);
}
function getHolder(n) {
  const ref = gh("GET", `git/ref/${refShort(n)}`);
  if (ref.status !== 0) return null;
  const sha = JSON.parse(ref.out).object.sha;
  const commit = JSON.parse(gh("GET", `git/commits/${sha}`).out);
  return { ...parseLeaseMessage(commit.message), claimedAt: commit.committer.date, sha };
}
function mkRef(n, message) {
  const c = gh("POST", "git/commits", { message, tree: baseTree() });
  if (c.status !== 0) return { result: "degraded" };
  const sha = JSON.parse(c.out).sha;
  const ref = gh("POST", "git/refs", { ref: refFull(n), sha });
  if (ref.status === 0) return { result: "won" };
  if (/already exists/i.test(ref.err)) return { result: "held" };
  return { result: "degraded" };
}

// ---------- primitive ----------

// claim — atomic. Returns {result, holder?}:
//   won | held | degraded (gh offline → proceed unlocked) | no-identity (AGENT_ID unset)
export function claim(n, { ttlMin = DEFAULT_TTL_MIN, owner = resolveOwner() } = {}) {
  const issue = normalizeIssue(n);
  if (issue === null) throw new Error(`invalid issue number: ${n}`);
  if (!owner) return { result: "no-identity" };
  let message;
  try { baseTree(); message = JSON.stringify({ v: 1, issue, owner, ttlMin }); }
  catch { return { result: "degraded" }; }

  const first = mkRef(issue, message);
  if (first.result !== "held") return first;

  const holder = getHolder(issue);
  if (!holder) return mkRef(issue, message);                          // vanished → retry
  if (holder.owner === owner) return { result: "won", holder };       // idempotent: already mine (parent↔child)
  if (!isExpired(holder.claimedAt, holder.ttlMin, Date.now())) return { result: "held", holder };

  gh("DELETE", `git/refs/${refShort(issue)}`);                        // expired → best-effort steal
  const second = mkRef(issue, message);
  if (second.result !== "held") return second;
  const now = getHolder(issue);
  if (now && now.owner === owner) return { result: "won", holder: now };
  return { result: "held", holder: now };
}

export function renew(n, { ttlMin = DEFAULT_TTL_MIN, owner = resolveOwner() } = {}) {
  const issue = normalizeIssue(n);
  if (issue === null) throw new Error(`invalid issue number: ${n}`);
  if (!owner) return { result: "no-identity" };
  const holder = getHolder(issue);
  if (holder && holder.owner !== owner && !isExpired(holder.claimedAt, holder.ttlMin, Date.now()))
    return { result: "held", holder };
  let message;
  try { message = JSON.stringify({ v: 1, issue, owner, ttlMin }); baseTree(); }
  catch { return { result: "degraded" }; }
  const c = gh("POST", "git/commits", { message, tree: baseTree() });
  if (c.status !== 0) return { result: "degraded" };
  const sha = JSON.parse(c.out).sha;
  const up = gh("PATCH", `git/refs/${refShort(issue)}`, { sha, force: true });
  if (up.status === 0) return { result: "renewed" };
  return mkRef(issue, message).result === "won" ? { result: "renewed" } : { result: "degraded" };
}

export function release(n) {
  const issue = normalizeIssue(n);
  if (issue === null) return false;
  try { const d = gh("DELETE", `git/refs/${refShort(issue)}`); return d.status === 0; }
  catch { return false; }
}

export function listLeases() {
  const out = [];
  for (let page = 1; ; page++) {
    const r = gh("GET", `git/matching-refs/${NAMESPACE}/issue-?per_page=100&page=${page}`);
    if (r.status !== 0) break;
    let batch; try { batch = JSON.parse(r.out); } catch { break; }
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const x of batch) {
      const num = Number(String(x.ref).replace(`refs/${NAMESPACE}/issue-`, ""));
      if (Number.isInteger(num)) out.push(num);
    }
    if (batch.length < 100) break;
  }
  return out;
}

// IO: the open-issue backlog, oldest-first, as {number,title,body,assignee}. Drops
// pull requests. `labels` (csv) / `milestone` (number) narrow server-side; `unassigned`
// keeps only assignee===null (client-side). Fail-OPEN: any gh trouble → {degraded:true}
// so `next` proceeds unlocked instead of crashing. gh fills owner/repo from the cwd.
export function listOpenIssues({ labels = null, milestone = null, unassigned = false } = {}, _env = process.env) {
  let path = "issues?state=open&sort=created&direction=asc&per_page=100";
  if (labels) path += `&labels=${encodeURIComponent(labels)}`;
  if (milestone !== null && milestone !== undefined && String(milestone) !== "") path += `&milestone=${encodeURIComponent(milestone)}`;
  const r = gh("GET", path);
  if (r.status !== 0) return { degraded: true };
  let items;
  try { items = JSON.parse(r.out); } catch { return { degraded: true }; }
  if (!Array.isArray(items)) return { degraded: true };
  const out = [];
  for (const it of items) {
    if (it.pull_request) continue;                       // issues endpoint also returns PRs
    if (unassigned && it.assignee !== null) continue;    // keep only unassigned
    out.push({ number: it.number, title: it.title, body: it.body, assignee: it.assignee });
  }
  return out;
}

// ---------- CLI ----------

const IDENTITY_HINT = "Set a unique AGENT_ID per agent (child sub-agents inherit it), e.g. export AGENT_ID=codex-7";

function cmdStatus(n) {
  const nums = n ? [normalizeIssue(n)].filter(Boolean) : listLeases();
  if (!nums.length) { console.log("no active issue leases"); return 0; }
  for (const num of nums) {
    const h = getHolder(num);
    if (!h) { console.log(`  #${num}  (no lease)`); continue; }
    const exp = isExpired(h.claimedAt, h.ttlMin, Date.now());
    const ageMin = Math.round((Date.now() - Date.parse(h.claimedAt)) / 60000);
    console.log(`  #${num}  ${(h.owner || "?").padEnd(24)} claimed ${ageMin}m ago  ttl ${h.ttlMin}m  ${exp ? "EXPIRED (stealable)" : "live"}`);
  }
  return 0;
}

function cmdReap() {
  let reaped = 0;
  for (const num of listLeases()) {
    const h = getHolder(num);
    const expired = !h || isExpired(h.claimedAt, h.ttlMin, Date.now());
    let closed = false;
    if (!expired) {
      const iv = ghRaw(["issue", "view", String(num), "--json", "state", "--jq", ".state"]);
      if (iv.status === 0) closed = iv.out === "CLOSED";
    }
    if (expired || closed) { if (release(num)) { reaped++; console.log(`  reaped #${num} (${closed ? "issue closed" : "expired"})`); } }
  }
  console.log(`reaped ${reaped} lease(s)`);
  return 0;
}

// `next` — atomically pop the next unclaimed open issue from a filtered backlog.
// Bare winning number → stdout (scriptable: ISSUE=$(gh-issue-lease next --label ready));
// human line → stderr. Exit 0 won/degraded · 3 no AGENT_ID · 10 queue drained.
function cmdNext(rest) {
  const labels = [];
  let milestone = null, unassigned = false, skipBlocked = false, ttlMin = DEFAULT_TTL_MIN;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--label") labels.push(rest[++i]);
    else if (a.startsWith("--label=")) labels.push(a.slice(8));
    else if (a === "--milestone") milestone = rest[++i];
    else if (a.startsWith("--milestone=")) milestone = a.slice(12);
    else if (a === "--unassigned") unassigned = true;
    else if (a === "--skip-blocked") skipBlocked = true;
    else if (a === "--ttl") ttlMin = Number(rest[++i]) || DEFAULT_TTL_MIN;
    else if (a.startsWith("--ttl=")) ttlMin = Number(a.slice(6)) || DEFAULT_TTL_MIN;
  }
  const blockerState = new Map(); // cache blocker-state lookups within this call
  const isBlockerOpen = (b) => {
    if (blockerState.has(b)) return blockerState.get(b);
    const r = gh("GET", `issues/${b}`);
    let open = false; // closed OR missing OR unreadable ⇒ not blocking
    if (r.status === 0) { try { open = JSON.parse(r.out).state === "open"; } catch { open = false; } }
    blockerState.set(b, open);
    return open;
  };
  const result = nextWalk({
    listIssues: () => listOpenIssues({ labels: labels.length ? labels.join(",") : null, milestone, unassigned }),
    claimFn: (n) => claim(n, { ttlMin }),
    isBlockerOpen,
    skipBlocked,
    sleep, // real backoff between retry passes under live rate-limit pressure
  });
  switch (result.kind) {
    case "won":
      writeState("issue", { issue: result.number });
      console.log(String(result.number));                     // bare number, scriptable
      console.error(`🔒 claimed next issue #${result.number}`);
      return 0;
    case "no-identity":
      console.error(`✗ AGENT_ID is not set — refusing to claim. ${IDENTITY_HINT}`);
      return 3;
    case "degraded":
      console.error("⚠ leasing unavailable (gh offline/unauthed) — proceed WITHOUT a lease.");
      return 0;
    default: // "empty"
      console.error("no unclaimed issue available in the filtered queue (all claimed or blocked)");
      return 10;
  }
}

// `mine` — the issues I currently hold (owner === my AGENT_ID). Always exit 0.
function cmdMine() {
  const me = resolveOwner();
  const held = [];
  for (const num of listLeases()) {
    const h = getHolder(num);
    if (!h || h.owner !== me) continue;
    const ageMin = Math.round((Date.now() - Date.parse(h.claimedAt)) / 60000);
    held.push(`#${num}  ${ageMin}m old  ttl ${h.ttlMin}m${isExpired(h.claimedAt, h.ttlMin, Date.now()) ? "  (expired)" : ""}`);
  }
  if (!held.length) { console.error(me ? "no issues held" : `no issues held (AGENT_ID unset). ${IDENTITY_HINT}`); return 0; }
  for (const line of held) console.log(line);
  return 0;
}

// A per-worktree "I hold #N" marker inside the worktree's git dir. Parent and its
// child sub-agents share the worktree → share this file, so after SessionStart the
// per-edit PreToolUse check is a local file read (~0 network) instead of a GitHub
// round-trip. Trusted only within the lease TTL, so it can never outlive the lease.
const MARKER = "gh-issue-lease-hold.json";

// PURE: `.git/HEAD` is `ref: refs/heads/<branch>` on a branch, or a raw sha when
// detached. Detached → "" (no issue branch → nothing to gate).
export function parseHeadRef(text) {
  const m = String(text).trim().match(/^ref:\s*refs\/heads\/(.+)$/);
  return m ? m[1].trim() : "";
}
// PURE: a linked-worktree/submodule `.git` is a FILE `gitdir: <path>`.
export function parseDotGitFile(text) {
  const m = String(text).match(/gitdir:\s*(.+)/);
  return m ? m[1].trim() : null;
}

// Resolve the branch + the worktree's git dir WITHOUT spawning git — on the per-edit
// hot path this replaces a ~5-10ms fork/exec with ~0.2ms of file reads, so the check
// is bounded only by Node's own startup. Walks up for `.git` (dir OR worktree/submodule
// file), then reads HEAD. Falls back to `git rev-parse` for anything exotic.
function gitContext(cwd) {
  let dir = cwd;
  for (;;) {
    const dotgit = join(dir, ".git");
    let st = null; try { st = statSync(dotgit); } catch { st = null; }
    if (st) {
      let gitDir;
      if (st.isDirectory()) gitDir = dotgit;
      else {
        let ptr = null; try { ptr = parseDotGitFile(readFileSync(dotgit, "utf8")); } catch { ptr = null; }
        if (!ptr) return gitFallback(cwd);
        gitDir = isAbsolute(ptr) ? ptr : resolve(dir, ptr);
      }
      let head = ""; try { head = readFileSync(join(gitDir, "HEAD"), "utf8"); } catch { return gitFallback(cwd); }
      return { branch: parseHeadRef(head), gitDir };
    }
    const parent = dirname(dir);
    if (parent === dir) return gitFallback(cwd); // reached fs root, no repo → let git decide (GIT_DIR env, etc.)
    dir = parent;
  }
}
function gitFallback(cwd) {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD", "--absolute-git-dir"], { encoding: "utf8" });
  if (r.status !== 0) return { branch: "", gitDir: null };
  const lines = r.stdout.trim().split("\n");
  return { branch: (lines[0] || "").trim(), gitDir: (lines[1] || "").trim() || null };
}
function markerPath(gitDir) { return gitDir ? join(gitDir, MARKER) : null; }
function readMarker(file) { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } }
function writeMarker(file, issue, owner) {
  try { writeFileSync(file, JSON.stringify({ issue, owner, ttlMin: DEFAULT_TTL_MIN, at: Date.now() })); } catch { /* best effort */ }
}

// PURE: Codex's `notify` passes a single JSON string as an argv. We only need it to
// not crash and to surface an optional cwd; unparseable/absent → {}.
export function codexEvent(argv) {
  const jsonArg = (argv || []).find((a) => typeof a === "string" && a.trim().startsWith("{"));
  if (!jsonArg) return {};
  try { return JSON.parse(jsonArg); } catch { return {}; }
}

// The generic, provider-agnostic hook: claim (or heartbeat-renew) the current
// branch's issue as AGENT_ID and refresh the local marker. Advisory only — always
// exits 0, never blocks (only Claude's PreToolUse can block; that path is separate).
// Throttled by the marker so a chatty per-turn hook does at most one GitHub write per
// TTL/3, and never re-checks the network while the lease demonstrably can't have
// expired. This is what Codex notify, a shell PROMPT_COMMAND, Cursor, or CI all call.
function holdCurrentBranch(cwd) {
  const me = resolveOwner();
  if (!me) { console.error(`⚠ AGENT_ID is not set — issue-lease protection is DISABLED for this worker. ${IDENTITY_HINT}`); return 0; }
  const { branch, gitDir } = gitContext(cwd);
  const n = issueFromBranch(branch);
  if (!n) return 0; // not an issue branch → nothing to hold
  const mf = markerPath(gitDir);
  const cur = mf && readMarker(mf);
  const ttlMs = DEFAULT_TTL_MIN * 60_000;
  if (cur && cur.issue === n && cur.owner === me && Date.now() - cur.at < ttlMs / 3) {
    console.error(`🔒 holding issue #${n} as "${me}" (lease fresh; no network)`); return 0;
  }
  const r = renew(n, { owner: me }); // renew both creates and re-stamps; returns held if a live foreign lease exists
  if (r.result === "renewed") { if (mf) writeMarker(mf, n, me); console.error(`🔒 holding issue #${n} as "${me}"`); return 0; }
  if (r.result === "held") { console.error(`⚠ issue #${n} is leased by ${r.holder?.owner || "another agent"} — coordinate or switch issues.`); return 0; }
  console.error("⚠ leasing unavailable (gh offline/unauthed) — proceeding WITHOUT a lease; watch for collisions."); return 0;
}

function cmdCodexHook(argv) {
  const ev = codexEvent(argv);
  return holdCurrentBranch(ev.cwd || process.cwd());
}

function cmdClaudeHook(argv) {
  const block = argv.includes("--block");
  let payload = {};
  try { const raw = readFileSync(0, "utf8"); if (raw) payload = JSON.parse(raw); } catch { /* best effort */ }
  const event = payload.hook_event_name || "SessionStart";
  const cwd = payload.cwd || process.cwd();
  const { branch, gitDir } = gitContext(cwd);
  const n = issueFromBranch(branch);
  const me = resolveOwner();

  const emit = (text) => {
    if (event === "SessionStart" || event === "UserPromptSubmit")
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
  };

  let situation = null;
  if (me && n) {
    const mf = markerPath(gitDir);
    if (event === "PreToolUse") {
      // Hot path: trust a fresh self-held marker → allow with NO network call.
      const c = mf && readMarker(mf);
      if (c && c.issue === n && c.owner === me && Date.now() - c.at < (c.ttlMin || DEFAULT_TTL_MIN) * 60_000) {
        situation = { result: "won" };
      } else {
        // Read-only ownership check (never create a lease on an edit). gh-offline → allow.
        let holder = null;
        try { holder = getHolder(n); } catch { holder = undefined; }
        if (holder === undefined) situation = { result: "degraded" };
        else if (holder && holder.owner === me) { situation = { result: "won" }; if (mf) writeMarker(mf, n, me); }
        else if (holder) situation = { result: "held", holder };
        else situation = { result: "won" }; // no lease exists → allow, but do NOT mark (we don't own it)
      }
    } else {
      situation = claim(n, { owner: me });
      if (situation.result === "won" && mf) writeMarker(mf, n, me);
    }
  }
  const d = hookDecision({ me, n, block, claim: situation });

  switch (d.kind) {
    case "no-identity": {
      const msg = `AGENT_ID is not set — issue-lease protection is DISABLED for this worker. ${IDENTITY_HINT}`;
      console.error(`⚠ ${msg}`); emit(`⚠ ${msg}`); return 0;
    }
    case "deny": {
      const msg = `Issue #${d.issue} is leased by ${d.holder}. Another agent is working it — coordinate or switch issues before editing.`;
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: msg } }));
      return 0;
    }
    case "warn": {
      const msg = `Issue #${d.issue} is already leased by ${d.holder}. Another agent is working it — coordinate or switch issues.`;
      console.error(`⚠ ${msg}`); emit(`⚠ ${msg}`); return 0;
    }
    case "held": {
      if (event !== "PreToolUse") {
        const msg = `You hold the gh-issue-lease on issue #${d.issue} as "${d.owner}". Other agents are blocked from it.`;
        console.error(`🔒 ${msg}`); emit(msg);
      }
      return 0;
    }
    default: return 0; // noop
  }
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const pos = rest.filter((a) => !a.startsWith("--"));
  switch (cmd) {
    case "claim": {
      const r = claim(pos[0], {});
      if (r.result === "won") { writeState("issue", { issue: normalizeIssue(pos[0]) }); console.log("won"); return 0; }
      if (r.result === "degraded") { console.error("⚠ leasing unavailable (gh offline/unauthed) — proceed WITHOUT a lease."); console.log("degraded"); return 0; }
      if (r.result === "no-identity") { console.error(`✗ AGENT_ID is not set — refusing to claim. ${IDENTITY_HINT}`); return 3; }
      console.error(`held by ${r.holder?.owner || "another agent"}`); return 1;
    }
    case "renew": {
      const r = renew(pos[0], {});
      if (r.result === "no-identity") { console.error(`✗ AGENT_ID is not set. ${IDENTITY_HINT}`); return 3; }
      console.log(r.result); return r.result === "held" ? 1 : 0;
    }
    case "release": {
      const ok = release(pos[0]);
      clearState("issue"); // cosmetic breadcrumb; no-op unless agent-refs installed
      return ok ? (console.log("released"), 0) : (console.log("no lease to release"), 0);
    }
    case "next": return cmdNext(rest);
    case "mine": return cmdMine();
    case "status": return cmdStatus(pos[0]);
    case "reap": return cmdReap();
    case "guard-push": {
      // pre-push gate. Read-only ownership check — never creates a lease. Non-issue
      // branches and gh-offline pass (fail-open on infra); a lease held by someone
      // else (or held while you have no AGENT_ID to prove it) blocks.
      const n = issueFromBranch(pos[0]);
      if (!n) return 0;
      const me = resolveOwner();
      let holder = null;
      try { holder = getHolder(n); } catch { return 0; } // gh unusable → don't block
      const d = pushDecision({ me, holder });
      if (d.allow) return 0;
      console.error(`✗ push blocked: ${d.reason} (issue #${n}).`);
      console.error(`  Set AGENT_ID / coordinate, or bypass with: git push --no-verify`);
      return 1;
    }
    case "hook": return holdCurrentBranch(process.cwd());
    case "codex-hook": return cmdCodexHook(rest);
    case "claude-hook": return cmdClaudeHook(rest);
    default:
      console.error("gh-issue-lease: claim <N> | next [--label X].. [--milestone N] [--unassigned] [--skip-blocked] [--ttl N] | mine | release <N> | renew <N> | status [<N>] | reap | guard-push <branch> | hook | codex-hook | claude-hook [--block]");
      return 2;
  }
}

// Run the CLI when invoked directly. npm/pnpm install the bin as a SYMLINK, so a
// naive argv[1]-vs-import.meta.url compare fails and the CLI silently no-ops.
function isCliEntry() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isCliEntry()) {
  try { process.exit(main(process.argv.slice(2))); }
  catch (err) { console.error(`gh-issue-lease: ${err.message}`); process.exit(1); }
}
