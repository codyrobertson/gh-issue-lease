import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  refShort, refFull, resolveOwner, parseLeaseMessage, isExpired,
  normalizeIssue, backoffMs, issueFromBranch, pushDecision, hookDecision, codexEvent,
  parseHeadRef, parseDotGitFile, parseBlockers, nextWalk, isTransient, retryAfterMs,
} from "../src/issue-lease.mjs";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src/issue-lease.mjs");

test("ref names map to the issue number", () => {
  assert.equal(refShort(123), "leases/issue-123");
  assert.equal(refFull(123), "refs/leases/issue-123");
});

// ---------- identity (strict AGENT_ID) ----------

test("resolveOwner returns AGENT_ID, trimmed", () => {
  assert.equal(resolveOwner({ AGENT_ID: "codex-7" }), "codex-7");
  assert.equal(resolveOwner({ AGENT_ID: "  agent-2  " }), "agent-2");
});

test("resolveOwner is null when AGENT_ID is unset/blank (no host/user fallback)", () => {
  assert.equal(resolveOwner({}), null);
  assert.equal(resolveOwner({ AGENT_ID: "" }), null);
  assert.equal(resolveOwner({ AGENT_ID: "   " }), null);
  // crucially: does NOT fall back to user@host
  assert.equal(resolveOwner({ USER: "cody", HOSTNAME: "mac" }), null);
});

test("parent and child share identity via inherited AGENT_ID → same owner", () => {
  // A launcher sets AGENT_ID; a child process inherits the env. Same string → the
  // claim is idempotent for the child (owner === holder.owner ⇒ won, never blocked).
  const parentEnv = { AGENT_ID: "fleet-agent-42" };
  const childEnv = { ...parentEnv }; // env inheritance
  assert.equal(resolveOwner(parentEnv), resolveOwner(childEnv));
});

// ---------- lease message / TTL / validation ----------

test("lease message round-trips owner/ttl/issue", () => {
  const m = parseLeaseMessage(JSON.stringify({ v: 1, issue: 5, owner: "a@b", ttlMin: 60 }));
  assert.deepEqual(m, { owner: "a@b", ttlMin: 60, issue: 5 });
});

test("unparseable lease message is reclaimable, not a crash", () => {
  assert.equal(parseLeaseMessage("not json").owner, null);
});

test("TTL: fresh lease live, old lease expired, unreadable → stealable", () => {
  const now = Date.parse("2026-07-03T12:00:00Z");
  assert.equal(isExpired("2026-07-03T11:59:00Z", 240, now), false);
  assert.equal(isExpired("2026-07-03T07:00:00Z", 240, now), true);
  assert.equal(isExpired("garbage", 240, Date.now()), true);
});

test("normalizeIssue accepts positive ints, rejects everything else", () => {
  for (const [in_, out] of [[123, 123], ["45", 45], [0, null], [-1, null], [1.5, null], ["abc", null], ["12; rm", null]])
    assert.equal(normalizeIssue(in_), out);
});

test("backoff grows, jittered, capped at 30s", () => {
  assert.ok(backoffMs(3, () => 0) < backoffMs(3, () => 1));
  assert.ok(backoffMs(10, () => 1) <= 30000);
});

test("issueFromBranch extracts issue #, null for non-issue branches", () => {
  assert.equal(issueFromBranch("fix/1069-print-qr"), 1069);
  assert.equal(issueFromBranch("codex/issue-123-whatever"), 123);
  assert.equal(issueFromBranch("feat/42-thing"), 42);
  assert.equal(issueFromBranch("1234-root-level"), 1234);       // no type prefix
  assert.equal(issueFromBranch("hotfix/team/900-nested"), 900); // nested path
  assert.equal(issueFromBranch("issue-77"), 77);                // bare issue-N
  assert.equal(issueFromBranch("chore/worktree-gc"), null);
  assert.equal(issueFromBranch("release/v2"), null);            // a number that isn't an issue id
  assert.equal(issueFromBranch("master"), null);
});

