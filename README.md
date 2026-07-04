# gh-issue-lease

**An atomic, GitHub-native mutex for multi-agent work. The lock IS a git ref — no server, no database, first writer wins.**

When many agents (Claude, Codex, humans, CI — anything) work the same repo, they collide: two grab the same issue and duplicate or clobber each other. `gh-issue-lease` gives every worker one atomic operation to run before touching an issue, so exactly one wins.

```sh
AGENT_ID=my-agent npx gh-issue-lease claim 1234   # "won" (go), "held by …" (pick another)
```

Zero runtime dependencies, one small file. Needs the [`gh` CLI](https://cli.github.com/) authenticated.

---

## How it works (and why there's no database)

The lock **is** a git ref: `refs/leases/issue-<N>`. Creating a ref is **atomic on GitHub's backend** — the first `POST /git/refs` gets `201`, every later one gets `422 "Reference already exists"`. That's the whole primitive: a real server-side mutex with nothing to run. The ref points at a tiny commit whose message carries `{owner, ttlMin}` and whose GitHub-set date is the lease clock, so a crashed agent's lease **expires and is reclaimed** on its own.

> **Why not an embedded database?** A mutex only works if every worker sees the *same* lock. GitHub is the shared, atomic, already-authenticated store everyone can already reach. An embedded DB (SQLite) is per-machine and can't be that shared store. GitHub already is.

---

## Identity is strict and agent-agnostic

The owner of a lease is **`AGENT_ID`** — a unique label the **launcher** sets per logical agent. This one rule makes the hard cases disappear:

- **Parent → children(N).** A parent that fans out into *N* child agents/threads/processes: every child **inherits `AGENT_ID` through the environment**, so the parent and all N children are **one owner**. The claim is idempotent for that owner — child #1 wins it, children #2…N each re-see it as theirs and proceed, none of them ever blocks a sibling.
- **Independent agents.** Two separate workers have different `AGENT_ID`s → different owners → the second is correctly excluded.
- **Any provider.** It's just an env var — Claude, Codex, a human, a CI job all set it identically. Nothing Claude-specific.

There is **no host/user/session fallback**. An unset `AGENT_ID` means *no identity*, and the tool **fails closed** (refuses to claim) rather than guess — guessing would either split a parent from its own children or merge two independent agents. Set it once per agent at launch:

```sh
export AGENT_ID="fleet-agent-7"   # children inherit this automatically
```

---

## Enforce WITHOUT hooks (the default, and the strongest guarantee)

**The primitive is the enforcement.** `claim` is atomic on GitHub's backend — if it doesn't return `won`, another owner has the issue and you stop. That's the whole mechanism, and it needs **no hooks, no daemon, no config on any agent's machine.** Just run it before you touch an issue:

```sh
gh-issue-lease claim 1234 || exit 1     # exit 1 = "held by someone else" → don't start
```

| `claim` exit | Meaning | What the caller does |
|---|---|---|
| `0` `won` | Lease is yours (fresh, already yours, or stolen from an expired holder) | Proceed. |
| `1` `held` | A live lease is held by a **different** `AGENT_ID` | Stop; pick another issue. |
| `3` | `AGENT_ID` unset | Fails **closed** — set an identity, don't guess. |
| `0` `degraded` | `gh` offline/unauthed | Fails **open** — proceed unlocked; never blocks work on an infra blip. |

Wire it into whatever the agent already reads. For any agent that honors an instructions file (Claude's `CLAUDE.md`, Codex/others' `AGENTS.md`), one line is the entire integration — no provider API, no hook:

```md
Before working an issue, run `gh-issue-lease claim <N>`. If it prints "held by …", pick another issue.
```

Because the lock is a server-side atomic ref, this is race-proof across machines and providers. Everything below is **optional** and only adds convenience or a local backstop — none of it changes the guarantee above.

### Commands

| Command | Exit | Meaning |
|---|---|---|
| `claim <N>` | `0` won/degraded · `1` held · `3` no AGENT_ID | Lease issue N. Run before working it. |
| `next [filters]` | `0` won/degraded · `3` no AGENT_ID · `10` drained | Atomically pop + claim the next unclaimed open issue. Prints the bare number. |
| `mine` | `0` | The issues you currently hold (owner === your `AGENT_ID`). |
| `release <N>` | `0` | Drop the lease. |
| `renew <N>` | `0` renewed · `1` held · `3` no id | Heartbeat for a task that outlasts the TTL. |
| `status [<N>]` | `0` | Who holds what (great as a CI/observability step). |
| `reap` | `0` | Delete expired + closed-issue leases. |
| `guard-push <branch>` | `0` allowed · `1` blocked | Read-only ownership check (used by the optional pre-push hook). |
| `hook` / `codex-hook` / `claude-hook [--block]` | `0` | Optional provider adapters (below). |

---

## Work queue: `next` (atomic pop from a shared backlog)

`claim <N>` presumes the agent already knows its issue. A *fleet* doesn't — it needs to **pull** work. `next` atomically pops the next unclaimed open issue from a filtered backlog and claims it in one step, so N agents racing the same queue each get a **distinct** issue (exactly-once, same server-side atomic-ref guarantee as `claim`).

```sh
# Pop the next ready issue and capture its number — the winning number is the ONLY thing on stdout:
ISSUE=$(AGENT_ID=agent-7 gh-issue-lease next --label ready)
case $? in
  0)  echo "working #$ISSUE" ;;        # won (or degraded → $ISSUE empty, proceed unlocked)
  10) echo "queue drained, nothing to do"; exit 0 ;;   # backlog empty / all claimed
  3)  echo "set AGENT_ID"; exit 1 ;;   # fail closed
esac
```

The bare issue number goes to **stdout** (scriptable); the human/status line goes to **stderr**, so `$(… next …)` captures only the number.

**Filters** (all optional, combine freely):

| Flag | Effect |
|---|---|
| `--label X` | Only issues with label `X`. Repeatable — collected into an AND set. |
| `--milestone N` | Only issues in milestone number `N`. |
| `--unassigned` | Only issues with no GitHub assignee. |
| `--skip-blocked` | Skip any issue whose body declares an **open** blocker (see below). |
| `--ttl N` | Lease TTL in minutes for this claim (overrides `AGENT_LEASE_TTL_MIN`). |

**Dependency-aware (`--skip-blocked`).** The body is scanned for blocker refs — `blocked by #N`, `blocked-by #N`, `depends on #N`, `depends-on #N`, and unchecked task-list items `- [ ] #N` (a checked `- [x] #N` is *not* a blocker). If any referenced issue is still **open**, the candidate is skipped; closed/missing blockers don't block. So `next --label ready --skip-blocked` hands out only issues whose prerequisites are done.

Candidates are tried **oldest-first**; contended ones (someone else won the race) are skipped transparently until one is won or the queue is **drained → exit 10**.

**See what you hold** with `mine`:

```sh
$ AGENT_ID=agent-7 gh-issue-lease mine
#412  12m old  ttl 240m
#530  305m old  ttl 240m  (expired)
```

---

## Optional: hooks (all opt-in, all covered by the install test suite)

Hooks are a **backstop for the human/agent who forgets to `claim`** — never the primary mechanism. Every one is gated off by default and exits `0` (never blocks) when `gh` is offline or `AGENT_ID` is unset. `test/install.test.mjs` packs the real tarball and exercises the shipped hook end-to-end, so what you install is what's tested.

**Local pre-push teeth** — rejects pushing a `<type>/<N>-<slug>` branch whose issue a *different* owner holds:

```sh
cp node_modules/gh-issue-lease/hooks/pre-push .githooks/pre-push
chmod +x .githooks/pre-push
git config core.hooksPath .githooks
git config issueLease.enforce true      # opt-in; unset/false = disabled
```

Non-issue branches pass; `gh` offline passes; bypass once with `git push --no-verify`.

**Claude Code** — the only provider whose hook can *deny* an edit in-flight. `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "gh-issue-lease claude-hook" }] }],
    "PreToolUse": [{ "matcher": "Edit|Write|MultiEdit|NotebookEdit",
      "hooks": [{ "type": "command", "command": "gh-issue-lease claude-hook --block" }] }]
  }
}
```

`SessionStart` claims the branch's issue and drops a per-worktree marker; `PreToolUse` reads that marker and allows with **zero network calls and zero subprocesses** on the hot path (owner editing its own issue) — branch + git-dir come from reading `.git/HEAD` directly, so the per-edit check is **~37 ms, within ~3 ms of Node's own cold-start floor** (a foreign issue falls back to one network check). That 34 ms of Node startup is the physical wall for a pure-npm CLI; going lower means a native binary or a resident daemon.

**Codex** — its `notify` fires *after* a turn, so it **cannot block** (that's a Codex limitation, not ours; the pre-push hook is the teeth for Codex). It's still useful as an auto-claim + heartbeat so a long session never lets its lease lapse. In `~/.codex/config.toml`:

```toml
notify = ["gh-issue-lease", "codex-hook"]
```

**Anything else** (Cursor, a shell `PROMPT_COMMAND`, a CI step) — the generic `gh-issue-lease hook` claims/heartbeats the current branch's issue and exits `0`. It's throttled by the marker to at most one GitHub write per `TTL/3`.

---

## Guarantees & edge cases

| Case | Behaviour |
|---|---|
| Two independent agents claim at once | Exactly one `201` (won); the other `422` (held). Atomic — the core guarantee. |
| Parent + its sub-agents (same `AGENT_ID`) | Idempotent — all "win", never block each other. |
| No `AGENT_ID` set | `claim` fails **closed** (exit 3); hook warns but never blocks; `guard-push` blocks a foreign-held issue you can't prove is yours. |
| Agent crashes holding a lease | Expires after `AGENT_LEASE_TTL_MIN` (default 240m); next claimer reclaims it. |
| Task outlasts the TTL | `renew <N>` re-stamps the clock; crashed agents don't renew. |
| Network blip after the ref was created | Retry sees `422`, owner is you → `won`. Idempotent. |
| Stealing an expired lease | Best-effort delete+recreate; GitHub refs have no CAS, so the hard guarantee stays the atomic *create*. Keep TTL conservative. |
| `gh` offline / unauthed | Fails **open** — never blocks work. |
| Two machines, identical `AGENT_ID` | They'd collude — `AGENT_ID` must be **unique per agent**. |

## Config

| Env | Default | Purpose |
|---|---|---|
| `AGENT_ID` | *(required)* | Unique owner per agent; children inherit it. |
| `AGENT_LEASE_TTL_MIN` | `240` | Minutes before a lease is stealable. |
| `ISSUE_LEASE_NAMESPACE` | `leases` | Ref namespace → `refs/<ns>/issue-<N>`. |
| `GH_ISSUE_LEASE_MAX_RETRY` | `5` | Backoff attempts on rate-limit / 5xx. |

## License

MIT © Mackenzie Robertson
