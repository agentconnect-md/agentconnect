# Assistant Mode

**Status:** Design, eleventh revision (2026-10-10). Reviewed by three independent design reviews and
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

**Console:** the switch is offered behind the `assistant-mode` flag (`features.assistantMode` in
the chart, off by default) until it changes behavior; an agent already switched on keeps it shown.

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
- **It speaks for the room.** It writes directly only to the place it is in. To post anywhere
  else — another channel, a conversation on another platform — it shows you the target and the
  exact text, and posts once you approve. Nobody can get at another person's DM; when something
  cannot be said here, it says "ask me in a DM".
- **Shared with another organization.** In a place the platform reports as external (a Slack
  Connect channel) it still knows everything, but every reply is a draft that an internal member
  approves in a DM before it is posted.

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

- The card lands in the item's place of origin; for an external place, in the approver's DM
  instead (§5.5). Who may approve follows the existing in-chat
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
  warns "everyone here will be able to get the content of its other places out of it;
  enable only if fully trusted".
- It acts with the agent's own identity and permissions, never someone's personal account.

---

## 2. Prior art

| Reference                                                               | Taken                                                                                                                                                                                                                                                                                                                                                             | Not taken                                                                          |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Hosted always-on personal and coworker agents (two launched in 2026-09) | Goals outlive conversations; the agent wakes itself; proactive research is read-only; it speaks only when needed; **rules first, free rein on its own computer, consequential actions brought back for approval, waiting without a deadline**; stopping the main task does not stop delegated work; each task in its own environment                              | The personal form (acting as a user with that user's accounts)                     |
| An open-source personal-agent template                                  | The approval record: hash-bound, expiring, `outcome_unknown` never retried; idempotent notifications; failure backoff and auto-pause                                                                                                                                                                                                                              | Rule-based idea generation; a task model that re-runs from scratch each time       |
| An open-source coworker-agent template                                  | Scheduled turns run in the original conversation; interruption waits for human review before retry                                                                                                                                                                                                                                                                | One task at a time globally                                                        |
| A durable agent-harness library                                         | The shape of background sub-agents: own conversation, anchored outside the parent's abort, replies delivered back as follow-ups, request ids on every delivery and report; sub-agents cannot spawn sub-agents                                                                                                                                                     | Using it as a runtime                                                              |
| A commercial AI coworker for team chat                                  | **Access scoped per person, enforced at recall**; DM content cannot be asked out of it; shared-channel replies drafted in a DM and posted after approval; approval cards lead with a sentence and offer "always allow"; whether an action needs approval is configured per action, never judged by the model; stopping the main task does not stop scheduled ones | One session per thread plus memory retrieval                                       |
| An open-source self-hosted multi-agent assistant                        | Read-only as a per-session tool filter; self-scheduled tasks in two tiers (push text without a model / run a turn); push cadence with active hours, random intervals and a dedup record; background replies only raise an unread badge                                                                                                                            | No distinction between senders in an IM; a per-thread persisted "allow all" bypass |

---

## 3. Where the code is today (verified)

| Needed                          | Today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One long conversation per place | Channel `append` exists. Telegram, Discord and Feishu DMs are already one continuous session; **only Slack DMs** open a session per top-level message. The restriction lives only in the web control; CP and daemon do not check the conversation kind                                                                                                                                                                                                                                                                                                                       |
| Keeping long sessions           | `append` sessions idle past the retention window (default 7 days) are reclaimed; on the pool, a session-isolated session's volume follows its row                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `append` visibility lock        | Enforced: `append` sessions refuse `session.visibility.change` (#2815); a channel session's owner is its first poster                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Conversation gating             | Exists (§14): a restricted agent is off everywhere, an editor enables places; `gated` is derived from `visibility === 'restricted'`; §14.8 auto-enables DMs of `sharedWith` members                                                                                                                                                                                                                                                                                                                                                                                          |
| Session visibility              | DMs and webchat are `private`; channels **and group DMs** default to `org` (the group-DM case is tracked separately)                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Presence data                   | The daemon has none: member listing is authoritative only on Slack and unpaginated; Telegram returns admins; Discord returns nothing                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| DMs and memory                  | Private sessions are excluded from per-turn capture; **dreams deliberately mine every session, DMs included** (prompt-only); explicit memory writes offer "allow for this session", a grant kept until restart. Channel sessions (external ones too) **are** captured and dreamed                                                                                                                                                                                                                                                                                            |
| Self-delegation                 | Only the channel-root form; the direct form refuses a self target (both admission checks exempt channel-root only). **In an `append` channel, agent-to-agent wakes resolve to the target's long-session coordinate** (`targetSessionCoordinate`), so self-delegation lands back in the main conversation today. A channel-root self-wake's child carries no platform origin, so it inherits its parent's visibility and owner like any agent-to-agent child (pinned by tests, #2862)                                                                                         |
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
- **Group DM**: treated as a small private channel — a private place for recall and memory
  (§5.5), internal unless the platform detects it as external. Its console-side default of `org`
  visibility is a session-visibility matter tracked separately.
- **Webchat**: one conversation is already one session.

Long sessions are kept per §4.2. Context relies on the runtime's own compaction; the standing
summary rides the existing reminder path (§5.4). The trigger for an automatic rollover (reopening
the context with the ledger and summary as a handover note) is an open question (§9).

### 5.3 Trust level

The daemon has no presence data and member enumeration is not made a prerequisite. There is no
per-place trust setting: **enabling a place on an assistant-mode agent trusts it as internal**
(everyone here is an organization member), on top of conversation gating. The enable flow shows
the warning "everyone here will be able to get the content of its other places out of it;
enable only if fully trusted". The only exception is an **external** level the platform detects.
An external place is not walled off: the agent reads there what it reads in an internal place,
and **every post is a draft an internal member approves first** (§5.5). External limits what
leaves, not what the agent knows, so an agent added to a shared channel can still answer.

- Slack: a Slack Connect channel is external. The share is read from the existing membership
  listing (`is_ext_shared` / `is_pending_ext_shared`) and from the flag every event envelope
  already carries (`is_ext_shared_channel`), so the first event after a share marks the place —
  no `channel_shared` subscription, no manifest change. A later listing that no longer reports
  the share lifts it.
- For assistant-mode agents only, a member joining is looked up once (`users.info`): a guest
  (`is_restricted` / `is_ultra_restricted`) or a member from another organization makes the place
  external, and that detection is never lifted by a later listing.
- Telegram groups, Discord channels, Feishu groups: no detection; enabled means trusted.
- DM: enabling it is trusting that person as a member. Webchat is internal by construction.
- A sub-session's place is its parent's: one born in an external place reports through that
  place's main session, so its result is drafted too.
- **The downgrade transition (internal → external) changes the output path, not the context.**
  On a downgrade — a detected share, a guest or outside member joining — the daemon
  interrupts the place's in-flight turn, whose reply would otherwise post unapproved; from the
  next turn on, replies are drafts. The long session and its sub-sessions keep their context:
  what they know was never the risk, what they post is. An upgrade (external → internal) needs no
  transition; drafts already pending stay approvable.
- Joining a public Slack channel on demand (`joiningOnRefusal`) does not create a place: an off
  row is not a place, and no filtering of self-initiated joins is attempted.

### 5.4 The shared mind

**① The item ledger** (daemon store, partitioned by agent, moving with duty):

```
{ id, title, doneWhen, nextCheck, status: active | waiting | done | dropped,
  followers: [{ identity: '<platform>:<scope>:<uid>' | 'user:<id>', place }],
  origin: place, summary, observations: [...], subsessions: [...], proposals: [...], version }
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
handles first turn, restart and compaction); every place receives the same summary. Incremental injection (`lastInjectedVersion`) is not in P0.

**③ The recall tool** `recall({ place, query })`: reads this agent's transcript excerpts from
another place, under §5.5.

### 5.5 Permission rules

> **Read**: any place may recall any non-private channel; a private channel or group DM only from
> itself (P0a; see below); a DM only from that person's own DM or webchat. Another person's DM,
> never.
> **Write**: platform write tools (`sendMessage`, `shareFile`, `scheduleMessage`, canvas, lists…)
> act directly only on **the current place**; a post to another place is a draft the asker
> approves (below). Item and report traffic across places goes through §5.7 as structured fields.
> The agent-to-agent forms of `sendMessage` are unchanged.
> **External**: an external place reads like an internal one; what it posts is a draft.

| Current place                | Recallable sources                                | Memory / knowledge | Output                                                |
| ---------------------------- | ------------------------------------------------- | ------------------ | ----------------------------------------------------- |
| P's DM                       | P's own DM and webchat, every non-private channel | all¹               | posted                                                |
| Internal channel or group DM | itself, every non-private channel                 | all¹               | posted                                                |
| External channel or group DM | itself, every non-private channel                 | all¹               | **drafted**: posted after an internal member approves |
| Webchat                      | as a DM, by the conversation's owner              | all¹               | posted                                                |

¹ Shared memory never holds content from DMs, webchat or private places (the memory bypass
below), so opening it everywhere does not reopen what the read rule closes.

**Drafts in an external place:**

- The turn's reply becomes a draft; other platform write tools are refused there. The place sees
  no streaming or tool progress; the triggering message gets a reaction where the platform
  supports one, never text.
- The draft goes as a card to an internal member's DM: the asker when the asker is an internal
  member (on Slack, a full member of the installing workspace — not a guest, not from the other
  organization), otherwise the responsible user or the fallback conversation. **Approve** posts
  the text unchanged in the original thread; **discard** drops it.
- A draft is an approval record (§5.10) whose action is "post this text to this place"; the
  daemon executes it itself, with no sub-session. It expires after 24 hours.
- Any other card that would land in an external place (a runtime permission request, a
  `propose`) goes to the same DM instead: a card is output too.

**Posts to another place:**

- Asked to post somewhere other than the current place — another channel, a DM, a conversation
  on another platform — the agent drafts the post instead of sending it. Only places where this
  agent is enabled can be targets.
- The draft goes to the same approver as an external place's draft, showing the target and the
  exact text; **approve** posts it unchanged, **discard** drops it. A target that is itself
  external needs no second approval.
- The card offers **"always allow from here to there"**, keyed by the pair of places: a route used
  often (a DM to the support channel) stops asking, and a grant never covers another source
  place. Grants live in the daemon store beside the approval records and end when assistant mode
  is switched off; listing and revoking them comes with Activity (P1).
- Whether a post needs approval follows from where it goes, never from the model's own judgment
  of how sensitive it is — a judgment a message in the conversation could talk it out of.
- A session with no place of its own (a hook, a cron run) drafts every platform post, approved by
  the responsible user or in the fallback conversation.

**Private places — scoped per place now, per asker later:**

- A **private place** is a channel or group DM the platform reports as private through the
  daemon's platform-neutral `isPrivate` facet (`PlatformChannelInfo` / `ObservedChat`). A platform
  that cannot tell reports not private — notably Discord, whose permission-restricted channels
  read as open.
- The target is **per-asker scoping**: an answer draws only on places the person asking can see,
  so a private place's content reaches only its members — the practice of the coworker agent in
  §2. It needs a membership cache per source and the identity links of P1 (webchat users), and
  platforms without a member list (Discord, Telegram) cannot support it; it ships in P1.
- **Until then (P0a) a private place is read only from itself**: no other place, not even a
  member's DM, can recall it; the place itself still recalls every non-private channel.
  Per-asker scoping only widens this, so nothing that works in P0a stops working later.
- Other places do not see a private place in recall's listing, and a refused read answers as
  opaquely as the DM rule: "I can't share that here", never where the content lives.

- Webchat ↔ IM recognition depends on identity links (P1); in P0 webchat recalls only itself and
  channels.
- **"Ask me in a DM"**: asked in place B for something only the asker may see, B's session
  neither reads nor answers; it says "ask me in a DM". P1 adds `handoff`: a row through §5.7 to the asker's DM carrying the original
  question, answered there by the DM session under its own permissions (the human-reaching
  `sendMessage` only sends already-generated text and starts no turn in the DM, so it is not used).
- No output filter; one zero-cost assertion: a source read during a turn that is outside the
  current place's allowed set raises an error metric.
- **Memory bypass**: in P0, per-turn capture, dreams and explicit memory writes skip `private`
  sessions (filtered by the CP-confirmed bit) and the sessions of private places (by `isPrivate`)
  for assistant-mode agents; "allow for this session" is removed on their `append` sessions. P1 adds the per-person memory space. This is a retreat from today's dream
  behavior and [memory-dreaming.md](memory-dreaming.md) says so. Runtime native memory must be
  disableable (admission) and is disabled on enable.

### 5.6 Sub-sessions

**P0b ships the minimal form**: self-delegation as below, a failure report the daemon sends when a
sub-session ends without reporting (§5.7), and a concurrency cap that refuses beyond
`maxConcurrentSubsessions` (default 3). Reports use the existing parent-report path
(`replyToSession`). The persistent outbox, the recovery order, permission-request routing and its
wait cap, listing / steering / stopping, the daily budget and queueing over the cap are deferred
until use shows they are needed; the rest of this section and §5.7 describe that target.

- **Opening**: self-delegation without a post — the direct form of `sendMessage({ toAgent })`
  accepts a self target (both admission checks exempt it; `targetSessionCoordinate` is skipped),
  and the sub-session gets **its own coordinate**: a reserved `subsession:` thread segment minted
  per delegation, on which every turn runs headless and which the Control Plane also recognises.
  It inherits the parent's visibility and owner through the A2A path; **visibility changes on
  sub-sessions are refused** (a channel parent's owner is its first poster).
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
  2. When one fires it is delivered to the place of origin (an external place's to the approver's
     DM, §5.5) as a card through the existing two approval paths and listed in Activity (deferred with this routing); the card offers "always allow this tool".
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
- **Webchat**: the session-detail dock's Sub-sessions panel (#2885) lists the sub-sessions a
  conversation opened (patrols included) and stops a running one; who may stop is whoever may
  continue that session today. A sub-session's own page is read-only (#2893): talking to one
  directly is deferred.
- **What stopping guarantees**: the current turn; a background process the runtime started may
  keep running; the adapter is never killed.
- **Limits**: no sub-sessions of sub-sessions; at most `maxConcurrentSubsessions` running (P0b
  refuses beyond it; the target queues the rest persistently with the asker told);
  `dailySubsessionsPerItem` per item per day (§5.7's loop bound, deferred).

### 5.7 The report channel

> **Background sessions never speak on the platform.** Sub-session reports, patrol results,
> permission requests and notifications are each one report injected into the target place's main
> session, which speaks for them.

In P0b a sub-session reports through the existing parent-report path, and when it ends without a
report — an error, `!stop`, pause, the stall watchdog — the daemon sends one short failure report
instead, never two; an interruption that will be replayed sends none. The outbox below is the
deferred target.

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

| Action                                        | Effect                                                                                                          | Who                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| "Stop" in the main conversation               | Interrupts that conversation's current turn only                                                                | today's `!stop` rules                                   |
| Stop one piece of work (named, or in webchat) | Interrupts that sub-session's current turn                                                                      | same / whoever may continue that session in the console |
| **Pause the agent** (existing #288)           | Interrupts every session and blocks new turns (today); assistant mode also suspends patrol wakes and the outbox | existing pause permission                               |

No new "stop everything". The sender rules for `!stop`, `!new` and pause are **unchanged and not
narrowed** — effects at this level cannot be defended against, and the design does not pretend
to. Resume: no catch-up; items whose `nextCheck` passed are each checked once on the next patrol;
killed sub-sessions do not restart. Stopping never undoes completed effects.

### 5.9 Patrol (P1)

**P1 ships a minimal patrol first**, ahead of the target below:

- **Wake**: only an item's `nextCheck` wakes a patrol — a duty-gated sweep on the daemon, once per
  `nextCheck` value; pause suspends it and an overdue item is checked once. `patrolSchedule`, hook
  events and triage come later.
- **Where it runs**: a read-only sub-session on the **agent's own host** — no credential-less host
  yet. Read-only rests on layers (a) and (c) below: AgentConnect tools filtered to reads plus the
  item tools it needs to record what it saw, and the runtime's read-only mode with a daemon policy
  that refuses anything needing approval. Layer (b) is missing, so every runtime's patrol is
  marked _degraded_ on the settings page and the residual is that of a degraded runtime plus the
  agent's own credentials on the host.
- **Outcomes**: a report, a `propose` (§5.10), or silence; the item gets an observation either
  way, and a run that records nothing counts as a failure. The report goes to the item's **origin
  place** through the existing parent-report path into that place's long session, which speaks;
  other followers are not told in this version.
- **Limits**: one patrol at a time per agent, outside the user's `maxConcurrentSubsessions`;
  `dailyPatrolBudget`; after a failure the next attempt backs off by `min(60, 2ⁿ)` minutes and five
  consecutive failures stop that item's patrols with one report until someone sets a new next
  check. A patrol's own next check must be at least five minutes ahead; `dailyPatrolBudget`
  defaults to 50.
- **Recovery**: a patrol replayed after a restart or handover settles from state stored with the
  running patrol (its observation baseline and any held report), so an empty replay still counts
  as a failure. Stopping a patrol from the dock ends it silently with its check done.

Shipped in #2887; `propose` from patrols in #2895. The rest of this section is the target.

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

- The card is delivered through §5.7 to the item's place of origin, or for an external place to
  the approver's DM (§5.5).
- **Drafts are the record's first use** (P0a): action "post" — into an external place or into
  another place (§5.5) — executed by the daemon. General
  `propose` actions come with P1.
- **Approvers follow the existing two paths** (`allowRuntimeChangesInChat` on ⇒ any participant
  of the conversation may click; off ⇒ the editor path); for an external place, the internal
  member of §5.5. Only the policy is reused: both existing
  paths bind to a pending ACP request, so a `propose` record that outlives a turn is a new
  mechanism; the chat card and the editor DM exist on Slack only, other platforms use the console.
- Approval ⇒ CAS to `executing`, record the sub-session id and write the marked inbox row in one
  transaction ⇒ open a normal-permission sub-session.
- An uncertain outcome ⇒ `outcome_unknown`, never retried automatically; on restart or handover
  see §5.7 step 1.
- The card reuses `OrganizationSuggestion`'s component, not its review route.

**P1 ships `propose` for patrols only** (#2895): `propose({ sentence, why, task })`, at most once
per patrol run; an approved proposal opens a sub-session with the agent's own permission mode in
the item's origin place, counted against `maxConcurrentSubsessions` (a full cap refuses the
approval and the proposal stays awaiting review). It departs from the record above in four
places:

1. **Expiry is 24 hours**, as for drafts — a patrol often runs overnight, so 30 minutes would
   expire nearly every proposal.
2. **The inbox row is not written in the approval transaction**: the transaction holds the state
   change, the sub-session key and the index row; the task's reserved `subsession:task-`
   coordinate keeps its row out of generic replay, and a recovery sweep catches a crash before the
   row exists.
3. **The item version is in the hash but does not cancel an approval**: a later update to the
   item would otherwise void every proposal; a closed or deleted item is still refused, and the
   task's prompt shows both versions and says to check the current state first.
4. **Approvers** are the responsible user or the fallback conversation through the draft card,
   plus the agent's editors in the console's Activity view, not the in-place card under the in-chat
   approval rule.

A cut execution settles from the sub-session's durable end: reported ⇒ `succeeded`, failure report
already sent ⇒ `failed`, otherwise `outcome_unknown` with one "please check" report.

### 5.11 Activity

The console's agent page gains an Activity view: items, scheduled wakes, running sub-sessions,
recent patrols, pending cards — all derived from the ledger, the approval records, the outbox and
session records, read from the daemon through the BFF proxy. A background report into a webchat
conversation only raises an unread badge.

The first version (#2876) shows what exists today, for assistant-mode agents only, read and
changed through the daemon without anything persisted on the Control Plane:

| Section                                         | Who sees it                                                                                                                                                          | Who may change it                                                                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Items (open, then done and dropped)             | anyone who can view the agent; the places an item is followed from, never who follows it or what was said; the next check, which wakes a patrol (§5.9)               | editors delete an item                                                                                                                                  |
| Sub-sessions                                    | anyone who can view the agent sees state and start time; the title, the session link and the conversation that opened it only where the viewer may open that session | —                                                                                                                                                       |
| Pending drafts                                  | editors                                                                                                                                                              | editors approve, approve and always allow, or discard (#2880) — the same decision path as the card, so a card click and a console decision execute once |
| Post grants ("always allow from here to there") | editors                                                                                                                                                              | editors revoke a grant                                                                                                                                  |

Deleting an item drops it from the standing summary at the next reminder; its followers are not
told. A console decision that cannot be confirmed keeps its row and tells the editor to check the
destination (#2881). Runtime permission requests awaiting approval, patrol history and the unread
badge are not in it yet.

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

| Phase                             | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Prerequisites                     | §4.2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **P0a — continuity and one mind** | Switch and admission; gating derivation and trust levels (enabled means internal, with a warning; Slack Connect detected external); Slack DM `append`; the ledger, the standing summary, `recall` and the permission rules (read, write); drafts in external places and posts to other places (the approval record, "post" only); memory bypass closed; "ask me in a DM". **No sub-sessions**                                                                                        |
| **P0b — background work**         | Minimal: direct self-delegation (own `subsession:` coordinate, inherited visibility, no nesting, the persistent parent–child index); a daemon failure report when a sub-session ends without reporting; a concurrency cap that refuses. Deferred until needed: the persistent outbox, recovery order, permission-request routing and the wait cap, list / steer / stop, the daily budget, queueing over the cap                                                                      |
| P1 — while nobody is around       | Shipped: minimal patrol (§5.9, #2887), `propose` from patrols (§5.10, #2895), Activity with console decisions (#2876, #2880), the webchat sub-session panel and read-only sub-session pages (#2885, #2893). Next: the target patrol (after per-runtime tests) on the credential-less host; `remind` / `patrol`; backoff; Activity; the webchat sub-session panel; `handoff`; the per-person memory space; identity links pushed to the daemon; per-asker recall scoping; quiet hours |
| P2 — cost and events              | Hook events routed to patrols; Decision triage; budgets; incremental summary injection                                                                                                                                                                                                                                                                                                                                                                                               |
| P3                                | Per-person quiet hours; the personal form; retention widened to every user once run state is decoupled from session rows                                                                                                                                                                                                                                                                                                                                                             |

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
- per-place restrictions on `!stop`, `!new` or pause; filtering self-initiated Slack joins;
- closing reads or memory in external places — their output is drafted instead; editing a draft
  before approval (discard and ask again);
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
the session and its sub-sessions' full-text reports (§5.3). Superseded by the fifth revision.

**Fifth revision (2026-10-07)**: a per-place trust declaration was a new setting nobody asked for
→ enabling a place trusts it; only a platform-detected external is the exception. An external
place that reads only itself cannot answer what it was added to answer → it reads like an
internal place and every post is a draft an internal member approves in a DM (the shared-channel
practice in §2). Consequences: the downgrade transition no longer retires context; the
shared-workspace restriction on external places, item trust levels and the external-filtered
summary are dropped; cards from external places go to the approver's DM, which settles the
external-place card question left open above.

**Sixth revision (2026-10-08)**: private channels were recallable from every place → per-asker
scoping is the target (P1); P0a reads a private place only from itself. Architecture review of
that change: group DMs are private on the platform too → they are private places; private
channels are `org` sessions that reach shared memory → the P0a memory bypass also skips private
places; the flag is the platform-neutral `isPrivate` facet, not a platform field; a refusal stays
as opaque as the DM rule.

**Seventh revision (2026-10-08)**: writing only to the current place refused a common request —
"reply to the support thread on the other platform" → a post to another place is a draft the
asker approves, with "always allow" per pair of places; whether a post needs approval follows
from its target, never from the model's judgment.

**Eighth revision (2026-10-09)**: P0b narrowed to its minimal form — self-delegation, a failure
report and a refusing concurrency cap over the existing report path — after weighing it against
the runtimes' own in-turn sub-agents, which keep short parallel work but cannot outlive a turn,
survive a restart or be seen and stopped. Corrections from the implementation: the `append`
visibility lock is enforced; a channel-root self-wake's child inherits its parent; a share is read
from the event envelope rather than a `channel_shared` subscription.

**Ninth revision (2026-10-09)**: the first Activity view (#2876) — who sees and may change each
section; deleting an item does not tell its followers; permission requests are not listed there
while their routing is deferred.

**Tenth revision (2026-10-09)**: P1 starts with a minimal patrol — `nextCheck` wakes a read-only
sub-session on the agent's own host, marked degraded for lacking the credential-less host, which
reports to the item's origin place or stays silent, with no `propose` yet; console approval of
drafts (#2880, #2881) is recorded in §5.11.

**Eleventh revision (2026-10-10)**: records what P1 shipped — the minimal patrol's limits and
replay recovery, `propose` for patrols with its four departures from the approval record, the
webchat Sub-sessions panel, read-only sub-session pages, and who may stop a sub-session from the
console.
