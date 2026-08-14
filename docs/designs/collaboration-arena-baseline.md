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

### 1.1 The platform echo (every game except cross-room counting)

In the **echo-enabled** games — peer-driven counting, quota counting, and
Werewolf's day phase — every delivered agent post fans back to the other members'
connections under the author's **real managed bot identity**, as a streaming post
under its own message id plus a response-closing `message_changed` edit under the
same msgId, distinguished by `ingressEventTag` and carrying the daemon-stamped
authorship claim. Whether an echo activates anyone is the **daemon's** decision;
the harness never editorializes, and chatter echoes exactly like a valid move,
because production echoes everything.

**Cross-room counting does not install the echo.** Its phases are referee-driven:
waves come from human-sourced referee broadcasts and `deliverRefereeEvent`, so a
delivered agent post there does not fan back as a production-style inbound event.
That game therefore says nothing about implicit continuation, and its
conversation is bounded by the referee's cadence rather than by the protections.

## 2. The four routing acceptance cases

`evals/test/routing-acceptance.test.ts` — 8 tests, all green.

| Case   | Shape                             | Pinned behavior                                                                                                                                                                                                                   | Status |
| ------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **1**  | `sendMessage {toAgent, channel}`  | One visible root post, target activated **exactly once**, anchored to that single post; a thread reply reaches only the target. The target's mention is rendered into the visible root post.                                      | Green  |
| **1b** | `sendMessage {sessionId: parent}` | Session-only parent resume: **zero** new IM outbound while the parent still processes the reply; an explicit visible send from the resumed parent is still delivered.                                                             | Green  |
| **2**  | `sendMessage {channel}`           | Bare visible root post with **zero** activations; the author owns the resulting thread, and a human thread reply reaches only the author.                                                                                         | Green  |
| **3**  | Ordinary-reply mentions           | Agent-authored platform messages route: a finalized reply mentioning a peer activates it exactly once; an A→B→A chain advances one hop per edge until a protection stops it; unmentioned posts and self-mentions activate no one. | Green  |

Case 3 carries the design's test #16: **16 admitted edges in exact alternating
order**, asserted edge-by-edge rather than in aggregate — a duplicated activation
on any single edge cannot hide under an aggregate bound — and the edge past the
budget is refused with no dispatch behind it.

The design phrases this as running "until the cap". It no longer does: the chain
stops on the **automatic-turn budget** with hops to spare. See §6.1 — this is the
single most important thing that changed in the routing bounds, and the test now
pins the behavior rather than the design's wording.

