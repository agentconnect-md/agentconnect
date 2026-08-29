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

The daemon stores one lease per **(agent, ACP session)** — keyed by `sdkLeaseKey`,
never by the session id alone. ACP session ids are runtime-local, so two agents
can each expose an `acp-1`; a shared entry would let one agent's task overwrite
the other's record under a colliding task id, suppress its completion wake
through `tasks`/`sdkState`, or spend its wake budget.

```text
{
  agentId,
  tasks: Map<taskId, { description?, isSubagent }>,
  sdkState: "idle" | "running",
  bgWakes,         // wakes already spent on this session, see §5.1
  armedWakes,      // wake timers armed or deferred, see §5.1
  deliveringWakes  // wake dispatches in flight, see §5.1
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
tasks.size == 0 && armedWakes == 0 && deliveringWakes == 0 && sdkState == "idle"
```

No lease means quiescent. Host reclamation separately requires that the daemon
has no foreground prompt pending for the agent.

`armedWakes` is part of the predicate because settling a task removes it from
`tasks` **before** its completion wake is armed (§5.1). Without it, a task that
outlived the session's idle TTL would leave the session quiescent for the whole
grace window, and a sweep landing there would close the session and drop the
lease — losing exactly the completion the wake exists to deliver. `deliveringWakes`
extends the same fence past the injected dispatch, until the woken turn is itself
visible to the sweep; §5.1 covers why both counters exist separately.

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

## 5. Completion Delivery

A settle edge posts nothing to the channel by itself. The completion reaches
the human through the model's own words — the drain-cycle narration (§5.2)
when the runtime produced one, or the wake turn's reply (§5.1) when it did
not. An earlier daemon-authored "🔔 Background task finished" notice was
retired once both paths existed: every post-turn settle is covered by them,
and the notice had become a worse restatement of the narration that followed
it seconds later. A wake-turn model that stays silent is the model judging
that nothing is owed — the same judgment the no-response sentinel already
trusts.

One rule gates both paths at the settle edge: a task that settles inside the
session's own live foreground loop — a `running` SDK cycle with a pending
dispatch — arms no wake. The runtime hands the result to the model in that
loop and the turn's own chrome already shows the step; auto-backgrounded
commands (sleeps, watchers) settle this way every time. Both conditions are
required: `running` without a pending dispatch is a self-drain cycle (§5.2),
and a pending dispatch past `idle` is finalization the model has already left.

A drain cycle's non-text updates (tool renders, the webchat sink) are still
not routed, and its MCP tool calls still land: that socket is not
`Pending`-gated, so side effects a self-drain performs — including a
`sendMessage` report — do land. §5.1 and §5.2 depend on these halves.

### 5.1 Waking the session

The model needs the completion delivered into a turn it can act from.

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
  anyone, names the task id to read output from, carries the runtime's own
  completion summary when `task_notification` supplied one, says THIS turn is
  the one actually delivered, and permits silence when the result needs no
  action. A completion the drain narration already covered never reaches this
  text — its wake is skipped at fire time (§5.2).
- It carries **no** `CallMeta`. It is not an agent call and must not look like
  one. A child woken this way still reaches its parent, because
  `replyToSession` authorizes against the origin persisted on the session
  (session-concept §5.3) and `needsParentReply` is sticky.
- `msgId` is `bgtask:<channel>:<task_id>` — stable in the task id, so a
  duplicated settle edge cannot dispatch the wake twice. `transcriptTs` is a
  monotonic "now" so the wake orders as new content.
- The reply transport is resolved from the **session's** transport scope, not the
  agent's default integration.

No wake is armed for a task that settled inside the session's own live
foreground loop (§5) — the loop already delivered the completion to the model.
The wake is armed on a `BG_TASK_WAKE_GRACE_MS` (4s) delay and every precondition
is re-checked when it fires, never captured when it is armed:

| Condition at fire time      | Behavior                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| No lease                    | Host was reclaimed; the ACP session is gone. Skip.                                        |
| Another timer still armed   | Several tasks settled on one edge; the last one delivers for all. Skip.                   |
| `sdkState == "running"`     | The runtime's self-drain cycle is in flight. **Re-arm**, up to `MAX_BG_TASK_WAKE_REARMS`. |
| `tasks.size > 0`            | Another task is still live; its completion carries the session forward. Skip.             |
| Drain covered this settle   | `drainDeliveredAt` ≥ this task's settle: the narration already said it (§5.2). Skip.      |
| Budget exhausted            | Warn and skip (see below).                                                                |
| A turn is in flight         | **Defer** — retry this attempt once the active dispatch settles.                          |
| Session missing or not idle | Closed. Skip.                                                                             |