// ---------- git-free branch/gitdir resolution, pure ----------

test("parseHeadRef reads the branch from HEAD, '' when detached", () => {
  assert.equal(parseHeadRef("ref: refs/heads/fix/990002-print-qr\n"), "fix/990002-print-qr");
  assert.equal(parseHeadRef("ref: refs/heads/main"), "main");
  assert.equal(parseHeadRef("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"), ""); // detached sha
  assert.equal(parseHeadRef(""), "");
});

test("parseDotGitFile extracts the worktree/submodule gitdir pointer", () => {
  assert.equal(parseDotGitFile("gitdir: /repo/.git/worktrees/foo\n"), "/repo/.git/worktrees/foo");
  assert.equal(parseDotGitFile("gitdir: ../.git/modules/sub"), "../.git/modules/sub");
  assert.equal(parseDotGitFile("not a gitdir file"), null);
});

// ---------- codexEvent: Codex `notify` argv parsing, pure ----------

test("codexEvent parses Codex's JSON argv, tolerates junk", () => {
  assert.deepEqual(codexEvent(['{"type":"agent-turn-complete","cwd":"/x"}']), { type: "agent-turn-complete", cwd: "/x" });
  assert.deepEqual(codexEvent(["not json"]), {});
  assert.deepEqual(codexEvent([]), {});
  assert.deepEqual(codexEvent(undefined), {});
  assert.deepEqual(codexEvent(["--flag", '{"cwd":"/y"}']), { cwd: "/y" }); // finds the JSON arg among flags
});

// ---------- pushDecision: the pre-push gate, pure ----------

test("pushDecision: no lease → allow (a missing claim is not a conflict)", () => {
  assert.equal(pushDecision({ me: "a", holder: null }).allow, true);
});

test("pushDecision: I hold it → allow", () => {
  assert.equal(pushDecision({ me: "a", holder: { owner: "a" } }).allow, true);
});

test("pushDecision: someone else holds it → block", () => {
  const d = pushDecision({ me: "a", holder: { owner: "b" } });
  assert.equal(d.allow, false);
  assert.match(d.reason, /leased by b/);
});

test("pushDecision: lease exists but I have no AGENT_ID → block (can't prove it's mine)", () => {
  const d = pushDecision({ me: null, holder: { owner: "b" } });
  assert.equal(d.allow, false);
  assert.match(d.reason, /AGENT_ID is unset/);
});

// ---------- hookDecision: the provider-hook adapter, pure ----------

test("hookDecision: no AGENT_ID → no-identity (warn, never block)", () => {
  assert.equal(hookDecision({ me: null, n: 5, block: true, claim: null }).kind, "no-identity");
});

test("hookDecision: not an issue branch → noop", () => {
  assert.equal(hookDecision({ me: "a", n: null, block: true, claim: null }).kind, "noop");
});

test("hookDecision: gh degraded → noop (never block on infra)", () => {
  assert.equal(hookDecision({ me: "a", n: 5, block: true, claim: { result: "degraded" } }).kind, "noop");
});

test("hookDecision: I hold it → held (parent AND its child both get this)", () => {
  assert.equal(hookDecision({ me: "a", n: 5, block: true, claim: { result: "won" } }).kind, "held");
  // child, same AGENT_ID, sees the lease as its own owner:
  assert.equal(hookDecision({ me: "a", n: 5, block: true, claim: { result: "won", holder: { owner: "a" } } }).kind, "held");
});

test("hookDecision: another agent holds it → deny when blocking, warn otherwise", () => {
  const held = { result: "held", holder: { owner: "b" } };
  assert.equal(hookDecision({ me: "a", n: 5, block: true, claim: held }).kind, "deny");
  assert.equal(hookDecision({ me: "a", n: 5, block: false, claim: held }).kind, "warn");
});

// ---------- rate-limit classification, pure ----------