Every suite also carries a regression pin that no turn is lost to
`session_source_mismatch` (issue #583, fixed by #568).

The same activation invariants are additionally pinned **per surface** by the
cross-surface parity suite ([`activation-parity.md`](activation-parity.md)):
one scenario spec (`evals/parity/spec.ts`), a Slack-shaped leg reusing this
routing fixture, and a webchat leg — with the governance rule that any
activation/routing change either keeps every leg green or declares the
divergence in the spec.

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

Seven agents by default, seeded roles (2 werewolves, 1 seer, 1 doctor, villagers
for the rest — the table scales past seven), a public room, a **real private wolf
den**, and per-player referee DMs.

**Every action is an ordinary message in the conversation it belongs to.** The
game registers no evaluation tools at all; the referee parses intent out of what
players actually say, where a human moderator would hear it:

| Action              | Conversation                  |
| ------------------- | ----------------------------- |
| `vote`              | the public day room, out loud |
| `kill`              | the wolf den, by the wolves   |
| `inspect`/`protect` | the actor's own referee DM    |

This replaced structured MCP tool calls, and the reason is that the tool channel
was **out of band with respect to the system under test**: a tool call never
traversed routing, produced no thread message, spent no automatic-turn budget,
and made the leak assertions weak because role visibility came from tool privacy
rather than from conversation membership. As messages, every action rides the
real path, and _a non-wolf literally cannot state a kill_ — the world's §7.2
authorization refuses the post before any parsing happens.

Parsing is deliberately strict and never coached: an action verb must be followed
by exactly one player alias inside the same sentence. Two different targets is
**ambiguous** and yields nothing. An actor that spoke in the right conversation
but never stated a readable action is recorded `unparseable`; one that never
spoke is `silent`. Neither is retried — stating your action clearly the first
time is part of what is measured. Authorization (phase, role, aliveness, one per
round) is unchanged, applied to the parsed intent.

**The day phase is sequential and peer-driven.** The referee opens each day
exactly once — deaths, living players, the speaking order, and the rule "speak
only after the player before you has spoken" — and then says nothing until the
order is finished or dead. Every step after that is carried by the players
themselves: a speech is delivered, the platform echo fans it to the other
members' connections, and the daemon's own routing ladder decides who wakes.
**No one is nominated.** Speaker N+1 is woken by speaker N's ordinary message,
which is exactly the PR #549 behavior — a verified agent-authored message naming
nobody continues the conversation through the arbitration ladder. Players who are
merely listening answer with the product's own `AC_NO_RESPONSE` silent branch, so
a listening turn produces no room traffic (but still costs a turn — see §6.5).

Measured per day and recorded in `game-result.json` / `world-events.jsonl`: the
announced order, who actually spoke and in what order, who never got their turn,
out-of-order speeches, what ended the round (`order_complete` / `stalled`), which
players' loop-guard circuits latched, per-player peer-wake accounting
(`admitted` / `gated` / `suppressed`), and whether the round reached the vote.

Once discussion completes or dies, the referee asks the living players to say
their votes out loud. Reasoning about voting _during_ discussion is ordinary
conversation and is not counted — the referee only reads votes once it has asked
for them.

The §6 evaluation tool registry still exists as a product capability and is
still covered by `packages/daemon/test/evaluation-game-tools.test.ts` — Werewolf
simply no longer uses it.

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

### 3.5 The webchat leg of the game matrix

Werewolf now runs in a SECOND composition —
`evals/games/webchat-werewolf.ts` + `webchat-werewolf-runner.ts`, gated by
`evals/test/webchat-werewolf.test.ts` — mapped onto ONE multi-agent **webchat
conversation** at the daemon seam (the same `handleRelayMsg` seam PR #906's
tests and the parity webchat leg drive), per the live single-conversation
runbook topology:

| Piece                    | Slack-shaped (§3.3)                        | Webchat leg                                                               |
| ------------------------ | ------------------------------------------ | ------------------------------------------------------------------------- |
| Public day speech, votes | Channel posts + platform echo              | Ordinary conversation posts, carried by the #906 continuation             |
| Role delivery            | Trusted referee DM (`deliverRefereeEvent`) | Postless `toAgent + needsReply` calls from the referee's session          |
| Night actions            | Player's own referee DM                    | `needsReply` calls; child reports back via `sendMessage {sessionId}`      |
| Wolf coordination        | REAL private den room                      | Referee-MEDIATED relay (propose → agree/counter), no den exists           |
| The referee              | Code referee on the trusted control path   | SCRIPTED SUBJECT AGENT acting through the real `sendMessage` tool surface |
| Phase pacing             | Referee waves                              | A reactive human HOST answering the referee's public "open night N" asks  |

**What each composition validates.** The Slack-shaped game pins room-membership
isolation, the platform echo, and the loop-guard/turn-budget bounds (§6.1–§6.5).
The webchat leg pins the OTHER half of the product: the `needsReply` delegation
round-trip into a live conversation session (exactly-once wakes, coalescing into
in-flight turns), the pre-addressed §5.2 fan-out, and the webchat hop budget —
with the referee composed exactly as a live model referee would be (its calls
run the trusted-session-context MCP path; only its brain is deterministic, and
for real-subject runs the same TypeScript brain drives a puppet ACP adapter,
`evals/games/puppet-acp-agent.mjs` + `puppet.ts`). Rules, roles and win logic
are shared (`evals/games/werewolf-rules.ts`) so the two compositions cannot
drift on the game itself.

Upstream of the full game sits the **night-collection scenario**
(`evals/games/night-collection.ts`, `evals/test/webchat-night-collection.test.ts`)
— the live night-1 failure shape in isolation: one host night-start, THREE
concurrent `needsReply` postless calls (wolf-A propose / seer inspect / doctor
protect) with public filler interleaved, plus the mediated wolf-B relay. Its
scripted cells pin, on current `main`:

- a child reply sent correctly (`sendMessage {sessionId}`) wakes the referee's
  session **exactly once**, whether as its own turn or coalesced into an
  in-flight turn whose input then still carries it (both shapes are recorded);
- a child that answers its delegation in **prose** (headless, no tool call) is
  a **lost** reply — the #905 validation cell, pinned `lost` because that IS
  current main;
- the referee-mediated relay leg round-trips end to end.

**What the webchat composition surfaced that the Slack-shaped one hid** (all
measured, recorded in the run artifacts, and — where deterministic — pinned):

- **A needsReply report is not private in a conversation-origin parent.** Since
  #926, a child's `sendMessage {sessionId}` report into a session whose origin
  is a webchat conversation is ALSO posted live into that conversation view (and
  fans §5.2 context copies to the whole roster). Night statements — "We kill
  player-1 tonight." — are visible to every player. The Slack composition's
  private den/DM rooms structurally hide this class. Pinned as
  `privateReportsPostedPublicly > 0`.
- **Sibling pairwise sessions share one transcript.** Every postless `toAgent`
  child of one caller lives on the same synthetic `a2a:<caller>` channel +
  thread, so a child's context refresh shows the referee's calls to its
  SIBLINGS — including role assignments — and their replies. Role secrecy in
  the webchat topology therefore depends on each child ignoring context rows
  addressed to others; the scripted players enforce that discipline explicitly.
- **A raw reply carries no sender label.** `messageAgent` deliveries render as
  `From <agent>: …`, but a `{sessionId}` reply is injected verbatim — a referee
  holding several concurrent `needsReply` calls cannot attribute a direct reply
  wake from the text alone. Coalesced replies, ironically, ARE attributable
  (they surface as `[<sender>] …` context rows).
- **The turn-final regeneration fence replaces the prompt with the delta** and
  silently discards the drafted answer; a policy that latches "I already acted"
  on its own draft loses actions. The scripted players carry the same
  observed-state discipline the Slack scripted host documents, plus an explicit
  regeneration escape hatch.

**Stage-1 real-model baseline — measured (2026-08-14).** The real-model
night-collection variant (`evals/test/webchat-night-collection-real.test.ts`;
scripted referee via the puppet adapter, real local Claude Code children over
ACP — the §4.1 recipe: node-launched claude-agent-acp, model pinned sonnet,
`permissionMode: default`, memory off) ran three trials. With PR #905
deliberately parked pending exactly this coverage, the loss rate measured here
**is the pre-#905 baseline** (the delegate-and-forward measurements ran
2/5–3/5 lost):

