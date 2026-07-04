// Live concurrency proof for `next` — the ONE property no unit test can show: under a
// real race, N workers popping the same backlog each win a DISTINCT issue (exactly-once).
//
// GATED: runs only when GH_LIVE_TEST=1 AND GH_REPO is set (e.g.
//   GH_LIVE_TEST=1 GH_REPO=codyrobertson/aspire-mailer node --test test/concurrent.test.mjs
// ). Default `npm test` skips it so the suite stays hermetic. It creates throwaway open
// issues, races real node procs against them, then DELETES every lease ref it created —
// cleanup is asserted (0 leaked refs), not narrated.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src/issue-lease.mjs");
const REPO = process.env.GH_REPO || "";
const LIVE = process.env.GH_LIVE_TEST === "1" && REPO.includes("/");
const [OWNER, NAME] = REPO.split("/");

function gh(args, { json = false } = {}) {
  const r = spawnSync("gh", args, { encoding: "utf8", env: { ...process.env, GH_REPO: REPO } });
  if (r.status !== 0) throw new Error(`gh ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return json ? JSON.parse(r.stdout || "null") : (r.stdout || "").trim();
}
// Deletes ref refs/leases/issue-<n>. The path is `git/refs/leases/issue-<n>` — the ref
// name WITHOUT its leading `refs/`. (Prefixing `git/refs/` with the full `refs/...`
// leaked 61 refs last time; do NOT reintroduce that bug.)
function deleteLeaseRef(n) {
  const r = spawnSync("gh", ["api", "--method", "DELETE", `repos/${OWNER}/${NAME}/git/refs/leases/issue-${n}`],
    { encoding: "utf8", env: { ...process.env, GH_REPO: REPO } });
  return r.status === 0;
}
function leaseRefExists(n) {
  const r = spawnSync("gh", ["api", `repos/${OWNER}/${NAME}/git/ref/leases/issue-${n}`],
    { encoding: "utf8", env: { ...process.env, GH_REPO: REPO } });
  return r.status === 0; // 200 ⇒ ref exists; 404 ⇒ gone
}
function runNext(label, agentId) {
  return new Promise((res) => {
    const p = spawn(process.execPath, [SRC, "next", "--label", label], {
      env: { ...process.env, GH_REPO: REPO, AGENT_ID: agentId },
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => res({ code, out: out.trim(), err: err.trim() }));
  });
}

test("N racers each pop a DISTINCT issue; every lease ref is cleaned up", { skip: !LIVE }, async () => {
  const K = 6;                       // issues
  const N = 8;                       // racers (> K so some lose)
  const uniq = `${Date.now()}-${randomBytes(3).toString("hex")}`;
  const label = `lease-citest-${uniq}`;
  const created = [];

  gh(["label", "create", label, "--color", "ededed", "--description", "gh-issue-lease CI race test — safe to delete"]);
  try {
    for (let i = 0; i < K; i++) {
      const url = gh(["issue", "create", "--title", `lease-citest ${uniq} #${i}`, "--body", "throwaway", "--label", label]);
      created.push(Number(url.split("/").pop()));
    }

    // POLL-UNTIL-INDEXED: GitHub's label-filtered issue list is eventually consistent —
    // freshly created issues take ~5s to appear. Wait until all K are visible BEFORE
    // racing, so this stays a clean CONCURRENCY proof (not a GitHub index-lag test).
    const deadline = Date.now() + 20_000;
    for (;;) {
      const visible = new Set(
        (gh(["issue", "list", "--label", label, "--state", "open", "--json", "number", "--limit", "50"], { json: true }) || [])
          .map((x) => x.number)
      );
      if (created.every((n) => visible.has(n))) break;
      if (Date.now() > deadline) throw new Error(`index lag: only ${visible.size}/${K} issues visible after 20s`);
      await delay(1000);
    }

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => runNext(label, `citest-agent-${uniq}-${i}`))
    );

    const winners = results.filter((r) => r.code === 0 && /^\d+$/.test(r.out)).map((r) => Number(r.out));
    // exactly-once: no issue claimed twice
    assert.equal(new Set(winners).size, winners.length, `duplicate winners: ${winners.join(",")}`);
    // every winner is a real created issue
    for (const w of winners) assert.ok(created.includes(w), `winner ${w} is not a created issue`);
    // with N>K and K distinct issues, all K should be won (racers exceed supply)
    assert.equal(winners.length, K, `expected ${K} winners, got ${winners.length}`);
  } finally {
    // Cleanup — asserted, not narrated.
    for (const n of created) {
      spawnSync("gh", ["issue", "close", String(n)], { encoding: "utf8", env: { ...process.env, GH_REPO: REPO } });
      deleteLeaseRef(n);
    }
    spawnSync("gh", ["label", "delete", label, "--yes"], { encoding: "utf8", env: { ...process.env, GH_REPO: REPO } });
    // 0 leaked lease refs for any citest issue
    const leaked = created.filter((n) => leaseRefExists(n));
    assert.deepEqual(leaked, [], `leaked lease refs for issues: ${leaked.join(",")}`);
  }
});
