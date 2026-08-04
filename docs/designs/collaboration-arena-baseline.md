# Collaboration Arena — measured baseline

Companion to [`collaboration-arena.md`](collaboration-arena.md), which is the
_design_. This document is the _measurement_: what the arena actually exercises
against the implementation on `main` today, what each scenario does, what the
numbers were, and where the limits are.

These scenarios **work** on the current implementation. The limitations in §6 are
real and documented, but none of them is a defect discovered by the arena — each
is a protection behaving as designed, or a capability the product does not have.

**Scope note.** This document describes and measures the landed implementation.
It deliberately does not argue for design alternatives; that discussion belongs
to the messaging-primitives counter-proposal, which builds on this baseline.

## 1. What the arena exercises

The arena runs multi-agent games through the **real daemon routing path**. There
is no synthetic relay, no `if (evaluation)` branch in policy code, and no
preselected recipient anywhere on the ingress path.

A game turn travels the same road a production Slack message travels, **from the
normalized-ingress boundary onward**:

| Stage             | What actually runs                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Transport         | `VirtualPlatformConnection` installed into the **production** connection maps — the real `SlackConnection` surface                |
| Ingress           | `injectPlatformEvent(...)` — enters `onInboundOutcome` with no preselected agent, exactly where a live connection callback enters |
| Suppression/dedup | The real per-connection, transport-scoped dedup and bot-message suppression                                                       |
| Routing           | The real routing table, arbitration ladder, mention resolution, and authorship-claim verification                                 |
| Gating            | The real hop cap, durable loop guard, and serial turn gate                                                                        |
| Sessions          | The real `SessionManager`, session keys, epochs, and turn-final context refresh                                                   |
| Tools             | The real MCP control socket — `sendMessage` and the §6 evaluation registry go through the daemon's actual executor                |
| Egress            | The real outbound authorization (`recordOutbound`): ownership, membership, visibility, and thread checks                          |

**Platform normalization is _not_ exercised.** `injectPlatformEvent` builds a
`NormalizedMessage` directly from the evaluation payload; it does not run the
Slack/Discord normalizers in `@agentconnect.md/message`. The arena's ingress
boundary is the normalized message, so normalizer bugs — mention parsing, event
shape, edit detection — are outside what these games can catch. Those are
covered by the `@agentconnect.md/message` package's own tests.

Beyond that boundary, two things are substituted, both at the edges:

- **The platform** is a virtual connection rather than a live Slack workspace.
  The `connection-surface` guard test asserts that the virtual Slack connection
  implements every member of the real one that the daemon consumes, and that its
  exemption list cannot rot (every exempt name must still exist on the real
  connection).
- **The model** is a scripted ACP host in CI, so the whole gate runs with **no
  model credentials**. The identical game runs against a real ACP runtime by
  passing a subject template; the engine seam is the same either way.

### 1.1 The platform echo (peer-driven counting and quota counting only)

In the **echo-enabled** games — peer-driven counting and quota counting — every
delivered agent post fans back to the other members' connections under the
author's **real managed bot identity**, as a streaming post under its own message
id plus a response-closing `message_changed` edit under the same msgId,
distinguished by `ingressEventTag` and carrying the daemon-stamped authorship
claim. Whether an echo activates anyone is the **daemon's** decision; the harness
never editorializes, and chatter echoes exactly like a valid move, because
production echoes everything.

**Werewolf and cross-room counting do not install the echo.** Their phases are
referee-driven: waves come from human-sourced referee broadcasts and
`deliverRefereeEvent`, so a delivered agent post there does not fan back as a
production-style inbound event. That is why those two games do not exercise
implicit continuation, and why their conversations are bounded by the referee's
cadence rather than by the hop cap.

## 2. The four routing acceptance cases

`evals/test/routing-acceptance.test.ts` — 8 tests, all green.

