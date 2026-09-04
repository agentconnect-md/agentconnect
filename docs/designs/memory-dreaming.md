# Design: Memory Dreaming Mode — Offline Consolidation for Managed Memory

> Status: D-1 shipped (protocol, daemon runner, CP REST, console config); D-2
> shipped (auto-accept policy, distillation rebase, scheduled dreams); D-3
> shipped (reviewed skill mining). Organization-wide Dream proposals extend
> this lifecycle in [organization-knowledge.md](organization-knowledge.md).
> Prerequisites: [memory-evolution.md](memory-evolution.md),
> [memory-system-plan.md](memory-system-plan.md),
> [architecture.md](architecture.md),
> [shared-skills.md](shared-skills.md),
> [organization-knowledge.md](organization-knowledge.md)
> Keywords: dreaming, memory consolidation, distillation, staged output,
> transcript mining, skill mining, managed provider, harness-agnostic

> **Production security hold — LIFTED (2026-08-03, task #36).** The 2026-08-01
> hold rejected all production Dream execution and staged-content operations until
> two conditions were met; both now are:
>
> 1. **Credentials outside model-readable paths.** Each Dream runs on a dedicated,
>    one-off ACP host, sandboxed when the agent runs sandboxed, so a sandboxed
>    runtime is denied the host's credentials and, on Claude, the inner sandbox
>    denies the agent's own provider credential to the model's bash. The dream
>    launch also excludes the agent's tool credentials entirely. Residual: on a
>    runtime with no inner provider-credential confinement (e.g. Codex) or an
>    unsandboxed agent, the agent's own provider auth can still be reached by the
>    model's own tools — a tracked **P2**, to be closed by per-runtime credential
>    brokering, not a blocker (owner decision; see docs/product-conventions.md).
> 2. **Reviewed bytes bound to adoption.** Adopt / skill-accept take the digest of
>    the exact staged bytes the console reviewed and refuse if the staging changed
>    since — the same-bytes review fence (skill acceptance verifies against the
>    publication snapshot itself, so a concurrent swap cannot slip un-reviewed
>    bytes through).
>
> Production Dream is therefore enabled; each agent's own `dreaming.enabled`
> policy still gates whether it dreams. Injected deterministic hosts remain a
> test-only seam (`dreamOperationPolicy: 'test-only'`), never a production path.

---

## 1. Background and Problem

Managed memory (`memory.provider: 'managed'`) accumulates writes three ways:
the agent's own `writeMemory` tool calls, console edits, and (opt-in) per-turn
auto-distillation. All three paths are **additive and local**: the distiller is
explicitly forbidden from rewriting or deleting existing memories
(`memory-distiller.ts` system policy), and nothing ever reads _across_
sessions. Over weeks a store therefore collects duplicates, contradictions,
relative dates that lost meaning, and stale one-off notes — and the injected
`MEMORY.md` index degrades, because it is the only part of the store every
fresh session sees.

**Dreaming** is the counterpart to distillation: a periodic, offline
consolidation pass that reads the whole store _and_ recent session
transcripts, then produces a reorganized store — duplicates merged, stale or
contradicted entries replaced with the latest value, relative dates made
absolute, new durable insights mined from the transcripts, and the index
rebuilt. Distillation is additive and per-turn; dreaming is reconstructive
and cross-session. Beyond facts, the same cross-session view also exposes
**reusable procedures** — command sequences, scripts, and workflows the agent
keeps re-deriving — which dreaming can surface as candidate skills (§7).

Scope constraints for v1:

- **Managed provider only.** `native` delegates the store to the runtime (we
  must not rewrite what the runtime owns), and `external` stores records
  behind a plugin ABI whose reorganization semantics are backend-specific —
  both are out of scope (§11).
- **Every supported agent harness.** The managed store is daemon-owned and
  harness-agnostic already; the dreaming _executor_ must be too. It therefore
  runs through the generic ACP host seam (the same one auto-distillation
  uses), never through any runtime-specific memory feature.

## 2. Concept: a dream is a staged rebuild, never an in-place edit

```
              ┌──────────────────────── daemon ────────────────────────┐
inputs        │  snapshot of <agent-root>/memory/   (read-only)        │
              │  last N session transcripts         (daemon DB)        │
              │            │                                           │
              │            ▼                                           │
executor      │  isolated ACP session on the agent's runtime           │
              │  (dream pipeline prompt; the model WRITES the rebuilt  │
              │   store through the memory tools, bound to the staged  │
              │   store, and returns review proposals as JSON)         │
              │            │                                           │
              │            ▼                                           │
outputs       │  memory-dreams/<dreamId>/memory/    (staged store)     │
              │  memory-dreams/<dreamId>/skills/    (staged skills §7) │
              └────────────┬───────────────────────────────────────────┘
                           ▼
review        console review → adopt store | discard;  accept skills | dismiss
```

Three invariants:

1. **The live store is never modified by a running dream.** The dream reads a
   snapshot and writes only into its own staging directory.
2. **Adoption is configured and reversible.** A user either reviews a proposal
   explicitly or enables auto-accept. Adopting renames the live store to a
   timestamped backup and moves the staged tree into place, appending a
   `dream-adopt` event to `.history`. The backup is retained until the next
   successful adoption.
3. **The model proposes; the daemon disposes.** The model's writes reach disk
   only through the daemon's own memory tools, bound to the staged store: the
   same path validation, topic-name rule, and byte caps a turn gets, plus the
   dream's own bounded file count. The daemon still performs every filesystem
   write itself and generates the index. `.history` is never part of the
   proposal — it is carried over verbatim and appended to.

Invariant 3 bounds only what the dream _output_ can do: a bad proposal can
change only the managed-memory store, and only after staging and validation.
Auto-accept deliberately skips a human content-quality check, as its console
warning makes clear. The invariant says nothing about what the _extraction run
itself_ can do — the mined transcript is attacker-controlled, so
a prompt injection could drive the runtime's native shell/file/network tools
during the run, and staged-output review cannot undo those
side effects. The executor therefore separates two independent gates:

- **Side effects during the run — HARD gate (fail closed).** The extraction
  session requires a verified non-mutating permission mode (read-only / plan);
  if the runtime advertises none or the switch is rejected, the dream fails
  rather than running with write access. This is what keeps the executor safe
  on runtimes without a trusted system-prompt channel (Codex has read-only
  mode), and it is stricter than "staging contains everything."
- **Trusted system-prompt channel — OBSERVED.** When the runtime carries the system
  prompt via `_meta.systemPrompt` the dream policy rides it; otherwise the
  policy is prepended to the user prompt. Auto-accept is the user's explicit
  choice to apply a completed proposal without content review, so this transport
  distinction does not override that choice. The verified non-mutating mode
  above still gates the extraction run itself.

## 3. Configuration

Extend the managed branch of `AgentMemoryBinding`
(`packages/protocol/src/frames/memory-connection.ts`) — zod makes the
managed-only constraint structural:

```ts
export const MemoryDreamingPolicy = z
  .object({
    enabled: z.boolean(),
    /** Optional override pinning a fixed newest-N session window (max 100). When
     *  absent (the norm), the window is sized automatically — see "Gather signal". */
    sessionWindow: z.number().int().min(1).max(100).optional(),
    /** Optional cron for scheduled dreams (same syntax as agent crons). */
    schedule: z.string().min(1).max(128).optional(),
    /** IANA zone the `schedule` is evaluated in; absent ⇒ daemon-host local. */
    timezone: z.string().min(1).max(64).optional(),
    /** Operator steering text applied through the whole pipeline (≤ 4096 chars). */
    instructions: z.string().max(4096).optional(),
    /** Also mine reusable procedures into candidate skills (§7). Default true;
     *  false is the opt-out. Mined skills are always proposals — never auto-installed. */
    mineSkills: z.boolean().optional(),
    /** Adopt the memory store automatically on completion without content
     *  review. Default true; false is the opt-out. Live-memory fence conflicts
     *  remain reviewable. Never applies to skills (§7). */
    autoAdopt: z.boolean().optional()
  })
  .strict()

export const BuiltInMemoryBinding = z
  .object({
    provider: z.enum(['none', 'native', 'managed']),
    autoDistill: z.boolean().optional(),
    dreaming: MemoryDreamingPolicy.optional() // valid only with provider: 'managed'
  })
  .strict()
  .superRefine(/* dreaming ⇒ provider === 'managed' */)
```

With managed memory, an absent `dreaming` policy resolves to `{ enabled: true,
schedule: '0 4 * * *', autoAdopt: true, mineSkills: true }`. The cron uses
daemon-local time when no timezone is set. An explicit policy preserves an absent
schedule as manual-only, while absent `autoAdopt` and `mineSkills` normalize to
the product default (`true`); an explicit `false` is the durable opt-out.
Auto-adopt is text-only and reversible; mined skills are still proposals that need
explicit approval before install, so `mineSkills` only surfaces candidates.

`memory-settings.ts` (console) grows a **Background memory** section rendered
only when the Managed provider is selected, presenting the two mechanisms as
one feature with two switches: _Capture (per turn)_ — the existing
`autoDistill` — and _Consolidate (dreaming)_ with its schedule, skill-mining,
and auto-adopt sub-controls.

## 4. The dream job (daemon)

A new `DreamRunner` in `packages/daemon/src/dream/runner.ts`, driven
by the daemon the same way distillation is:

**Job record** (persisted in the daemon store so a crash mid-dream is
recoverable and history is listable):

```ts
interface DreamRecord {
  dreamId: string
  agentId: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'canceled' | 'adopted' | 'discarded' | 'superseded'
  trigger: 'manual' | 'schedule' | 'auto'
  sessionIds: string[] // transcripts mined
  snapshotDigest: string // digest of the live store at snapshot time (adoption fence)
  executionSessionId?: string // session-list/history correlation for the isolated model run
  runtime?: string
  model?: string
  stopReason?: string
  instructions?: string
  /** Candidate skills staged by this dream (§7), with per-skill review state. */
  skills?: { name: string; state: 'proposed' | 'accepted' | 'dismissed' }[]
  usage?: SessionUsage & { inputBytes: number; outputBytes: number }
  error?: { type: string; message: string }
  createdAt: string
  endedAt?: string
}
```

**Pipeline** (one job at a time per agent; a second trigger while
`pending|running` is rejected):

1. **Snapshot.** Copy `<agent-root>/memory/` (excluding `.history`) into
   `memory-dreams/<dreamId>/input/`; record `snapshotDigest`.
2. **Gather signal.** Pull the relevant sessions' transcripts for this agent from
   the daemon store. The window is sized **automatically** (no operator config):
   the sessions with activity since the last successful dream — each one's
   `updatedAt` is at or after that dream's baseline — capped at 100; the first dream
   (no baseline) takes the current corpus up to the cap. The baseline is stamped
   **before** the source query and the comparison is inclusive (`>=`), so at
   millisecond resolution a session written in the same millisecond as the
   baseline is re-mined once rather than silently dropped: the invariant is
   "duplicates possible, gaps never". A scheduled tick with no such session is
   skipped (nothing new to consolidate). An explicit `sessionWindow` (a per-run
   manual override, or a legacy configured policy value) instead pins a fixed
   newest-N window. Every session the agent itself
   participated in is eligible — channel, DM, webchat, external (GitHub), A2A, and
   launched alike;
   the per-turn capture-visibility gate is deliberately **not** applied here (see
   session-visibility.md §5.1 dream-path carve-out). Peer isolation stays with the
   source: sourcing is `agentId`-scoped and each transcript returns only the rows
   this agent sent, received, or was delivered, so a peer's private session never
   enters. For memory consolidation only user/agent
   text rows are used; when `mineSkills` is set, tool rows are included as
   **titles plus truncated inputs** (command lines, file paths — enough to see
   _what_ the agent did) while raw tool outputs stay excluded, both for
   context-budget and for secret-hygiene reasons. Everything is clamped per
   session and overall, newest first until the byte budget is spent. The dream
   policy prompt — not a hard pre-filter — keeps a person's private/personal
   conversation from becoming shared organization knowledge.
3. **Dream.** Run an isolated ACP session on the agent's runtime host through
   the shared extraction-session helper (§8): temp cwd, read-only / plan
   permission mode when the runtime offers one, dream system prompt (§5),
   snapshot + transcripts as untrusted prompt data. Collect the streamed text
   exactly as distillation does.
4. **Validate & stage.** The store proposal is already on disk: the extraction
   session's `writeMemory`/`readMemory` are bound to `memory-dreams/<dreamId>/`
   as their store, so every topic file went through the same write path a turn
   uses (header normalize + stamp, byte cap, `.history`) — the binding also
   carries the two limits the old JSON format enforced, the topic regex
   `^[a-z0-9][a-z0-9-]{0,62}\.md$` and the bounded file count. Staging then
   generates the index from those files' `description` headers, so the index a
   human reviews is byte-for-byte the one adoption installs. Parse the returned
   JSON (§5) for the review queue only — skills and organization suggestions,
   validated per §7 — and stage candidates to
   `memory-dreams/<dreamId>/skills/<name>/`. A parse failure ⇒ `failed`, and so
   does a run that wrote no topic file while the live store had some: the store
   is what the model wrote, so writing nothing is no proposal at all, not an
   empty one — completing it would let adoption install an index-only store over
   a live one. The staging of a run that never completes is dropped.
5. **Finish.** Mark `completed`; emit `memory.dream.completed` on the
   evaluation-events channel (alongside the existing `memory.capture.*`
   events). If `autoAdopt` is set, run §6 adoption for the store — never for
   skills.

Cancel moves `pending|running → canceled` and aborts the ACP prompt (same
cancellation path as a turn).

## 5. The dream prompt

A `MEMORY_DREAM_SYSTEM_PROMPT` sibling to `MEMORY_DISTILLATION_SYSTEM_PROMPT`,
with the same injection posture and a five-phase pipeline:

- Every byte of memory and transcript input is untrusted data, never
  instructions; embedded instructions cannot change the rules.
- Phases: **orient** over the existing store → **gather signal**: mine the
  transcripts for corrections, preference shifts, decisions, and recurring
  patterns → **consolidate**: merge duplicates, keep the _latest_ value where
  entries contradict, convert relative dates to absolute, drop transient task
  progress and secrets → **prune**: give every topic a strong `description`
  header (the index is generated from those), demoting verbose entries into
  topic files → (when skill mining is enabled) **extract procedures**: identify
  workflows the agent performed repeatedly or re-derived across sessions and
  express each as a candidate skill (§7) — only procedures grounded in at
  least two distinct sessions, never one-off task steps.
- Unlike distillation, rewriting and deleting are **allowed** — that is the
  point — but only inside the staged store, never in the live one.
- Existing topic boundaries, filenames, and byte-identical content are
  preserved by default. Small wording, formatting, ordering, or consistency
  edits do not justify renaming a topic. A rename, merge, or split is proposed
  only when a material content change makes the existing structure misleading;
  equally faithful proposals prefer the smallest diff.
- The rebuilt store is WRITTEN, not returned: one `writeMemory` call per topic
  file, into a staging area that starts empty and replaces the live store on
  adoption — so a file the model does not write is how it prunes, and an
  unchanged file is copied byte-for-byte. `MEMORY.md` is generated, never
  written by the model.
- The JSON reply carries only the review queue:
  `{"agentSkills":[{"name":"...","description":"...","skill":"<SKILL.md body>",
"scripts":[{"path":"...","content":"..."}]}],"organizationKnowledge":[],
"organizationSkills":[]}` — skills present only when mining is enabled.
- The operator's `instructions` string is appended to the system prompt (it is
  operator-, not model- or user-supplied — same trust class as the rest of the
  prompt).

