# AgentConnect Collaboration Arena

**Status:** Draft for review (revised after design review)

**Author:** AgentConnect team

**Related:** [collaboration-arena-baseline.md](collaboration-arena-baseline.md) · [agent-capability-benchmark-harness.md](agent-capability-benchmark-harness.md) · [agents-collaboration-design.md](agents-collaboration-design.md) · [agent-collaboration-implementation.md](agent-collaboration-implementation.md) · [architecture.md](architecture.md) · [session-concept.md](session-concept.md)

> This document is the **design**. What the arena actually measures against the
> landed implementation — the games' status, the real-model numbers, and the
> documented limitations (the fixed hop cap, goal overshoot, loop-guard
> saturation, and the blocked §10.2 handoff) — lives in
> [collaboration-arena-baseline.md](collaboration-arena-baseline.md).

## 1. Motivation and relationship to the existing suite

AgentConnect's current evaluation system is an **add-on regression harness**: it
measures whether memory and one-step collaboration improve a fixed ACP subject.
It already launches the real daemon, runs disposable agents, records semantic
events, and writes ATIF artifacts. But its case model is a linear array of
externally supplied turns, and each turn enters through a synthetic webchat
conversation. That is insufficient for shared rooms, concurrent agents, room
membership, cross-platform routing, or game-driven continuation.

This design evolves it into two complementary suites:

```text
Existing suite
AgentConnect Add-on Evals
  └── Small paired cases:
      memory off/on
      one delegation and reply
      (always the production
       collaboration surface)

New suite
AgentConnect Collaboration Arena
  └── Stateful multi-agent games:
      same-room counting
      cross-room counting
      Werewolf
```

The existing suite remains the fast regression suite. The Arena becomes the
product-level benchmark for AgentConnect's core value: multi-agent coordination
through real rooms, sessions, and message delivery.

### 1.1 Scope amendment to the existing evaluation design

[agent-capability-benchmark-harness.md](agent-capability-benchmark-harness.md)
lists "a bespoke runner, judge framework, report UI, or artifact schema" and a
general benchmark engine among its non-goals. **This design explicitly
supersedes that non-goal for the narrow scope of collaboration games.** The
Arena adds a game engine and world model, but deliberately keeps:

- Promptfoo as the outer orchestrator;
- ATIF and the existing evaluation-event schema as the product trace;
- the separation of trial validity, product invariants, and game score;
- the rule that no game logic enters `Daemon` — the daemon gains only generic
  evaluation seams.

The companion document carries a matching amendment note.

## 2. Architecture

```text
Promptfoo / evaluation CLI
              │
              ▼
┌──────────────────────────────────────────┐
│       Collaboration Game Runner          │
│                                          │
│  event scheduling · seeds · timeouts     │
│  scenario lifecycle · artifact writing   │
└───────────────┬──────────────────────────┘
                │
       ┌────────┴─────────┐
       ▼                  ▼
┌───────────────┐   ┌─────────────────────┐
│   Game World  │   │ AgentConnect Daemon │
│               │   │                     │
│ rules         │   │ real sessions       │
│ hidden state  │   │ real ACP runtimes   │
│ scoring       │   │ real ingress path   │
│ room topology │   │ real sendMessage    │
└───────┬───────┘   │ real A2A delivery   │
        │           │ real traces         │
        ▼           └──────────┬──────────┘
┌───────────────────┐          │
│ Virtual platform  │◀─────────┘
│ connections       │
│                   │
│ virtual Slack     │
│ virtual Discord   │
│ virtual Telegram  │
│ rooms and DMs     │
└───────────────────┘
```

The defining boundary:

> The game world decides what events occur and whether the game succeeds. The
> AgentConnect daemon decides how agents, sessions, messages, permissions, and
> collaboration behave.

No counting or Werewolf logic enters `Daemon`. The daemon gains five generic
evaluation seams, each specified below:

1. **Virtual platform connections** — a full transport double, not just a
   `MessageGateway` (§3).
2. **Two ingress surfaces** — real-path platform injection and trusted referee
   delivery (§4).
3. **An effective integration registry** — one authority for synthetic
   integrations (§5).
4. **An evaluation tool registry** — the seam for game-owned structured action
   tools (§6).
5. **Explicit delivery and outbound-effect contracts** — admission/completion
   handles and authorization-enforcing world recording (§7).

## 3. Transport seam: virtual platform connections, not just `MessageGateway`

### 3.1 Why `MessageGateway` alone is insufficient