| Case   | Shape                             | Pinned behavior                                                                                                                                                                                                     | Status |
| ------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **1**  | `sendMessage {toAgent, channel}`  | One visible root post, target activated **exactly once**, anchored to that single post; a thread reply reaches only the target. The target's mention is rendered into the visible root post.                        | Green  |
| **1b** | `sendMessage {sessionId: parent}` | Session-only parent resume: **zero** new IM outbound while the parent still processes the reply; an explicit visible send from the resumed parent is still delivered.                                               | Green  |
| **2**  | `sendMessage {channel}`           | Bare visible root post with **zero** activations; the author owns the resulting thread, and a human thread reply reaches only the author.                                                                           | Green  |
| **3**  | Ordinary-reply mentions           | Agent-authored platform messages route: a finalized reply mentioning a peer activates it exactly once; an A→B→A chain advances one hop per edge until the cap; unmentioned posts and self-mentions activate no one. | Green  |

Case 3 carries the design's test #16 at full budget: **8 admitted edges in exact
alternating order**, asserted edge-by-edge rather than in aggregate — a
duplicated activation on any single edge cannot hide under an aggregate bound —
and the edge past the cap is refused with no dispatch behind it.

Every suite also carries a regression pin that no turn is lost to
`session_source_mismatch` (issue #583, fixed by #568).

## 3. The games

### 3.1 Peer-driven counting (§10.1 / §3.3)

A room of agents counts to a target with **no moderator**. The referee speaks
once to open, then goes silent; the count is carried entirely by agents
continuing each other. There is no winner and no loser — this is a probe of
leaderless group self-organization, and the result is a coordination report.

Measured: group completion, participation entropy, duplication, turn-taking
balance, and termination awareness.

The referee-announced variant is retained as the deterministic contrast: there,
the referee announces each acceptance, so the official count stays visible and
the no-consecutive-scorer rule is enforced at acceptance.

### 3.2 Quota counting (§10.1 variant)

Same room, but each agent may contribute a **fixed quota** of numbers. This adds
a real endgame hazard: if one agent hoards its quota while everyone else
exhausts theirs, the sequence cannot finish. The game classifies that hazard
distinctly from an ordinary stall and from a deadlock, and observes over-quota
and consecutive posts rather than policing them.

### 3.3 Werewolf (§10.3)

Seven agents, seeded roles (2 werewolves, 1 seer, 1 doctor, 3 villagers), a
public room, a **real private wolf den**, and per-player referee DMs. Public
discussion is ordinary natural-language speech; game-state mutations
(`vote`, `inspect`, `protect`, `kill`) go through the §6 evaluation tool registry
as structured actions over the real MCP socket.

The registry enforces at the daemon: startup name-collision rejection (an
evaluation tool may never shadow a product tool), a per-agent visibility
predicate, and dispatch on the **trusted token-bound** `SessionContext` — never
tool-input-supplied identity. Role-appropriate authorization, aliveness, phase
correctness, and idempotence per `(round, action)` are the game's job in the
handler.

**Aliveness is enforced in the handler, not in visibility.** The current
`visibleTo` predicate admits every configured player, and dead players remain in
the public-room and wolf-den broadcast membership, so they still receive prompts
and can still attempt actions — which the handler then rejects. Authoritative
game state is never corrupted, but the measured conversation is **not**
living-player-only, and the action counts include rejected attempts by the dead.
Anyone reading participation metrics off this game should account for that.

The strongest deterministic measure is **secret leakage**: unique canaries in
private role information, checked against exact private-channel membership. Any
public-room effect containing one — attempted or delivered — is an isolation
failure. Measured leaks: **0**.

### 3.4 Cross-room counting (§10.2) — blocked, and pinned as such

See §6.4. The game is present and its referee semantics are covered, but the
milestone cannot complete against the landed `sendMessage`.

## 4. Reproducing every result

Node 24 (`.nvmrc`) and pnpm 11. No model credentials required.

```bash
pnpm install
pnpm build # protocol must be built before typecheck

# the whole arena gate
pnpm eval:collab:contracts # 15 files, 99 tests

# the routing acceptance cases alone
pnpm eval:collab:routing # routing-acceptance + connection-surface

# individual scenarios
npx vitest run evals/test/counting.test.ts
npx vitest run evals/test/quota-counting.test.ts
npx vitest run evals/test/werewolf.test.ts
npx vitest run evals/test/cross-room-counting.test.ts
npx vitest run evals/test/game-runner.test.ts
npx vitest run evals/test/routing-acceptance.test.ts

# supporting suites
pnpm eval:contracts # evidence schema, ATIF, permission, redaction
pnpm eval:validate  # adapter/config validation + evals tsc
```

Full gate, measured on this branch:

| Suite                                                  | Tests  |
| ------------------------------------------------------ | ------ |
| `evals/test/routing-acceptance.test.ts`                | 8      |
| `evals/test/game-runner.test.ts`                       | 5      |
| `evals/test/werewolf.test.ts`                          | 7      |
| `evals/test/quota-counting.test.ts`                    | 8      |
| `evals/test/cross-room-counting.test.ts`               | 6      |
| `evals/test/counting.test.ts`                          | 11     |
| `evals/test/world-authorization.test.ts`               | 10     |
| `evals/test/collaboration-game-provider.test.ts`       | 9      |
| `evals/test/game-result-assertion.test.ts`             | 7      |
| `evals/test/game-subject.test.ts`                      | 6      |
| `evals/test/connection-surface.test.ts`                | 5      |
| `evals/test/topology.test.ts`                          | 5      |
| `evals/test/virtual-connections.test.ts`               | 4      |
| `packages/daemon/test/evaluation-game-ingress.test.ts` | 5      |
| `packages/daemon/test/evaluation-game-tools.test.ts`   | 3      |
| **Total**                                              | **99** |

**0 expected-fail.** Every pin is an ordinary assertion.

## 5. Real-model runs

> **Provenance.** The numbers in this section were measured on **`main` @ 87d36bc**
> with real local Claude Code over ACP (model sonnet), and are **carried forward
> unrefreshed**. No ACP adapter is installed in the current environment, so they
> could not be re-measured for this document. They are reported as inherited
> measurements, not as re-verified results. Everything in §2, §3, §4 and §6 **was**
> measured on the current branch.

Both runs use the peer-driven variant: one human-sourced start message, then a
silent referee.

**2 agents, target 20 — reached 10/20.**

| Metric                | Value                                      |
| --------------------- | ------------------------------------------ |
| Numbers landed        | 10 of 20                                   |
| Terminated by         | Hop cap (`unrouted` on the next echo)      |
| Structure             | Human-seeded wave + 8 agent-to-agent edges |
| Participation entropy | 1.0 (perfect alternation)                  |
| Duplicate posts       | 0                                          |
| Regenerations         | 1                                          |
| Final admissions      | 9 admitted + 1 `unrouted`                  |

The 10 is not a coordination failure — it is the hop budget, exactly (see §6.1).
Coordination quality was perfect over the whole budget. For contrast, before #568
the same run stalled at 2 with `session_source_mismatch` at hop 1 of 8.

**4 agents, target 8 — completed 8/8.**

| Metric                | Value                        |
| --------------------- | ---------------------------- |
| Numbers landed        | 8 of 8 (completed)           |
| Admissions → turns    | 24 admissions → 13 turns     |
| Regenerations         | 12                           |
| Coalesced             | 15                           |
| Participation entropy | 0.70 (one agent never spoke) |

The high regeneration and coalescing counts are the turn-final context refresh
working: a concurrent turn pulls a fresher thread snapshot, sees a peer message
it has not represented, and regenerates rather than posting a stale number.

## 6. Limitations

### 6.1 The hop cap is a fixed constant, and it binds long leaderless games

`MAX_AGENT_CALL_HOPS = 8` in `packages/protocol/src/consts.ts`. It is a **single
shared constant** — the daemon, both relay paths, and the CP all import the same
value, deliberately, so a relayed chain cannot outlive the budget an internal
chain gets. There is **no per-conversation, per-agent, or environment override
anywhere on `main`** (verified: no config-schema key, no CP env key, no
`.env.example` entry).

Consequence: a conversation carried purely by agent continuations gets the
initial human-sourced wave plus 8 agent-to-agent edges. With two participants
that is **10 numbers, structurally** — a 20-number leaderless count cannot
finish, no matter how well the agents coordinate. Any longer target needs a
human or referee message to re-seed the budget.

This is a property of the probe, not a defect. It is what the routing rework
means by "the exchange ends because it reaches a limit". It does mean the arena
cannot currently measure leaderless coordination **quality** beyond depth 8 —
past that point the metric measures the cap.

### 6.2 A leaderless room does not stop at its goal

Measured, scripted, 3 agents × target 6: the room completes 1..6 correctly and
then **keeps counting past the target**, to about 10, until a loop protection
latches.

Termination awareness is scored as a coordination-quality signal — a
post-completion acknowledgment ("the count is complete") is recorded as a
positive, never as noise. But the **mechanism** that actually ends the
conversation is always a protection, never the group recognizing its own goal.

Pinned in `evals/test/game-runner.test.ts` ("peer-driven variant: … then the loop
protections stop the room").

### 6.3 Wide fan-out saturates the loop guard, and participation becomes unfair

The durable loop guard admits `MAX_AUTOMATIC_TURNS_PER_WINDOW = 8` automatic
turns per `LOOP_GUARD_WINDOW_MS = 60_000` window (`packages/daemon/src/daemon.ts`).
The latch is **durable and has no cooldown** — only an explicit `!resume` resets
it.

Each **dedicated bot** receives the channel event on its own connection, so one
post wakes every other participant. With four dedicated bots the wake fan-out
outruns that budget: turns are **admitted and then dropped unstarted**.

Measured, scripted quota counting, 4 agents × quota 2 (target 8): **0 of 8**
completed — 29 turns accepted, only 10 started. The two-participant version of
the same game completes cleanly (4/4, quota exhausted exactly). Both regimes are
pinned.

The consequence worth naming is **participation unfairness**: agents whose ring
position never came up before the latch **never speak at all**. The room is
bounded by the protections rather than by the game, and which agents got to
participate is decided by scheduling order, not by the design of the game.

### 6.4 The §10.2 cross-room handoff is not expressible

§10.2 requires the cross-room handoff to be **fully addressed** — explicit
platform, integrationId, channel **and thread** — and scores a channel-root send
as an _incorrect handoff_, because the destination conversation is a thread and a
root post starts a different one.

The routing rework removed `thread` from **every** `sendMessage` target. Per
`packages/daemon/src/mcp/ops.ts` (§2.2), a visible send is either a direct
message or a channel-**root** post; addressing the current thread is the ordinary
turn reply's job. A supplied `thread` is rejected loudly rather than silently
posted at the root:

```text
sendMessage: channel target allows only `channel`, `platform`, `integrationId`,
`message`; unexpected `thread`.
```

So against a threaded destination the only send the product accepts is exactly
the one §10.2 scores as incorrect. **The milestone is blocked on a product
capability that does not exist** — nothing is broken.

Rather than assert a completion that cannot happen, the end-to-end test pins the
measured boundary: the origin room counts 1..6 in perfect alternation through the
real routing path, and the game stalls at the handoff on the product's own
refusal, carried by the bridge's own turn. Measured verdict: `acceptedPrefix: 6`,
`handoffDelivered: false`, `terminalReason: 'stalled'`, with zero unauthorized
effects, zero wrong-room messages and zero private leaks. The §10.2 referee
semantics (full addressing, channel-root scoring, canary isolation, completion
reporting) remain covered by contract tests, so the scoring rules are ready if
the capability lands.

### 6.5 Scope limits of the harness itself

- **The platform is virtual.** Real Slack rate limits, retries, event ordering
  under load, and partial outages are not exercised. The connection-surface guard
  bounds the drift but cannot eliminate it.
- **Normalization is above the boundary** (§1). The arena starts at the
  normalized message, so it cannot catch a normalizer defect.
- **Only two games install the echo** (§1.1). Werewolf and cross-room counting
  are referee-driven and therefore say nothing about implicit continuation.
- **Werewolf's dead players still participate in the conversation** (§3.3);
  only authoritative state is protected.
- **Scripted hosts are not models.** They make the engine's outcome a
  reproducible CI gate; they say nothing about whether a real model coordinates
  well. Only the real-subject runs speak to that, and only as repeated trials —
  §8.1 is explicit that real agents get observed reliability, never a reproducible
  single score.
- **Single daemon.** Every game runs in one daemon. Multi-daemon and real-relay
  topologies are §14 step 8 and are not measured here.
- **Delay, duplication and failure variants** (§14 step 7) are not implemented.
  The arena currently measures the happy transport path plus the protections.

Two known fidelity gaps in the harness, both currently harmless but worth naming
before a future game depends on them:

- **The echo's reconstructed claim omits `addressedAnyone`.** Production uses
  that bit to distinguish "named nobody" from "named only a human or third-party
  app," typically when the mention occurred in an earlier split section that is
  no longer visible in the final one. `VirtualResponseMetadata` has no such
  field, so the echo cannot preserve it. No current game produces that shape —
  the counting games never split a response around a human mention — but a
  routing game that did would see the eval daemon treat an addressed response as
  unaddressed.
- **Evaluation `listAgents` scopes an omitted request to the current channel.**
  The daemon's `ChannelAgentsRequest` documents `currentChannel` as trusted
  session context, not a scope request; an omitted `channel` means an org-wide
  listing. The evaluation directory falls back to `currentChannel`, so an
  org-wide call would come back conversation-scoped (and carrying `mention`
  tokens production would omit). No current game issues `listAgents({})`, so
  nothing measured here depends on it; a game that needs org-wide discovery must
  fix the scoping and add omitted-vs-explicit coverage together.

## 7. Measured versus inferred

Stated explicitly, since several claims above are structural rather than observed:

| Claim                                                       | Basis                                                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| The 99 contract tests pass, credential-free                 | **Measured**, this branch                                                                                     |
| The four acceptance cases behave as tabulated               | **Measured**, this branch                                                                                     |
| Werewolf plays to a winner with 0 canary leaks              | **Measured**, this branch                                                                                     |
| Normalization is not exercised                              | **Measured** by reading `injectPlatformEvent` — it builds the `NormalizedMessage` itself                      |
| Only counting/quota install the echo                        | **Measured** — `PlatformEcho` is constructed in `counting.ts` and `quota-counting.ts` only                    |
| Werewolf visibility admits dead players                     | **Measured** — the `visibleTo` predicate tests configured membership, not aliveness                           |
| Cross-room handoff is refused, naming `thread`              | **Measured**, this branch (assertion on the product's own error text)                                         |
| Leaderless rooms overshoot the target                       | **Measured**, this branch (scripted, 3 × 6)                                                                   |
| 4-bot quota counting stalls 0/8 at 29 accepted / 10 started | **Measured**, this branch (scripted)                                                                          |
| Real-model 2 × 20 → 10, entropy 1.0                         | **Measured on `main` @ 87d36bc**, carried forward unrefreshed                                                 |
| Real-model 4 × 8 → 8/8, entropy 0.70                        | **Measured on `main` @ 87d36bc**, carried forward unrefreshed                                                 |
| A 20-number 2-agent leaderless count _cannot_ finish        | **Inferred** from `MAX_AGENT_CALL_HOPS = 8` plus the absence of any override; consistent with the observed 10 |
| No hop-cap override exists                                  | **Measured** by exhaustive grep of config schema, CP env, and `.env.example`                                  |
| Participation unfairness under fan-out                      | **Measured** (agents that never spoke) — the _cause_ attributed to scheduling order is **inferred**           |
