---
name: agentconnect-debug
description: Diagnose a live AgentConnect incident from evidence — a session that is stuck, missing, or ran on the wrong machine; a hook or review Check that never settles; a daemon that looks online but drops work; a webchat that cannot reach its agent; a turn killed part-way; a control-plane row the code "cannot" have written. Use this skill whenever someone reports something wrong in a running deployment (test, staging, or production), asks why a session, cron, hook run, or review did what it did, or wants a daemon's local store, transcript, or logs read. Use it even when the report looks like a plain code bug — the first three checks (environment, daemon version, where the artifact lives) are exactly what past investigations skipped and paid for.
---

# Debug AgentConnect

Work from evidence, in a fixed order, and say what each conclusion rests on. Most hours lost in past investigations were not spent on hard problems. They went to four mistakes: reading the wrong environment, reading `main` while the daemon ran an older release, searching the place one happens to know instead of the place the artifact must be, and treating one indirect signal as proof. The order below forces those checks before anything deeper.

## 0. Establish the coordinates

Take the environment coordinates from local instructions or memory, never from names or guesses: which console and Control Plane is which environment; where each self-hosted daemon runs, with its root, service form, and log source; the cluster and namespace of pool daemons; the local time zone the console renders in; and any read-only restrictions on production. A tool connector or console login bound to one environment tells you nothing about another. If the coordinates are not recorded, ask for the environment and the daemon before reading anything.

Write down, before touching data:

- the environment and the ids in the report — session, agent, daemon, hook run, check run;
- the time window in UTC (database timestamps are UTC; the console may render a local zone);
- which platform the session belongs to (`session_meta.platform`, `hookKind`), because that decides the ingress path.

## 1. Pin the version

Self-hosted daemons lag the release train by one or more release candidates; pool members follow it. Behavior that the current code cannot produce is usually old code, and a Control Plane table is written by daemons of several versions at once, so one odd row proves nothing about `main`.

Read the writer's version first (`daemon`: `name`, `agentVersion`, `lastSeenAt`, `host`), then read the code at that tag:

```bash
git show v<agentVersion>:packages/daemon/src/<file>
```

To test what `main` does, use an agent placed on the pool, not a self-hosted daemon.

## 2. Locate the artifact

Decide where the thing must be before looking for it. "The place I know is empty" is not "it did not happen".

- **Which id you hold.** A session has an outward `sessionId` and a runtime `acpSessionId` (`docs/designs/session-concept.md` §1.1). The Control Plane, the console routes, hook runs, and projections key by the outward id. A deep link that returns "Session unavailable" mid-run while the final link works was minted from the ACP id.
- **Which daemon and which machine.** `session_meta` gives `agentId`, `daemonId`, `executorDaemonId`, `stayedHomeReason`, `platform`/`channel`/`thread`, `phase`. A non-null `executorDaemonId` means the turn ran on another daemon; `stayedHomeReason` names why it did not.
- **Which directory.** A session's daemon-owned state lives under a leaf named by the session key alone, `session-<sha256(sessionKey)[:24]>` (`packages/daemon/src/acp/host-key.ts`). Compute it with `scripts/daemon-store.cjs leaf <sessionKey>` and match it against the disk rather than trusting logs. A confined session sits at `<agentsDir>/<agentId>/sessions/<leaf>/{workspace,repos,home}`; a shared-host session uses `<agentsDir>/<agentId>/workspace`; a session borrowed by an executor sits at `<root>/sessions/<leaf>/` on the executor, which never has that agent's directory; a Linux host-shim run leaves `<root>/hs/<12hex>/`.
- **Which source of truth.** Transcripts and tool bodies never reach the Control Plane; it holds only metadata. The console proxies transcript reads from the owning daemon live, so an empty transcript view means "the daemon cannot serve it now", not "nothing happened".

## 3. Pick the evidence source by symptom

