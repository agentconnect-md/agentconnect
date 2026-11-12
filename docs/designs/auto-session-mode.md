# Auto Session Mode: the Coordinator Session and Tasks

> Status: Implemented on the daemon, the Control Plane and the console. A daemon runs `auto` with
> its `features.autoSessionMode` switch, which is on by default and advertises
> `session-mode-auto-v1` (§3.1); with the switch off it routes `auto` as Per thread and keeps P1's
> task tools for every session (§5.1, §6.3). New rooms and group DMs use the agent's default,
> with Auto as the default where the platform and daemon support it (§3.2). Assistant mode's
> places run through the coordinator (§3.4). On Slack a task moves into a code channel only
> when it makes one for its work (§6.8). The
> coordinator's prompt and tool surface are the ones the local runtime matrix validates (§12).
> An approved proposal answers in a thread of its place, on a platform with approval cards and in
> a member's webchat coordinator conversation (§6.9.1); read-only tasks (§6.9.3) are proposed, not
> built.
> Builds on: [channel-session-mode.md](channel-session-mode.md) (the per-conversation setting),
> [assistant-mode.md](assistant-mode.md) §5.6 (delegated tasks),
> [send-message-guide.md](send-message-guide.md) (the `sendMessage` actions).
> Compatibility with today's task tools is not kept: the task actions change shape (§4).

## 1. Summary

`auto` is a third session mode beside Per thread (`createNew`) and Single session (`append`). Every
channel-root message goes to the agent's **coordinator session** for that conversation, which hands it
to an open task, opens a new task, replies itself, or ignores it. A task opened for a message has the
message's thread attached, and people in that thread talk to the task directly.

Tasks and today's delegated tasks become one concept. A task with a thread attached talks to people;
a task without one works in the background and reports to its parent session, as a delegated task does
today. Every task the coordinator opens is threaded (§6.6).

Single session keeps its current meaning: root and thread messages all join one session.

## 2. Vocabulary

| Term                | Meaning                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Auto                | The session mode that turns the coordinator on                                                                                           |
| Coordinator session | One long session per agent per conversation. It receives root messages and messages in unowned threads, and only decides where they go   |
| Task                | A child session the coordinator opens with `delegateTask`, with a title and a link to its parent. It replaces topics and delegated tasks |
| Threaded task       | A task with one or more platform threads attached; people in those threads talk to it directly                                           |
| Background task     | A task with no thread; only its parent talks to it, and it reports to the parent at the end of each round                                |
| Owned thread        | A thread attached to a task that still exists                                                                                            |

A task runs in **work** mode, as every task above does, or in **watch** mode: assistant mode's
follow-ups, read-only and checked on a schedule ([assistant-mode.md](assistant-mode.md) §5.18 ⑤).
Approved proposals stay a kind of their own.

## 3. Mode and configuration

### 3.1 Value and capability

- `ChannelSessionMode` gains `auto` (`packages/protocol/src/frames/integration.ts` and the Prisma enum).
- The daemon advertises support for `auto` (`session-mode-auto-v1`); the Control Plane refuses `auto`
  on a row served by a daemon that does not (409 `SESSION_MODE_UNSUPPORTED`).
- A daemon without the capability that still serves an `auto` row, after a move or a downgrade, is
  sent `createNew` for it: a new enum value would make the whole frame unreadable to it.

### 3.2 Defaults

- Unless the agent chooses another new-conversation default below, new **channel and group-DM**
  rows default to `auto` where the platform and daemon support it. Otherwise they start on `createNew`.
- Existing rows, `createNew` and `append` alike, are not changed.
- This new-conversation default does not change 1:1 DMs. Assistant mode can still force a supported
  DM, including a Slack 1:1 DM, onto its coordinator (§3.4).
- The Control Plane decides when it creates the row: from a daemon's conversation report, by the
  reporting daemon's features, or from the relay, by the features of the daemon the relay addresses
  the install's agent on. A new row starts on `auto` where that daemon advertises
  `session-mode-auto-v1` and the platform keys one session for the row's kind (`appendKinds` in
  `packages/protocol/src/platform-manifest.ts`), so a Linear team row stays `createNew`.
- The daemon's spec does not list a row it just reported, so the Control Plane pushes the integration
  at once when a report creates an `auto` row; the relay path pushes with its route update. A message
  that arrives before the push runs Per thread, and the coordinator adopts that thread session as a
  task when it first runs (§3.5).
- A row a later report reclassifies as a 1:1 DM, which Slack can do to a conversation it first
  reported as a room, takes the DM's mode with the DM's trigger.
- A group DM is a small private room: Slack lists `mpim` in `appendKinds`, and the console offers its
  group-DM rows a room's modes (`groupDmSessionModes`). Assistant mode therefore runs a Slack group
  DM through its coordinator too (§3.4).
- The daemon's `features.autoSessionMode` switch is on by default.
- The **New channels start on** selector at the bottom of the agent's Integrations card sets what
  new rooms and group DMs start at (`newConversationMode`, also in `PATCH /agents/:id`):
  `auto` or unset is the default above; `mention` is labelled **@-mentions · Per thread** and
  selects that pair even where the daemon reads Auto; `off` starts them Off. It applies to rows created after it is set; 1:1 DMs
  keep their own default, and a restricted agent's or an external place's Off still wins. On a shared
  bot the install that seeds a room decides, as for the restricted Off.

### 3.3 Trigger

- Under `auto` every root message goes to the coordinator, so @-mentions and Any message behave the
  same.
- The conversation popover leads with Session mode. With `auto` selected it hides Respond to;
  Off stands alone below a divider. Per thread and Single session show Respond to where there is
  a trigger choice. There is no "Decided by the coordinator" option. A Decision is added through
  the row's separate + Decision control ([channel-session-mode.md](channel-session-mode.md) §8).
- By decision and shared-bot routing are mutually exclusive with `auto` for now.
- The Control Plane refuses `auto` on a By decision or routed row, By decision on an `auto` row, and
  adding an `auto` conversation to a shared bot's routing, all with 409 `SESSION_MODE_CONFLICT`. A
  daemon that still receives both keys the row Per thread.
- Mention and Any message both admit every message: a daemon adds an Any rule for each `auto`
  conversation of a direct integration that is not Off, and a shared bot's relay routes every message
  of an `auto` conversation to its owner once the owner's daemon advertises `session-mode-auto-v1`.

### 3.4 Assistant mode

- Assistant mode forces `auto` instead of `append`. The coordinator is assistant mode's long session:
  follow-ups, reports and approval cards belong to it.
- An assistant-mode agent's existing rows move to `auto` once their daemon supports it. The old
  `append` session takes no new messages and ages out through retention. Its context is not carried
  over; the coordinator starts empty and relies on memory.
- The Control Plane's spec projection marks each place assistant mode forces onto one session, and
  the spec sent to a daemon advertising `session-mode-auto-v1` lists such a place as `auto`; any
  other daemon receives `append`. The stored rows are not rewritten. A daemon with the switch on also
  gives an assistant-mode place it does not list yet `auto` where the platform appends its kind.
- The place's long session is its coordinator: a report, a follow-up's result or another agent's
  answer reaches its batch as a `<report>`. The coordinator answers a report with `replyToMessage`,
  which posts in the report's thread or at the conversation's root. A report that names no thread is
  at the root, never in the thread the coordinator's latest turn answered. A report never opens a
  task and is never handed to one, and shows no 🤔. Its own follow-ups and proposals, made with the
  place tools of §5.4, belong to it as they belong to an `append` session.
- A report queued behind a running turn joins the next batch in arrival order, beside the channel
  messages and framed apart from them as `<report id task kind title>`: the task it speaks for by
  its `taskId`, kind and title, or `kind="agent answer"` for another agent's answer
  ([assistant-mode.md](assistant-mode.md) §5.18 ④). It brings no asker and no permission class, so it
  rides with the batch it arrives in, and a batch of reports alone is judged `NOBODY` (§5.18 ③). The
  coordinator answers it with `replyToMessage` naming its id, or leaves it, which settles it
  silently with the turn; nothing is retried or queued again.
- A report that carries turn metadata keeps a turn of its own, ending the batch before it: a
  getting-to-know report, whose proposals ride on that turn's metadata, and a report that opens its
  place's long session. The channel messages right behind it of one permission class join its turn,
  and it adds no asker. A report that finds the coordinator idle starts a turn at once, and a webchat
  conversation's reports, like its messages, each run as a turn of their own (§10).
- The coordinator's turns carry the work board ([assistant-mode.md](assistant-mode.md) §5.18 ② and ④)
  instead of the standing follow-up list and the running-tasks block: its place's open tasks with
  their ids, and the other places' open tasks every person in its batch may read. It is sent when the
  session opens, when its text changed, after a compaction and after a restart.

### 3.5 Switching

- **Into `auto`**: thread sessions opened before the switch become the coordinator's threaded tasks.
  Their threads keep reaching them, and `listTasks` lists them, titled with the start of their first
  message.
- **Out of `auto`**: the coordinator takes no new messages and ages out. Threaded tasks go back to
  being ordinary thread sessions: under `createNew` they keep working; under `append` thread messages
  join the one session.
- Mode is read per message, so the switch takes effect where a message or the sweep meets it:
  - A conversation's coordinator is minted by the first message that needs it. A newly minted one
    adopts, as settled threaded tasks, the conversation's thread sessions that a platform message
    opened, that were active within the last 7 days (§6.5) and whose threads no task holds.
  - The minute sweep on the agent's duty holder releases the threaded tasks of a conversation that
    is no longer `auto` and drops its coordinator reservation, so a switch back mints a new
    coordinator, which adopts its old tasks' sessions again.

### 3.6 Turning the coordinator off

