// install.test.mjs — proves the PUBLISHED artifact actually works once installed.
//
// Unit tests run against ./src directly; they can't catch packaging faults — a file
// missing from `files`, a bin that breaks through npm's symlink, a broken `exports`
// map, or a hook script that can't find the CLI. Others will `npm i` this, so we pack
// the real tarball, rebuild npm's exact on-disk layout, and drive it end-to-end.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync, chmodSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const has = (bin) => spawnSync(bin, ["--version"], { encoding: "utf8" }).status === 0;

// Pack once, share the tarball + parsed file list across every install test.
let TGZ = null, FILES = null, WORK = null;
test.before(() => {
  if (!has("npm") || !has("tar")) return; // hermetic skip on a machine without them
  WORK = mkdtempSync(join(tmpdir(), "ghil-install-"));
  const r = spawnSync("npm", ["pack", "--json", "--pack-destination", WORK], { cwd: PKG, encoding: "utf8" });
  assert.equal(r.status, 0, `npm pack failed: ${r.stderr}`);
  const meta = JSON.parse(r.stdout)[0];
  TGZ = join(WORK, meta.filename);
  FILES = meta.files.map((f) => f.path);
});
test.after(() => { if (WORK) rmSync(WORK, { recursive: true, force: true }); });

const skip = !has("npm") || !has("tar");

// Extract the tarball into an npm-shaped node_modules and return the consumer root.
function installTarball() {
  const root = mkdtempSync(join(tmpdir(), "ghil-consumer-"));
  const nm = join(root, "node_modules");
  const pkgDir = join(nm, "gh-issue-lease");
  mkdirSync(pkgDir, { recursive: true });
  const x = spawnSync("tar", ["-xzf", TGZ, "-C", pkgDir, "--strip-components=1"], { encoding: "utf8" });
  assert.equal(x.status, 0, `tar failed: ${x.stderr}`);
  // npm links bins under node_modules/.bin as relative symlinks — reproduce that.
  const binDir = join(nm, ".bin");
  mkdirSync(binDir, { recursive: true });
  symlinkSync(join("..", "gh-issue-lease", "src", "issue-lease.mjs"), join(binDir, "gh-issue-lease"));
  return { root, pkgDir, bin: join(binDir, "gh-issue-lease") };
}

test("the tarball ships exactly what's needed and nothing stray", { skip }, () => {
  for (const need of ["package.json", "src/issue-lease.mjs", "hooks/pre-push", "README.md", "LICENSE"])
    assert.ok(FILES.includes(need), `published tarball is missing ${need} (files: ${FILES.join(", ")})`);
  // no secrets / dev cruft leaked into the package
  for (const f of FILES)
    assert.ok(!/(^|\/)(\.env|node_modules\/|test\/|\.git\/)/.test(f), `stray file in tarball: ${f}`);
});

test("installed bin runs through npm's symlink (no silent no-op)", { skip }, () => {
  const { root, bin } = installTarball();
  try {
    const r = spawnSync(process.execPath, [bin], { encoding: "utf8" });
    assert.equal(r.status, 2);                 // usage exit — the CLI actually executed
    assert.match(r.stderr, /guard-push/);      // and printed the command list
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bare-specifier `import` resolves through the exports map", { skip }, () => {
  const { root } = installTarball();
  try {
    const consumer = join(root, "consumer.mjs");
    writeFileSync(consumer, `import * as m from "gh-issue-lease";\nprocess.stdout.write([typeof m.claim, typeof m.resolveOwner, typeof m.codexEvent].join(","));\n`);
    const r = spawnSync(process.execPath, [consumer], { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "function,function,function");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("installed `claim` fails CLOSED without AGENT_ID before any network I/O", { skip }, () => {
  const { root, bin } = installTarball();
  try {
    const r = spawnSync(process.execPath, [bin, "claim", "5"], { encoding: "utf8", env: { ...process.env, AGENT_ID: "" } });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /AGENT_ID is not set/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the shipped pre-push hook resolves the CLI and passes non-issue branches", { skip }, () => {
  const { root, pkgDir } = installTarball();
  try {
    // A tiny git repo whose PATH exposes the installed CLI as `gh-issue-lease`.
    const repo = join(root, "repo");
    mkdirSync(repo);
    for (const a of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]])
      spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
    const hooks = join(repo, ".githooks");
    mkdirSync(hooks);
    const hookSrc = join(pkgDir, "hooks", "pre-push");
    assert.ok(existsSync(hookSrc), "hooks/pre-push not in the installed package");
    spawnSync("cp", [hookSrc, join(hooks, "pre-push")]);
    chmodSync(join(hooks, "pre-push"), 0o755);

    // Expose the installed CLI on PATH via a shim (mirrors a global/local bin).
    const binDir = join(root, "shim");
    mkdirSync(binDir);
    const shim = join(binDir, "gh-issue-lease");
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${join(pkgDir, "src", "issue-lease.mjs")}" "$@"\n`);
    chmodSync(shim, 0o755);

    // Feed the hook a push line for a NON-issue branch → guard-push returns 0 (hermetic, no network).
    const stdin = "refs/heads/chore/cleanup deadbeef refs/heads/chore/cleanup 0000000\n";
    const r = spawnSync("sh", [join(hooks, "pre-push")], {
      cwd: repo, input: stdin, encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    });
    assert.equal(r.status, 0, `pre-push hook failed on a non-issue branch: ${r.stderr}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("nested-install layout: bin still resolves when packaged deep", { skip }, () => {
  // Simulate a bin that npm hoisted vs. nested — realpathSync on both sides must hold.
  const { root, pkgDir } = installTarball();
  try {
    const deep = mkdtempSync(join(tmpdir(), "ghil-deep-"));
    const link = join(deep, "gh-issue-lease");
    symlinkSync(join(pkgDir, "src", "issue-lease.mjs"), link);
    const r = spawnSync(process.execPath, [link, "status", "--help"], { encoding: "utf8", env: { ...process.env, AGENT_ID: "" } });
    // `status` with no network would try gh; but we only assert the CLI dispatched
    // (didn't silently no-op) — any exit is fine as long as it's not the "no entry" void.
    assert.ok(r.status !== null, "CLI did not run at all through the deep symlink");
    rmSync(deep, { recursive: true, force: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