`MessageGateway`
([packages/daemon/src/mcp/ops.ts](../../packages/daemon/src/mcp/ops.ts)) is the
platform-neutral slice that backs **MCP operations** — `sendMessage`, channel
and member listing, profile resolution, file download. It is not the daemon's
full transport abstraction:

- **Ordinary agent replies** — the normal way an agent speaks in its current
  room — are posted through the concrete
  `SlackConnection | TelegramConnection | DiscordConnection | FeishuConnection`
  resolved by `replyConnFor(agentId, integrationId?)` in
  [packages/daemon/src/daemon.ts](../../packages/daemon/src/daemon.ts), not
  through a `MessageGateway`.
- **Slack session/audience classification** reads tenant identity via
  `workspaceId()` on the concrete connection (`connByIntegration`), which a bare
  gateway does not provide.
- **Ingress metadata** (sender profiles, bot identity, thread canonicalization
  inputs) originates from the concrete connections, not the gateway.

A virtual `MessageGateway` alone therefore cannot capture ordinary assistant
replies, render public game discussion faithfully, provide Slack
tenant/audience metadata, or emulate platform reply and thread behavior. Worse,
forcing agents to use `sendMessage` for every public statement would measure
tool-following rather than coordination, and would produce duplicate output in
production, where ordinary replies already reach the room.

### 3.2 The `VirtualPlatformConnection` contract

The Arena introduces a virtual transport that implements the **complete
per-platform connection surface the daemon consumes**, per platform shape:

```ts
export interface VirtualConnectionWorldPort {
  /** Outbound-effect sink shared by ordinary replies and MCP sends (§7.2). */
  recordOutbound(effect: OutboundEffectInput): Promise<OutboundEffectResult>
  channelInfo(channel: string): VirtualChannelInfo | undefined
  members(channel: string): readonly VirtualMember[]
  channels(integrationId: string): readonly VirtualChannelInfo[]
  profile(user: string): VirtualProfile | undefined
}

export class VirtualSlackConnection /* implements the SlackConnection surface the daemon uses */ {
  constructor(
    private readonly integrationId: string,
    private readonly tenant: { workspaceId: string },
    private readonly world: VirtualConnectionWorldPort
  ) {}

  /** Tenant identity for session/audience classification — same contract as
   *  the real connection's workspaceId(). */
  workspaceId(): string {
    return this.tenant.workspaceId
  }

  /** Ordinary reply path — the same method the daemon's reply pipeline calls
   *  on a real connection. Routed to the world as a `reply` effect. */
  async postMessage(channel: string, text: string, threadTs?: string, identity?: SendIdentity) {
    const result = await this.world.recordOutbound({
      kind: 'reply',
      integrationId: this.integrationId,
      channel,
      thread: threadTs,
      identity,
      text
    })
    if (result.status !== 'delivered') throw new VirtualDeliveryRejected(result)
    return result.messageId
  }

  // getChannelInfo / listMembers / listChannels / getUserProfile /
  // openDirectMessage / downloadFile — the full MessageGateway surface,
  // answered from the world.
}
```

Registration: the evaluation environment (§5) installs virtual connections into
the same per-integration connection maps the daemon already consults
(`connByIntegration`, `tgConnByIntegration`, …). Because `replyConnFor`,
`srcIntegrationIds`, transport-scope resolution, and Slack realm classification
all resolve through those maps, **every existing consumer — ordinary replies,
MCP ops, session classification — reaches the virtual transport without new
branches in the daemon.** The daemon change is confined to accepting injected
connections at composition time; no call site changes.

### 3.3 Speech model

- **Ordinary output is current-room speech.** An agent's normal turn reply in a
  game room is captured as a public message in that room and relayed by the
  referee like any other room event. Games must not require `sendMessage` for
  in-room statements.
- **`sendMessage` is reserved** for proactive sends, cross-room/cross-platform
  sends, and direct agent-to-agent wakes — the cases where a real user would
  also need the tool.
- Both paths converge on the same world outbound-effect sink (§7.2), so scoring
  and invariant checks see one unified, ordered stream of attempted effects
  regardless of which path produced them.

A separate weekly smoke suite covers real Slack/Discord. The scored benchmark
uses virtual platforms for reproducibility, with real platform names and
thread-coordinate shapes (a virtual Slack room produces Slack-shaped channel
and thread coordinates) so platform-specific session behavior is exercised.

## 4. Ingress seam: two explicit surfaces