- An agent can turn its coordinator off: **Disable coordinator** at the end of the Coordinator tab of
  its model picker (`coordinatorDisabled` in `POST`/`PATCH /agents/:id`, stored with the coordinator
  model in the agent's run overrides). Picking a coordinator model turns it back on. The chosen
  coordinator model is kept while it is off.
- While it is off the agent has no coordinator anywhere:
  - The Control Plane refuses `auto` on its conversations (409 `SESSION_MODE_UNSUPPORTED`) and the
    console offers no Auto. New rooms and group DMs start Per thread, as where the daemon cannot
    read Auto (§3.2).
  - A row already on `auto` keeps its stored mode but is projected as `append`: it runs as Single
    session on the row's own trigger, and a shared bot's relay forwards it by that trigger rather than
    every message. The console shows it as Single session. Turning the coordinator back on projects
    `auto` again.
  - Assistant mode's places stay `append` and are not marked for the coordinator (§3.4).
  - A member's console conversation with the agent is an ordinary webchat conversation (§10); the
    Control Plane mints no coordinator conversation for it.
- The daemon reads the flag from the agent spec and keys every `auto` conversation as `append`,
  including an assistant-mode place it does not list yet, so a stale integration spec cannot revive
  a coordinator. Leaving Auto then follows §3.5: the minute sweep retires each coordinator and hands
  its threaded tasks back as ordinary thread sessions, whose thread messages now join the one session.
- `coordinatorDisabled` rides the agent spec as a plain field, always shipped by a current CP; an
  older daemon ignores it and still receives `append` for its `auto` rows from the projection.

## 4. Root messages and the coordinator

### 4.1 What it sees

- Every **root message** of the conversation, and every message in an **unowned thread** (a thread
  under a message the coordinator replied to itself, or one whose task has closed).
- A message that mentions the agent may not be ignored.
- **A thread it meets part-way.** A message in a thread the coordinator was admitted no earlier
  message of comes with a `<thread>` block ahead of the batch: the thread's messages before it,
  read through the platform's thread-history port as a thread session's catch-up reads them
  ([daemon-detailed-design.md](daemon-detailed-design.md) §8.4). It covers a mention part-way
  through another agent's thread, a thread from before the conversation was on Auto, and a thread
  whose earlier messages the filter (§4.7) kept from it.
  - The block is background for the message that names the thread, never a message to decide. It
    holds the root and the newest of the rest, 20 messages of at most 1,500 characters each, and
    says how many it leaves out; the agent's own earlier words there read `from="you"`.
  - It is read once per thread: the delivered message is admitted, so the coordinator holds the
    thread from then on and later messages there arrive alone. A message the filter skips in a
    thread it already holds stays unseen.
  - The rows are not recorded in the coordinator's transcript. A task opened for the message
    catches the whole thread up itself.
  - The read is bounded at 5 seconds. A failed or late read, and a platform with no thread-history
    port or no ordered message ids, leave the turn as it was: the message and its thread's id.

### 4.2 Four outcomes

| Outcome                  | How                                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (a) Hand to an open task | `messageTask {taskId, messageId}`: the message's thread is attached to that task, which answers there                                                                                            |
| (b) Open a new task      | `delegateTask {messageId, title}`: a new task opens for the message, with its thread attached                                                                                                    |
| (c) Ignore               | `ignoreMessage {messageId, reason}`: nothing is posted for the message, whatever the turn writes; the reason stays in the coordinator's transcript                                               |
| (d) Reply directly       | The turn's final text, or `replyToMessage {messageId, message}` in a turn of several messages, posted in the message's thread. The thread stays unowned, so replies come back to the coordinator |

(d) is for what needs no session of its own: greetings, thanks, a question about a task's status.
The reply is the coordinator's response, so on Slack it carries the attribution footer a turn's
reply does, linking the coordinator's session.

### 4.3 Batching

The coordinator runs one turn at a time. Root messages that arrive while it runs are delivered
together in its next turn, with the reports that arrived among them (§3.4), and it decides each one
separately. Queued messages are never dropped. A coordinator whose runtime session could not be
restored (a runtime change, a failed load) reads its conversation so far ahead of the batch, as any
recreated session does.
A batch holds one permission class, so the queue is cut in arrival order where the next sender's
class differs, and every sender of a batch is asked on its turn
([assistant-mode.md](assistant-mode.md) §5.18 ③).

Every outcome is a call that names its message, except the coordinator's own reply, which may be the
turn's final text:

- (a) `messageTask`, (b) `delegateTask`, (c) `ignoreMessage`, (d) `replyToMessage`, at most one call
  per message.
- The final text, the text after the turn's last call, answers the message no call decided: the one
  person's message left without a call, else the one of those that mentions the agent. It is posted
  where that message is answered. Text is never posted for a report, which is answered by
  `replyToMessage` or left, nor when several messages are left and none or more than one mentions
  the agent, nor after every message got its call.
- **Leaving a message is a call, not silence.** A model that leaves a message tends to write why. As
  text that is indistinguishable from a reply, so the daemon would post it; as the `reason` of
  `ignoreMessage` it is recorded and posted nowhere, and the call gives the message its outcome, so
  no text can answer it. Text that is `AC_NO_RESPONSE`, or prose that ends in it on a line of its
  own, is still silence, as in any session (`packages/daemon/src/session/no-response.ts`), but the
  prompt no longer relies on it.
- A mention may not be ignored (§4.1): `ignoreMessage` on one posts nothing for it and its receipt
  says a task will answer it, which the fallback of §4.5 then opens.
- The coordinator reads only an attachment's name (§5.1), so its text never answers a person's
  message that carries one; a mention among them takes the fallback of §4.5.
- How it came to this. The first prompt said the text was shown to nobody while a one-message turn's
  text was posted, and a model's reasons were posted; the daemon then posted no channel turn's text,
  and every reply was a `replyToMessage` call. When the text answered a message again, with the
  sentinel as the way to stay silent, a coordinator on Claude Haiku posted "This message is
  addressed to another bot, not me, so I'm ignoring it" in two threads on the test environment. Its
  session had left forty messages that way before, each time ending its turn with such a sentence
  and never with the sentinel, which had been harmless while no text was posted.
- **A coordinator from before a change of outcomes is succeeded.** Its own past turns teach it the
  old way more strongly than a changed prompt does. The conversation's reservation records the
  outcome protocol its coordinate was minted under (`COORDINATOR_PROTOCOL`); a message that finds
  an earlier one mints the next coordinate and hands the tasks over, as a root `!new` does (§8). A
  webchat conversation keeps its coordinator, since its browser shows the text either way.
- In webchat (§10) the browser shows the text as it streams and commits it with its turn.

Ignoring posts nothing. The prompt forbids a reply that only says a message is not for the agent; the
runtime matrix caught one model posting exactly that (§12).

Each message is delivered with its id, its sender, and whether it mentions the agent:

```text
[2 new channel-root messages in #eng-platform (C0EXAMPLE1)]
<message id="msg-1700000900.000100" from="<@U0EXAMPLE2>" mentions-you="no">
morning all
</message>
<message id="msg-1700000900.000200" from="<@U0EXAMPLE1>" mentions-you="yes">
<@U0EXAMPLEBOT> can you add retry with backoff to the webhook sender?
</message>
```

The id is the platform message id behind a `msg-` prefix. A bare Slack timestamp reads as a number,
and some models pass it as one, which drops its trailing zeros (§12).

A message that mentions the agent and is left unanswered when the turn ends, by `ignoreMessage` or
with neither a call nor a reply in text, takes the fallback of §4.5: a task opens for it.

### 4.4 Feedback

- A reaction intent, `triaging` (`PlatformReactionIntent`, beside `seen`), shown as 🤔, which is in
  Telegram's allowed set. Every platform that implements `react` maps it and takes it back with
  `unreact`.
- Placed on each message the coordinator is deciding when its turn starts, and removed when the turn
  ends, whatever the outcome. A message still waiting in the queue shows nothing until the turn that
  decides it starts.
- A Telegram bot shows one reaction per message, so 🤔 comes off only while it is still the one shown;
  the 👀 of a task that answers the message replaces it and stays.
- A threaded task's turns show 👀 as usual. Google Chat cannot react, so it shows nothing here.

### 4.5 Failure

When the coordinator's turn fails or times out:

- A message that mentions the agent opens a threaded task directly, as Per thread would, in the
  message's thread. It is a task opened for a message like a delegated one, so it may make and hold a
  code channel for its work under the same rules (§6.8).
- Any other message stays silent.

### 4.6 Usage

No separate cap: batching (§4.3) bounds it, and the console's Usage page shows, under each agent,
what its coordinators spent. A limit is decided once real usage is known.

### 4.7 The filter

An agent may put a Decision model in front of its coordinator: `coordinatorFilter: { providerId,
model }` in `POST`/`PATCH /agents/:id`, stored beside the coordinator model and shipped on the agent
spec. It is a provider and model only, like the repository selector
([multi-repository-workspaces.md](multi-repository-workspaces.md) decision 15): the daemon writes the
question, and the model must answer Boolean questions (400 otherwise). Null removes it.

- **What it screens.** An unaddressed channel-root message from a person. A mention, which may not
  be ignored (§4.1), a reply in a thread, a report (§3.4), an agent's call and every webchat message
  reach the coordinator unasked.
- **The question.** `COORDINATOR_FILTER_QUESTION` in `packages/daemon/src/auto-session/coordinator-filter.ts`
  asks whether the agent, described by its name and description, should get involved with the
  latest message, judged with the conversation's earlier messages as the Decision gate reads them
  ([decisions.md](decisions.md) §8.2).
- **The verdict.** A message is skipped only when the probability of Yes is below
  `COORDINATOR_FILTER_SKIP_BELOW` (0.25); a less certain answer lets it through. An unavailable
  answer (no key, timeout, capacity, an invalid response) lets it through as well (decisions.md §5).
- **Where it runs.** The daemon asks when the message is queued for its coordinator and holds the
  queue entry on the answer, so evaluations overlap while the queue keeps arrival order. A skipped
  message settles as an ignored one does (§4.2 (c)): no 🤔, no turn, no reply. It stays in the
  conversation's record, where `recall` and later evaluations read it, but no later batch delivers it.
  A skip that finds the coordinator idle opens no turn.
- **Visibility.** Each verdict is logged by message id with its probability or failure reason, and
  recorded in the daemon's `coordinator_filter_evaluation` table in the shape of a gate verdict:
  `triggered` let the message through, `skipped` kept it from the coordinator, `unavailable` let it
  through without an answer; `decisionId` is `coordinator-filter` and the title is the message's
  first line. The agent's editors read them under **Recent evaluations** beside the filter on its
  Configuration card, through `GET /agents/:id/coordinator-filter/evaluations` and `…/:seq`, which the
  Control Plane proxies from a daemon advertising `coordinator-filter-evaluations-v1` without storing
  them. The detail shows the question, the message and conversation judged, the answer and the
  provider JSON; it goes after 24 hours or 20 newer verdicts of the agent, the summary after seven
  days. A replayed message keeps its first record.
- **Rollout.** The daemon advertises `coordinator-filter-v1`; the console offers the filter only where
  the agent's daemon does. An older daemon ignores the field and runs no filter.

## 5. Tools

### 5.1 `sendMessage` task actions

The existing names stay, with `messageId` added (`SEND_MESSAGE_ACTIONS` in
`packages/daemon/src/mcp/ops/send-message-actions.ts`):

- `delegateTask {title, message?, messageId?}`: `message` or `messageId` is required.
  - With `messageId`: a threaded task. It receives the original message as it arrived (sender, text,
    attachments); `message` is the coordinator's background. It works in the message's thread; a
    task that makes a Slack code channel for its work moves into it (§6.8).
  - Without: a background task, as today. The coordinator's tool always names a message, so its tasks
    are always threaded (§6.6).
  - `title` is required and shown in the console and in `listTasks`.
- `messageTask {taskId, message?, messageId?}`: with `messageId`, hands that platform message to the
  task and attaches its thread (§6.4), or moves it into the task's own conversation (§6.8).
- `stopTask {taskId}`: stops a task's current turn, either kind. The coordinator is not offered it
  yet; `!stop` in a task's thread stops a threaded task (§8), and the console stops either kind.
- `replyToMessage {messageId, message}`: the coordinator's own reply, in the message's thread. The
  coordinator reads only an attachment's name, so the daemon refuses this for a channel message that
  has one; a task receives the file itself. A report is exempt, since no task can take one.

`messageId` names a platform message the coordinator received, so calls carrying it, and
`replyToMessage`, are the coordinator's alone.

Only the coordinator delegates (decided 2026-10-30). No other session is offered `delegateTask`,
`messageTask`, `listTasks` or `stopTask`, and the daemon refuses them there: Per thread, Single
session, an ordinary webchat session, and a task of either kind.

- An assistant-mode place's session that is not a coordinator, such as a DM on a platform whose DMs
  never run Auto or a webchat conversation, keeps `messageTask`, `listTasks` and `stopTask` for what
  assistant mode gives it: its follow-ups, its organization research and the approved proposals that
  report to it. A delegated task is not listed there, messaged or stopped.
- A task a session delegated before this rule runs and reports to that session until it ends. A
  person stops it from the console. The session is no longer reminded of it.
- `updateTask` stays a task's own (§5.3). `followUp`, `propose`, research, `callAgent` and
  `postMessage` are unchanged.
- The daemon applies the rule with its Auto switch on, which is the default. With the switch off,
  every session keeps the task tools of P1 (§6.3).

### 5.2 `listTasks`

A tool of its own, not a `sendMessage` action, and the coordinator's (§5.1). It lists the caller's
tasks, follow-ups and approved proposals included, and at most the 20 most recently active threaded
tasks. An assistant-mode place's session that is not a coordinator lists with it only its
follow-ups, research and approved proposals. Each entry: id, title, whether a thread is attached,
thread links, owner, last activity, whether it is running, and the task's summary with its update
time (§6.7); a follow-up, a task in watch mode, also its next check. The coordinator uses it to place a new message and to
answer "how is that going".

The coordinator's `listTasks {after?}` reads the work board ([assistant-mode.md](assistant-mode.md)
§5.18 ④): `here`, its own open tasks with the fields above, and `elsewhere`, the other places' open
tasks its batch may see, read only, with place, status, summary and thread links. A `here` entry also
carries its status as the board shows it: a follow-up's is `next <time>` while it waits and `running`
during a check. Each is a page of
at most 20 in the board's order, newest change first, continued by its own `nextCursor`, and access
is judged again on every page. Every entry also names the message its task was opened for and the pull
or merge requests it opened. Both lists hold open tasks only; a task's id is its key cut before the
agent's id where that names it alone, which every task tool takes beside the whole key.

