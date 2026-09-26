# Evidence sources

Where each kind of evidence lives, what it can and cannot tell you, and how to read it without changing anything. Table and column names below are the current code's and will drift; before writing a query, read the schema the daemon under investigation actually runs — `pragma table_info(<table>)` on the live store, or the DDL at its tag (`git show v<agentVersion>:packages/daemon/src/store/local-store.ts`, and `packages/control-plane/prisma/schema.prisma` for the Control Plane). When a bundled script fails on a column, the schema moved: update the script rather than working around it.

## 1. Control Plane database

**What it holds.** Orchestration metadata only: daemons, agents, session metadata, hook runs and review projections, cron runs, audit rows. Never message bodies, transcripts, tool output, or attachments.

**Tables of interest** (names are the Prisma `@@map` values, not model names — `packages/control-plane/prisma/schema.prisma`):

| Table                    | Columns to read first                                                                                                                                                                                                         | Answers                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `daemon`                 | `name`, `host`, `agentVersion`, `status`, `health`, `lastSeenAt`, `unreachableAt`, `orgId` (null = install-wide pool member), `clusterIdentity`                                                                               | Which release wrote a row; whether the daemon was reachable at the time |
| `session_meta`           | `id` (outward session id), `agentId`, `daemonId`, `executorDaemonId`, `stayedHomeReason`, `platform`, `channel`, `thread`, `phase`, `activityState`, `hookKind`, `runtime`, `model`, `startedAt`, `lastActivityAt`, `endedAt` | Where a session lives, where it ran, what it was for                    |
| `hook_run`               | `status`, `reason`, `startedAt`, `preparingAt`, `turnStartedAt`, `completedAt`, `orphanedAt`, `dispatchDaemonId`, `sessionId`, `projectionId`, `projectionGeneration`, `redeliveryAttempts`, `redeliveryNextAttemptAt`        | Whether a delivery was dispatched, to whom, and how far the turn got    |
| `hook_review_projection` | `checkRunId`, `desiredState`, `observedState`, `attempts`, `lastErrorCode`, `leaseOwner`, `writePhase`, `writeStartedAt`, `nextAttemptAt`, `generation`, `currentHookRunId`                                                   | Why a Check on the code host does not match what the agent posted       |
| `cron_run`               | `status`, `startedAt`, `durationMs`, `sessionId`, `reason`                                                                                                                                                                    | A schedule that fired, and whether its completion report arrived        |
| `app_user`, `membership` | —                                                                                                                                                                                                                             | Who a `createdByUserId` is; `app_user` is the user table                |

**Timestamps** are UTC. The console may render another zone; convert before comparing to a screenshot.

**Reaper semantics you will run into.** A `running` `hook_run` or `cron_run` older than `CRON_RUN_TTL_SEC` (default 1800 s, scanned every `CRON_RUN_REAP_INTERVAL_SEC`) is reaped as orphaned; the projection goes to a terminal `timed_out` and the code host shows a re-request control. `hook_run.reason = daemon_offline` is retryable: the redelivery reconciler asks the code host to redeliver after a grace period (`redeliveryNextAttemptAt`).

**How to query.** Run SQL inside a Control Plane pod so the database URL never leaves it:

```bash
scripts/cp-query.sh --context <ctx> -n <namespace> -- <pod-or-deployment/name> \
  'select name, "agentVersion", "lastSeenAt" from daemon where id = $1' <daemon-id>
```

The script resolves the bundled `pg` driver inside the image, sets the session read-only, and passes every literal as a `$n` parameter, which is also what keeps quoting sane (cast intervals: `$2::interval`). Quote camel-case columns. Resolve the pod name every time; it rolls with each release. Where production forbids `exec`, fall back to `kubectl logs` and the console; do not copy a secret out to query from elsewhere.

## 2. The daemon store

