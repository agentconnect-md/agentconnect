# Assistant Mode

**Status:** Design, fourteenth revision (2026-10-10). Reviewed by three independent design reviews
and the repository's review bot; §10 records what each round corrected. Nothing is implemented yet.
Prerequisites: #2812, #2813. Work breakdown: #2810.

**In one sentence:** switch an agent into assistant mode and it behaves like one person on the
team — it keeps a continuous conversation with you in every place, what it hears in one place it
knows in the others, it only says what the people present may hear, it keeps a ledger of what
everyone asked of it, checks on progress by itself, speaks up only when there is something to say,
and asks before it acts.

**Name:** unrelated to [agent-assistant.md](agent-assistant.md), which is the AgentConnect MCP
tool set for AI tools. That design gives an agent tools to administer the platform; this one
describes how an agent behaves.

**Console:** the switch sits in the assistant mode panel on the agent's Configuration tab, offered
behind the `assistant-mode` flag (`features.assistantMode` in the chart, off by default) until it
changes behavior. The flag gates only switching the mode on: an
agent already switched on keeps the switch, Activity, the Sub-sessions tab and proposals.

**Builds on:** [resource-visibility.md](resource-visibility.md) §14 (per-conversation triggers
and their defaults), [session-visibility.md](session-visibility.md) (session visibility, the
private-session memory exclusion), [channel-session-mode.md](channel-session-mode.md) (`append`
long sessions), [agent-collaboration-implementation.md](agent-collaboration-implementation.md)
(`sendMessage` with `toAgent` / `needsReply`), [memory-dreaming.md](memory-dreaming.md) (the
per-agent built-in switch and the dream host), [slack-approval-dm.md](slack-approval-dm.md) (the
two in-chat approval paths), [webchat-side-panels.md](webchat-side-panels.md) (the console dock).

**Principle:** the simplest thing that works. Assistant mode sets a default permission mode once,
as it is switched on (§1.8), and otherwise leaves the agent's permission policy, workspace
isolation and command permissions alone, reuses an existing mechanism wherever one exists, and
does not pretend to defend against effects it cannot defend against.

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
  exact text, and posts once you approve. It reads another conversation only for someone who may see
  it, and leaves it to that person whether to share what it finds; nobody can get at another
  person's DM, and when something cannot be shared it says "I can't share that here".
- **Shared with another organization.** In a place the platform reports as external (a Slack
  Connect channel) it answers as it does anywhere else, and what it shares there is the asking
  person's call. Approvals there go to an internal member, the place keeps its own memory, and its
  list of open items is not brought there.

### 1.2 Asking it to do things

- Ask as you would a colleague. It restates its understanding — what to do, what counts as done,
  when to check next — and on your confirmation the item enters its ledger.
- The ledger is visible to the team. An item born in a DM or a private channel records who asked
  for what, never that conversation's wording or details; it says so when it takes the item.
- **It reports to whoever asked, in the place they asked.**
- When two people ask for the same thing in different places, it asks "attach this to X's item?"
  when restating, and both receive the report after you confirm.
- When the asker can no longer be reached (DM closed, left the channel), reports go to the agent's
  responsible user (§5.1), and otherwise wait in its Activity view.

### 1.3 Long work: sub-sessions

- A sub-session is an **implicit background session opened on demand** — "fix this bug and open a
  PR". Ordinary conversation stays in the main conversation.
- In an IM: the main conversation says "started", then reports the result with a console link.
  Nothing extra appears on the platform.