`readTask {taskId, after?}` is offered wherever `listTasks` is. It reads one task, open or closed
within its window (§6.5), without waking it: its title, summary and `summaryAt`, mode and status, the
message it was opened for, the pull requests it opened with the follow-ups watching them, and a page
of its latest words, continued by a cursor. It is judged like `recall` of the task's place, with the
task's own sessions, for every person in the batch, on every page; a task they may not read is
answered as an unknown id ([assistant-mode.md](assistant-mode.md) §5.18 ④).

### 5.3 `updateTask`

`updateTask {summary, title?}`, a tool of its own. `summary` is required; the title changes only
together with the summary. Only a task calls it, for itself; both kinds can, and so can a follow-up's
check, to rename what it watches (§6.7). Its description says the title names what the task is doing
now and the summary's first sentence states the current status.

### 5.4 The coordinator's limits

- Only AgentConnect tools: `sendMessage` (the task actions and `replyToMessage`, plus `postMessage`
  and `callAgent`), `ignoreMessage`, `listTasks`, `readTask`, `recall`, memory, and assistant mode's
  follow-up tools.
  - `recall` keeps its parameters and the read rule, judged by every sender of the batch. Each excerpt
    carries its message id and, where the batch may read it, the task the message was handed to.
  - `postMessage` and `callAgent` run as they do in any session. `callAgent` always asks for an
    answer, which comes back as a report.
  - The place tools are those its place's long session is offered: `followUp`, `getToKnow`, `propose`,
    `remind`, `listReminders` and `cancelReminder`.
  - A batch can hold several people's messages and reports, so `followUp`, `getToKnow` and `remind`,
    which act for the person who asked, name that person's message by `messageId`. They act for its
    sender and answer in its thread; a report or an unknown id is refused.
- A read-only runtime mode and no workspace (an empty directory). Anything that needs work becomes a
  task.
  - Where that mode is a plan mode, the tools that end a plan wait for an approver nobody is, so the
    coordinator is never offered them (Claude Code's `ExitPlanMode` and `AskUserQuestion`, as for a
    check). Its prompt says the mode restricts native file and shell tools only, never its
    AgentConnect tools.
  - Its workspace isolation is always shared, so it never gets a checkout, a session pod or an
    executor of its own.
  - On the daemon's disk a coordinator on the agent's shared host opens in
    `<daemon root>/coordinators/<agent>`. An srt shim hides that directory, so under srt the
    coordinator always gets a host of its own. A host of its own (under srt, for a runtime with
    per-process MCP servers, in a microsandbox VM, or as a model-session host) launches in
    `<agent dir>/coordinator`, inside the directory a sandbox boundary admits. On the pool it opens in `.agentconnect/coordinator` on the
    agent's pod volume, made through the pod's files once the pod is bound. Where none of these can be
    made, it opens in the agent's directory with no workspace roots.
- An ACP session with the coordinator's own prompt, on the agent's coordinator model
  (`coordinatorModel`: runtime, model, effort and Fast mode), apart from the task model.
  - Unset is Default: the agent's runtime at low effort, on the newest small model that runtime offers
    (Claude Code's Haiku, Codex's terra tier), else the task model. `defaultCoordinatorModel` in
    `packages/protocol/src/coordinator-model.ts` is the one rule the daemon and the console both read.
  - It has no approval setting: it runs in the runtime's read-only mode, else its auto mode, else the
    runtime's own. Read-only restricts native tools only, so memory and the AgentConnect tools still work.
  - Claude Code's plan mode runs Haiku as Sonnet, so a Claude Code coordinator runs in `default`
    instead. There sandboxed Bash runs without asking, so it is offered no shell, file-writing or
    sub-agent tool at all, and the daemon refuses whatever else asks, as it does for a check; its own
    AgentConnect tools are granted before that. The other runtimes keep their read-only mode.
  - A Decision that picks the task model never picks the coordinator's.
  - Each turn runs the coordinator on its setting's runtime and applies its model, effort and Fast
    mode, so a change reaches a running coordinator at its next turn. Its runtime is never pinned on
    the session: a chosen runtime holds when the agent's runtime changes, and Default follows the
    agent's.
  - A changed runtime opens a runtime session there, which replays the conversation's latest
    messages (at most 50, with its own replies) because the runtime cannot load the old one; changing
    an agent's runtime does the same to its sessions.
  - The console sets it in the agent's model picker, under a Task | Coordinator switch above the
    providers; with the task model By decision, it is a Coordinator field of its own.
  - A conversation changes its own coordinator's model, effort and Fast mode within its runtime, as a
    task's thread changes the task: under `chatActions: settings`, the composer of a member's coordinator
    conversation sets the coordinator session's overrides, which win over the agent's coordinator model.
    It shows no approval. Changing the agent's coordinator model clears every coordinator's overrides,
    so the new setting reaches each conversation at its next turn.

## 6. Tasks

### 6.1 Storage

Tasks live in the existing persistent parent–child index
(`packages/daemon/src/store/assistant-subsessions.ts`), which gains a title, a summary and attached
threads. A row's `mode` tells a task in work mode from a follow-up in watch mode, which keeps its
schedule (`nextAt`) on the same row ([assistant-mode.md](assistant-mode.md) §5.18 ⑤). The thread-to-task attachment can extend the
thread participation record of [channel-session-mode.md](channel-session-mode.md) §6.4.

### 6.2 The two kinds

The rules follow from whether a thread is attached; there is no separate switch.

| Aspect           | Threaded task                                                                        | Background task                                |
| ---------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------- |
| Coordinate       | Platform threads, one or more, or a room of its own (§6.8)                           | `subsession:<id>`, never posts to the platform |
| Who talks to it  | Anyone in its threads; the parent through `messageTask`                              | The parent only                                |
| Where results go | Into its threads; a run ended in a channel it holds is reported to the parent (§6.8) | Reported to the parent each round (today)      |
| Permission cards | In its own thread                                                                    | As today                                       |
| Concurrency cap  | Not counted in `maxConcurrentSubsessions`                                            | Counted                                        |
| Owner            | The sender of the message it opened for; later messages keep it                      | The parent's owner                             |

Both kinds inherit the parent's visibility and refuse changes to it. A background task follows
its parent both ways: tightening the parent tightens it, and widening widens it
([session-visibility.md](session-visibility.md) §4.5). A webchat coordinator's task is the
exception (§10).

