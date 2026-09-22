# Per-Conversation Session Mode

> Status: Implemented on the daemon and the Control Plane; the console control (§8) and the
> unbounded transcript read (§10) are still outstanding. `auto` remains reserved (§12).
> Scope: chat conversations that are channels, on every platform that has them, over
> both daemon-owned and relay-forwarded ingress.
> Primary implementation areas: `packages/protocol`, `packages/control-plane`,
> `packages/daemon`, `packages/web`

## 1. Summary

A conversation row in the console carries one operator choice today: **when** the agent
responds (`off` / `@-mention` / `any message`). It carries no choice about **which
session** an activation joins — that is hardcoded by the session key.

This design adds a second per-conversation setting, the **session mode**:

| Mode        | Meaning                                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createNew` | Default, today's behavior. A new message opens a new session; a reply inside a thread the agent already owns continues that thread's session.                         |
| `append`    | Every admitted message in this conversation — top-level or inside a thread — joins **one** long-lived session belonging to the conversation.                          |
| `auto`      | Reserved. A classifier would decide between continuing and opening a new session. Not implemented; the enum leaves room so the wire does not change again when it is. |

The trigger and the session mode are orthogonal: the trigger decides whether a message
activates the agent at all, the session mode decides which session the activation joins.

Both modes get `!new`, and it means the same thing to a user in both — "start over
here" — while doing something different underneath (§7): in `append` it mints a new
coordinate, in `createNew` it clears the current thread's session in place.

## 2. What exists today

### 2.1 The setting that is already there

- Stored on `IntegrationChannel.trigger`, a `ChannelTrigger` enum of `off | mention | any`
  — `packages/control-plane/prisma/schema.prisma` (`enum ChannelTrigger`, `model IntegrationChannel`).
- Edited through the per-conversation `PATCH` in
  `packages/control-plane/src/http/routes/integrations.ts`, which persists and then
  re-pushes the integration spec to the owning daemon.
- Projected by `integrationToSpec()` / `httpIntegrationToSpec()` in
  `packages/control-plane/src/orchestrator/placement.ts`, folded into the core envelope
  as `bindRules` (an `auto` rule per "any message" conversation) and `mutedChannels`
  (each `off` conversation).
- Read on the daemon by `integrationCore()` → `integrationRouting()`
  (`packages/daemon/src/platforms/integration-config.ts`,
  `packages/daemon/src/router/routing-rule.ts`).
- Rendered by `TriggerToggle` in `packages/web/src/components/console/IntegrationChannelList.tsx`,
  narrowed per platform through `channelListSemantics(platform).triggers`.

### 2.2 How a message picks its session today

`sessionKey(platform, channel, thread, agentId, transportScope)`
(`packages/daemon/src/store/local-store.ts`) is the identity. Its `thread` segment comes
from `transcriptCoords(msg)` (`packages/daemon/src/session/session-manager.ts`):

```
thread = msg.thread ?? msg.msgId
```

The current "create new" behavior is therefore not a policy — it falls out of the
coordinate. A top-level message has no `thread`, falls back to its own id, and keys a new
session; a reply inside a thread carries the thread's id and keys the session that thread
already owns. No branch has to be removed to keep this mode.

Three facts constrain the implementation.

**`msg.thread` does two jobs.** It is the session coordinate above _and_ the outbound post
target: `packages/daemon/src/daemon/turn-plan.ts` copies it into the turn plan's `thread`
(where platform turn output posts) and into `statusThread` (where turn chrome posts).
Rewriting it would send answers to a thread that does not exist.

**Thread context is read by the same coordinate.** `ThreadContextCoordinator.refresh()`
(`packages/daemon/src/session/thread-context.ts`) reads observed rows and the revision
fence by `(transcriptChannel, thread)`. A session whose transcript lives under a different
coordinate than its key would prompt with no history.

**One inbound message reaches several agents.** `onInboundOutcome` arbitrates one primary
through `routeRules` and then calls `fanOutToThreadPeers` for every other participating,
mentioned, or channel-`auto` agent (`packages/daemon/src/daemon.ts`, the fan-out loop
below the primary dispatch). The human path hands each target its own shallow copy of the
message; the agent-authored path shares one object and mutates it per target. So a field
stamped on the message at ingress cannot carry a per-agent answer — which is why §3.1
resolves the coordinate downstream instead.

## 3. The model

### 3.1 Session coordinate vs delivery coordinate

The two roles `msg.thread` plays are split:

- **Delivery coordinate** — `msg.thread`, untouched. Used by the turn plan, platform turn
  output, and the outbound `threadKeyForPost` strategies
  (`packages/daemon/src/platforms/thread-keys.ts`). An answer is always posted where the
  message that started the turn came from, in both modes.
- **Session coordinate** — resolved once per target, from
  `(agentId, msg, integrationId)`. In `createNew` it is `msg.thread ?? msg.msgId`, exactly
  as today. In `append` it is the conversation's current append coordinate (§3.2).

**Where resolution happens is load-bearing.** It cannot be at ingress: §2.2's fan-out means
one object reaches several targets, and in one channel agent A may be `append` while agent
B is `createNew`. It also cannot be inside `SessionManager.handle`, because by then the
session key has already been used — the durable inbox lane is keyed by it
(`inbox_fifo (sessionKey, enqueuedAt)`) and the per-session serial gate has been claimed
under it. A coordinate decided after admission would be a different coordinate from the one
the message was admitted on.

So it resolves in the one place that is both after routing has picked this target and
before anything is keyed on the result: the per-target step in the fan-out, on that
target's own copy of the message. That step already computes `sessionKey`-derived values
per target — the target's `muteKey` and `activationKey` are built there, from the target's
own transport scope rather than the observing connection's — so this is the same
resolution, one field wider. The resolved coordinate is then **carried** through the inbox
lane, the serial gate, the observer, the turn plan, and the session manager, never
re-derived by any of them.

`transcriptCoords()` therefore takes the resolved coordinate rather than deriving it, and
every session-side consumer reads the carried value: the session key, the local transcript
primary key, the thread-revision fence, the per-session serial queue, and the
active-session recency probe. Two sites need explicit correction because they currently
derive a coordinate of their own:

- `recordObservedInbound()` (`packages/daemon/src/daemon.ts`) matches an in-flight turn
  with `p.plan.statusThread === thread`, comparing a delivery coordinate against a session
  coordinate. The turn plan gains its own session coordinate and that comparison switches
  to it; `statusThread` stays the chrome target.
- `handleCommand()` (`packages/daemon/src/commands/handlers.ts`) derives
  `thread = msg.thread ?? msg.msgId` and keys the session from it. In `append` every
  command — `!stop`, `!cancel`, `/status`, `/models` — would key a session that does not
  exist and reach the right one only through the `latestSessionForTransport` fallback,
  which is luck rather than resolution. It resolves the append coordinate like any other
  caller. `replyThread`, which that function already keeps deliberately separate, is
  unchanged.

### 3.2 The append coordinate

The coordinate is **`(agent, channel, timestamp)`**, spelled `append:<epochMs>` in the
`thread` segment of the session key (which already carries the agent and the channel).
"Append" means: find the **largest** timestamp among this
`(agent, channel, transportScope)`'s append coordinates and join it; if there is none,
mint one.

**Why a timestamp and not a counter.** A counter has to be derived from something that
survives. Deriving it from session rows does not work: retention GC deletes session rows
after an idle window (§6.3) but deliberately leaves transcript rows behind, because those
are `(channel, thread)`-scoped and outlive any one session. A counter derived from rows
would reset to zero after a quiet period and mint `append:0` again — a coordinate whose
transcript is still sitting there, so the new session would inherit the retired
conversation's history. A timestamp needs no surviving state: the clock only moves
forward, so a coordinate minted after a purge is one that has never been used.

The same property answers what happens to a conversation that goes quiet past the
retention window: its session row, ACP session id, and worktree are gone, so its model
context is gone regardless. Minting a fresh coordinate reports that honestly instead of
presenting a continuation that cannot continue.

Two mechanics follow:

- **Mint monotonically**, `max(now, currentMax + 1)`, so a clock adjustment cannot make
  `!new` silently no-op by minting a timestamp below the current maximum. `monotonicTs()`
  in the session manager is the existing precedent.
- **The maximum lookup must not require an ACP session id.** `!new` writes a bare session
  row at the new coordinate, and a row that has never run a turn has no ACP id yet — so
  `latestSessionForTransport` (`local-store.ts`), which filters on
  `acpSessionId IS NOT NULL`, cannot serve this. `latestSessionForThread` next to it
  exists for exactly this reason: its comment records that it omits that filter "so a stop
  still reaches a turn that has not spawned yet".

The coordinate is a reserved shape, not a platform value, and cannot collide with a real
one — a platform thread id is a provider timestamp, a snowflake, or a numeric message id,
never `append:`-prefixed. It follows the precedent of Telegram's continuous-DM literal
`dm` in `thread-keys.ts`.

### 3.3 Resolve-or-reserve is one atomic step

"Find the largest, or mint one" is a read followed by a write, and two messages arriving
together in a conversation that has no append session yet would both read nothing and both
mint — two coordinates, two sessions, for one conversation. Deriving the maximum from
session rows has the same race against a concurrent `!new`.

The current coordinate therefore lives in its own reservation row, keyed
`(agentId, channel, transportScope)`, and is resolved by one atomic operation:

- **Resolve** — `INSERT OR IGNORE` a row carrying a freshly minted coordinate, then read
  the row back. Every concurrent caller converges on whichever insert won; nobody trusts
  the value it proposed. This is exactly the shape `mintOutwardId` already uses to mint a
  session's outward identity, and its reasoning transfers: the reservation "lands in its
  own table, never in a half-built `sessions` row".
- **Advance** (`!new`) — a compare-and-set from the coordinate the caller read to a newly
  minted one. **A caller that loses the CAS does not retry the advance.** It re-reads,
  sees a coordinate minted after its own read, and concludes that the rotation it wanted
  has already happened — so two `!new` commands issued simultaneously advance the
  conversation once, while two issued in sequence advance it twice, which is what each
  pair of users meant. Retrying would advance a second time and leave an orphan coordinate
  nobody ever posts into.

Both are portable across the two stores this runs on: `postgres-dialect.ts` rewrites
`INSERT OR IGNORE` to `ON CONFLICT DO NOTHING`, and a single-row CAS is an ordinary
conditional `UPDATE` in both dialects.

**A reservation can outlive what it names.** Retention deletes session rows and leaves
transcript rows behind (§6.3), so a reservation that survived its session would hand the
next message a coordinate whose transcript is still on disk — reintroducing exactly the
inheritance §3.2 chose a timestamp to prevent.

The cleanup belongs at the deletion, not at the resolve. **The reservation is cleared
inside `deleteSession`**, in the same transaction that removes the row, conditionally on
the reservation still naming the coordinate being purged — so a reservation a concurrent
`!new` has already advanced is left alone. That single site covers every case: the daemon
contains exactly one `DELETE FROM sessions`, inside `deleteSession`, and its only callers
are the retention sweep and the moved-agent purge, which share the same expiry rule.

**Resolve must not infer staleness from a missing session row.** The tempting safety net —
"a reservation whose coordinate has no session is stale, advance it" — is wrong, and
breaks the very case this section opens with. A reservation is created before admission
while its session row is written later, by the first message's turn or by `!new`; during
that ordinary window a reservation legitimately has no session. A second concurrent
resolver applying that rule would advance past it, splitting the two simultaneous first
deliveries it was supposed to join, or skipping the coordinate `!new` just minted.

So the reservation is authoritative on its own: a resolve reads it and nothing else, and
never consults the sessions table. That is also what keeps the coordinate resolvable
**before** admission, as §3.1 requires.

### 3.4 Decided semantics

- **Every admitted message joins the current coordinate**, top-level or in a thread. A
  conversation in `append` has exactly one live session per agent.
- **Answers post where the message came from.** The delivery coordinate is untouched, so
  an in-thread question is answered in that thread and a top-level one is answered the way
  that platform already answers one, including Discord's `materializeRootThread`. The
  visible conversation shape does not change; only which session remembers it does.
- **Mode is read per message.** Flipping the setting migrates nothing. Sessions from the
  `createNew` era live at ordinary thread coordinates, which are not append coordinates,
  so they are simply not candidates for the maximum — the first message after the flip
  mints a fresh coordinate rather than adopting whichever thread happened to be touched
  last.
- **The coordinate is per agent.** Two agents in one `append` channel keep separate
  sessions and separate coordinates, so `!new` addressed to one does not disturb the
  other. Every other command in the vocabulary resolves a target agent and acts on that
  agent's session; `!new` being the one room-wide command would let someone clearing one
  agent discard an uninvolved agent's long-running context. §6.2 covers what this costs.

## 4. Wire

`IntegrationCoreEnvelope` (`packages/protocol/src/frames/integration.ts`) gains one field
beside `mutedChannels`:

```ts
/** Per-conversation session mode; absent ⇒ `createNew`. Only conversations that
 *  depart from the default are listed. */
