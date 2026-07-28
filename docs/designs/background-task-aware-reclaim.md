# Background-Task-Aware ACP Host Reclamation

**Status:** Implemented for Claude runtimes that emit the required SDK lifecycle
events. Other runtimes use the ordinary idle-timeout behavior.

## 1. Contract

Returning from `session/prompt` marks the end of a user turn. It does not prove
that every task started by the runtime has finished. The daemon therefore keeps
an in-memory event lease for background tasks and runtime-initiated follow-up
cycles. Automatic idle reclamation must not stop an ACP host while that lease
reports live work.

The lease protects automatic idle cleanup only. Explicit shutdown, agent
removal, configuration replacement, and the absolute host-lifetime safeguard
may still stop the host and its background work.

## 2. Lifecycle Signal

For Claude sessions, [`claudeSessionMeta()`](../../packages/daemon/src/acp/acp-host.ts)
requests a filtered `_claude/sdkMessage` stream containing only these system
event subtypes:

- `session_state_changed`
- `background_tasks_changed`
- `task_started`
- `task_updated`
- `task_notification`

The filter is intentional: the daemon does not request the unfiltered SDK
message stream. `AcpHost` receives the extension notification from its connected
local ACP runtime and passes the opaque message to the daemon. The daemon accepts
only `type: "system"`, a known subtype, and fields of the expected primitive
shape. Unknown or malformed messages are ignored.

These notifications are trusted lifecycle signals because they come from the
daemon-owned ACP connection, not from a chat message or a control-plane
instruction. They remain daemon-local and never traverse the daemon-control
plane WebSocket.

## 3. Lease State

The daemon stores one lease per ACP session:

```text
{
  agentId,
  tasks: Map<taskId, { description?, isSubagent }>,
  sdkState: "idle" | "running",
  bgWakes  // wakes already spent on this session, see §5.1
}
```

[`onSdkLifecycle()`](../../packages/daemon/src/daemon.ts) applies these
transitions:

| Event                      | Lease update                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `task_started`             | Add or replace the task record. A non-empty `subagent_type` marks it as an internal subagent.                                |
| `task_notification`        | Settle the tracked task.                                                                                                     |
| `task_updated`             | Settle the tracked task when `patch.status` is `completed`, `failed`, or `killed`.                                           |
| `background_tasks_changed` | Settle tracked tasks absent from the current snapshot. Surviving tracked records keep their descriptions and subagent flags. |
| `session_state_changed`    | Accept `idle` or `running` as the top-level SDK cycle state.                                                                 |

Settling deletes the task before any notification is sent, so overlapping
terminal events cannot announce the same task twice. A background-task snapshot
repairs missed completion edges for tasks already observed through
`task_started`; it does not synthesize records for previously unseen tasks.

A session is SDK-quiescent when:

```text
tasks.size == 0 && sdkState == "idle"
```

No lease means quiescent. Host reclamation separately requires that the daemon
has no foreground prompt pending for the agent.

### Logical waiting state

The lease adds a logical waiting condition after a foreground turn:

```text
prompting -- turn returns, lease not quiescent --> waiting
waiting   -- lease becomes quiescent          --> idle-eligible
prompting -- turn returns, lease quiescent     --> idle-eligible
```

`waiting` is not a persisted `SessionRecord.state`. The stored row returns to
`idle` when the foreground turn finishes, while the lease exemption supplies the
waiting behavior for session closure, host reclamation, and secret-file cleanup.
This keeps ordinary session routing unchanged without confusing an idle
human-facing turn with a quiescent runtime.

## 4. Idle and Lifetime Safeguards

[`sweepIdle()`](../../packages/daemon/src/daemon.ts) applies three independent
guards:

1. An idle session older than `agentIdleTimeoutMs` is closed only when its lease
   is quiescent.
2. An ACP host older than the idle window is reclaimed only when it has no
   foreground prompt and no live SDK work.
3. If an otherwise idle-eligible host still reports SDK work after
   `agentMaxLifetimeMs` from host start, the daemon logs a warning and
   force-reclaims it. A hung task cannot pin the child process indefinitely.

The defaults in
[`config-schema.ts`](../../packages/daemon/src/config/config-schema.ts) are:

| Setting              |    Default | Purpose                                                        |
| -------------------- | ---------: | -------------------------------------------------------------- |
| `agentIdleTimeoutMs` | 15 minutes | Close inactive sessions and reclaim genuinely idle hosts.      |
| `agentMaxLifetimeMs` |    6 hours | Bound lease-based reclaim deferral for an otherwise idle host. |
| `idleSweepMs`        | 60 seconds | Re-evaluate session and host eligibility.                      |

The maximum lifetime does not preempt an active foreground prompt: the pending
turn guard runs before the lifetime check. When the daemon does choose to stop a
host, normal ACP child teardown applies and outstanding background work may be
terminated.

The same pending-turn and live-lease checks protect idle removal of materialized
config-file secrets. Once the agent is quiet, those files may be removed after
`configFilesIdleMs` and are materialized again before the next turn.

## 5. Completion Notifications

When a tracked non-subagent task settles, the daemon may post:

```text
🔔 Background task finished: <description> (<status>)
```

Delivery follows these rules:

- The effective output mode must be `medium` or `high`.
- The session must still exist and must not be closed.
- A usable integration connection must be available.
- Internal subagents never produce this notification.
- `task_updated` can supply a terminal status; a completion edge without a
  status uses the description alone.