`maxConcurrentSubsessions` bounds the tasks an agent opens by its own decision. On a daemon whose
Auto switch is off, a session's `delegateTask` opens a background task with no person's message
behind it, any number in one turn, and the cap is what stops that. A threaded task does not open
that way: the coordinator opens one only for a person's message delivered in the turn, and a thread
belongs to one task (§5.1, §6.4), so a message opens at most one; an approved proposal opens one
per approval (§6.9.1). People's messages and approvals bound it, which is all that ever bounded a
Per thread session, so it stays outside the cap. Organization research and an approved proposal
with no home (§6.9.6) run as background tasks and are counted (decided 2026-11-11, #3970).

- A background task's coordinate and lineage already tell the Control Plane that it is a task.
- A threaded task is a session on a platform thread. It is classified as any session there is, which
  in the coordinator's conversation is the coordinator's audience. Its daemon reports
  `taskParentSessionId` on `EventSession`: the session that owns it now. It sends this when the task
  opens, is adopted on a switch into `auto`, or is handed to a new coordinator by `!new`, and sends
  `null` when the task is released on a switch out or closes after 7 idle days.
- While the field is set, the Control Plane refuses visibility changes to the session and lists it
  among the owner's child sessions, and the task's page names that owner as its parent
  ([session-visibility.md](session-visibility.md) §4.3).
- Becoming a task never widens a session that its sender made private earlier. The lock only keeps
  its audience from changing while the task belongs to the coordinator.
- A move is a hard cutover, and a coordinator and its tasks stay in the store that holds them. At
  the source's cutover a daemon on a store of its own retires the agent's coordinators and closes
  their threaded tasks, so a later move back revives neither. Once the placement commits, the
  Control Plane releases the lock of every task whose store the new placement does not share,
  since no daemon left serving the agent can report it. A shared store keeps both for the next
  member. The source's tasks stay readable: the Control Plane sends a conversation's task reads to
  a daemon holding its store, which answers them for an agent it no longer serves, and offers no
  Stop on them.

### 6.3 Nesting

One level: only the coordinator opens tasks (§5.1), and a task opens none, threaded or background.

A daemon with its Auto switch off keeps the two levels of P1: a task an ordinary session opened may
open background tasks of its own, and those may not open more.

### 6.4 Several threads

A threaded task can hold several threads, one more for each `messageTask` with a `messageId`. A
message in any of them reaches the task, and the answer goes to the thread it came from (the delivery
coordinate is unchanged, [channel-session-mode.md](channel-session-mode.md) §3.1).

### 6.5 Lifetime

A threaded task lives as long as its session: when the session ages out after 7 idle days, the task
closes and leaves `listTasks`. A later reply in its thread is an unowned-thread message and goes to
the coordinator, which may open a task again, under the same id. A follow-up lives until it is done or
stopped, however long it waits between checks. A closed task of either kind keeps its row, marked
closed, which `readTask` reads and nothing else lists; the store's retention sweep deletes it 90 days
after it closed.

### 6.6 Coordinator tasks are threaded

Every task the coordinator opens is threaded from its first round: its `delegateTask` always names a
message (§5.1), and the task holds that message's thread, or in webchat the message's id (§10). The
coordinator opens no background task, so no task of the coordinator ever changes kind (decided
2026-10-30). A background task is one a session opened on a daemon whose Auto switch is off (§6.3).

### 6.7 The task summary

A task keeps its own summary with `updateTask` (§5.3), which the coordinator reads in `listTasks` to
place new messages.

- **Content**: fixed parts set by the task's prompt, at most 500 characters: the status (in progress,
  waiting on someone, done or blocked) in a first sentence that stands on its own, since a short list
  may quote only that sentence, then the scope (what the task is about, the coordinator's main
  signal), and the next step and open questions.
- **When**: the prompt asks for an update in any turn where the scope or status changes. As a
  backstop the daemon adds a reminder before the first turn's message to call `updateTask` before
  replying, even if the task finishes in that turn. Later turns keep the reminder when a task has
  no summary or its summary is 5 turns old. No extra model call writes summaries.