Start with [references/symptoms.md](references/symptoms.md): it maps a reported symptom to the first query, what the result usually means, and where the fix landed. Then read [references/evidence-sources.md](references/evidence-sources.md) for how to read the source you need. Five investigations that went to the wrong component first have a worked recipe in [references/recipes.md](references/recipes.md): slow starts, the code that actually served a turn, a 403 with working git, a turn lost or repeated across a restart, and a store that is not where SQLite would be. Work outward in this order and stop when the evidence explains the report:

1. Control Plane tables — what was dispatched, to whom, and what state the orchestrator believes.
2. The daemon store — what the daemon believed and did (`sessions`, `transcript`, `inbox`, outboxes).
3. The runtime's own log under the session or agent HOME — what the process saw, which the transcript may not carry.
4. The daemon's process log — journal, log file, or a foreground pane.
5. Ingress — relay logs and the gateway access log, for anything that may never have reached a daemon.

Use the bundled scripts instead of retyping queries; every retyped one-liner in the past broke on quoting:

- `scripts/daemon-store.cjs` reads a daemon's `<root>/state/local.sqlite` read-only with the host's own Node: `leaf`, `sessions`, `tools`, `query`. `tools` prints metadata only and scopes to one session with `--session`, because a thread's rows are shared by every agent in it; a row's command and output come out only for one `--seq` with `--raw`, because another session's tool call can carry a credential that must not land in this investigation's transcript or in any public text.
- `scripts/cp-query.sh` runs one parameterized read-only statement inside a Control Plane pod with the pod's own database credentials.

## 4. Check the premise before concluding

Before you write a cause down, run it past these. Each one has cost a wrong conclusion before.

- A daemon shown `ready` while `hook_run.reason = daemon_offline`: look at relay pod restart times first. A relay that came up seconds earlier had no daemon connection yet; the run is redelivered automatically.
- A Check that is `queued` while the turn is visibly running: `hook_run.turnStartedAt` is null because the daemon's `hook/start` barrier failed during a Control Plane reconnect. The turn completes without review authority and lands as a neutral check.
- A failed `execute` tool with empty output and only an exit code: the real stderr is in the runtime's own log, not the transcript.
- A row in `hook_review_projection` with `attempts = 0`: nothing has tried yet. That is a queue problem or a still-running review, not a write failure. Rising `attempts` with `lastErrorCode = ambiguous_write` is the opposite case.
- Many unrelated failures at once, or "skipped" everywhere: check `df -h` on the host before reading anything else.
- A session directory with no `sessions` row, or a store with no row for a session the Control Plane knows: check which root the daemon started on (`agentconnect status` prints it) before assuming data loss.
- A feature reported "not installed": decide where its product must appear first. Repository-tracked skills arrive with the clone; git-sourced skills land at the agent level; managed bundles are the only ones in `agent.managedSkills`.

## 5. Report

Lead with the cause, or the open hypotheses and the next check for each. Then give the timeline in UTC, and for every claim the source and the query or file it came from. Separate what is already fixed (name the PR) from what is a product gap. When the report becomes public text — an issue, a PR, a commit — refer to private hosts, ids, clusters, and hostnames by category, never by value; use reserved example names where a literal is unavoidable.

## Safety rails

- Read only. Open SQLite with `readOnly`, set the Postgres session read-only, and never write to a shared database by hand; a systemic fix goes through code.
- Never list processes with their arguments on a daemon host (`ps aux`, `pgrep -af`): the daemon's command line can carry an API key. Use `ps -o pid,ppid,lstart,comm`, and never print a service unit's environment or a foreground command line.
- Do not restart, stop, or reconfigure a daemon or service as part of diagnosis. Report what a restart would change and let the operator decide.
- Do not walk a whole disk with `du` on a shared host; use `df -h` and a depth-limited `du` on the suspected tree.
- Respect production restrictions: where `exec` into a pod is not allowed, work from logs and the console; where a daemon on a host belongs to another environment, leave it alone.
- Keep secrets out of scratch files and transcripts: a `DATABASE_URL` stays inside the pod, an API key stays in the service unit, and a tool row's raw command or output is read one row at a time and never quoted in public text.