sessionModes: z.array(z.object({ channel: z.string(), mode: ChannelSessionMode })).default([])
```

with `ChannelSessionMode = z.enum(['createNew', 'append'])`.

- **Not a `bindRule`.** A relay-managed shared bot ships an empty `bindRules` array unless
  the owning agent is gated (`httpIntegrationToSpec()`), because the relay arbitrates
  activation. Session keying stays on the daemon in every mode, so this setting rides a
  field populated unconditionally — like `mutedChannels`, which ships for the same reason.
- **Sparse.** Only departures from the default are listed, so a large conversation list
  adds nothing to the common spec.
- **Old daemons ignore it, by design.** `IntegrationCoreEnvelope` is a non-strict
  `z.object`, so a daemon that predates the field strips it and keeps today's behavior,
  which is exactly `createNew`. No capability advertisement and no daemon-side feature
  flag: the default is inert, and the console offers the control unconditionally.

## 5. Control plane

- **Schema.** `enum ChannelSessionMode { createNew, append }` and
  `sessionMode ChannelSessionMode @default(createNew)` on `model IntegrationChannel`, plus
  a migration. Like `trigger`, it is replicated across a shared bot's sibling integration
  rows so deleting the canonical owner does not discard it.
- **Read path.** The channel DTO in `http/routes/integrations.ts` carries `sessionMode`
  beside `trigger`.
- **Write path.** The existing per-conversation `PATCH` accepts `sessionMode` under the
  same authorization as `trigger` and the same "persist, then push the recomputed spec"
  ordering. No new route.
- **Projection.** `integrationToSpec()` and `httpIntegrationToSpec()` both emit
  `sessionModes`, unconditionally — including for gated agents and relay-managed bots.
- **No `sessionModeChosen` flag.** `trigger` needs one because a stored `off` is
  indistinguishable from a default nobody decided, and the two need opposite treatment
  under visibility catch-up. Nothing in the visibility rules opens or closes a session
  mode, so the stored default is unambiguous.

## 6. Daemon

### 6.1 Resolving the coordinate

`integrationCore()` returns the new `sessionModes` and `integrationRouting()` exposes a
lookup. The per-target fan-out step resolves the coordinate for
`(agentId, msg, integrationId)` beside the `muteKey` and `activationKey` it already builds
there — `createNew` yields today's value, `append` performs the atomic resolve-or-reserve
of §3.3 — and puts it on the turn plan. Admission, the inbox lane, the observer, and
`SessionManager.handle` all read that carried value.

### 6.2 Transcript

Transcript rows for an `append` session are recorded under the **append coordinate**, not
under the message's physical thread. That is what makes the session's context read
coherent: the prompt path reads `(transcriptChannel, thread)`, and rows scattered across
the physical threads the conversation happens to use would be invisible to it.

Because the coordinate is per agent, two agents in one `append` channel do not share
transcript rows. Each still sees the whole conversation — including the other agent's
posts — but as its own rows under its own coordinate. `recordObservedInbound()` currently
writes one row with a single owner (`recipient ?? inFlightAgent ?? initializingAgent`);
for `append` conversations it writes one per agent holding a live append session there.

This gives up the same-store collapse that `transcript_recipient`
(`orgId, channel, thread, ts, agentId` — one text row, one recipient entry per agent)
exists to provide. That is a deliberate trade: the collapse is an optimization, not an
invariant, and the system already tolerates a conversation existing in several copies —
two agents in one channel may run on different daemons, each with its own local store, so
duplication across daemons is unavoidable whatever the coordinate looks like. What the
per-agent coordinate buys is that `!new` stays a per-agent command like every other one.

### 6.3 Consequences to handle

- **No provider backfill on an `append` session.** The snapshot reconciliation in
  `ThreadContextCoordinator.refresh()` fetches one provider thread's history. An `append`
  session's coordinate is synthetic and spans many threads, so there is no thread to fetch
  and importing one would misrepresent the conversation. The daemon passes no `snapshot`
  callback for such a session and the refresh degrades to the observed-only path it
  already supports.
- **`threadUrl`** is taken from the message that created the session, and keeps the
  existing first-non-null-wins rule. An `append` session has no single platform thread to
  link.
- **The observer uses the same coordinate.** `recordObservedInbound()` has no routed
  target, but it does resolve an owner agent, which is enough to resolve the coordinate.
  Without this, messages arriving mid-turn would be filed under the physical thread and
  the session's catch-up would never see them.
- **One serial queue per conversation.** Admission is serialized per session key, so the
  whole conversation shares one queue: a long turn delays every other message in that
  conversation rather than only its thread. This is inherent to the mode and is the main
  reason `createNew` stays the default.
- **`!stop` does not mute in `append`.** With one session per conversation, the `!stop`
  mute latch would silence the whole room until someone `@`-mentions. In `append`, `!stop`
  interrupts the in-flight turn and nothing else — behaviorally `!cancel`, with reply copy
  that says so. An `append` session ignores any mute latch left over from before the flip,
  and the way to silence the agent there is the `off` trigger in the console.
- **Context management stays the runtime's.** The daemon performs none: compaction is the
  runtime's, and the daemon only infers that it happened from a drop in reported usage
  (`COMPACTION_DROP_RATIO`), with nothing acting on usage approaching the limit. An
  `append` session's context degrades as the runtime compacts it, and `!new` is the reset.
  No daemon-side warning and no automatic rotation.
- **Retention clears the reservation with the session.** Retention GC deletes sessions
  idle past the configured window (default 7 days), taking the ACP session id and the
  worktree, and leaves transcript rows behind. For an `append` conversation it also clears
  the reservation row naming the purged coordinate, inside `deleteSession` itself and
  conditionally on it still naming that coordinate (§3.3) — otherwise the next message
  would rejoin a coordinate whose session is gone but whose transcript is not. An actively
  used `append` session is never a GC candidate; a conversation quiet past the window loses
  its session and the next message mints a fresh coordinate.
- **Thread affinity and peer fan-out need their own record** — see §6.4. This is the one
  place `append` does not leave activation alone.
- **Unaffected.** The trigger, gating, and mute fences all key on `channel`, never on a
  thread coordinate, and an agent still does not respond to another bot's message unless
  mentioned. Memory scope is already per channel.

### 6.4 Thread affinity and peer fan-out

Two routing lookups find agents by querying **session rows with the physical thread**:

- `SessionManager.threadOwner(channel, thread, scope)` → `store.openSessionAgents(...)`,
  falling back to `closedSessionAgents(...)`. This is mention-mode continuity: exactly one
  agent owning the thread means an unmentioned follow-up still reaches it; two owners are
  ambiguous and fall back to mention-gating.
- `SessionManager.threadParticipants(channel, thread, scope)`, which supplies the
  `participants` set that `conversationPeers` turns into the peer fan-out.

An `append` session's row carries the synthetic coordinate, so both lookups return nothing
for the physical thread the message actually arrived in. Two regressions follow, and the
second is worse than a regression:

- **Continuity.** A mentioned agent answers in a thread; the next reply in that thread,
  without a mention, finds no owner and does not route. Today it does.
- **Peer fan-out.** `threadParticipants` returns empty, so there are no peers — and peer
  fan-out is the mechanism that delivers a message to the _second_ agent in a channel. The
  decision in §3.4 that two agents keep separate sessions while still seeing each other
  depends on it.

The cause is the one §3.1 already names, one level up: the session row is doing two jobs.
It is the session, and it is the record that _this agent is active in this physical
thread_. `createNew` can conflate them because a session **is** a thread. `append` separates
them, so the second job needs its own record:

**A thread participation record**, keyed `(channel, physicalThread, agentId, transportScope)`,
written when a message is delivered to an agent in a thread and when the agent posts into
one. `threadOwner` and `threadParticipants` read it instead of the sessions table. Whether
a listed agent is live or dormant — the distinction `openSessionAgents` /
`closedSessionAgents` draws today — is then decided by resolving that agent's current
session through its own mode, rather than by which query found the row.

It is written in **both** modes, so there is one code path rather than a mode branch in the
routing ladder. In `createNew` it carries exactly the same information as the session rows
it replaces, which is what makes it a safe substitution to verify: the existing continuity
and fan-out tests must pass unchanged against it before `append` uses it for anything.

## 7. `!new`

### 7.1 In `append`: mint a new coordinate

`!new` advances the reservation row by compare-and-set (§3.3). Nothing else is written: the
reservation is the authoritative source (§3.3) and no resolver consults the sessions table,
so a bare row would serve nobody. The retired session keeps its row, its outward id, its CP
metadata, and its transcript; the conversation simply stops adding to it, and it ages out
through ordinary retention. Nothing is destroyed, and the successor's runtime session is
born lazily, on the next message.

Work already ADMITTED stays on the retired coordinate: it was resolved at ingress, so a
running turn and anything queued behind it finish where they were admitted. That is the same
rule §7.3 states for the in-flight turn, extended to the queue behind it, and it is why the
reply says new messages rather than the next message.

A session-isolated agent gets a **new workspace** with the new session, since workspace
isolation is pinned when a logical session is created. That is the intended reading of
`!new` in this mode: the previous stretch of work is finished, including its working tree.

### 7.2 In `createNew`: clear the thread's session in place

Here there is no coordinate to rotate — the session belongs to the thread, and the thread
is not going anywhere. `!new` means what `/clear` means: the session keeps its key,
coordinate, outward id, and workspace, and loses its context.

The primitive already exists and is exercised twice in `SessionManager.handle` — once when
a session's memory provider changes and once on a forced workspace-isolation change. Both
write the same two fields on the existing row: `acpSessionId: null` and
`lastDeliveredTs: null`. The next turn then builds a fresh runtime session through
`runtime-session.ts`.

`!new` deviates in exactly one field. Those two call sites null `lastDeliveredTs`, which
makes the next prompt replay the whole thread as catch-up (bounded by
`MAX_REPLAY_ENTRIES`) — that restores context rather than clearing it. `!new` sets the
cursor to the moment it ran, so the replay window starts there and the session resumes
from the `!new` point with nothing before it.

**The cursor is a platform id, not a clock.** It is compared against the transcript's own
`ts`, and the replay path discards a cursor its platform's ordering cannot parse — falling
back to a full catch-up, which restores exactly what was cleared. So it is derived from the
`!new` message itself, the way a turn derives its own coordinates, and a wall-clock stamp is
wrong on every platform whose ids are not wall-clock shaped. Only Slack registers an ordering
strategy; every other platform's cursor is compared as text, so it is only as good as its
ids' lexical order — Feishu's opaque `om_` ids most obviously, but Telegram's per-chat
numbers and Discord's snowflakes are compared the same way. That is a pre-existing property
of every cursor in the transcript, not something this command introduces.

Two guards the shape of this operation earns. The write is pinned on the runtime session id
the command read, which narrows the check-then-act above it: a turn admitted in the window
that minted a NEW id loses the pin. It does not cover a turn that kept the same id — that one
read the row before the clear and its end-of-turn write restores what was cleared — so the
command re-checks the gate afterwards and says so rather than reporting a success the user
will not get. Closing this properly means running the clear under the session's own serial
gate, as a zero-length turn, so a concurrent dispatch queues behind it; that is worth doing
if the window turns out to matter in practice.

And a `!new` that the latest-session fallback retargeted to another conversation is refused
rather than performed — the reply lands on the command's own thread, so the people working in
the cleared one would never be told. The refusal is checked BEFORE the in-flight one, or a
retargeted command would be told to `!cancel` first, and `!cancel` retargets the same way.

The cleared session is the same session afterwards: same key, so the same
`session_outward_ids` row and the same console entry. The clear leaves **no console
trace** — a deliberate choice, not an oversight.

### 7.3 While a turn is in flight

- **`append` allows it.** Minting a new coordinate does not touch the running turn: it
  finishes on the old coordinate and posts its answer to its own thread, while later
  messages go to the new one. Refusing would be friction with nothing behind it.
- **`createNew` refuses it.** Clearing nulls the `acpSessionId` of the very row a running
  turn is identified by — the interrupt path resolves a turn through `rec.acpSessionId` —
  so it would pull the running turn's identity out from under it. `ctx.inflight` already
  reports gate ownership; the reply points at `!cancel`.

### 7.4 Authorization

`commandSenderAllowed`, the same gate `!stop` takes, plus the trusted-actor check `!resume`
takes: `!new` discards a conversation's working context and cannot be undone, so a bot echo
or a wrapper reporting no actor must not be able to forge it. The check is one predicate
(`requiresTrustedActor`) applied at BOTH ingress paths — direct and relay — because relay is
where the HTTP callbacks that can carry no actor at all arrive, and a gate on one path only
is the failure mode this shape exists to prevent. **Not** marked `runtimeChange` —
that flag guards Agent-level runtime settings behind an Agent editor, and `!new` changes
no setting. No confirmation step. `logSessionAction('new', key, actor)` records who ran
it, which is what that function exists for.

### 7.5 Command surface

`parseCommand()` gains `NEW_WORDS = new Set(['new'])` → `{ kind: 'new' }`. The word is
free in the current vocabulary (`stop`, `cancel`, `resume`, `queue`, `status`, `fast`,
`model`/`models`, `effort`, `permission`). Both prefixes work, so it is `!new` on Slack
and `/new` on Telegram and Discord, and it joins the advertised menus — `BOT_COMMANDS` in
`packages/daemon/src/telegram/connection.ts` and `DISCORD_APP_COMMANDS` — described as
"Start a new session in this conversation".

## 8. Web console

`IntegrationChannelList.tsx` renders a second `TriggerSelect` in the conversation row,
left of the trigger dropdown, with its own hover copy:

- `Create new` — "Each new message starts a fresh session. Replies inside a thread
  continue that thread's session."
- `Append` — "Every message in this conversation is added to one ongoing session."

**Scope: channel rows, on every platform that has channels.** A direct conversation is not
a channel and does not get the control. Per-platform narrowing uses the same mechanism as
the trigger's — `WebPlatformModule`'s `channelListSemantics`
(`packages/web/src/components/console/platforms/contract.ts`) gains an optional
`sessionModes` list — so a platform opts out by omitting it rather than having core branch
on a platform name.

**An `append` session is labelled by its room, not by a person.** The session list and
detail header render a session's `user` column from `triggeredBy`/`triggeredByName`, which
is frozen first-wins on the daemon ("the sender that created the session keeps the credit
across later upserts"). For a session that carries a whole channel over months, that
credits everything to whoever spoke first. `append` sessions are identified by the
conversation and the coordinate's start time instead — `#deploys (since Mar 4)` — which
also makes `!new` visible in the console, since two generations are otherwise
indistinguishable in a list.

