# Recipes

Each recipe names a symptom, the smallest read-only check, the observation that supports the hypothesis, and what that observation does not establish. They exist because each of these investigations once went to the wrong component first. Treat every "usually means" as a hypothesis to distinguish, not a conclusion about the next incident.

## 1. Slow start or slow review: build the phase timeline first

**Symptom.** A session's first reply, or a review's Check, takes far longer than expected, and the report already names a culprit (the sandbox, the model, the install).

**Smallest check.** Take one run and put its boundaries on a UTC line before reading anything else. For a hook, `hook_run` gives `startedAt` (relay receipt), `preparingAt`, `turnStartedAt`, `completedAt`, plus `headSha`, `projectionId`, `projectionGeneration` so the run is not confused with a re-review of the same PR. Then align the daemon log for the same run, and the runtime's own log under the session HOME. Keep cold and warm runs apart; a re-review of a checkout that kept `node_modules` is a different measurement from a first review.

| Phase                         | Boundary evidence                                                                                                           | Typical size seen so far                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Ingress, dispatch, placement  | `hook_run.startedAt` → `preparingAt`; the `executor: session … runs on daemon …` line when placement ran                    | Pool: ~9 s waiting for a heartbeat to carry the duty grant; a network policy that had not converged once cost 10–28 s |
| Image, VM or host-shim start  | Sandbox or shim bind lines; on a pool, the pod's claim labels (`claim-first-ready-at` minus `controller-first-observed-at`) | Warm-pool claim 26 ms; a VM start ~1.4 s; a fresh pod with an image pull 30–40 s                                      |
| Repository checkout           | Workspace preparation and git completion lines; file mtimes under the session directory                                     | ~16.5 s on one measured self-hosted start; 4–5 s for a 69 MB tree on the pool                                         |
| Runtime and skill preparation | `runtimes: "<id>" launches …`, skill sync lines, `<root>/runtimes/` mtimes                                                  | An adapter that unpacks a vendored harness on first use: ~7 s and 455 MB (fixed in PR #2025)                          |
| ACP initialize or resume      | `acp: resumed session … via session/load`, or the new-session result                                                        | ~2 s                                                                                                                  |
| First model output            | `turnStartedAt`, the first `session/update` row in the transcript                                                           | ~2 s to first token; a review model may then read for minutes before its first tool call                              |
| Tool execution                | `tools` rows (`scripts/daemon-store.cjs tools … --session <key>`), the runtime log                                          | A first-round `pnpm install` was ~1.5 min of a 12-minute review, i.e. about 12 %                                      |
| Final publication             | `completedAt`, the projection's write, the platform post                                                                    | Seconds, unless the projection queue is starved (symptoms table, second row)                                          |

**What supports the hypothesis.** A phase whose two boundaries were both observed and whose duration is most of the total. Put `unknown` in a row whose boundary was not observed rather than inferring it from the neighbours.

**What it does not establish.** `startedAt` → `preparingAt` bounds dispatch and waiting, and `preparingAt` → `turnStartedAt` contains several preparation phases; neither is a measurement of VM start. A slow total, a late Check, the agent's own narration, or a user's impression identifies no component: on one measured start the sandbox was blamed for a delay that was repository preparation, and on one review "installing dependencies" was blamed for what was mostly model reading time.

## 2. Missing models or ignored configuration: capture the execution context that served the turn

**Symptom.** A model the console should list is missing, a setting changed in the console appears to have no effect, or a turn behaved as if configured differently from the agent's current form.

**Which code served it.** Pinning the daemon's `agentVersion` (SKILL.md step 1) is the first layer, not the last. Three more can lag independently:

| Layer                                 | Where to read it                                                                                                                                                                                                  | How it lags                                                                                                                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The daemon-owned ACP adapter          | `<root>/runtimes/<package>@<version>/` (`packages/daemon/src/runtimes/runtime-store.ts`); the log's `runtimes: "<id>" launches …` line at start                                                                   | The dist-tag is resolved once per daemon start, and an unreachable registry keeps whatever the store already holds; `install()` reuses an existing tree                                |
| The nested runtime CLI inside it      | The adapter's own dependency tree, and the runtime's cache under the session or agent HOME (for Codex, `models_cache.json` records the `client_version` that fetched it)                                          | Updating the CLI on the host or the desktop does not touch the daemon-owned copy; a host copy injected by environment once masked a newer bundled one (PR #2087 removed the injection) |
| The CLI that performs upgrades        | `<root>/cli-entry` (the path the CLI wrote at its last invocation), `<root>/current` → `versions/<v>`; the log's `cp: installing daemon <v> via <cliEntry>` line (`packages/daemon/src/lifecycle/cli-upgrade.ts`) | An upgraded daemon can have been installed by an older CLI, and the CLI is not upgraded by the daemon                                                                                  |
| Control Plane, relay, execution image | The deployment's rollout history; for a pool member the pod's image; for an executor-placed session, the executor's version, not the home daemon's                                                                | A symptom within a minute of a rollout is the rollout until shown otherwise                                                                                                            |

**Which configuration served it.** The `sessions` row holds the session's own execution state, which is not the agent's current form: `observedRuntime`/`observedModel` (what the last turn reported), `decisionModel` (a Decision-pinned target), `modelOverride`/`effortOverride`/`permissionModeOverride`/`fastModeOverride`/`outputModeOverride` (per-session sticky overrides), `birthStrategy` and `workspaceIsolation` (an isolated session keeps its birth strategy across later changes, PR #2517), and `executorDaemonId`. The snapshot the Control Plane shows is layered override → agent configuration and re-emitted after every turn (`packages/daemon/src/store/session-metadata-outbox.ts`), so a console value is the last snapshot, not a live read.

**Smallest check.** For the session: the `sessions` columns above against the agent's current configuration. For the code: the four rows of the table, read on the daemon that ran the turn (the executor when placement moved it). For a missing model: the daemon log's `probe:` lines at start, and the runtime cache's `client_version` on the host against the version bundled in the adapter.

**What supports the hypothesis.** A `client_version` older than the adapter's bundled CLI: the host copy answered the probe. An `observedModel` or `decisionModel` that differs from the agent's model: the session is pinned, and the console change applies to new sessions. A `cli-entry` older than the daemon: the last upgrade ran through the old CLI. A launch line naming a different adapter version than `<root>/runtimes/` now holds: the running process predates the install.

**What it does not establish.** Pool membership or the agent's current form does not show which image, adapter, CLI, or settings an existing session used. An observed pair is a last-turn observation. `runtimes ready:` at start lists what the daemon could launch, not what a given session launched.

## 3. Git works but PR creation returns 403: identify the credential route before touching permissions

**Symptom.** `git clone`/`push` succeed, but creating or updating a pull request fails with `Resource not accessible by integration`, or a comment/review call is refused, and the first instinct is to widen the GitHub App's permissions.

**The three routes.** The daemon serves credentials on distinct planes with distinct capability sets (`packages/daemon/src/cp/git-credential.ts`), and the console applies a separate authorization before any of them exists:

| Route                      | Who calls it                                                                              | Capability set                                                                                                                                                              | How the target is chosen                                                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git credential helper      | git itself, through the helper line in the checkout's `.git/config` (`git-credential`)    | `contents` only, one token per repository                                                                                                                                   | The remote git is talking to                                                                                                                                                                                                                  |
| `gh` wrapper               | the agent's `gh` calls, via `run/bin/gh` → hidden `gh-token` → the daemon's helper socket | `contents` + `issues` + `pull_requests` (+ `actions` when the Control Plane advertises it); the Control Plane clamps each capability to the repository's authorization tier | gh's own precedence (`packages/daemon/src/cp/gh-target.ts`): last `-R/--repo`, then the target the command names (a repo positional, a `gh api` path, a PR or issue URL), then `GH_REPO`, then the cwd origin remote, else the workspace repo |
| Console user authorization | the Control Plane, when a user attaches a repository to an agent                          | the user's own access to that repository (`…/github/installations/:id/repositories/:owner/:repo/access`; 403 codes `GITHUB_IDENTITY_REQUIRED`, `USER_NO_ACCESS`)            | The repository being attached                                                                                                                                                                                                                 |

Two things follow. A token minted on the git plane carries `contents` alone, so a REST request to the pulls endpoint made with it (an agent that ran `git credential fill` and passed the result to `curl`, or exported it as `GH_TOKEN`) fails with exactly this 403 while the installation is perfectly able to open PRs through the gh plane. And a `GH_TOKEN` already in the environment makes the wrapper `exec` the real `gh` untouched, so the daemon never sees that call at all.

**Smallest check.** Record, without printing any credential: the caller (git, `gh` through the wrapper, or a hand-built REST call), the exact command from the transcript tool row (metadata first, `--seq <n> --raw` for that one row), the target repository, the route, and the denied capability. Then read the daemon log around that timestamp for the helper socket's audit line:

```
gitcred: local credential outcome=<served|denied|rejected|erased> agent="…" repo="<owner/repo>|workspace" plane=<git|gh|glab>
```

**What supports the hypothesis.** `outcome=served plane=git` immediately before a pulls or issues REST call that returned 403 is the route problem, not a permission problem. `outcome=denied` carries the Control Plane's reason: an agent-level refusal is terminal until the agent's configuration changes; a repository-level refusal is cached for 60 s, so an operator's authorization in the console takes effect on the next call without a restart. `outcome=rejected` (a warning) means the caller presented no valid local capability — the case of a stale agent id left in the checkout's helper line after an agent was recreated under the same name (PR #898 pinned the env identity). The wrapper's exit code says which branch it took: 2 = not a GitHub target, real `gh` ran; 3 = refused, and the reason went to the agent's stderr.

**What it does not establish.** A 403 from GitHub does not show which token was used, and a served token does not show what the agent did with it. Read the App's installation permissions only after the route is known; widening them for a git-plane token changes nothing.

## 4. A turn disappears or repeats after a restart: separate admission, resume, execution, and completion

**Symptom.** After a daemon restart or upgrade, a message that was acknowledged never produced a reply, or the same work happened twice, or a hook's Check reports a handover.

**Mechanism.** Admission writes a durable `inbox` row before the caller is told `delivered:true`; the row is removed only on a terminal path (success, reject, cancel, gate drop), so a shutdown-cancelled or never-started turn survives the restart. On startup the daemon replays rows FIFO per session key, and the runtime resumes the session or recreates it:

| Evidence                                                                                   | Where                                            | Meaning                                                                                                     |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `shutdown: deadline hit with N ACP turn(s) still in flight — cancelling`                   | daemon log, old process                          | The drain window closed on running turns; their inbox rows were kept                                        |
| `durable inbox: replayed N admitted message(s) through the serial gate`                    | daemon log, new process                          | Rows re-admitted; N is the number of turns that will run again                                              |
| `durable inbox: hook row <id> belongs to another daemon's dispatch — reporting a handover` | daemon log                                       | A pool member with a new id cannot resume a hook fenced to the old one; the Check is told to retry          |
| `acp: resumed session <id> via session/load`                                               | daemon log (info)                                | The runtime restored its own history; the replayed prompt lands in the same conversation                    |
| `acp: session/load failed … — will recreate` (debug)                                       | daemon log                                       | A fresh runtime session; the daemon replays the transcript as context, own replies included (`historyLost`) |
| `(AgentConnect delivery note: …)` in the replayed prompt                                   | the runtime's own rollout under the session HOME | The model was told the turn was interrupted (PR #2301)                                                      |

The replay decision is `packages/daemon/src/session/turn/replay-plan.ts`. A replayed turn is `retryAdmittedTurn`: its trigger is redelivered even when a progress reply had already advanced the session's read cursor (`sessions.lastDeliveredTs`) past it — PR #2370 is the case where, before that rule, the cursor had passed an admitted trigger and the resumed session skipped its work.

**Smallest check.** On the owning daemon, join the same durable entry to its session and its run: `inbox` by session key (`id`, `enqueuedAt`, `completedAt`, `terminalReport`, `reportOwnerId`, `hookContext`), the `sessions` row (`state`, `lastDeliveredTs`, `acpSessionId`, `lastTurnOutcome`), and the Control Plane's `hook_run` or `cron_run` (`sessionId`, `turnStartedAt`, `completedAt`, `reason`). Then read the daemon log around the restart for the lines above.

**What supports the hypothesis.** A row with `completedAt` null after the restart plus the `replayed N` line: the turn ran again by design, and a duplicate reply is the replay of an interrupted turn, not a second trigger. A row with `completedAt` set and `terminalReport` retained: execution finished; only the report to the Control Plane is pending, and nothing should be redelivered. `lastDeliveredTs` at or past the trigger with no completion and no replay line: the pre-#2370 skip, or a daemon that has not been upgraded to it. A handover line: the work moved daemons; look for the run on the daemon named by `dispatchDaemonId`.

**What it does not establish.** An advanced read cursor is not a completed turn. A successful `session/load` is not resumed work; it only means the runtime kept its history. A retained terminal report is not an unfinished turn. The console showing `idle` between the interruption and the replay is the reporting gap PR #2338 closes, not a lost turn. Before proposing a redelivery, establish whether execution or publication already completed.

## 5. No local session rows: find the store backend before concluding anything

**Symptom.** `<root>/state/local.sqlite` is missing or has no `sessions` rows for a session the Control Plane lists, and the investigation is about to conclude the data is gone.

**Where the store lives.** `<root>/config.json` → `store` is `{ "backend": "sqlite" }` by default, or `{ "backend": "postgres", "configFile": "<path relative to root>" }` (PR #2240). A pool member (`--k8s`) always reads the mount `/var/run/ac-data-plane/config.json`. That file is `{ "version": 1, "databaseUrl": …, "maxConnections": … }` and is the only place the database is named — never a flag, never an environment variable. At startup a self-hosted Postgres store logs `store: PostgreSQL (a shared store; this machine keeps no local session history)`, and it refuses to start without the Control Plane, because every row carries the agent's organization.

**The database.** Schema `agentconnect_cloud_store`, the same table and column names as SQLite through the dialect layer (`packages/daemon/src/store/postgres-dialect.ts`); columns are camelCase and must be quoted; rows carry `orgId` (and owner claims such as `ownerId`), so scope every query by organization and session key. This is not the Control Plane database that `scripts/cp-query.sh` reaches: that one has `session_meta`, this one has `sessions`, `transcript`, `inbox`.

**Smallest check.** On the daemon host, print only the backend and the file name, never the whole config:

```bash
node -e 'const c=require(process.argv[1]);console.log(JSON.stringify(c.store??{backend:"sqlite"}))' < root > /config.json
ls -la < root > /state/local.sqlite
```

**Reading it.** Open a plain read-only connection; never call `openPostgresDataPlane()` or `LocalStore.open()` from a diagnostic, because both take the schema advisory lock and run bootstrap and migrations. `scripts/daemon-pg-query.cjs` does the plain connection: the data-plane file's connection string (read where the file is, never copied off), `search_path=agentconnect_cloud_store,pg_catalog`, `SET default_transaction_read_only = on`, and `application_name=agentconnect-debug` so it is distinguishable in `pg_stat_activity`. The `pg` driver it needs is importable in a pool pod (`/app/packages/daemon/node_modules`) but not on a self-hosted host, where the published daemon is one self-contained bundle with the driver inlined; there, install it once into a scratch prefix and point `NODE_PATH` at it. If `psql` is installed instead, hand it the connection through `PG*` environment variables, never on a command line:

```bash
kubectl -n node -e "$(cat scripts/daemon-pg-query.cjs)" -- pool 'select count(*) from inbox where "completedAt" is null' < namespace > exec < pool-pod > --
ssh daemon-host 'npm --prefix /tmp/ac-debug install --silent pg@8 && NODE_PATH=/tmp/ac-debug/node_modules node - <root> "select key, \"sessionId\", state, \"executorDaemonId\" from sessions where \"orgId\" = $1 and key like $2 order by \"updatedAt\" desc limit 20" <orgId> "%<thread>%"' < scripts/daemon-pg-query.cjs
```

**What supports the hypothesis.** `backend: postgres` with an empty or absent SQLite file: the rows are in the shared store, look there. `backend: sqlite` with an empty file: the daemon is on a different root from the one that holds the data, or retention purged the session (`session_purges` keeps the receipt until the Control Plane acknowledges it).

**What it does not establish.** An absent SQLite file is not an absent session. Rows in the shared store are not runtime state on this machine: a session that ran on its home daemon keeps its ACP state there, and only an executor-placed session can be continued elsewhere. The shared store is not the Control Plane database, and a count there says nothing about `session_meta`.