| Trial | Scoreable | needsReply replies owed (wolf-A / seer / doctor) | Lost    | Wolf-B relay reached  | Referee wakes |
| ----- | --------- | ------------------------------------------------ | ------- | --------------------- | ------------- |
| 1     | yes       | 3                                                | **3/3** | never (proposal lost) | 0             |
| 2     | yes       | 3                                                | **3/3** | never                 | 0             |
| 3     | yes       | 3                                                | **3/3** | never                 | 0             |

Every loss has the same shape, and it is exactly the live night-1 failure: the
child session runs, usually explores first (`ListAgents` in all nine cases,
once `ToolSearch`, once a terminal probe), and then answers the delegation as
its ORDINARY ASSISTANT RESPONSE — a correctly formatted single line
("`DOCTOR-REPORT: …`", "`SEER-REPORT: …`", "`WOLF-PROPOSAL: …`") that a
headless child delivers to nobody. Zero `sendMessage` calls, zero permission
requests, zero failed turns; the referee's session was never woken again, so
the mediated wolf-B relay never fired. 9/9 owed replies lost across the three
trials — at or above the historical baseline; the marker-formatted instruction
("answer with a single line starting …") plausibly biases the child further
toward prose than the free-form delegations of the earlier measurements.

A webchat Werewolf real run (`evals/test/webchat-werewolf-real.test.ts`) that
stalls at a night is therefore a VALID result: the runner records `stalledAt`
and the unanswered `needsReply` rows instead of failing.

## 4. Reproducing every result

Node 24 (`.nvmrc`) and pnpm 11. No model credentials required.

```bash
pnpm install
pnpm build # protocol must be built before typecheck

# the whole arena gate
pnpm eval:collab:contracts # 17 files, 119 tests

# the routing acceptance cases alone
pnpm eval:collab:routing # routing-acceptance + connection-surface

# individual scenarios
npx vitest run evals/test/counting.test.ts
npx vitest run evals/test/quota-counting.test.ts
npx vitest run evals/test/werewolf.test.ts
npx vitest run evals/test/webchat-night-collection.test.ts
npx vitest run evals/test/webchat-werewolf.test.ts
npx vitest run evals/test/cross-room-counting.test.ts
npx vitest run evals/test/game-runner.test.ts
npx vitest run evals/test/routing-acceptance.test.ts

# the sequential-discussion cases specifically
npx vitest run evals/test/werewolf.test.ts -t "sequential discussion"

# supporting suites
pnpm eval:contracts # evidence schema, ATIF, permission, redaction
pnpm eval:validate  # adapter/config validation + evals tsc
```

Full gate, measured on this branch:

| Suite                                                  | Tests   |
| ------------------------------------------------------ | ------- |
| `evals/test/routing-acceptance.test.ts`                | 8       |
| `evals/test/game-runner.test.ts`                       | 5       |
| `evals/test/werewolf.test.ts`                          | 18      |
| `evals/test/webchat-night-collection.test.ts`          | 2       |
| `evals/test/webchat-werewolf.test.ts`                  | 2       |
| `evals/test/quota-counting.test.ts`                    | 8       |
| `evals/test/cross-room-counting.test.ts`               | 6       |
| `evals/test/counting.test.ts`                          | 11      |
| `evals/test/world-authorization.test.ts`               | 10      |
| `evals/test/collaboration-game-provider.test.ts`       | 9       |
| `evals/test/game-result-assertion.test.ts`             | 7       |
| `evals/test/game-subject.test.ts`                      | 11      |
| `evals/test/connection-surface.test.ts`                | 5       |
| `evals/test/topology.test.ts`                          | 5       |
| `evals/test/virtual-connections.test.ts`               | 4       |
| `packages/daemon/test/evaluation-game-ingress.test.ts` | 5       |
| `packages/daemon/test/evaluation-game-tools.test.ts`   | 3       |
| **Total**                                              | **119** |

**0 expected-fail.** Every pin is an ordinary assertion.

### 4.1 Running a game against a real ACP runtime

The identical game runs against a real runtime by passing a subject template.
Two things must be true first, and the **real-subject preflight** now checks both
before a single wave is injected (`preflightRealSubject` in
`evals/games/subject.ts`), because each of them otherwise fails silently:

- **Every runtime in the template must actually launch.** The preflight spawns
  each one and fails with the child's own stderr if it exits immediately. A
  corrupted `npx` cache produces exactly that, and the symptom without the check
  is a game that admits every wave, produces zero agent effects, and burns its
  whole deadline before writing an empty world.
- **The template must use `permissionMode: default`.** A non-prompting mode
  (`dontAsk`) makes the runtime deny every AgentConnect tool locally, before the
  daemon ever sees a permission request, so no game action can land (§5.1).
  `auto` stalls on the runtime's classifier.
- **`AGENTCONNECT_DAEMON_ENTRY` must point at the built daemon bundle.** A real
  runtime reaches every AgentConnect tool through a `mcp-bridge` subprocess
  spawned from the daemon CLI; driving the arena from source makes
  `daemonEntryForShims` fall back to `process.argv[1]` (a Vitest worker), the
  bridge cannot start, and the ACP session comes up with **no tools at all** —
  no `sendMessage` and none of the §6 evaluation tools. Scripted hosts never use
  the bridge (they speak the control socket directly), so nothing in the scripted
  gate can catch it. This was measured, not theorized: see §5.1.

```bash
pnpm --filter @agentconnect.md/daemon build
export AGENTCONNECT_DAEMON_ENTRY="$PWD/packages/daemon/dist/index.js"
# then call runWerewolf({ subject: { kind: 'real', subjectRoot, templateAgentIds } })
```