The message is daemon-authored system output, not an agent reply, so it has no
agent-attribution footer.

The runtime's own unsolicited follow-up narration is not routed when no
foreground turn is pending. This is not a stylistic choice — `onAcpUpdate`
returns early on `!pending`, so **every** content-bearing update from such a
cycle (message chunks, tool renders, transcript rows, the webchat sink) is
discarded. Its MCP tool calls are unaffected: that socket is not `Pending`-gated,
so side effects a self-drain performs — including a `sendMessage` report — do
land. §5.1 depends on both halves of this.

### 5.1 Waking the session

The notification above tells the human. The model needs the completion too.

`run_in_background` promises the model that it "will be notified when the task
completes" — a **harness** guarantee, not an SDK one. Interactive Claude Code
re-invokes the model when the task exits. Under ACP the foreground turn has
already returned `end_turn` by then, so nothing delivers the result: the model
reasonably ends its turn expecting a notification, and any obligation riding on
that task (a `needsParentReply` report to a parent session, a deferred answer to
the human) is silently dropped.

The daemon therefore delivers it, as a new turn into the same session:

- The turn is `source: "agent"` with sender `background-task:<task_id>`. Its text
  states plainly that it is a daemon notification rather than a message from
  anyone, names the task id to read output from, says that THIS turn is the one
  actually delivered, tells the model not to repeat a report it already sent after
  the task finished, and permits silence when the result needs no action.
- It carries **no** `CallMeta`. It is not an agent call and must not look like
  one. A child woken this way still reaches its parent, because
  `replyToSession` authorizes against the origin persisted on the session
  (session-concept §5.3) and `needsParentReply` is sticky.
- `msgId` is `bgtask:<channel>:<task_id>` — stable in the task id, so a
  duplicated settle edge cannot dispatch the wake twice. `transcriptTs` is a
  monotonic "now" so the wake orders as new content.
- The reply transport is resolved from the **session's** transport scope, not the
  agent's default integration.

The wake is armed on a `BG_TASK_WAKE_GRACE_MS` (4s) delay and every precondition
is re-checked when it fires, never captured when it is armed:

| Condition at fire time      | Behavior                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| No lease                    | Host was reclaimed; the ACP session is gone. Skip.                                        |
| `sdkState == "running"`     | The runtime's self-drain cycle is in flight. **Re-arm**, up to `MAX_BG_TASK_WAKE_REARMS`. |
| `tasks.size > 0`            | Another task is still live; its completion carries the session forward. Skip.             |
| Session missing or not idle | Closed, or a real turn is already running and will observe the task. Skip.                |
| Budget exhausted            | Warn and skip (see below).                                                                |

The `running` case is a **wait, not a stand-down**. The self-drain cycle delivers
nothing (see §5), so treating it as the delivery is what strands the session; the
wake only defers to it so an injected turn does not race the runtime's own work,
then delivers regardless. `MAX_BG_TASK_WAKE_REARMS` (15, ≈1 minute) bounds that
wait so a cycle that never returns to `idle` is not polled forever.

Observed sequence for a `sleep 30` in `run_in_background` (Claude
claude-agent-acp 0.63.0), which is what this design is calibrated against:

```text
task_started {t}
session_state_changed {idle}        # turn returned end_turn, task still live
background_tasks_changed {live: 0}  # settles the task (arrives first)
task_updated {completed}            # already settled — deduped
task_notification                   # already settled — deduped
session_state_changed {running}     # runtime's self-drain cycle
session_state_changed {idle}        # ...which produced nothing observable
```

Internal subagent tasks never wake a session — the SDK joins them itself.

Unlike an agent call, a wake carries no `hopCount` to bound, and a woken turn may
start further background tasks. `MAX_BG_TASK_WAKES_PER_SESSION` (20, counted over
the lease's life) is therefore the only backstop against a self-feeding loop;
exhausting it logs a warning and leaves the completion undelivered.

A wake is **not** gated on output mode. The channel notification in §5 is for the
human and stays gated at `medium`; the wake is for the model and must happen at
every output mode, including `low` and `none`.

## 6. Fallback and Runtime Limits

The current lease depends on the filtered Claude SDK lifecycle stream:

- A non-Claude runtime, an adapter without the extension, or a session that
  emits no accepted lifecycle messages has no lease and uses ordinary
  idle-timeout reclamation.
- Arbitrary child processes that the runtime does not represent as lifecycle
  tasks are not protected by the lease.
- A missed `task_started` event is not recovered from
  `background_tasks_changed`; the snapshot only settles already tracked tasks.
- A lease that never receives a terminal edge remains protected only until the
  absolute host-lifetime safeguard applies.

The daemon does not currently infer background work by walking the operating
system process tree. Such inference cannot reliably distinguish agent work from
long-lived runtime infrastructure such as stdio MCP servers, and it is not part
of this contract.

## 7. Locality and Cleanup

Lease records live only in daemon memory. Stopping a host removes all leases for
that agent so stale task state cannot defer a future child. TTL-closing an idle
session removes its lease, and unknown lifecycle events do not create durable
state.

The control plane receives neither the lifecycle stream nor task descriptions.
Only the optional platform notification leaves the daemon, through the
session's existing delivery integration.
