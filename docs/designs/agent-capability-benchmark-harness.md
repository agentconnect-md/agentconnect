# AgentConnect Add-on Evaluation and Harness Neutrality

**Status:** Draft for review

**Author:** AgentConnect team

**Related:** [memory-evolution.md](memory-evolution.md) · [memory-system-plan.md](memory-system-plan.md) · [agent-collaboration-implementation.md](agent-collaboration-implementation.md) · [agents-collaboration-design.md](agents-collaboration-design.md) · [loop-breaker-design.md](loop-breaker-design.md) · [architecture.md](architecture.md)

## 1. Product boundary and motivation

AgentConnect is a **harness-neutral capability layer**. Claude Code, Codex, Gemini, and other ACP runtimes supply the underlying agent loop, reasoning, and most general task competence. AgentConnect adds product behavior around that loop:

- durable managed, native, or external memory;
- multi-agent discovery, direct delivery, orchestration, correlation, and policy;
- channel/session routing, prompt context, permission policy, and untrusted-event wrapping;
- daemon-local durability, isolation, and lifecycle behavior.

Therefore the useful question is not “how capable is this agent?” An absolute task score would mostly measure the selected model and underlying harness. The useful questions are:

1. **Neutrality:** does routing the same harness through AgentConnect preserve its behavior when AgentConnect add-ons are disabled?
2. **Incremental value:** does enabling one AgentConnect add-on improve the intended outcome?
3. **Safety and invariants:** does the add-on obey its deterministic product contract on every run?
4. **Portability:** does the effect remain sound across the supported harnesses, or does a harness-by-feature interaction reveal an integration bug?

Today these questions are answered mostly through manual end-to-end checks. Those checks found real regressions—permission-card noise, collaboration cascades from context bleed, lost collaboration replies, and weak memory behavior—but they are not repeatable or comparable.

This design adds a small evaluation system around existing tests and the real daemon path. It reuses established evaluation and trace formats instead of creating a general benchmark engine in this repository.

### 1.1 Goals

1. Turn known memory, collaboration, routing, prompt, and safety behaviors into repeatable regression cases.
2. Measure the **paired change** caused by an add-on, holding the underlying harness/model and other variables constant.
3. Detect integration regressions across a representative ACP-runtime matrix.
4. Produce complete, replayable evidence for every trial: configuration, semantic events, trajectory, outcome, usage, and errors.
5. Keep deterministic product invariants fast enough for pull requests; run token-consuming behavioral comparisons on demand and nightly.

### 1.2 Non-goals

- A general model or agent leaderboard.
- A claim that AgentConnect owns the underlying harness's coding/reasoning capability.
- A replacement for Vitest unit, integration, protocol, or lifecycle tests.
- A bespoke runner, judge framework, report UI, or artifact schema.
- A single weighted “agent score” that can hide a safety failure.
- In v1, a large public coding benchmark, generalized LLM judge, or trend dashboard.

> **Scope amendment.** [collaboration-arena.md](collaboration-arena.md) supersedes
> the “no bespoke runner / general benchmark engine” non-goal for the narrow scope
> of stateful multi-agent collaboration games. The Arena adds a game engine and
> world model while keeping Promptfoo as the outer orchestrator, ATIF and the
> evaluation-event schema as the product trace, and the separation of trial
> validity, product invariants, and game score defined here. All other non-goals
> in this list remain in force.

## 2. Experimental model

### 2.1 Terms

- **Subject harness (`h`)** — a pinned ACP runtime, model, model settings, prompt/tool surface, and version.
- **Case** — an instruction/event script, isolated initial state, treatment matrix, and expected invariants/outcomes.
- **Trial** — one attempt of one case under one exact subject/treatment configuration.
- **Control/treatment pair** — two trials that differ only in the AgentConnect capability under test.
- **Trajectory** — the structured messages, model updates, tool calls/results, memory events, collaboration events, policy decisions, and usage for a trial.
- **Outcome** — the externally meaningful final state, distinct from what the agent said it did.
- **Infrastructure error** — the case could not validly measure the subject; it is not an agent failure.

### 2.2 Paired effects

For a fixed subject harness `h`:

```text
Δcore(h)   = score(AgentConnect, add-ons off, h) - score(raw ACP, h)
Δmemory(h) = score(AgentConnect, memory on, h)   - score(AgentConnect, memory off, h)
Δcollab(h) = score(AgentConnect, collab on, h)   - score(AgentConnect, collab off, h)
```