## 5. Real-model runs

### 5.1 Sequential Werewolf, real local Claude Code

These are the **discussion-only** runs, measured before the permission blocker
below was fixed: real local Claude Code over ACP
(`npx -y @agentclientprotocol/claude-agent-acp@0.64.0`, model pinned to sonnet,
`permissionMode: dontAsk`, memory off, from-scratch workspace), five players, one
round, five trials. §5.2 has the full games. Real subjects get **observed reliability, never a
reproducible single score** (§8.1), so all five trials are reported.

| Trial | Seed | Order | Spoke | Outcome          | Out-of-order | Gated wakes | Latches |
| ----- | ---- | ----- | ----- | ---------------- | ------------ | ----------- | ------- |
| A     | 42   | 5     | **5** | `order_complete` | 0            | 0           | 0       |
| B     | 42   | 5     | **1** | `stalled`        | 0            | 0           | 0       |
| C     | 41   | 5     | **5** | `order_complete` | 0            | 0           | 0       |
| D     | 42   | 5     | **5** | `order_complete` | 0            | 0           | 0       |
| E     | 43   | 5     | **3** | `stalled`        | 0            | 0           | 0       |

Two facts, and they should be read together.

**The mechanism works, and works cleanly.** In every trial the referee opened the
day once and then said nothing; every speech that happened was **in order**, by
the announced next speaker, woken by the previous speaker's echoed post through
the ordinary routing ladder. Across five trials there were **zero out-of-order
speeches**, zero canary leaks, and zero unauthorized or wrong-room effects. The
speeches genuinely built on each other — _"let's hear from player-3 and player-5
before jumping to conclusions"_, _"I'd rather listen to player-5 and player-4
before forming an opinion"_, _"Now it's my turn, since player-1, player-2, and
player-3 have all spoken"_ — which is the behavior the sequential form exists to
make possible and which the concurrent broadcast form cannot produce.

**The order is not reliably carried to the end: 3 of 5 trials completed it.** The
two stalls are **not** a protection: gated wakes and loop-guard latches were zero
in every trial, and per-player admitted wakes stayed at 5–8, inside the budget
(§6.5). The next speaker was woken and simply did not take its turn. That is a
model-behavior result, not a system bound, and it is the one figure here that
would move with a different model, prompt, or table size.

For contrast, the scripted gate completes the order in **every** run at these
table sizes — so the harness, the echo, and the routing ladder are not what
varies.

**Trial B also produced the §4.1 finding.** It came up with
no AgentConnect tools at all: `AGENTCONNECT_DAEMON_ENTRY` was unset, so the
`mcp-bridge` subprocess was spawned from the Vitest worker instead of the daemon
CLI and never started. The models improvised in prose — _"There's no dedicated
kill/night-action tool available to me"_, _"I don't have a vote tool available in
this environment"_ — and searched their own runtime's deferred tool list for
`inspect`/`protect`/`vote`, finding nothing. Nothing in the harness reported a
fault; the run was `passed` with `acceptedActions: 0`. That is precisely the class
of silent real-subject failure the preflight now refuses to let happen.

**Why no real game could reach a winner, and what fixed it.** With the bridge
entry corrected the tools appear correctly as `mcp__agentconnect__vote` /
`…__inspect` / `…__protect`, and the models reach for them — then every call
failed, so there was no lynch, no night kill, and no win condition
(`acceptedActions: 0` in every trial).

The mechanism, measured rather than assumed — and it is **not** the daemon's
auto-allow set, which an earlier revision of this document wrongly blamed:

- The daemon records **zero `permission.*` events** for an entire real run. The
  ACP `session/request_permission` is never sent, so `isBuiltinSystemTool` is
  never consulted at all.
- Claude Code denies **locally, inside the runtime**, 24–31 times per run:
  _"Permission to use `mcp__agentconnect__protect` has been denied because Claude
  Code is running in don't ask mode."_ `dontAsk` means "do not prompt, DENY if
  not pre-approved".

Three subject-side pre-approvals were tried and all failed: workspace
`.claude/settings.json` + `settings.local.json` (both rule shapes) are written
and survive the run but are **not honored**; relocating the user tier with
`CLAUDE_CONFIG_DIR` takes the runtime's authentication with it (`infra_error`,
zero peer wakes); `permissionMode: auto` stalls on the classifier.

So a headless real subject must run in `permissionMode: **default**`, where the
request does reach the daemon — and the daemon must then be willing to approve a
game's own tools without a card, because a headless run has no card surface (its
fallback is to hold the request, which is what made `auto` hang).

That is the one **daemon** change this work required
(`isBuiltinSystemTool` / `isBuiltinSystemToolCall`): the auto-allow set is no
longer the hardcoded product list but _the tools this daemon actually registered
on its own reserved `agentconnect` MCP server for that session_. The scoping is
the whole point and is pinned by tests:

- the extra names come from `evaluation.environment.tools`, injected in-process
  at Daemon construction — no wire, agent, peer, CP or config path can add one;
- that registry is **empty in production**, so behavior there is unchanged;
- a name only matches under the reserved `agentconnect` prefix, so the same name
  on any other MCP server still gets its card (negative test);
- startup already rejects an evaluation tool that shadows or duplicates a product
  tool, and the runtime's dangerous built-ins (Bash/Edit/…) are not in the set.

### 5.2 Full real-model games, played to a winner

