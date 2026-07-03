#!/usr/bin/env node
// gh-issue-lease — an atomic, GitHub-native mutex for multi-agent work.
//
// The lock IS a git ref: `refs/leases/issue-<N>`. Creating a ref is atomic on
// GitHub's backend, so the FIRST writer gets HTTP 201 and everyone else gets 422
// "Reference already exists". That single fact is the whole primitive — a real
// server-side mutex with no database, no service, and no state you have to run.
//
// The ref points at a tiny root commit whose message carries {v,issue,owner,ttlMin}
// and whose GitHub-set commit date is the lease clock. A crashed agent's lease
// therefore expires on its own, and the next claimer reclaims it. No heartbeat
// required — though `renew` is provided for tasks that legitimately outlast the TTL.
//
// WHY NOT A DATABASE: a mutex only works if every agent sees the SAME lock. GitHub
// is the shared, atomic, already-authenticated store every agent can already reach.
// An embedded DB (SQLite) is per-machine and cannot be that shared store. The gh
// calls live behind a small `backend` seam so a local-fs backend (single-host) or a
// networked backend (extreme scale) can drop in — but the default install is zero-dep.
//
// Commands:
//   claim <N>     0 = won/degraded, 1 = held by someone else
//   release <N>   drop the lease (unconditional)
//   renew <N>     re-stamp my lease's clock (heartbeat for long tasks)
//   status [<N>]  who holds what
//   reap          delete expired + closed-issue leases
//   guard-push <branch>   pre-push hook: 0 = allowed, 1 = blocked
//
// Env: AGENT_ID (owner label — set this per agent), AGENT_LEASE_TTL_MIN (default 240),
//      ISSUE_LEASE_NAMESPACE (ref namespace, default "leases"),
//      GH_ISSUE_LEASE_MAX_RETRY (backoff attempts on rate-limit/5xx, default 5).

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_TTL_MIN = Number(process.env.AGENT_LEASE_TTL_MIN) || 240;
const NAMESPACE = (process.env.ISSUE_LEASE_NAMESPACE || "leases").replace(/^\/+|\/+$/g, "");
const MAX_RETRY = Number(process.env.GH_ISSUE_LEASE_MAX_RETRY) || 5;

// ---------- pure, unit-tested helpers ----------

export function refShort(n) { return `${NAMESPACE}/issue-${n}`; }        // for git/ref/<this>
export function refFull(n) { return `refs/${NAMESPACE}/issue-${n}`; }    // for creating

