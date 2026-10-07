# Assistant Mode

**Status:** Design, fourth revision (2026-10-07). Reviewed by three independent design reviews and
the repository's review bot; §10 records what each round corrected. Nothing is implemented yet.
Prerequisites: #2812, #2813. Work breakdown: #2810.

**In one sentence:** switch an agent into assistant mode and it behaves like one person on the
team — it keeps a continuous conversation with you in every place, what it hears in one place it
knows in the others, it only says what the people present may hear, it keeps a ledger of what
everyone asked of it, checks on progress by itself, speaks up only when there is something to say,
and asks before it acts.

**Name:** unrelated to [agent-assistant.md](agent-assistant.md), which is the AgentConnect MCP
tool set for AI tools. That design gives an agent tools to administer the platform; this one
describes how an agent behaves.

**Builds on:** [resource-visibility.md](resource-visibility.md) §14 (conversation gating:
authorize places), [session-visibility.md](session-visibility.md) (session visibility, the
private-session memory exclusion), [channel-session-mode.md](channel-session-mode.md) (`append`
long sessions), [agent-collaboration-implementation.md](agent-collaboration-implementation.md)
(`sendMessage` with `toAgent` / `needsReply`), [memory-dreaming.md](memory-dreaming.md) (the
per-agent built-in switch and the dream host), [slack-approval-dm.md](slack-approval-dm.md) (the
two in-chat approval paths), [webchat-side-panels.md](webchat-side-panels.md) (the console dock).

**Principle:** the simplest thing that works. Assistant mode leaves the agent's permission
policy, workspace isolation and command permissions alone, reuses an existing mechanism wherever
one exists, and does not pretend to defend against effects it cannot defend against.

---

## 1. The experience

### 1.1 One person

- **Every place is one long conversation.** Each person's DM with it, each channel, each webchat
  conversation. Wherever you find it, it remembers what was said there — after months of silence
  too.
- **One mind behind them.** Something asked of it in one place is known in the others; a
  discussion in an internal channel can be recalled when you ask about it in a DM.
- **It speaks for the room.** In a place it draws only on what everyone present may see, and
  writes only to that place. Nobody can get at another person's DM; when something cannot be said
  here, it says "ask me in a DM".

### 1.2 Asking it to do things

- Ask as you would a colleague. It restates its understanding — what to do, what counts as done,
  when to check next — and on your confirmation the item enters its ledger.
- The ledger is visible to the team. An item born in a DM records who asked for what, never the
  DM's wording; it says so when it takes the item.
- **It reports to whoever asked, in the place they asked.**
- When two people ask for the same thing in different places, it asks "attach this to X's item?"
  when restating, and both receive the report after you confirm.
- When the asker can no longer be reached (DM closed, left the channel), reports go to the agent's
  responsible user or fallback conversation.

### 1.3 Long work: sub-sessions

- A sub-session is an **implicit background session opened on demand** — "fix this bug and open a
  PR". Ordinary conversation stays in the main conversation.
- In an IM: the main conversation says "started", then reports the result with a console link.
  Nothing extra appears on the platform.
- Steering and stopping go through the main conversation: "change the PR task to X", "stop the
  PR one".
- In webchat: the sub-sessions a conversation opened are visible — watch, talk to one directly,
  stop one.
- The workspace is whatever the agent's other sessions get: a worktree each under session
  isolation, the shared primary otherwise.
- It finishes the work inside the workspace and asks separately for the outward step (push, open
  the PR). If it hits an operation that needs approval midway, it waits; the card goes to the place
  you asked from; it continues once you approve.
- Sub-sessions are one level deep; concurrent ones are capped and queue beyond the cap, and it
  tells you.

### 1.4 Stopping

- "Stop" in the main conversation interrupts only that conversation's current turn — **not the
  work already delegated**, and it does not mute the conversation.
- To stop one piece of work, name it in the main conversation or stop it in webchat. That
  interrupts its current turn; a background process the runtime started itself (a build, a dev
  server) may keep running and is marked as such.