The current `runEvaluationTurn` calls `dispatch` with a preselected agent. The
real platform path first performs bot-loop suppression, per-connection
deduplication, platform thread canonicalization, command interception, trigger
routing, gating, and thread-ownership checks. A single generalized
"evaluation message" entry point that still preselects the agent would bypass
exactly the invariants the Arena claims to test: duplicated or reordered
evaluation messages would not exercise production ingress deduplication, and
room membership or trigger configuration would not affect admission.

The Arena therefore splits ingress into two explicit surfaces.

### 4.1 `injectPlatformEvent(...)` — the real inbound path

```ts
export interface EvaluationPlatformEvent {
  integrationId: string
  /** Platform-shaped raw-ish event: channel, thread, sender (with bot flag),
   *  text, mentions, message id — everything the platform normalizer needs. */
  payload: EvaluationPlatformPayload
}

class Daemon {
  /** Enters the SAME normalization → suppression → deduplication → thread
   *  canonicalization → command → trigger-routing → gating → dispatch path as
   *  a live platform callback. No target agent is supplied; routing decides. */
  async injectPlatformEvent(event: EvaluationPlatformEvent): Promise<DeliveryHandle>
}
```

Semantics:

- **No preselected agent.** The event enters upstream of routing, at the same
  point a virtual connection would surface a live platform message. Trigger
  rules, membership, thread ownership, and gating decide who (if anyone) is
  admitted.
- Duplicate, reordered, and delayed injections are legitimate test inputs and
  are expected to be handled by the production ingress logic.
- Human world events (game instructions rendered as room messages from the
  referee's _user persona_, observations, other-agent public speech relays) use
  this surface.
- `sender.kind: 'agent'` **does not exist** on this surface. Injected events
  carry human or bot platform senders exactly as a platform would. Genuine
  A2A traffic is never fabricated by injection; agent-originated messages
  arise only when a real agent actually calls `sendMessage` through the
  collaboration path, and the world relays the resulting effect.

### 4.2 `deliverRefereeEvent(...)` — trusted, pre-addressed game control

```ts
export interface RefereeEvent {
  targetAgentId: string
  platform: Platform
  integrationId: string
  channel: string
  thread?: string
  messageId: string
  text: string
  isDm: boolean
}

class Daemon {
  /** Trusted control-channel delivery: role assignments, private night
   *  prompts, canonical phase updates. Skips trigger routing (the target is
   *  authoritative) but still runs session addressing, the serial gate,
   *  SessionManager, and ACP. */
  async deliverRefereeEvent(event: RefereeEvent): Promise<DeliveryHandle>
}
```

Semantics:

- Referee deliveries are **excluded from ingress-invariant scoring** — they are
  environment machinery, not production traffic. The
  `events.jsonl`/`world-events.jsonl` records tag them `origin: 'referee'` so
  invariant checks (§9.2) can filter them.
- They still traverse the dispatch admission queue, per-session FIFO, and
  session identity code, so referee traffic cannot corrupt session state
  invariants either.

The existing `runEvaluationTurn` becomes a compatibility wrapper over
`deliverRefereeEvent` with a synthetic webchat coordinate, preserving the
current add-on suite unchanged.

## 5. Integration seam: one effective integration registry

Today, tool schemas and trusted session integrations derive from
`agent.integrations` (MCP session construction), while transport scope and
source classification resolve through configured integrations and live
connection maps. Adding "evaluation fallbacks" at each of these points would
let them disagree — advertised `sendMessage` platforms, integration selection,
`listChannels`, target-integration resolution, session transport scope, and
Slack audience identity could each see a different world.

The Arena instead defines **one authoritative effective-integration registry**
consumed by all of those paths:

```ts
export interface EffectiveIntegration {
  integrationId: string
  agentId: string
  platform: Platform
  /** Physical-bot identity used in session keys and transcript coordinates. */
  transportScope: string
  /** Virtual tenant metadata (e.g. Slack workspaceId) for audience/session
   *  classification. */
  tenant?: { workspaceId?: string }
  connection: VirtualPlatformConnection
}

export interface DaemonEvaluationEnvironment {
  integrations: readonly EffectiveIntegration[]
  listAgents(request: ChannelAgentsRequest): Promise<ChannelAgentsOk>
  collaborationRoutes: CollabRoutesSnapshot
}
```

At daemon composition (extending the existing `DaemonEvaluationOptions`):

```ts
export interface DaemonEvaluationOptions {
  observer?: EvaluationObserver
  runId?: string
  capabilityProfile?: EvaluationCapabilityProfile
  environment?: DaemonEvaluationEnvironment
  onObserverError?: (error: unknown) => void
}
```

Composition rules:

1. Each `EffectiveIntegration` is materialized as **both** an entry in the
   agent's `integrations` (so MCP session construction, tool gating, and
   `sendMessage` platform advertising see it) **and** a virtual connection in
   the per-integration connection maps (so reply resolution, transport scope,
   and tenant classification see the same object). One registry, two
   projections — they cannot diverge because both are derived from the same
   record.
