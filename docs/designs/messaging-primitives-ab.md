# Tool-surface A/B: `sendMessage` (shipped) vs `post` (messaging primitives)

Status: apparatus landed and contract-proven; static costs measured; the
24-run behavioral matrix is implemented and one command from producing its
table (see §6 — the run is currently blocked on local runtime credentials,
not on anything in this repository).

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
`evals/test/tool-surface-ab-fixture.test.ts`, on `main` @ `70d58cd1` +
this branch; token figures are a chars/4 approximation and labelled as such):

| Surface component                | Arm A (`sendMessage`) | Arm B (`post`) | Ratio    |
| -------------------------------- | --------------------- | -------------- | -------- |
| Tool description (chars)         | 2,617                 | 1,046          | 2.5×     |
| Tool input schema (chars)        | 7,407                 | 1,025          | 7.2×     |
| Descriptor total (chars)         | **10,024**            | **2,071**      | **4.8×** |
| Descriptor (≈ tokens)            | ~2,506                | ~518           |          |
| Standing guidance (chars)        | 2,718                 | 2,394          | 1.1×     |
| **Combined per session (chars)** | **12,742**            | **4,465**      | **2.9×** |
| Combined (≈ tokens)              | ~3,186                | ~1,116         |          |

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

## 6. Behavioral results

**Run status (2026-08-09): blocked on local runtime credentials.** The
harness itself is verified to the provider boundary: the smoke trial booted
the real daemon, materialized the real subject, launched the local
`claude-acp` adapter, created the ACP session, and dispatched the kickoff
turn — which failed with `provider_auth_required` ("OAuth session expired
and could not be refreshed"). The local Claude Code CLI's OAuth refresh
token expired on 2026-08-09 (the 2026-08-08 arena baseline re-run caught its
last hours of validity), and re-authentication is an interactive login only
the operator can perform.

To produce the table (after `claude /login` on the host):

```bash
pnpm --filter @agentconnect.md/daemon build
export AGENTCONNECT_DAEMON_ENTRY="$PWD/packages/daemon/dist/index.js"
export AGENTCONNECT_EVAL_SUBJECT_ROOT=/absolute/path/to/subject   # §4.1 template shape, runtime id claude-acp
export AGENTCONNECT_EVAL_GAME_TEMPLATE_AGENTS=<template-agent-id>
npx vitest run evals/test/tool-surface-ab-real.test.ts
```

Per-run artifacts land in `.artifacts/evaluation/tool-surface-ab/<scenario>-<arm>-<trial>/`
(events.jsonl, world-events.jsonl, trial.json) with an aggregated
`summary.json`; the table below is its rendering.

| Scenario       | Arm | Success | First-attempt | Invalid calls | Mean tool calls | Mean subject tokens (total / in+out) | Mean wall time |
| -------------- | --- | ------- | ------------- | ------------- | --------------- | ------------------------------------ | -------------- |
| agent-channel  | A   | – /3    | – /3          | –             | –               | –                                    | –              |
| agent-channel  | B   | – /3    | – /3          | –             | –               | –                                    | –              |
| channel-bare   | A   | – /3    | – /3          | –             | –               | –                                    | –              |
| channel-bare   | B   | – /3    | – /3          | –             | –               | –                                    | –              |
| agent-postless | A   | – /3    | – /3          | –             | –               | –                                    | –              |
| agent-postless | B   | – /3    | – /3          | –             | –               | –                                    | –              |
| parent-session | A   | – /3    | – /3          | –             | –               | –                                    | –              |
| parent-session | B   | – /3    | – /3          | –             | –               | –                                    | –              |

## 7. Conclusion so far — the honest answer to the question

On **token consumption**, the measurable half is already answered: the
primitives surface is 4.8× smaller as a tool descriptor and 2.9× smaller
including the standing guidance — roughly **2,000 fewer descriptor-tokens
carried on every turn** of every session (mostly as cache traffic on a warm
local run; as fresh input on cold sessions and non-caching deployments).

On **success rate**, no behavioral claim is made yet: the pre-registered
expectation is little or no difference at n=3 on these well-specified
single-send tasks, with arm B's advantage expected in the invalid-call
column — and partly by construction there. The 24-run matrix is implemented,
contract-tested, and one credential refresh away from filling §6.