Where the runtime has no trusted system-prompt channel (today: Codex ACP),
the policy text is prepended to the user prompt instead. That is acceptable
because invariant 3 + staged output constrain the proposal to validated
managed-memory content. Independently, the extraction session is **hard-gated
on a verified read-only / plan mode** (§2); a runtime with no non-mutating mode
fails the dream. That gate is necessary but NOT sufficient — a real claude run
in plan mode still wrote files through its own tools (#1302) — so the staged
store is verified explicitly rather than trusted: staging refuses any file the
bound memory tools did not write. When `autoAdopt` is enabled,
a valid completed proposal is accepted on either prompt transport; the console
warns that this skips content review.

## 6. Adoption (memory store)

`adoptDream(agentId, dreamId)`:

1. Refuse unless `status === 'completed'`.
2. **Fence:** recompute the live store digest; if it differs from
   `snapshotDigest`, apply the distillation rebase rule (§8) — and if writes
   from any other source landed meanwhile, refuse with a conflict (the store
   changed while the dream ran — rerun or force). This mirrors the `ifMatch`
   optimistic-concurrency style of `writeMemoryFile`.
3. Atomically: rename `memory/` → `memory-backups/<ts>-pre-<dreamId>/`; move
   the staged store into place as `memory/`; carry `.history` over and append
   one `dream-adopt` line (`source: 'dream'`, dreamId, backup path).
4. Mark the record `adopted`. Every other `completed` store proposal for the
   agent is no longer based on the live store, so remove its store staging and
   mark it `superseded`; independently staged skill candidates remain
   reviewable. Existing completed proposals that predate the latest adoption
   are reconciled the same way when an older daemon store is upgraded.

`discardDream` deletes the staging directory and marks `discarded`. Backups
are pruned to the most recent one on each successful adoption.

`autoAdopt` runs the same path immediately on completion without content
review. The fence in step 2 still applies — on conflict the dream completes as
reviewable instead of failing, preserving newer live-memory changes.

## 7. Skill mining and recommendations

Facts are not the only durable asset in a trajectory. Agents repeatedly
re-derive the same procedures — a deploy sequence, a data-fixup script, a
platform-specific debugging workflow — paying the cost every session. When
`dreaming.mineSkills` is enabled, the extract-procedures phase (§5) turns
those recurring trajectories into **candidate skills** the user can review and
install for reuse in future sessions.

**Candidate shape.** Each candidate is staged as a standard skill directory —
`memory-dreams/<dreamId>/skills/<name>/SKILL.md` plus optional
`scripts/<file>` — so an accepted skill is consumable by the existing skill
installation machinery without conversion. Validation before staging: `name`
matches the topic-style regex (lowercase kebab-case), `SKILL.md` has
name/description frontmatter and is clamped, script count and per-script size
bounded, script paths confined to the skill directory, and a hard cap on
candidates per dream (e.g. 5) to keep review tractable.

**Recommendation, not installation.** Mined skills follow a stricter rule than
the memory store: **they are never auto-adopted**, even when `autoAdopt` is
set. A skill is executable instruction content that will steer future
sessions; a hallucinated or injection-shaped procedure is a standing
compromise, not a stale note. The console surfaces candidates as
recommendations with the full `SKILL.md` and script bodies rendered for
review. Per candidate, the user can:

- **Accept** — under the per-agent admission/host fence, the reviewed bundle is
  copied into a daemon-owned digest-addressed directory
  `<agent-root>/skills/.bundles/<name>-<sha256>` and an atomically replaced
  `accepted-skills.json` index selects that immutable revision. The accepted
  source is re-hashed against the index before use, and the installer verifies
  the same expected digest again when it snapshots the source. Only then does
  it join Git and managed sources in the same exact isolated
  `skills@1.5.21` CLI pipeline. Acceptance is not hot-injected into an existing
  host, and there is no Dream-specific workspace materializer or harness
  directory map. The `DreamRecord.skills[]` entry moves to `accepted` only
  after publication succeeds.
- **Dismiss** — the candidate is deleted and recorded as `dismissed`.
  Dismissed skill names are fed back into subsequent dream prompts as
  "previously declined" so the same recommendation doesn't reappear every
  cycle.

**Grounding rule.** The prompt requires every candidate to cite the sessions
it was observed in (session ids from the provided transcript set); the daemon
drops any candidate citing unknown sessions or fewer than two. This keeps
recommendations anchored to real trajectories rather than plausible-sounding
inventions.

Skill review states are independent of store adoption: a user can adopt the
consolidated store while dismissing every skill, or accept a skill from a
dream whose store proposal was discarded.

Organization-wide knowledge and skill proposals use a second, owner-reviewed
lifecycle described in `organization-knowledge.md`. Their bounded bodies remain
daemon-local while pending, are never covered by memory auto-adopt, and become
central immutable artifacts only after explicit acceptance. Agent-local skill
acceptance described above remains unchanged.

## 8. Interaction with auto-distillation

Distillation and dreaming are two layers of one background-memory system —
per-turn additive capture and periodic reconstructive consolidation. The
constraints are deliberately coupled: distillation may write to the live store
unreviewed because it is additive-only; dreaming may rewrite and delete because
its output is staged, validated, reversible, and either reviewed or covered by
the user's auto-accept policy. Neither subsumes the other: capture keeps facts
available in near-real-time; dreaming compacts what capture accumulates and
catches cross-session patterns capture cannot see.

Like dreaming, distillation runs on **every** harness (#653). The extraction is
hard-gated on a verified read-only/plan permission mode (attacker-controlled turn
text must never drive the runtime's native tools); the trusted system-prompt
channel is observed, not required — the policy rides `_meta.systemPrompt` when the
runtime has one, otherwise it is prepended inline to the turn, so runtimes without
that channel (Codex, OpenCode) distill too instead of silently no-op'ing.

> **Residual risk (owner-accepted P2, tracked in #658).** Unlike a dream,
> distillation writes to shared live memory **unreviewed** and runs on the agent's
> **warm host** (full tool credentials), not a dedicated `excludeAgentToolCredentials`
> host. On the untrusted-channel (inline-policy) path the policy and the turn share
> user-message priority, so a prompt injection could write poisoned facts, or read a
> warm-host credential and re-encode it into a "memory" (read-only blocks writes, not
> reads). #658 will give that path the dream's credential-isolated host; the
> trusted-channel path is unchanged.

Concrete unification points:

- **Shared executor.** `runMemoryExtraction` (daemon.ts) generalizes into one
  isolated-extraction-session helper used by both mechanisms: temp cwd,
  permission-mode gating, `_meta`/inline system-prompt routing, streamed-text
  collection, and the parse-JSON-then-validate posture. Distillation and
  dreaming become two policies (system prompt + output schema + write path)
  over the same machinery.
- **Distillation rebase at adoption** (implemented, D-2). Distillation may
  append to the live store while a long dream runs, which would trip the
  adoption fence and starve busy agents of ever adopting. On fence mismatch the
  rebase gets one chance to explain the drift, splitting the question in two:
  - **Authorization** comes from an in-process **write ledger**, not from
    `.history`. The log is best-effort by design (`appendHistory` swallows its
    errors so logging can never fail a write), which makes it a fine audit trail
    but an unsound authorizer: a tool write whose append was lost is invisible
    there, and a later distill row would make the window look distill-only. The
    ledger is bumped inside the write under the same lock, counts total vs
    non-distill mutations, and is stamped with an opaque per-process
    **generation** — counts are comparable only within one generation, because a
    restart resets them and numeric comparison alone cannot see that. A dream
    adoption's directory swap bypasses `writeMemoryFile`, so it records itself as
    a non-distill mutation; otherwise a second dream staged from the same
    snapshot could roll over the first adoption.
  - **Content** comes from the files, not from `.history`: a record's `after` is
    clamped to `MAX_HISTORY_VALUE_BYTES`, so a large file's row cannot be
    replayed faithfully. Because distillation is additive by construction,
    diffing the live file against the dream's own `input/` snapshot yields
    exactly the added lines; they are appended to the staged store, deduped
    against everything already there, and re-checked against the store's byte
    caps (the swap bypasses `writeMemoryFile`, so its limits are re-enforced
    here).

  Any write with a tool, console, or other source hard-fences to manual review,
  including when auto-accept is enabled.

- **Serialization.** Snapshot and adoption take the shared per-memory-dir lock,
  and a distillation batch holds that same lock end to end — it reads the index
  once and then writes a topic and the index, so if those were separate critical
  sections an adoption landing between them would be overwritten by the batch's
  stale index. The long-running dream execution itself stays off the
  chain; distillation continues normally while a dream runs (the rebase rule
  absorbs the drift).
- **One product surface.** The console presents both under a single
  "Background memory" section (§3) so users configure capture and
  consolidation as one feature, not two.

A possible future simplification — demoting distillation to a model-free
"append raw candidate notes" step and letting frequent cheap dreams do all
synthesis — is deliberately not designed here; it is a cost/quality experiment
to run once dreaming has usage data.

## 9. Triggers

- **Manual** — console "Dream now" button; the primary v1 path.
- **Scheduled** — the `dreaming.schedule` cron (+ optional `timezone`), driven
  by a `DreamScheduler` synced on the same agent reconcile as `agent.json.crons[]`.
  It is a SIBLING of `Scheduler`, not a reuse: that one synthesizes a message and
  runs it as a turn, while a dream is a background job with no conversation. A
  tick landing while a dream is in flight is skipped, never queued. Each fire
  also obeys the agent lifecycle gates (pause, safety-drain, per-agent drain,
  daemon drain) — as skips, so the schedule resumes by itself on unpause.
  Every tick stamps its occurrence in the shared store's `dream_runs` (the dream
  twin of `cron_runs`) BEFORE those gates, so the stamp records that the moment
  was serviced here rather than that a dream ran. On gaining an agent's duty a
  member compensates the one occurrence a handover swallowed — the newest missed
  moment only, inside a grace window of one interval capped at an hour, claimed
  by a CAS on the stamp so two members racing a handoff dream once. The row also
  fingerprints the policy fields that define the schedule (enabled + expression +
  timezone), because a mutable policy makes a bare stamp meaningless: a catch-up
  is eligible only under the same definition, and a reconcile that sees a moved
  one retires the stamp so the new policy starts clean.
- **Idle-triggered (later)** — "N hours since the last consolidation and the
  agent has been active since" fits the daemon (it already tracks per-agent
  activity), as a follow-up once scheduled dreams are proven.

## 10. Control plane and console

The CP stays off the hot path and stores **metadata only**, per the
architecture invariant:

- **Frames** (`packages/protocol/src/frames/memory.ts` additions):
  `dream.start`, `dream.cancel`, `dream.list`, `dream.get`, `dream.adopt`,
  `dream.discard`, `dream.skill.accept`, `dream.skill.dismiss`, plus a
  `dream.review` read that returns the staged store tree and skill candidates
  via the existing byte-sliced CP memory-reader path (`cp/memory-reader.ts`)
  so staged bodies are proxied, bounded, and never persisted by the CP.
- **CP REST** under the agent memory surface
  (`/agents/:id/memory/dreams[...]`), tagged/summarized per the OpenAPI
  conventions; the CP relays over the daemon WS and stores at most the
  `DreamRecord` metadata (including per-skill review states) for listing when
  the daemon is offline.
- **Console** — the Background memory section (§3) plus, per dream: a review
  screen showing a current-to-staged line diff for each store file (reusing the
  managed-memory history diff and file browser components) with Adopt / Discard.
  When Adopt hits the §6 snapshot fence (the live store moved under the dream),
  the console does not dead-end on the error: it offers "Adopt anyway" (the
  `force` flag), warning that adoption is a whole-directory swap and naming the
  live-only files it would drop, with re-running the dream as the alternative
  that keeps the newer changes. The review screen also has a
  "Recommended skills" list rendering
  each candidate's `SKILL.md` and scripts with Accept / Dismiss. Accepted
  skills also surface on the Tools & Skills page alongside imported sources.
  Both branches of the mobile/desktop split follow the existing
  memory-settings pattern.

Observability:
`memory.dream.started|completed|failed|adopted|skill_accepted|skill_dismissed`
evaluation events carry correlation, lifecycle, runtime/model, token/cost, and
bounded byte-count metadata. Every extraction is also represented as a `dream`
session in the normal Sessions list and usage reports. Its history contains the
original ACP activity, using the same transcript recorder as an ordinary session:
the exact extraction prompt, raw reasoning, merged tool call/update bodies, and the
model's final proposal. Because those bodies can quote the memory snapshot and
source transcripts, agent session authorization is the privacy boundary. Raw Dream
activity never enters generic evaluation events, logs, or the triggering chat. The
Memory Dream list links the execution session and shows that run's model, duration,
token/cost, and prompt/output byte metrics. Source-session selection is input
metadata, not the Dream session's usage.

## 11. Explicitly out of scope (v1)

- **`native` provider** — the runtime owns that store; rewriting it behind the
  runtime's back risks divergence. If a runtime grows its own consolidation
  feature, `native` users get it from the runtime.
- **`external` provider** — record-shaped stores could support a dream as a
  plugin-side reorganize, but that belongs in a Memory Plugin ABI revision,
  not core.
- **Cross-agent / shared-scope dreams** — blocked on the M-6 shared-scope
  work in memory-evolution.md.
- **Auto-installing mined skills** — skills are always human-reviewed (§7);
  no unattended path is planned.
- **Unreviewed cross-agent skill sharing** — Dream cannot publish or enable a
  shared skill. The reviewed organization proposal path is specified separately
  in `organization-knowledge.md`.

## 12. Phasing

| Phase | Scope                                                                                                                                                                                   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1   | Protocol schema (`MemoryDreamingPolicy`), shared extraction-session helper, daemon `DreamRunner` + staged store pipeline, manual trigger via frames, console review + adopt/discard.    |
| D-2a  | `autoAdopt` independent of prompt-channel trust, the distillation rebase rule, backup pruning. **Done.**                                                                                |
| D-2b  | Scheduled dreams (`DreamScheduler` cron trigger + reconciliation) and the console schedule control. **Done.** Evaluation-event dashboards remain.                                       |
| D-3   | Skill mining (`mineSkills`): extract-procedures phase, staged skill candidates, console recommendations with accept/dismiss, integration with the shared-skills install flow. **Done.** |
| D-4   | Idle-trigger heuristic; revisit external-provider dreaming.                                                                                                                             |