test("isTransient catches secondary rate limits, 429, and Retry-After (not business errors)", () => {
  assert.ok(isTransient("You have exceeded a secondary rate limit and have triggered abuse detection"));
  assert.ok(isTransient("HTTP 429 Too Many Requests"));
  assert.ok(isTransient("Retry-After: 60"));
  assert.ok(isTransient("API rate limit exceeded"));
  assert.ok(isTransient("HTTP 502 Bad Gateway"));
  assert.equal(isTransient("Reference already exists"), false);
  assert.equal(isTransient("HTTP 404 Not Found"), false);
});

test("retryAfterMs honors GitHub's Retry-After (bounded), null when absent", () => {
  assert.equal(retryAfterMs("Retry-After: 30"), 30_000);
  assert.equal(retryAfterMs("retry after 5 seconds"), 5_000);
  assert.equal(retryAfterMs("Retry-After: 9999", 30_000), 30_000); // capped
  assert.equal(retryAfterMs("no header here"), null);
});

// ---------- parseBlockers: the dependency scanner, pure ----------

test("parseBlockers matches all 5 patterns, case-insensitive", () => {
  assert.deepEqual(parseBlockers("blocked by #1"), [1]);
  assert.deepEqual(parseBlockers("Blocked-by #2"), [2]);
  assert.deepEqual(parseBlockers("depends on #3"), [3]);
  assert.deepEqual(parseBlockers("Depends-On #4"), [4]);
  assert.deepEqual(parseBlockers("- [ ] #5"), [5]);
});

test("parseBlockers excludes CHECKED task items, keeps unchecked", () => {
  assert.deepEqual(parseBlockers("- [x] #10\n- [ ] #11"), [11]);
  assert.deepEqual(parseBlockers("- [X] #12"), []);        // capital X still checked
  assert.deepEqual(parseBlockers("* [ ] blocks on #13"), [13]); // `*` bullet + text before #
});

test("parseBlockers de-dupes and combines patterns across a body", () => {
  const body = "Depends on #7.\nblocked by #7\n- [ ] #8\n- [x] #9\ntext #999 not a blocker";
  assert.deepEqual(parseBlockers(body), [7, 8]);           // #7 once, #9 checked-out, #999 ignored
});

test("parseBlockers returns [] for empty/nullish body", () => {
  assert.deepEqual(parseBlockers(""), []);
  assert.deepEqual(parseBlockers(null), []);
  assert.deepEqual(parseBlockers(undefined), []);
});

// ---------- nextWalk: injectable core of the `next` verb, pure (no network) ----------

const listOf = (...nums) => () => nums.map((n) => ({ number: n, body: "" }));

test("nextWalk returns the first winnable issue number", () => {
  const r = nextWalk({ listIssues: listOf(10, 11, 12), claimFn: () => ({ result: "won" }) });
  assert.deepEqual(r, { kind: "won", number: 10 });
});

test("nextWalk skips contended issues and wins the first free one", () => {
  const held = new Set([10, 11]);
  const claimFn = (n) => (held.has(n) ? { result: "held" } : { result: "won" });
  const r = nextWalk({ listIssues: listOf(10, 11, 12), claimFn });
  assert.deepEqual(r, { kind: "won", number: 12 });
});

test("nextWalk --skip-blocked skips a candidate whose blocker is open", () => {
  const listIssues = () => [
    { number: 20, body: "blocked by #99" }, // #99 open ⇒ skip
    { number: 21, body: "depends on #98" }, // #98 closed ⇒ eligible
  ];
  const isBlockerOpen = (b) => b === 99; // 99 open, 98 closed
  const claimFn = () => ({ result: "won" });
  const r = nextWalk({ listIssues, claimFn, isBlockerOpen, skipBlocked: true });
  assert.deepEqual(r, { kind: "won", number: 21 });
});