- **Before the first summary**: `listTasks` shows the title and background the coordinator gave
  (`delegateTask`'s `message`).
- **Title**: it names what the task is doing now. The task changes it with the summary when the work
  moves on to something it no longer names, and the stale-summary reminder says so; the coordinator's
  title is only the first one. A new title changes the work board.
- **A follow-up**: its summary is its last check's result, which `recordCheck` writes, and before its
  first check `listTasks` shows what it was taken with. Its title names what it watches; a check that
  a message moved to something else renames it with `updateTask`. It gets no stale-summary reminder.
- **Storage**: the summary is conversation content, so the Control Plane does not store it. It lives
  in the daemon's task index (§6.1), and the console's Tasks tab reads it through the BFF from the
  owning daemon, as transcript reads work.

### 6.8 A task in a conversation of its own

A task the coordinator opens for a message works in the message's thread on every platform (§6.4).
On Slack it may move into a native code channel ([slack-code-channels.md](slack-code-channels.md)),
but only when it makes one for its work: the coordinator never asks the platform for a place. Until
the eighty-seventh revision of [assistant-mode.md](assistant-mode.md) the coordinator opened a code
channel for every delegated message, which made a channel of each small request and left the asking
thread with a link and no answer, since a task in a place reported nothing. The thread is the asker's
place; a channel is a workspace the task earns.

- **Creation.** The task calls its `createSlackCodeChannel` tool, as any Slack session may, when the
  work it was handed is the kind that wants a channel (several steps, edits, tests or a pull request,
  in the tool's own words) and the person did not ask it to stay in the thread; a quick answer never
  makes one. The tool's rules are unchanged: linked to the message the task is working on, keyed by it
  so a retried creation finds the same channel, privacy matching the message's conversation, its author
  invited, and open only to a sender who may have the agent make something new (a full member of the
  bot's workspace, the place write rule's `new` target). The `openTaskPlace` member leaves the daemon
  platform contract (`platforms/contract.ts`): `delegateTask` has no place to ask for.
- **Coordinate.** The task keeps its session. The channel becomes one more thread it holds
  (`slack:<channel>:<channel>`, attached as §6.4 attaches a thread), so a message in the channel
  reaches the task and is answered there, while the origin thread stays attached and is answered in
  place. The task's own words tell the thread where it moved; the coordinator posts nothing.
  The attachment records the creating turn's delivery thread for reports. Session-only wakes
  (capability settlement and PR feedback) use the latest turn's saved delivery channel and thread,
  while replies to agent messages use the sending turn's target saved with that message.
  These targets change only delivery; the task keeps its original session coordinates.
- **The first message.** Slack copies the linked message into the new channel. The copy reaches the
  task through the channel it holds, never a second session, and carries nothing new: the task already
  has the message, its title and its background. The daemon dispatches nothing itself. A message in a
  room keyed as one thread that arrives while the task's channel is still being attached waits for it,
  at most 30 seconds.
- **Not a place.** A channel a task holds is the task's workspace, not a place of its own: it is never
  onboarded (no getting-to-know task, no long session of its own, no coordinator), and a follow-up
  taken from a message there belongs to the task's own place, the conversation the task was opened
  in, where its reports and its board line go. A code channel made outside a task is unchanged here.
- **Routing.** A room its platform keys as one thread named after itself has no root, so it never runs a
  coordinator of its own whatever its mode: every message there keys on the channel's session, the
  task's while a task holds it. This also keeps a code channel made outside a task, or one whose task has
  closed, an ordinary code channel. `!new`, `!stop` and Slack's native Stop act on that session (§8).
  A message in a room a task holds passes the session source gate
  ([session-visibility.md](session-visibility.md) §4.1) as the task's own: it is judged as the
  conversation of the task's session, whose row keeps its binding to the origin.
- **More messages.** `messageTask` with a `messageId` moves the message into the channel a task holds,
  where the task answers, and links the channel in the message's thread ("Passed to [title](link)"); the
  thread is not attached, so a later reply there comes back to the coordinator. `listTasks` lists the
  task with the channel among its threads and the channel's link.
- **Reports.** A task whose answer lands where the asker's thread is not reports to its coordinator: a
  background task each round (§6.6), and a task holding a channel at the end of each run there, with the
  `<report id task kind title>` of [assistant-mode.md](assistant-mode.md) §5.18 ④ carrying the run's
  final output, delivered on its behalf, with its summary as a supplement. A summary is the task's own
  account of itself and is stale whenever the task did not update it as it finished, so the report
  carries what the run produced, as a background task's round report carries the round's output.
  The coordinator may relay it with `replyToMessage` in the thread that requested the channel,
  recorded when the channel was attached, or leave it. A task opened in thread A that makes its
  channel for work requested in thread B therefore reports to B. Older attachments without that
  record retain the task's recorded report thread. A task answering in the asker's own thread reports
  nothing, as before. A task running in the channel may also tell its origin thread itself with
  `postMessage`, since its turn's own reply goes to the channel: `sendMessage` refuses only the thread
  the turn is delivering to as the conversation it already answers, not the thread the session is
  keyed on. Such a post seeds no session, the task's own being that thread's.
- **Closing.** Archiving the channel, by a person or by the agent, closes the task: its threads go, its
  row is kept closed (§6.5), and its owner is cleared (§6.2). The relay forwards an archive with an
  `archived` flag, since a native Stop reaches the same channel coordinate. The task also closes after
  7 idle days (§6.5) and is released when its coordinator's conversation leaves `auto` (§3.5), judged
  by that conversation, not the channel's own mode.
- **Fallback.** When the installation lacks code channels, creation fails, or the sender may not make a
  channel, the task stays in its threads; nothing beyond the tool's own answer is shown.
- **Not here.** A background task (`delegateTask` without a `messageId`) never holds a channel, and
  neither does a thread session adopted on a switch into `auto` (§3.5): neither was opened for a
  message. A fallback task (§4.5) was, and holds a channel it makes as a delegated task does. The
  coordinator asking for a channel on `delegateTask` (a `place` parameter) is not done: the task that
  has the work decides.

**As shipped** (2026-11-02, #3567). Choices the text above leaves open:

- **One session in two conversations.** A message carries the channel of its session beside its
  thread (`sessionChannel`, read through `sessionChannelOf` beside `sessionThreadOf` wherever a session
  key, an inbox lane, a gate or a mute is built), so a message in a channel a task holds keys on the task's session in the
  origin conversation and is delivered, answered and recorded in the channel. Routing looks a room
  keyed as one thread up among the agent's held threads before it reads the room's mode, and a
  command typed there (`!new`, `!stop`, `!queue`) acts on the task's session the same way. A message
  is steered into a running turn only when that turn answers in the message's own channel, so a
  message in the channel waits for a turn of its own there rather than being answered in the origin
  thread, and the reverse.
- **The attach.** `createSlackCodeChannel` hands the channel it made to the daemon through the
  session tool environment (`makeRoom`), never through the platform contract, and the daemon attaches
  it to the calling session's task when that task was opened for a message; a thread session adopted
  on a switch into `auto` was opened for none, so its channel keeps its own session as outside a
  task. A channel the tool finds the origin already in is not attached again. The wait is per agent:
  a message in any room keyed as one thread waits while one of the agent's rooms is being attached.
- **Not a place.** A join of the agent's bot to a channel a task holds takes no getting-to-know task
  and no introduction on join; the join waits, as a message does, while the channel is being
  attached. `gettingToKnowPlaceRefusal` refuses such a channel (`task-workspace`), so a getting-to-know
  task taken for it before the attach landed ends unread, and a report that would open the place's
  long session opens none there: no coordinator or appending session is minted for it. A follow-up
  taken in a run there gets the task's place, as every tool of the task's session does
  (`placeOfSession`), and replies in the thread the task holds there, the one it was opened in.
- **A fallback task.** The task index records a fallback task as opened for its message, as it records
  a delegated one ([assistant-mode.md](assistant-mode.md) "Opened for"), so the attach holds a channel
  it makes with no rule of its own.
- **The report.** It is sent when a turn delivered in a channel the task holds ends, completed or
  failed, and no message of the task's waits behind it; a turn stopped there reports nothing. It
  opens with `[task run] Task "<title>" ended a run in its channel (<link>).` and carries the last
  turn's final output, delivered on the task's behalf, or says that the run ended without one or
  stopped there before finishing; then `Its summary: <summary>` follows on one line when the task has
  written one. The final output is the one a background round's report takes, the turn's reply with
  nothing interrupted and no sentinel, uncapped, so the report costs the coordinator's next turn the
  output once per run. It rides as any report does, one per run and answered in the thread the task
  was opened in. A report the coordinator does not admit is logged, not retried. The task's standing
  instructions say that the coordinator gets its summary at the end of each run there, so it keeps
  that summary current.
- **The tools in the channel.** The Slack tools that default to "this conversation"
  (`setSlackCodeView`, `manageSlackCodeChannel`, `presentSlackReport`) and `getCurrentChannel` act in
  the channel of the turn, and the code channel's native session controls follow the turn there.
  The automatic Code diff is published from a turn delivered in the channel, against the base branch
  each repository was cut from ([slack-code-channels.md](slack-code-channels.md#automatic-task-diffs)),
  so a task that takes a channel days after it opened shows its branch's work and not what landed on
  the base branch since. A repository without a base branch falls back to the starting point the task
  kept on its first turn, in its origin thread; one that already had changes then keeps none, as anywhere.
  The channel's Tasks tab shows the session of the task that holds it, with that session's tasks,
  background work and console link: no session is keyed on the channel, so the read takes the
  session the task index names as the channel's holder. The code channel's standing context is not
  added to a task whose session opened elsewhere.
- **Earlier tasks.** A task the coordinator opened in a code channel before this change keeps the
  channel's session as its own and routes as before; nothing migrates.

### 6.9 A home for every task

> Status: Built (§6.9.1, §6.9.2, §6.9.5), on a platform with approval cards and in a member's
> webchat coordinator conversation. Proposed, not built: read-only tasks (§6.9.3), where
> [assistant-mode.md](assistant-mode.md) §5.9 describes what runs.

**Why.** In one coordinator's channel, a getting-to-know report and one approved proposal left five
top-level messages within four minutes: the introduction, two proposal cards, the approved
proposal's result, and the coordinator's relay of that result. People then replied under the result.
The approved proposal had ended and held no thread, so those replies went to the coordinator, which
opened a second task to act on what the first one found. The console listed the first under
"Background tasks", a group the coordinator's own tasks never enter (§6.6).

The two kinds of §6.2 differ in one thing: whether the task has a **home**, a thread in the place
where its people read it and write to it. Who talks to it, where its results go, how long it lives
and who owns it all follow from that. So work the place's people will read gets a home, and only
work nobody talks to runs without one.

#### 6.9.1 An approved proposal gets a home

This covers the task form of `propose` (assistant-mode.md §5.10) where the place's long session is
a coordinator: an internal room on a platform with approval cards, where a message's own id opens
its thread, and a member's webchat coordinator conversation. A platform 1:1 DM and a platform
without cards run it as before. The follow-up form runs no task and is unchanged.

| Where the proposal's card is                                                                                                                                                                                      | The task's home                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| At the place's top level, as a check's proposal is in a coordinator's conversation, with no task holding its thread                                                                                               | The card's thread: the card is the root                                         |
| In a thread (a place's long session that lives in one), at the top level with a task already holding its thread, or on no message of the place (webchat's pending requests, Activity, a DM the card fell back to) | A root the daemon posts at the place's top level when the task starts           |
| An external place, a place with no coordinator, or a root that could not be posted                                                                                                                                | None: it runs as today, on a `subsession:` coordinate that reports to its place |

- **The root the daemon posts** is one message as the agent: the proposal's sentence, who approved
  it, and a link to its card where the card is a message of the place. It is not a turn of the
  coordinator. A platform cannot nest a thread under a card that is already in one, and a thread
  holds one task (§6.4), so a card in a thread is never a home.
- **A card whose thread is taken.** Until the approval a card's thread is unowned, so a reply under
  it reaches the coordinator, which may open a task for it (§4.2). That task then holds the thread.
  The approval reads the task index in its transaction: a card whose thread a task holds is no
  home, and the daemon posts a root.
- **What it becomes.** A threaded task of the place's coordinator, opened for its root as
  `delegateTask` with that `messageId` opens one (§5.1): keyed on the root's thread, titled with the
  proposal's sentence, owned by the approver. Its record stays an approved proposal: the hash,
  approvers, expiry and settled states of assistant-mode.md §5.10 are unchanged.
- **Its kind.** It is a task like any other the coordinator holds, from its first turn: listed as
  a task with its thread, open on the board while it is indexed, `running` or `idle`, and
  addressed by `messageTask`. "Open only until its one run settles" of assistant-mode.md §5.18
  holds for a proposal with no home alone. Its record alone says it began as a proposal.
- **Who asks.** The approver owns the session, as the sender of the message a task opened for
  does (§6.2). The first turn's reads are still judged by the follow-up's askers, as an approved
  run's are today; a later turn's by its own sender.
- **Its first turn** takes the approved proposal's prompt, which now says its reply posts in this
  thread. The record settles from that turn as it settles from a report today: completed is
  `succeeded`, failed is `failed`, cut short is `outcome_unknown`.
- **Recognized by its turn, not its coordinate.** The reserved `subsession:task-` coordinate is
  how the daemon knows an approved run with no home: inbox replay removes its row instead of
  running it again, the turn's end settles the proposal, and its reads are judged by its
  follow-up's askers (assistant-mode.md §5.7 step 1, §5.10). A thread key says none of that. The
  first turn's metadata therefore carries the proposal's id (`approvedProposal`), persisted with
  its inbox row, and each of those reads it where it read the coordinate.
  - **Never run twice.** A replay after a restart or a handover removes a row that carries a
    proposal's id and settles that proposal `outcome_unknown`, as today. The daemon says so once in
    the task's thread. Later turns of the task carry no proposal and replay as any thread's do.
  - **Never steered.** A reply that arrives in the thread while the first turn runs is neither
    steered into it nor folded into a regenerated answer: it waits for a turn of its own, as a
    message on a task's page waits (§10). The hash binds the approved work, so nobody's message
    joins it.
- **Afterwards** it rests as any threaded task does (§6.5). A reply in its thread reaches it as an
  ordinary turn under its sender's own permission. The approval covered the first turn's work and
  nothing later: approving already grants only what asking in the place gets.
- **It reports nothing.** A task that answers in its own thread reports nothing (§6.8), so the
  coordinator has no result to relay. The work board and `readTask` carry its state.
- **The cap.** Like every threaded task it is outside `maxConcurrentSubsessions` (§6.2), so a full
  cap no longer refuses the approval. Each one starts on a person's approval.
- **The card** settles as "Approved by …" with where the task answers: this thread, or a link to
  the root.
- **Order of writes.** The decision is won before anything is posted, so a root never announces
  work that does not run.
  1. One transaction moves the record to `executing`, which is what serializes two decisions: the
     second finds it decided. Where the card is a free root, the same transaction opens the task on
     the card's thread and writes its first turn's row, as an approval does today. Otherwise it
     marks the record as waiting for a root.
  2. The daemon posts the root, once. A second transaction then opens the task: on the root's
     thread where the post returned and no task took that thread meanwhile, else on a
     `subsession:` coordinate with no home (the table's last row). A post that failed or timed out
     takes the second branch. A timed-out post may still land, as a card's may
     (assistant-mode.md §5.10); it then stands as an agent message whose thread is unowned, and
     its text, the sentence and who approved it, stays true.
  3. A record left `executing` and waiting for a root, by a crash between the two transactions,
     has started no work. The recovery sweep that already catches an approval cut before its row
     exists opens it with no home.
- **Webchat.** A proposal there has no card: it waits in the conversation's pending requests. Once
  approved, the root is the agent's own post at the conversation's root, the proposal's sentence
  and who approved it, and the task is keyed `webchat:<conv>:<rootPostId>:<agent>`
  (webchat-threads.md §5.2). The console draws it as that root's thread footer, and the task's
  answer and every reply are posts in that thread. A daemon whose Auto switch is off, which has no
  webchat threads, runs the proposal as before.
- **What its people read.** The first turn's message shows the work that was approved, as the
  proposal's task states it. The framing the model reads (who approved it, the follow-up it serves,
  the check to make first) is the model's and is not shown.
- **A card from before this.** A card's record says which thread it was posted in. One posted
  before that was recorded is never taken for a root, so its approval posts one.
- **Not in this change.** An approved proposal makes no code channel (§6.8): the tool links the
  message a task works on and invites its author, and this root's author is the agent.

#### 6.9.2 Getting-to-know cards under a coordinator

assistant-mode.md §5.13 holds a report round's cards until the round's reply has posted, and then
cards them in that reply's thread. Under a coordinator they go at the place's top level instead,
after the introduction, in the order proposed. **Built.**

A card in the introduction's thread can never be a home (§6.9.1), so approving one posted a root
elsewhere in the channel that linked back to the card, and the card could only say its task answers
"in a thread of the conversation". A card at the top level is the root itself: approving it starts
the task in the card's own thread, the card says so, and nothing else is posted. The cost is the
channel's top level: a join shows the introduction and up to three cards where it showed one
message, and a card that was denied or expired stays there as one line. Of the five messages the
channel above saw, the introduction and the two cards remain; the result and every reply to it are
in the approved card's thread.

- **Which places.** Where an approved proposal gets a home: a coordinator's room that is not one
  person's direct conversation. Every other place keeps §5.13's thread under the reply.
- **What the daemon reads the reply for.** The `replyToMessage` that answers a getting-to-know
  report is the round's reply, since a report's turn text is never posted (§4.3). The cards
  still wait for it, so the introduction comes first, and its thread is still what the task's row
  shows (below).
- **The card as a root in the console.** A card is no row of the conversation. When it becomes a
  root, the daemon records one for it under the card's id, saying what a posted root says: the
  proposal's sentence and who approved it. The coordinator's page then shows the root and its
  thread (§6.9.5).

**Shown with a home (built).** The thread of that first reply is also recorded on the
getting-to-know task's row (`shownThread`, on the wire `shownThreadId`), for display only: the introduction's own thread for a join, the asker's thread for a
requested one. The console then draws the task as one with a home (§6.9.5), and its row opens that
thread: the introduction and its replies. The thread is not attached to the task, which
ended with its one check and takes no message. It stays unowned, so a reply there reaches the
coordinator (§7), which holds the report. The row keeps it in a field apart from its attached
threads, so routing, `listTasks`' "thread attached", `taskParentSessionId` and the 7-day close
never read it. A round that posted no reply, as in an external place,
records none.

#### 6.9.3 Read-only tasks

`delegateTask` and the task form of `propose` take `readOnly: true`.

- **Why.** A proposal whose text promises to change nothing runs today in the agent's own
  permission mode, so the promise is the prompt's alone. The same holds when a person asks the
  agent only to look.
- **The profile** is a follow-up check's as shipped (assistant-mode.md §5.9, layers (a) and (c)):
  AgentConnect tools filtered to reads, the runtime's read-only mode, and the daemon refusing
  whatever asks for approval.
- **Only where the profile is complete.** On a runtime assistant-mode.md §5.9 marks degraded (no
  read-only mode, native tools that ask no permission, no sandbox) the native shell can still
  write, so `readOnly` is refused there: `delegateTask` and `propose` answer that this agent's
  runtime cannot hold a read-only task, and nothing opens. A check runs degraded because it
  promises nobody anything; a card and a board line that say read-only are a promise to the people
  who read them.
- **The code host.** A read-only task's session reaches its code host through the credential
  proxy at the read tier, whatever the agent's tier on the repository
  ([github-app-git-credentials.md](github-app-git-credentials.md), Phase 2): a write through REST
  or `git-receive-pack` is refused there, on every runtime. The proxy already resolves the session
  behind each request, so the task's row is where it reads the flag.
- **Residual.** The task runs on the agent's host, so the agent's other credentials stay within
  reach of whatever the runtime's read-only mode lets run. The credential-less host of that
  section's layer (b) would close that and is not part of this change.
- **What it still writes.** Its replies in the threads it holds, `updateTask`, and `propose`, as a
  check has: a read-only task that finds work to do offers it as a card in its thread, and the
  approved work is a new task with a home of its own (§6.9.1). It proposes at most once a turn,
  as a check does at most once a check. Where the place has no card surface the proposal waits in
  the console (assistant-mode.md §5.10), and the tool's answer tells the task to say so in its
  reply.
- **Where the flag lives.** On the task's row. A check's profile is chosen by its `subsession:`
  coordinate, and a threaded task's coordinate is its thread. The row's flag is applied on every
  turn, whoever sent the message, for the task's whole life. A reply in the thread cannot lift it;
  work that needs to write is another task.
- **Fail closed across versions.** Both layers read the row, so a daemon that does not know the
  flag would enforce neither. The daemon advertises a capability for it; `readOnly` is offered and
  accepted only where the agent's daemon, and every member of its set, advertises it; and a daemon
  refuses to run a turn of a row whose flag it cannot read, rather than run it writable.
- **Shown.** `listTasks`, the work board and the console's task row say read-only. A proposal's
  card says it, and the proposal's hash binds it with the rest of its arguments.
- **Limit.** The check profile refuses the agent's own MCP servers and any native tool that asks
  for approval. A read-only task therefore reads its place, the code host, memory and its
  workspace, and cannot investigate through a user MCP server. Admitting MCP tools that declare
  `readOnlyHint` is open (below).
- **Validation.** The coordinator's prompt gains one sentence on when to pass `readOnly`, and the
  runtime matrix (§12) a scenario: a request only to look is delegated read-only. Tool description
  sizes are measured in the change that adds the field, which also adds read-only tasks to the
  repository's threat model: the label is a security claim people will rely on.

#### 6.9.4 `getToKnow` stays

Folding a requested getting-to-know task into `delegateTask` with `readOnly` was considered and is
not done. What makes a getting-to-know task is not its permission profile but what the daemon holds
it to (assistant-mode.md §5.13): 30 days or 500 messages, reads of its own place only, a session
kept out of memory capture, memory writes in fixed shapes, one at a time per place, and a report
round with at most three cards. A read-only task has none of these, and a prompt cannot promise
them. A join needs the daemon-taken task whether or not a tool can ask for one, so `getToKnow` is a
short trigger for machinery that exists either way.

#### 6.9.5 Console

Built.

- **One group.** A parent's Tasks tab lists its work-mode tasks in one **Tasks** group, replacing
  §11's two. A row with a home carries its platform's mark and opens its thread; a row without one
  opens its page and folds into Finished once it ended. Follow-ups keep their own group.
- **A getting-to-know task is listed among Tasks**, not Follow-ups: it follows nothing, and is a
  follow-up only in how it is stored. While it reads it has no mark and opens its page. Once its
  introduction has posted it carries the mark and opens that thread (§6.9.2). A task's row may
  open a thread the task cannot be written to in, as this one does. The grouping reads the row's
  getting-to-know marker, since its mode is still watch.
- **No "background task" in the product.** A task's report and the instruction a task opened with
  carry no caption in the transcript: the line named no task, and a task's thread and card carry
  none either. Another agent's message or reply keeps its caption, which names that agent, and
  shows none for a sender known only by its id. This document keeps the term for the rules of §6.2.
- **Long session messages fold.** A report, a task's instruction or another agent's message shows
  its first six lines in the transcript, with the toggle that opens the rest directly below them.
  Before, the whole body showed and the toggle sat under it, a screen or more down for a
  getting-to-know report.
- **A delivered message is not the agent's speech.** A report in its coordinator and the work
  handed to a task are rows of the session's own agent, so they were drawn as prose the agent said,
  unfolded. They are drawn as a bubble on the agent's side, folded as above; what the agent says in
  answer follows as prose. The work handed to a task in a webchat thread is also posted live in
  that thread, where it showed at the conversation's root until a reload.
- **The agent's own root carries its thread's footer.** An approved proposal's root and a
  getting-to-know introduction are the agent's posts at the root. Each is drawn with the footer of
  the thread under it, its task's card and its replies line, as a person's root is.
- **The agent's posts on a platform are rows of its conversation.** A coordinator's reply and an
  approved proposal's root are recorded in the coordinator's conversation under the id the platform
  gave the post, as its webchat posts already were; one at the top level is the root of its own
  thread. Before, the page showed neither until something read the thread back from the platform,
  and a getting-to-know row opened a thread the conversation did not have.
- **A getting-to-know report shows the report.** The long session reads what to do with the report
  ahead of the report itself. People read the report; that guidance folds with the message's facts,
  where before it filled the six lines shown.
- **A thread whose task is starting is re-read as often as a running one.** Its panel says the task
  is starting until the task's session exists, which is seconds. Two things kept the notice up far
  longer. The read was on the idle interval. And the console's polls gave their interval as a
  function, which the polling library takes for a new interval on every render and restarts its
  timer for; a conversation with a live turn re-renders more often than any interval, so the thread
  was not re-read until the conversation went quiet. The thread's record, a task's row and a
  conversation's task list now poll on an interval that changes only when what they poll does.

#### 6.9.6 What still runs without a home

A follow-up's checks, which nobody talks to; a getting-to-know task, which is only shown with one
(§6.9.2); organization research; an approved proposal of an external place, where a root would show
the place's guests work that was approved elsewhere; and the tasks of a session on a daemon whose
Auto switch is off (§6.3).

#### 6.9.7 Order and open questions

1. The console changes (§6.9.5) and the card fix (§6.9.2), each on its own.
2. Homes for approved proposals (§6.9.1).
3. Read-only tasks (§6.9.3).

Open:

- Whether a read-only task may call a user MCP server's tools that declare `readOnlyHint`. The
  hint is the server's own claim, so it is not enough alone; the likelier form is an
  organization's allow per server.
- Whether an approved proposal with a home may make a code channel, with the approver in the
  author's place.
- How often `getToKnow` is called. If almost never, the tool's description is a cost every
  coordinator session pays for nothing, and §6.9.4 is revisited.

## 7. Thread routing

| Thread                     | Goes to                                                          |
| -------------------------- | ---------------------------------------------------------------- |
| Attached to a task         | That task, without the coordinator                               |
| Unowned                    | The coordinator, which may still open a task for the thread      |
| A room keyed as one thread | That room's one session, the task's while a task holds it (§6.8) |

## 8. Commands

| Where           | `!new`                                                               | `!stop`                       |
| --------------- | -------------------------------------------------------------------- | ----------------------------- |
| A task's thread | Restarts the task's session in place (Per thread's `!new`)           | Stops the task's current turn |
| Root            | Resets the coordinator (Single session's new coordinate); tasks stay | Stops the coordinator's turn  |

- **In a task's thread**, any of its threads: the commands act on the task's session, as Per thread's
  do, so `!stop` also mutes the task until someone mentions the agent there.
- **`!new` at the root** hands the coordinator's threaded tasks to the new coordinator, which lists
  them and hands messages to them; their threads keep reaching them. A turn still running on the old
  coordinator, and the messages queued behind it, act for the new one: they list the same tasks, and a
  task they open belongs to the new coordinator.
- **`!stop` and `!cancel` at the root** mute nothing and keep the messages queued behind the stopped
  turn: they are other people's messages, and the next turn decides them (§4.3). The stopped turn acts
  on none of its messages (§4.5).
- An unowned thread routes to the coordinator (§7), so a command there acts on the coordinator too.
  At a root with no coordinator yet, a command finds nothing rather than an older thread session.
- A platform's own "new chat" gesture (Slack's Assistant thread) is a root `!new`: it starts a new
  coordinator, which takes the threaded tasks over. A conversation with no coordinator yet mints none.

## 9. Several agents

Each agent has its own coordinator, and each decides independently. The prompt lists the other
agents in the conversation, by name and description, so a message for one of them is recognized as
not addressed to this agent. Cost grows with the number of agents.

The list holds the agents that answer in the conversation. An agent whose bot has left it is no
longer listed, and neither is a paused agent: a coordinator that still deferred to one would leave
it messages no one takes. A daemon reads the pause state of its own agents from their specs, and of
another daemon's agents from the peer directory, which the Control Plane pushes again when an agent
is paused or resumed. The list is part of the session's standing instructions, so a coordinator
already running takes the change on its next turn, with no `!new`.

## 10. Webchat (the console home and playground)

- Opening an agent from the home page or the playground enters **that member's private coordinator**
  with the agent, like a DM.
  - Its conversation id is derived from the organization, the member and the agent (a version 5
    UUID, `coordinatorConversationId` in `packages/protocol`). The Control Plane creates the
    conversation when the console mints with the `coordinator` flag, and the daemon recognizes it
    from the first turn's author, agent and organization, then from its recorded coordinator
    coordinate, so neither the relay nor the Control Plane's schema carries a marker. It takes no
    other agent participants. Resuming it uses the same `session.continue` policy as any webchat
    conversation: private sessions stay owner-only; once shared with the organization, members
    other than viewers may send messages at its root and in its threads under their own identity.
  - Its owner may publish it to the organization or pull it back, as with any owned webchat session,
    and every descendant session the owner owns follows both ways. A channel's coordinator stays the
    conversation's (channel-session-mode.md §9).
  - Its owner may also change any of its tasks on its own, wider or narrower than the coordinator.
    That task is then independent: later changes to the coordinator skip it and everything below it.
  - It has threads, as a Slack channel does ([webchat-threads.md](webchat-threads.md)). A message at
    the root, or in a thread no task holds, goes to the conversation's coordinator coordinate; a
    message in a thread a task holds goes to that task (§7). Every message counts as addressed to
    the agent, so one left without an outcome opens a task (§4.5). A message's id is its webchat
    post id, and its thread its root's post id.
  - Each message runs as a turn of its own, never batched (§4.3's one-message form): its text streams
    to the browser and stays in the main conversation. `replyToMessage` is the coordinator's own post
    in the message's thread.
  - The coordinator's prompt names the place a console conversation its owner may share, with threads: a
    task answers in the message's thread, and the text the coordinator writes is shown as it writes
    it, so that text is its reply and holds nothing else.
  - It runs over the legacy webchat protocol; an AHP conversation stays an ordinary one for now.
- New session opens an **ordinary webchat session** without the coordinator, as today.
- Every task's page accepts messages (today it is read-only), for whoever may continue the parent,
  where the daemon advertises `task-page-messages-v1`, which its Auto switch also turns on.
  - A threaded task's page is its thread's session, which the console already continues. A background
    task's coordinate is no platform thread, so its page continues it console-only: nothing is mirrored
    to the platform, and the answer streams to the page.
  - The page is where every round of such a task shows, whoever started the round: a file the task
    shares lands on the page as a card or chip, and a message a person types there is that person's,
    for memory and for the read rule alike
    ([agent-authored-attachments.md](agent-authored-attachments.md) §3.2).
  - The Control Plane judges the composer, the token and every dial by the parent session's audience.
    A task without a recorded parent of its own agent stays read-only, and so do a follow-up's checks,
    an approved proposal and research.
  - A person's message waits for the task's running turn and runs as a turn of its own, so it is never
    steered into a round whose output goes to the parent. A round still open reports to the parent as
    usual; a settled task's parent hears nothing, since the person read the answer on the page.
  - The task's standing context says people may write to it from its page.
- A task the coordinator opens for a webchat message is a threaded task on the message's thread,
  keyed `webchat:<conv>:<rootPostId>:<agent>` (webchat-threads.md §5.2): it opens with the thread so
  far, the coordinator's answers included, answers in the thread with posts of its own, and a reply
  in the thread reaches it directly. The coordinator posts no link card for it; the console draws
  the task in its thread's footer under the root (webchat-threads.md §6.1).
  - Whoever may continue the coordinator writes to it from its page or its thread's panel, where the
    daemon advertises `webchat-threads-v1`: the message is a reply in the thread it names, or the
    task's own, among the threads the task holds, and runs on the task's session console-only, as a
    background task's page does (webchat-threads.md §6.3). The root and threads no task holds reach
    the coordinator under the same continuation policy.
  - The console draws the conversation in Slack's shape: roots with their threads' footers, thread
    replies only in the thread, the coordinator's turns in the main timeline with "In thread: …" on
    one that answered a reply, and `replyToMessage` as one line "Answered in the thread". A footer,
    a label, that line or Reply in thread opens the thread in the side panel at `?thread=<rootId>`,
    where authorized members write in it on the conversation's own socket. A task's page returns to the
    coordinator through Back or Close. On a desktop, a thread whose first reply starts while the
    owner watches opens by itself (webchat-threads.md §6).
- Before webchat had threads, a task the coordinator opened for a webchat message continued on its own
  page, which is its conversation. Such a page task keeps running as described here until it closes,
  and a message without a post (such as an MCP app's) still opens one; webchat-threads.md §10
  retires the rest. This replaced an earlier plan in which each task had its own webchat
  conversation (decided 2026-10-30).
  - `delegateTask` with a `messageId` opens the task on a background coordinate of its own
    (`subsession:<id>`, off the conversation's channel, as a background task of a webchat session
    is) and attaches the message's id as a thread from the first round. The task therefore follows
    the threaded rules: it never reports to the coordinator and is outside the concurrency cap. It
    receives the original message, records the coordinator as its parent, and is told that its
    person reads it on its page.
  - The coordinator posts a link card: an agent post with a Markdown link, titled with the task's
    title, to the task's page. The post and its transcript row also carry `taskLink` (the task's
    session id, title, and whether the task was opened or handed the message). The console draws a
    post that carries it as the task's card. A click on the card or its replies opens the task's
    thread in the coordinator's side panel, as the Tasks list does, where people read and reply; a
    modified click or the panel's task-page link opens the task's own page: the same page a direct link
    lands on, with Back and Close returning to the coordinator, the task's Files, Git, Tasks and
    Computer, and what the coordinator opened it with folded at the top. The card shows the task's
    `replies`: the messages its people and the task posted after the one that opened it, which the
    daemon counts. A coordinator on a
    platform with threads posts no link card, so its task row carries `openedForMessageId`, the
    platform id of the message it was opened for. The console draws the card under the
    coordinator's turn that answered that message, once per task, on a platform whose module declares
    no thread shape; where it does, the root's thread footer carries the task instead (§11).
  - `messageTask` with a `messageId` moves the message into the task's conversation, which answers on
    its page, and attaches its thread as one more; the coordinator posts a link card in the message's
    thread.
  - A link card arriving while the person watches opens its task's thread in the dock, the latest
    one when several arrive; cards already in the conversation when the page opened do not.
- **Administration.** The conversation's AgentConnect admin MCP entitlement
  ([webchat-preset-agentconnect-mcp.md](webchat-preset-agentconnect-mcp.md) §5.4) installs nothing on
  the coordinator, which only routes, and installs its own grant on each task it opens, so a
  request to change the configuration is delegated and done by the task. A write the task asks for
  waits for approval on the task's thread, and the decision is a notice to the task.
- Existing ordinary webchat conversations stay as they are.

## 11. Console

- The agent's model picker sets the coordinator under its Coordinator tab (§5.4). Below the
  runtimes, a **Filter** group lists the Decision providers whose models can answer the filter's
  Boolean question where the agent runs, each with its model count; a provider lists its models and
  **No filter** (§4.7). The coordinator model is required and the filter is an optional addition to
  it, never a replacement: the runtime holding the coordinator model and the provider holding the filter
  are each marked as chosen, the coordinator's settings stay shown while a filter is browsed, and only
  the runtime list scrolls, with the Filter group kept in view below it. TypeSafe is named **Jev** there, after its models. The group reads the
  providers of the placement chosen: in the Add dialog the machine, group or pool picked, sent with the
  new agent only while that placement still offers the model; in the Edit dialog the agent's current
  placement, while it stays there. Either way it shows only where that placement's daemon advertises
  `coordinator-filter-v1`, and never while the coordinator is off. **Disable coordinator** ends the
  runtimes' model list (§3.6). The agent's Configuration card names the filter under the coordinator.
- The session-mode menu gains Auto beside Per thread and Single session, where the conversation's
  consumer's daemon reads it and outside By decision and shared-bot routing; a group DM row offers it
  too (§3.2).
- The session list labels the coordinator; tasks show their title and link to their parent. A
  threaded task's page names its coordinator once, among its related sessions, from the Control
  Plane's record of the owner (§6.2).
- A parent's Tasks tab lists all its tasks in one group, a task with a thread wearing its
  platform's mark (§6.9.5).
- A coordinator's page takes its platform's thread shape where the web platform module declares one
  (`WebPlatformModule.threadShape`; webchat's is core's own). On Slack it reads the coordinator's
  roots with their threads' footers, keeps thread replies in their threads, labels the turns that
  answer them, and opens a thread's whole record beside the page at `?thread=<ts>`, linked to the
  thread in Slack. In a held thread the composer continues the task as its page does, mirrored into
  the Slack thread. In a thread no task holds, and from Reply in thread on a root, whoever may
  continue the coordinator writes there too: the message is mirrored into the Slack thread, then
  routed as any reply in it, to the coordinator with its thread named or to a task holding the
  thread by then. A Slack task's page returns to the coordinator through Back or Close
  (webchat-threads.md §7). Other platforms keep the flat transcript.

## 12. Validation

`packages/daemon/test/acp-matrix/coordinator-probe.ts` injects a candidate coordinator prompt and tool
surface (`sendMessage` with `delegateTask`, `messageTask` and `replyToMessage`, `ignoreMessage`, `listTasks` with
its `here` and `elsewhere` lists, and `readTask`) into a real runtime session over an HTTP MCP fixture, opens each
turn with the work board the daemon would send ([assistant-mode.md](assistant-mode.md) §5.18),
delivers channel messages in the format of §4.3, and judges each message's outcome. Its scenarios:
new work, a message for an open task, a status question, a greeting, chatter between people, a
request to another agent, a thread follow-up for another app's bot (`ignore-other-bot-thread`), twelve turns of messages that are not for the agent in one session before a greeting that is (`ignore-streak`), a vague mention, a small edit the coordinator must not do itself, two mixed
batches, a follow-up's report (§3.4), a batch of one message and two reports, one worth telling
and one with nothing new, a request for work another channel's task already has open, a question
about another channel's task that only its latest words answer, a run report from a task holding
its code channel (§6.8), and
in a webchat conversation (§10) new work, a status question, a message for an open task, a status
question about another channel's task and a follow-up asking for work in a thread no task holds
(`webchat-thread-follow-up`, [webchat-threads.md](webchat-threads.md) §11). That scenario and the
threaded webchat prompt have not been measured on a runtime yet; they are watched on the test
environment.

```bash
AC_RUNTIME_MATRIX_ONLY=coordinator AC_RUNTIME_MATRIX_TARGETS=claude-acp,codex-acp \
  pnpm --filter @agentconnect.md/daemon test:runtime-matrix
```

Results on 2026-10-29 (scenario passes per runtime, repetitions included):

| Runtime                 | Passed                  | Notes                                                                                                                                                                                                                                               |
| ----------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-acp`            | 30 / 30 (3 repetitions) | Only `ToolSearch` besides the coordinator tools                                                                                                                                                                                                     |
| `codex-acp`             | 30 / 30 (3 repetitions) | Only its auto-review besides the coordinator tools                                                                                                                                                                                                  |
| `cursor`, `opencode-v2` | 10 / 10                 |                                                                                                                                                                                                                                                     |
| `opencode`              | 9 / 10, 1 degraded      | Handed a status question to the task instead of answering it                                                                                                                                                                                        |
| `github-copilot-cli`    | 9 / 10, 1 degraded      | Tried an empty `replyToMessage` before ignoring a message for another agent                                                                                                                                                                         |
| `qoder-cli`, `qoder`    | 9 / 10 and 8 / 10       | Replied to a message for another agent; `qoder` also answered "morning all"                                                                                                                                                                         |
| Not measured            | —                       | `dsh-acp`, `omp`: provider balance; `grok-build`, `kimi`: not signed in; `antigravity-acp`: adapter missing; `qwen-code`: every turn fails with an internal error; `devin`: its MCP calls never reached the fixture; `cline`, `pi-acp`: no HTTP MCP |

On 2026-10-30 the shipped prompt and tools (`packages/daemon/src/auto-session/coordinator-prompt.ts`)
passed 30 / 30 again on `claude-acp` and `codex-acp` (3 repetitions each); the other runtimes were not
rerun. The same day, with reports, `postMessage`, `callAgent` and the place tools added to the prompt
and the report scenario added to the probe, both passed 33 / 33 (3 repetitions each); every report was
answered with `replyToMessage` naming the PR it reported. After the place tools came to name their
message by `messageId`, `codex-acp` passed 33 / 33 again and `claude-acp` 32 / 33. Its one failure was
an `ignore-chatter` turn that timed out after 180 s with no call; that scenario passed 3 / 3 on a rerun.
On 2026-10-31 the webchat form of the prompt (§10) passed its three scenarios (`webchat-new-work`,
`webchat-status`, `webchat-route`, which also fail any text shown beside a call) 9 / 9 on `claude-acp`
and on `codex-acp` (3 repetitions each); the channel prompt was unchanged.
On 2026-11-01, with the work board (assistant-mode.md §5.18), every scenario opened with the board
the daemon sends and `listTasks` answered `here` and `elsewhere`; two scenarios were added:
`elsewhere-duplicate`, a request at the channel root for work another channel's task has open, and
`webchat-elsewhere-status`, a status question about that task in a member's webchat conversation.
`claude-acp` (on Claude Opus 5.5) and `codex-acp` each passed 48 / 48 (3 repetitions each). Every
new scenario was answered from the task's `elsewhere` summary after one `listTasks` call, naming its
channel and pull request; no second task was opened and no task from elsewhere was messaged.
`claude-acp` used only `ToolSearch` besides the coordinator tools, and `codex-acp` nothing else.
The same day, with reports riding in the batch ([assistant-mode.md](assistant-mode.md) §5.18 ④),
every report block naming its task by `task`, `kind` and `title`, and the prompt saying a report may
arrive beside messages and is left silently, `report-batch` was added: a follow-up's report worth
telling, a request for new work and a follow-up's report with nothing new, in one turn.
`claude-acp` (on Claude Opus 5.5) and `codex-acp` each passed 51 / 51 (3 repetitions each). In every
`report-batch` run the first report was relayed with `replyToMessage` naming its PR, the request
was delegated and the empty report was left; `codex-acp` called `listTasks` once first, `claude-acp`
did not. Neither used a tool besides the coordinator tools other than `claude-acp`'s `ToolSearch`.
The same day, with follow-ups as watch tasks ([assistant-mode.md](assistant-mode.md) §5.18 ⑤), the
prompt gained one paragraph: a task runs in one of two modes, work or watch, both messaged and
stopped by their `taskId`, and a follow-up shows "next" and the time of its next check, or "running"
while a check runs. No scenario was added. `claude-acp` (on Claude Opus 5.5) and `codex-acp` each
passed 51 / 51 again (3 repetitions each), on the prompt with the reports of phase D. In every
`report-reply` and `report-batch` run the follow-up's report was relayed with `replyToMessage` naming
its PR, and the request beside it was delegated. Over the 51 runs `claude-acp` called `listTasks` 31
times and `codex-acp` 39 times; neither used a tool besides the coordinator tools other than
`claude-acp`'s `ToolSearch`.
On 2026-11-02, with `readTask`, the inlined ids and the title as a task's current scope
([assistant-mode.md](assistant-mode.md) §5.18 ④), the tool surface gained `readTask`, the board's
header named it, and the prompt said that `readTask` reads a task's latest words, the message it was
opened for and the pull requests it opened without waking it, and that a title names what a task is
doing now and a summary's first sentence its status. `elsewhere-read-task` was added: a request at the
channel root for the pull request of another channel's task, whose `elsewhere` summary predates it, so
only `readTask` names it. `claude-acp` (on Claude Opus 5.5) and `codex-acp` each passed 54 / 54
(3 repetitions each). In every `elsewhere-read-task` run the coordinator called `listTasks` once, then
`readTask` once with the id `elsewhere` gave, and replied with the pull request's link; neither called
`readTask` in any other scenario. Over the 54 runs `claude-acp` called `listTasks` 32 times and
`codex-acp` 42 times; neither used a tool besides the coordinator tools other than `claude-acp`'s
`ToolSearch`.
The same day, with a task making its own code channel (§6.8), no scenario expected a task to open in
a place: the probe's `delegateTask` already opened its task in the message's thread. One scenario
was added, `channel-task-report`: a run report from a task holding its code channel, whose summary
says the pull request is ready and that the asker wanted to hear, to be relayed with
`replyToMessage`. `claude-acp` (on Claude Opus 5.5) and `codex-acp` each passed 57 / 57 (3
repetitions each), on an unchanged prompt. In every `channel-task-report` run the coordinator
relayed the report with `replyToMessage`, addressed to the asker and naming the pull request,
without calling `listTasks` first. Over the 57 runs `claude-acp` called `listTasks` 34 times and
`codex-acp` 42 times, and each called `readTask` only in `elsewhere-read-task`; neither used a tool
besides the coordinator tools other than `claude-acp`'s `ToolSearch`.

The candidate prompt asked the coordinator to express every outcome as a call and to end its turn
with `AC_NO_RESPONSE`, and the runs above judged a one-message turn's text as its reply. The prompt
now asks for the coordinator's own reply as the turn's text, and the judge ties the text after the
turn's last call to a message as the daemon does (§4.3).

On 2026-11-11 that prompt ran on `claude-acp` with Claude Haiku at low effort, a coordinator setting
of §5.4 rather than the runtime's default (`AC_RUNTIME_MATRIX_COORDINATOR_MODEL` and
`AC_RUNTIME_MATRIX_COORDINATOR_EFFORT`), 3 repetitions of every scenario; no other runtime was
rerun. The prompt before it passed 60 / 63 there, and the new one 60 / 63: in both, the three
degraded runs were `elsewhere-read-task`, answered from the task's summary without `readTask`. No
turn posted its reasons: the 24 turns that ended in text other than the sentinel were replies to
their one message (greetings, status answers, a relayed report), `ignore-chatter` and `ignore-peer`
ended in the sentinel alone 6 / 6, and the batches replied by `replyToMessage`. A first wording
passed 57 / 63: answering in text, the model skipped `listTasks` in `webchat-elsewhere-status` and
answered from the board, without the pull request its summary names. The prompt now says the board
only names tasks and a status answer comes from `listTasks`, after which that scenario passed 3 / 3.
A one-message reply takes one call fewer, so a turn averaged 6.4 s where it took 8.0 s. Those runs
had the role lines of #3978 and its `role-alert` scenario, since reverted; on the prompt without
them the new form passed 58 / 60 (20 scenarios), the two degraded runs again `elsewhere-read-task`,
`ignore-chatter` and `ignore-peer` silent 6 / 6, and a vague mention answered in text with a
question back rather than a task.

On 2026-11-12, after a coordinator on Claude Haiku posted its reasons for leaving thread follow-ups
addressed to another app's bot, leaving a message became the `ignoreMessage` call (§4.3). The probe
gained `ignore-other-bot-thread`, such a follow-up, and `ignore-streak`, which delivers twelve turns
of messages that are not for the agent to one session and then a greeting that is, because the
coordinator that leaked had a long past and the probe's fresh sessions had not shown its habit. The
judge fails a run whose text would be posted to a message `ignoreMessage` did not leave. On
`claude-acp` with Claude Haiku at low effort, 3 repetitions of 22 scenarios, the prompt passed
63 / 66; the three degraded runs were `elsewhere-read-task` again. Every message to leave got its
call: 36 / 36 turns of `ignore-streak`, 9 / 9 of the three single ignore scenarios, and the chatter
and empty reports of the batches, 54 calls in all. No turn wrote anything but the sentinel after
them, the greeting that ends each streak was answered in text, and no run wrote text beside a call.
Other runtimes were not rerun, and the probe cannot show a session of hundreds of turns.

Two findings changed the design. A bare Slack timestamp as the message id was passed as a number by
`qoder`, losing its trailing zeros, so ids carry a `msg-` prefix (§4.3). `github-copilot-cli` posted
a reply saying a message was for another agent, so the prompt states that ignoring is silent.

## 13. Not done / later

- Returning a conversation's coordinator to the agent's coordinator model (Reset); a task has none either.
- A cap on coordinator usage (§4.6).
- Judging across bots; one coordinator shared by a shared bot's agents.
- Carrying an assistant-mode `append` session's context into the coordinator.
- A background task gaining a thread: the coordinator opens no background task (§6.6), so nothing
  would gain one.
