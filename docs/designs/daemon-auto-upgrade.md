# Daemon Auto-Upgrade

> **Status:** Proposed (#3127)
>
> **Related designs:**
>
> - [cli-daemon-split.md](cli-daemon-split.md) — version store, `agentconnect upgrade`,
>   supervision, and the CP-commanded lifecycle operations this reuses.
> - [daemon-cp-ws-protocol.md](daemon-cp-ws-protocol.md) §8.3 — fleet control frames.
> - [background-task-aware-reclaim.md](background-task-aware-reclaim.md) — the background
>   task lease that defines "live work" after a turn returns.

A daemon owner can turn on **auto-upgrade** for one daemon. While it is on, that daemon
follows the release its Control Plane announces: it downloads the new version while
serving and restarts onto it only when it is idle. The switch is off by default.

## 1. Goals and non-goals

Goals:

- a per-daemon switch, default off, owned by whoever may already upgrade that daemon;
- the version a daemon upgrades to is the one the console's "update available" hint
  shows — the same fact, from the same source;
- no turn is ever cut short by an automatic upgrade;
- a release that cannot start on a host returns that host to the version it ran before,
  without a human;
- the console shows that an automatic upgrade is in progress and how it ended.

Non-goals:

- Kubernetes pool members. Their version is the Pod image; they refuse self-installing
  upgrades today (`FleetUpgradeCoordinator`) and keep doing so.
- Maintenance windows, org-wide rollout policies, and version pinning. §9 leaves room for
  them; the first version does not ship them.
- Upgrading the `agentconnect` CLI itself.

## 2. Division of work

**The CP decides _what_; the daemon decides _when_.**

The CP already knows the deployment's target release. `DaemonReleaseResolver`
(`control-plane/src/registry/daemonRelease.ts`) reads the npm dist-tags document for
`@agentconnect.md/daemon` and takes the version behind the deployment's pinned channel,
`DAEMON_DIST_TAG` (default `latest`; the test CP uses `rc`). `GET /daemons` returns it
as `latestVersion`, and the console compares each daemon's `agentVersion` against it to
show the upgrade hint. Auto-upgrade reuses that value and pushes it to daemons when it
changes.

Using the CP's release rather than each daemon's CLI channel matters because the two
can disagree. A daemon whose CLI was installed from `rc` against a stable CP would
otherwise follow `rc`, and the console would show one target while the daemon chased
another. With the CP as the source:

- the deployment's channel is the only channel, so every daemon of a deployment
  converges on one version;
- the daemon installs an **exact** version, so the CLI's stored channel is irrelevant;
- the deployment can stop a rollout by moving the dist-tag back (§4.1), and can later
  add a ceiling or a pause in one place (§9).

The daemon decides the moment, because only it knows whether now is a good time: turns in
flight, background tasks still running after `session/prompt` returned, and the time since
the last turn ended are daemon-local state. The CP sees a heartbeat that is up to one
interval old and a turn count without the background lease. Preparation can take minutes,
and only the process watching its own admission can pick the moment after it. The CP
never commands an automatic upgrade and runs no per-daemon scheduler.

## 3. The switch

### 3.1 Storage and delivery

The switch is a console daemon setting stored on the CP, delivered exactly like the
session retention setting:

- `Daemon.autoUpgrade Boolean @default(false)`;
- `PATCH /api/v1/orgs/:orgId/daemons/:id` accepts `autoUpgrade: boolean` under the same
  `canEdit` check that guards `POST …/upgrade` today, so enabling auto-upgrade grants no
  power a user did not already have;
- `register/ok` carries `autoUpgrade` in its settings baseline, and a change is hot-pushed
  with `config/push { 'upgrade.auto': boolean }`;
- the daemon persists the last value it received in its local store, so a restart during
  a CP outage keeps the owner's choice.

### 3.2 Eligibility

A daemon advertises `daemon-auto-upgrade-v1` only when it could carry out an upgrade
unattended — the same predicate as `bootstrapUpgradeCapable()`: `AGENTCONNECT_SUPERVISOR`
is `cli` or `service` (not `k8s`, not unset) and `<root>/cli-entry` names a CLI.

The console renders the switch only when the feature is present and otherwise explains
why it is unavailable ("runs without a supervisor", "pool member"). The CP rejects
`autoUpgrade: true` for a daemon without the feature with 409, so an API caller cannot set
a switch nothing will honour.

## 4. Announcing the release

### 4.1 The CP side

Today the resolver refreshes lazily: `get()` starts a fetch only when a console read finds
the cache stale (30 minutes on a stable channel, 2 minutes on `rc`). A CP nobody is
looking at never learns about a release. Two changes make it a source of pushes:

- **Background refresh.** `start()`/`stop()` arm a Clock-driven loop, like
  `CronRunReaper`, that refreshes every 5 minutes on a stable channel and every 2 on `rc`.
  The container starts it in `startBackground()`; tests drive it with `FakeClock`. The
  lazy path in `get()` stays for the console.
- **Change notification.** `onChange(listener)` fires when the channel's version differs
  from the last one seen, including the first resolution after a cold start.

On a change, each CP replica sends

```ts
config/push { keys: { 'upgrade.latest': { channel: 'latest', version: '1.41.0' } } }
```

to every daemon in its own `ConnectionRegistry.reachableDaemons()` that is READY and
advertises `daemon-auto-upgrade-v1`. The push goes to those daemons whether or not their
switch is on, so turning it on later needs no extra delivery. A daemon's connection lives
on exactly one replica, so no daemon receives a replica's push twice and no coordination
between replicas is needed.

`register/ok` carries the same value as `release: { channel, version }` whenever the
resolver has one. A push lost to a dropped connection is therefore repaired by the
reconnect, and a CP restart re-announces on its first resolution.

Pushes are one small EVT per daemon per release, and only when the dist-tag moves. The CP
does not poll daemons, track their idleness, or open lifecycle operations on its own
initiative.

The release is a fact, not configuration, but `config/push` is still the right carrier.
The daemon's tolerant reader already handles it, and `mergeConfigPush` reports an unknown
key as ignored rather than failing. An older daemon therefore needs no feature gate, and
the auto-upgrade keys are routed to the `AutoUpgrader` instead of being merged into
`cfg`.

### 4.2 The daemon side

The daemon keeps one **announced target**: the latest `upgrade.latest` it received,
persisted locally so it survives a restart during a CP outage. Each announcement replaces
the previous one:

- a version strictly greater (semver) than `DAEMON_VERSION`, not in the local skip list
  (§6.3), becomes the **candidate**;
- anything else clears the candidate. This includes an announcement that moves _back_, as
  when a bad release's dist-tag is retracted. A staged but not yet switched version is
  abandoned, so retagging npm stops a rollout within one refresh interval. The daemon never
  downgrades.

## 5. The daemon's auto-upgrader

A new `AutoUpgrader` in `packages/daemon/src/lifecycle/` runs while the switch is on, the
daemon is eligible, and a candidate exists. It shares admission, drain, and exit with
`FleetUpgradeCoordinator`, so a CP-commanded operation and an automatic one cannot run at
the same time. It re-evaluates on each announcement, turn end, background-lease change,
and a 5-minute timer for retries.

### 5.1 Rollout spread

A bad release must not reach every enabled daemon in the same few minutes. When a version
first becomes the candidate, the daemon records `firstSeenAt` and waits a deterministic
delay before acting:

```text
delay = hash(daemonId, version) mod spread
```

`spread` is 2 hours when the announced channel is stable and 0 on `rc`. Hashing the version
as well as the daemon id means one daemon is not always first. The delay is a floor; the
idle requirement usually adds more.

### 5.2 Stage

Once the delay has passed, the daemon runs `agentconnect version install <version>` while
it keeps serving. Install resolves that exact version in the CLI's configured registry,
verifies integrity and the Node engine, and extracts without switching `current`. Any later
step at the idle moment is then local and fast. Registry choice stays local to the CLI, as
cli-daemon-split.md §2.1 requires; the CP supplies only a version string.

Failures:

- an engine mismatch adds the version to the skip list with reason `engines`, so the host
  does not download it again;
- "does not exist in the registry" — a private mirror that has not synced yet — and network
  errors retry on the 5-minute timer with backoff capped at 1 hour.

### 5.3 Wait for an idle window

The daemon is **quiescent** when all of these hold:

- no in-flight turn (`pending` is empty), including turns waiting on a permission or
  elicitation answer;
- no live background-task lease and no SDK session in `running`;
- no lifecycle operation is in flight and the daemon is not draining;
- the last turn ended at least 5 minutes ago (`quietMs`).

The quiet period keeps the restart out of a back-and-forth conversation.

### 5.4 Upgrade

When the daemon is quiescent and the candidate is staged:

1. **Reserve** — send `daemon/lifecycle/begin` to the CP (§6). If the CP answers
   `conflict`, another lifecycle operation is pending; back off to the next evaluation.
   If the CP is unreachable or does not advertise the frame, proceed without an operation
   record.
2. **Prepare and switch** — write the trial marker (§7.1), then run the existing
   `agentconnect upgrade --to <version> --root <root>`. That runs the target's
   `prepare-upgrade` and switches `current`. The daemon keeps serving and reports
   `preparing`.
3. **Re-check** — preparation may have taken long enough for new work to arrive. If the
   daemon is still quiescent, report `restarting`. Otherwise wait for quiescence for up to
   10 minutes.
4. **Exit** — drain through the shared path and exit with `RESERVED_RESTART_CODE`. The
   supervisor starts the new `current`.

If step 3's wait lapses, the daemon runs `agentconnect version use <previous>`, removes the
trial marker, and reports `failed` with reason `busy`. The CP records the operation as
deferred (§6), and the next idle window tries again with the version already on disk. This
keeps the invariant that an automatic upgrade never interrupts a turn.

A busy daemon can therefore stay behind indefinitely. The console shows that a daemon with
auto-upgrade on is waiting for an idle window (§8), and the owner can still upgrade
manually.

## 6. Control Plane record

The CP shows progress and keeps automatic and manual operations from overlapping. A new
acknowledged daemon request opens the operation:

```ts
// D→C REQ, READY only; reply DaemonLifecycleBeginOk or error CONFLICT
const DaemonLifecycleBegin = z.object({
  op: z.literal('upgrade'),
  trigger: z.literal('auto'),
  fromVersion: z.string(),
  targetVersion: z.string()
})
const DaemonLifecycleBeginOk = z.object({ operationId: z.string() })
```

The CP:

- opens a `DaemonLifecycleOp` row with `trigger = auto`, `initiator = null`, the current
  connection epoch as `commandEpoch`, and `acceptedAt = now` — the daemon is both sender
  and acceptor, so the row is armed at once;
- answers `CONFLICT` when the partial unique index already holds a pending row;
- uses a deadline of preparation budget plus the 10-minute idle wait plus relaunch, 30
  minutes in total;
- settles it through the existing paths: `daemon/lifecycle/progress`, READY on the target
  version, or deadline expiry.

A `failed` progress report with reason `busy` settles the row with the new status
`deferred`. The console's lifecycle badge ignores `deferred` rows, and a daily sweep
deletes deferred rows older than 7 days.

A manual upgrade or restart stays available while auto-upgrade is on. It receives 409 while
an automatic operation is pending, as it does for any pending operation today. A manual
upgrade to a version older than the announced release turns `autoUpgrade` off in the same
transaction; otherwise the daemon would upgrade itself again at the next idle window. The
upgrade modal says so before the owner confirms.

## 7. Failure and rollback

A remote upgrade today has no automatic rollback once the old daemon exits
(cli-daemon-split.md §6.2). Unattended upgrades need one, because nobody is watching when
the restart happens.

### 7.1 Trial marker

Before switching `current`, the daemon writes `<root>/upgrade-trial.json`:

```json
{ "from": "1.40.2", "to": "1.41.0", "operationId": "…", "startedAt": "…", "failures": 0 }
```

The new daemon deletes the marker when it first reaches READY. Reaching READY is the
success signal, as it already is for CP-commanded upgrades.

### 7.2 Who rolls back

Only definite failures roll back. A CP outage is not one: the daemon is local-first, and
"never reached READY because the CP is down" must not undo a good upgrade.

| Failure                                                                                     | Detected by       | Action                                                              |
| ------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------- |
| The new daemon exits non-zero, not `RESERVED_RESTART_CODE`, within the startup window       | CLI run shell     | count it in the marker; on the third, `version use <from>`, respawn |
| The CP authenticates the new daemon but rejects `register` with a non-retryable error twice | new daemon itself | `version use <from>`, exit `RESERVED_RESTART_CODE`                  |
| The CP or network is unreachable                                                            | —                 | none; the marker stays until the first READY                        |

The run-shell row requires a CLI that knows the marker; an older CLI ignores the file and
behaves as today. The daemon advertises `daemon-auto-upgrade-v1` regardless; CLI step 1
of §9.1 ships first, so most hosts already have it by the time daemons can auto-upgrade.

### 7.3 Skip list

A rollback records the version in `<root>/auto-upgrade.json` under `skipped` with its
reason. The upgrader never targets a skipped version again; a newer announcement
supersedes it. A manual upgrade to a skipped version removes it from the list.

After rolling back, the old version reaches READY. If it finds a rollback record whose
`operationId` is still pending, it reports
`daemon/lifecycle/progress { phase: 'failed', reason: 'rolled back: <reason>' }`, and the
console shows the failure.

## 8. Console

On the daemon detail view, settings section:

- an **Auto-upgrade** switch for owners when `daemon-auto-upgrade-v1` is present, and a
  disabled switch with the reason otherwise;
- the existing lifecycle badge reads "Auto-upgrading to v1.41.0" for a pending `auto`
  operation;
- below the switch, the last automatic outcome ("Upgraded to v1.41.0 2 h ago", "v1.41.0
  rolled back: crashed on start") from the DTO's `lastAutoUpgrade`, and "Waiting for an
  idle window" while the switch is on, an update is available, and nothing is pending.

The fleet list shows a small auto-upgrade indicator next to the version. The desktop and
mobile branches of `DaemonDetailView` both get the switch.

## 9. Changes by package

**protocol**

- `DAEMON_AUTO_UPGRADE_FEATURE = 'daemon-auto-upgrade-v1'`;
- `DaemonLifecycleBegin` / `DaemonLifecycleBeginOk`, and a CP feature flag the daemon
  checks before sending them;
- `register/ok` fields `autoUpgrade` and `release`, and the `config/push` keys
  `upgrade.auto` and `upgrade.latest`. The daemon reads CP frames with the tolerant
  reader, so an older daemon ignores all of them.

**control-plane**

- `DaemonReleaseResolver`: background refresh with `start()`/`stop()`, and `onChange`;
- the release broadcaster: on change, push `upgrade.latest` to this replica's READY,
  feature-advertising daemons; include `release` in `register/ok`;
- migration: `daemon.autoUpgrade`, `daemon_lifecycle_op.trigger` (`manual` | `auto`,
  default `manual`), and the `deferred` value of `DaemonLifecycleOpStatus`;
- `PATCH /daemons/:id` accepts `autoUpgrade`, with an OpenAPI description update;
- the `daemon/lifecycle/begin` WS handler, the manual-downgrade rule (§6), and the
  deferred-row sweep;
- DTO fields `autoUpgrade`, `autoUpgradeSupported`, and `lifecycleOp.trigger`.

**daemon**

- `AutoUpgrader` (announced target, spread, stage, quiescence, upgrade, revert);
- a quiescence signal over `pending`, the SDK lease map, and the last turn end;
- trial-marker cleanup on READY, the register-rejection rollback, and rollback reporting;
- feature advertisement and persistence of the setting and the announced target.

**cli**

- the run shell's trial-marker crash counting and rollback.

**web**

- the switch, badge, last-outcome line, and fleet-list indicator.

### 9.1 Delivery order

1. CLI: trial-marker rollback. Nothing writes the marker yet.
2. Protocol and CP: resolver refresh and broadcast, switch storage and delivery, the begin
   handler, and the DTO. The switch stays hidden because no daemon advertises the feature.
3. Daemon: `AutoUpgrader` and feature advertisement.
4. Web: the switch and status.

Each step is safe to ship alone, and the feature appears only when steps 2–4 are deployed.

### 9.2 Tests

- CP unit with `FakeClock` and a stubbed fetch: the resolver refreshes without reads,
  `onChange` fires once per version change (including cold start), and the broadcaster
  pushes only to READY, feature-advertising daemons on its own registry.
- CP integration: `register/ok` carries the release, the begin handler conflicts with a
  pending manual operation, operations settle on READY, `busy` maps to `deferred`, the
  manual-downgrade rule holds, and PATCH is rejected without the feature.
- Daemon unit with a fake clock and a stubbed CLI runner: never acts without the switch or
  while busy, respects the quiet period and spread, drops a staged candidate when the
  announcement moves back, reverts `current` when the idle wait lapses, skips
  engine-incompatible and rolled-back versions, and does not roll back while the CP is
  unreachable.
- CLI unit: crash counting and rollback, including that `RESERVED_RESTART_CODE` exits and
  signals do not count.

## 10. Extension points

- **Pause or ceiling.** Because the CP is the only announcer, a deployment-wide hold is a
  CP setting that announces `null` or a capped version; daemons need no change.
- **Maintenance window.** A per-daemon `autoUpgradeWindow` (cron-style local hours)
  becomes one more quiescence condition.
- **Org default.** New daemons inherit an org-level default for the switch.

## 11. Open questions

1. **Host-side veto.** Should `config.json` accept `upgrade.auto: false` that overrides the
   console, for hosts whose operator wants to keep version changes in their own hands?
   Adding it later is backward compatible.
2. **Quiet period and spread defaults.** 5 minutes and 2 hours are guesses. Busy shared
   daemons may need a longer quiet period to avoid restarting between two users' turns.