The memory-plus-collaboration treatment also measures whether the features interfere or create additional value beyond their individual effects.

Report the control result, treatment result, and paired delta for each harness. Do not roll different harnesses into one AgentConnect capability score. Cross-harness aggregation is allowed only for compatibility summaries such as “the invariant passed on 3/3 supported harnesses.”

### 2.3 Controls

Within a pair, pin and record:

- AgentConnect commit and dirty state;
- runtime, runtime version, ACP version, provider, model, and generation settings;
- base system prompt, skills, MCP/tool schemas, workspace, case fixtures, and input script;
- resources, concurrency, network policy, timeout, date, seed where supported, and cache state;
- evaluator, case, grader, trajectory-schema, and semantic-convention versions.

Run each trial in a fresh root/workspace/store. A treatment may not inherit sessions, files, native runtime memory, provider caches, or credentials from its control.

Some subject harnesses have native memory or subagents. Those are separate comparison questions:

- isolate `none → AgentConnect managed memory` with native memory disabled where the runtime supports it;
- optionally compare `runtime-native → AgentConnect managed` as a product choice, clearly labeled as such;
- do not call a comparison between native subagents and AgentConnect collaboration the isolated collaboration effect.

## 3. Reuse decisions

There is no single universal agent-evaluation runner, but current industry practice converges on tasks/cases, isolated trials, complete trajectories, executable outcomes, separate safety gates, and calibrated semantic judges.

| Concern                                                                  | Decision                                     | Why                                                                                                                                                                                                         |
| ------------------------------------------------------------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository-owned cases, repeats, assertions, CI output, red-team support | **Promptfoo**                                | OpenAI's current migration guidance points to it; it already supplies orchestration, custom TypeScript providers/assertions, JSON/JUnit/HTML output, and trace assertions.                                  |
| Deterministic AgentConnect contracts                                     | **Vitest and existing integration fixtures** | Faster and more precise than LLM-in-the-loop evaluation.                                                                                                                                                    |
| Durable trial trajectory                                                 | **ATIF**, pinned to a supported version      | Versioned interchange format for messages, tool calls/results, metrics, multi-turn, and multi-agent trajectories.                                                                                           |
| Live trace transport                                                     | **OpenTelemetry GenAI conventions**, pinned  | The daemon already initializes OTel; trace export is useful for observability and Promptfoo trajectory assertions. The conventions remain a developing contract, so they are not the only durable artifact. |
| Sandboxed task/public-benchmark execution                                | **Harbor, optional**                         | Use only when a feature question needs a container verifier or external calibration. It is not required for the core add-on suite.                                                                          |
| OpenClaw/ClawBench                                                       | **Methodology only**                         | Borrow outcome-first grading, reliability/failure profiles, and hidden-case discipline; do not port its OpenClaw-native runner or weighted score.                                                           |
| Hermes                                                                   | **Subject/adapter only**                     | Hermes generates agent trajectories; it is not the product evaluation framework.                                                                                                                            |

Primary references:

- [OpenAI agent evals](https://developers.openai.com/api/docs/guides/agent-evals), [evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices), and [Promptfoo migration](https://developers.openai.com/cookbook/examples/evaluation/moving-from-openai-evals-to-promptfoo)
- [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) and [infrastructure noise](https://www.anthropic.com/engineering/infrastructure-noise)
- [Harbor concepts](https://www.harborframework.com/docs/core-concepts), [ACP agents](https://www.harborframework.com/docs/agents/acp), and [ATIF](https://www.harborframework.com/docs/agents/trajectory-format)
- [SWE-bench](https://www.swebench.com/original.html), [τ-bench](https://arxiv.org/abs/2406.12045), [ClawBench](https://github.com/openclaw/shellbench), [Claw-SWE-Bench](https://arxiv.org/abs/2606.12344), [WildClawBench](https://arxiv.org/abs/2605.10912), and [ClawsBench](https://arxiv.org/abs/2604.05172)

## 4. Evaluation stack

```text
case + treatment matrix
          │
          ▼
Promptfoo custom provider ──────── optional raw-ACP provider (neutrality only)
          │
          ▼
isolated full Daemon + synthetic Webchat/hook ingress
          │
          ├── deterministic state/outcome checks
          ├── semantic evaluation events ──▶ ATIF artifact
          │                              └──▶ OTel GenAI spans
          └── output/usage/error metadata ─▶ Promptfoo assertions/reports
```

There are two complementary layers:

1. **Contract layer:** ordinary deterministic tests exercise memory, collaboration, routing, authorization, idempotency, timeout, and isolation semantics without a real model where possible.
2. **Behavior layer:** Promptfoo runs paired feature-off/feature-on trials through a real subject harness to measure whether the add-on changes user-visible outcomes.

### 4.1 Execution modes

#### Full daemon — primary product mode

Boot a real `Daemon` against a throwaway root and use synthetic Webchat or hook ingress. This path must exercise the real `SessionManager`, prompt injection, MCP bridge, memory provider, dispatch gate, collaboration routing, and lifecycle behavior.

The control and treatment use the same full-daemon path. An internal test composition seam selects an evaluation capability profile:

```ts
type EvaluationCapabilityProfile = {
  memory: 'off' | 'configured'
}
```

Collaboration is deliberately not part of the profile. Evaluation must run the exact production tool surface and messaging mechanism, so there is no collaboration-off composition: every full-daemon cell exposes the full `sendMessage` target union and the collaboration tools, and delivery follows production policy.

This is constructor/test composition, not a new externally routable platform or production configuration. It must not put message bodies on the control-plane path.

#### Raw ACP — neutrality control only

`runChat`/`AcpHost.newSession(cwd)` bypasses the daemon `SessionManager`, managed-memory injection, daemon MCP bridge, collaboration, routing, and policy. It is useful only for `Δcore`: comparing a raw subject harness with the same harness routed through AgentConnect with add-ons off.

It must never be used as the control for managed memory. That control is the full daemon with memory off. Collaboration has no off control at all — its behavior is checked functionally on the production surface.

### 4.2 Provider lifecycle

For every Promptfoo provider invocation:

1. Create an isolated root, store, workspace, runtime profile, and agent fixtures.
2. Seed only the case-declared memory, messages, files, and external state.
3. Start the selected execution mode and semantic event collector.
4. Drive the case script in order, awaiting a terminal turn result with a bounded timeout.
5. Run deterministic outcome/state checks.
6. Flush an ATIF trajectory, OTel spans, run manifest, usage, and grader evidence.
7. Return output, score-relevant metadata, and artifact paths to Promptfoo.
8. Stop the daemon/runtime and delete or retain the root according to the artifact policy.

Setup, runtime launch, transport, provider, timeout, and artifact-write failures produce `infra_error`; they do not count as an agent failure.

### 4.3 Semantic evaluation observer

The current transcript is a user-facing projection, not an evaluation API. `transcriptSince()` is deliberately text-only, while reconstructing behavior from `threadTranscript()`, tool bodies, and private SQLite tables loses policy and add-on semantics.

Add an optional, synchronous, side-effect-free observer at the daemon composition boundary:

```ts
interface EvaluationObserver {
  emit(event: EvaluationEvent): void
}
```

Events are versioned discriminated records with shared trial/turn/session/agent/time identifiers. The initial vocabulary covers:

- turn accepted, started, completed, failed, cancelled, or timed out;
- ACP session update and normalized tool call/result;
- memory recall requested/completed/failed and capture requested/completed/failed;
- permission requested, auto-allowed, prompted, denied, resolved, or cancelled;
- agent delivery admitted/rejected/deduplicated and orchestration state transitions;
- output terminal status and usage/cost updates.

Emit at the semantic decision point. For example, an `AcpHost.onPermission` callback is only a request; it does not say whether the daemon auto-allowed a system tool or rendered an interactive prompt. The observer records the actual decision.

The observer is absent in normal production composition. It never changes a decision, blocks a turn, or sends trace data through the CP. Observer failures are contained and fail the evaluation trial, not the daemon behavior being measured.

### 4.4 Trajectory and privacy

The collector maps evaluation events and ACP updates to:

- `trajectory.json` in pinned ATIF form;
- `events.jsonl` in the versioned AgentConnect evaluation-event schema for lossless local debugging;
- OTel spans using pinned GenAI conventions;
- `run.json` containing the full reproducibility manifest and terminal status.

Reasoning content, tool results, memory, prompts, and secrets are sensitive. Artifacts remain local/CI-restricted by default, pass through explicit redaction before upload, and use short retention. Public reports contain aggregate results and safe failure labels, not raw message bodies or hidden fixtures.

## 5. Cases and treatments

Promptfoo owns enumeration, repeats, output formats, and CI exit behavior. AgentConnect keeps only a small case manifest and provider-specific fixtures:

```ts
interface AgentConnectEvalCase {
  id: string
  feature: 'core' | 'memory' | 'collaboration' | 'interaction' | 'safety'
  subject: SubjectHarness
  fixture: FixtureRef
  script: InboundEvent[]
  treatments: Treatment[]
  assertions: AssertionRef[]
  timeoutMs: number
}
```

`Treatment` changes exactly the declared AgentConnect capability profile or prompt variant. It may not silently change the model, runtime, tool schema, fixture, or timeout.

### 5.1 Initial deterministic contract suite

These remain normal tests and gate relevant pull requests:

**Memory**

- capture is attempted once and stored under the correct agent/principal;
- recall injects only bounded, relevant records and fails open within policy;
- a new session can retrieve seeded managed memory;
- agent/org isolation and deletion/history semantics hold;
- slow/failed external capture is reported without unsafe automatic duplication.

**Collaboration**

- direct delivery preserves trusted caller, delivery, correlation, origin, and hop metadata;
- context isolation gives a callee only the handed content and trusted collaboration context;
- call policy, membership, idempotency, queue limits, timeout/cancel, and failure feedback hold;
- orchestration is record-first and reaches the correct terminal state;
- duplicate delivery and cascades/loops are contained.

**Policy and ingress**

- built-in system tools are auto-allowed while dangerous runtime tools follow interactive policy;
- permission decision events distinguish auto-allow from prompt/cancel;
- hook bodies remain explicitly untrusted;
- memory-off composition omits the corresponding memory prompt/tool behavior; the collaboration surface is identical in every composition.

### 5.2 Initial paired behavior suite

Keep v1 small and outcome-focused:

- `core-simple-instruction`: raw ACP versus full daemon/add-ons-off; assert equivalent required output plus bounded overhead.
- `memory-cross-session-recall`: full daemon memory off versus on; outcome is a correct answer grounded only in prior-session state, plus recall-state evidence.
- `memory-proactive-capture`: memory off versus on; after a learn-worthy turn, verify durable state and retrieval in a fresh session.
- `memory-isolation`: memory on; verify a fact from another agent/principal is neither injected nor disclosed.
- `collab-delivery-reply`: production-surface functional check; a task requiring a specialist peer succeeds only through admitted delivery/reply correlation (no off cell — the product ships no collaboration-off composition).
- `collab-context-isolation`: reproduce the greeting/cascade failure; treatment must complete without peer rebroadcast or thread-context bleed.
- `collab-orchestration-partial-failure`: verify collected successes, timed-out worker state, and final main-agent recovery.
- `prompt-quiet-mechanics`: prompt-variant comparison on the production surface; the treatment uses the tool without narrating internal delivery mechanics.
- `memory-collab-handoff`: a peer uses relevant managed memory during a delegated task without leaking unrelated memory.

The subject's absolute result remains visible for diagnosis. The product signal is the paired delta plus invariant/safety gates.

## 6. Grading and statistics

Apply graders in this order:

1. **Trial validity:** setup and execution completed without infrastructure/grader failure.
2. **Deterministic outcome:** expected final state, delivery state, file/state change, or executable verifier result.
3. **Safety/policy gate:** isolation, authorization, secret handling, permission, and forbidden-action checks.
4. **Trajectory properties:** required/forbidden tool/event sequence and bounded step counts.
5. **Semantic rubric:** only for requirements that cannot be made executable.

A model judge cannot rescue a deterministic or safety failure. When later introduced, a judge must use a narrow pass/fail, pairwise, or reference-guided rubric; be calibrated on human-labeled examples; record model/prompt/version; and support `unknown`.

### 6.1 Result statuses

Every trial terminates as one of:

- `passed`
- `agent_failed`
- `safety_failed`
- `infra_error`
- `grader_error`
- `invalid_case`

Reports keep dimensions separate:

- outcome/completion — hard gate;
- safety/policy — hard gate;
- reliability — repeated-trial measure;
- quality — deterministic and optional calibrated semantic measures;
- efficiency — turns, tool calls, latency, tokens, and cost;
- trajectory diagnostics — evidence, not a substitute for outcome.

### 6.2 Repetition

There is no universal default of three trials:

- deterministic contract cases run once per pull request and must pass;
- a small reference-harness behavior smoke may run once on demand;
- nightly reliability runs repeat enough to estimate observed pass rate and `pass^k`;
- capability/uplift comparisons report paired deltas with confidence intervals when sample size permits.

Use the terms precisely:

- pass rate: successful trials divided by valid trials;
- `pass@k`: probability at least one of `k` attempts succeeds;
- `pass^k`: probability all `k` attempts succeed.

Never count `infra_error` as an agent failure or silently drop it from the report.

## 7. Repository layout and CI

```text
evals/
  promptfooconfig.yaml
  cases/
  fixtures/
  providers/
  assertions/
  schemas/
  README.md

packages/daemon/
  src/evaluation/       # optional observer/event definitions and emit helpers
  test/evaluation/      # deterministic contract/collector tests
```

Do not add `packages/bench`. Promptfoo remains the runner; AgentConnect code is an adapter and observer.

CI lanes:

1. **Pull request:** type/schema/collector tests plus deterministic add-on contracts; no external model credentials required.
2. **On demand:** paired behavioral suite for one selected subject or prompt change.
3. **Nightly:** repeated reference-subject suite and a rotating supported-harness compatibility matrix.
4. **Optional scheduled calibration:** Harbor/public tasks only when needed to validate a feature effect against an external task environment.

CI publishes redacted JSON/JUnit summaries and retains raw artifacts only in restricted storage for a short period. A case can gate only after it has demonstrated stable fixtures and an acceptable infrastructure-error rate.

## 8. Delivery plan

### P0 — contracts and evidence, no real model required

- versioned evaluation-event schema and optional daemon observer;
- semantic permission, memory, collaboration, turn, and usage events at the decision points needed by the initial suite;
- event collector, `run.json`, `events.jsonl`, and ATIF writer with schema validation;
- deterministic tests for observer non-interference, event semantics, redaction, and terminal error taxonomy;
- root `evals/` layout and documented local commands.

### P1 — paired full-daemon provider

- Promptfoo custom TypeScript provider;
- isolated full-daemon fixture lifecycle and capability-profile composition seam;
- full-daemon memory-off/on controls (collaboration always at the production surface);
- initial paired memory, prompt, and interaction cases plus a functional collaboration case;
- JSON/JUnit output and an on-demand workflow.

### P2 — runtime matrix and nightly reliability

- raw-ACP neutrality provider;
- one PR/on-demand reference subject and a rotating nightly runtime/model matrix;
- repeated-trial reliability, paired-delta reports, cost/latency bounds, and failure profiles;
- promote sanitized production failures into regression cases.

### P3 — optional extensions after demonstrated need

- Harbor adapter and containerized/public task controls;
- calibrated semantic judge;
- hidden/adversarial case set and broader Promptfoo red-team runs;
- trend UI if JSON/CI history is no longer sufficient.

## 9. Acceptance criteria for the first usable system

1. A developer can run the deterministic evaluation contracts locally with no external credentials.
2. A configured developer can run one Promptfoo command that executes an isolated full-daemon paired case and produces control, treatment, delta, status, and artifact paths.
3. Memory and collaboration controls use the same full-daemon path; raw ACP is rejected for those feature cases.
4. Permission assertions observe the daemon's actual policy decision, not callback count.
5. A complete validated ATIF trajectory and versioned run manifest are retained for each valid trial.
6. Infrastructure failures are distinguishable from agent and safety failures.
7. No evaluation event or artifact traverses the control-plane message path, and normal daemon composition is unchanged when no observer is installed.
8. Pull-request checks require no model credential; model-consuming suites are explicit on-demand/nightly jobs.

## 10. Resolved decisions

- Evaluate **AgentConnect add-ons and harness neutrality**, not generic agent capability.
- Use paired feature-off/feature-on trials with a fixed underlying harness.
- Use the full daemon for memory and collaboration controls/treatments.
- Use raw ACP only for core neutrality.
- Reuse Promptfoo rather than building a runner/CLI/report framework.
- Use ATIF for durable trajectories and pinned OTel GenAI conventions for live export.
- Keep deterministic outcome and safety as independent hard gates; no global weighted score.
- Keep Harbor, public coding benchmarks, and model judges outside the v1 critical path.