2. The synthetic collaboration topology loads into the existing
   `CpCollabRoutes`; `listAgents` answers from the evaluation peer directory.
3. Authorization, coordinate-integrity, call-policy, hop-limit, deduplication,
   and session-key code stay **unchanged**. The benchmark compiles its topology
   into production collaboration policy; it never branches on
   `if (evaluation)` inside policy code.

### 5.1 Topology compilation

The game manifest uses human-readable aliases:

```yaml
agents:
  - id: agent-a
    rooms: [counting-room]
  - id: bridge-x
    rooms: [discord-origin, slack-support]
```

The topology compiler resolves every alias into **protocol-valid concrete
identifiers** (agent ids, integration ids, channel/thread coordinates,
transport scopes that satisfy the wire schemas in
`@agentconnect.md/protocol`) before anything reaches the daemon. Aliases exist
only in manifests and reports; the daemon and the artifacts operate on
concrete identifiers, with the alias map recorded in `topology.json`.

## 6. Tool seam: the evaluation tool registry

Werewolf needs a structured action tool (`vote`, `inspect`, `protect`, `kill`)
so authoritative game actions are never inferred from prose. Tool descriptors
and execution currently flow through the fixed bridge registry in
[packages/daemon/src/mcp/tools.ts](../../packages/daemon/src/mcp/tools.ts)
(`toolsForIntegrations` + the bridge's dispatch table); the environment seam in
§5 cannot register a new daemon-owned tool.

The Arena adds an **evaluation tool registry** to
`DaemonEvaluationEnvironment`:

```ts
export interface EvaluationToolDefinition {
  descriptor: ToolDescriptor // name + JSON schema, merged into the session tool set
  /** Which agents see and may call the tool (e.g. only living players). */
  visibleTo(agentId: string): boolean
  handler(call: {
    runId: string
    agentId: string
    sessionContext: SessionContext
    input: unknown
  }): Promise<EvaluationToolResult>
}

export interface DaemonEvaluationEnvironment {
  // …§5 fields…
  tools?: readonly EvaluationToolDefinition[]
}
```

Contract:

- **Descriptor merge.** Evaluation tools are appended to the per-session tool
  set after `toolsForIntegrations`, with name-collision rejection at daemon
  startup (an evaluation tool may not shadow a product tool).
- **Trusted binding.** The handler receives the trusted `SessionContext`
  captured at `session/new` — never tool-input-supplied identity — so the game
  knows _which_ agent in _which_ session acted.
- **Role-aware authorization is the game's job, in the handler.** The daemon
  only guarantees authentic caller identity; the world decides whether a dead
  villager may vote and returns a structured rejection if not.
- **Structured world effects.** Handler results are recorded as
  `world-events.jsonl` entries (attempted/rejected/accepted) through the same
  outbound-effect ordering as §7.2, so game actions and messages share one
  causal order.
- **Duplicate-action handling** is explicit: the handler is idempotent per
  `(runId, phase, agentId, action)` and reports `duplicate` rather than
  double-applying, mirroring the referee's atomic-acceptance rule in counting.

An evaluation-owned local MCP server was considered as an alternative. It is
viable but adds a second tool-lifecycle and trust boundary to specify
(spawn/teardown per run, transport auth, session binding). The in-daemon
registry reuses the bridge's existing session binding and permission plumbing,
so it is the chosen design; the local-server option remains open for tools that
must run out of process.

## 7. Delivery lifecycle and outbound authorization

### 7.1 Delivery handles

`dispatch` today resolves when the full turn completes, not merely on
admission. A bare `deliverConcurrent()` + `waitUntilIdle()` would leave
ambiguous which barrier each promise represents. Both ingress surfaces (§4)
return an explicit handle:

```ts
export interface DeliveryHandle {
  /** Settles at the admission decision: routed/admitted, or rejected with the
   *  production reason (deduplicated, suppressed, unrouted, gated, queue-full). */
  admission: Promise<DeliveryAdmission>
  /** Settles when the resulting turn (if any) reaches a terminal state. */
  completion: Promise<DeliveryCompletion>
}

export type DeliveryAdmission =
  | { admitted: true; agentId: string; sessionKey: string; turnId: string }
  | { admitted: false; reason: 'deduplicated' | 'suppressed' | 'unrouted' | 'gated' | 'queue_full' | 'error' }

export type DeliveryCompletion =
  | { status: 'completed'; sessionId: string; turnId: string }
  | { status: 'failed' | 'cancelled' | 'timeout'; sessionId: string | null; turnId: string; error?: string }
  | { status: 'not_admitted' }
```

The harness exposes both barriers:

```ts
class DaemonEvaluationHarness {
  start(): Promise<void>
  inject(event: EvaluationPlatformEvent): DeliveryHandle
  deliverReferee(event: RefereeEvent): DeliveryHandle
  /** Concurrent wave: all events pass admission before any completion is
   *  awaited, so later deliveries cannot see earlier turns' output. */
  injectConcurrent(events: EvaluationPlatformEvent[]): DeliveryHandle[]
  waitUntilIdle(): Promise<void> // dispatch queues drained + post-turn chains settled
  events(): readonly EvaluationEvent[]
  stop(): Promise<void>
}
```

`waitUntilIdle()` is a convenience barrier over the union of open
`completion` promises plus the daemon's post-turn memory chains; game logic
that cares about a specific delivery awaits its handle, not global idleness.

### 7.2 Outbound effects are authorized, not recorded

The world's outbound sink must not unconditionally succeed, or "unauthorized
delivery" and "wrong-room delivery" cannot be hard gates — every violation
would simply become a delivered message. `recordOutbound` (§3.2) distinguishes
three dispositions and enforces the checks a real platform + daemon policy
would:

```ts
export type OutboundEffectResult =
  | { status: 'delivered'; messageId: string; sequence: number }
  | { status: 'rejected'; sequence: number; reason: OutboundRejection }

export type OutboundRejection =
  | 'integration_not_owned' // sender agent does not own this integration
  | 'platform_mismatch' // effect platform ≠ integration platform
  | 'not_a_member' // sender not in the target room
  | 'channel_not_visible' // channel exists but is not visible to the integration
  | 'unknown_channel'
  | 'invalid_thread' // thread does not exist under that channel
```

Every attempt — delivered or rejected — is recorded in `world-events.jsonl`
with a monotonic `sequence`, the resolved integration, and the trusted sender
identity. Rejected effects surface to the agent as the same shaped tool/reply
error a real platform would return. Invariant scoring (§9.2) counts
**attempted** violations, not just delivered ones: an agent that tries to post
into a room it is not a member of has violated the invariant even though the
world refused the message.

## 8. Game runner and execution modes

A game is an event loop, not a list of turns:

```ts
while (!world.isTerminal()) {
  const wave = world.nextDeliveries()
  const handles = harness.injectConcurrent(wave.platformEvents)
  const refereeHandles = wave.refereeEvents.map((e) => harness.deliverReferee(e))
  await Promise.all([...handles, ...refereeHandles].map((h) => h.completion))
  const effects = world.drainOutboundEffects()
  world.applyEffects(effects)
  if (world.stepCount >= limits.maxSteps) world.terminate('step_limit')
}
```

A **wave** matters: after number 7 is accepted, agents B, C, and D receive the
observation concurrently. Sequential delivery would give later agents unfair
information and would not test collisions.

### 8.1 Execution modes — honest determinism claims

Fixed seeds, fixed delivery order, and virtual delays make the **environment
and referee** deterministic. They do not make concurrent real model calls
deterministic: "first valid arrival wins" still depends on provider latency
and runtime scheduling. The modes are therefore defined as:

```text
deterministic (environment-deterministic)
  fixed seed, fixed event ordering, fixed virtual delays
  EXACT reproducibility guaranteed only for scripted ACP hosts
  real-agent trials: deterministic environment, non-deterministic outcomes

stress
  concurrent delivery, randomized seeded delays
  duplicate and reordered events, race-condition testing
```

Consequences:

- Scripted-host runs are the reproducible benchmark of the **engine** and gate
  CI.
- Real-agent games run **repeated trials** and report observed reliability
  (pass rate, `pass^k`) rather than claiming a reproducible single score.
- Every scheduler decision and effect ordering is recorded: the world logs each
  wave's composition, each admission order, and each `sequence`-stamped effect
  in `world-events.jsonl`. A real-agent trial is therefore **explainable**
  (its exact causal order can be replayed for analysis) even when it is not
  **reproducible** (a rerun may order differently).

## 9. Result layers

Every run has three result layers, evaluated in order.

### 9.1 Trial validity

```text
daemon started
all runtimes authenticated
no infrastructure timeout
artifacts successfully written
game referee remained internally consistent
```

An invalid trial is `infra_error`, never an agent failure.

### 9.2 Product invariants — hard gates

```text
no unauthorized outbound effect (attempted or delivered) — §7.2
no wrong-room delivery
no duplicate session wake
no cross-room canary leak
no private-role leak
correct sender attribution
correct session identity
correct parent/child correlation
per-session FIFO preserved
ingress deduplication preserved (scored on injectPlatformEvent traffic only;
  referee deliveries are excluded — §4.2)
```

A privacy or authorization failure is never averaged away by a high game score.

### 9.3 Game outcome and efficiency

```text
counting completion · handoff completion · Werewolf winner
round/turn/tool-call counts · token usage · latency · participation balance
```

A Werewolf loss is a valid trial with the appropriate team result, matching the
existing philosophy that an expected-low control can legitimately score zero.

## 10. The games

### 10.1 Game 1: same-room coordinated counting

```yaml
rooms:
  - id: counting-room
    platform: slack
    channel: C-EVAL-COUNTING
    thread: T-GAME-001
    members: [agent-a, agent-b, agent-c, agent-d]
```

Counting has **no winner or loser**. It probes leaderless group
self-organization (无领导小组讨论): can a room of agents coordinate
turn-taking without a moderator — fill in, avoid duplication, avoid spam, and
recognize completion on their own? The result is a **collaboration report**:
did the group complete the count, and with what coordination quality.

The world injects the starting instruction to the room; routing fans it out to
the members' room-scoped sessions. Agents publish candidates as **ordinary
room replies** (current-room speech, §3.3) containing the number; the world
parses candidates from the unified outbound-effect stream and the referee
atomically accepts the first valid candidate equal to `current + 1` in
`sequence` order. Two variants differ in what drives the next wave:

- **referee-announced**: the referee relays a canonical room event after each
  acceptance (`Accepted: 1 from agent-c. Next expected number: 2.`) and
  enforces the take-turns convention at acceptance time.
- **peer-driven** (§3.3 taken literally): every delivered agent post is relayed
  verbatim to the other members through the real ingress path the moment it
  lands; the referee posts only the start message and then stays silent,
  observing and validating the sequence at the end. Agents continue the count
  from **each other's** messages, and a consecutive contribution is recorded as
  a turn-taking-balance observation — never a hidden rejection, which would
  diverge the official count from the room-visible transcript.

Conventions: target 12; one accepted occurrence of each number; no skips; no
predefined order; waiting is legal; letting another participant continue after
you contributed is the turn-taking convention the group is measured on. The
world — not an agent call chain — performs the relays, so the game tests room
coordination rather than the collaboration hop limit. A post-completion
acknowledgment ("8 has already been posted, so the count is complete.") is a
positive termination-awareness signal, never noise.

Group measures: completion (prefix reached / target), per-agent contribution
record and participation as normalized entropy, duplication
(duplicate/stale/wrong-number candidates), digit-free noise, consecutive
contributions (turn-taking balance), termination acknowledgments, rejected
outbound effects, regenerations/coalesces absorbed by in-flight turns, and
turns/tokens/latency per accepted number.

### 10.2 Game 2: cross-room counting relay

```yaml
rooms:
  - id: discord-origin
    platform: discord
    channel: D-ORIGIN
    thread: D-GAME-001
    members: [agent-a, agent-b, bridge-x]
  - id: slack-support
    platform: slack
    channel: S-SUPPORT
    thread: S-GAME-001
    members: [bridge-x, agent-c, agent-d]
```

`bridge-x` is one identity with two virtual integrations, so it naturally holds
two room-scoped sessions. The Discord room counts 1–6; at 6 the room must
initiate a handoff; `bridge-x` must post into Slack via `sendMessage`; the
Slack room counts 7–12; `bridge-x` reports completion back to Discord.

**The handoff is a real cross-room send, so it must be fully addressed.** The
scenario instructions require the agent to pass explicit `platform`,
`integrationId` (or an unambiguous integration selector), `channel`
`S-SUPPORT`, and `thread` `S-GAME-001`. This is a scoring rule, not a
convenience: `sendMessage` defaults to the caller's current platform, and a
channel-root send would start a different conversation rather than continue
`S-GAME-001`. A handoff that lands at channel root, on the wrong platform, or
through a non-owned integration is scored as an incorrect handoff (and the
world's §7.2 checks reject the non-owned case outright).

The referee never secretly moves the task; the Slack room learns of the
handoff only from the agent's actual delivered send. A canary present in
Discord but outside the allowed handoff payload makes context leakage a
deterministic failure.

Metrics: handoff attempted/accepted, correct source and destination
(platform + integration + channel + thread), payload completeness, unsupported
information added, forbidden information leaked, destination continuation,
completion reported to origin, cross-room turns and latency.

### 10.3 Game 3: same-room Werewolf

Minimal setup: 7 agents — 2 werewolves, 1 seer, 1 doctor, 3 villagers.

Contexts:

```text
public room               → ordinary replies (current-room speech)
private role message      → deliverRefereeEvent (trusted control)
werewolf private room     → a real private virtual room; wolves coordinate
                            via ordinary replies there, or direct A2A via
                            real sendMessage
private action results    → deliverRefereeEvent
```

Public discussion stays natural language through ordinary replies. **Game-state
mutations use the evaluation tool registry (§6)**: `vote`, `inspect`,
`protect`, `kill` are structured tools visible only to living players, with
role-appropriate authorization enforced by the game's handler and duplicate
actions reported per §6. This removes any need to guess whether "I'm leaning
toward D, but C is also suspicious" is a vote.

**The day is sequential, and its sequencing is peer-driven.** Werewolf's day is
not a simultaneous broadcast: players speak one at a time, in a known order, and
each speaker hears everyone before them. The referee announces the order once
when it opens the day and then stays silent; from there the round advances
because speaker N's ordinary reply is echoed into the room and the daemon's own
arbitration ladder wakes speaker N+1 (§3.3). Nobody is nominated by the referee —
that would replace the behavior under measurement with a scheduler. Players who
are not up answer with the product's `AC_NO_RESPONSE` silent branch.

Every day therefore records how far the order got: the announced order, who
spoke, who never got their turn, out-of-order speeches, what ended the round, and
whether it reached the vote. A round that dies mid-order is a **result**, not a
harness failure — see the baseline's §6.5 for the measured bound.

The strongest deterministic system metric is secret leakage: unique canaries in
private role information (`SEER-CANARY-…`, `WOLF-CANARY-…`). Any public-room
effect containing them — attempted or delivered — is an isolation failure.

## 11. Artifacts

Keep the existing artifacts and add game artifacts:

```text
run.json               (existing — reproducibility manifest)
events.jsonl           (existing — AgentConnect product trace)
trajectory.json        (existing — ATIF)
world-events.jsonl     (new — referee events + ordered outbound effects, §7.2/§8.1)
game-result.json       (new — deterministic scoring)
topology.json          (new — compiled topology + alias map, §5.1)
```

`world-events.jsonl` example:

```json
{
  "sequence": 19,
  "type": "count.candidate",
  "origin": "agent_effect",
  "agentId": "agent-b",
  "roomId": "counting-room",
  "value": 7,
  "accepted": false,
  "reason": "duplicate"
}
```

`game-result.json`:

```json
{
  "schemaVersion": "agentconnect.game-result/v1",
  "game": "same-room-counting",
  "seed": 42,
  "mode": "deterministic",
  "subjectKind": "scripted",
  "valid": true,
  "terminalReason": "completed",
  "outcome": { "completed": true, "acceptedPrefix": 12, "target": 12 },
  "invariants": {
    "attemptedUnauthorizedEffects": 0,
    "wrongRoomMessages": 0,
    "privateLeaks": 0
  },
  "metrics": { "collisions": 4, "turns": 31, "toolCalls": 18, "latencyMs": 82451 }
}
```

The world and AgentConnect traces share `runId`, `turnId`, message ids, and
room coordinates so any failure can be followed across both.

## 12. Promptfoo integration

Promptfoo remains the outer orchestrator; one provider invocation is one
complete game:

```yaml
tests:
  - vars:
      case: |
        {
          "kind": "game",
          "id": "counting-same-room-v1",
          "game": "counting",
          "seed": 42,
          "scenario": "same-room",
          "agentIds": ["agent-a", "agent-b", "agent-c", "agent-d"]
        }
```

Promptfoo owns treatment enumeration, repeated seeds/trials (§8.1), reporting,
CI output, and comparisons. Raw ACP is not a control for games — it has no
room, identity, routing, or collaboration semantics. Compare instead:
AgentConnect commit A vs B, collaboration configuration A vs B, clearly
labeled model/runtime A vs B, and capability ablations.

## 13. Repository structure

```text
packages/daemon/src/evaluation/
  artifacts.ts
  events.ts
  subject-sandbox.ts        # extracted from runner.ts
  daemon-harness.ts         # reusable daemon lifecycle + DeliveryHandle surface
  environment.ts            # effective-integration registry + tool registry contracts
  virtual-connections.ts    # VirtualSlack/Discord/TelegramConnection
  runner.ts                 # existing linear cases (unchanged surface)
  game-runner.ts            # new stateful runner

evals/
  providers/
    agentconnect.ts
    collaboration-game.ts
  games/
    types.ts
    engine.ts
    world.ts                # rooms, membership, outbound authorization (§7.2)
    topology.ts             # alias → concrete-identifier compiler (§5.1)
    counting.ts
    cross-room-counting.ts
    werewolf.ts
  cases/
    addons.yaml
    collaboration-games.yaml
  assertions/
    outcome.ts
    game-result.ts
  test/
    virtual-connections.test.ts
    world-authorization.test.ts
    topology.test.ts
    counting.test.ts
    cross-room-counting.test.ts
    game-runner.test.ts
```

Scripts:

```json
{
  "eval:collab:contracts": "vitest run evals/games packages/daemon/test/evaluation-game*.test.ts",
  "eval:collab": "pnpm --filter @agentconnect.md/daemon build && node evals/run-collaboration.mjs",
  "eval:collab:view": "promptfoo view -n"
}
```

## 14. Implementation order

The first milestone is **same-room counting with scripted fake ACP hosts** —
proving virtual connections, real-path injection, concurrent delivery, session
addressing, outbound authorization, and scoring deterministically. Then the
identical game runs with real agents; any difference is behavioral, not engine
uncertainty.

```text
1. Virtual platform connections + effective integration registry + outbound
   authorization (scripted hosts, unit/contract tests)
2. injectPlatformEvent / deliverRefereeEvent + DeliveryHandle
3. Same-room counting, scripted agents (CI gate)
4. Same-room counting, real agents (repeated trials)
5. Cross-room counting with bridge identity
6. Evaluation tool registry + Werewolf
7. Delay, duplication, and failure variants (stress mode)
8. Multi-daemon / real-relay benchmark later
```

## 15. Review resolutions

This revision incorporates a design review. Resolution map:

| Finding                                                                    | Resolution                                                                                                                                                                             |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 — `MessageGateway` is not the full transport abstraction                | §3: `VirtualPlatformConnection` implements the complete concrete-connection surface (ordinary replies, tenant metadata, gateway ops), installed in the existing connection maps.       |
| P1 — generalized ingress bypasses the invariants under test                | §4: split into `injectPlatformEvent` (real routing path, no preselected agent) and `deliverRefereeEvent` (trusted control, excluded from ingress scoring); no fabricated A2A senders.  |
| P1 — synthetic integrations need one authoritative registry                | §5: one `EffectiveIntegration` registry projected into both `agent.integrations` and the connection maps; no per-path evaluation fallbacks.                                            |
| P1 — Werewolf's structured action tool has no implementation seam          | §6: evaluation tool registry with trusted session binding, game-side role authorization, structured world effects, and idempotent duplicate handling.                                  |
| P2 — "deterministic mode" overpromised reproducibility                     | §8.1: deterministic = environment/referee only; exact reproducibility only for scripted hosts; real agents use repeated trials; full decision/ordering log for explainability.         |
| P2 — delivery lifecycle and virtual authorization needed sharper contracts | §7: `DeliveryHandle` separates admission from completion with typed outcomes; `recordOutbound` enforces ownership/membership/visibility/thread checks and scores attempted violations. |
| Warning — earlier non-goal ("no general benchmark engine")                 | §1.1: explicit scope amendment; the companion document carries a matching note.                                                                                                        |
| Warning — alias names must compile to protocol-valid identifiers           | §5.1: topology compiler resolves aliases before the daemon; alias map recorded in `topology.json`.                                                                                     |
| Warning — cross-room handoffs must be fully addressed                      | §10.2: explicit `platform`/`integrationId`/`channel`/`thread` required and scored; channel-root or wrong-platform sends are incorrect handoffs.                                        |
