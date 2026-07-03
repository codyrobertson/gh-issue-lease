# gh-issue-lease

**An atomic, GitHub-native mutex for multi-agent work. The lock IS a git ref — no server, no database, first writer wins.**

When many agents (Claude, Codex, humans, CI jobs — anything) work the same repo, they collide: two of them grab the same issue and duplicate or clobber each other's work. `gh-issue-lease` gives every agent one command to run before touching an issue. It leases the issue atomically, so exactly one wins.

```sh
npx gh-issue-lease claim 1234   # → "won" (go), "held by …" (pick another), or "degraded" (proceed)
```

Zero runtime dependencies. One small file. It only needs the [`gh` CLI](https://cli.github.com/) authenticated.

---

## How it works (and why there's no database)

The lock **is** a git ref: `refs/leases/issue-<N>`. Creating a ref is **atomic on GitHub's backend** — the first `POST /git/refs` gets HTTP `201`, and every later one gets `422 "Reference already exists"`. That one guarantee is the entire primitive: a real server-side mutex with nothing to run.

The ref points at a tiny root commit whose message carries `{owner, ttlMin}` and whose GitHub-set commit date is the lease clock. So a crashed agent's lease **expires on its own** and the next claimer reclaims it. No heartbeat process, no lock table, no service.

> **Why not ship an embedded database?** A mutex only works if every agent sees the *same* lock. GitHub is the shared, atomic, already-authenticated store every agent can already reach. An embedded DB (SQLite) is per-machine — two agents on two machines each get their *own* copy and can't see each other's locks, so it can't be the shared store. GitHub already is. (For single-host fleets or scale past GitHub's rate limit, see [Scaling](#scaling) — the answer is a backend swap, still never an embedded DB.)

---

## Install

```sh
# one-off, no install:
npx gh-issue-lease <command>

# or as a dev dependency / global:
npm i -D gh-issue-lease
npm i -g gh-issue-lease
```

Requires the `gh` CLI, authenticated with push access to the repo (`gh auth login`).

---

## Commands

| Command | Exit | Meaning |
|---|---|---|
| `claim <N>` | `0` won/degraded · `1` held | Lease issue N. **Run this before you work an issue.** |
| `release <N>` | `0` | Drop the lease (unconditional). Usually run on merge. |
| `renew <N>` | `0` renewed · `1` held | Heartbeat — re-stamp your lease for a task that outlasts the TTL. |
| `status [<N>]` | `0` | Who holds what (all leases, or one). |
| `reap` | `0` | Delete expired + closed-issue leases. Run from a cron or opportunistically. |
| `guard-push <branch>` | `0` allowed · `1` blocked | Used by the pre-push hook (below). |

`claim` prints one of `won` / `held by <owner>` / `degraded`:

- **won** — you hold it. Proceed.
- **held by …** — someone else holds a *live* lease. Pick another issue.
- **degraded** — `gh` is offline/unauthed. The tool **fails open**: proceed *without* a lease rather than block you. Rare-collision risk is accepted over halting all work on an infra blip.

### Programmatic API

```js
import { claim, release, renew } from "gh-issue-lease";

const r = claim(1234);              // { result: "won" | "held" | "degraded", holder? }
if (r.result === "held") console.log(`taken by ${r.holder.owner}`);
```

---

## Enforcement (make it not-optional)

Leasing only helps if agents actually do it. The `pre-push` hook makes it **mechanical** — it rejects pushing a branch `<type>/<N>-<slug>` whose issue is leased by someone else:

```sh
mkdir -p .githooks
cp node_modules/gh-issue-lease/hooks/pre-push .githooks/pre-push
chmod +x .githooks/pre-push
git config core.hooksPath .githooks
```

Non-issue branches pass. `gh` offline passes. Bypass a single push with `git push --no-verify`; disable entirely with `git config issueLease.enforce false`. Because the rule is in the hook (not in any one agent's prompt), it binds **every** agent identically — Claude, Codex, Tony, or a human.

---

## Identity

Set `AGENT_ID` to a **unique** label per agent so leases are attributable and idempotent-retry works:

```sh
export AGENT_ID="codex-worker-7"
```

Without it, the owner falls back to `user@host` (fine for a single human; the CLI warns). At scale a unique `AGENT_ID` is required — two agents sharing an owner are indistinguishable, and the "I already hold it" fast-path would wrongly let both proceed.

---

## Scaling

The primitive is correct at any size; the ceiling is **GitHub's rate limit — which is per token (5,000 req/hr).**

- **Give each agent its own auth** (a PAT or a GitHub App installation token). Then limits are per-agent and `claim` — only ~2 writes, fired once per issue-pickup, not in a loop — is nowhere near the budget. Sharing one token across a large fleet is the only thing that hits the wall.
- **Transient failures back off automatically** with exponential backoff + jitter (`GH_ISSUE_LEASE_MAX_RETRY`, default 5), so a herd contending on one hot issue self-spaces instead of hammering in lockstep.
- **Past GitHub's ceiling** (thousands of agents, high churn): the `gh` calls live behind a small internal backend seam. A *networked* backend (Redis/Postgres) can replace it without changing the primitive — still shared, still never embedded. A single-host fleet can use a filesystem-lock backend (atomic `O_EXCL`, zero deps). The default install stays zero-dep.

---

## Guarantees & edge cases

| Case | Behaviour |
|---|---|
| Two agents claim at once | Exactly one gets `201` (won); the other gets `422` and yields. **Atomic — the core guarantee.** |
| Agent crashes holding a lease | Lease expires after `AGENT_LEASE_TTL_MIN` (default 240m); next claimer reclaims it. |
| Legit task outlasts the TTL | Call `renew <N>` periodically to re-stamp the clock. Crashed agents don't renew, so they still free up. |
| Network blip after the ref was actually created | Retry sees `422`, checks owner, finds it's **you** → returns `won`. Claim is idempotent. |
| Stealing an expired lease | Best-effort delete-then-recreate. GitHub refs have **no compare-and-swap**, so the hard guarantee stays the atomic *create*; the delete is a tiny TOCTOU window. Keep the TTL conservative. |
| Thousands of live leases | `status`/`reap` paginate. |
| `gh` offline / unauthed | Fails open — proceed without a lease (never blocks work). Enforcement hook also passes. |
| Non-integer / injected issue number | Rejected before any API call. |
| Branch protection | Leases live under `refs/leases/*`, not `refs/heads/*`, so branch protection doesn't apply. An org ruleset targeting `refs/**` could block ref creation — scope it to exclude `refs/leases/*`. |
| Fork PRs | Leasing needs push access to the coordination repo; fork-only contributors can't lease. Intended for trusted agent fleets. |

---

## Config

| Env | Default | Purpose |
|---|---|---|
| `AGENT_ID` | `user@host` | Unique owner label per agent. |
| `AGENT_LEASE_TTL_MIN` | `240` | Minutes before a lease is stealable. |
| `ISSUE_LEASE_NAMESPACE` | `leases` | Ref namespace → `refs/<ns>/issue-<N>`. |
| `GH_ISSUE_LEASE_MAX_RETRY` | `5` | Backoff attempts on rate-limit / 5xx. |

## License

MIT © Mackenzie Robertson