## 9. Visibility and attribution

Session visibility and ownership are computed once, at row insert, from the first
milestone's sender and coordinates, and are never re-evaluated: `visibility`,
`ownerIdentity`, and `visibilitySource` appear only in the `INSERT` list of the session
metadata upsert, not in its `DO UPDATE SET` ("Visibility remains first-wins here").

For the scope this design ships, **the default classification is safe**. `classifySession`
marks an IM session `private` only when the conversation kind is `dm`, and `org`
otherwise — so a channel's session is `org`-visible, readable by every org member, and
`ownerIdentity` is provenance rather than a gate. Since §8 restricts the control to
channel rows, an `append` session is never the single-owner `private` kind.

One consequence still has to be closed: **an `append` session forbids `setVisibility`.**
That route is gated on `ownerIdentity`, so in `createNew` the first sender can reclassify
the thread they started — their own session. In `append` the same person owns the
conversation's long-lived session, and flipping it to `private` would move every later
participant's messages into a session only that person can read and only that person can
continue from the console, with the privacy bit pushed to the daemon to exclude those
turns from memory capture. An `append` session's audience follows its conversation, so it
is not one person's to change.

The eventual home for "audience = the conversation" is the existing external tier —
`externalProvider` + `externalScopeId` bound to an `ExternalScope`, which nulls
`ownerIdentity` and resolves membership live — but that tier only engages when an
organization enables the provider policy, so it is not a prerequisite here.

