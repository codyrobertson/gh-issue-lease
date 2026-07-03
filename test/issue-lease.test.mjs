import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  refShort, refFull, buildOwner, parseLeaseMessage, isExpired,
  normalizeIssue, backoffMs, issueFromBranch,
} from "../src/issue-lease.mjs";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src/issue-lease.mjs");

test("ref names map to the issue number", () => {
  assert.equal(refShort(123), "leases/issue-123");
  assert.equal(refFull(123), "refs/leases/issue-123");
});

test("owner falls back to user@host, honors AGENT_ID", () => {
  assert.equal(buildOwner({ AGENT_ID: "codex-7" }), "codex-7");
  assert.equal(buildOwner({ USER: "cody", HOSTNAME: "mac.local" }), "cody@mac");
  assert.equal(buildOwner({ USER: "cody" }), "cody");
});

test("lease message round-trips owner/ttl/issue", () => {
  const m = parseLeaseMessage(JSON.stringify({ v: 1, issue: 5, owner: "a@b", ttlMin: 60 }));
  assert.deepEqual(m, { owner: "a@b", ttlMin: 60, issue: 5 });
});

test("unparseable lease message is reclaimable, not a crash", () => {
  const m = parseLeaseMessage("not json");
  assert.equal(m.owner, null);
});

test("TTL: fresh lease is live, old lease is expired", () => {
  const now = Date.parse("2026-07-03T12:00:00Z");
  assert.equal(isExpired("2026-07-03T11:59:00Z", 240, now), false); // 1m old, 4h ttl
  assert.equal(isExpired("2026-07-03T07:00:00Z", 240, now), true);  // 5h old, 4h ttl
});

test("TTL: unreadable claim date is stealable (fail-open on reclaim)", () => {
  assert.equal(isExpired("garbage", 240, Date.now()), true);
});

test("normalizeIssue accepts positive ints, rejects everything else", () => {
  assert.equal(normalizeIssue(123), 123);
  assert.equal(normalizeIssue("45"), 45);
  assert.equal(normalizeIssue(0), null);
  assert.equal(normalizeIssue(-1), null);
  assert.equal(normalizeIssue(1.5), null);
  assert.equal(normalizeIssue("abc"), null);
  assert.equal(normalizeIssue("12; rm -rf"), null);
});

test("backoff grows, stays within [base/2, base] and is jittered", () => {
  const lo = backoffMs(3, () => 0);   // min jitter
  const hi = backoffMs(3, () => 1);   // max jitter
  assert.ok(lo < hi, "jitter widens the window");
  assert.ok(lo >= (Math.min(1000 * 2 ** 3, 30000) / 2) - 1);
  assert.ok(hi <= Math.min(1000 * 2 ** 3, 30000) + 1);
  assert.ok(backoffMs(10, () => 1) <= 30000, "capped at 30s");
});

test("CLI runs when invoked through a symlinked bin (npm/pnpm install shape)", () => {
  // Regression: npm installs the bin as node_modules/.bin/gh-issue-lease → src.
  // A naive argv[1]-vs-import.meta.url check fails there and the CLI silently
  // no-ops (guard-push/status/reap would do nothing). Assert the symlink runs.
  const dir = mkdtempSync(join(tmpdir(), "ghil-"));
  try {
    const link = join(dir, "gh-issue-lease");
    symlinkSync(SRC, link);
    const r = spawnSync(process.execPath, [link], { encoding: "utf8" });
    assert.equal(r.status, 2, "usage exit code");
    assert.match(r.stderr, /guard-push/, "prints command list");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("issueFromBranch extracts the number the pre-push hook gates on", () => {
  assert.equal(issueFromBranch("fix/1069-print-qr"), 1069);
  assert.equal(issueFromBranch("feat/1109-owner-recency"), 1109);
  assert.equal(issueFromBranch("codex/issue-123-whatever"), 123);
  assert.equal(issueFromBranch("chore/worktree-gc-tooling"), null); // non-issue → not gated
  assert.equal(issueFromBranch("master"), null);
});