- Stopping goes through the main conversation: "stop the PR one". Steering ("change the PR task
  to X") is deferred (§7).
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
- To stop one piece of work, name it in the main conversation that opened it, or stop it in
  webchat. The agent first confirms in one sentence which one you mean. Stopping interrupts its
  current turn; a background process the runtime started itself (a build, a dev server) may keep
  running, and the answer says so.
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

- A proposal's card lands in the item's place of origin; for an external place, in the approver's
  DM instead (§5.5). Whoever could ask the agent there may approve it: in a DM, that person; in a
  channel, anyone whose own message would start a turn of the agent there; in webchat, whoever may
  continue the conversation, from its pending requests. Approving runs the task with the agent's
  own permissions, which is what asking there gets, so it grants nothing more.
- A runtime permission request inside the task follows the existing in-chat approval rules: where
  "What people can do in chat" includes approving tool calls, anyone who sees the card can click;
  otherwise the console and the editor DM path. That card offers "always allow this tool".
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
  agent that does not gets a locked switch with the reason.
- Background work nobody watches should not stop for approval, so switching it on sets the
  agent's permission mode to the runtime's auto mode (Claude Code's `auto`, Codex's `agent`,
  which it calls "Auto review"), or to its full-access mode where it has no auto mode. Only an
  unset mode or one that asks for approval or only reads is changed: an auto or full-access
  mode, Claude Code's `dontAsk` (it refuses what is not pre-approved rather than asking), a mode
  set in the same edit, and every mode of a runtime with neither (OpenCode) are kept. The
  Control Plane applies it on every edit that switches the mode on, from the console or the
  API. It is a default, never an admission check: an editor may change the mode afterwards and
  the choice sticks while the mode stays on. While it is on, an agent whose mode asks every time
  gets a warning: background work will wait for approval often.
- Switching it on changes no conversation's trigger, and new conversations start as any agent's
  of the same visibility do (§5.3). A place is _internal_ unless the platform detects it as
  _external_ (§5.3).
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
| DMs and memory                  | Every agent keeps memory by audience (B6): a DM's turns go to its person's layer, dreams mine only the shared layer's conversations, and an explicit write needs no card                                                                                                                                                                                                                                                                                                                                                                                                     |
| Self-delegation                 | Only the channel-root form; the direct form refuses a self target (both admission checks exempt channel-root only). **In an `append` channel, agent-to-agent wakes resolve to the target's long-session coordinate** (`targetSessionCoordinate`), so self-delegation lands back in the main conversation today. A channel-root self-wake's child carries no platform origin, so it inherits its parent's visibility and owner like any agent-to-agent child (pinned by tests, #2862)                                                                                         |
| Reports                         | `replyToSession`: injected into the parent session, never posted, through the parent's serial gate. Gaps: link state in memory (`childSessionLinks`, cleared at 2000); random delivery id; a full parent queue (10) drops the report; `!stop` deletes the queued messages and their inbox rows; a failing turn rejects everything queued; no report on failure; reports count as agent calls, and the hop cap is today's only loop bound                                                                                                                                     |
| Stopping                        | `!stop` interrupts the session's current turn, does not cascade, does not mute under `append`; senders are any non-bot member of an enabled place. Agent pause (#288) interrupts every session and **drops queued messages**; nothing is replayed on resume. ACP cancels whole turns only; runtime-started background tasks cannot be stopped                                                                                                                                                                                                                                |
| Concurrency                     | Sessions sharing a workspace are **not serialized** (`admitActiveDispatch` waits on workspace mutations only); turns from several channels already run in parallel in one directory                                                                                                                                                                                                                                                                                                                                                                                          |
| Deadline wake                   | The orchestration tool triple is retired from the tool surface; the deadline wake remains, bound to the `orchestration` table, re-armed on startup and duty changes with CAS claim                                                                                                                                                                                                                                                                                                                                                                                           |
| Read-only modes                 | Matched by **name** (`read-only`, else `plan`). Claude Code has `plan`; **OpenCode's `read-only` is a daemon-authored agent injected only on the credential-less dream host**, a normal host has native `plan` with bash allowed; **Codex's `read-only` profile opens the network when the managed credential channel is enabled**, so a "read-only" session can run write calls through that channel with no permission request — both are credential problems, not filesystem ones. Dreams use a credential-less host; **per-turn distillation uses the agent's own host** |
| Runtime versions                | Managed Codex follows a floating release channel (`version: ''`); only probed versions are known                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Workspace isolation             | `isolation: session` applies to git mode only; **scratch is always `shared`, on the pool too**                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| In-chat approval                | The in-conversation card checks who clicks only where permissions are synced (an editor's linked account, slack-approval-dm.md §6.5), hence behind `chatActions` at `approve` or above; otherwise the editor path. The card **exists on Slack, Telegram, Discord, Feishu/Lark and Google Chat** and the editor DM **on Slack only**, and both bind to a pending ACP request                                                                                                                                                                                                  |
| Context size                    | The daemon has `contextUsed` (usage snapshots) and infers compaction from it; the reminder path `shouldRemind` already handles first turn, restart and compaction                                                                                                                                                                                                                                                                                                                                                                                                            |
| Slack joins                     | A join waits for a person behind the turn (`askToJoin`, #2979); the join fires `member_joined_channel` and re-reports from the authoritative snapshot                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Pending cards                   | `OrganizationSuggestion`'s card component is reusable; its review route is owner-only and is not                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Self-hosted groups              | Without a shared store, records stay on the member that wrote them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

---

## 4. Scope and admission

### 4.1 Admission (checked on enable; a failing check locks the switch)

| Dimension         | Requirement                                                                                                                                                                                                                                                   | Why                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime           | On the **admission list**: native cross-session memory can be disabled; a session resumes by id after a runtime restart. **No genuine read-only mode required**: the patrol guarantee is stated by layer in §5.9, and a runtime without one shows as degraded | Memory bypass, long sessions and resuming a sub-session after approval depend on it. Registering strict read-only semantics would lock most runtimes out |
| Memory            | `managed` or `none`; per-turn distillation (`autoDistill`) recommended off; if on, the trade-off in [memory-dreaming.md](memory-dreaming.md) §8 applies                                                                                                       | The person layer exists for managed memory only; distillation runs on the credentialed warm host                                                         |
| Self-hosted group | Every member shares the store (the CP verifies store ids); single daemons unaffected                                                                                                                                                                          | Otherwise the ledger, approvals and pending reports stay on the old member after a handover                                                              |
| Executors         | Assistant-mode sessions never spread to remote executors                                                                                                                                                                                                      | Not possible today either                                                                                                                                |
| One per place     | One assistant-mode agent per place (`transportScope` + channel)                                                                                                                                                                                               | With two, who speaks and where reports go has no good answer                                                                                             |

Not admission criteria: platform (all allowed; a place is internal unless detected external, §5.3), channel trigger mode
(user configuration), workspace mode and isolation (§5.6), sandboxing, permission policy (switching
on sets a default, §1.8; an asking mode only warns), a linked identity for the responsible user
(without one, what would be carded to them waits in Activity, §5.1).

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

On enable: §4.1 is checked; conversation gating is untouched (`gated` is derived from restricted
visibility alone, §5.3), so every row keeps its trigger and counts as internal unless the platform
detects it as external (§5.3). In the same row-locked write, an unset, asking or
read-only permission mode becomes the runtime's auto mode, else its full-access mode, unless the
edit sets a mode itself (§1.8); which mode is which comes from a per-runtime map kept beside the
admission list. Workspace isolation is untouched.

**The responsible user is derived, never stored.** It is the member asked when no person is behind
a draft, a proposal or a sub-session's permission request (the asker, a schedule's creator or editor,
an item's asker and a sub-session's opener always come first): the agent's creator while they are a
member who may edit the agent, otherwise the editor who joined the organization first (membership
time, then user id), otherwise nobody. The Control Plane derives it when it is asked (the approval
route's `responsible` form, behind `assistant-responsible-route-v1`, so a daemon on an older Control
Plane asks nobody), so a creator who leaves or loses edit rights hands over at once, and the
assistant mode panel names that person read-only. Whatever cannot reach them by a direct message
waits in the agent's Activity view, where an Agent editor decides it. There is no fallback
conversation.

The stored keys go in two steps, since a rollout runs both Control Plane versions on one database
([high-availability.md](high-availability.md)). Now: a row an older Control Plane wrote may keep
`responsibleUserId` and `fallbackConversation`; this one reads past them, never writes them, serves
the policy without them, and projects them to daemons unchanged, so a daemon that still requires
one keeps validating an agent nobody edited. A daemon likewise reads past them in an agent.json an
older daemon wrote, so that agent still loads after the upgrade. Follow-up: drop the two stored keys
in the next release, once no Control Plane that reads them is serving.

### 5.2 Places and long conversations

A _place_ is an IM conversation (DM, group DM, channel) the agent answers in, or a webchat
conversation. Each place has exactly one long session:

- **Channel**: forced `append`. Rows already in `append` are taken as they are; Linear rows are
  skipped; Decision-gated rows are not forced to change mode.
- **DM**: Slack DMs gain `append` (other platforms are already continuous). Fixed `private`.
- **Group DM**: treated as a small private channel — a private place for recall and memory
  (§5.5), internal unless the platform detects it as external. Its console-side default of `org`
  visibility is a session-visibility matter tracked separately.
- **Webchat**: one conversation is already one session.
- **A new place**: one session from its first message. The Control Plane lists every known row of
  an assistant-mode agent, its own-mode rows included, and the daemon gives a conversation it does
  not list yet `append` where the platform appends the message's kind, so a message that arrives
  before the row's projection does not open a thread session of its own
  ([channel-session-mode.md](channel-session-mode.md)).

Long sessions are kept per §4.2. Context relies on the runtime's own compaction; the standing
summary rides the existing reminder path (§5.4). The trigger for an automatic rollover (reopening
the context with the ledger and summary as a handover note) is an open question (§9).

### 5.3 Trust level

The daemon has no presence data and member enumeration is not made a prerequisite. There is no
per-place trust setting: **a place is internal** (the organization's own)
**unless the platform detects it as external**. Enabling a place is not the trust boundary: what
crosses between places is judged by who is asking (§5.5 "Reads") and memory by its audience
([product conventions](../product-conventions.md#memory-layers)), so an assistant-mode agent takes
the same conversation defaults as any agent of its visibility and is gated only when restricted.
An external place is not walled off: the agent reads there for whoever is asking and **replies
there directly**, as every agent does (§5.5, "Replies in an external place"). External changes
who approves, which memory layer the place uses and how a post from elsewhere reaches it; it does
not change what the agent says in the place itself. Internal describes the place, not each person
in it: a guest who was in a channel before the bot arrived is never detected, so whether someone
approves as an internal member is asked of the platform per person wherever it can tell (§5.5
"Drafts").

**Conversation defaults (issue #2979, item B7).** The mode used to gate the agent like a
restricted one: its new rooms and DMs started Off, it was never a shared bot's default member, a
conversation it had not been enabled in was told so, and enabling a room or group DM first warned
that everyone there could get the content of its other places out of it. That rested on enabling a
place being the boundary recall, the ledger and memory crossed. Reads are now judged by who is
asking and memory by audience, so the gate kept out nothing they do not, while every new place
needed an editor. An assistant-mode agent now takes the defaults of its visibility: an Everyone
agent's new room answers @-mentions, a member's new 1:1 DM starts On, a conversation shared with
another organization starts Off ([resource-visibility.md](resource-visibility.md) §14.9), and it
can be a shared bot's default member; a restricted one stays gated. Rows already Off stay Off:
nothing is migrated or re-seeded. An Off nobody chose keeps the one-time notice for every agent
([resource-visibility.md](resource-visibility.md) §14.9), so a room seeded Off under the old gating
still tells a person who mentions the agent there; an Off an editor chose is silent. Without the
gate, a new place can be answered before its row reaches the daemon, so the daemon keys an
unlisted place on one session from its first message (§5.2).

- Slack: a Slack Connect channel is external. The share is read from the existing membership
  listing (`is_ext_shared` / `is_pending_ext_shared`) and from the flag every event envelope
  already carries (`is_ext_shared_channel`), so the first event after a share marks the place —
  no `channel_shared` subscription, no manifest change. A later listing that no longer reports
  the share lifts it.
- A member joining is looked up once (`users.info`): a guest (`is_restricted` /
  `is_ultra_restricted`) or a member from another organization makes the place external, and that
  detection is never lifted by a later listing. Another workspace of the same Enterprise Grid
  organization is the same organization; a console account plays no part. The connection keeps
  each person's answer for a minute and runs at most four lookups at once, so a burst of joins
  costs one lookup per person and queues rather than fans out. A draft's membership check (§5.5)
  reads the same answer.
- **Output no event triggered asks first.** A place learns of a share from its next event, so
  before a post no event from that place triggered — a scheduled or hook run and its anchor
  message, a report round, a post from another place, a
  sub-session's permission card, a patrol's proposal card — the daemon asks the platform whether
  the place is shared now: on Slack the share flags of
  `conversations.info`, read through the channel lookup a platform module declares
  (`sharedConversations`). The answer is cached per place for a minute, the bound the membership
  read in §5.5 uses: repeated posts cost one lookup, and a share made after an answer goes unseen
  for at most that minute. A 1:1 DM is never asked. A share found this way is a detection like an
  event's flag. A lookup that fails marks nothing and confirms nothing: a post from another place
  is then drafted or refused like one into an external place, while the place's own run, report
  round or reminder posts there as it would anywhere. No event subscription is added.
- **Detection is the same for every agent.** The member-join lookup, the event-envelope flag and
  the check before output no event triggered run whether or not the agent is in assistant mode,
  and every detection is reported to the Control Plane, so `externalChannels` reflects it for any
  agent. What already applies to every agent then follows: an approval in the place goes to an
  internal member, the place's memory goes to its own place layer (never the shared one), and a
  post into it from another place is drafted or refused (§5.5). Assistant mode adds one thing of
  its own: the standing summary of items is not injected there (§5.4 ②). Its replies, its other
  writes there and its turns are what any agent's are.
- Telegram groups, Discord channels, Feishu groups: no detection; such a place is internal.
- DM: never external; what it is told is judged by its one person (§5.5). Webchat is internal by
  construction.
- A sub-session's place is its parent's: one born in an external place reports through that
  place's main session, which answers there like any other turn.
- **A place turning external (internal → external) has no transition.** A detected share, or a
  guest or outside member joining, interrupts nothing: the turn in flight posts its reply, and
  what is queued or arrives next runs as before. From then on the place's approvals, memory layer
  and posts from elsewhere follow the external rules, and the standing summary stops being
  injected there. Until #2979 item B4, assistant mode cut the place's in-flight turn here, since
  its reply would have posted unapproved; with replies posted directly there is nothing to cut.
  Drafts still pending from before stay approvable.
- A confirmed join of a public Slack channel ("Joining a public channel" in product-conventions.md)
  does not create a place: an off row is not a place, and no filtering of such joins is attempted.

### 5.4 The shared mind

**① The item ledger** (daemon store, partitioned by agent, moving with duty):

```
{ id, title, doneWhen, nextCheck, status: active | waiting | done | dropped,
  followers: [{ identity: '<platform>:<scope>:<uid>' | 'user:<id>', place }],
  origin: place, summary, observations: [...], subsessions: [...], proposals: [...], version }
```

- Item summaries are visible to organization members; the wording, and any detail from a DM or a
  private place, stays in the source session. This is an instruction to the model, not a filter.
  Observations written by patrols are bound by standing instructions: team-visible, no quotes,
  source content framed as untrusted data.
- The ledger does not pass through the shared-memory exclusion gate — it is its own store, not
  agent memory.
- Concurrency: field-level merge (append observations), CAS only on state transitions.
- Followers are keyed by platform identity plus place, with no cross-platform merge (P1).
  "Someone left" is handled by **delivery failure**: an undeliverable report goes to the
  responsible user (§5.1), otherwise it waits in Activity.
- Duplicates are never merged automatically; the model asks when restating and calls
  `attachFollower` on confirmation. Conflicts between followers are not detected in P0; the model
  says so in the current place and writes it into the summary.

**② The standing summary**: `id`, title, status and followers' places of active and waiting
items; capped at 30; injected through the existing reminder path (`shouldRemind`, which already
handles first turn, restart and compaction); every internal place receives the same summary. Incremental injection (`lastInjectedVersion`) is not in P0.
An external place (§5.3) receives none, sub-sessions born there included: the ledger is internal,
and nobody there asked for it. The item tools still answer there when someone asks (#2979, B4).
A main conversation's summary also lists the sub-sessions that conversation opened which are
running now, each by its id and label, at most 10 and then a count. The block is omitted when
none runs. It rides the same points and is re-injected on the next turn after one starts or
ends, so the list the model holds stays current (§5.8); after the last one ends, that turn says
none is running. It is kept in an external place: it names only work that conversation itself
started.

**③ The recall tool** `recall({ place, query })`: reads this agent's transcript excerpts from
another place, under §5.5.

**④ The people's local time** is no longer assistant mode's own: every agent's turns carry it,
by the order in [product conventions](../product-conventions.md#local-time). In assistant mode it
still rides every turn — main conversations, sub-sessions, patrols, tasks and report rounds — as
one line in the turn prelude, current at that turn: `Now: 2026-10-12 Mon 04:20 (Asia/Shanghai,
UTC+08:00).` The runtime host's clock is never presented as the people's time. The line is
context, not an instruction; no tool's parameters change, and instants the agent writes
(`nextCheck`, `remind`) still carry their own offset.

### 5.5 Permission rules

> **Read**: judged by who is asking, for every agent (§5.5 "Reads"): a source is readable when the
> person behind the request may see it, and whether to bring it into this conversation is that
> person's call. A turn no person is behind reads only public channels on its own bot.
> **Write**: judged by who is asking, for every agent (§5.5 "Writes"): a platform write tool
> (`sendMessage`, `scheduleMessage`, reactions, bookmarks, canvases, lists, `createConversation`…)
> acts on the current place and wherever every person asking could post themselves; a post into an
> external place from elsewhere is a draft an internal member approves (below). Item and report
> traffic across places goes through §5.7 as structured fields. The agent-to-agent forms of
> `sendMessage` are unchanged.
> **External**: an external place reads and posts like an internal one, for every agent (§5.5
> "Replies in an external place"); its approvals go to an internal member, and a post into it from
> elsewhere is a draft.

| Current place                | Readable sources                                             | Memory / knowledge | Output  |
| ---------------------------- | ------------------------------------------------------------ | ------------------ | ------- |
| P's DM                       | itself, and whatever P may see (§5.5 "Reads")                | all¹               | posted  |
| Internal channel or group DM | itself, and whatever every person asking on the turn may see | all¹               | posted  |
| External channel or group DM | itself, and whatever every person asking on the turn may see | all¹ ²             | posted² |
| Webchat                      | itself, and whatever the console shows its console user      | all¹               | posted  |

¹ The shared memory layer never holds content from DMs, webchat, private places or places with
outsiders (memory layers, below), so opening it everywhere does not reopen what the read rule closes.
² The standing summary of items is not injected there (§5.4 ②), and its approvals go to an internal
member (below).

**Replies in an external place (issue #2979, item B4):**

- **The change.** Until B4 an assistant-mode agent drafted its reply in an external place for an
  internal member to approve: the place saw no working indicator, streaming or tool progress, only
  a reaction on the triggering message; other platform writes there were refused; a scheduled
  run's opening message and a reminder there were drafted; and a place turning external cut the
  reply in flight. Drafting existed because an assistant-mode agent carried every enabled place's
  knowledge into each of them. B3 and B6 removed that reason: a read is judged by who is asking,
  and memory is layered by audience, so the shared layer never holds what a private conversation
  or one with outsiders said. What to share is then the asking person's call, as it is everywhere
  else, while drafting every reply made the agent unusable in a shared support channel. Every agent
  now replies there as it does anywhere: the reply streams under its indicator, other writes there
  go through, the anchor and a reminder post directly, and nothing is cut when the place turns
  external (§5.3).
- **What stays external**, for every agent: an approval there goes to an internal member (below);
  the place keeps its own memory layer; a post into it from another place is drafted or refused
  (below); a newly found one starts Off (#2980). Assistant mode also does not inject its standing
  summary there (§5.4 ②), since the item ledger is internal.
- A reply drafted before the change stays approvable and posts unchanged in its original thread.

**Drafts:**

- A post that needs approval goes as a card to an internal member's DM: the asker when the asker
  is an internal member (on Slack, a full member of the installing workspace — not a guest, not
  from the other organization), otherwise the responsible user (§5.1); with neither reachable it
  waits in Activity. **Approve** posts the text unchanged where it was aimed; **discard** drops it.
- **Whether the asker is internal is the platform's answer, for every agent.** Where the card
  surface can tell a full member (Slack's `isFullMember`), every asker is looked up, in any place
  and in either mode: a place not known external does not vouch for the people in it (§5.3). The
  lookup is the member-join one of §5.3, one per person a minute and at most four at once, and a
  draft makes at most one. A lookup that fails takes the asker as not internal; what follows is
  unchanged: an assistant-mode agent goes on to the responsible user or Activity, and any other
  agent refuses the post. Where a card surface cannot tell a full member (none does today: the only
  card surface is Slack's), a person who sent this turn's message from a place not known external
  counts as internal, the same for every agent, since an enabled place means the same in both
  modes (§5.3 "Conversation defaults"). A console asker is routed to the member they linked, as
  before.
- A draft is an approval record (§5.10) whose action is "post this text to this place"; the
  daemon executes it itself, with no sub-session. It expires after 24 hours.
- Any card that would land in an external place (a runtime permission request, a `propose`) goes
  to the same DM instead: a card is output too.

**Posts from another place into an external one:**

- A post into an external place from another conversation, or into one the platform could not
  confirm is not shared now, is drafted to that approver, showing the target and the exact text;
  **approve** posts it unchanged, **discard** drops it. Any other write aimed at an external place
  from elsewhere is refused.
- Whether a post needs approval follows from where it goes, never from the model's own judgment
  of how sensitive it is — a judgment a message in the conversation could talk it out of.
- A session no person is behind (a hook, a cron run that records no person) drafts every platform
  post aimed outside its own conversation, approved by the responsible user or in Activity.

**Writes — judged by who is asking (issue #2979, items B1 and B2):**

- **The change.** Until now an assistant-mode agent drafted every post to another place, for the
  asker to approve, and refused every other write there; "always allow from here to there" grants
  let a route stop asking. Agents outside assistant mode had only a Slack reach rule (a public
  channel, or a private one only where the agent was invoked) and nothing on other platforms or for
  the other write tools. The product owner's rule replaces both: the agent may post wherever the
  person asking could post, what is posted is that person's call, and the machine only checks
  access. Drafting a post the asker could have made themselves only made the agent slower than
  their own copy and paste, so internal posts are no longer drafted and the grants are removed:
  their table is no longer created or read, and existing rows are left unread rather than migrated.
  The rule itself is in [product-conventions.md](../product-conventions.md), "Writing to other
  conversations".
- **One choke point.** `judgePlaceWrite` in `mcp/ops/place-gate.ts` judges every platform write
  once its target is resolved: `sendMessage` through `judgePost` (before the platform is read for
  a named thread, so no error tells a closed place from a missing one), and `scheduleMessage`,
  `addReaction`, `deleteMessage`, the bookmark, canvas and list writes and `createConversation`
  through `judgeWrite`, which the dispatcher hands every handler. Another conversation is judged by
  the read rule's `askerMayRead` for every person on the turn, so B3's asker resolution and its
  owner-only console check apply unchanged.
- **Direct messages** go only to a member of the organization: where the platform declares
  `workspaceMembers` (Slack), a full member of the target bot's workspace; elsewhere the platform's
  own limits stand. A new conversation is opened only with such members, and made only for a full
  member, which a person off their own bot is as the account they linked there (see "Reads"). A
  canvas or a list is judged by the conversations it is shared in, from a new read port
  `documentReach` (Slack's `files.info`); one the platform cannot fully list is not changed.
- **External targets.** A post into an external place from elsewhere is drafted for every agent:
  the drafts machinery (record, Slack card, expiry sweep, click handling) is not assistant-only, so
  an agent outside assistant mode uses it with one change, routing only to the asker when they are
  a full member and refusing the post otherwise, since it has no responsible user or Activity
  view. In assistant mode a post from elsewhere first asks Slack whether the
  target is shared now (§5.3), as a granted post did; outside it, the integration's recorded
  external conversations decide.
- **No person behind the turn** writes only to its own conversation, which for an anchored hook or
  schedule is its configured target; assistant mode drafts other posts as before, and every other
  agent is refused.
- **The enabled-target requirement is removed**: a drafted post no longer needs its target to be a
  conversation where the agent is enabled, since the write rule already decides where the people
  asking may post. It is a separate change so that it can be reverted alone.
- **The 1:1 write bar is removed.** A DM or webchat conversation that read a private place under the
  person's access no longer refuses posts elsewhere, item changes or agent-to-agent sends until
  `!new`: posts follow the rule above, the item ledger keeps recording only who asked for what, and
  an agent-to-agent child session keeps the DM's visibility. The mark's table is no longer created
  or read.
- **Unchanged**: replies inside an external place (B4), memory, and the agent-to-agent forms of
  `sendMessage`, whose channel form keeps the Slack reach rule. Joining a public Slack channel later
  became a person's confirmation instead of the bot's `joinPublicChannels` setting (#2979, "Joining
  a public channel" in product-conventions.md).

**Reads — judged by who is asking (issue #2979, item B3):**

- **The change.** Until B3 a private place was read only from itself, except in its member's own 1:1
  DM, and only in assistant mode; agents outside it had a Slack-only reach rule and nothing on the
  other platforms. Now one rule serves every agent, and the person decides whether to share: the
  machine checks only whether the person asking has access to the source. An answer in a shared
  place is read by everyone present, but so is anything that person could paste there themselves;
  refusing them only made the agent less useful than the person's own copy and paste. The rule
  itself is in [product-conventions.md](../product-conventions.md), "Reading other conversations".
- **One choke point.** `judgePlaceRead` in `mcp/ops/place-gate.ts` passes every cross-place read:
  `getChannelHistory`, `getThreadHistory`, `getReactions`, `listBookmarks` (through the bridge
  dispatcher, before the handler) and `recall`. The decision is `readRefusal` in
  `assistant/place-access.ts`; refusals are counted with the existing metric, labelled by the closed
  tool and reason sets.
- **On the asker's own platform and bot** the platform decides, from read-port declarations
  (`platforms/read-ports.ts`), never a platform name: `channelPrivacy` (a channel the platform reports
  not private is confirmed public: Slack, Discord by the `@everyone` view permission, Feishu/Lark by
  `chat_type`, Telegram by a public @username), `authoritativeMembers` (Slack, Feishu/Lark by
  union_id) and `workspaceMembers` (Slack's `isFullMember`, which tells a guest or an outsider from
  a full member). A 1:1 DM's only member besides the bot is its person, so membership decides a DM
  too. Lookups are cached for a minute (`assistant/place-members.ts`) and fail closed.
- **On another platform or bot, and for every console user**, a person the product can identify (a
  console user, or a chat member who linked a console account) who linked a chat account in the
  target bot's workspace is judged as that account on that bot, by the rule above. The daemon asks
  `agent/read-access` with `linkedOn` (feature `read-access-linked-v1`); the CP resolves the asker
  to their console user as below, matches that user's linked identities against the bot's
  `chatMemberTenant` (Slack's workspace, Feishu/Lark's region) and answers the member id or none.
  The answer is cached for a minute per agent, bot and asker beside the membership lookups. A CP
  without the feature is not asked, so the console's visibility decides as before; one that
  advertises it but fails, or answers without the field, refuses the read. A webchat source never
  asks, so it stays its owner's.
- **Otherwise**, for a person with no linked account in that workspace (Telegram, Discord and
  Google Chat accounts cannot be linked), the read is judged by the console's own session-visibility
  predicate
  ([session-visibility.md](session-visibility.md)), asked of the Control Plane through
  `agent/read-access` (feature `read-access-v1`): the CP resolves a chat member to the one
  organization member who linked that identity, or takes a console user directly, and answers which
  of the agent's sessions there that user could see. Every session the read would
  show must be visible; `recall` reads at most the place's eight newest sessions, the ones it checks.
  For a DM, a webchat conversation or an undescribed place the rule is stricter than the console:
  the daemon asks `ownerOnly`, and the CP counts only sessions whose recorded owner is that user
  (a webchat session always), so a DM the console shows every member stays its owner's alone. A CP
  that is unreachable, or lacks the feature, refuses the read.
- **Who is asking** on a turn: the senders of its message and of every message coalesced or steered
  into it, recorded before the runtime sees them; the console user in webchat and a console
  continuation; a sub-session's opener (kept in memory, so a restart reads it as no one); a patrol's
  or a task's item asker (the item's first follower); a schedule's last human editor, else its
  creator (`CronUpsert.askerUserId`). Hook runs, report rounds, schedules that record no person and
  agent-to-agent messages are no one: the agent-to-agent frame carries no originating person and was
  not given one.
- **The answer** to a refusal is one opaque "I can't share that here"; a chat member with no linked
  console account is also told how linking opens reads across platforms and bots, on every refusal,
  so the hint never tells a closed place from a missing one. A read of a private source carries a
  `privateSource` note naming it, and the model is asked to mention the source in one short clause.
- **A read restricts nothing afterwards.** The 1:1 write bar B3 kept is removed by B1/B2 (§5.5
  "Writes").
- **Revocation**: after P leaves a place, excerpts already in a conversation's context stay there;
  new reads are refused once the cached membership expires.
- **"Ask me in a DM"** is retired: a DM is readable from anywhere by its own person, and nothing
  tells anyone else that it exists. `handoff` (P1) remains the way to answer a question in the
  asker's DM under that session's permissions.
- **Memory layers** ([product conventions](../product-conventions.md#memory-layers)): every agent,
  in assistant mode or not, keeps memory by audience. Per-turn capture, dreams and explicit writes
  go to the conversation's layer: the shared layer only from a public channel the platform
  confirms internal, the person's layer from their DM or console conversation, the place's own
  layer anywhere else. The shared layer therefore never holds what a DM, a private place or a
  place with outsiders said. The per-person memory space this section planned for P1 is the
  person layer, built for every agent; "allow for this session" is gone for every agent. Runtime
  native memory must be disableable (admission) and is disabled on enable.

### 5.6 Sub-sessions

**P0b ships the minimal form**: self-delegation as below, a failure report the daemon sends when a
sub-session ends without reporting (§5.7), and a concurrency cap that refuses beyond
`maxConcurrentSubsessions` (default 3). Reports use the existing parent-report path
(`replyToSession`). The persistent outbox, the recovery order, listing / steering, the daily
budget and queueing over the cap are deferred until use shows they are needed; the rest of this
section and §5.7 describe that target. Permission-request routing and its wait cap (items 2 and 3
below) have shipped, and so has stopping from the main conversation (§5.8).

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
  parent–child index** (`childSessionLinks` is in memory). Stopping has shipped (§5.8). Listing
  is the running block of the standing summary (§5.4); a listing tool and steering stay deferred.
- **Runtime permission requests** (far more common than `propose`):
  1. Standing prompt: finish the work in the workspace; the outward step (push, open the PR) goes
     through `propose`.
  2. When one fires it is delivered to the place of origin (an external place's to the approver's
     DM, §5.5) as a card through the existing two approval paths and listed in Activity; the card
     offers "always allow this tool". **Shipped**, for delegated and `task` sub-sessions (a patrol
     still refuses, §5.9), as the one pending request every surface settles (slack-approval-dm.md
     §11): a Slack, Telegram, Discord, Feishu/Lark or Google Chat place gets the in-chat card where `chatActions` (`approve` or above) lets people
     there answer (only editors where permissions are synced), otherwise a neutral notice plus the editor DM, the notice rewritten in place to how
     the request settled; the card names the sub-session (its title, else its task), links it
     and says how long it waits. It goes to the parent's own thread, or to the conversation's
     root for an `append` conversation, where reports land too. A webchat place has the console:
     the request carries its conversation (`parentSessionId`), whose page lists it among its own.
     An external place's card goes where drafts route theirs: the responsible user's DM (a click is
     verified like any approval DM), else an editor's DM as for any other request; Activity lists it
     either way. Approval elicitations take the
     notice and editor path, since a chat card for them needs a live turn's surface.
  3. **Waiting is waiting**: the ACP request stays open and the turn is not cancelled — the card
     and both approval paths are bound to that pending request; cancelling it expires the card,
     and a later "continue" grants nothing to the re-triggered request. Host and concurrency slot
     stay occupied (the slot bounds occupied hosts anyway); Activity shows "awaiting approval".
     `permissionWaitHours` (default 12) caps the wait: then deny, report, and the sub-session
     stops; re-delegate to continue and it asks again. Cost: on the pool a waiting sub-session
     holds a pod. If that becomes a cost problem, P1 may add "cancel the turn plus a cross-turn
     one-shot grant". **Shipped**: the record is denied with "no answer within N hours" and its
     cards rewritten; the stop is latched (`approval wait expired`) before the runtime is answered
     `cancelled`, so the turn ends stopped and the existing failure report tells the parent. The
     timer lives in memory: a restart ends the turn, the store expires every request no process
     holds a resolver for, a stale card's click or console decision finds nothing pending, and the
     card's and the notice's handles on the row let the reconnect sweep retire them.
  4. Switching assistant mode on moves an asking mode to the runtime's auto mode, else its
     full-access mode (§1.8), so requests come only from what that mode still escalates or from
     an asking mode an editor picks afterwards (asking every time gets the warning in §1.8).
     Nothing else changes the permission mode.
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
instead, never two; an interruption that will be replayed sends none. When that replay never runs
the turn — a same-process replay finds its message already carried by the prompt that was cut, or a
purge drops the kept delivery — no turn end reports it, and its `open` row would hold a slot under
the cap for good. So the minute sweep reports it ended, as no longer running, once it has seen
nothing run for it for ten minutes: no live or queued turn, no delivery left in the inbox, no
background task owing it a wake, and the agent not paused. An approved task is left to its own
recovery (§5.10). The failure report waits on the sub-session's index row as `reporting` until it
is admitted: a refused admission is retried on the minute sweep, three attempts in all, a drain or
restart leaves it to be re-sent on the next start, and a fixed delivery id with the inbox's
receipt keeps a re-send from arriving twice. Like patrol and task reports, it goes to the current
session of the parent's place (after `!new`, the new conversation), else the recorded parent. Every
report the daemon sends ends by telling that session to answer its people in their language,
since its framing is English; patrols and tasks are asked to write their report in it, and a
delegating conversation tells its sub-session which it is. The outbox below is the deferred target.

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

| Action                                        | Effect                                                                                                          | Who                                                                                   |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| "Stop" in the main conversation               | Interrupts that conversation's current turn only                                                                | today's `!stop` rules                                                                 |
| Stop one piece of work (named, or in webchat) | Interrupts that sub-session's current turn                                                                      | same, for whoever started the turn / whoever may continue that session in the console |
| **Pause the agent** (existing #288)           | Interrupts every session and blocks new turns (today); assistant mode also suspends patrol wakes and the outbox | existing pause permission                                                             |

**Stopping a named piece of work** is the `stopSubsession` tool, given the sub-session's id. Only
an assistant-mode agent's main conversations are offered it: never a sub-session, patrol, task,
hook or cron run. It stops only a sub-session whose parent in the persistent index is the calling
conversation. Any other id is refused with the same words as an unknown one, so nothing about
another conversation is revealed. The turn must have been started by a person's own message, and
that person must pass today's `!stop` sender rule there; in webchat, the Control Plane admitted
the message only from someone who may continue the conversation. A report round, a reminder or a
scheduled run is refused. The stop itself is the console's Stop: the same daemon core, logged
with who asked. So it answers the same way: stopped, or not running, adding that a background
process the runtime started may keep running. Stopping one's own sub-session moves no content, so
a session marked by a private read (§5.5) may still do it. The tool's description tells the
agent to ask which sub-session the person means only when that is not clear; a clear request is
carried out at once.

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
  as a failure. A run's reports are admitted before it settles, each under a stable id the inbox
  deduplicates, so a run whose turn ended before it settled is settled on the next replay without
  a second report. Stopping a patrol from the dock ends it silently with its check done.

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
  `patrol`. `remind` ships first, to sessions of an assistant-mode agent that have a
  platform conversation of their own:
  - `remind({ at, message })` keeps `message` verbatim for `at`, an ISO-8601 instant with an offset,
    in the future and at most 366 days ahead; the text is non-empty and at most 40,000 characters.
    `listReminders` and `cancelReminder` reach only the current conversation's pending reminders.
  - It lands only where the setting session's replies land, that conversation and thread; there is
    no target argument. It is refused in sub-sessions and patrols, and in webchat, which has no
    daemon-side post path without a turn. An external place sets and receives reminders like any
    other (#2979, B4).
  - The duty holder's sweep, on the patrol cadence, claims a due reminder atomically and posts it
    through the executed-draft post path as the agent: no ACP, no turn. A claim cut short by a
    restart or handover fails and is never posted again, so delivery is at most once. A platform
    error is retried on later sweeps, three attempts in all, then fails with a warning; a send
    that timed out or came back without a message id may or may not have posted, so it fails at
    once.
  - While the agent is paused or out of assistant mode nothing is delivered; afterwards a reminder
    less than 24 hours late posts late and an older one expires. An agent holds at most 100
    pending reminders, a fixed limit with no setting. Settled rows stay, like the other assistant
    tables' settled rows, until the agent is removed.
  - A session marked by a private read (§5.5) may set reminders: they land only in its own DM.
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

- The card is posted in the item's place of origin, where the place's own replies land: its root,
  or the thread its long session lives in. An external place's card, or one the place cannot take,
  goes where a draft with no asker goes instead (§5.5): the responsible user's DM, else it waits in
  Activity.
- **Drafts are the record's first use** (P0a): action "post" — into an external place from
  another place (§5.5) — executed by the daemon. General
  `propose` actions come with P1.
- **Approvers of a proposal are whoever could ask the agent in its place**: a DM's own person; in
  a channel, a person whose own message would start a turn of the agent there, judged at the click
  by the place's live admission and trigger; never a bot. Approving runs the task with the agent's
  own permissions, which is what asking there gets, so it grants nothing more. For an external
  place, the internal member of §5.5; editors always, in Activity. A draft's approvers stay as
  §5.5 says. `chatActions` is not read: it guards runtime approval controls and runtime-setting
  changes in chat, a different decision. Cards exist on Slack only; other platforms use
  the console.
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
4. **Approvers** are the people who could ask the agent in the item's place, through the draft card
   posted there, plus the agent's editors in the console's Activity view; the first answer from any
   surface wins. The responsible user's DM gets the card only when the place cannot (an external
   place, a post that definitely failed, a place gated by a decision's verdict, a platform with no
   card), and with them unreachable the proposal waits in Activity. A timed-out post may still land, so it is never carded twice:
   the place keeps it. The card's handle and the status it last showed are on the record, so a reconnect
   rewrites a card a restart left behind. A webchat place has no card: the proposal waits in its
   conversation's pending-requests strip. Whoever may continue that conversation in the console may
   decide it there, and so may the agent's editors. The strip reads and decides through routes of
   its own, which pass the conversation to the daemon. The daemon lists only that conversation's
   proposals and refuses a decision on any other. The responsible user is not asked.

A cut execution settles from the sub-session's durable end: reported ⇒ `succeeded`, failure report
already sent ⇒ `failed`, otherwise `outcome_unknown` with one "please check" report.

### 5.11 Activity

The console's agent page gains an Activity view: items, scheduled wakes, running sub-sessions,
recent patrols, pending cards — all derived from the ledger, the approval records, the outbox and
session records, read from the daemon through the BFF proxy. A background report into a webchat
conversation only raises an unread badge.

The first version (#2876) shows what exists today, for assistant-mode agents only, read and
changed through the daemon without anything persisted on the Control Plane:

| Section                             | Who sees it                                                                                                                                                          | Who may change it                                                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Items (open, then done and dropped) | anyone who can view the agent; the places an item is followed from, never who follows it or what was said; the next check, which wakes a patrol (§5.9)               | editors delete an item                                                                                                       |
| Sub-sessions                        | anyone who can view the agent sees state and start time; the title, the session link and the conversation that opened it only where the viewer may open that session | —                                                                                                                            |
| Pending drafts                      | editors                                                                                                                                                              | editors approve or discard (#2880) — the same decision path as the card, so a card click and a console decision execute once |

Deleting an item drops it from the standing summary at the next reminder; its followers are not
told. A console decision that cannot be confirmed keeps its row and tells the editor to check the
destination (#2881). Sub-sessions' runtime permission requests are listed under pending drafts for
editors (§5.6): the sub-session and conversation where the viewer may open them, the tool, the
wait's deadline and the request's own options, answered through the approval queue's decision so
the first answer from any surface wins. Patrol history and the unread badge are not in it yet.

---

## 6. Relation to existing mechanisms

| Mechanism                           | Relation                                                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Conversation gating (§14)           | Unchanged: `gated` stays restricted visibility alone, and the mode takes the same defaults (§5.3)               |
| Session visibility                  | The permission rules follow it; DM long sessions are fixed `private`; sub-sessions refuse visibility changes    |
| `append`                            | Extended to Slack DMs; retention (assistant agents) and the visibility lock are prerequisites                   |
| Memory layers                       | The same for every agent; the ledger is its own store                                                           |
| Dreams / explicit memory writes     | Dreams mine the shared layer's conversations only; writes go to the conversation's layer                        |
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

| Phase                             | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prerequisites                     | §4.2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **P0a — continuity and one mind** | Switch and admission; gating derivation and trust levels (enabled means internal, with a warning; Slack Connect detected external); Slack DM `append`; the ledger, the standing summary, `recall` and the permission rules (read, write); drafts in external places and posts to other places (the approval record, "post" only); memory bypass closed; "ask me in a DM". **No sub-sessions**                                                                                                                                                                                                                                                       |
| **P0b — background work**         | Minimal: direct self-delegation (own `subsession:` coordinate, inherited visibility, no nesting, the persistent parent–child index); a daemon failure report when a sub-session ends without reporting; a concurrency cap that refuses. Deferred until needed: the persistent outbox, recovery order, list / steer (the standing summary names the running ones; stop has shipped, §5.8), the daily budget, queueing over the cap                                                                                                                                                                                                                   |
| P1 — while nobody is around       | Shipped: minimal patrol (§5.9, #2887), `propose` from patrols (§5.10, #2895), Activity with console decisions (#2876, #2880), the webchat sub-session panel and read-only sub-session pages (#2885, #2893), per-asker recall in the asker's DM (§5.5, #2901), `remind` (§5.9), sub-session permission requests routed to their conversation under the wait cap (§5.6), stopping a sub-session from the main conversation that opened it (§5.8). Next: the target patrol (after per-runtime tests) on the credential-less host; `handoff`; identity links pushed to the daemon. The per-person memory space shipped as memory layers for every agent |
| P2 — cost and events              | Hook events routed to patrols; Decision triage; budgets; incremental summary injection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| P3                                | The personal form; retention widened to every user once run state is decoupled from session rows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

---

## 8. Explicitly not done

- The personal form; one shared context; an output filter as a defense; member enumeration as a
  precondition for recall;
- a dedicated sub-session workspace, changing the agent's isolation, changing the permission mode
  other than by the default when the mode is switched on;
- automatic retry of an uncertain external write; cancelling a waiting permission request to free
  a slot (P0);
- delegation / report / status tools parallel to `sendMessage`; restoring the orchestration tool
  triple; a new "stop everything";
- sub-sessions of sub-sessions; sub-sessions as platform threads;
- an "add this to the ledger" card; the "allow for this session" memory-write bypass;
  `tool_call.kind`-based retry;
- per-place restrictions on `!stop`, `!new` or pause; filtering self-initiated Slack joins;
- closing reads or memory in external places — reads are judged by who is asking and memory by
  audience instead (§5.5); drafting replies there (removed by #2979, B4); editing a draft
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
5. **Trust drift**: a place whose members change after the agent first answered there;
   member-joined coverage per platform beyond Slack guests.
6. **Cost**: one long conversation per place and one main-session turn per report round; needs
   P0 measurements.
7. **Wording of item summaries**: the restatement when an item is taken is the only review point
   for what becomes team-visible.
8. Whether distillation on a normal OpenCode host runs under `plan` (live, unverified).
9. **Settled by B1/B2**: with no marked sessions left (§5.5 "Writes"), what a person's request
   sends out of a conversation is that person's call, through any tool.

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

**Twelfth revision (2026-10-10)**: per-asker recall applies only where the asker is the whole
audience — their own DM with the agent — with membership checked live on platforms whose member
listing is authoritative; every shared place keeps the P0a private-place rule. Architecture review
of that change: the Read box, the `P's DM` row and the target now state the same rule; the widening
is bound to a turn P started, never a report, patrol, cron or sub-session turn, and to a read of a
named place, never to recall's listing; a session that made a widened read writes only to P's DM —
no ledger writes, self-delegation, posts elsewhere or agent-to-agent sends — until it is retired,
because the content stays in its context across turns, and a later session that reads the DM's
history back is marked too; per-person memory captured from it stays in P's DM; revocation residue
and the metric's inputs are stated; writes through code-host, MCP and shell tools are left open
(§9).

**Thirteenth revision (2026-10-10)**: `remind`, the cheap tier of self-scheduling, ships ahead of
the target patrol (§5.9): text set for a time is posted verbatim by the duty holder's sweep into
the conversation and thread where the setting session's replies land, through the executed-draft
post path, with no turn. Delivery is at most once (an atomic claim; a claim cut short fails), a
platform error is retried three times, a pause delivers nothing and a reminder more than 24
hours late expires, a place that turned external drafts the text instead, and an agent holds at
most 100 pending reminders. Sub-sessions, patrols, external places and webchat cannot set one;
a session marked by a per-asker read can, since it lands only in that DM. Listing reminders in
Activity and delivery to another place or a person's DM are left for later.

**Fourteenth revision (2026-10-10)**: §5.6 items 2 and 3 ship. A delegated or `task` sub-session's
runtime permission request, seen only on the sub-session's own page until now, reaches the
conversation it belongs to through that place's own approval path: the in-chat card where anyone
there may answer, else a neutral notice and the editor DM; the console's request list for a
webchat conversation; the drafts approver for an external place. It is the one pending request
every surface settles, so the first answer wins, and Activity lists it for editors. After
`permissionWaitHours` (default 12) it is recorded as denied, the sub-session stops with the reason
latched before the runtime hears the answer, and the existing failure report tells the parent. The
cap is an in-memory timer, which a restart cannot turn into a later grant: the turn ends, the
request expires, and its card is retired by the reconnect sweep. Approval elicitations take the
notice and editor path; patrols still refuse.

**Fifteenth revision (2026-10-10)**: quiet hours are dropped from P1 and the per-person form from
P3. A teammate keeps no office hours of its own, and a person who wants quiet mutes notifications
in their own chat client; nothing in the design depended on a delivery window.

**Sixteenth revision (2026-10-10)**: a sub-session's failure report is no longer lost to a drain, a
refused admission or a restart. It is held as `reporting` until admitted, retried on the sweep up to
three times, re-sent after a restart and deduplicated by a fixed delivery id, and it reaches the
parent place's current session through the one delivery path the daemon's patrol and task reports
already use (§5.7).

**Seventeenth revision (2026-10-12)**: the ledger's no-quote rule covers private channels and group
conversations as well as DMs. In a test, an item taken in a private channel carried a figure said
there into its done-when, and another place read it back from the ledger although recalling the
channel itself was refused. The item tools' descriptions now forbid quoting or paraphrasing any of
these conversations, down to a figure or a detail, and have the agent tell the person, as it takes
such an item, that the item is visible to the whole organization. The rule stays an instruction
rather than a per-place filter on the ledger.

**Eighteenth revision (2026-10-12)**: a patrol's proposal is carded in the conversation its item
belongs to. In a test, the card went to the responsible user's DM or the fallback conversation,
and the place that asked saw nothing: not the proposal, not its denial, not its expiry. Now the
card is posted there and rewritten in place as it is approved, denied or expires, and again when
the task ends. Whoever could ask the agent there may approve it: in a DM, that person; in a
channel, anyone whose own message would start a turn of the agent, judged at the click by the
place's live admission and trigger. This grants nothing new. An approved proposal runs a task with
the agent's own permissions, which is exactly what a person there gets by typing the request, and
runtime permission requests inside the task still take the normal path. So the approval does not
read `chatActions`, which guards runtime approval controls and runtime-setting changes in chat, a
different kind of decision, and it adds no setting. The first version kept
proposals off the in-place card because that card was bound to an ACP request of the
conversation's own turn. Since #2913 a conversation shows cards for requests its own turn did not
raise, so that reason no longer holds. The responsible user and the fallback conversation are now
the fallback only, used when the place cannot take the card. The first answer from any surface
still wins. Webchat places keep Activity for now (§5.10).

**Nineteenth revision (2026-10-12)**: a patrol's proposal for an item taken in a webchat
conversation now shows in that conversation's pending-requests strip. Until now only editors saw
it, in Activity, and the conversation itself showed nothing. Whoever may continue the conversation
in the console may approve or deny it there, the same check that lets them stop its sub-sessions.
The agent's editors may too, there and in Activity. This matches Slack, where the card goes to
whoever could ask the agent in the item's conversation, and it grants nothing new. The proposal is
no longer carded to the responsible user or the fallback conversation. Two new routes list and
decide one conversation's proposals, and the daemon refuses a decision for a proposal of any other
conversation. The first answer from any surface still wins.

**Twentieth revision (2026-10-12)**: the main conversation can stop a sub-session it opened. In
a test, a person asked in a Slack DM to stop one, and the agent answered that it had no tool for
it; only the console could. Now the main conversation of a place has `stopSubsession` (§5.8). It
stops only a sub-session that conversation opened, on a turn a person there started, under the
`!stop` sender rule; in webchat, the person may continue the conversation. It runs the console's
own Stop, so the effect and the answer are the same. The agent confirms which sub-session is
meant before it stops one. To name one, the standing summary of a main conversation lists the
sub-sessions it opened that are running now (§5.4). That block is re-injected on the next turn
after one starts or ends. Stop leaves P0b's deferred list; listing as a tool and steering stay
deferred.

**Twenty-first revision (2026-10-12)**: a sub-session that nothing will run again is reported
ended. A sub-session turn cut for a handover or a runtime respawn and replayed in the same process
was folded away, its message already carried by the cut prompt, so neither a replayed turn nor a
failure report settled its row, and the row held one of the agent's concurrent slots for good.
Now the minute sweep reports such a sub-session ended once nothing has run for it for ten minutes
(§5.7), through the existing failure report, which also frees the slot. Why the same-process replay
folds the turn away is not changed here.

**Twenty-second revision (2026-10-12)**: assistant-mode turns are told the people's local time. In
a test, an agent in a Slack DM with a person in UTC+8, at 04:20 on a Monday, said today was Sunday
and called that same Monday "tomorrow". The times it scheduled carried the right offset, but its
sense of today followed the runtime host's clock, which is UTC. Now every turn of an assistant-mode
agent opens with one line naming the current local date, weekday, time, zone and offset (§5.4 ④).
The zone is the sender's Slack profile zone or the console browser's; a turn no person started
takes the zone last seen from a person in its place; otherwise the line says UTC and that the local
zone is unknown. No tool changes, and an agent outside assistant mode gets no line.

**Twenty-third revision (2026-10-12)**: switching assistant mode on sets a default permission mode.
In a test, nearly every background task stopped to wait for approval of a file write, and nobody
was watching. Now the edit that switches the mode on, from the console or the API, moves an unset,
asking or read-only mode to the runtime's auto mode, or to its full-access mode where the runtime
has no auto mode (§1.8). Which mode is which is a per-runtime map beside the admission list: Claude
Code gets `auto` and Codex gets `agent`, its "Auto review"; OpenCode has neither and keeps its
mode. An auto or full-access mode, Claude Code's `dontAsk` and a mode set in the same edit are
kept. It is a default, not an admission check: an editor may pick another mode afterwards, the
choice sticks while the mode stays on, and the ask-every-time warning returns for it. Switching
the mode off and on again applies the default again.

**Twenty-fourth revision (2026-10-12)**: reads are judged by who is asking, for every agent (issue
#2979, item B3; §5.5 "Reads"). The per-place rule refused a member their own private channel from
any shared conversation, and agents outside assistant mode had no rule at all off Slack: a Discord
or Feishu chat the bot was in was readable from anywhere. The product owner's principle settles both:
the machine checks whether the person behind the request has access, and that person decides
whether to share. On the asker's own platform and bot the platform's membership decides; anywhere
else, and for every console user, the console's own session-visibility predicate does, asked of the
Control Plane, so no second rule exists to drift from it. Runs a person started read as that person:
a sub-session as its opener, a patrol or a task as its item's asker, a schedule as its last editor.
The 1:1 write bar keeps its trigger and is not extended to shared conversations; writes, memory and
the item ledger are unchanged.

**Twenty-fifth revision (2026-10-13)**: writes are judged by who is asking, for every agent (issue
#2979, items B1 and B2; §5.5 "Writes"). The same principle as the read rule: the agent may post
wherever the person asking could post, and what is posted is their call. Posts to internal places
are no longer drafted, so the "always allow from here to there" grants and their Activity section
are removed, and so is the requirement that a drafted post's target be an enabled place. A post
into an external place from elsewhere is still drafted, now for every agent. The 1:1 write bar is
removed: it refused a person writes they could make themselves. A turn no person is behind writes
only to its own conversation.

**Twenty-sixth revision (2026-10-13)**: memory is layered by audience for every agent (issue #2979,
item B6; [product conventions](../product-conventions.md#memory-layers)). A public channel the
platform confirms internal uses the shared layer; a person's DM and console conversations use that
person's layer, keyed by their linked console account; every other conversation keeps a place layer
of its own. The P0 memory bypass and the per-person memory space planned for P1 are both this rule,
now applied to agents outside assistant mode too, and the Agent/Channel memory scope is retired.

**Twenty-seventh revision (2026-10-13)**: off their own bot, a person the product can identify is
judged by the chat account they linked in the target bot's workspace (issue #2979, items B1 to B3;
§5.5 "Reads"). Judged only by console session visibility, a person in the Playground, or a Slack
member asking about Feishu, could neither read nor post in a conversation the agent had never been
in, even as a full member of that workspace or a member of that private group. Someone with a
linked account there is now judged as that account; without one, by the console as before. An
asker on their own bot, and one the product cannot identify, are unchanged.

**Twenty-eighth revision (2026-10-13)**: every agent replies directly in a conversation shared with
another organization (issue #2979, item B4; §5.5 "Replies in an external place"). Assistant mode
drafted those replies because the agent carried every enabled place's knowledge into each of them;
with reads judged by who is asking (B3) and memory layered by audience (B6), that reason is gone,
and drafting every reply made the agent unusable in a shared support channel. Assistant mode stops
drafting the turn's reply, a scheduled run's opening message and a reminder there, stops hiding the
indicator, streaming and tool progress, stops refusing other writes into the conversation, and no
longer cuts the turn in flight when a place turns external, so the interrupt and its place scoping
(#2970) are removed. Detection, approvals routed to an internal member, the place's own memory
layer, drafts of posts from elsewhere and the starting Off stay for every agent. The standing
summary of items is no longer injected there, since the ledger is internal.

**Twenty-ninth revision (2026-10-13)**: every agent is told the people's local time (issue #2979,
item B9; [product conventions](../product-conventions.md#local-time)). An agent outside assistant
mode was told nothing, so it read "today" off the runtime host's clock, which is UTC in a
container. Now every agent's turns carry the line of §5.4 ④, and its zone is the first one known
of: the sender's own (a Slack or Feishu/Lark profile, a console browser), a scheduled run's
configured zone, the zone of the person who started a run no one sent, the zone last seen in the
place, and UTC. A schedule's own zone now wins over the place's, and a background run reads its
starter's zone before the place's; with neither known, assistant mode reads as it did. The per-place
store is the same table under a mode-neutral name in code.

**Thirtieth revision (2026-10-13)**: assistant mode no longer gates conversations (issue #2979,
item B7; §5.3 "Conversation defaults"). Gating rested on enabling a place being the trust boundary,
and reads judged by who is asking and memory layered by audience have taken that role. An
assistant-mode agent now takes the conversation defaults of its visibility and can be a shared
bot's default member; the enable warning, the turn-on warning that named enabled rooms, the
one-room-at-a-time rule for Apply to all and the console banner are removed. Rows already Off stay
Off, and an Off nobody chose keeps the one-time notice for every agent. A place's first message
already keys its one session (§5.2). The permission-mode default (§1.8) is unchanged.

**Thirty-first revision (2026-10-13)**: the responsible user is derived and the fallback
conversation is removed (issue #2979; §5.1). Both were settings an editor had to fill in before the
mode could be switched on, for work no person was behind. Since writes and reads are judged by who
is asking, most work has a person behind it: the asker, a schedule's creator or editor, an item's
asker, a sub-session's opener, and they still come first. A conversation where anyone may decide
also conflicts with that rule, since the machine checks who is asking and a fallback conversation
let whoever was in it decide for someone else. So the responsible user is now the agent's creator
while they may edit it, otherwise the editor who joined the organization first, derived by the
Control Plane each time it is asked; what reaches nobody waits in Activity, where an editor decides
it. Stored values stay in place for one release and are read past, so a Control Plane still serving
during the rollout never reads a policy it cannot parse; the next release drops them (§5.1). The
assistant mode panel moves from the Memory tab to the Configuration tab and shows the derived person
read-only; managed memory stays an admission requirement.

**Thirty-second revision (2026-10-13)**: a draft's asker is internal on the platform's word, for
every agent (issue #2979; §5.5 "Drafts"). An assistant-mode agent took a person who sent the turn's
message from a place not known external as an internal member without asking, because enabling a
place once meant someone had vetted it. Since the thirtieth revision an enabled place is any
conversation the agent's visibility admits, and a guest already in a channel when the bot arrived
is never detected, so such a guest could approve a post into a conversation shared with another
organization. Every agent now asks the platform whether the asker is a full member wherever the card
surface can tell, reading the member-join lookup's per-person answer; a failed lookup takes the
asker as not internal. Where a card surface cannot tell, the place still vouches for the person who
spoke there, now the same in both modes.