// A stable, attributable owner label. AGENT_ID is the identity key at scale and
// MUST be unique per agent — if two agents share an owner they are indistinguishable
// and idempotent-claim (owner===me → won) will wrongly let both proceed. buildOwner
// falls back to user@host so a single human still gets attribution; the CLI warns.
export function buildOwner(env = process.env) {
  if (env.AGENT_ID) return env.AGENT_ID;
  const who = env.USER || env.LOGNAME || "agent";
  const host = (env.HOSTNAME || "").split(".")[0];
  return host ? `${who}@${host}` : who;
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

// Positive-integer issue numbers only — this is what becomes the ref name, so a
// non-integer must never reach the API. Returns null for anything invalid.
export function normalizeIssue(n) {
  const x = Number(n);
  return Number.isInteger(x) && x > 0 ? x : null;
}

// Backoff schedule with jitter, so a thundering herd of agents self-spaces instead
// of retrying in lockstep. Exposed for tests; pure given a rng.
export function backoffMs(attempt, rng = Math.random) {
  const base = Math.min(1000 * 2 ** attempt, 30_000);
  return Math.round(base / 2 + rng() * (base / 2));
}

// ---------- backend seam ----------
// Everything below talks to GitHub only through `gh()`. Swapping this object for a
// local-fs or networked implementation is how the package would scale past GitHub's
// per-token rate limit without changing the primitive. Default: the github backend.

function ghRaw(args, input) {
  const r = spawnSync("gh", args, { input, encoding: "utf8" });
  return { status: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

// Is this stderr a transient failure worth backing off and retrying?
function isTransient(err) {
  return /rate limit|secondary rate|abuse|\b5\d\d\b|timeout|timed out|EAI_AGAIN|ECONNRESET|temporarily/i.test(err);
}

// Synchronous sleep with no CPU spin — Atomics.wait blocks the thread cleanly.
// (The CLI is a short-lived synchronous process; spawnSync above is already blocking.)
const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* SAB unavailable → skip the wait */ } };

function gh(method, path, body, { retry = MAX_RETRY } = {}) {
  const args = ["api", "--method", method, `repos/${slug()}/${path}`];
  if (body) args.push("--input", "-");
  const input = body ? JSON.stringify(body) : undefined;
  let last;
  for (let attempt = 0; attempt <= retry; attempt++) {
    last = ghRaw(args, input);
    if (last.status === 0) return last;
    // "already exists" and other 4xx business errors are terminal — do not retry.
    if (/already exists/i.test(last.err)) return last;
    if (!isTransient(last.err) || attempt === retry) return last;
    sleep(backoffMs(attempt));
  }
  return last;
}

let SLUG = null;
function slug() {
  if (SLUG) return SLUG;
  const r = ghRaw(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  if (r.status !== 0) throw new Error("gh unavailable");
  return (SLUG = r.out);
}

let DEFAULT_BRANCH = null;
function defaultBranch() {
  if (DEFAULT_BRANCH) return DEFAULT_BRANCH;
  const r = ghRaw(["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]);
  if (r.status !== 0 || !r.out) throw new Error("cannot resolve default branch");
  return (DEFAULT_BRANCH = r.out);
}

let TREE = null;
// Reuse the default branch's existing tree so a lease commit creates no new tree
// object (tiny, GC-friendly). Cached per process.
function baseTree() {
  if (TREE) return TREE;
  const ref = gh("GET", `git/ref/heads/${defaultBranch()}`);
  const tip = JSON.parse(ref.out).object.sha;
  return (TREE = JSON.parse(gh("GET", `git/commits/${tip}`).out).tree.sha);
}

function getHolder(n) {
  const ref = gh("GET", `git/ref/${refShort(n)}`);
  if (ref.status !== 0) return null;
  const sha = JSON.parse(ref.out).object.sha;
  const commit = JSON.parse(gh("GET", `git/commits/${sha}`).out);
  return { ...parseLeaseMessage(commit.message), claimedAt: commit.committer.date, sha };
}

// Create the lease commit + ref. Returns {result:'won'|'held'|'degraded'}.
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

// claim — the atomic operation. Returns {result:'won'|'held'|'degraded', holder?}.
//   won      : you hold the lease (freshly, by steal, or you already held it)
//   held     : someone else holds a live lease — `holder` describes them
//   degraded : gh is offline/unauthed — caller should PROCEED WITHOUT a lease
export function claim(n, { ttlMin = DEFAULT_TTL_MIN, owner = buildOwner() } = {}) {
  const issue = normalizeIssue(n);
  if (issue === null) throw new Error(`invalid issue number: ${n}`);
  let message;
  try { baseTree(); message = JSON.stringify({ v: 1, issue, owner, ttlMin }); }
  catch { return { result: "degraded" }; }

  const first = mkRef(issue, message);
  if (first.result !== "held") return first;

  // Contended. Re-read the current holder to decide.
  const holder = getHolder(issue);
  if (!holder) return mkRef(issue, message);          // vanished between calls → retry create
  if (holder.owner === owner) return { result: "won", holder };  // idempotent: already mine
  if (!isExpired(holder.claimedAt, holder.ttlMin, Date.now())) return { result: "held", holder };

  // Expired → best-effort steal. NOTE: GitHub refs have no compare-and-swap, so the
  // hard guarantee remains the atomic create below; the delete is a tiny TOCTOU window.
  gh("DELETE", `git/refs/${refShort(issue)}`);
  const second = mkRef(issue, message);
  if (second.result !== "held") return second;
  const now = getHolder(issue);
  if (now && now.owner === owner) return { result: "won", holder: now };
  return { result: "held", holder: now };
}

// renew — heartbeat for a task that legitimately outlasts its TTL. Re-stamps the
// lease clock IF you still own it (or it already expired). Force-updates the ref to a
// fresh commit. Returns {result:'renewed'|'held'|'degraded'}.
export function renew(n, { ttlMin = DEFAULT_TTL_MIN, owner = buildOwner() } = {}) {
  const issue = normalizeIssue(n);
  if (issue === null) throw new Error(`invalid issue number: ${n}`);
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

// list — every live lease number, paginated (thousands of concurrent leases are fine).
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

// Extract the issue number from a branch made off a lease (`<type>/<N>-<slug>` or
// `issue-<N>`). Returns null for non-issue branches — they are not gated.
export function issueFromBranch(branch) {
  const m = String(branch).match(/(?:^|\/)(?:issue-)?(\d+)-/) || String(branch).match(/issue-(\d+)/);
  return m ? Number(m[1]) : null;
}

// ---------- CLI ----------

function warnOwnerFallback() {
  if (!process.env.AGENT_ID)
    console.error("⚠ AGENT_ID unset — using user@host for attribution. Set a unique AGENT_ID per agent at scale.");
}

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

function main(argv) {
  const [cmd, ...rest] = argv;
  const pos = rest.filter((a) => !a.startsWith("--"));
  switch (cmd) {
    case "claim": {
      warnOwnerFallback();
      const r = claim(pos[0], {});
      if (r.result === "won") { console.log("won"); return 0; }
      if (r.result === "degraded") { console.error("⚠ leasing unavailable (gh offline/unauthed) — proceed WITHOUT a lease."); console.log("degraded"); return 0; }
      console.error(`held by ${r.holder?.owner || "another agent"}`); return 1;
    }
    case "renew": { warnOwnerFallback(); const r = renew(pos[0], {}); console.log(r.result); return r.result === "held" ? 1 : 0; }
    case "release": return release(pos[0]) ? (console.log("released"), 0) : (console.log("no lease to release"), 0);
    case "status": return cmdStatus(pos[0]);
    case "reap": return cmdReap();
    case "guard-push": {
      // pre-push hook. Enforce that you hold the branch's issue lease. Non-issue
      // branches and gh-offline both pass (never block legitimate work).
      const n = issueFromBranch(pos[0]);
      if (!n) return 0;
      const me = buildOwner();
      const r = claim(n, {});
      if (r.result === "won" || r.result === "degraded") return 0;
      if (r.holder && r.holder.owner === me) return 0;
      console.error(`✗ push blocked: issue #${n} is leased by ${r.holder?.owner || "another agent"}.`);
      console.error(`  Coordinate, pick another issue, or bypass with: git push --no-verify`);
      return 1;
    }
    default:
      console.error("gh-issue-lease commands: claim <N> | release <N> | renew <N> | status [<N>] | reap | guard-push <branch>");
      return 2;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { process.exit(main(process.argv.slice(2))); }
  catch (err) { console.error(`gh-issue-lease: ${err.message}`); process.exit(1); }
}
