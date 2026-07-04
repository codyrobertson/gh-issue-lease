// state.test.mjs — hermetic tests for the vendored agent-refs state-cache writer.
// Verifies the config-by-convention gate (silent no-op unless the state dir already
// exists), atomic single-file writes, the AGENT_ID gate, and clearState. No network,
// no git, no real `<gitdir>/agent-refs/state` dir — every case pins its own temp dir
// via AGENT_REFS_STATE_DIR.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeState, clearState } from "../src/state.mjs";

// Run fn with env overrides, then restore exactly (undefined ⇒ unset the var).
function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try { return fn(); }
  finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("no-op when the state dir is absent", () => {
  const base = mkdtempSync(join(tmpdir(), "agentrefs-"));
  const missing = join(base, "does", "not", "exist");
  try {
    withEnv({ AGENT_REFS_STATE_DIR: missing, AGENT_ID: "x" }, () => {
      writeState("heartbeat", { task: "t" });
    });
    assert.equal(existsSync(missing), false, "must not create the state dir");
    assert.deepEqual(readdirSync(base), [], "must write nothing");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("writes atomically when the dir exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentrefs-"));
  try {
    withEnv({ AGENT_REFS_STATE_DIR: dir, AGENT_ID: "x" }, () => {
      writeState("heartbeat", { task: "t", pid: 123 });
    });
    assert.deepEqual(readdirSync(dir), ["x.heartbeat.json"],
      "exactly one target file, no leftover .tmp");
    const rec = JSON.parse(readFileSync(join(dir, "x.heartbeat.json"), "utf8"));
    assert.equal(rec.actor, "x");
    assert.equal(rec.concern, "heartbeat");
    assert.equal(rec.task, "t");
    assert.equal(rec.pid, 123);
    assert.ok(typeof rec.at === "string" && !Number.isNaN(Date.parse(rec.at)),
      "carries an ISO `at` timestamp");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no-op when AGENT_ID is unset", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentrefs-"));
  try {
    withEnv({ AGENT_REFS_STATE_DIR: dir, AGENT_ID: undefined }, () => {
      writeState("heartbeat", { task: "t" });
    });
    assert.deepEqual(readdirSync(dir), [], "no file written without an actor id");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("clearState removes the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentrefs-"));
  try {
    withEnv({ AGENT_REFS_STATE_DIR: dir, AGENT_ID: "x" }, () => {
      writeState("heartbeat", { task: "t" });
      assert.equal(existsSync(join(dir, "x.heartbeat.json")), true);
      clearState("heartbeat");
    });
    assert.equal(existsSync(join(dir, "x.heartbeat.json")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
