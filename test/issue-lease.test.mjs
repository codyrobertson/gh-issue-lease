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

// ---------- CLI wiring ----------

test("CLI runs through a symlinked bin (npm/pnpm install shape)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ghil-"));
  try {
    const link = join(dir, "gh-issue-lease");
    symlinkSync(SRC, link);
    const r = spawnSync(process.execPath, [link], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /guard-push/);
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