## 10. A prerequisite fix

`threadTranscript()` (`packages/daemon/src/store/local-store.ts`) reads a conversation
with `SELECT * … WHERE channel = ? AND thread = ? ORDER BY seq ASC` and **no `LIMIT`**,
and transcript rows are never pruned — no retention rule covers them. This is safe today
only because no `(channel, thread)` pair grows without bound. `append` creates exactly
that: a busy channel's whole history under one coordinate, read into memory on every
console open, with the rows of retired coordinates still on disk beside it. The prompt
path is already bounded (`MAX_REPLAY_ENTRIES`, `MAX_CONTEXT_REFRESH_EVENTS`); this read is
not.

It is bounded as part of this work, not after it.

## 11. Testing

- `packages/protocol` — the envelope round-trips `sessionModes`, and an older-shaped core
  still parses.
- `packages/control-plane` (`test:unit`) — `integrationToSpec()` and
  `httpIntegrationToSpec()` both emit the sparse list, including for a gated agent and for
  a relay-managed bot whose `bindRules` is empty.
- `packages/daemon`, coordinates — two top-level messages in an `append` conversation
  resolve to one session key; a thread reply in the same conversation resolves to that
  same key; the turn plan's delivery thread still equals the physical thread in both
  cases; two agents in one `append` channel resolve to different coordinates; a
  `createNew` conversation is unchanged; the observed-inbound in-flight match uses the
  session coordinate; a command sent in an `append` conversation resolves that
  conversation's session without relying on the latest-session fallback.