**Where.** `<root>/state/local.sqlite` for a self-hosted daemon (`packages/daemon/src/paths.ts`); the root defaults to `~/.agentconnect`, or `AGENTCONNECT_ROOT`, or `--root`. `agentconnect status` prints the root the service runs on. Before reading that file, check `<root>/config.json` → `store.backend`: a pool member, and any self-hosted daemon configured with `store: { backend: "postgres", configFile }` (PR #2240), keeps the same tables in the shared Postgres data plane (schema `agentconnect_cloud_store`, lowercase column names) and holds no local session history, so an absent or empty SQLite file there is not a missing session. Print only the `store` object, never the whole config.

**Tables** (`packages/daemon/src/store/local-store.ts`):

| Table                     | Read for                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions`                | `key` (`platform:channel:thread:agentId`), `sessionId` (outward), `acpSessionId`, `state`, `executorDaemonId`, `stayedHomeReason`, `lastTurnOutcome`, `workspaceIsolation`, `birthStrategy`, `observedRuntime`/`observedModel`, `updatedAt` |
| `transcript`              | Every row the console renders: `channel`, `thread`, `ts`, `sender`, `kind` (`text`, `tool`, `reasoning`, `plan`, `elicit`, `app`), `text`, `body`, `seq`, `sessionScope`; keyed by conversation, so two agents in one thread share rows     |
| `transcript_recipient`    | Which local `sessions.key` admitted a transcript row (`sessionKey`, `seq`)                                                                                                                                                                  |
| `inbox`                   | Queued and completed turns per `sessionKey`: `msg`, `integrationId`, `hookContext`, `terminalReport`, `completedAt`, `enqueuedAt`; what a restart replays                                                                                   |
| `session_metadata_outbox` | Session snapshots not yet acknowledged by the Control Plane (`failedAttempts`, `nextAttemptAt`); a session the console never shows is often stuck here                                                                                      |
| `session_outward_ids`     | Outward ids minted before their `sessions` row existed                                                                                                                                                                                      |
| `cron_runs`               | The daemon's side of schedule runs                                                                                                                                                                                                          |
| `permission_requests`     | Pending and answered permission asks                                                                                                                                                                                                        |

**Tool rows.** On a `kind = 'tool'` row, `body` is the JSON `ToolBody` (`packages/protocol/src/frames/session.ts`): `status` (`pending|in_progress|completed|failed`), `kind` (`execute`, `read`, `edit`, …), `rawInput` (for a shell tool typically `command`, `cwd`), `rawOutput` (for a shell tool typically `formatted_output`, `exit_code`), `truncated`. The console counts any non-zero-exit execute as a failed tool call, so one root cause fans out into a chain of red rows; read the first failure, not the last. Rows of one thread are shared by every agent in it, and `sessionScope` holds the admitting session's key: scope by it before calling a failure the investigated session's. Raw command and output are free-form and can carry a credential another session used, so read them one row at a time (`--seq <n> --raw`) and keep them out of public text. The default window is the oldest 200 rows; the summary says when more exist, and `--tail` takes the newest instead, so "0 failed" is never read as a verdict on rows that were not shown.

**Hook sessions** key their transcript as `channel = owner/repo`, `thread = <PR or issue number>`.

**How to read.** The daemon itself uses `node:sqlite`, so the host's Node can open the file without a `sqlite3` binary. Copy nothing off the host; stream the script over SSH and open read-only:

```bash
ssh daemon-host 'node - sessions <root> <substring>' < scripts/daemon-store.cjs
ssh daemon-host 'node - tools <root> <channel> <thread> --session <sessionKey>' < scripts/daemon-store.cjs
ssh daemon-host 'node - tools <root> <channel> <thread> --seq <n> --raw' < scripts/daemon-store.cjs
ssh daemon-host 'node - query <root> "select count(*) from inbox where completedAt is null"' < scripts/daemon-store.cjs
```

## 3. The daemon's filesystem

Under `<root>`:

| Path                                                      | What it is                                                                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `config.json`                                             | The daemon's configuration, including sandbox settings; a daemon started on the wrong root reads a different one |
| `state/local.sqlite`                                      | The store above                                                                                                  |
| `agents/<agentId>/workspace`                              | The shared-host checkout                                                                                         |
| `agents/<agentId>/sessions/<leaf>/{workspace,repos,home}` | A confined session: its clone, secondary clones, and its own runtime HOME, all gone when the leaf is retired     |
| `agents/<agentId>/worktrees/<id>`                         | Per-session worktrees of the shared checkout; hundreds of them make `exec` fail with E2BIG                       |
| `sessions/<leaf>/`                                        | A session this daemon executes for another daemon's agent; it never has that agent's directory                   |
| `hs/<12hex>/`                                             | One Linux host-shim run root per session                                                                         |
| `runtimes/`                                               | Daemon-owned ACP adapter installs                                                                                |
| `current/dist/index.js`                                   | The version the shims point at; `agentconnect version list` shows what is installed                              |

The leaf is `session-<sha256(sessionKey)[:24]>`; compute it with `scripts/daemon-store.cjs leaf <sessionKey>` and compare against `ls`. A leaf with no `sessions` row, or a row with no leaf, is a finding in itself.

## 4. The runtime's own log

The transcript stores what the runtime reported over ACP. When a tool row shows only an exit code, or a denial appears only as a `reasoning` row, the runtime's own state directory has the rest. It lives under the HOME the session ran with: `<sessionDir>/home` for a confined session, the agent's home for a shared host. Codex keeps its logs and its reviewer transcript deltas in a SQLite database under `.codex/` there (timestamps in epoch seconds); read it with the same `node:sqlite` technique, read-only.

## 5. The daemon's process log

Find the process without exposing its arguments:

```bash
ps -o pid,ppid,lstart,comm -C node # Linux
cat /proc/PID/cgroup               # which unit owns it: system, user, or none
```

Then read the log where that supervisor put it:

- **systemd** (`agentconnect.service`, or `agentconnect@<instance>.service`): the unit writes no file; read `journalctl -u agentconnect` for a system unit, `journalctl --user -u agentconnect` for a user unit. A `not-found` or stale user unit next to a running system unit is a leftover; trust the cgroup.
- **Foreground** (`agentconnect run` in a shell or tmux): stdout goes to the pane. `tmux list-panes -a -F "#{pane_id} #{pane_tty}"` finds it; `tmux capture-pane -p -J -t <pane> -S -20000` reads it, without timestamps. The journal then holds only the previous process.
- **Pool member**: `kubectl logs` on the pod in the deployment's namespace.

`agentconnect status` prints the service label, root, state, pid, and the log location for the default instance.

## 6. Relay and ingress

The relay terminates Slack callbacks, code-host webhooks, and webchat, then forwards to the owning daemon. It persists nothing, so its evidence is its log and its restart times.

- A refused ingress logs a status and reason (PR #2003); before that it logged nothing.
- Events that arrive in the seconds after a relay pod restarts, before it has re-established daemon connections, come back as `daemon_offline` (and were once dropped outright, #2164). Compare `hook_run.startedAt` with the relay pods' start times before blaming the daemon.
- For webchat, pair the token mint (`POST …/webchat/token`) with the socket dial (`GET /webchat?token=…` answered `101`) in the public gateway's access log. A mint with no dial means the socket died in the browser or at the edge; relay, daemon, and Control Plane logs cannot show it. Normal mint-to-dial is well under a few seconds.

## 7. The console and its BFF

The console reads session metadata from the Control Plane and proxies transcript, tool bodies, workspace files, and memory from the owning daemon on demand. An empty or unavailable transcript therefore means the daemon cannot serve it now — offline, on another root, or the session retired — not that the turn produced nothing. Deep links, check details, and footers use the outward session id; a 404 on a link is an id problem before it is a visibility problem (hook sessions are org-visible).
