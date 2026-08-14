# Activation Parity Across Surfaces

Companion to [`send-message-routing-rework.md`](send-message-routing-rework.md)
(the platform ladder), [`webchat-multi-agents.md`](webchat-multi-agents.md)
(webchat activation), and
[`collaboration-arena-baseline.md`](collaboration-arena-baseline.md) (the
measured behavior of the platform ladder). This document defines the **parity
suite** and the governance rule attached to it.

## 1. Why this exists

"Who does this message activate" is implemented more than once:

1. **The daemon platform ladder** — the pure decision logic now lives in
   `@agentconnect.md/activation-policy` (`routeRules`, kind precedence
   mention > dm > keyword > auto, the conversation-peer selection, and the
   §4.1 hop gates), consumed through the thin adapter
   `packages/daemon/src/router/routing-table.ts` by the verified agent-author
   ladder in `packages/daemon/src/daemon.ts` (`routeVerifiedAgentMessage` /
   `fanOutToThreadPeers`), including the #549 rung: a verified agent-authored
   message naming nobody continues the conversation with the author excluded,
   hop-bounded.
2. **The relay's arbitration** for relayed platform ingress —
   `packages/relay/src/bot-arbitration.ts`, the "same rules" per
   send-message-routing-rework.md §6, but a separate implementation over
   already-attributed routes.
3. **Webchat multi-agent activation** — roster/standing-mention semantics
   (webchat-multi-agents.md §4.2), with agent-continuation parity added by
   PR #906 (`maybeActivateWebchatContinuation`, §5.2a). Since the webchat
   fold-in these decisions are package-owned too: the relay consumes
   `selectTurnTargets` (human-turn roster targeting) and the daemon consumes
   `webchatContinuationDecision` (the §5.2a edge) from
   `@agentconnect.md/activation-policy`, each through a thin adapter.

Copy 3 missed the #549 policy change **for months**: after #549 flipped the
platform ladders to conversation continuation, webchat kept treating agent
posts as pure context, so an alternating multi-agent conversation ran to
completion on Slack and stalled after one round on webchat (issue #904, fixed
by PR #906). Nothing failed while the copies drifted — that silence is the
defect this suite removes.

The shared machinery **below** the ladders — sessions/turns, the regeneration
fence, the hop cap (`MAX_AGENT_CALL_HOPS`), the durable loop guard, the
activation rendezvous — is single-implementation and is _not_ re-pinned here
beyond what the scenarios observe through it.

## 2. The suite

One surface-agnostic scenario spec, several per-surface legs:

- **Spec:** [`evals/parity/spec.ts`](../../evals/parity/spec.ts) — each
  scenario is data: an invariant sentence plus per-surface expected outcomes in
  one vocabulary (`mentioned-only`, `roster`, `participants-minus-author`,
  `target-exactly-once`, `parent-exactly-once`, `nobody`, chain-refusal
  reasons). Where surfaces intentionally differ, the spec carries a
  **declared divergence** with design-doc citations.
- **Slack-shaped leg:** `evals/test/parity-slack.test.ts` — the arena routing
  fixture (`evals/test/routing-fixture.ts`): a real daemon, one mention-gated
  Slack-shaped room, scripted hosts, production-style platform echo.
- **Webchat leg:** `evals/test/parity-webchat.test.ts` — the daemon-level seam
  the #906 tests drive (`handleRelayMsg` + played relay fan-out), via the
  shared fixture `packages/daemon/test/webchat-continuation-fixture.ts`. The
  kickoff scenario computes its turn-vs-context split with the relay's
  PRODUCTION target choice (`selectTurnTargets` — package-owned in
  `@agentconnect.md/activation-policy`, re-exported by
  `packages/relay/src/relay-browser-connection.ts`), so the roster-wide vs
  mention-narrowed decision is the deployed code, not a re-implementation.
- **Spec guard:** `evals/test/parity-spec.test.ts` — the spec itself stays
  well-formed (unique ids, expectation xor declared-not-applicable per surface,
  undeclared cross-surface differences fail, citations point into
  `docs/designs/`).

Each leg iterates the spec and must implement a driver for every scenario the
spec declares for its surface — a scenario added to the spec without a driver
fails the leg's coverage guard. Every driver additionally **pins its
scenario's declared outcome with an exact `toEqual`**
(`declaredOutcome(scenario.expect[surface])`), so the spec is load-bearing in
both directions: editing an expectation fails the driver that demonstrates the
old outcome, and a behavior change fails the driver's measured assertions. All
of it is credential-free and runs in the Unit Test CI gate: `pnpm eval:parity`.

The relay's arbitrate ladder has no leg yet; it is pinned by its own unit suite
(`packages/relay/src/bot-arbitration.test.ts`) and inherits the daemon
expectations by construction ("same rules", §6). The single policy module now
exists (`@agentconnect.md/activation-policy`, consumed by the daemon); the
relay leg lands when the relay is folded onto it — the module's header
documents how `AttributedRoute`s and the affinity map plug into the same
functions.

### 2.1 Declared per-surface divergences (as of this writing)

- **Human kickoff** — channels are mention-gated per message
  (shared-channel convention); webchat roster membership _is_ the standing
  mention, so an unnarrowed kickoff activates the whole roster
  (webchat-multi-agents.md §4.2).
- **Which protection terminates an unattended chain** — both surfaces charge
  the same +1 hop per edge against `MAX_AGENT_CALL_HOPS`, but channels _also_
  charge the durable loop guard, whose automatic-turn budget binds first
  (16 edges for a two-agent room, refusal reason `gated`;
  collaboration-arena-baseline.md §6.1). Webchat deliberately charges only the
  exact hop cap — it has no in-band `!resume` to reset a guard latch — so the
  same chain runs to the cap and is refused there (`hop_limit`;
  webchat-multi-agents.md §5.2a).

## 3. Governance rule

**Any PR that changes activation/routing behavior — the daemon ladder, the
relay arbitration, webchat activation, or the verified-author continuation —
must update the parity spec.** Concretely, one of:

1. every applicable leg still passes against the unchanged spec (a pure
   refactor), or
2. the spec's expected outcomes change **for every surface together**, and
   every leg passes against the new expectations, or
3. the change is intentionally per-surface, and the spec records it as a
   **declared divergence** with a citation into `docs/designs/`.

A leg failing while the others pass is the incident shape of #549/#904/#906 —
the fix is never to loosen the failing leg locally, it is to decide (1)–(3)
explicitly in the spec. Reviewers: treat a diff that touches
`packages/daemon/src/router/`, the daemon's verified-author ladder,
`packages/relay/src/bot-arbitration.ts`, or
`maybeActivateWebchatContinuation` without touching `evals/parity/spec.ts` as
requiring an explanation.

## 4. Running it

```bash
pnpm eval:parity # spec guard + both legs (credential-free)
```

The legs also run file-by-file:

```bash
pnpm exec vitest run evals/test/parity-slack.test.ts
pnpm exec vitest run evals/test/parity-webchat.test.ts
```