- To stop everything, **pause the agent** in the console (today's pause): main conversations,
  sub-sessions and patrols stop until resumed. Patrols missed meanwhile are not replayed; items
  whose check is overdue are each checked once on the next patrol.
- Stopping never undoes what is already done.

### 1.5 While you are away

- At the agreed times it looks at the items in its ledger, **read-only**: it checks status, reads
  logs, looks at PRs — no edits, no messages, no clicks. What always holds: it does nothing under
  its own identity and writes nothing through AgentConnect. "Does not touch your workspace" holds
  when the runtime has a read-only mode or runs in a sandbox; without either, the settings page
  shows the patrol as _degraded_ (§5.9 says what that means).
- Three outcomes: something you should know → one message; something it wants to do → a card
  "I want to do X because Y, OK?"; nothing → silence.
- One message per item per state; non-urgent items go to the inbox; after repeated failures it
  stops itself and tells you once. A turn interrupted by a rolling deploy is re-run without
  bothering you.

### 1.6 Approval

- The card lands in the item's place of origin. Who may approve follows the existing in-chat
  approval rules: with "allow runtime changes in chat" switched on, anyone who sees the card can
  click; otherwise the console and the editor DM path. The card offers "always allow this tool".
- The card leads with one plain sentence; the raw arguments are folded underneath.
- It acts only after approval and reports back. An uncertain outcome is reported as "not sure this
  went through, please look" — never retried. An expired card is never executed.

### 1.7 Progress

- "What's on your plate?" lists the items it follows, what it last saw for each, when it checks
  next, what awaits approval, which sub-sessions are running.
- The console has the same Activity view plus recent patrols. The ledger is editable; delete an
  item and it drops it.

### 1.8 Enabling

- Switch assistant mode on in the agent's settings. The agent must pass admission (§4.1); an
  agent that does not gets a locked switch with the reason. An agent whose permission policy is
  "ask every time" gets a warning: background work will wait for approval often; consider
  auto-approving workspace-local operations.
- Once on, the agent is off everywhere; an editor enables places one by one. Enabling a place
  trusts it as _internal_ unless the platform detects it as _external_ (§5.3); the enable flow
  warns "everyone here will be able to get the content of other internal places out of it;
  enable only if fully trusted".
- It acts with the agent's own identity and permissions, never someone's personal account.

---

## 2. Prior art

| Reference                                                               | Taken                                                                                                                                                                                                                                                                                                                                | Not taken                                                                          |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Hosted always-on personal and coworker agents (two launched in 2026-09) | Goals outlive conversations; the agent wakes itself; proactive research is read-only; it speaks only when needed; **rules first, free rein on its own computer, consequential actions brought back for approval, waiting without a deadline**; stopping the main task does not stop delegated work; each task in its own environment | The personal form (acting as a user with that user's accounts)                     |
| An open-source personal-agent template                                  | The approval record: hash-bound, expiring, `outcome_unknown` never retried; idempotent notifications; failure backoff and auto-pause                                                                                                                                                                                                 | Rule-based idea generation; a task model that re-runs from scratch each time       |
| An open-source coworker-agent template                                  | Scheduled turns run in the original conversation; interruption waits for human review before retry                                                                                                                                                                                                                                   | One task at a time globally                                                        |
| A durable agent-harness library                                         | The shape of background sub-agents: own conversation, anchored outside the parent's abort, replies delivered back as follow-ups, request ids on every delivery and report; sub-agents cannot spawn sub-agents                                                                                                                        | Using it as a runtime                                                              |
| A commercial AI coworker for team chat                                  | **Access scoped per person, enforced at recall**; DM content cannot be asked out of it; shared-channel mentions answered in a DM; approval cards lead with a sentence and offer "always allow"; stopping the main task does not stop scheduled ones                                                                                  | One session per thread plus memory retrieval                                       |
| An open-source self-hosted multi-agent assistant                        | Read-only as a per-session tool filter; self-scheduled tasks in two tiers (push text without a model / run a turn); push cadence with active hours, random intervals and a dedup record; background replies only raise an unread badge                                                                                               | No distinction between senders in an IM; a per-thread persisted "allow all" bypass |

---

## 3. Where the code is today (verified)

| Needed                          | Today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One long conversation per place | Channel `append` exists. Telegram, Discord and Feishu DMs are already one continuous session; **only Slack DMs** open a session per top-level message. The restriction lives only in the web control; CP and daemon do not check the conversation kind                                                                                                                                                                                                                                                                                                                       |
| Keeping long sessions           | `append` sessions idle past the retention window (default 7 days) are reclaimed; on the pool, a session-isolated session's volume follows its row                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `append` visibility lock        | Documented, **not enforced** (`SessionChangeVisibility` in `policy.ts` checks ownership only); a channel session's owner is its first poster — #2813                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Conversation gating             | Exists (§14): a restricted agent is off everywhere, an editor enables places; `gated` is derived from `visibility === 'restricted'`; §14.8 auto-enables DMs of `sharedWith` members                                                                                                                                                                                                                                                                                                                                                                                          |
| Session visibility              | DMs and webchat are `private`; channels **and group DMs** default to `org` (the group-DM case is tracked separately)                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Presence data                   | The daemon has none: member listing is authoritative only on Slack and unpaginated; Telegram returns admins; Discord returns nothing                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| DMs and memory                  | Private sessions are excluded from per-turn capture; **dreams deliberately mine every session, DMs included** (prompt-only); explicit memory writes offer "allow for this session", a grant kept until restart. Channel sessions (external ones too) **are** captured and dreamed                                                                                                                                                                                                                                                                                            |
| Self-delegation                 | Only the channel-root form; the direct form refuses a self target (both admission checks exempt channel-root only). **In an `append` channel, agent-to-agent wakes resolve to the target's long-session coordinate** (`targetSessionCoordinate`), so self-delegation lands back in the main conversation today. A channel-root self-wake into a DM classifies by destination with no owner                                                                                                                                                                                   |
| Reports                         | `replyToSession`: injected into the parent session, never posted, through the parent's serial gate. Gaps: link state in memory (`childSessionLinks`, cleared at 2000); random delivery id; a full parent queue (10) drops the report; `!stop` deletes the queued messages and their inbox rows; a failing turn rejects everything queued; no report on failure; reports count as agent calls, and the hop cap is today's only loop bound                                                                                                                                     |
| Stopping                        | `!stop` interrupts the session's current turn, does not cascade, does not mute under `append`; senders are any non-bot member of an enabled place. Agent pause (#288) interrupts every session and **drops queued messages**; nothing is replayed on resume. ACP cancels whole turns only; runtime-started background tasks cannot be stopped                                                                                                                                                                                                                                |
| Concurrency                     | Sessions sharing a workspace are **not serialized** (`admitActiveDispatch` waits on workspace mutations only); turns from several channels already run in parallel in one directory                                                                                                                                                                                                                                                                                                                                                                                          |
| Deadline wake                   | The orchestration tool triple is retired from the tool surface; the deadline wake remains, bound to the `orchestration` table, re-armed on startup and duty changes with CAS claim                                                                                                                                                                                                                                                                                                                                                                                           |
| Read-only modes                 | Matched by **name** (`read-only`, else `plan`). Claude Code has `plan`; **OpenCode's `read-only` is a daemon-authored agent injected only on the credential-less dream host**, a normal host has native `plan` with bash allowed; **Codex's `read-only` profile opens the network when the managed credential channel is enabled**, so a "read-only" session can run write calls through that channel with no permission request — both are credential problems, not filesystem ones. Dreams use a credential-less host; **per-turn distillation uses the agent's own host** |
| Runtime versions                | Managed Codex follows a floating release channel (`version: ''`); only probed versions are known                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Workspace isolation             | `isolation: session` applies to git mode only; **scratch is always `shared`, on the pool too**                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| In-chat approval                | The in-conversation card does no per-user authorization, hence off by default behind `allowRuntimeChangesInChat`; otherwise the editor path. Both the card and the editor DM **exist on Slack only**, and both bind to a pending ACP request                                                                                                                                                                                                                                                                                                                                 |
| Context size                    | The daemon has `contextUsed` (usage snapshots) and infers compaction from it; the reminder path `shouldRemind` already handles first turn, restart and compaction                                                                                                                                                                                                                                                                                                                                                                                                            |
| Slack auto-join                 | `joiningOnRefusal` joins public channels on demand; the join fires `member_joined_channel` and re-reports from the authoritative snapshot                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Pending cards                   | `OrganizationSuggestion`'s card component is reusable; its review route is owner-only and is not                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Self-hosted groups              | Without a shared store, records stay on the member that wrote them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

---

## 4. Scope and admission

### 4.1 Admission (checked on enable; a failing check locks the switch)

| Dimension         | Requirement                                                                                                                                                                                                                                                   | Why                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime           | On the **admission list**: native cross-session memory can be disabled; a session resumes by id after a runtime restart. **No genuine read-only mode required**: the patrol guarantee is stated by layer in §5.9, and a runtime without one shows as degraded | Memory bypass, long sessions and resuming a sub-session after approval depend on it. Registering strict read-only semantics would lock most runtimes out |
| Memory            | `managed` or `none`; per-turn distillation (`autoDistill`) recommended off; if on, the trade-off in [memory-dreaming.md](memory-dreaming.md) §8 applies                                                                                                       | P1's per-person memory space is built on managed memory only; distillation runs on the credentialed warm host                                            |
| Self-hosted group | Every member shares the store (the CP verifies store ids); single daemons unaffected                                                                                                                                                                          | Otherwise the ledger, approvals and pending reports stay on the old member after a handover                                                              |
| Executors         | Assistant-mode sessions never spread to remote executors                                                                                                                                                                                                      | Not possible today either                                                                                                                                |
| One per place     | One assistant-mode agent per place (`transportScope` + channel)                                                                                                                                                                                               | With two, who speaks and where reports go has no good answer                                                                                             |

Not admission criteria: platform (all allowed; enabling a place trusts it, §5.3), channel trigger mode
(user configuration), workspace mode and isolation (§5.6), sandboxing, permission policy (`ask`
only warns), a linked identity for the responsible user (a fallback conversation is required when
no DM can be reached).

### 4.2 Prerequisites (independent of assistant mode, done first)

1. **`append` sessions kept, for assistant-mode agents first** (#2812): no idle reclaim; a
   session retires only when the agent or integration is deleted or a user sends `!new`. Run
   state (worktree, pool volume) persists with it; decoupling run state from the session row so
   it can be reclaimed and rebuilt is the follow-up, after which the exemption can widen.
2. **`append` sessions refuse `setVisibility`** (#2813): a live bug; the CP predicate refuses
   the action for `append` coordinates.

Not a prerequisite: per-turn distillation on the credentialed warm host (#2814, closed) — it is
off by default and its exposure is a recorded trade-off in [memory-dreaming.md](memory-dreaming.md)
§8; moving it to a credential-less host would cost a cold host launch per turn. Patrols have their
own credential-less launch.

---

## 5. Design

### 5.1 The switch

A per-agent built-in policy beside `BuiltInMemoryBinding.dreaming`:

```ts
export const AssistantModePolicy = z
  .object({
    enabled: z.boolean(),
    /** Where undeliverable reports and unclaimed items go; at least one */
    responsibleUserId: z.string().optional(),
    fallbackConversation: ConversationRef.optional(),
    /** Patrol cadence; absent ⇒ events and each item's own nextCheck only */
    patrolSchedule: z.string().min(1).max(128).optional(),
    timezone: z.string().min(1).max(64).optional(),
    instructions: z.string().max(4096).optional(),
    limits: z
      .object({
        maxConcurrentSubsessions: z.number().int().min(1).max(50).optional(),
        dailyPatrolBudget: z.number().int().min(1).max(500).optional(),
        dailySubsessionsPerItem: z.number().int().min(1).max(50).optional(),
        permissionWaitHours: z.number().int().min(1).max(72).optional()
      })
      .optional()
  })
  .strict()
```

On enable: §4.1 is checked; the agent enters conversation gating (`gated` derived from
"restricted **or** assistant mode"); already-enabled rows keep their state and, like any enabled
place, count as internal unless the platform detects them as external (§5.3), so the switch shows
the enable warning for them; DMs auto-enabled by §14.8 for `sharedWith` members count as internal
(that person is an organization member). The agent's permission policy and workspace isolation
are untouched.

### 5.2 Places and long conversations

A _place_ is an IM conversation (DM, group DM, channel) an editor enabled, or a webchat
conversation. Each place has exactly one long session:

- **Channel**: forced `append`. Rows already in `append` are taken as they are; Linear rows are
  skipped; Decision-gated rows are not forced to change mode.
- **DM**: Slack DMs gain `append` (other platforms are already continuous). Fixed `private`.
- **Group DM**: treated as a small private channel; for recall it counts as external. Its
  console-side default of `org` visibility is a session-visibility matter tracked separately.
- **Webchat**: one conversation is already one session.

Long sessions are kept per §4.2. Context relies on the runtime's own compaction; the standing
summary rides the existing reminder path (§5.4). The trigger for an automatic rollover (reopening
the context with the ledger and summary as a handover note) is an open question (§9).

### 5.3 Trust level

The daemon has no presence data and member enumeration is not made a prerequisite. There is no
per-place trust setting: **enabling a place on an assistant-mode agent trusts it as internal**
(everyone here is an organization member), on top of conversation gating. The enable flow shows
the warning "everyone here will be able to get the content of other internal places out of it;
enable only if fully trusted". The only exception is an **external** level the platform detects:

- Slack: a Slack Connect channel (`is_ext_shared` / `is_pending_ext_shared` on the existing
  membership listing) is external; a later listing that no longer reports the share lifts it.
  Detection reads only that listing — no new API call, no manifest change.
- Guests (`is_restricted` / `is_ultra_restricted`, one `users.info` per member join) and the
  `channel_shared` event are detected in the change that adds the downgrade transition below,
  and only for assistant-mode agents.
- Telegram groups, Discord channels, Feishu groups: no detection; enabled means trusted.
- DM: enabling it is trusting that person as a member. Webchat is internal by construction.
- **Trust propagates downward**: a sub-session's place is its parent's; an item's trust level is
  the lowest among its followers' places; a patrol's tool scope follows the item's level.
- **The downgrade transition (internal → external) retires context, not just the flag.** The
  place's long session was populated under internal permissions: recalled transcripts and memory
  reads sit in its ACP context whether or not they were ever posted, and a sub-session born there
  carries the same context. On a downgrade — a detected share, a `channel_shared` event, a guest
  joining — the daemon: interrupts the place's in-flight turn; retires
  the long session the way `!new` does (a fresh coordinate, so the next message starts from an
  empty context with the external-filtered standing summary); interrupts the sub-sessions born in
  that place and drops their pending full-text reports (structured rows stay); leaves pending
  approval cards in place. The retired session's transcript keeps the visibility it had. An
  upgrade (external → internal) needs no transition.
- **An agent with a shared workspace cannot be enabled in an external place** (git with shared
  isolation, scratch): workspace files cross places, and the runtime's native file tools cannot
  be filtered.
- Joining a public Slack channel on demand (`joiningOnRefusal`) does not create a place: an off
  row is not a place, and no filtering of self-initiated joins is attempted.

### 5.4 The shared mind

**① The item ledger** (daemon store, partitioned by agent, moving with duty):

```
{ id, title, doneWhen, nextCheck, status: active | waiting | done | dropped,
  followers: [{ identity: '<platform>:<scope>:<uid>' | 'user:<id>', place }],
  origin: place, trust: internal | external,      // = lowest among followers' places
  summary, observations: [...], subsessions: [...], proposals: [...], version }
```

- Item summaries are visible to organization members; the wording stays in the source session.
  Observations written by patrols are bound by standing instructions: team-visible, no quotes,
  source content framed as untrusted data.
- The ledger does not pass through the shared-memory exclusion gate — it is its own store, not
  agent memory.
- Concurrency: field-level merge (append observations), CAS only on state transitions.
- Followers are keyed by platform identity plus place, with no cross-platform merge (P1).
  "Someone left" is handled by **delivery failure**: an undeliverable report goes to the
  responsible user or fallback conversation.
- Duplicates are never merged automatically; the model asks when restating and calls
  `attachFollower` on confirmation. Conflicts between followers are not detected in P0; the model
  says so in the current place and writes it into the summary.

**② The standing summary**: `id`, title, status and followers' places of active and waiting
items; capped at 30; injected through the existing reminder path (`shouldRemind`, which already
handles first turn, restart and compaction). External places receive only locally-born items.
Incremental injection (`lastInjectedVersion`) is not in P0.

**③ The recall tool** `recall({ place, query })`: reads this agent's transcript excerpts from
another place, under §5.5.

### 5.5 Permission rules

> **Read**: in an internal place, any other internal place may be recalled; everywhere else reads
> only itself. Another person's DM, never.
> **Write**: platform write tools (`sendMessage`, `shareFile`, `scheduleMessage`, canvas, lists…)
> target only **the current place**; anything cross-place goes through §5.7 as structured fields.

| Current place              | Recallable sources                             | Memory / knowledge                                                                                                                                                                  |
| -------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P's DM (internal)          | P's own DM and webchat, every internal channel | all                                                                                                                                                                                 |
| Internal channel           | itself, every other internal channel           | all                                                                                                                                                                                 |
| External channel, group DM | itself only                                    | **closed**: memory recall, `readMemory`, `findKnowledge` and cross-place read tools (`getChannelHistory` and kin) — internal channel content is already captured into shared memory |
| Webchat                    | as a DM, by the conversation's owner           | all                                                                                                                                                                                 |

- Webchat ↔ IM recognition depends on identity links (P1); in P0 webchat recalls only itself and
  internal channels.
- **"Ask me in a DM"**: asked in place B for something only the asker may see, or asked for
  internal content in an external place, B's session neither reads nor answers; it says "ask me
  in a DM". P1 adds `handoff`: a row through §5.7 to the asker's DM carrying the original
  question, answered there by the DM session under its own permissions (the human-reaching
  `sendMessage` only sends already-generated text and starts no turn in the DM, so it is not used).
- No output filter; one zero-cost assertion: a source read during a turn that is outside the
  current place's allowed set raises an error metric.
- **Memory bypass**: in P0, dreams and explicit memory writes skip `private` sessions for
  assistant-mode agents, filtered by the CP-confirmed bit; "allow for this session" is removed on
  `append` sessions. P1 adds the per-person memory space. This is a retreat from today's dream
  behavior and [memory-dreaming.md](memory-dreaming.md) says so. Runtime native memory must be
  disableable (admission) and is disabled on enable.

### 5.6 Sub-sessions

- **Opening**: self-delegation without a post — the direct form of `sendMessage({ toAgent })`
  accepts a self target (both admission checks exempt it; `targetSessionCoordinate` is skipped),
  and the sub-session gets **its own coordinate**. It inherits the parent's visibility and owner
  through the A2A path; **visibility changes on sub-sessions are refused** (a channel parent's
  owner is its first poster).
- **Workspace**: no dedicated workspace and no change to isolation. Under session isolation each
  session has its own worktree; otherwise (git shared, scratch) sub-sessions share the primary
  like every other session of the agent — turns from several channels already run in parallel
  there today.
- **Relation to the main conversation**: the main conversation can list, steer (reuse
  "re-delegate into the same child") and stop a sub-session; listing needs a **persistent
  parent–child index** (`childSessionLinks` is in memory).
- **Runtime permission requests** (far more common than `propose`):
  1. Standing prompt: finish the work in the workspace; the outward step (push, open the PR) goes
     through `propose`.
  2. When one fires it is delivered to the place of origin as a card through the existing two
     approval paths and listed in Activity; the card offers "always allow this tool".
  3. **Waiting is waiting**: the ACP request stays open and the turn is not cancelled — the card
     and both approval paths are bound to that pending request; cancelling it expires the card,
     and a later "continue" grants nothing to the re-triggered request. Host and concurrency slot
     stay occupied (the slot bounds occupied hosts anyway); Activity shows "awaiting approval".
     `permissionWaitHours` (default 12) caps the wait: then deny, report, and the sub-session
     stops; re-delegate to continue and it asks again. Cost: on the pool a waiting sub-session
     holds a pod. If that becomes a cost problem, P1 may add "cancel the turn plus a cross-turn
     one-shot grant".
  4. The user's permission policy is never changed; an `ask`-policy agent gets the warning in
     §1.8.
- **Webchat**: a text list (list / stop) in P0b; the dock panel in P1.
- **What stopping guarantees**: the current turn; a background process the runtime started may
  keep running; the adapter is never killed.
- **Limits**: no sub-sessions of sub-sessions; at most `maxConcurrentSubsessions` running, the
  rest queued (persistently) with the asker told; `dailySubsessionsPerItem` per item per day
  (§5.7's loop bound).

### 5.7 The report channel

> **Background sessions never speak on the platform.** Sub-session reports, patrol results,
> permission requests and notifications are each one report injected into the target place's main
> session, which speaks for them.

Implemented as a **persistent per-place outbox** (a table shaped like `orchestration_subtask`:
agent-owned, CAS-claimed, duty-gated, re-armed on `agentsGained`):

- **Merged per place**: however many rows are pending for a place, one "report round" carries
  them all (capped; the rest wait for the next round), sidestepping the 10-row session queue.
- **Ack on round completion**; **`!stop` acks the current batch** (suppressed, never returns);
  a retry cap per row, beyond which the row goes to a dead letter and the responsible user is
  told. At-least-once is accepted; the prompt carries row ids.
- **Delivery id** derived from source session + the delivery that woke it + target place +
  sequence number.
- **Structured fields only across places**: `itemId`, event type, a one-line conclusion already
  present in the team-visible summary. A sub-session's own text goes only to its place of birth.
  Event types include `handoff` (P1) and `permission`.
- **Failure is reported too**: a sub-session that fails, is fenced or times out gets an outbox
  row written by the daemon.
- **Report rounds are admitted as human messages**, hop reset; the loop bound moves to a chain
  depth carried on the outbox row and the per-item daily sub-session budget.
- **Anti-nag**: the idempotency key `(agentId, itemId, status, observation version)` doubles as
  the delivery dedup key.
- **Handover versus failure**: an interruption whose reason is `shutdown` or `superseded`
  (**not `pause`**, which drops queued messages and replays nothing) is recovered per session
  kind, in order:
  1. **Approval-execution sub-sessions first, outside generic recovery**: an interrupted
     sub-session of an `executing` record marks the record `outcome_unknown` and its inbox row is
     excluded from replay. Moving the proposal to `executing`, recording the sub-session id and
     writing the marked inbox row happen **in one transaction**.
  2. **Patrols** re-enter silently.
  3. **Ordinary sub-sessions** follow today's handover replay; the re-entry prompt says "re-run
     after an interruption, verify the current state first", and the item gets an observation.
  4. **Report rounds** are re-delivered.
- Cost: every report round is one long-context turn of the main session; merged delivery and
  "silence when nothing happened" are the main controls.

### 5.8 Stopping

| Action                                        | Effect                                                                                                          | Who                       |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------- |
| "Stop" in the main conversation               | Interrupts that conversation's current turn only                                                                | today's `!stop` rules     |
| Stop one piece of work (named, or in webchat) | Interrupts that sub-session's current turn                                                                      | same / console editor     |
| **Pause the agent** (existing #288)           | Interrupts every session and blocks new turns (today); assistant mode also suspends patrol wakes and the outbox | existing pause permission |

No new "stop everything". The sender rules for `!stop`, `!new` and pause are **unchanged and not
narrowed** — effects at this level cannot be defended against, and the design does not pretend
to. Resume: no catch-up; items whose `nextCheck` passed are each checked once on the next patrol;
killed sub-sessions do not restart. Stopping never undoes completed effects.

### 5.9 Patrol (P1)

```
patrolSchedule fires / hook event (P2) / an item's nextCheck is due
        │
        ▼
  [optional, P2] Decision triage with a small model
        │
        ▼
  Patrol: a headless read-only sub-session on a **credential-less host**
  "read these items → check for changes with read tools → update the items (with notify) → end"
        │
  ┌─────┼──────────────┐
 notify  propose      silence
 (through §5.7 to each follower's place)
```

- **"Read-only" has three layers, each with its own guarantee:**
  (a) AgentConnect-injected tools are filtered per session; a patrol gets read tools and
  `propose` — **guarantees** nothing is written through AgentConnect;
  (b) the patrol host is launched like a dream host: **without the agent's tool credentials** and
  with a **throwaway cwd** (a dream's `input/` works this way), not the agent's workspace —
  **guarantees** nothing is done under the agent's identity; the cwd only anchors relative paths
  and is not filesystem isolation;
  (c) the runtime's closest-to-read-only mode (chosen by name, `read-only` else `plan`), the
  daemon's permission policy "bridge tools allowed, everything else refused", and whatever
  sandbox the agent already runs in — layered when present, **not admission criteria**. "Does
  not touch the agent's workspace" holds at this layer only: a read-only mode, or a sandbox that
  blocks the workspace.
  **Degraded** (a runtime with no read-only mode, native tools that raise no permission request,
  and no sandbox): the native shell can still write the agent's workspace by absolute path or
  `../` and still make network requests that need no credentials; only (a) and (b) hold. This is
  the residual class [memory-dreaming.md](memory-dreaming.md) records for dreams; it is accepted
  and the settings page marks the patrol _complete_ or _degraded_ per runtime.
- **The patrol's read surface** (in the standing prompt): the bridge's code-host read tools
  (`readCodeHostDiscussions`, `inspectCodeHostPipelines`, using the daemon's credentials),
  channel history, the ledger, memory under §5.5. `gh`, `curl` and user MCP servers are
  **unavailable**.
- **Completion**: each round must update the `observations` of the items it checked; a round
  that updates nothing is recorded as `incomplete` and reported once.
- **Wake on time**: an item's `nextCheck` uses the deadline wake, generalized out of the
  `orchestration` record.
- **Two tiers of self-scheduling**: `remind` (deliver text at a time, no model turn) and
  `patrol`.
- **Budget and backoff**: `dailyPatrolBudget`; after a failure the next attempt backs off by
  `min(60, 2ⁿ)` minutes, and five consecutive failures pause that item's patrols.
- **Start condition**: not before each runtime has been tested for exactly the residual stated
  above.

### 5.10 `propose` and the approval record (P1)

```
{ id, agentId, sentence, why, evidence, action, args, place,
  hash = sha256(action + args + executing identity + target version),
  status: awaiting_review | executing | succeeded | failed | outcome_unknown | denied | expired,
  createdAt, expiresAt = createdAt + 30min }
```

- The card is delivered through §5.7 to the item's place of origin.
- **Approvers follow the existing two paths** (`allowRuntimeChangesInChat` on ⇒ any participant
  of the conversation may click; off ⇒ the editor path). Only the policy is reused: both existing
  paths bind to a pending ACP request, so a `propose` record that outlives a turn is a new
  mechanism; the chat card and the editor DM exist on Slack only, other platforms use the console.
- Approval ⇒ CAS to `executing`, record the sub-session id and write the marked inbox row in one
  transaction ⇒ open a normal-permission sub-session.
- An uncertain outcome ⇒ `outcome_unknown`, never retried automatically; on restart or handover
  see §5.7 step 1.
- The card reuses `OrganizationSuggestion`'s component, not its review route.

### 5.11 Activity

The console's agent page gains an Activity view: items, scheduled wakes, running sub-sessions,
recent patrols, pending cards — all derived from the ledger, the approval records, the outbox and
session records, read from the daemon through the BFF proxy. A background report into a webchat
conversation only raises an unread badge.

---

## 6. Relation to existing mechanisms

| Mechanism                           | Relation                                                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Conversation gating (§14)           | `gated` derivation gains "assistant mode"; enabling a place trusts it, with a warning                           |
| Session visibility                  | The permission rules follow it; DM long sessions are fixed `private`; sub-sessions refuse visibility changes    |
| `append`                            | Extended to Slack DMs; retention (assistant agents) and the visibility lock are prerequisites                   |
| Private-session memory exclusion    | Unchanged; the ledger is its own store                                                                          |
| Dreams / explicit memory writes     | Skip private sessions for assistant agents (P0); per-person space in P1                                         |
| `sendMessage` / `needsReply`        | Delegation goes through them; the direct self target is allowed; write targets are limited to the current place |
| `replyToSession`                    | The reference for the report channel; replaced by the persistent outbox                                         |
| Orchestration tool triple           | Not restored; the deadline wake is generalized and reused                                                       |
| Agent pause (#288)                  | Is "stop everything"; also suspends wakes and the outbox                                                        |
| Reminder injection (`shouldRemind`) | Carries the standing summary                                                                                    |
| Dream host                          | The shape of the patrol host                                                                                    |
| Cron / hooks                        | Patrol triggers; hook routing in P2                                                                             |
| `OrganizationSuggestion`            | Card component only                                                                                             |
| `Decision`                          | P2 triage                                                                                                       |

---

## 7. Phases

| Phase                             | Content                                                                                                                                                                                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prerequisites                     | §4.2                                                                                                                                                                                                                                                                                                                |
| **P0a — continuity and one mind** | Switch and admission; gating derivation and trust levels (enabled means internal, with a warning; Slack Connect detected external); Slack DM `append`; the ledger, the standing summary, `recall` and the three permission rules (read, write, memory); memory bypass closed; "ask me in a DM". **No sub-sessions** |
| **P0b — background work**         | Direct self-delegation, own coordinates, the persistent parent–child index; the persistent outbox (merge, ack, dead letter, chain depth, failure reports, hop reset, recovery order); sub-session permission requests and the wait cap; list / steer / stop (text list); pause suspends the outbox                  |
| P1 — while nobody is around       | Patrol (after per-runtime tests) on the credential-less host; `propose` and the approval record; `remind` / `patrol`; backoff; Activity; the webchat sub-session panel; `handoff`; the per-person memory space; identity links pushed to the daemon; quiet hours                                                    |
| P2 — cost and events              | Hook events routed to patrols; Decision triage; budgets; incremental summary injection                                                                                                                                                                                                                              |
| P3                                | Per-person quiet hours; the personal form; retention widened to every user once run state is decoupled from session rows                                                                                                                                                                                            |

---

## 8. Explicitly not done

- The personal form; one shared context; an output filter as a defense; member enumeration as a
  precondition for recall;
- a dedicated sub-session workspace, changing the agent's isolation, changing the user's
  permission policy;
- automatic retry of an uncertain external write; cancelling a waiting permission request to free
  a slot (P0);
- delegation / report / status tools parallel to `sendMessage`; restoring the orchestration tool
  triple; a new "stop everything";
- sub-sessions of sub-sessions; sub-sessions as platform threads;
- an "add this to the ledger" card; the "allow for this session" memory-write bypass;
  `tool_call.kind`-based retry;
- per-place restrictions on `!stop`, `!new`, pause or approval cards; filtering self-initiated
  Slack joins;
- runtimes outside the admission list, external memory plugins, self-hosted groups without a
  shared store.

---

## 9. Open questions

1. **Automatic context rollover**: a threshold on `contextUsed`; whether items and followers stay
   attached to the same place after a rollover.
2. **Run-state reclaim for permanent sessions** (the follow-up to §4.2 item 1); whether Codex
   resumes a session by id after a runtime restart is unverified.
3. **Slack DM `append` versus Slack assistant threads** (`assistant_thread_started` is already
   supported): whether a "new conversation" button still means anything.
4. **Webchat report rounds without a connected client** (unverified).
5. **Trust drift**: a place that changes after it was enabled; member-joined coverage per
   platform beyond Slack guests.
6. **Cost**: one long conversation per place and one main-session turn per report round; needs
   P0 measurements.
7. **Wording of item summaries**: the restatement when an item is taken is the only review point
   for what becomes team-visible.
8. Whether distillation on a normal OpenCode host runs under `plan` (live, unverified).

---

## 10. Review record

**Two design reviews of the second revision (2026-10-06)**: the permission table could not be
computed on the daemon → trust per place (later: enabling a place trusts it, only a
platform-detected external is the exception); reports injected into channels reach shared
memory → structured fields only across places; the `append` visibility lock unenforced and
seven-day reclaim → prerequisites; a fragile report chain → persistent outbox; DM self-wakes with
no owner → the inheritance path; sub-sessions as threads impossible on thread-less platforms →
implicit background sessions; a new approver policy → the existing two paths; `!stop` already
non-muting and non-cascading; self-wakes absorbed by `append` channels → own coordinates;
stopping cannot reach runtime background tasks → stated scope; full re-injection after
compaction; hop reset; silent re-entry after handovers.

**Review bot, third revision**: "ask me in a DM" lacked the handoff step → `handoff` through the
outbox (moved to P1); silent re-run would repeat approved writes → recovery order, approval
executions excluded from generic recovery.

**Cross-review of the third revision (2026-10-07)**, absorbed: reads were bounded but not writes
or memory → write targets limited to the current place, memory and knowledge closed in external
places; trust did not propagate → §5.3; Slack guests, `channel_shared` and "organization member"
undefined → §5.3; Codex `read-only` opens the network and OpenCode `read-only` exists only on
the dream host → credential-less patrol host; no loop bound after the hop reset and endless
re-delivery after `!stop` → chain depth, per-item budget, `!stop` ack, dead letter, row cap;
sub-sessions deadlocking the slot while awaiting approval → the wait cap; recovery marking must be
atomic; `pause` is not a handover; scratch has no per-session directory on the pool either → no
dedicated sub-session workspace; forced session isolation excessive → dropped; the retention
cost → assistant agents first; filtering self-joins infeasible → dropped; "stop everything" is
the existing pause; `handoff` to P1; the summary rides the reminder path; `tool_call.kind`
dropped; P0 split into P0a / P0b; patrols not before per-runtime tests. Corrections to §3: the
daemon has `contextUsed`; chat approval exists on Slack only; `gated` is derived from
`restricted`.

Cross-review suggestions **not adopted** (product decisions): limiting P0 to Slack and webchat
(all platforms stay, with warnings); no sub-sessions for scratch agents (they stay, sharing the
workspace); narrowing who may send `!stop` / `!new` or click external-place cards (the simplest
thing that works).

**Review bot, fourth revision**: cancelling a waiting turn expires the card bound to its ACP
request → the request stays open under a wait cap (§5.6). Removing credentials does not stop
native writes or unauthenticated requests → the patrol guarantee stated by layer, a throwaway
cwd, degraded runtimes marked (§5.9, §1.5). A throwaway cwd is not filesystem isolation → "does
not touch the workspace" limited to read-only or sandboxed hosts, workspace writes listed in the
degraded residual.

**Review bot, public PR**: an internal → external downgrade left context read under internal
permissions in the long session and in active sub-sessions → the downgrade transition retires
the session and its sub-sessions' full-text reports (§5.3).