test("nextWalk without skipBlocked ignores blockers entirely", () => {
  const listIssues = () => [{ number: 30, body: "blocked by #99" }];
  const isBlockerOpen = () => { throw new Error("must not be consulted"); };
  const r = nextWalk({ listIssues, claimFn: () => ({ result: "won" }), isBlockerOpen, skipBlocked: false });
  assert.deepEqual(r, { kind: "won", number: 30 });
});

test("nextWalk drained queue (all held) → empty sentinel", () => {
  const r = nextWalk({ listIssues: listOf(1, 2, 3), claimFn: () => ({ result: "held" }) });
  assert.deepEqual(r, { kind: "empty" });
});

test("nextWalk empty list → empty sentinel", () => {
  const r = nextWalk({ listIssues: () => [], claimFn: () => ({ result: "won" }) });
  assert.deepEqual(r, { kind: "empty" });
});

test("nextWalk propagates degraded issue-lister (proceed unlocked)", () => {
  const r = nextWalk({ listIssues: () => ({ degraded: true }), claimFn: () => ({ result: "won" }) });
  assert.deepEqual(r, { kind: "degraded" });
});

test("nextWalk surfaces no-identity from the claimer (fail closed)", () => {
  const r = nextWalk({ listIssues: listOf(5), claimFn: () => ({ result: "no-identity" }) });
  assert.deepEqual(r, { kind: "no-identity" });
});

test("nextWalk treats an all-degraded claim run as degraded (gh genuinely down)", () => {
  // every pass re-lists the same issue, every claim is transient → degraded, not empty
  const r = nextWalk({ listIssues: listOf(5), claimFn: () => ({ result: "degraded" }), sleep: () => {} });
  assert.deepEqual(r, { kind: "degraded" });
});

// ---------- liveness: a transient on one issue must not abandon a free one ----------

test("nextWalk SOFT-skips a transient candidate and wins a LATER one in the SAME pass", () => {
  // issue 20 hits a rate-limit (degraded); 21 is free → keep walking, win 21. NOT degraded.
  const claimFn = (n) => (n === 20 ? { result: "degraded" } : { result: "won" });
  const r = nextWalk({ listIssues: listOf(20, 21), claimFn, sleep: () => {} });
  assert.deepEqual(r, { kind: "won", number: 21 });
});

test("nextWalk retries across passes: transient on pass 1, won on pass 2", () => {
  let calls = 0;
  const claimFn = (n) => (n === 30 && calls++ === 0 ? { result: "degraded" } : { result: "won" });
  let listed = 0;
  const listIssues = () => { listed++; return [{ number: 30, body: "" }]; };
  const r = nextWalk({ listIssues, claimFn, sleep: () => {} });
  assert.deepEqual(r, { kind: "won", number: 30 });
  assert.ok(listed >= 2, `expected a re-list on pass 2, saw ${listed} list calls`);
});

test("nextWalk exit-10 (drained) requires a FULL pass of definitive holds, zero transients", () => {
  const r = nextWalk({ listIssues: listOf(1, 2, 3), claimFn: () => ({ result: "held" }), sleep: () => {} });
  assert.deepEqual(r, { kind: "empty" });
});

test("nextWalk does NOT exit-10 when a transient masked a candidate (retries, then degraded)", () => {
  // one held + one always-transient, over all passes → never a clean full pass → degraded, never empty
  const claimFn = (n) => (n === 41 ? { result: "held" } : { result: "degraded" });
  const r = nextWalk({ listIssues: listOf(40, 41), claimFn, maxPasses: 3, sleep: () => {} });
  assert.deepEqual(r, { kind: "degraded" });
});

// ---------- index lag: eventual consistency of the label-filtered list ----------

test("nextWalk CONFIRMS before draining: empty list, then the issue appears → CLAIMS it", () => {
  // GitHub index lag: the freshly-created issue is invisible on the first read(s).
  let call = 0;
  const listIssues = () => (call++ < 2 ? [] : [{ number: 70, body: "" }]);
  const r = nextWalk({ listIssues, claimFn: () => ({ result: "won" }), sleep: () => {} });
  assert.deepEqual(r, { kind: "won", number: 70 }, "must not exit-10 on a lagging empty read");
});