- `packages/daemon`, minting — the maximum lookup ignores the ACP-id filter; a mint after
  every append session was retention-purged produces a coordinate that no surviving
  transcript row uses; a clock moved backwards still mints above the current maximum.
- `packages/daemon`, concurrency — two messages arriving together into a conversation with
  no append session resolve to ONE coordinate, enter one inbox lane, and claim one serial
  gate; two simultaneous `!new` commands advance the conversation once and the CAS loser
  performs no second advance, while two sequential ones advance it twice; a `!new` racing
  an in-flight message does not split the conversation across two coordinates. Run against
  both store dialects, since the reservation's atomicity is what is under test.
- `packages/daemon`, reservation lifetime — retention purging an append session clears the
  reservation naming it, so the next message mints fresh rather than inheriting the
  surviving transcript, but a reservation a concurrent `!new` has already advanced is left
  alone; and a reservation whose session row has not been written yet — the ordinary window
  between resolve and the first turn — is joined by a second resolver, not advanced past.
- `packages/daemon`, `!new` — `parseCommand` recognizes both prefixes and the Telegram
  `@botname` suffix; in `append` the next message lands on the new coordinate while the
  retired session's row and transcript survive; in `createNew` the session keeps its key
  and workspace, loses its ACP id, and its next prompt replays nothing from before the
  command; `createNew` refuses while a turn is in flight and `append` does not.
- `packages/daemon`, routing — the existing thread-continuity and peer fan-out suites pass
  against the participation record in `createNew` with no change in behavior; in `append`,
  an unmentioned follow-up in a thread a mentioned agent answered in still routes to that
  agent, two agents in one thread remain ambiguous and fall back to mention-gating, a
  dormant owner is still revived, and peer fan-out still reaches the second agent so §3.4's
  mutual visibility holds.
- `packages/web` — the row renders both controls, a platform that omits `sessionModes`
  renders only the trigger, a direct conversation renders no session-mode control, and the
  `PATCH` carries the chosen mode.

## 12. Open questions

1. **`auto`.** Deliberately unimplemented. When it arrives it is a third enum value and a
   daemon-side classifier; nothing above changes shape to accommodate it.
2. **Retention of retired coordinates.** Superseded `append` sessions age out through the
   ordinary retention window, and their transcript rows remain on disk indefinitely like
   every other conversation's. §10 bounds the read; whether the rows themselves deserve a
   retention rule is a separate question about transcript retention generally.
