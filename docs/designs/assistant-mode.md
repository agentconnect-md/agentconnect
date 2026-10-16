# Assistant Mode

**Status:** Design, fourteenth revision (2026-10-10). Reviewed by three independent design reviews
and the repository's review bot; §10 records what each round corrected. Nothing is implemented yet.
Prerequisites: #2812, #2813. Work breakdown: #2810.

**In one sentence:** switch an agent into assistant mode and it behaves like one person on the
team — it keeps a continuous conversation with you in every place, what it hears in one place it
knows in the others, it only says what the people present may hear, it follows up on what
everyone asked of it, checks on progress by itself, speaks up only when there is something to say,
and asks before it acts.

**Name:** unrelated to [agent-assistant.md](agent-assistant.md), which is the AgentConnect MCP
tool set for AI tools. That design gives an agent tools to administer the platform; this one
describes how an agent behaves.

**Console:** the switch sits in the assistant mode panel on the agent's Configuration tab, offered
behind the `assistant-mode` flag (`features.assistantMode` in the chart, off by default) until it
changes behavior. The flag gates only switching the mode on: an
agent already switched on keeps the switch, Activity, the Tasks tab and proposals.

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
  list of open follow-ups is not brought there.

### 1.2 Asking it to do things

- Ask as you would a colleague. It restates its understanding — what to watch, what counts as
  done, when to check next — and on your confirmation it takes a follow-up of that conversation.
- A follow-up belongs to the place it was taken in: only that conversation is told of it, unless
  it is a public channel, whose follow-ups every internal place of the agent is reminded of.
- **It reports in the place you asked.** Tell it there to change what or when it checks, or to
  stop following it up.
- When an open follow-up of the conversation already covers a request, it offers to send that one
  the change instead of taking a second.
- When the asker can no longer be reached (DM closed, left the channel), reports go to the agent's
  responsible user (§5.1), and otherwise wait in its Activity view.

### 1.3 Long work: delegated tasks

- A delegated task is **work the conversation hands off on demand**, in a context of its own — "fix
  this bug and open a PR". Ordinary conversation stays in the main conversation.
- Every agent has them, in assistant mode or not (§5.6). Follow-ups and approved proposals are
  tasks of the conversation they report to as well, but no conversation delegates them, and they
  stay assistant mode's.
- In an IM: the main conversation says "started", then reports the result with a console link.
  Nothing extra appears on the platform.
- Stopping and steering go through the conversation that delegated the task: "stop the PR one",
  "change the PR task to X" (§5.6, §5.8).
- In webchat: a conversation's tasks are visible in its Tasks tab — watch, talk to one
  directly, stop one.
- The workspace is whatever the agent's other sessions get: a worktree each under session
  isolation, the shared primary otherwise.
- It finishes the work inside the workspace and asks separately for the outward step (push, open
  the PR). If it hits an operation that needs approval midway, it waits; the card goes to the place
  you asked from; it continues once you approve.
- Tasks are one level deep: a delegated task cannot delegate tasks. Concurrent ones are capped and queue
  beyond the cap, and it tells you.

### 1.4 Stopping

- "Stop" in the main conversation interrupts only that conversation's current turn — **not the
  work already delegated**, and it does not mute the conversation.
- To stop one piece of work, name it in the conversation that started it, or stop it in
  webchat. The agent first confirms in one sentence which one you mean. Stopping interrupts its
  current turn; a background process the runtime started itself (a build, a dev server) may keep
  running, and the answer says so.