Once the permission blocker above was removed (`permissionMode: default` plus the
daemon's reserved-server auto-allow), real Claude Code plays the **whole** game:
night → sequential day discussion → structured vote → resolution, repeating
until a faction wins. Same runtime and model as §5.1.

| Trial | Players | Seed | Winner         | Rounds | Actions (vote/kill/inspect/protect) | Order completion | Leaks |
| ----- | ------- | ---- | -------------- | ------ | ----------------------------------- | ---------------- | ----- |
| 1     | 5       | 81   | **village**    | 2      | 14 (9 / 1 / 2 / 2)                  | 2 of 2 days      | 0     |
| 2     | 5       | 91   | **werewolves** | 1      | 3 (0 / 1 / 1 / 1)                   | no day reached   | 0     |
| 3     | 5       | 92   | **werewolves** | 2      | 14 (8 / 2 / 2 / 2)                  | 2 of 2 days      | 0     |
| 4     | 7       | 101  | **werewolves** | 3      | 16 (10 / 3 / 1 / 2)                 | 2 of 2 days      | 0     |
| 5     | 7       | 102  | **werewolves** | 2      | 11 (6 / 2 / 1 / 2)                  | 1 of 1 day       | 0     |

All five trials reached `terminalReason: completed` with a real win condition
satisfied by the survivors, and **zero** canary leaks, zero unauthorized effects,
zero wrong-room messages, zero gated peer wakes and zero loop-guard latches.
Across every day of every game the speaking order was completed **in order**:
`speechesDelivered == speakingTurnsOwed`, `outOfOrderSpeeches: 0`,
`speakersNeverReached: 0`. Nothing stalled.

Village won 1 of 5 — a small sample, and not something to read as a balance
result.

**Seven players is where the day phase carries the game.** Trial 4 ran the full
three-round arc: night 1 killed the seer; day 1's six-player order completed and
lynched `player-2`, a **werewolf**; night 2 killed a villager; day 2's four-player
order completed and lynched the doctor; night 3's kill left one wolf against one
villager, and the **werewolves won** on `livingWolves >= livingOthers`. Ten
speeches, ten owed, **zero out-of-order**, both days `order_complete`, 96
admitted automatic turns with **zero** gated.

**A five-player table can end before any discussion.** Trial 2 is not a failure:
with 2 wolves and 3 villagers, one successful night-1 kill makes it 2-vs-2 and
the werewolves win by the ordinary condition (`livingWolves >= livingOthers`)
before a day ever opens. That is why `daysOpened: 0` there, and why seven players
is the size at which the day phase reliably matters.

Trial 1 is the fullest example, and the game reads like Werewolf:

- **Night 1** — doctor protects itself, seer inspects `player-1`, the two wolves
  coordinate in the den (`"Wolf pack check-in: I'll go with player-1 as tonight's
target"` → `"Agreement confirmed … calling the kill"`) and kill `player-1`.
  The doctor's save lands: nobody dies.
- **Day 1** — all five speak once, in the announced order, no out-of-order
  speeches. Vote: `player-2` lynched, revealed a **werewolf**.
- **Night 2** — seer inspects `player-5` and learns it is a wolf; the surviving
  wolf's kill never resolves.
- **Day 2** — all four speak in order; the seer, now holding the read, votes
  `player-5`, joined by the doctor and the villager. `player-5` lynched, revealed
  the second **werewolf** → **village wins**, both wolves lynched.

The private information really did travel the private channels: the seer's result
arrives as a referee DM (`"Got it — player-5 is a werewolf"` in its own DM, never
in the room), the wolves coordinate only in the den, and the canary assertions
confirm no private content reached the public room.

**The per-round budget reset carries the game across rounds.** Trial 1 spent 52
admitted automatic turns and trial 3 spent 48 — far past the 8-per-window budget
— with **zero** gated wakes, because each round's referee `DAY`/`VOTE` broadcast
is a trusted human turn that resets the automatic counter (§6.5).

### 5.3 Natural-language actions, and the 60-second window

Actions became messages (§3.3). That doubles what a day costs the public room —
the discussion AND the votes now travel it — so the automatic-turn budget was
expected to bind much harder. It does, but **only in scripted runs**, and the
reason is timing rather than design.

**Scripted, 7 players, seed 42 — collapses.** Every circuit latches at exactly
`admitted: 8`, and rounds 2+ are empty: `votesCast: 0`, every actor `silent`,
`terminalReason: round_limit`, no winner. The two wolves absorb more (14) because
they hold **two** circuits — the public room and the den are different channels,
so different loop-guard scopes.

**Real local Claude Code, 7 players — all three trials complete.**

| Trial | Seed | Winner         | Rounds | Admitted | **Gated** | Latches | Unparseable | Leaks |
| ----- | ---- | -------------- | ------ | -------- | --------- | ------- | ----------- | ----- |
| 1     | 201  | **werewolves** | 2      | 91       | **0**     | **0**   | **0**       | 0     |
| 2     | 211  | **werewolves** | 2      | 95       | **0**     | **0**   | **0**       | 0     |
| 3     | 212  | **werewolves** | 3      | 117      | **0**     | **0**   | **0**       | 0     |

The difference from scripted is the **60-second window**, and the per-round wall
clock shows it directly:

| Trial | Round | Wall-clock span | Admitted per player | Gated |
| ----- | ----- | --------------- | ------------------- | ----- |
| 1     | 1     | t = 0–90 s      | 7–11                | 0     |
| 1     | 2     | t = 105–135 s   | 3–5                 | 0     |
| 2     | 1     | t = 0–128 s     | 6–**14**            | 0     |
| 2     | 2     | t = 143–176 s   | 1–5                 | 0     |
| 3     | 1     | t = 0–115 s     | 8–11                | 0     |
| 3     | 2     | t = 139–223 s   | 5–9                 | 0     |
| 3     | 3     | t = 251–266 s   | 2                   | 0     |

Round 1 spans 90 s, **128 s** and 115 s across the three trials — longer than the window,
so it rolls over _inside_ the round. That is why players absorbed **11** and
**14** admitted automatic turns without ever being gated, against a nominal
budget of 8. Each round 2 then starts on a fresh window. A scripted game does the
same work in about two seconds, so all of it lands in one window and the budget
never refreshes.

**Conclusion: the natural-language design works in real time.** The scripted
collapse is an artifact of scripted speed, not a limit of the design. It is still
pinned as a test (`SCRIPTED BOUNDARY: a seven-player game exhausts the budget
inside one 60s window`) because it is a real property of the gate — a scripted
7-player game cannot be used to measure multi-round play, and the 5-player
scripted game is the one that plays through to a winner.

**Real agents state their actions clearly enough to parse: `unparseableActions: 0`.**
Night actions arrived as _"I inspect player-1."_ and _"I protect player-4."_ in
the actor's own DM; votes as _"player-7: I vote for player-2."_ in the room.

**The wolves genuinely coordinated**, which the tool path could never show —
independent submissions never had to agree. Night 1 in the den:

> **player-6:** I'll go with player-3, they seem like a likely threat — thoughts?
> **player-1:** Works for me — we kill player-3.
> **player-6:** Agreed, we kill player-3.

Night 2 opens with a rationale drawn from the day: _"Player-4 was quiet during the
day and could be dangerous later — I'd suggest we kill player-4. Any objections?"_
→ _"No objection, we kill player-4."_ The redundant confirmations are exactly the
4 `duplicateActions`: the pack gets one kill, and the first clear statement
carries.

What did **not** go cleanly, stated plainly, because it is the honest limit here:
trials 1 and 2 left votes uncast (3 and 2 of 6 eligible; `silentActors: 3` in
each), while trial 3 collected all six. Trial 2's day-1 speaking order also
stalled at 3 of 6 speakers, where trials 1 and 3 completed every order. **None
of that was a protection** — zero gated wakes and zero latches in all three runs
— so it is model behavior: players finish the discussion and then sometimes
never say a vote. Sequential order quality is excellent _when players speak_
(**0 out-of-order across all three trials**); whether every player speaks at all
is the softer signal.

### 5.4 Peer-driven counting (historical)

> **Provenance — read before quoting these.** These numbers were measured on
> **`main` @ 87d36bc** with real local Claude Code over ACP (model sonnet). They
> are **carried forward unrefreshed**: they have not been re-measured since.
>
> They were also measured **when `MAX_AGENT_CALL_HOPS` was 8**. #628 has since
> raised it to 20, so the depth-limited run below would terminate differently
> today — and, per §6.1, on a different protection. Treat the **coordination
> quality** figures (entropy, duplicates, regenerations) as the durable signal
> and the **depth** figures as historical.
>
> Everything in §2, §3, §4, §5.1–§5.3 and §6 **was** measured on the current branch.

Both runs use the peer-driven variant: one human-sourced start message, then a
silent referee.

**2 agents, target 20 — reached 10/20** (at the then-current hop cap of 8).

| Metric                | Value                                      |
| --------------------- | ------------------------------------------ |
| Numbers landed        | 10 of 20                                   |
| Terminated by         | Hop cap of 8 (`unrouted` on the next echo) |
| Structure             | Human-seeded wave + 8 agent-to-agent edges |
| Participation entropy | 1.0 (perfect alternation)                  |
| Duplicate posts       | 0                                          |
| Regenerations         | 1                                          |
| Final admissions      | 9 admitted + 1 `unrouted`                  |

The 10 was not a coordination failure — it was the hop budget of the day,
exactly. Coordination quality was perfect over the whole budget. For contrast,
before #568 the same run stalled at 2 with `session_source_mismatch` at hop 1.

Under today's constants the same run would be bounded at 16 agent-to-agent edges
by the automatic-turn budget rather than at 8 by the cap (§6.1). **That
prediction is inferred, not measured** — it follows from the scripted chain
result, but no real-model run has been done since #628.

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

### 6.1 The raised hop cap is unreachable — the automatic-turn budget binds first

Two protections bound an agent-to-agent chain, and **which one binds changed
under this branch's feet**:

| Bound                            | Where                                     | Value                          |
| -------------------------------- | ----------------------------------------- | ------------------------------ |
| `MAX_AGENT_CALL_HOPS`            | `packages/protocol/src/consts.ts`         | **20** (was 8, raised by #628) |
| `MAX_AUTOMATIC_TURNS_PER_WINDOW` | `packages/daemon/src/daemon.ts` (private) | **8** per agent per 60 s       |

`MAX_AGENT_CALL_HOPS` is a **single shared constant** — the daemon, both relay
paths, and the CP import the same value, deliberately, so a relayed chain cannot
outlive the budget an internal chain gets. There is **no per-conversation,
per-agent, or environment override anywhere on `main`** (verified: no
config-schema key, no CP env key, no `.env.example` entry). The loop guard's
budget has no override either, and its latch is durable — only `!resume` clears
it.

**Measured on this branch:** a two-agent A→B→A chain advances one hop per edge in
strict alternation, exactly once per finalized response, and stops at **16
edges** — with **4 hops still unspent**. Each agent spent exactly its 8 automatic
turns. Raising only `MAX_AUTOMATIC_TURNS_PER_WINDOW` lets the identical chain run
to hop 20 and stop on the cap instead, which is how the attribution was
confirmed rather than inferred from arithmetic.

So after #628 the hop cap is **not** the operative limit for a leaderless
two-agent room; the automatic-turn budget is, at `2 × 8 = 16` edges. Raising the
hop cap alone does not lengthen such a conversation.

Consequence for the probe: a conversation carried purely by agent continuations
gets the initial human-sourced wave plus 16 agent-to-agent edges, so with two
participants roughly **17 numbers**. A longer target still needs a human or
referee message to re-seed the budget. The arena cannot measure leaderless
coordination **quality** past that depth — beyond it, the metric measures the
protection.

None of this is a defect. It is two protections composing, and the composition is
worth stating plainly because the design's "advances until the cap" is currently
unreachable.

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

This same budget is what stops the A→B→A chain in §6.1, and the two facts belong
together: the automatic-turn budget is now the operative bound on agent-to-agent
conversation in **both** the narrow (2-agent chain) and wide (4-bot fan-out)
regimes, while the hop cap binds in neither.

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

### 6.5 A sequential speaking order is bounded at nine speakers per referee-opened round

This is what sequential Werewolf measures, and it is a different bound from §6.1
and §6.3 even though it comes out of the same budget.

A day of sequential discussion costs every participant **one automatic turn per
other participant's speech**, whether or not they say anything: the echo of each
speech is real ingress on every other member's connection, and the listening
turn — even one that answers `AC_NO_RESPONSE` and posts nothing — is charged to
that member's loop-guard circuit. So the player at position _i_ in the order must
absorb _i_ automatic turns before their own turn arrives.

`MAX_AUTOMATIC_TURNS_PER_WINDOW` is **8**, so position 8 (the **ninth** speaker)
is the last one the budget can carry, and position 9 is refused. Measured,
scripted, seed 42, varying only the table size:

| Players | Day-1 order | Speakers reached | Outcome          | Gated wakes | Circuits latched |
| ------- | ----------- | ---------------- | ---------------- | ----------- | ---------------- |
| 7       | 6           | 6                | `order_complete` | 0           | 0                |
| 9       | 8           | 8                | `order_complete` | 0           | 0                |
| 10      | 9           | 9                | `order_complete` | 8           | 1                |
| 11      | 10          | **9**            | `stalled`        | 16          | 2                |
| 12      | 11          | **9**            | `stalled`        | 24          | 3                |

Nine is exact, not approximate, and the arithmetic is visible in the artifacts:
**every latched player shows `admitted: 8` followed by `gated`**, never 7 and
never 9. Seed 9 reproduces the 12-player row identically.

Three consequences worth stating plainly:

- **The bound is per ROUND, not per game.** A seven-player table absorbs 9–10
  admitted automatic turns over a two-day game and is never refused once. That is
  possible only because the referee's `DAY`/`VOTE` broadcasts are trusted **human**
  turns, and a human turn RESETS the automatic counter to zero
  (`recordLoopGuardTurn` in `packages/daemon/src/store/local-store.ts`: the
  automatic count is cleared on any non-automatic admission). Each referee message
  hands the room a fresh budget; what has to fit inside one budget is a single
  round of discussion.
- **The latch is durable and takes the player out of the game, not just the
  round.** Only `!resume` clears it and nobody sends one, so a latched player
  never speaks again — and cannot even be reached by the referee's `VOTE`
  broadcast, because an open circuit blocks human turns too. The measured
  consequence is `incompleteVotes`: the day still reaches a vote, with fewer
  ballots than living players.
- **Dead players consume the budget too.** They stay in the room's broadcast
  membership (§3.3's pre-existing limitation), so they absorb every echo. In the
  10-player row above, the single latched circuit belongs to the night-1 victim —
  a player who had nothing left to say and burned its whole budget listening.

None of this is a defect. It is the automatic-turn budget doing its job against a
conversation shape that costs O(N) turns per participant per round. It does mean
the arena cannot measure sequential-discussion quality in a room of more than
nine active speakers per referee message.

### 6.6 Scope limits of the harness itself

- **The platform is virtual.** Real Slack rate limits, retries, event ordering
  under load, and partial outages are not exercised. The connection-surface guard
  bounds the drift but cannot eliminate it.
- **Normalization is above the boundary** (§1). The arena starts at the
  normalized message, so it cannot catch a normalizer defect.
- **Cross-room counting does not install the echo** (§1.1). It is referee-driven
  and therefore says nothing about implicit continuation.
- **Werewolf's dead players still participate in the conversation** (§3.3);
  only authoritative state is protected. Since the day phase became sequential,
  that is no longer only a reporting caveat — a dead player absorbs the same
  automatic-turn budget as a living one (§6.5).
- **A sequential order longer than nine speakers cannot be measured** (§6.5).
- **A real subject cannot call the §6 evaluation tools** (§5.1). They are listed
  correctly, but the daemon's auto-allow set is the static product tool list, so
  they fall through to an interactive permission policy that a headless run has
  no surface for. Real-subject runs therefore measure conversation, not
  structured game actions.
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

| Claim                                                       | Basis                                                                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| The 115 contract tests pass, credential-free                | **Measured**, this branch                                                                                                                         |
| The four acceptance cases behave as tabulated               | **Measured**, this branch                                                                                                                         |
| Werewolf plays to a winner with 0 canary leaks              | **Measured**, this branch                                                                                                                         |
| Normalization is not exercised                              | **Measured** by reading `injectPlatformEvent` — it builds the `NormalizedMessage` itself                                                          |
| Only cross-room counting omits the echo                     | **Measured** — `PlatformEcho` is constructed in `counting.ts`, `quota-counting.ts` and `werewolf.ts`                                              |
| Werewolf visibility admits dead players                     | **Measured** — the `visibleTo` predicate tests configured membership, not aliveness                                                               |
| Cross-room handoff is refused, naming `thread`              | **Measured**, this branch (assertion on the product's own error text)                                                                             |
| Leaderless rooms overshoot the target                       | **Measured**, this branch (scripted, 3 × 6)                                                                                                       |
| 4-bot quota counting stalls 0/8 at 29 accepted / 10 started | **Measured**, this branch (scripted)                                                                                                              |
| A 2-agent chain stops at 16 edges, not the hop cap of 20    | **Measured**, this branch (scripted A→B→A chain)                                                                                                  |
| ...and the automatic-turn budget is what stops it           | **Measured by construction** — raising only `MAX_AUTOMATIC_TURNS_PER_WINDOW` lets the same chain reach hop 20                                     |
| Werewolf's day advances on peer messages, not the referee   | **Measured**, this branch — one referee event per day between open and close, each speech preceded by the previous speaker's echo                 |
| A sequential order stops at exactly 9 speakers per round    | **Measured**, this branch (scripted, tables of 7/9/10/11/12, seeds 42 and 9)                                                                      |
| ...because each latched player absorbed exactly 8 wakes     | **Measured** — every latched circuit reports `admitted: 8` then `gated`                                                                           |
| A referee (human) message resets the automatic counter      | **Measured** — 7-player players absorb 9–10 admitted automatic turns across a game with zero refusals; confirmed by reading `recordLoopGuardTurn` |
| A latched player cannot receive the referee's VOTE either   | **Measured** — `incompleteVotes ≥ 1` on every stalled table                                                                                       |
| Real Claude Code speaks strictly in order when it speaks    | **Measured**, this branch — 0 out-of-order speeches across 5 trials (§5.1)                                                                        |
| ...but carries the order to the end in only 3 of 5 trials   | **Measured**, this branch (§5.1); both stalls had 0 gated wakes and 0 latches, so no protection was involved                                      |
| A real subject with a bad MCP bridge entry loses ALL tools  | **Measured**, this branch (§5.1 trial B) — now refused by the preflight                                                                           |
| Real Claude Code plays Werewolf to a winner, multi-round    | **Measured**, this branch (§5.2) — 4 games, 4 winners, 1–3 rounds, 0 leaks                                                                        |
| A 5-player table can end at night 1 with no day at all      | **Measured** (§5.2 trial 2) — 2 wolves vs 3 others, one kill makes it 2-vs-2                                                                      |
| The per-round budget reset carries a multi-round game       | **Measured** — 48–96 admitted automatic turns per game, 0 gated                                                                                   |
| A real subject's tool calls were denied INSIDE the runtime  | **Measured** — the denial text names `don't ask mode`, and the daemon logs zero `permission.*` events for the whole run                           |
| Werewolf's actions are messages, parsed per conversation    | **Measured**, this branch — the game registers no evaluation tools at all                                                                         |
| A non-wolf cannot even post a kill statement in the den     | **Measured** — the world's §7.2 authorization rejects the post before parsing                                                                     |
| Real agents state actions clearly enough to parse           | **Measured** — `unparseableActions: 0` in both real 7p trials                                                                                     |
| The wolves actually negotiate in the den                    | **Measured** — proposal → rationale → "any objections?" → agreement, with the redundant confirmations deduped                                     |
| Scripted 7p collapses inside ONE 60s loop-guard window      | **Measured**, this branch — every circuit latches at `admitted: 8`                                                                                |
| ...and that is scripted SPEED, not the design               | **Measured** — real 7p rounds span 90–128 s, the window rolls, and all 3 trials complete with 0 gated                                             |
| Real games still leave votes uncast                         | **Measured** — 3 and 2 votes of 6 eligible, with 0 gated and 0 latches, so model behavior not protection                                          |
| ...so the daemon's auto-allow set was never the blocker     | **Measured** — an earlier revision of this document claimed it was; the request never reaches the daemon at all                                   |
| Workspace `.claude/settings.json` pre-approval is ignored   | **Measured** — files written and confirmed surviving the run, tools still denied                                                                  |
| `CLAUDE_CONFIG_DIR` relocation breaks the runtime's auth    | **Measured** — `infra_error`, 0 peer wakes, 32s collapse                                                                                          |
| Real-model 2 × 20 → 10, entropy 1.0                         | **Measured on `main` @ 87d36bc, when the hop cap was 8**; carried forward unrefreshed                                                             |
| Real-model 4 × 8 → 8/8, entropy 0.70                        | **Measured on `main` @ 87d36bc**, carried forward unrefreshed                                                                                     |
| The same real-model run would now stop at 16 edges          | **Inferred** from the scripted chain result; no real-model run has been done since #628                                                           |
| A long leaderless count still cannot finish unaided         | **Inferred** from the 16-edge bound plus the absence of any override                                                                              |
| No hop-cap or loop-guard override exists                    | **Measured** by exhaustive grep of config schema, CP env, and `.env.example`                                                                      |
| Participation unfairness under fan-out                      | **Measured** (agents that never spoke) — the _cause_ attributed to scheduling order is **inferred**                                               |