Coalescing and deferring are **not** the same case, and conflating them loses
results:

- **Another timer still armed** is safely coalescible because none of those wakes
  has run yet — an empty `background_tasks_changed` snapshot settles every task on
  one edge, arming a timer each, and all of them then see an empty `tasks`. One turn
  covers them all.
- **A turn is in flight** is not. `sdkState` is already `idle` by this point, so
  `host.prompt()` has returned and the model cannot observe the task in-turn — yet
  the dispatch stays pending through renderer/finalization. Folding the new
  completion into that finishing delivery discards it permanently. So the wake
  defers instead: it retries the same attempt once
  `activeDispatchDoneByKey` for the session resolves, holding a fence slot across
  the hand-off. Aggregate progress is bounded by the wake budget, which caps
  deliveries.

The fence is two counters, and every outcome releases exactly one slot:

| Counter           | Taken                    | Released                          |
| ----------------- | ------------------------ | --------------------------------- |
| `armedWakes`      | arming a timer / a defer | that timer firing                 |
| `deliveringWakes` | just before `dispatch()` | when the dispatch promise settles |

The two are separate precisely so the coalescing decision above can tell "armed"
from "delivering". Re-arm and defer take the replacement slot **before** releasing
the current one, so the total never dips to zero while a completion is owed.

Delivery releases at dispatch-promise settle — turn completion, not admission.
Releasing at dispatch time is not enough: `dispatch()` claims the serial gate
synchronously, but `dispatchOne` then awaits thread history, attachments, and
managed-memory recall before `SessionManager` writes `state = 'prompting'`. Through
that window the row is still `idle` and has no `Pending`, so an already-expired
session would read quiescent and a sweep landing there would TTL-close it and stop
the host mid-initialization.

A wake turn that never settles keeps the fence indefinitely; the absolute
`agentMaxLifetimeMs` ceiling (§4) remains the backstop, as it is for a hung task.

The `running` case is a **wait, not a stand-down**. A self-drain cycle may
produce nothing observable (its narration, when any, is delivered by §5.2), so
treating it as the delivery is what strands the session; the wake only defers to
it so an injected turn does not race the runtime's own work, then delivers
regardless. `MAX_BG_TASK_WAKE_REARMS` (15, ≈1 minute) bounds that wait so a
cycle that never returns to `idle` is not polled forever.

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

A wake is **not** gated on output mode. It is for the model and must happen at
every output mode, including `low` and `none`.

### 5.2 Delivering the drain narration

When a task settles after the turn, the Claude runtime keeps its own
"you will be notified" promise in-process: it self-wakes a drain cycle and the
model narrates the completion there. That cycle has no `Pending`, so its updates
used to be discarded wholesale — the narration (often the very output the human
asked for) was lost, and the wake had to ask the model to say everything again,
which it does only probabilistically.

The daemon now captures that narration. While the lease reads `running` with no
pending dispatch, `agent_message_chunk` text accumulates on the lease (capped at
`MAX_DRAIN_TEXT_CHARS`); the `running → idle` edge — or the next real dispatch
for the session, whichever comes first — delivers it:

- Delivered as **agent speech**, with the agent's conversational identity
  (name, icon, author id) and a transcript row — not as a chrome notice: the
  model authored it.
- The no-response sentinel, a closed session, and `none` output mode keep their
  usual semantics (sentinel drops; `none` records without posting).
- Capture is gated on the lease saying `running`, so a straggler chunk after
  `idle` stays dropped and stale text can never leak into a later flush; a real
  dispatch claims the buffer synchronously before taking the session over.
- Deliveries spend the same per-session cap as wakes
  (`MAX_BG_TASK_WAKES_PER_SESSION`, counted separately), bounding a model that
  keeps self-continuing by starting new tasks from each drain — a loop the wake
  budget alone cannot bound, since drains need no wake to keep going.
- A drain with nowhere to deliver (no platform connection) keeps the old drop
  and does **not** stamp `drainDeliveredAt`, so the wake still asks for a full
  report.

The wake stays armed either way (§5.1) — a drain may narrate nothing — and reads
`drainDeliveredAt` at fire time: a wake whose settle the narration already
covered (delivered at-or-after that settle) is skipped, saving the model round
trip and the extra turn chrome; a drain that narrated nothing leaves the wake
to deliver as before.

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