- To stop everything, **pause the agent** in the console (today's pause): main conversations
  and tasks stop until resumed. Checks missed meanwhile are not replayed; follow-ups
  whose check is overdue are each checked once after it resumes.
- Stopping never undoes what is already done.

### 1.5 While you are away

- At the agreed times it checks each follow-up, **read-only**: it checks status, reads
  logs, looks at PRs — no edits, no messages, no clicks. What always holds: it does nothing under
  its own identity and writes nothing through AgentConnect. "Does not touch your workspace" holds
  when the runtime has a read-only mode or runs in a sandbox; without either, the settings page
  shows its checks as _degraded_ (§5.9 says what that means).
- Three outcomes: something you should know → one message; something it wants to do → a card
  "I want to do X because Y, OK?"; nothing → silence.
- One message per change; after repeated failures it stops checking that follow-up and tells you
  once, until you message it. A turn interrupted by a rolling deploy is re-run without
  bothering you.

### 1.6 Approval

- A proposal's card lands in its follow-up's place; for an external place, in the approver's
  DM instead (§5.5). Whoever could ask the agent there may approve it: in a DM, that person; in a
  channel, anyone whose own message would start a turn of the agent there; in webchat, whoever may
  continue the conversation, from its pending requests. Approving runs the approved proposal with the
  agent's own permissions, which is what asking there gets, so it grants nothing more.
- A runtime permission request inside that run follows the existing in-chat approval rules: where
  "What people can do in chat" includes approving tool calls, anyone who sees the card can click;
  otherwise the console and the editor DM path. That card offers "always allow this tool".
- The card leads with one plain sentence; the raw arguments are folded underneath.
- It acts only after approval and reports back. An uncertain outcome is reported as "not sure this
  went through, please look" — never retried. An expired card is never executed.

### 1.7 Progress

- "What's on your plate?" lists the follow-ups of the place, what it last saw for each, when it
  checks next, what awaits approval, which tasks are running.
- The console lists follow-ups among the tasks, with their recent checks; Stop ends one.

### 1.8 Enabling

- Switch assistant mode on in the agent's settings. The agent must pass admission (§4.1); an
  agent that does not gets a locked switch with the reason.
- Tasks nobody watches should not stop for approval, so switching it on sets the
  agent's permission mode to the runtime's auto mode (Claude Code's `auto`, Codex's `agent`,
  which it calls "Auto review"), or to its full-access mode where it has no auto mode. Only an
  unset mode or one that asks for approval or only reads is changed: an auto or full-access
  mode, Claude Code's `dontAsk` (it refuses what is not pre-approved rather than asking), a mode
  set in the same edit, and every mode of a runtime with neither (OpenCode) are kept. The
  Control Plane applies it on every edit that switches the mode on, from the console or the
  API. It is a default, never an admission check: an editor may change the mode afterwards and
  the choice sticks while the mode stays on. While it is on, an agent whose mode asks every time
  gets a warning: its tasks will wait for approval often.
- The console's form for a new agent preselects the same mode from the same per-runtime map,
  narrowed to the modes the runtime reports, whether or not the agent will ever be switched on: an
  agent that runs work nobody watches should not wait on approval by default. A runtime with
  neither keeps the form's old preselection, the creator may still pick an asking mode, and an
  agent created through the API or MCP without a mode keeps the runtime's default.
- The map covers every runtime that reports a mode whose own description says it decides by the
  runtime's review or classifier (auto) or never asks (full access); the form's pick per runtime
  is listed in product-conventions.md, "A new agent's permission mode". A mode whose description
  leaves approvals open, such as one that runs tools "based on configured permissions", or that
  refuses rather than asks, like `dontAsk`, stays out of the map. Only an admitted runtime (§4.1)
  reaches the switch-on default above, so the map's other runtimes change only the form.
- Switching it on changes no conversation's trigger, and new conversations start as any agent's
  of the same visibility do (§5.3). A place is _internal_ unless the platform detects it as
  _external_ (§5.3).
- It acts with the agent's own identity and permissions, never someone's personal account.

### 1.9 When it joins a place

Partly shipped (§5.13 "As shipped"): the first look runs and reports, and its offers are lines in
the introduction until the cards below come.

- **It takes a first look.** Added to a channel or group chat, it reads that place once: the last
  30 days or 500 messages, whichever is less, and nothing else. It remembers how the place works:
  what it is for, who decides what as people there say it, how requests are made, what recurs. It
  does not remember what is in flight, or anything about a person beyond their role there.
- **It introduces itself once**: who it is, one line on what it saw, how to reach it. Under that
  it offers at most three concrete ways to help, each resting on what people there said, or none.
  On Slack each offer is a card anyone who could ask it there may approve; elsewhere it is a line to
  answer. It asks at most one question, then posts nothing more on its own.
- **Nothing is taken without a yes.** Something someone is visibly waiting on may be offered as a
  follow-up; a regular rhythm may be offered as a timed check of the place.
- **Only new places, by itself.** Places it was already in when assistant mode was switched on
  get a first look only when someone there asks ("take a first look"), so switching the mode on
  posts nothing in old channels. Never in a 1:1 DM, not yet in a place shared with another
  organization, and only where the platform lets a bot read history (Slack, Discord, Lark/Feishu;
  not Telegram).
- What it read and reported is on the first look's task page, for whoever may see that place.

---

## 2. Prior art

| Reference                                                               | Taken                                                                                                                                                                                                                                                                                                                                                             | Not taken                                                                                                 |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Hosted always-on personal and coworker agents (two launched in 2026-09) | Goals outlive conversations; the agent wakes itself; proactive research is read-only; it speaks only when needed; **rules first, free rein on its own computer, consequential actions brought back for approval, waiting without a deadline**; stopping the main task does not stop delegated work; each task in its own environment                              | The personal form (acting as a user with that user's accounts)                                            |
| An open-source personal-agent template                                  | The approval record: hash-bound, expiring, `outcome_unknown` never retried; idempotent notifications; failure backoff and auto-pause                                                                                                                                                                                                                              | Rule-based idea generation; a task model that re-runs from scratch each time                              |
| An open-source coworker-agent template                                  | Scheduled turns run in the original conversation; interruption waits for human review before retry                                                                                                                                                                                                                                                                | One task at a time globally                                                                               |
| A durable agent-harness library                                         | The shape of background sub-agents: own conversation, anchored outside the parent's abort, replies delivered back as follow-ups, request ids on every delivery and report; sub-agents cannot spawn sub-agents                                                                                                                                                     | Using it as a runtime                                                                                     |
| A commercial AI coworker for team chat                                  | **Access scoped per person, enforced at recall**; DM content cannot be asked out of it; shared-channel replies drafted in a DM and posted after approval; approval cards lead with a sentence and offer "always allow"; whether an action needs approval is configured per action, never judged by the model; stopping the main task does not stop scheduled ones | One session per thread plus memory retrieval                                                              |
| An open-source self-hosted multi-agent assistant                        | Read-only as a per-session tool filter; self-scheduled tasks in two tiers (push text without a model / run a turn); push cadence with active hours, random intervals and a dedup record; background replies only raise an unread badge                                                                                                                            | No distinction between senders in an IM; a per-thread persisted "allow all" bypass                        |
| A team-chat AI coworker trialed in 2026-08                              | Onboarding researched first and reported back; a twice-daily alert watch that spoke only when needed, with one concrete ask and no repeat if ignored (§5.13)                                                                                                                                                                                                      | A quota-based outreach job (up to five DMs and one channel post per run), which the team stopped as noise |
| A coding agent's project coordinator (2026-10)                          | On a user's first project it may take a turn of its own: a read-only exploration plus setup suggestions, and suggested threads started with one click (§5.13)                                                                                                                                                                                                     | Suggestions to one person: in a shared place they are offered to the place                                |

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
| Stopping                        | `!stop` interrupts the session's current turn, does not cascade, does not mute under `append`; senders are any non-bot member of an enabled place. Agent pause (#288) interrupts every session and **drops queued messages**; nothing is replayed on resume. ACP cancels whole turns only; runtime-started background processes cannot be stopped                                                                                                                                                                                                                            |
| Concurrency                     | Sessions sharing a workspace are **not serialized** (`admitActiveDispatch` waits on workspace mutations only); turns from several channels already run in parallel in one directory                                                                                                                                                                                                                                                                                                                                                                                          |
| Deadline wake                   | Removed with the orchestration tools (#2979); a follow-up's `nextCheck` falls due on the check sweep, once a minute                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
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

| Dimension         | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                   | Why                                                                                                                                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime           | On the **admission list**: native cross-session memory can be disabled; a session resumes by id after a runtime restart. **No genuine read-only mode required**: the patrol guarantee is stated by layer in §5.9, and a runtime without one shows as degraded                                                                                                                                                                                 | Memory bypass, long sessions and resuming tasks after approval depend on it. Registering strict read-only semantics would lock most runtimes out                                                                       |
| Memory            | `managed`, kept in the Control Plane (`home: control-plane`). Turning the mode on moves a `daemon` home in the same write, and the owning daemon copies the tree, one way. While the mode is on, a `daemon` home, the forced return and any other provider are refused; turning it off moves nothing back. Per-turn distillation (`autoDistill`) recommended off; if on, the trade-off in [memory-dreaming.md](memory-dreaming.md) §8 applies | The person layer exists for managed memory only; person and place memory must be readable and clearable in the console with no daemon online, and must survive a move. Distillation runs on the credentialed warm host |
| Self-hosted group | Every member shares the store (the CP verifies store ids); single daemons unaffected                                                                                                                                                                                                                                                                                                                                                          | Otherwise the ledger, approvals and pending reports stay on the old member after a handover                                                                                                                            |
| Executors         | Assistant-mode sessions never spread to remote executors                                                                                                                                                                                                                                                                                                                                                                                      | Not possible today either                                                                                                                                                                                              |
| One per place     | One assistant-mode agent per place (`transportScope` + channel)                                                                                                                                                                                                                                                                                                                                                                               | With two, who speaks and where reports go has no good answer                                                                                                                                                           |

The admission list holds Claude Code (`claude-acp`, and `claude`, its earlier id), Codex (`codex-acp`,
and `codex`) and OpenCode (`opencode`). A runtime joins it once both facts hold for the version the
product runs: its memory is off by a verified switch or it keeps none, and a new runtime process
resumes a session from `session/load` with the earlier turns in the next model request, not merely
an answered call (the thirty-ninth revision records the check for Codex and OpenCode).

Keeping memory in the Control Plane has three accepted costs. A self-hosted daemon on a hosted
Control Plane keeps its person and place layers there. While the Control Plane is unreachable,
memory is unavailable: there is no local cache. And the move is one way. The Control Plane's boot
pass moves every assistant-mode agent that still has a `daemon` home, as it does for agents on a
member set ([memory-evolution.md](memory-evolution.md) §3.2.1).

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
    /** Follow-up check cadence (not read yet); absent ⇒ each follow-up's own next check only */
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
a draft, a proposal or a task's permission request (the asker, a schedule's creator or
editor, a follow-up's asker and a delegated task's opener always come first): the agent's creator while they are a
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
the context with the standing list and summary as a handover note) is an open question (§9).

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
approves as an internal member is asked of the platform, person by person (§5.5 "Drafts").

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
  a task's permission card, a check's proposal card — the daemon asks the platform whether
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
  its own: the standing list of follow-ups is not injected there (§5.4 ②). Its replies, its other
  writes there and its turns are what any agent's are.
- Telegram groups, Discord channels, Feishu groups: no detection; such a place is internal.
- DM: never external; what it is told is judged by its one person (§5.5). Webchat is internal by
  construction.
- A delegated task's place is its owning session's: one delegated in an external place reports through
  that place's main session, which answers there like any other turn.
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

① and ② are follow-ups, a kind of task (§5.12), which replaced the item ledger and its standing
summary.

**① Follow-ups** (daemon store, the item ledger's tables, partitioned by agent, moving with duty):

```
{ id, taskKey, title, doneWhen, nextCheck, status: active | waiting | done | dropped,
  origin: place, asker, shared, summary, observations: [...], version }
```

- `taskKey` is the follow-up's own session key, its `taskId`; `asker` is the person who confirmed
  it; `shared` says its place is a public channel, judged when it is taken and at every check.
- Observations are what checks saw, the latest handed to every check; they are bound by standing
  instructions: no quotes, source content framed as untrusted data.
- Follow-ups do not pass through the shared-memory exclusion gate — they are their own store, not
  agent memory.
- Concurrency: field-level merge (append observations); a check's schedule and a stop write
  without a version handshake, and an ended follow-up is never reopened.

**② The standing list**: label, the place it belongs to, and its next check (or that it waits) of
the open follow-ups a place may see: its own, each with its `taskId`, and every public channel's;
a private channel's, a group DM's and a DM's only there (§5.12). Capped at 30 and injected through
the existing reminder path (`shouldRemind`, which already handles first turn, restart and
compaction). When a place may see none, a session that may still hold an earlier list is told so
once at those points, after a restart too; a fresh context is not. Incremental injection
(`lastInjectedVersion`) is not in P0. An external place (§5.3)
receives none, tasks delegated there included: follow-ups are internal, and nobody there asked for
them. `followUp` still answers there when someone asks (#2979, B4).
Every session that can delegate tasks, in assistant mode or not, is also told which of its
delegated tasks are running now, each by its `taskId` and label, at most 10 and then a count. The block is
omitted when none runs. It rides the same points and is re-injected on the next turn after one starts or
ends, so the list the model holds stays current (§5.8); after the last one ends, that turn says
none is running. It is kept in an external place: it names only work that conversation itself
delegated.

**③ The recall tool** `recall({ place, query })`: reads this agent's transcript excerpts from
another place, under §5.5. Every agent has it, in assistant mode or not: the read rule it passes
is every agent's, so it is offered wherever an assistant-mode agent's sessions offer it, with the
same parameters and description. Without `place` it lists the conversations the asker may recall
from here: public ones, and in the asker's own DM or webchat conversation also their other DMs and
webchat conversations (§5.5 "Reads", the listing).

**④ The people's local time** is no longer assistant mode's own: every agent's turns carry it,
by the order in [product conventions](../product-conventions.md#local-time). In assistant mode it
still rides every turn — main conversations, delegated tasks, follow-up checks, approved proposals and report rounds — as
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
> external place from elsewhere is a draft an internal member approves (below). Follow-up and report
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
² The standing list of follow-ups is not injected there (§5.4 ②), and its approvals go to an internal
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
  summary there (§5.4 ②), since follow-ups are internal.
- A reply drafted before the change stays approvable and posts unchanged in its original thread.

**Drafts:**

- A post that needs approval goes as a card to an internal member's DM: the asker when the asker
  is an internal member (on Slack, a full member of the installing workspace — not a guest, not
  from the other organization), otherwise the responsible user (§5.1); with neither reachable it
  waits in Activity. **Approve** posts the text unchanged where it was aimed; **discard** drops it.
- **Whether the asker is internal is the platform's answer, for every agent.** Every asker is
  looked up, in any place and in either mode: no place vouches for the people in it, known external
  or not (§5.3). A card surface must answer the question (`isFullMember` is required of it, and
  Slack's is the only one today), so on a platform with no card surface an asker never approves,
  in either mode. The lookup is the member-join one of §5.3, one per person a minute and at most
  four at once, and a draft makes at most one. A lookup that fails takes the asker as not internal;
  what follows is unchanged: an assistant-mode agent goes on to the responsible user or Activity,
  and any other agent refuses the post. A member of another workspace of the same Enterprise Grid
  organization is the same organization for detection (§5.3) but not a full member of the
  installing workspace, so they do not approve. A console asker is routed to the member they
  linked, as before.
- A draft is an approval record (§5.10) whose action is "post this text to this place"; the
  daemon executes it itself, with no task. It expires after 24 hours.
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
  person's access no longer refuses posts elsewhere, follow-ups or agent-to-agent sends until
  `!new`: posts follow the rule above, a follow-up stays in its own place, and
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
  continuation; a delegated task's opener (kept in memory, so a restart reads it as no one); a follow-up's
  check's or an approved proposal's asker (the person who confirmed the follow-up, and for a check a
  message started also everyone behind that message); a schedule's last human editor, else its
  creator (`CronUpsert.askerUserId`). Hook runs, report rounds, schedules that record no person and
  agent-to-agent messages are no one: the agent-to-agent frame carries no originating person and was
  not given one.
- **The answer** to a refusal is one opaque "I can't share that here"; a chat member with no linked
  console account is also told how linking opens reads across platforms and bots, on every refusal,
  so the hint never tells a closed place from a missing one. A read of a private source carries a
  `privateSource` note naming it, and the model is asked to mention the source in one short clause.
- **The listing.** `recall` without `place` lists the current conversation and, newest first and at
  most 30 entries in all, the public channels every asker may read (at most 40 described). In a
  person's own DM or webchat conversation it also lists that person's other DMs, on any platform and
  bot of the agent, and their webchat conversations:
  - _Only there._ Exactly one person asks, the current conversation is a DM or webchat conversation,
    and it is theirs by the rule a read of it from elsewhere passes, so a follow-up's check or approved proposal run in
    someone's DM for another person lists none. In a channel or group DM, or on a turn nobody or
    several people are behind, none is listed, since everyone present would read the titles. Group
    DMs and private channels are never listed.
  - _Whose._ The owner rule reads use: a DM is theirs when they are its person or their linked
    account on that bot is, a webchat conversation when they opened it. Another DM on the bot the
    asker speaks on is never a candidate, since a person has one DM per bot.
  - _Cost._ One `agent/read-access` ask, `ownerOnly`, names the candidates' recalled sessions, up to
    64 (the current conversation's first, then the ones the asker opened, then newest first), under
    feature `read-access-batch-v1`; the frame's cap was 8, so a CP without the feature is not asked
    and the listing is as before. Each candidate that ask says the asker owns then passes the read
    rule with the answer standing in for the console's: a webchat conversation needs nothing more,
    and a DM on another bot asks for the linked account on that bot (cached a minute per bot, as
    reads do) and its member listing. No candidate costs a Control Plane call of its own, and none
    is described through the platform.
  - _Labels._ Each entry carries its place id and a name the person knows: a DM's is
    `DM with <their display name> on <platform>`, a webchat conversation's its title.
- **Titles.** `place` resolves a webchat conversation by its exact title, ignoring case, when no
  other conversation has it, as before; when several do, it resolves the one that the same batched
  ask says is the asker's own, if exactly one is. A title that matches nothing, or several of theirs,
  gets the opaque refusal.
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

### 5.6 Tasks

**Every agent has delegated tasks**, in assistant mode or not
([send-message-guide.md](send-message-guide.md) §2.1, §8). A session delegates one with
`sendMessage` action `delegateTask` and only a `message`, gives it more work with
`messageTask {taskId}`, stops it with `stopTask {taskId}` (§5.8), and lists its tasks with
`listTasks`; a self-call without a channel is refused with the exact `delegateTask` call to make
instead. The session that delegated a task is its **owning session**. The coordinate, inheritance, no nesting, round
reports, failure report, permission routing, wait cap, stop and running block are described here
and in §5.7–§5.8. An agent with an assistant mode policy takes its `limits`; any other agent takes
the defaults (`maxConcurrentSubsessions` 3, `permissionWaitHours` 12), and there is no new
setting. Follow-ups (§5.12) and approved proposals (§5.10) are tasks too, of the conversation they
report to, but no session delegates them as a step. A follow-up is owned by its place and is
messaged and ended by `taskId` (§5.12); an approved proposal runs once, is not continued with
`messageTask` or stopped with `stopTask`, and stays assistant mode's. Delegated tasks, follow-ups
and approved proposals together are a session's **tasks**, the name the console and the limits
that count all of them use.

**P0b shipped the minimal form**: self-delegation as below, a failure report the daemon sends
when a task ends without reporting (§5.7), and a concurrency cap that refuses beyond
`maxConcurrentSubsessions` (default 3). A delegated task answers its owning session's messages with
`replyToSession` by message id, any number of times, and the daemon reports the end of each round
of work. The persistent outbox, the recovery order, the daily budget and queueing
over the cap are deferred until use shows they are needed; the rest of this section and §5.7
describe that target. Permission-request routing and its wait cap (items 2 and 3 below) have
shipped, and so have steering with `messageTask`, stopping with `stopTask` (§5.8) and listing
with `listTasks`.

- **Opening**: `delegateTask` builds a trusted self-delegation from the caller's identity (both
  admission checks exempt it; `targetSessionCoordinate` is skipped), and the task gets **its own
  coordinate**: a reserved `subsession:` thread segment minted per delegation, on which every turn
  runs headless and which the Control Plane also recognises. It inherits the owning session's
  visibility and owner through the A2A path; **visibility changes on tasks are
  refused** (a channel conversation's owner is its first poster).
- **Workspace**: no dedicated workspace and no change to isolation. Under session isolation each
  session has its own worktree; otherwise (git shared, scratch) tasks share the primary like
  every other session of the agent — turns from several channels already run in parallel there
  today.
- **Relation to the owning session**: only the owning session messages a delegated task and
  stops it, on any of its turns; a delegated task cannot delegate, message or stop tasks. Ownership is the **persistent
  parent–child index** (`childSessionLinks` was in memory). A task outlives one round of work, and
  a later `messageTask` gives it new work in its retained context. Listing is the running block of
  the standing summary (§5.4) and `listTasks`, which also lists the place's follow-ups, to its
  current long session, and the approved proposals that report to the session.
- **Runtime permission requests** (far more common than `propose`):
  1. Standing prompt: finish the work in the workspace; the outward step (push, open the PR) goes
     through `propose`.
  2. When one fires it is delivered to the place of origin (an external place's to the approver's
     DM, §5.5) as a card through the existing two approval paths and listed in Activity; the card
     offers "always allow this tool". **Shipped**, for delegated tasks and approved proposals (a follow-up's
     check still refuses, §5.9), as the one pending request every surface settles (slack-approval-dm.md
     §11): a Slack, Telegram, Discord, Feishu/Lark or Google Chat place gets the in-chat card where `chatActions` (`approve` or above) lets people
     there answer (only editors where permissions are synced), otherwise a neutral notice plus the editor DM, the notice rewritten in place to how
     the request settled; the card names the task (its title, else the work it was
     given), links it and says how long it waits. It goes to the owning session's own thread, or to the conversation's
     root for an `append` conversation, where reports land too. A webchat place has the console:
     the request carries its conversation (`parentSessionId`), whose page lists it among its own.
     An external place's card goes to the responsible user's DM (a click is verified like any
     approval DM), for every agent, since the Control Plane derives that person whatever the mode,
     else an editor's DM as for any other request; Activity lists it either way. Approval
     elicitations take the notice and editor path, since a chat card for them needs a live turn's
     surface.
  3. **Waiting is waiting**: the ACP request stays open and the turn is not cancelled — the card
     and both approval paths are bound to that pending request; cancelling it expires the card,
     and a later "continue" grants nothing to the re-triggered request. Host and concurrency slot
     stay occupied (the slot bounds occupied hosts anyway); Activity shows "awaiting approval".
     `permissionWaitHours` (default 12) caps the wait: then deny, report, and the work stops; a
     delegated task continued with `messageTask` asks again. Cost: on the pool a waiting task
     holds a pod. If that becomes a cost problem, P1 may add "cancel the turn plus a cross-turn
     one-shot grant". **Shipped**: the record is denied with "no answer within N hours" and its
     cards rewritten; the stop is latched (`approval wait expired`) before the runtime is answered
     `cancelled`, so the turn ends stopped and the existing failure report tells the owning
     session. The
     timer lives in memory: a restart ends the turn, the store expires every request no process
     holds a resolver for, a stale card's click or console decision finds nothing pending, and the
     card's and the notice's handles on the row let the reconnect sweep retire them.
  4. Switching assistant mode on moves an asking mode to the runtime's auto mode, else its
     full-access mode (§1.8), so requests come only from what that mode still escalates or from
     an asking mode an editor picks afterwards (asking every time gets the warning in §1.8).
     Nothing else changes the permission mode: an agent outside assistant mode keeps its own, so
     its tasks ask as often as that mode does.
- **Webchat**: the Delegated group of the session-detail dock's Tasks tab (#2885) lists a
  conversation's tasks (follow-ups and approved proposals included) and stops a running one; who may
  stop is whoever may continue that session today. The tab's This turn group shows, read-only,
  what the runtime reports for the current turn. A task's own page is read-only (#2893), with a
  header naming the session it belongs to and a link back: talking to one directly is deferred.
- **What stopping guarantees**: the current turn; a background process the runtime started may
  keep running; the adapter is never killed.
- **Limits**: no delegated tasks of tasks; at most `maxConcurrentSubsessions` running (P0b
  refuses beyond it; the target queues the rest persistently with the asker told);
  `dailySubsessionsPerItem` per item per day (§5.7's loop bound, deferred).

### 5.7 The report channel

> **Tasks never speak on the platform.** Delegated-task reports, patrol results,
> permission requests and notifications are each one report injected into the target place's main
> session, which speaks for them.

The daemon reports the end of each round of a delegated task itself: `[task finished]` with the round's
last output, or `[task ended]` after an error, `!stop`, pause or the stall watchdog, never two.
A follow-up's check reports only what it found (§5.12), and its failures are counted on the
follow-up (§5.9). An approved proposal keeps its own one report; when it ends without it, the
daemon sends one short failure report, headed `[approved proposal ended]`, instead. An
interruption that will be replayed sends none. When that replay never runs
the turn — a same-process replay finds its message already carried by the prompt that was cut, or a
purge drops the kept delivery — no turn end reports it, and its `open` row would hold a slot under
the cap for good. So the minute sweep reports it ended, as no longer running, once it has seen
nothing run for it for ten minutes: no live or queued turn, no delivery left in the inbox, no
process the runtime started in the background owing it a wake, and the agent not paused. An approved
proposal is left to its own recovery (§5.10). The report waits on the task's index row as `reporting`
until it
is admitted: a refused admission is retried on the minute sweep, three attempts in all, a drain or
restart leaves it to be re-sent on the next start, and a fixed delivery id with the inbox's
receipt keeps a re-send from arriving twice. Like patrol and approved-proposal reports, it goes to
the current session of the owning session's place (after `!new`, the new conversation), else the
recorded owning session. Every report the daemon sends ends by telling that session to answer its
people in their language, since its framing is English; patrols and approved proposals are asked to
write their report in it, and an owning session tells its delegated task which it is. The outbox below is
the deferred target.

Implemented as a **persistent per-place outbox** (agent-owned, CAS-claimed, duty-gated, re-armed
on `agentsGained`):

- **Merged per place**: however many rows are pending for a place, one "report round" carries
  them all (capped; the rest wait for the next round), sidestepping the 10-row session queue.
- **Ack on round completion**; **`!stop` acks the current batch** (suppressed, never returns);
  a retry cap per row, beyond which the row goes to a dead letter and the responsible user is
  told. At-least-once is accepted; the prompt carries row ids.
- **Delivery id** derived from source session + the delivery that woke it + target place +
  sequence number.
- **Structured fields only across places**: `itemId`, event type, a one-line conclusion already
  present in the team-visible summary. A task's own text goes only to its place of birth.
  Event types include `handoff` (P1) and `permission`.
- **Failure is reported too**: a task that fails, is fenced or times out gets an outbox
  row written by the daemon.
- **Report rounds are admitted as human messages**, hop reset; the loop bound moves to a chain
  depth carried on the outbox row and the per-item daily task budget.
- **Anti-nag**: the idempotency key `(agentId, itemId, status, observation version)` doubles as
  the delivery dedup key.
- **Handover versus failure**: an interruption whose reason is `shutdown` or `superseded`
  (**not `pause`**, which drops queued messages and replays nothing) is recovered per session
  kind, in order:
  1. **Approved proposals first, outside generic recovery**: an interrupted approved proposal of
     an `executing` record marks the record `outcome_unknown` and its inbox row is excluded from
     replay. Moving the proposal to `executing`, recording the approved proposal's session id and
     writing the marked inbox row happen **in one transaction**.
  2. **Follow-up checks** re-enter silently.
  3. **Delegated tasks** follow today's handover replay; the re-entry prompt says "re-run
     after an interruption, verify the current state first", and the item gets an observation.
  4. **Report rounds** are re-delivered.
- Cost: every report round is one long-context turn of the main session; merged delivery and
  "silence when nothing happened" are the main controls.

### 5.8 Stopping

| Action                                        | Effect                                                                                                              | Who                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| "Stop" in the main conversation               | Interrupts that conversation's current turn only                                                                    | today's `!stop` rules                                                                                              |
| Stop one piece of work (named, or in webchat) | Interrupts that work's current turn                                                                                 | a named delegated task: its owning session, on any of its turns / whoever may continue that session in the console |
| **Pause the agent** (existing #288)           | Interrupts every session and blocks new turns (today); assistant mode also suspends follow-up checks and the outbox | existing pause permission                                                                                          |

**Stopping a named delegated task** is the `stopTask` tool, given the task's `taskId`
([send-message-guide.md](send-message-guide.md) §8.7). Every session that can delegate a task is
offered it, in assistant mode or not, hook runs, scheduled runs and peer sessions included: never
a delegated task, a follow-up's check or an approved proposal. It stops only a delegated task whose owning
session in the persistent index is the calling session, on any of that session's turns: one a
person started, a delegated task's report, another agent's reply, a reminder or a scheduled run. Deciding that a step is no longer
needed is the owning session's planning, so the `!stop` sender rule does not gate it; a person
who wants a task stopped asks that session. It also ends a follow-up of the calling session's place when that session is the place's current
long session (§5.12). Any other id (the task itself, a sibling, the session
after `!new`, another agent's, an approved proposal, an unknown or purged one) is refused
with the same words, so nothing about another conversation is revealed. The stop itself is the
console's Stop: the same daemon core, logged with the person whose message started the live turn,
else the agent. So it answers the same way: stopped, or not running, adding that a background
process the runtime started may keep running. A later `messageTask` can give a stopped task new
work. Stopping one's own task moves no content, so a session marked by a private read (§5.5) may
still do it. The tool's description tells the agent to ask which task the person means only when
that is not clear; a clear request is carried out at once. Approved proposals are stopped from the
console, in the session's Tasks tab.

No new "stop everything". The sender rules for `!stop`, `!new` and pause are **unchanged and not
narrowed** — effects at this level cannot be defended against, and the design does not pretend
to. Resume: no catch-up; follow-ups whose `nextCheck` passed are each checked once;
stopped tasks do not restart. Stopping never undoes completed effects.

### 5.9 Patrol (P1)

An item's patrols became the checks of a follow-up (§5.12); wake, limits and recovery are as
below. A check reports only to the follow-up's place, so where the target below says "patrol" read
a check, and "each follower's place" becomes that place.

**P1 ships a minimal check first**, ahead of the target below:

- **Wake**: a follow-up's `nextCheck` wakes a check — a duty-gated sweep on the daemon, once per
  `nextCheck` value; pause suspends it and an overdue follow-up is checked once. Its place's
  `messageTask` starts one at once (§5.12). `patrolSchedule`, hook events and triage come later.
- **Where it runs**: a read-only task on the **agent's own host**, with the agent's
  credentials, until the credential-less host exists, in the follow-up's one retained session.
  Read-only rests on layers (a) and (c) below: AgentConnect tools filtered to reads plus
  `recordCheck` and `propose`, and the runtime's read-only mode with a daemon policy that refuses
  anything needing approval. Layer (b) is missing, so the residual is that of a degraded runtime
  plus the agent's own credentials on the host.
- **Outcomes**: a report, a `propose` (§5.10), or silence; the check records an observation
  either way, and a check that records nothing counts as a failure. The report goes to the
  follow-up's **place** through the existing parent-report path into that place's long session,
  which speaks.
- **Limits**: one scheduled check at a time per agent, outside the user's
  `maxConcurrentSubsessions`; a messaged check starts at once. `dailyPatrolBudget` counts every
  check, messaged ones included; after a failure the next attempt backs off by `min(60, 2ⁿ)`
  minutes and five consecutive failures stop that follow-up's checks with one report until it is
  messaged. A check's next check must be at least five minutes ahead; `dailyPatrolBudget` defaults
  to 50.
- **Recovery**: a check replayed after a restart or handover settles from state stored with the
  running check (its observation baseline and any held report), so an empty replay still counts
  as a failure. A check's reports are admitted before it settles, each under a stable id the inbox
  deduplicates, so a check whose turn ended before it settled is settled on the next replay without
  a second report. Stopping a follow-up from the dock's Tasks tab or with `stopTask` ends it; a
  running check ends silently with its check done.

Shipped in #2887 as patrols, `propose` from them in #2895, and as follow-up checks with §5.12. The
rest of this section is the target.

```
patrolSchedule fires / hook event (P2) / an item's nextCheck is due
        │
        ▼
  [optional, P2] Decision triage with a small model
        │
        ▼
  Patrol: a headless read-only task on a **credential-less host**
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
- **Wake on time**: an item's `nextCheck` falls due on the patrol's minute sweep.
- **Two tiers of self-scheduling**: `remind` (deliver text at a time, no model turn) and
  `patrol`. `remind` ships first, to every agent's sessions that have a platform conversation
  of their own, in assistant mode or not; `patrol` stays assistant mode's:
  - `remind({ at, message })` keeps `message` verbatim for `at`, an ISO-8601 instant with an offset,
    in the future and at most 366 days ahead; the text is non-empty and at most 40,000 characters.
    `listReminders` and `cancelReminder` reach only the current conversation's pending reminders.
    Only an agent in assistant mode is told, in `remind`'s description, to take an item with a
    next check instead for something to be checked on at a time; the descriptions are otherwise
    the same.
  - It lands only where the setting session's replies land, that conversation and thread; there is
    no target argument. It is refused in delegated tasks, patrols and approved proposals, and in webchat, which has no
    daemon-side post path without a turn. An external place sets and receives reminders like any
    other (#2979, B4).
  - The duty holder's sweep, on the patrol cadence, claims a due reminder atomically and posts it
    through the executed-draft post path as the agent: no ACP, no turn. A claim cut short by a
    restart or handover fails and is never posted again, so delivery is at most once. A platform
    error is retried on later sweeps, three attempts in all, then fails with a warning; a send
    that timed out or came back without a message id may or may not have posted, so it fails at
    once. Each sweep first asks the store once which of its agents have a reminder due or a claim
    cut short, and works only on those, so an agent with nothing due costs no query of its own.
  - While the agent is paused nothing is delivered; afterwards a reminder less than 24 hours late
    posts late and an older one expires. Switching assistant mode off or on changes nothing: a
    pending reminder stays and posts at its time. An agent holds at most 100 pending reminders, a
    fixed limit with no setting. Settled rows stay, like the other assistant tables' settled rows,
    until the agent is removed.
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
  by the place's live admission and trigger; never a bot. Approving runs the approved proposal with the
  agent's own permissions, which is what asking there gets, so it grants nothing more. For an external
  place, the internal member of §5.5; editors always, in Activity. A draft's approvers stay as
  §5.5 says. `chatActions` is not read: it guards runtime approval controls and runtime-setting
  changes in chat, a different decision. Cards exist on Slack only; other platforms use
  the console.
- Approval ⇒ CAS to `executing`, record the approved proposal's session id and write the marked
  inbox row in one transaction ⇒ start the approved proposal's run with normal permissions.
- An uncertain outcome ⇒ `outcome_unknown`, never retried automatically; on restart or handover
  see §5.7 step 1.
- The card reuses `OrganizationSuggestion`'s component, not its review route.

**P1 ships `propose` for patrols only** (#2895): `propose({ sentence, why, task })`, at most once
per patrol run; an approved proposal runs as a task with the agent's own permission mode in
the item's origin place, counted against `maxConcurrentSubsessions` (a full cap refuses the
approval and the proposal stays awaiting review). It departs from the record above in four
places:

1. **Expiry is 24 hours**, as for drafts — a patrol often runs overnight, so 30 minutes would
   expire nearly every proposal.
2. **The inbox row is not written in the approval transaction**: the transaction holds the state
   change, the approved proposal's session key and its index row; its reserved `subsession:task-`
   coordinate keeps its row out of generic replay, and a recovery sweep catches a crash before the
   row exists.
3. **The item version is in the hash but does not cancel an approval**: a later update to the
   item would otherwise void every proposal; a closed or deleted item is still refused, and the
   approved proposal's prompt shows both versions and says to check the current state first.
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

A cut execution settles from the approved proposal's durable end: reported ⇒ `succeeded`, failure report
already sent ⇒ `failed`, otherwise `outcome_unknown` with one "please check" report.

With follow-ups (§5.12), a proposal comes from a check and points at its follow-up instead of an
item, at most once per check; nothing else here changes.

### 5.11 Activity

The console's agent page gains an Activity view: items, scheduled wakes, running tasks,
recent patrols, pending cards — all derived from the ledger, the approval records, the outbox and
session records, read from the daemon through the BFF proxy. A background report into a webchat
conversation only raises an unread badge.

The first version (#2876) shows what exists today, for assistant-mode agents only, read and
changed through the daemon without anything persisted on the Control Plane. A daemon that
advertises `activity-every-agent-v1` answers the same read for an agent outside assistant mode:
its tasks' pending permission requests, its tasks and its drafts, with no
follow-ups and no proposals. It also stops such an agent's tasks and
decides its
drafts from the console, and refuses an item delete or a proposal decision (`assistant-mode-off`);
an older daemon refuses every request for such an agent:

| Section        | Who sees it                                                                                                                                                                                                                                              | Who may change it                                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Tasks          | anyone who can view the agent sees state and start time, and a follow-up's status and next check; the title, the session link, the conversation that opened it and a follow-up's done-when and recent checks only where the viewer may open that session | whoever may continue a task's session stops it; Stop ends a follow-up                                                        |
| Pending drafts | editors                                                                                                                                                                                                                                                  | editors approve or discard (#2880) — the same decision path as the card, so a card click and a console decision execute once |

A daemon that advertises `follow-up-tasks-v1` keeps follow-ups instead of items: its task list
carries each follow-up's kind, status (waiting, checking, paused, done or stopped), next check and
recent checks, and its item routes are refused (§5.12). A daemon without it still has the Items
section, whose editors delete an item. A console
decision that cannot be confirmed keeps its row and tells the editor to check the destination
(#2881). Tasks' runtime permission requests are listed under pending drafts
for editors (§5.6): the task and conversation where the viewer may open them, the tool, the
wait's deadline and the request's own options, answered through the approval queue's decision so
the first answer from any surface wins. The unread badge is not in it yet.

Every agent has tasks, drafts and its tasks' permission requests, so every
agent has those sections, and the Delegated group of the session dock's Tasks tab, once its serving daemon advertises
`activity-every-agent-v1`. Follow-ups, items and proposals stay assistant mode's: the Control Plane refuses
those routes with `ASSISTANT_MODE_OFF` for any other agent and asks its daemon for drafts without
proposals. Who sees, stops and decides what is unchanged. Toward a daemon without the feature an
agent outside assistant mode is refused as before, before any daemon I/O, and the console shows
it no Delegated group.

### 5.12 Follow-ups: the ledger and patrols become one kind of task

**Status:** Shipped (2026-10-16) in the daemon, the protocol and the Control Plane, with the
console's follow-up rows in the Tasks tab and Activity (#3055). §5.4 ①②, §5.9 and §5.11 describe
follow-ups now. How it shipped is under "As shipped" at the end of this section.

**Why.** An item and its patrol are already a task in all but name: a patrol is a read-only run
on the `subsession:` coordinate that reports to the conversation the item was taken in (§5.6). Yet
the agent keeps a second list beside `listTasks`, a person cannot stop a patrol from chat, and the
ledger shows every place that a commitment exists, including one made in a DM. A **follow-up**
folds an item and its patrols into one task.

**What a follow-up is.** A task of the place it was taken in, beside delegated tasks and
approved proposals, so a session's tasks are its delegated tasks, its follow-ups and its approved
proposals.

- **Read-only.** Every round is what a patrol is today: the read profile and layers of §5.9, on
  the agent's own host, marked degraded where §5.9 says so.
- **Woken by time.** A round starts when the follow-up's next check falls due. It ends by
  recording what it saw and, unless the follow-up is done, when to look again.
- **Retained.** Rounds run in the follow-up's own retained context, as a delegated task's rounds
  do (§5.6), so what it saw last time is in its context. The runtime's own compaction bounds that
  context. Whenever the context is reopened (lost on a restart, or reopened by the daemon), the
  stored last observation is the handover, so recovery needs it too. Whether to reopen after a
  fixed number of checks is §9 Q6.
- **Owned by its place.** A follow-up belongs to the place it was taken in, not to one session
  row. Its owning session is that place's current long session: after `!new` or a rollover, the
  new one. That session lists it with `listTasks`, gives it new instructions with `messageTask`
  and ends it with `stopTask`. Its reports already go there (§5.7).
  - This departs from delegated tasks on purpose. A delegated task is bounded by one piece of
    work, so §5.8 refuses the session after `!new`. A follow-up is a commitment that lives for
    weeks, and `!new` is routine, so a session-bound follow-up would soon be unaddressable from
    chat.
  - A session of the agent in any other place still cannot address it.
- **Addressable by `taskId`.**
  - `stopTask` ends the follow-up, not just one check.
  - `messageTask` gives it new instructions and runs a check at once, counted against the daily
    budget. While a check runs, the message waits for the next input, as a delegated task's does;
    with the day's budget spent, it is refused with the time the budget resets.
  - The `taskId` is for the agent's own calls alone. Every place that hands the agent a task's id
    tells it never to show the id to people, who know a task by its title or label.
- **Visible where its place is.** It inherits its conversation's visibility, as every task does.
  The organization-visible ledger goes away.
- **Its asker.** A check's asker for §5.5 "Reads" is the person who confirmed `followUp` (a
  migrated item's first follower). A check started by `messageTask` also counts the sender of the
  message that led to it, as every sender counts on a turn.

The word "patrol" leaves visible text; a round of a follow-up is a check.

**Tools.**

| Today                                                | With follow-ups                                                                        |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `takeItem { title, doneWhen, nextCheck?, summary? }` | `followUp` with the same parameters; returns the `taskId`                              |
| `listItems`                                          | `listTasks`                                                                            |
| `updateItem` in the main conversation                | `messageTask` to change what or when to check, `stopTask` to end it                    |
| `followItem`                                         | Removed: one follow-up belongs to one place                                            |
| a patrol's `updateItem`                              | `recordCheck { observation, report?, nextCheck?, done? }`, offered only inside a check |
| `propose`                                            | Unchanged, at most once per check                                                      |

- **`followUp`** keeps `takeItem`'s rules in its own description:
  - restate what will be watched, what counts as done and when to look next, and call it only after
    the person confirms;
  - check `listTasks` first, and when an open follow-up of this conversation already covers the
    request, offer `messageTask` to it instead of a second one.
  - It is a tool of its own, not a `delegateTask` option. A follow-up is a commitment to a person,
    which needs that confirmation, and it is read-only by construction, so nothing changes outside
    the workspace while nobody is around. `sendMessage` and its guide are unchanged.
- **`recordCheck`** replaces the patrol's restricted `updateItem` without the version handshake,
  since only the follow-up itself writes it.
  - `observation` is required; a check that records nothing counts as a failure, as today.
  - `report` reaches the owning session, which speaks; leaving it out is silence.
  - `nextCheck` must be at least five minutes ahead.
  - `done: true` ends the follow-up when its done-when holds. Without `nextCheck` or `done`, it
    waits with no scheduled check until it is messaged or stopped.

**Wake, limits and recovery** are the minimal patrol's (§5.9), unchanged:

- a duty-gated minute sweep, once per next-check value; pause suspends it, and an overdue check
  runs once;
- one check at a time per agent, outside `maxConcurrentSubsessions`; `dailyPatrolBudget`, which
  keeps its key, defaults to 50;
- backoff of `min(60, 2ⁿ)` minutes after a failure; five consecutive failures stop the follow-up's
  checks, with one report, until it is messaged;
- recovery settles from the stored observation baseline and held report, as today.

The target in §5.9 (scheduled and hook-woken checks, the credential-less host) applies to
follow-ups unchanged.

**The standing list** replaces §5.4 ②, keeping its injection points, its cap of 30 and its
absence from external places. It is keyed by place:

- one taken in a public channel is listed in every internal place;
- one taken in a private channel or group DM is listed only there;
- one taken in a DM is listed only there.

This derives from §5.5 "Reads" but is stricter for DMs. On a platform whose session access is not
synced, a DM is `org`-visible ([session-visibility.md](session-visibility.md) §3), yet its
follow-ups stay in that DM. Listing a DM's follow-ups in that person's webchat conversations too
needs the chat identity's console user on the injection path, which arrives with identity links
pushed to the daemon (§7, P1); until then they are not listed there.

Each entry has its label, the place it belongs to, its state and its next check. Only the owning
place also sees its `taskId`. The running-tasks block of §5.4 ② stays as it is.

**Console.**

- Follow-ups appear in the Delegated group of the session's Tasks tab and in Activity's tasks
  section, under the existing task visibility rules.
- They have a waiting state, "Waiting · next check <time>", and their page lists their checks:
  time, what was seen, and whether it was reported.
- Activity's Items section goes away; its editor delete becomes Stop.

**Migration** happens in one daemon store version, with no cross-version downgrade.

- Each active or waiting item becomes a follow-up of its origin place. It carries over its title,
  done-when, summary, latest observation and next check; its first follower becomes its asker.
- Followers other than the origin are dropped, and they are not told. Done and dropped items are
  not carried.
- A pending proposal keeps pointing at the follow-up its item became.
- A patrol in flight at the upgrade settles as that follow-up's check.
- A daemon that advertises `follow-up-tasks-v1` answers Activity without items, and the console
  shows the Items section only toward a daemon without it.

**Behaviour change.** A commitment made in a DM or a private place is no longer listed anywhere
else, and nobody but its own conversation is told of it.

**When it ships**, [send-message-guide.md](send-message-guide.md) changes with it:

- §2.1: follow-ups replace patrols in the list of task kinds, and they are messaged and stopped by
  `taskId`;
- §6's "ownership never spans a conversation", §8.2 and §8.7: a follow-up is owned by its place,
  so after `!new` or a rollover the place's new session may message, stop and list it, the one
  exception to the session-recreated refusal;
- §8.7: only approved proposals lack a `taskId`;
- the `listTasks` kinds: delegated task, follow-up, approved proposal.

`remind`'s pointer for assistant-mode agents says follow-up instead of item.

**As shipped.** Choices the text above leaves open:

- **Storage.** Follow-ups live in the item ledger's tables; a follow-up's id is its item id, so a
  pending proposal's `itemId` still names it. Its session key, `subsession:patrol-<id>` in its
  place, is minted when it is taken and is its `taskId`. Each check is a numbered row in a check
  log (`assistant_check`): start, end, what it saw or why it failed, and whether its report got
  through; the newest 50 are kept, and the daily budget counts its starts.
- **Ownership.** The follow-up's index row names its place's current long session, re-pointed
  whenever that session lists, messages or stops it, when the console lists that conversation's
  tasks, and when a check starts. Only that session addresses it; a thread session of the same
  place does not.
- **Reports.** A follow-up keeps the platform thread of the turn that took it (store version 54),
  and its reports reply there, else where its place's latest turn replied (`replyThread`), as a
  background task's wake does. `listTasks` says a follow-up handed back a result only when its
  latest check's report got through.
- **Messages.** `messageTask` starts a check at once, outside the one-scheduled-check slot. While a
  check of that follow-up runs, the message waits (at most 10), with the people behind it, and
  the next check, which starts as soon as the running one ends, takes every waiting message; a check
  released by a pause or failed short of the fifth failure puts its messages back. A message to an
  ended follow-up is refused; a new one is taken with `followUp`. A message past the budget is
  refused with the time its oldest check in the window turns 24 hours old.
- **Prompt.** Every check is handed the follow-up, its five latest observations and the messages
  it takes, so a reopened context loses nothing it needs; `recordCheck` is told to carry over any
  instruction a message gave.
- **Schedule.** `recordCheck` with `nextCheck` makes the follow-up active, with `done` done, with
  neither waiting; a follow-up taken without a next check starts waiting. A scheduled next check
  that a messaged check passes over stays due.
- **Standing list.** A place is judged public as its memory layer is: shared only for a channel its
  platform confirms public and internal. A migrated follow-up is listed only in its own place until
  its first check judges it.
- **Console.** Activity's task rows carry `kind`, and a follow-up's row its `followUp` fields with
  its own id; a console Stop ends the follow-up. One whose first check has not run has no session
  yet, so the console ends it by that id (`stop-follow-up`), under the rule of the conversation
  its row names, which the daemon checks the row still names. A task's own page reads its row by
  the task's session (`task`) and shows a follow-up's status, what counts as done and its recent
  checks. A daemon advertises both with `assistant-task-handle-v1`; toward an older one a row
  carries no id, so it cannot be stopped from the console before its first check, and the page
  shows only the session it belongs to.

### 5.13 First look

**Status:** Partly shipped (2026-10-16). What is marked _decided_ is the product owner's
(2026-10-16), who confirmed every recommendation below the same day. The first look itself and the
read ports' topic, description and message links have shipped; the `propose` changes ("Cards") and
pins have not. How the first look shipped is under "As shipped" at the end of this section.

**Why.** Added to a channel, an assistant-mode agent does nothing until someone @-mentions it, and
then knows nothing of how the place works. A first look reads the place once as the agent arrives,
remembers how it works, introduces the agent and offers at most three concrete ways to help. It is
the first part of the agent's proactivity: a timed check of the place is offered through it as a
follow-up (below), and waking on platform events is later work (§7).

**What runs** (_decided_).

- A read-only task of the place reads it and reports to the place's long session. The task cannot
  post, react or write memory.
- The long session then writes memory, posts the introduction and offers the suggestions.

**Where** (_decided_): channels and group chats only, never a 1:1 DM, which has nothing to read.
Three conditions are recommended below: the agent answers in the place (its row is not Off), the
place is internal, and its platform can read history.

**What it reads** (_decided_).

- Newest first, the last 30 days or 500 messages, whichever is less.
- The place's description, topic, pinned messages and bookmarks.
- Every top-level message, plus the replies of any thread with three or more replies or an
  unanswered question.
- It stops early once new messages stop changing the picture, and reads only this place.

The daemon holds it to the bounds, not the prompt alone. Its history reads go back no further than
30 days and return nothing past 500 messages in all. Its tools are the place's own reads (history,
thread replies, the conversation's details, members and profiles, reactions, bookmarks, pins and
attachments), memory reads and `recordCheck`. `recall`, search, other channels, knowledge and
code-host reads are not offered, and §5.5's read gate refuses any source but its own place.

**Outputs** (_decided_). Each goes somewhere different.

1. **Memory.** A topic file named after the place, plus one index line, written to the layer that
   conversation writes ([product conventions](../product-conventions.md#memory-layers)): an internal
   public channel writes the shared layer; a private channel, a group DM or an external place
   writes its place layer.
   - Only how the place works (its purpose; roles as people state them, never opinions of people;
     how requests are made; where decisions are recorded; links people keep using; other bots) and
     what recurs. Dated, with inferred items marked "(inferred)".
   - Never what is in flight, opinions of people, quotes beyond a short phrase, credentials,
     private links or personal details.
   - The shared layer is read in every conversation, those with outside guests included, so the
     file holds only what is fine to say in every conversation that reads that layer. There is no
     new memory layer for public channels.
2. **Report.** The whole report is the task's result: its check's report, on the task's own page,
   visible to whoever may see the place's conversation, as every task is (§5.6).
3. **Introduction and suggestions.**
   - One short introduction in the place: who it is, one line on what it saw, how to reach it.
   - Suggestions are `propose` cards in the thread under that introduction, not a DM to whoever
     added the agent, so who sees them is who sees the place.
   - At most three, each resting on two or more messages or on a request nobody took. None is a
     fine outcome: a threshold, never a quota.
   - At most one question, and only if the answer changes what it does. Then it stays quiet unless
     the place's trigger says otherwise.
   - Something in flight becomes a follow-up (§5.12) only if someone is visibly waiting on it, and
     only as an offer, never taken silently.

The first look's own session is excluded from memory capture, as a private session is, so neither
per-turn distillation nor a dream mines what it read: memory gets only what the long session
writes in step 1 of its handling. The report itself arrives as a report round of the long session,
which a dream of the shared layer mines as it mines every report round in such a channel.

**The prompts** (_decided_, adjusted where noted below). The task's prompt, in English as product
text:

```text
You are taking a first look at {place}, a {kind} you were just added to. Read it and report
back. You cannot post, react or change anything, and nothing you write here reaches the place.

Read, newest first, until you have the last {days} days or {maxMessages} messages, whichever
is less: the description, topic, pinned messages and bookmarks; every top-level message; the
replies of any thread with 3+ replies or an unanswered question. Stop early once new messages
stop changing your picture. Read only this place.

Answer in these sections, in the place's main language. Link every claim to the message it
rests on (its link, or its time where it has none), and mark anything inferred rather than
read as (inferred).

## How this place works
What it is for, in two sentences. Who owns or decides what, as people here say it: roles,
never opinions of people. How requests are made, where decisions are recorded, links people
keep using, other bots and what they post.

## Recurring
Things that happened at least twice on a rhythm, and when.

## In flight
Unanswered questions, commitments with a date, threads waiting on someone: owner, date, link.

## Where I could help
At most three; none is a fine answer. Each must rest on two or more messages or on a request
nobody took. Say what you would do first, whether it is one task or a check on a schedule, and
what you lack (a tool, an integration, access). Offer only what the place's conversation can
actually do with its tools: {tools}.

## Not covered
What you could not read or check.

Stay under 1,500 words. Quote no more than a short phrase, record nothing about a person
beyond their role here, and leave out credentials, private links and personal details.
Hand it back with recordCheck: a one-line observation, this answer as its report, and done
set. It is your only output.
```

The long session's handling arrives with the report, as a `[follow-up]` report's text does, never
in a tool description:

```text
When a first look reports back:
1. Write "How this place works" and "Recurring" to a topic file named after the place, dated,
   plus one index line. Leave out "In flight" and anything you would not say in every
   conversation that reads this layer.
2. Post one short introduction in the place: who you are, one line on what you saw, how to
   reach you ({reach}).
3. Under it, offer each "Where I could help" item with propose. Offer an "In flight" item as a
   follow-up only if someone is visibly waiting on it.
4. Ask at most one question, and only if the answer changes what you do. Then post nothing
   more on your own.
```

Changed from the agreed drafts, each to fit a verified fact:

- "Link every claim" adds "(its link, or its time where it has none)". History pages carry a link
  only where the platform can form one (below), and elsewhere a link the model made up would be
  worse than a time.
- "Offer only what your tools can actually do" names the place's tools, `{tools}`. The first look
  itself has only reads, so "your tools" would rule out everything.
- A last line hands the answer back with `recordCheck`, a check's only output (§5.12).
- A first look someone asked for in a place the agent was already in reads "a {kind} you are in"
  instead of "you were just added to".
- Step 2's "how to reach you" names the place's trigger, `{reach}` ("@-mention me", "I read every
  message"). A report round carries no mention to infer it from.
- Step 4's "Then stay quiet unless mentioned" becomes "Then post nothing more on your own". In a
  place whose trigger is every message people reach it without a mention, and the decided rule
  defers to the trigger.
- On a platform with no card surface, step 3 reads "In the same message, list each 'Where I could
  help' item in one line, and an 'In flight' item only if someone is visibly waiting on it; act on
  one when someone here asks for it."

**Machinery: a follow-up the daemon takes** (recommended). A first look is a follow-up of its place,
marked as a first look, that the daemon takes instead of `followUp` and that ends after one check.
It reuses the read-only check and its layers (§5.9), the one scheduled-check slot,
`dailyPatrolBudget`, backoff, recovery, the report path into the place's long session, and the
console's follow-up rows, labelled "First look", in the Tasks tab, Activity and its own page. A new
task kind would repeat all of that for a run that differs only in what the marker decides:

- **Who takes it.** The daemon, on a join or a request (below). `followUp`'s confirmation protects
  people from commitments made in their name; a first look commits to nothing and posts nothing.
- **Its asker.** The person who invited the bot where the platform names one, else the person who
  asked for it, else nobody. It reads only its own place, which every turn may read (§5.5), so the
  asker changes nothing it reads.
- **Its tools and prompt** are the ones above. It has no `propose`: the cards come from the long
  session.
- **Its one check** ends it as done. No next check is set, and `messageTask` is refused, as for any
  ended follow-up.
- **The standing list** leaves it out: it is no commitment to remind anyone of.

Nothing found needs more than the marker. Outside the follow-up machinery, `propose` and the read
ports change (below). A new place has no long session until its first message (§5.2), and a report
needs one, so a first look's report opens it on the coordinate that first message would key.

**Triggers** (recommended).

- **A new join, automatically.** The platform reports that the bot itself joined a conversation,
  and the conversation becomes a place of an assistant-mode agent: its row is listed and not Off.
  The daemon holding the agent's duty then takes a first look. A join that leaves the row Off takes
  none, such as one a person confirmed so the agent could read or post there once ("Joining a public
  channel" in product-conventions.md) or a restricted agent's: §5.3 already says it is no place.
- **Everything else, on request.** A place the agent was already in when the mode was switched on,
  a platform that reports no join, and a second look all wait for a person there to ask ("take a
  first look"); the long session then calls `firstLook`, a tool offered only to a place's long
  session where a first look could run. Switching the mode on therefore posts no introduction in
  old channels, however many the agent is in.
- A paused agent takes it on the join and runs it once resumed, as an overdue check does.

**Platforms** (verified 2026-10-16). Whether a first look can run is the platform's declaration,
never its name ([integration-plugin-architecture.md](integration-plugin-architecture.md)): it runs
only where the platform's read ports declare `channelHistory`. Thread replies, bookmarks and pins
are read where their ports exist; the rest goes under "Not covered".

| Platform        | Reports the bot's own join                    | History                          | Thread replies | `propose` card           | First look                                  |
| --------------- | --------------------------------------------- | -------------------------------- | -------------- | ------------------------ | ------------------------------------------- |
| Slack           | Yes: its own `member_joined_channel`, handled | Yes                              | Yes            | Yes, and one in a thread | On join and on request                      |
| Discord         | No: a bot joins a server, not a channel       | Yes                              | No port        | No                       | On request                                  |
| Lark/Feishu     | A bot-added event exists, not subscribed      | Yes                              | No port        | No                       | On request; on join once its module listens |
| Telegram        | Yes (`new_chat_members`)                      | No: the Bot API gives a bot none | —              | No                       | Never                                       |
| Google Chat, QQ | —                                             | No                               | —              | No                       | Never                                       |

The read ports this adds, each declared by the platform's own module:

- `getChannelInfo` reports a conversation's topic and description where the platform keeps them
  (Slack's topic and purpose, a Discord channel's topic, a Lark/Feishu chat's description), and
  `getCurrentChannel` returns them. Shipped.
- A pinned-messages read. Slack's needs `pins:read`, which the app manifest does not request today,
  so an install that has not granted it lists pins under "Not covered" (§9).
- History and thread messages carry a link where the platform can form one. Shipped: Slack's from
  the workspace URL, the channel and the timestamp (a reply's opens in its thread), and Discord's
  from its guild, channel and message ids. Lark/Feishu's carry none: its message list returns no
  position to form one from, and its only documented message link comes back from a forward.
- A connection callback for the bot's own join. Slack's handler already sees the event; a
  Lark/Feishu module would raise it from its bot-added event. Shipped for Slack as `onBotJoined`.

**Repeats** (recommended). Once per place, automatically. The first look's follow-up row, kept like
other settled rows until the agent is removed, records it per agent and place: a rejoin finds it and
takes none, nor does switching the mode off and on take one. A person asks for another with `firstLook`,
which runs a new one; its handling updates the same topic file. One runs at a time per place, and
asking while one runs is refused with that reason.

**External places** (recommended): no first look in v1, automatic or requested, and `firstLook` is
not offered there. A card in an external place goes to an internal member's DM (§5.5 "Drafts"), so
its suggestions would leave the place, which output 3 exists to avoid; and what an introduction
should tell people from outside is undecided (§9). A place that turns external while a first look
runs keeps only step 1 of its handling.

**Cards** (verified, then recommended). Only Slack has a `propose` card surface (`DraftCardPort`);
elsewhere a proposal is carded to the responsible user's DM or waits in Activity (§5.10). Slack's
card takes a thread, as a proposal's card does today in a long session that lives in one, so a card
under the introduction works. For a first look, `propose` changes in four ways:

1. **Offered in the report round.** The place's long session is offered `propose` on the round that
   delivers a first look's report, at most three times, and only where the platform has a card
   surface; elsewhere step 3 is text, as above. Approvers and expiry are unchanged (§5.10): whoever
   could ask the agent in the place, for 24 hours.
2. **Under the introduction.** The round's reply posts at the place's top level. The daemon holds
   the round's cards until that reply has posted, then cards them in its thread in the order
   proposed; a round whose reply never posts has its cards posted where the place's cards go
   otherwise.
3. **A follow-up form.** `propose({ sentence, why, followUp: { title, doneWhen, nextCheck? } })`,
   in place of `task`. Approving it takes that follow-up of the place with the approver as its
   asker, the confirmation `followUp` requires; it runs no task and counts against no limit, and
   its card says it was taken. This is how something in flight becomes a follow-up, and how a
   "Recurring" rhythm becomes a timed check of the place: a follow-up whose checks each set the
   next one, not a cron.
4. **The first look has ended.** Its proposals point at the first look's follow-up, which ends after
   its check by design, so "its follow-up ended" refuses none of them; every other refusal stands.

**Budget** (recommended). A first look counts as one check against `dailyPatrolBudget`.

- An automatic one waits for the agent's one scheduled-check slot, and takes it only when no
  follow-up's check is due, so an agent added to twenty channels at once delays no existing
  follow-up. Past the budget it waits for the window.
- A requested one starts at once, as a messaged check does; past the budget it is refused with the
  time the budget resets.
- Its turn is bounded by the read cap above and the 1,500-word report.
- Failures back off as a check's do. After five, an automatic first look ends without a word in the
  place, its page saying why; a requested one is reported once, as a check is.

**As shipped.** Choices the text above leaves open:

- **The marker.** A first look is a follow-up row with `firstLook` set to `joined` or `requested`
  (local store version 55). Its session is `subsession:patrol-look-<id>` in its place, a check's
  coordinate, so every rule of a check holds for it, and the coordinate alone narrows its tools,
  turns its reads to its own place and keeps its session out of memory capture and dreams. Its
  title is "First look at <name>".
- **Its bounds.** A history row counts by its own time; a page that reaches past 30 days ends the
  read there. The 500 messages count history and thread replies together, per check, so a retry
  after a failure starts again. A first look's reads take no `platform`, `integrationId` or other
  `channel`.
- **Its prompt.** `{place}` is the conversation's name in quotes, `{kind}` is public channel,
  private channel, group chat or channel, as the platform tells, and `{tools}` names the AgentConnect
  tools the place's long session is offered, the agent's MCP servers and "your runtime's own tools".
  `{reach}` is "I read every message" where a plain message starts a turn, else "@-mention me".
- **A join.** The platform's own-join callback (`onBotJoined`) raises it: Slack's
  `member_joined_channel` for the bot, over Socket Mode and, through the relay's `bot-joined` action,
  in HTTP mode. "Listed" is the Control Plane listing the conversation in the integration's session
  modes, as `append`; a join waits up to ten minutes for that, in memory, so a restart in between
  takes none. The inviter Slack names is the asker. Lark/Feishu's bot-added event is not yet
  subscribed.
- **A request.** `firstLook` is offered on a place's appending long session only and checked again
  on the call. One whose start is refused stays due, and the scheduled-check slot runs it.
- **Its report.** One report round at the place's top level carries the handling, then the report;
  step 3 is the text form until `propose` takes the round. Where the place has no long session yet,
  the report opens one on its append coordinate. A first look that ends without handing back a
  report counts as a failed check, and one whose check is stopped ends as stopped.
- **Messages.** `messageTask` to a first look is refused while it runs as well as after it ended,
  since its one check takes none. `listTasks` lists it as a first look.
- **Console.** Activity's follow-up row carries `firstLook: true` and no next check; the console
  labels it "First look". Tool sizes: `firstLook` 433 characters with a 76-byte input schema, and a
  first look's `recordCheck` 244 characters with a 391-byte schema.

---

## 6. Relation to existing mechanisms

| Mechanism                           | Relation                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Conversation gating (§14)           | Unchanged: `gated` stays restricted visibility alone, and the mode takes the same defaults (§5.3)                         |
| Session visibility                  | The permission rules follow it; DM long sessions are fixed `private`; tasks refuse visibility changes                     |
| `append`                            | Extended to Slack DMs; retention (assistant agents) and the visibility lock are prerequisites                             |
| Memory layers                       | The same for every agent; the ledger is its own store                                                                     |
| Dreams / explicit memory writes     | Dreams mine the shared layer's conversations only; writes go to the conversation's layer                                  |
| `sendMessage` / `needsReply`        | Delegation goes through them; a delegated task starts with `delegateTask`; write targets are limited to the current place |
| `replyToSession`                    | The reference for the report channel; replaced by the persistent outbox                                                   |
| Orchestration tool triple           | Removed with its deadline wake; not restored                                                                              |
| Agent pause (#288)                  | Is "stop everything"; also suspends wakes and the outbox                                                                  |
| Reminder injection (`shouldRemind`) | Carries the standing summary                                                                                              |
| Dream host                          | The shape of the patrol host                                                                                              |
| Cron / hooks                        | Patrol triggers; hook routing in P2                                                                                       |
| `OrganizationSuggestion`            | Card component only                                                                                                       |
| `Decision`                          | P2 triage                                                                                                                 |

---

## 7. Phases

| Phase                             | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prerequisites                     | §4.2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **P0a — continuity and one mind** | Switch and admission; gating derivation and trust levels (enabled means internal, with a warning; Slack Connect detected external); Slack DM `append`; the ledger, the standing summary, `recall` and the permission rules (read, write); drafts in external places and posts to other places (the approval record, "post" only); memory bypass closed; "ask me in a DM". **No tasks**                                                                                                                                                                                                                                                                                                                  |
| **P0b — tasks**                   | Minimal: direct self-delegation, now `delegateTask` (own `subsession:` coordinate, inherited visibility, no nesting, the persistent parent–child index); a daemon failure report when a task ends without reporting; a concurrency cap that refuses. Deferred until needed: the persistent outbox, recovery order, the daily budget, queueing over the cap; listing (`listTasks`), stop and steering have shipped (§5.6, §5.8)                                                                                                                                                                                                                                                                          |
| P1 — while nobody is around       | Shipped: minimal patrol (§5.9, #2887), `propose` from patrols (§5.10, #2895), Activity with console decisions (#2876, #2880), the webchat tasks panel and read-only task pages (#2885, #2893), per-asker recall in the asker's DM (§5.5, #2901), `remind` (§5.9), tasks' permission requests routed to their conversation under the wait cap (§5.6), stopping a delegated task from the session that delegated it (§5.8), follow-ups in place of the ledger and patrols (§5.12; console rows #3055). Next: the target check (after per-runtime tests) on the credential-less host; `handoff`; identity links pushed to the daemon. The per-person memory space shipped as memory layers for every agent |
| First look (partly shipped)       | §5.13: a one-check follow-up the daemon takes when the bot is added to a place (Slack) or a person asks for one (Slack, Discord, Lark/Feishu), with `firstLook` and the bot-join callback, shipped. Still to come: `propose` in its report round, under the introduction and with a follow-up form; Lark/Feishu's join. The read ports it needs (topic and description, message links) shipped. A timed check of the place is offered through it as a follow-up; waking on events stays P2                                                                                                                                                                                                                      |
| P2 — cost and events              | Hook events routed to follow-up checks (§5.12); Decision triage; budgets; incremental summary injection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| P3                                | The personal form; retention widened to every user once run state is decoupled from session rows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

---

## 8. Explicitly not done

- The personal form; one shared context; an output filter as a defense; member enumeration as a
  precondition for recall;
- a dedicated workspace for tasks, changing the agent's isolation, changing the
  permission mode other than by the default when the mode is switched on;
- automatic retry of an uncertain external write; cancelling a waiting permission request to free
  a slot (P0);
- delegation / report / status tools parallel to `sendMessage`; restoring the orchestration tool
  triple; a new "stop everything";
- delegated tasks of tasks; tasks as platform threads;
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

1. **Automatic context rollover**: a threshold on `contextUsed`. Under §5.12 a follow-up belongs
   to its place, so a rollover hands it to the place's new session as `!new` does; what remains
   open is the threshold.
2. **Run-state reclaim for permanent sessions** (the follow-up to §4.2 item 1).
3. **Slack DM `append` versus Slack assistant threads** (`assistant_thread_started` is already
   supported): whether a "new conversation" button still means anything.
4. **Webchat report rounds without a connected client** (unverified).
5. **Trust drift**: a place whose members change after the agent first answered there;
   member-joined coverage per platform beyond Slack guests.
6. **Cost**: one long conversation per place and one main-session turn per report round; needs
   P0 measurements. A follow-up (§5.12) may run hundreds of checks in one retained context: whether
   the daemon reopens it after a fixed number of checks, with the stored observation as the
   handover, or leaves it to the runtime's compaction.
7. **Wording of item summaries**: the restatement when an item is taken is the only review point
   for what becomes team-visible. Moot under §5.12, where a follow-up is listed only where its
   conversation may be read.
8. Whether distillation on a normal OpenCode host runs under `plan` (live, unverified).
9. **Settled by B1/B2**: with no marked sessions left (§5.5 "Writes"), what a person's request
   sends out of a conversation is that person's call, through any tool.
10. **Settled: instructions in a resumed session**: a runtime that does not apply native
    instructions on `session/load` (Codex applies them only when a thread starts, OpenCode takes
    them inline) keeps the standing rules it started with. The daemon records a digest of the
    standing context each session's model last received; on the first prompt after a load on such
    a runtime, a changed context rides that prompt as a block that says it replaces the earlier
    rules ([session-concept.md](session-concept.md) §2.3). Claude applies them on load and gets no
    block. A session whose context changes while its runtime stays up keeps what it has until it
    next resumes.
11. **First look in external places** (§5.13): none in v1. Whether to allow one on request, with its
    suggestions as text in the place, once what an introduction may tell people from outside is
    decided.
12. **Slack pins** (§5.13): reading them needs `pins:read`, a scope every workspace must grant again.
    Whether to add it with the first look, or ship without pins and list them under "Not covered".
    Decided 2026-10-16: v1 ships without pins.
13. **The first look's window and threshold** (§5.13): whether 30 days or 500 messages, and
    "resting on two or more messages", give useful first looks. Measure one first look's cost and the
    share that offer nothing before widening either.
14. **Group DMs on Slack** (§5.13): whether Slack reports the bot added to a group DM as its own
    `member_joined_channel`. Unverified; one it does not report gets a first look only on request.

---

## 10. Review record

Each entry records its revision in the vocabulary of its time. Until the forty-first revision,
"sub-session" named what is now a delegated task, a patrol or an approved proposal, and
`stopSubsession` is now `stopTask`. Until the forty-second, "task" meant only a delegated task,
`delegateTask` was `startTask`, and "background work" and "approved work" named what are now
tasks and approved proposals.

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
organization. Every agent now asks the platform whether the asker is a full member, reading the
member-join lookup's per-person answer; a failed lookup takes the asker as not internal. A card
surface must answer membership, so no place vouches for anyone, and a platform without a card
surface has no asker approver in either mode. A member of a sibling Enterprise Grid workspace, whom
the shortcut let approve in assistant mode, is not a full member here and no longer does.

**Thirty-third revision (2026-10-13)**: every agent has `recall` and the reminder tools (issue
#2979; §5.4 ③, §5.9). Both were gated on assistant mode, but neither needs anything only the mode
has: `recall` passes the read rule every agent's cross-place reads already pass (B3), and a
reminder posts into the conversation it was set in, which every agent now does directly, one shared
with another organization included (B4). Each is offered in the same sessions as before, minus the
mode check: `recall` everywhere, a turn no person is behind reading only public channels on its own
bot; the reminder tools in a platform conversation of the session's own, never a sub-session,
patrol or webchat. Only an agent in assistant mode is told in `remind`'s description to take an
item instead for something to be checked on at a time, since only it has items. Switching the mode
off no longer holds back a pending reminder: it posts at its time. Items, patrols, proposals, the
standing summary, sub-sessions, Activity and the one long session per place stay assistant mode's.

**Thirty-fourth revision (2026-10-13)**: `recall` lists a person's own DMs and webchat conversations
in their own one (issues #2979, #2810; §5.4 ③, §5.5 "Reads"). A person could already read their own
conversations across linked surfaces by id, but the listing skipped every DM and webchat
conversation, a Slack DM has no name, and a webchat title another conversation shared did not
resolve, so in practice the agent could not find them. In the asker's own DM or webchat
conversation, with no one else asking, the listing now offers their other DMs on any platform and
bot and their webchat conversations, judged by the owner rule reads use, through one batched
owner-only `agent/read-access` ask (feature `read-access-batch-v1`, up to 64 sessions); anywhere else
it still lists only public conversations. A webchat title also resolves when it is unique among the
asker's own conversations. A Control Plane without the feature is not asked, and the listing and
title resolution stay as they were.

**Thirty-fifth revision (2026-10-13)**: the orchestration tools and their deadline wake are removed
(issue #2979), so `nextCheck` falls due on the patrol's minute sweep, not a generalized deadline wake.

**Thirty-sixth revision (2026-10-13)**: Activity, the session dock's Sub-sessions tab and the
console's permission-mode default reach every agent (issues #2979, #2810; §1.8, §5.11). Every agent
now drafts posts and opens sub-sessions, but only an assistant-mode agent's page showed them, so an
editor of any other agent could decide a draft only from its card and could not see or stop a
sub-session from the console. The Activity routes for sub-sessions, stopping one, drafts and
deciding one now admit an agent outside assistant mode when its serving daemon advertises
`activity-every-agent-v1`, and the console shows that agent an Activity tab with those sections
and a Sub-sessions tab on its sessions; items and proposals stay assistant mode's, and an older
daemon is never asked. The console's new-agent form preselects the runtime's auto mode, else its
full-access one, through the same helper §1.8 uses, since background work nobody watches stalls on
approval whatever the mode; an agent created through the API or MCP is unchanged. The Control Plane
refuses a visibility change on any agent's own sub-session (§5.6), recognised by its reserved
coordinate and its parent's agent, no longer only on an assistant-mode agent's; only a daemon that
opens sub-sessions for every agent can create such a session outside assistant mode.

**Thirty-seventh revision (2026-10-13)**: every agent has sub-sessions (issues #2979, #2810; §1.3,
§5.4 ②, §5.6–§5.8, §5.11). Self-delegation needed nothing only the mode has: its coordinate,
inheritance, no-nesting rule, reports and failure report, cap, permission routing and wait cap, and
stopping were all keyed by the sub-session index, not the mode. A postless self-call of any agent
now opens a sub-session, `sendMessage` and `listAgents` describe it to every agent, and every
agent's main conversation gets `stopSubsession` and the running-sub-sessions block. Limits come
from an assistant mode policy's `limits` when the agent has one, otherwise from the defaults (3
running, 12 hours to wait for approval); there is no new setting. A sub-session's permission
request is routed for every agent as for an assistant-mode agent, an external place's to the
responsible user, whom the Control Plane derives whatever the mode. The daemon's Activity read
answers every agent (`activity-every-agent-v1`) with permission requests, sub-sessions and drafts,
and so do its console stop of a sub-session and its draft decisions; items, patrols, proposals and
reminders stay assistant mode's.

**Thirty-eighth revision (2026-10-13)**: the console's permission-mode default reaches every runtime
with an auto or full-access mode (issue #2979; §1.8). The per-runtime map named only Claude Code and
Codex, so a new agent on any other runtime kept the form's old preselection, often a mode that asks
and then waits for nobody. The map now classifies each mode by the description its runtime reports
and covers every runtime with a mode that decides on its own or never asks; a mode whose
description leaves approvals open stays out. No runtime is newly admitted, so switching the mode
on is unchanged, and an agent created through the API or MCP still keeps its runtime's default.

**Thirty-ninth revision (2026-10-14)**: Codex and OpenCode join the admission list (issue #2810;
§4.1, §9). Native memory could already be turned off for both, but resuming a session by id after a
runtime restart was unverified. Against a local model stub, each runtime took two turns, its whole
process group was killed, a new process loaded the session by its old id, and the model request for
a third turn carried both earlier turns and their replies. Codex (the managed adapter
2.2.2-agentconnect.1 with Codex 0.160.1, and the image's previous pin 2.1.1-agentconnect.1 with
0.159.3) resumes the thread from its rollout under `CODEX_HOME`; OpenCode (1.18.32, the image pin,
and 1.19.0, the registry's) resumes from its session database under `XDG_DATA_HOME`. Both live in
the runtime's private HOME, which the daemon derives again after its own restart from the agent's or
the session's directory and which on the pool is the session's volume, and `session/load`
re-attached the MCP servers it was given for both. Codex's `memories` feature is still the switch: on, it runs a memory
consolidation request at startup and writes a `memories` directory; the daemon's
`features.memories = false` over the same configuration does neither. OpenCode offers no memory
tool and keeps no memory store. No daemon capability gates the change: the daemon never reads the
list, and its resume path, `session/load` whenever the runtime advertises it, predates assistant
mode and branches on that capability alone, so an older daemon resumes these runtimes the same way. Switching the
mode on moves Codex to Auto review and keeps OpenCode's mode (§1.8). A resumed Codex thread keeps
the instructions it started with (§9).

**Fortieth revision (2026-10-14)**: a resumed session gets the current standing instructions on
every runtime (issue #2810; §9). Codex applies native instructions only when a thread starts and
OpenCode receives them inline, so a session opened before a change kept the old rules after a
restart while the tools it fetched afresh described the new ones; #3019's self-call rule is the
case that showed it. Each session row now keeps a digest of the standing context its model last
received (local store v50), and the first prompt after `session/load` on a runtime that does not
apply instructions on load carries the current context, with a first line saying it replaces the
earlier one, only when the digest differs. Claude applies them on load and is unchanged, as is a
warm session on every runtime.

**Forty-first revision (2026-10-15)**: visible text no longer says sub-session (send-message-guide.md
§11 questions 10–11; §1.3, §5.6–§5.11). Work a session started with `startTask` is a task, so
"task" has one meaning; a patrol is a patrol and an approved proposal's work is approved work,
neither of them a task. The umbrella for all three, in the console's Background work tab, Activity,
permission cards and the limits that count them, is background work, and the daemon's failure
report for a patrol or approved work is headed `[patrol ended]` or `[approved work ended]`. §5.6–§5.8
now state the task contract directly instead of pointing to send-message-guide.md: `startTask`,
`messageTask {taskId}`, `stopTask` from the owning session on any of its turns, and replies by
message id. Store tables, the `subsession:` coordinate, protocol fields, capability names and the
`limits` keys keep their names.

**Forty-second revision (2026-10-15)**: task is the umbrella (send-message-guide.md §11 questions
10–11; §1.3, §5.6–§5.11). A session's tasks are its delegated tasks, which it hands off with
`delegateTask` (renamed from `startTask`, which shipped only in v2.5.0 release candidates, so no
alias remains), and the patrols and approved proposals that report to it; the new `listTasks`
lists them. "Background work" and "approved work" are gone from visible text, and an approved
proposal's failure report is headed `[approved proposal ended]`. The session dock's Background work
and Runtime jobs tabs merge into one Tasks tab with two groups: This turn, what the runtime reports
for the current turn, read-only; and Delegated, the session's tasks, which can be stopped. A
task's page names the session it belongs to and links back. §1.3 is now "Long work: delegated
tasks" and §5.6 "Tasks".

**Forty-third revision (2026-10-15)**: §5.12 proposes follow-ups in place of the item ledger and
patrols. A follow-up is a read-only task of the place it was taken in, woken by time, with a
`taskId` the place's current long session can message and stop, after `!new` or a rollover too:
a stated departure from delegated tasks, which stay bound to the session row. Its asker is the
person who confirmed it. `followUp` replaces `takeItem`; `recordCheck` replaces a patrol's
`updateItem`; `listItems`, the main conversation's `updateItem` and `followItem` go away. It is a
tool of its own rather than a `delegateTask` option: a follow-up needs the person's confirmation
and is read-only by construction, and `sendMessage` stays unchanged. The organization-visible
ledger is dropped: the standing list is keyed by place, stricter than §5.5 for DMs. Wake, limits
and recovery are the minimal patrol's. §5.4, §5.9–§5.11, §7 and §9 point to §5.12; nothing else
changes until it ships.

**Forty-fourth revision (2026-10-16)**: §5.12 ships in the daemon, the protocol and the Control
Plane, beside the console's follow-up rows (#3055). `followUp` and `recordCheck` replace
`takeItem`, the item tools and a patrol's `updateItem`, with no aliases. A follow-up keeps one
session for all its checks, its `taskId`; a numbered check log records each check for the daily
budget and the console. The place's current long session lists, messages and ends it, and its
index row is re-pointed to that session when it does. `messageTask` starts a check at once, and a message that
arrives while one runs waits for the next. The standing list is keyed by place. The daemon
advertises `follow-up-tasks-v1`: Activity carries follow-ups among the tasks and answers no items,
and the Control Plane refuses the item routes toward it. Store version 53 turns each open item into
a follow-up of its place and drops followers and closed items. §1, §5.4, §5.6–§5.11 and §7 now
describe follow-ups; §5.12 records how it shipped.

**Forty-fifth revision (2026-10-16)**: §5.12 "As shipped" closes its two console gaps. A
follow-up's row carries its own id, by which the console ends one whose first check has not run,
under the rule of the conversation its row names. A task's own page reads its row by the task's
session and shows a follow-up's status, what counts as done and its recent checks. The daemon
advertises both as `assistant-task-handle-v1`.

**Forty-sixth revision (2026-10-16)**: assistant mode keeps managed memory in the Control Plane
(§4.1), so person and place memory survives a move and can later be read and cleared in the console
with no daemon online; the console's memory routes still go through the agent's daemon. Admission
takes `managed` only; `none` is no longer admitted, and no binding is still the managed default.
Turning the mode on switches a `daemon` home to `control-plane` in the same row-locked write and
flags the one-way migration the owning daemon already runs for a manual switch. While the mode is
on, an edit that sets a `daemon` home or another provider, and the forced return, are refused with a
409 that says to turn the mode off first; turning it off moves nothing back. The Control Plane's
boot pass also flips every assistant-mode agent with a `daemon` home, and gives one whose memory is
off the managed default in the Control Plane, which has no tree to copy. The costs are accepted: a
self-hosted daemon on a hosted Control Plane keeps person and place layers there, memory is
unavailable while the Control Plane is unreachable, and the move is one way. The console fixes the
Memory tab's backend and home while the mode is on.

**Forty-seventh revision (2026-10-16)**: the console reads an assistant's memory with no daemon
online. For a Control-Plane home the Control Plane answers the shared layer, a place layer, the
caller's own person layer and the place-layer listing from its own tables, and clears a place
layer there, under the same per-caller rules, so the forty-sixth revision's remaining gap is
closed. A console edit still goes through the agent's daemon, which owns the write path.

**Forty-eighth revision (2026-10-16)**: §5.13 proposes a first look (issue #2810; §1.9, §2, §7,
§9). Added to a channel, an assistant-mode agent did nothing until someone @-mentioned it. The
product owner decided what a first look is: a read-only task of the place reads its last 30 days or
500 messages, whichever is less, and reports to the place's long session. That session writes how
the place works to the layer that conversation writes (the shared layer for an internal public
channel, else the place layer), introduces the agent once, and offers at most three suggestions as
`propose` cards under the introduction, none being a fine outcome. The two prompts are recorded
with the changes made to fit verified facts. Recommended for the owner to confirm: a first look is
a follow-up the daemon takes and ends after one check, reusing the follow-up machinery, not a new
task kind. It runs on a new join automatically and otherwise on request (`firstLook`), only where
the platform declares channel history (Slack, Discord, Lark/Feishu; not Telegram), once per place,
and never in an external place in v1. `propose` gains the report round, cards held until the
introduction posts, and a follow-up form that turns an approval into a follow-up. It counts as one
check, and an automatic one yields to due follow-up checks.

**Forty-ninth revision (2026-10-16)**: §5.13's read ports ship for topic, description and links.
`getCurrentChannel` reports Slack's topic and purpose, Discord's topic and Lark/Feishu's
description. Slack's history and thread messages and Discord's history messages carry a link;
Lark/Feishu's carry none, since no stable one can be formed. `channelHistory` already declared
exactly Slack, Discord and Lark/Feishu.

**Fiftieth revision (2026-10-16)**: §5.13 partly ships (issue #2810; §1.9). The owner confirmed
every recommendation. A first look is a follow-up marked as one, on a check's coordinate, that the
daemon takes when Slack reports the bot's own join of a listed, not-Off, internal conversation, or
that a place's long session asks for with `firstLook`. It reads only its place, at most 30 days and
500 messages, reports with the handling into the long session, opening it where there was none,
and ends after one check. It counts against `dailyPatrolBudget`, yields to due follow-up checks when
automatic, and its own session feeds no memory. The suggestions are text until the `propose`
changes; Lark/Feishu's join and pins come later.