test("nextWalk CONFIRMS before draining: subset of held, re-list reveals free issues → claims one", () => {
  // pass 1 sees 4 candidates all held; the confirm re-list reveals 2 more that are free.
  let call = 0;
  const listIssues = () =>
    call++ === 0
      ? [1, 2, 3, 4].map((n) => ({ number: n, body: "" }))
      : [1, 2, 3, 4, 5, 6].map((n) => ({ number: n, body: "" }));
  const held = new Set([1, 2, 3, 4]);
  const claimFn = (n) => (held.has(n) ? { result: "held" } : { result: "won" });
  const r = nextWalk({ listIssues, claimFn, sleep: () => {} });
  assert.deepEqual(r, { kind: "won", number: 5 }, "must reconsider newly-indexed candidates, not drain");
});

test("nextWalk still reaches exit-10 for a genuinely-empty backlog (after the confirm)", () => {
  let calls = 0;
  const listIssues = () => { calls++; return []; };
  const r = nextWalk({ listIssues, claimFn: () => ({ result: "won" }), sleep: () => {} });
  assert.deepEqual(r, { kind: "empty" });
  assert.ok(calls >= 2, `exit-10 must require ≥1 confirming re-list, saw ${calls} reads`);
});

// ---------- CLI wiring ----------

test("CLI runs through a symlinked bin (npm/pnpm install shape)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ghil-"));
  try {
    const link = join(dir, "gh-issue-lease");
    symlinkSync(SRC, link);
    const r = spawnSync(process.execPath, [link], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /guard-push/);
    assert.match(r.stderr, /\bnext\b/);
    assert.match(r.stderr, /\bmine\b/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("claim without AGENT_ID fails closed (exit 3), does not touch the network", () => {
  const r = spawnSync(process.execPath, [SRC, "claim", "5"], { encoding: "utf8", env: { ...process.env, AGENT_ID: "" } });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /AGENT_ID is not set/);
});

test("claude-hook is a silent no-op on a non-issue branch (no stdout, exit 0)", () => {
  const payload = JSON.stringify({ hook_event_name: "SessionStart", cwd: dirname(SRC) });
  const r = spawnSync(process.execPath, [SRC, "claude-hook"], { input: payload, encoding: "utf8", env: { ...process.env, AGENT_ID: "x" } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("claude-hook warns (does not block) when AGENT_ID is unset", () => {
  // even a PreToolUse --block on an issue-less branch: no-identity is checked first
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", cwd: dirname(SRC) });
  const r = spawnSync(process.execPath, [SRC, "claude-hook", "--block"], { input: payload, encoding: "utf8", env: { ...process.env, AGENT_ID: "" } });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /AGENT_ID is not set/);
});

test("codex-hook warns without AGENT_ID and never blocks (exit 0), even given Codex's JSON argv", () => {
  const codexArg = JSON.stringify({ type: "agent-turn-complete", "turn-id": "abc" });
  const r = spawnSync(process.execPath, [SRC, "codex-hook", codexArg], { encoding: "utf8", env: { ...process.env, AGENT_ID: "" } });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /AGENT_ID is not set/);
});

test("codex-hook is a silent no-op outside an issue branch (exit 0, no output)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ghil-nonrepo-"));
  try {
    const r = spawnSync(process.execPath, [SRC, "codex-hook"], { cwd: dir, encoding: "utf8", env: { ...process.env, AGENT_ID: "x" } });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("generic hook warns without AGENT_ID and exits 0", () => {
  const r = spawnSync(process.execPath, [SRC, "hook"], { encoding: "utf8", env: { ...process.env, AGENT_ID: "" } });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /AGENT_ID is not set/);
});
