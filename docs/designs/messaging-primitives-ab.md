# Tool-surface A/B: `sendMessage` (shipped) vs `post` (messaging primitives)

Status: **complete.** Apparatus landed and contract-proven; static costs
measured; the full 24-run behavioral matrix ran on 2026-08-09 (local Claude
Code over ACP, model `sonnet`) with 24/24 valid trials — results in §6,
conclusion in §7. **2026-08-11:** the matrix gained scenario 5 (in-thread
turn-taking, the #801 regression gate — §8) after a prompt change validated
only against parent-session caused a live in-thread regression; §8 also
records the standing prompt-change gate that incident created.

The question under test, verbatim from the request that started this work:
**how much does the primitives design improve success rate and total token
consumption?** The primitives design is the `post` write primitive of the
messaging-primitives proposal (PR #551); the baseline is the `sendMessage`
surface as shipped. When that proposal lands on `main`, its doc and this one
should link to each other (deliberately not done while #551 is an open PR).

## 1. The two arms

| Arm | Surface the model carries                         | Implementation that executes |
| --- | ------------------------------------------------- | ---------------------------- |
| A   | product `sendMessage`, production guidance text   | product `sendMessage`        |
| B   | `post` (3 orthogonal params), arm-B guidance text | product `sendMessage`        |

Arm B is a **façade** (`evals/games/post-facade.ts`): every `post` call
compiles into exactly one legal `sendMessage` input and is executed by the
product tool on the same trusted session context. No routing, activation,
addressing or policy code differs between arms — a measured difference is
attributable to the _surface_, not to a second implementation.

Three evaluation-only seams make the comparison fair, and each is
contract-tested in the CI gates:

- **`executeProductTool`** (`packages/daemon/src/mcp/control-server.ts`) — an
  evaluation-registry tool may run a product tool on the caller's own trusted
  `SessionContext`. Grants nothing the caller didn't have.
- **`hideProductTools`** (`packages/daemon/src/daemon.ts`) — withhold named
  product descriptors for a run so each arm presents exactly one surface for
  the capability. A withheld tool stays fully executable, which is precisely
  how the façade compiles down to it.
- **`collaborationGuidance`** (`packages/daemon/src/session/session-manager.ts`)
  — the prompt-side complement of `hideProductTools`. The standing
  collaboration guidance and the parent-report append teach `sendMessage`
  call shapes _by name_; without this seam, arm B would carry a system prompt
  describing a tool it does not have — priming it with arm A's vocabulary and
  telling it to call a tool absent from its list. Arm B's texts mirror the
  production structure sentence-for-sentence outside the tool teaching
  (pinned by tests in `evals/test/post-facade.test.ts`).

`evals/test/tool-surface-ab-fixture.test.ts` proves the composed result
against a real daemon: arm A sessions list `sendMessage` (no `post`) and
carry the production guidance; arm B sessions list `post` (no `sendMessage`),
their prompt contains no `sendMessage` text anywhere, a compiled call
produces a real world-authorized delivery, and a `needsReply` wake installs
the `post`-flavored parent-report append on the child.

## 2. Method (pre-registered)

**Matrix**: 4 scenarios × 2 arms × 3 trials = 24 runs, local Claude Code over
ACP (`claude-acp`, model pinned `sonnet`, `permissionMode: default`, memory
off), driven by `evals/test/tool-surface-ab-real.test.ts`. Arm order is
counterbalanced per (scenario, trial); topology/ids are seed-deterministic
and identical across the two arms of a pair.

**Scenarios** (`evals/games/tool-surface-ab.ts`): each is one explicit send
whose correct product form is known in advance, so every attempt classifies
into one six-form vocabulary for both arms. The task text names the GOAL and
never a tool, field, or form — a banned-vocabulary test enforces this (it
already caught the word "conversation" priming arm B once). Scored forms:

1. **agent-channel** — reach a specific agent visibly in a channel.
2. **channel-bare** — post an announcement at a channel root, waking nobody.
3. **agent-postless** — ask an agent privately, answer required back, no
   platform trace.
4. **parent-session** — woken by a real parent session (the peer agent is
   instructed to delegate a quoted question with an answer-back obligation),
   reply into that session.
5. **in-thread-count** — added 2026-08-11 (§8): NOT a send scenario. One
   plaza thread, BOTH agents on the arm's surface, a human kickoff
   @-mentioning both; the agents take turns counting to 6 via ordinary
   replies (each delivered reply echoes back and wakes the peer through the
   #549 continuation ladder). The correct number of messaging-tool calls is
   ZERO — in-thread speech is the ordinary turn reply, by product
   convention. The same banned-vocabulary rule covers its kickoff text.

**Topology**: `briefing` (subject only — instructions arrive here, outside
every measured room), `plaza` (subject + peer, the target channel),
`peer-briefing` (peer only, scenario 4's kickoff). Production mention-gated
routing; full platform-echo fidelity (`evals/games/tool-surface-ab-fixture.ts`).

**Judging** — from the daemon's records, never the model's claims. An attempt
satisfies a scenario only when its _executed_ product form (arm B is scored
on what its call **compiled to**) names the right target ids, AND the world's
effects show the intended delivery: a delivered post in the target channel, a
real activation of the addressed agent, the postless ask leaking into no
channel, the parent actually woken by the child's answer.

**Metrics per run**: success; first-attempt success; attempts-to-success;
tool calls on the subject surface; invalid/rejected calls; token consumption
from `turn.completed` usage events (total and input/output/cache-read/
cache-write components; cache traffic dominates local runs, so input+output
is reported beside the raw total), scoped to the subject agent and also for
the whole run; wall time; verbatim attempts plus any call on the _other_
arm's tool (qualitative misuse evidence).

**Validity**: provider failures and turn timeouts invalidate a trial (they
measure infrastructure, not a surface). A scenario-4 trial where the peer
never delegates is invalid — it conditioned on the caller, not the subject.

## 3. Fidelity notes and limits

- **A hidden tool is unlisted, not disabled.** `hideProductTools` removes the
  descriptor; the daemon still executes the tool if called. A model cannot
  normally call an unadvertised MCP tool, so in practice arm B cannot reach
  `sendMessage` — but this is a property of the runtime's tool dispatch, not
  a daemon-side ban, and the driver records any cross-surface attempt.
- **Not expressible by either arm** and excluded: a fully-addressed
  cross-room handoff into an existing THREAD (the routing rework removed
  `thread` from every `sendMessage` target). Including it would measure a
  known product gap, not the surfaces.
- **Invalid-call rate is partly structural.** Arm B cannot even _express_
  most of arm A's illegal combinations (its remaining illegal combos are
  refused by the façade with named errors). A lower arm-B invalid rate is
  therefore expected **by construction** and is only weak evidence of
  comprehensibility.
- **Scenario 4 uses a real caller.** The peer's delegation itself runs on the
  arm's surface; its failures invalidate the trial rather than scoring
  against either arm, and are reported.
- **n = 3 per cell screens for large effects only.** A marginal difference is
  noise and is reported as such; a null result is not proven equivalence.

## 4. Static cost — measured, not estimated

Measured from the real descriptors and from the guidance text a real daemon
injected into a session prompt (`evals/test/post-facade.test.ts`,
`evals/test/tool-surface-ab-fixture.test.ts`; token figures are a chars/4
approximation and labelled as such). Revision history: the #800
tool-precedence bullet briefly landed in BOTH arms' guidance after the
behavioral runs (production via #801, arm B via this branch's parity
commit, ~+380 chars per arm) and was then removed from both when production
reverted it (#861, after the live in-thread regression §8 gates) — prompt
parity held at every revision, and the current head is back at the 24-run
revision's guidance:

| Surface component                                | Arm A (`sendMessage`) | Arm B (`post`) | Ratio    |
| ------------------------------------------------ | --------------------- | -------------- | -------- |
| Tool description (chars)                         | 2,617                 | 1,046          | 2.5×     |
| Tool input schema (chars)                        | 7,407                 | 1,025          | 7.2×     |
| Descriptor total (chars)                         | **10,024**            | **2,071**      | **4.8×** |
| Descriptor (≈ tokens)                            | ~2,506                | ~518           |          |
| Standing guidance, current head = 24-run (chars) | 2,718                 | 2,394          | 1.1×     |
| **Combined per session, current head (chars)**   | **12,742**            | **4,465**      | **2.9×** |
| Combined, current head (≈ tokens)                | ~3,186                | ~1,116         |          |

The descriptor is carried by **every turn** of every session; the guidance is
standing session context. On a cache-warm local run most of this cost lands
in cache reads rather than fresh input, which is why the behavioral table
reports token components, not just totals.

Literal JSON form templates enumerated by the description: arm A ≥ 6 (plus
its illegal-combination rule table); arm B 4 conversation kinds with no rule
table — the design claim is that the orthogonal split makes the rule table
unnecessary rather than shorter.

## 5. Pre-registration

Expected before any behavioral run, held to afterwards:

1. **Clear arm-B win on static cost** — confirmed above (4.8× descriptor,
   2.9× combined).
2. **Lower arm-B invalid-call rate** — expected partly by construction (§3).
3. **Little or no difference in task success or efficiency** (tool calls,
   tokens net of the static gap) — sonnet-class models handle either surface
   in these single-send scenarios; the primitives' value case is the removal
   of the illegal-combination space and the smaller carried surface, not a
   success-rate jump on well-specified tasks.
4. Anything beyond ±1 trial per cell on success, or a >2× token difference
   net of cache, would _exceed_ this pre-registration and warrants scrutiny
   (and more trials) before belief.

## 6. Behavioral results (2026-08-09, 24/24 valid trials)

Run: local Claude Code over ACP (`claude-acp` 0.64.0 launched via `node`,
model `sonnet`, `permissionMode: default`, memory off), 4 scenarios × 2 arms
× 3 trials, counterbalanced arm order, sequential on one machine. Two
harness defects were found and fixed by the first live trials before the
scored run (both are commits on this branch): evaluation-registry tools
lacked the system-tool permission auto-allow (arm B's calls hung on an
unanswerable approval card — a fairness bug), and a subscription session
limit could score as a behavioral trial (validity now rejects any failed
turn). Per-run artifacts:
`.artifacts/evaluation/tool-surface-ab/<scenario>-<arm>-<trial>/`
(events.jsonl, world-events.jsonl, trial.json) plus `summary-merged.json`;
copies under `~/arena-runs/ab-2026-08-09/` on the measurement host.

Revision notes. (a) These 24 runs predate the #800 tool-precedence bullet;
NEITHER arm carried it, so prompt parity held. The bullet's effect was then
measured separately (parent-session × 5 per arm, criteria pre-fixed):
built-in `SendMessage` attempts 3/6 → 0/10, losses 2/6 → 0/10, success
4/6 → 10/10 — recorded on issue #800 / PR #801, artifacts under
`~/arena-runs/ab-2026-08-09/precedence-fix/`. (b) The channel-bare judge was
later tightened to also require that nobody was woken; the six recorded
channel-bare trials were re-verified under the stricter rule (the peer ran
zero turns in all six) and their 6/6 stands.

| Scenario       | Arm | Success | First-attempt | Invalid calls | Mean tool calls | Mean subject tokens (total / in+out) | Mean wall time |
| -------------- | --- | ------- | ------------- | ------------- | --------------- | ------------------------------------ | -------------- |
| agent-channel  | A   | 3/3     | 3/3           | 0             | 1.0             | 203,578 / 915                        | 33.2s          |
| agent-channel  | B   | 3/3     | 3/3           | 0             | 1.0             | 125,247 / 412                        | 22.7s          |
| channel-bare   | A   | 3/3     | 3/3           | 0             | 1.0             | 173,850 / 782                        | 18.0s          |
| channel-bare   | B   | 3/3     | 3/3           | 0             | 1.0             | 124,990 / 406                        | 14.3s          |
| agent-postless | A   | 3/3     | 3/3           | 0             | 1.0             | 261,008 / 2,350                      | 186.7s         |
| agent-postless | B   | 3/3     | 3/3           | 0             | 1.0             | 140,889 / 598                        | 66.9s          |
| parent-session | A   | 2/3     | 0/3           | 0             | 2.33            | 48,812 / 286                         | 77.6s          |
| parent-session | B   | 2/3     | 0/3           | 2             | 3.0             | 50,263 / 273                         | 98.1s          |

Totals: success **11/12 vs 11/12**, first-attempt **9/12 vs 9/12** —
identical. Subject tokens are the sum over the subject agent's completed
turns (total includes cache read/write; in+out is uncached input plus
output). Cache traffic dominates: e.g. agent-channel arm A ≈ 186.6k cache
read + 16.1k cache write vs arm B ≈ 102.2k + 22.6k. Whole-run totals
(subject + peer) show the same direction, e.g. agent-postless 338.2k (A) vs
217.5k (B).

### What actually happened, qualitatively

- **Scenarios 1–3 were a clean sweep for both arms**: every trial, both
  surfaces, one correct call on the first attempt — including the postless
  ask, where both arms set the reply obligation (`needsReply` /
  `expectReply`) in 3/3 trials.
- **Scenario 4 (reply to your parent session) broke both arms identically.**
  In trial 1 of BOTH arms the child answered through **Claude Code's own
  built-in `SendMessage` tool** (`{to, recipient, summary, …}` — the
  runtime's native inter-agent tool, a name-collision hazard with the
  product's `sendMessage`), so the answer never reached the daemon and the
  parent never got it: 0/1 in each arm. In the remaining trials both arms
  eventually made the right parent-form call but shotgunned extra routes
  around it (a postless call to the peer's agent id, arm B also a DM to a
  bot user id — refused `unknown_channel` — and a channel post addressing
  two recipients — refused by the façade's "at most one agent"). First
  attempt was wrong in 6/6 scored parent-session trials across arms.
- **The two invalid calls belong to arm B** (the DM-to-a-bot and the
  two-recipient channel post above). Arm A produced zero invalid calls: its
  wrong attempts were either the runtime's native tool (not the surface) or
  legal-but-unnecessary product forms the daemon accepted.

## 7. Conclusion — the answer to the question

**Success rate: no improvement, and none was expected.** 11/12 vs 11/12
overall, 9/12 vs 9/12 first-attempt — identical, exactly the pre-registered
expectation for well-specified single-send tasks on a sonnet-class model.
The one shared failure mode (the child session reaching for the runtime's
native `SendMessage` instead of the platform surface) is a product finding
that neither surface design fixes.

**Token consumption: a consistent, large arm-B win in the parent-facing
scenarios.** Where the session carries the full surface (scenarios 1–3),
the primitives arm consumed **28–46% fewer total subject tokens**
(125.2k vs 203.6k; 125.0k vs 173.9k; 140.9k vs 261.0k) and **47–75% fewer
uncached input+output tokens**, with wall time 21–64% lower. In the child
sessions of scenario 4 the arms were equal (≈49–50k). The static gap
(~2,000 descriptor tokens per request) explains only part of this; the rest
is behavioral — under the bigger surface the model generated ~2× the output
and re-read its (larger) cached prompt across more loop steps. Honest
caveat: that behavioral component is an observation at n=3, not a
guaranteed mechanism, and local cache pricing makes the _billable_ gap
deployment-dependent.

**Against the pre-registration:** #1 confirmed (static cost, 4.8×/2.9×).
#2 **refuted in direction** — arm B had MORE invalid calls (2 vs 0), not
fewer: the façade refuses combinations the model then repairs, while arm
A's model simply never emitted an illegal product combination in these 24
runs (its errors routed around the surface instead). At n=3 per cell this
is anecdote-grade, but it must be said: the "invalid-call win" this
experiment pre-registered for the primitives did not appear. #3 confirmed
(no success-rate difference). #4: the token effect in scenarios 1–3
approaches but does not exceed the 2× totals threshold (in+out does exceed
it) — treat the efficiency magnitude as promising, not proven.

**Net:** the primitives design does not change whether a sonnet-class agent
delivers a well-specified message (it delivers it either way), but it
delivers the same outcome measurably cheaper and faster wherever the full
surface is carried, and its structural inability to express most illegal
combinations manifested as _actionable refusals_ rather than fewer errors.
The scenario-4 findings — the native-tool name collision and the
route-shotgunning child — are product problems upstream of either surface
and worth fixing regardless of which surface ships.

## 8. Scenario 5: in-thread turn-taking — the #801 regression gate

### 8.1 The incident that created it

The #800 name-collision finding (§6) was fixed by a prompt-side precedence
bullet (#801): "AgentConnect's MCP tools are the ONLY channel that reaches
other agents and humans here." It was validated against the parent-session
scenario only — 10/10, up from 4/6 — and merged. It then caused a **live
in-thread regression**: in a real Slack thread counting game the agent
stopped replying with numbers and instead routed every turn through
`sendMessage` to "hand off" the next number to its peer, posting only
meta-narration into the thread ("Handing off for 5 / 已把 5 交给 test2")
with skipped and duplicated numbers in the visible count. The bullet's
"ONLY channel" over-generalized: the product convention is that
current-thread communication IS the ordinary reply (`sendMessage`
deliberately has no in-thread form), and the bullet taught the model that
plain replies reach nobody. #801 was reverted (#861); issue #800 is
reopened and records the lesson: **the matrix had no in-thread conversation
scenario, so a prompt change could pass the whole matrix while breaking
ordinary thread play.** Scenario 5 is that missing coverage.

### 8.2 Shape

One `plaza` thread; **both** agents are subjects running the arm's surface;
a human kickoff @-mentions both: take turns counting from 1, reply with
just the next number, stop at 6 (small on purpose — cheap enough to run as
a routine gate). The kickoff names no tool, field, or form (the
banned-vocabulary test covers it). The agents then continue via ordinary
replies: each delivered reply echoes back as real platform ingress and
wakes the peer through the #549 continuation ladder — the mechanics the
live counting game used. The topology, seeds, routing, echo, and validity
rules (any failed/timed-out turn ⇒ invalid trial) are the matrix's own;
counterbalancing places the scenario at matrix index 4.

### 8.3 Judge (`judgeThreadCount`, contract-tested in the CI gate)

Daemon-judged, same philosophy as the send scenarios — score what the
system recorded, never what a model claims:

- **Hard pass**: the count reaches the target via delivered ordinary thread
  replies; **ZERO messaging-tool calls by either participant during the
  game** — the product surface (`sendMessage`/`post`), the other arm's
  tool, and the runtime's built-in `SendMessage` all count, delivered or
  refused, because a messaging call has no legitimate purpose in this
  scenario (any such call IS the #801 failure mode); and no participant
  reply rejected by the world (a lost message).
- **Soft metrics** (reported, never failed on): duplicated and skipped
  numbers, overshoot past the stop target, meta-narration beyond the bare
  number (replies carrying a number plus prose; mean reply length vs the
  expected 1 char), turns per number, tokens per participant and per run.

The judge is pinned by credential-free contract tests in
`evals/test/tool-surface-ab.test.ts` (the `eval:collab:contracts` gate): a
scripted trace replaying the #801 handoff pattern must score FAIL, a clean
reply-only trace must score PASS, the built-in-`SendMessage` and arm-B
`post` variants must FAIL identically, and soft-metric traces must pass
while being measured. `evals/test/tool-surface-ab-fixture.test.ts` proves
the transport end-to-end against a real daemon with scripted hosts: a
both-mentioned kickoff plus ordinary replies really carries the count
peer-to-peer through the echo, with both participants contributing, and
the judge passes it.

### 8.4 Baseline results (2026-08-11, post-revert prompt, 2 arms × 3 trials)

Run: local Claude Code over ACP (`claude-agent-acp` 0.64.0 launched via
`node`, model `sonnet`, `permissionMode: default`, memory off), 2 arms × 3
trials, counterbalanced arm order, sequential on one machine, 6/6 valid.
This baselines the scenario on the CURRENT (post-revert, pre-#801-identical)
guidance — the expectation was that both arms pass cleanly, since the
pre-#801 text never caused the in-thread failure, but it was measured
rather than assumed. Artifacts:
`.artifacts/evaluation/tool-surface-ab/in-thread-count-<arm>-<trial>/`;
copies under `~/arena-runs/ab-2026-08-11-in-thread-count/` on the
measurement host.

| Arm | Trial | Verdict  | Visible count | Messaging calls | Lost | Dup / skip / overshoot | Bare / meta replies | Turns per number | Run tokens (total / in+out) | Wall  |
| --- | ----- | -------- | ------------- | --------------- | ---- | ---------------------- | ------------------- | ---------------- | --------------------------- | ----- |
| A   | 1     | **PASS** | 1–6 in order  | 0               | 0    | 0 / 0 / 0              | 6 / 0               | 1.17             | 295,219 / 214               | 46.7s |
| A   | 2     | **PASS** | 1–6 in order  | 0               | 0    | 0 / 0 / 0              | 6 / 0               | 1.17             | 294,154 / 114               | 42.5s |
| A   | 3     | **PASS** | 1–6 in order  | 0               | 0    | 0 / 0 / 0              | 6 / 0               | 1.17             | 302,221 / 880               | 60.3s |
| B   | 1     | **PASS** | 1–6 in order  | 0               | 0    | 0 / 0 / 0              | 6 / 0               | 1.17             | 298,318 / 325               | 44.3s |
| B   | 2     | **PASS** | 1–6 in order  | 0               | 0    | 0 / 0 / 0              | 6 / 0               | 1.17             | 317,230 / 734               | 51.6s |
| B   | 3     | **PASS** | 1–6 in order  | 0               | 0    | 0 / 0 / 0              | 6 / 0               | 1.17             | 299,571 / 200               | 66.8s |

**6/6 clean sweep, both arms.** Every trial produced exactly the six bare
numbers 1–6 in order (mean reply length 1 char — zero meta-narration), via
7 participant turns (both agents woken by the kickoff, then five
echo-driven continuation turns), with zero messaging-tool calls of any
kind — product surface, other arm's tool, or the runtime built-in — zero
lost replies, and zero duplicates, skips, or overshoot. This is the
pre-#801 guidance behaving exactly as the live product did before the
regression, now pinned as the gate's baseline: a future guidance candidate
that scores below 3/3 per arm here is a regression against this table, no
matter what it scores on parent-session.

### 8.5 The standing prompt-change gate

**Any change to the standing collaboration guidance or the parent-report
append (`collabAppend` / `parentReplyAppend` in
`packages/daemon/src/session/session-manager.ts`) must be validated against
BOTH the parent-session scenario AND this in-thread scenario before
landing.** #801 is the incident that created this rule: a prompt fix
measured only on the report-back path traded a silent parent-report loss
for a visible conversation regression, because the two failure modes pull
the guidance in opposite directions ("use the tool to reach peers" vs
"in-thread speech is the ordinary reply"). A candidate rewrite that scores
well on one and is unmeasured on the other is unvalidated. The same gate is
recorded in `collaboration-arena-baseline.md` §4.2.
