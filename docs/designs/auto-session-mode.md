# Auto Session Mode: the Coordinator Session and Tasks

> Status: Implemented on the daemon, the Control Plane and the console. A daemon runs `auto` with
> its `features.autoSessionMode` switch, which is on by default and advertises
> `session-mode-auto-v1` (§3.1); with the switch off it routes `auto` as Per thread and keeps P1's
> task tools for every session (§5.1, §6.3). New rooms and group DMs start on Auto where the bot's
> daemon reads it (§3.2), and assistant mode's places run through the coordinator (§3.4). On Slack a
> task the coordinator opens for a message works in a code channel linked to it (§6.8). The
> coordinator's prompt and tool surface are the ones the local runtime matrix validates (§12).
> Builds on: [channel-session-mode.md](channel-session-mode.md) (the reserved `auto` value),
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

Assistant mode's follow-ups and approved proposals stay the other kinds of task, unchanged.

## 3. Mode and configuration

### 3.1 Value and capability

- `ChannelSessionMode` gains `auto` (`packages/protocol/src/frames/integration.ts` and the Prisma enum).
- The daemon advertises support for `auto` (`session-mode-auto-v1`); the Control Plane refuses `auto`
  on a row served by a daemon that does not (409 `SESSION_MODE_UNSUPPORTED`).
- A daemon without the capability that still serves an `auto` row, after a move or a downgrade, is
  sent `createNew` for it: a new enum value would make the whole frame unreadable to it.

### 3.2 Defaults

- New **channel and group-DM** rows default to `auto`. When the bot's daemon does not support it, a
  new row still defaults to `createNew`.
- Existing rows, `createNew` and `append` alike, are not changed.
- DMs are unaffected.
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

### 3.3 Trigger

- Under `auto` every root message goes to the coordinator, so @-mentions and Any message behave the
  same.
- With `auto` selected, the trigger menu offers only Off; the other choices read "Decided by the
  coordinator".
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
  which posts in the report's thread or at the conversation's root; a report never opens a task and
  is never handed to one, and shows no 🤔. Its own follow-ups and proposals, made with the place
  tools of §5.4, belong to it as they belong to an `append` session.
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

## 4. Root messages and the coordinator

### 4.1 What it sees

- Every **root message** of the conversation, and every message in an **unowned thread** (a thread
  under a message the coordinator replied to itself, or one whose task has closed).
- A message that mentions the agent may not be ignored.

### 4.2 Four outcomes

| Outcome                  | How                                                                                                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Hand to an open task | `messageTask {taskId, messageId}`: the message's thread is attached to that task, which answers there                                                                                              |
| (b) Open a new task      | `delegateTask {messageId, title}`: a new task opens for the message, with its thread attached                                                                                                      |
| (c) Ignore               | No call for the message; a one-message turn may also answer `AC_NO_RESPONSE` (`packages/daemon/src/session/no-response.ts`)                                                                        |
| (d) Reply directly       | `replyToMessage {messageId, message}`, posted in the message's thread as today; a one-message turn may also just answer in text. The thread stays unowned, so replies come back to the coordinator |

(d) is for what needs no session of its own: greetings, thanks, a question about a task's status.

### 4.3 Batching

The coordinator runs one turn at a time. Root messages that arrive while it runs are delivered
together in its next turn, with the reports that arrived among them (§3.4), and it decides each one
separately. Queued messages are never dropped.
A batch holds one permission class, so the queue is cut in arrival order where the next sender's
class differs, and every sender of a batch is asked on its turn
([assistant-mode.md](assistant-mode.md) §5.18 ③).

A turn's final text cannot be tied to one of several messages, so in a turn with more than one
message every outcome is a call that names its message:

- (a) `messageTask`, (b) `delegateTask`, (d) `replyToMessage`, at most one per message.
- A message with no call is ignored (c); no `AC_NO_RESPONSE` is needed.
- The turn's final text is not posted; it is kept only in the coordinator's transcript.

A one-message turn may use either form: text equals `replyToMessage`, `AC_NO_RESPONSE` equals
ignoring it.

Ignoring is silent. The prompt forbids a reply that only says a message is not for the agent; the
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

A message that mentions the agent and has no outcome when the turn ends (a one-message turn's
`AC_NO_RESPONSE` included) takes the fallback of §4.5: a task opens for it.

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
  message's thread: a fallback never opens a conversation of its own (§6.8).
- Any other message stays silent.

### 4.6 Usage

No separate cap: batching (§4.3) bounds it, and the console's Usage page shows, under each agent,
what its coordinators spent. A limit is decided once real usage is known.

## 5. Tools

### 5.1 `sendMessage` task actions

The existing names stay, with `messageId` added (`SEND_MESSAGE_ACTIONS` in
`packages/daemon/src/mcp/ops/send-message-actions.ts`):

- `delegateTask {title, message?, messageId?}`: `message` or `messageId` is required.
  - With `messageId`: a threaded task. It receives the original message as it arrived (sender, text,
    attachments); `message` is the coordinator's background. Where the message's platform gives a task a
    conversation of its own (a Slack code channel), the task works there instead of in the message's
    thread (§6.8).
  - Without: a background task, as today. The coordinator's tool always names a message, so its tasks
    are always threaded (§6.6).
  - `title` is required and shown in the console and in `listTasks`.
- `messageTask {taskId, message?, messageId?}`: with `messageId`, hands that platform message to the
  task and attaches its thread (§6.4), or moves it into the task's own conversation (§6.8).
- `stopTask {taskId}`: stops a task's current turn, either kind. The coordinator is not offered it
  yet; `!stop` in a task's thread stops a threaded task (§8), and the console stops either kind.
- `replyToMessage {messageId, message}`: the coordinator's own reply, in the message's thread.

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
time (§6.7). The coordinator uses it to place a new message and to
answer "how is that going".

The coordinator's `listTasks {after?}` reads the work board ([assistant-mode.md](assistant-mode.md)
§5.18 ④): `here`, its own open tasks with the fields above, and `elsewhere`, the other places' open
tasks its batch may see, read only, with place, status, summary and thread links. Each is a page of
at most 20 in the board's order, newest change first, continued by its own `nextCursor`, and access
is judged again on every page.

### 5.3 `updateTask`

`updateTask {summary, title?}`, a tool of its own. `summary` is required; the title changes only
together with the summary. Only a task calls it, for itself; both kinds can.

### 5.4 The coordinator's limits

- Only AgentConnect tools: `sendMessage` (the task actions and `replyToMessage`, plus `postMessage`
  and `callAgent`), `listTasks`, `recall`, memory, and assistant mode's follow-up tools.
  - `recall` keeps its parameters and the read rule, judged by every sender of the batch.
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
- An ACP session on the agent's own runtime with the coordinator's own prompt. In the first version
  every runtime setting, the model included, follows the agent.

## 6. Tasks

### 6.1 Storage

Tasks live in the existing persistent parent–child index
(`packages/daemon/src/store/assistant-subsessions.ts`, where follow-ups already sit under `kind`),
which gains a title, a summary and attached threads. The thread-to-task attachment can extend the
thread participation record of [channel-session-mode.md](channel-session-mode.md) §6.4.

### 6.2 The two kinds

The rules follow from whether a thread is attached; there is no separate switch.

| Aspect           | Threaded task                                                   | Background task                                |
| ---------------- | --------------------------------------------------------------- | ---------------------------------------------- |
| Coordinate       | Platform threads, one or more, or a room of its own (§6.8)      | `subsession:<id>`, never posts to the platform |
| Who talks to it  | Anyone in its threads; the parent through `messageTask`         | The parent only                                |
| Where results go | Into the thread; nothing is reported to the parent              | Reported to the parent each round (today)      |
| Permission cards | In its own thread                                               | As today                                       |
| Concurrency cap  | Not counted in `maxConcurrentSubsessions`                       | Counted                                        |
| Owner            | The sender of the message it opened for; later messages keep it | The parent's owner                             |

Both kinds inherit the parent's visibility and refuse changes to it.

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
the coordinator, which may open a task again.

### 6.6 Coordinator tasks are threaded

Every task the coordinator opens is threaded from its first round: its `delegateTask` always names a
message (§5.1), and the task holds that message's thread, or in webchat the message's id (§10). The
coordinator opens no background task, so no task of the coordinator ever changes kind (decided
2026-10-30). A background task is one a session opened on a daemon whose Auto switch is off (§6.3).

### 6.7 The task summary

A task keeps its own summary with `updateTask` (§5.3), which the coordinator reads in `listTasks` to
place new messages.

- **Content**: fixed parts set by the task's prompt, at most 500 characters: the scope (what the task
  is about, the coordinator's main signal), the status (in progress, waiting on someone, done or
  blocked), and the next step and open questions.
- **When**: the prompt asks for an update in any turn where the scope or status changes. As a
  backstop the daemon adds a reminder to the next turn when a task has no summary or its summary is
  5 turns old. No extra model call writes summaries.
- **Before the first summary**: `listTasks` shows the title and background the coordinator gave
  (`delegateTask`'s `message`).
- **Title**: the task may change it with the summary; the coordinator's title is only the first one.
- **Storage**: the summary is conversation content, so the Control Plane does not store it. It lives
  in the daemon's task index (§6.1), and the console's Tasks tab reads it through the BFF from the
  owning daemon, as transcript reads work.

### 6.8 A task in a conversation of its own

On Slack, a task the coordinator opens for a message works in a native code channel linked to that
message ([slack-code-channels.md](slack-code-channels.md)) instead of in the message's thread.

- **Creation.** `delegateTask` with a `messageId` asks the message's platform for a place, through the
  optional `openTaskPlace` member of the daemon platform contract (`platforms/contract.ts`). Slack
  implements it with the code channel creation path its `createSlackCodeChannel` tool uses: linked to
  the message, keyed by it so a retried creation finds the same channel, privacy matching the message's
  conversation, and its author invited. The daemon asks only for a sender who may have the agent make
  something new (a full member of the bot's workspace, the place write rule's `new` target).
- **Coordinate.** The task's session is the channel's one session (`slack:<channel>:<channel>`), and the
  task holds the channel coordinate as its one thread from its first round: it reports nothing and is
  outside the concurrency cap (§6.2). The message's own thread stays unowned, and the coordinator posts
  a link to the channel there ("Started a task: [title](link)").
- **The first message.** Slack copies the message into the new channel, and that copy opens the task: it
  reaches the task's session, never a second one, and the daemon dispatches nothing itself. A message in a
  room keyed as one thread that arrives while the agent's place is still being made waits for it, at most
  30 seconds, so the copy runs once the task is indexed. The copy, the first message there from the
  original's sender within 10 minutes, carries the coordinator's title and background; no other message
  takes them, nor a message the coordinator moves there.
- **Routing.** A room its platform keys as one thread named after itself has no root, so it never runs a
  coordinator of its own whatever its mode: every message there keys on the channel's session, the
  task's while a task holds it. This also keeps a code channel made outside a task, or one whose task has
  closed, an ordinary code channel. `!new`, `!stop` and Slack's native Stop act on that session (§8).
- **More messages.** `messageTask` with a `messageId` moves the message into the channel, where the task
  answers, and links the channel in the message's thread ("Passed to [title](link)"); the thread is not
  attached, so a later reply there comes back to the coordinator. `listTasks` lists the task with the
  channel as its thread and the channel's link.
- **Closing.** Archiving the channel, by a person or by the agent, closes the task: its row and thread go,
  and its owner is cleared (§6.2). The relay forwards an archive with an `archived` flag, since a native
  Stop reaches the same channel coordinate. The task also closes after 7 idle days (§6.5) and is released
  when its coordinator's conversation leaves `auto` (§3.5), judged by that conversation, not the
  channel's own mode.
- **Fallback.** When the installation lacks code channels, creation fails, or the sender may not make a
  channel, the task opens in the message's thread as before; nothing beyond the usual answer is shown.
- **Not here.** A background task (`delegateTask` without a `messageId`) never gets a conversation of its
  own, and neither does a fallback task (§4.5) or a thread session adopted on a switch into `auto`
  (§3.5).

## 7. Thread routing

| Thread                     | Goes to                                                     |
| -------------------------- | ----------------------------------------------------------- |
| Attached to a task         | That task, without the coordinator                          |
| Unowned                    | The coordinator, which may still open a task for the thread |
| A room keyed as one thread | That room's one session, the task's in its place (§6.8)     |

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

## 10. Webchat (the console home and playground)

- Opening an agent from the home page or the playground enters **that member's private coordinator**
  with the agent, like a DM.
  - Its conversation id is derived from the organization, the member and the agent (a version 5
    UUID, `coordinatorConversationId` in `packages/protocol`). The Control Plane creates the
    conversation when the console mints with the `coordinator` flag, and the daemon recognizes it
    from the turn's author, agent and organization, so neither the relay nor the Control Plane's
    schema carries a marker. Only its owner resumes it, and it takes no other participants.
  - Every message in it goes to the conversation's coordinator coordinate and counts as addressed to
    the agent, so a message left without an outcome opens a task (§4.5). A message's id is its
    webchat post id.
  - Each message runs as a turn of its own, never batched (§4.3's one-message form): its text streams
    to the browser and is its reply. `replyToMessage` and the link cards below are the coordinator's
    own posts in the conversation.
  - The coordinator's prompt names the place a private conversation with one person, with no
    threads: a task answers on its own page, and the text the coordinator writes is shown as it
    writes it, so it writes nothing but its calls and replies with `replyToMessage`.
  - It runs over the legacy webchat protocol; an AHP conversation stays an ordinary one for now.
- New session opens an **ordinary webchat session** without the coordinator, as today.
- Every task's page accepts messages (today it is read-only), for whoever may continue the parent,
  where the daemon advertises `task-page-messages-v1`, which its Auto switch also turns on.
  - A threaded task's page is its thread's session, which the console already continues. A background
    task's coordinate is no platform thread, so its page continues it console-only: nothing is mirrored
    to the platform, and the answer streams to the page.
  - The Control Plane judges the composer, the token and every dial by the parent session's audience.
    A task without a recorded parent of its own agent stays read-only, and so do a follow-up's checks,
    an approved proposal and research.
  - A person's message waits for the task's running turn and runs as a turn of its own, so it is never
    steered into a round whose output goes to the parent. A round still open reports to the parent as
    usual; a settled task's parent hears nothing, since the person read the answer on the page.
  - The task's standing context says people may write to it from its page.
- Webchat has no threads, so a task the coordinator opens for a webchat message continues on its own
  page, which is its conversation. This replaces an earlier plan in which each task had its own
  webchat conversation (decided 2026-10-30).
  - `delegateTask` with a `messageId` opens the task on a background coordinate of its own
    (`subsession:<id>`, off the conversation's channel, as a background task of a webchat session
    is) and attaches the message's id as a thread from the first round. The task therefore follows
    the threaded rules: it never reports to the coordinator and is outside the concurrency cap. It
    receives the original message, records the coordinator as its parent, and is told that its
    person reads it on its page.
  - The coordinator posts a link card: an agent post with a Markdown link, titled with the task's
    title, to the task's page.
  - `messageTask` with a `messageId` moves the message into the task's conversation, which answers on
    its page, and attaches its id as one more thread; the coordinator posts a link card.
- Existing ordinary webchat conversations stay as they are.

## 11. Console

- The session-mode menu gains Auto beside Per thread and Single session, where the conversation's
  consumer's daemon reads it and outside By decision and shared-bot routing; a group DM row offers it
  too (§3.2).
- The session list labels the coordinator; tasks show their title and link to their parent. A
  threaded task's page names its coordinator once, among its related sessions, from the Control
  Plane's record of the owner (§6.2).
- A parent's Tasks tab lists all its tasks, threaded and background grouped apart.

## 12. Validation

`packages/daemon/test/acp-matrix/coordinator-probe.ts` injects a candidate coordinator prompt and tool
surface (`sendMessage` with `delegateTask`, `messageTask` and `replyToMessage`, plus `listTasks` with
its `here` and `elsewhere` lists) into a real runtime session over an HTTP MCP fixture, opens each
turn with the work board the daemon would send ([assistant-mode.md](assistant-mode.md) §5.18),
delivers channel messages in the format of §4.3, and judges each message's outcome. Its scenarios:
new work, a message for an open task, a status question, a greeting, chatter between people, a
request to another agent, a vague mention, a small edit the coordinator must not do itself, two mixed
batches, a follow-up's report (§3.4), a batch of one message and two reports, one worth telling
and one with nothing new, a request for work another channel's task already has open, and
in a webchat conversation (§10) new work, a status question, a message for an open task and a status
question about another channel's task.

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

The candidate prompt asks the coordinator to express every outcome as a call and to end its turn
with `AC_NO_RESPONSE`; the judge still accepts a one-message turn's text as its reply (§4.3).

Two findings changed the design. A bare Slack timestamp as the message id was passed as a number by
`qoder`, losing its trailing zeros, so ids carry a `msg-` prefix (§4.3). `github-copilot-cli` posted
a reply saying a message was for another agent, so the prompt states that ignoring is silent.

## 13. Not done / later

- A coordinator model setting of its own (the first version follows the agent).
- `recall` and a read of another place's tasks for the coordinator, and `listTasks` paging: proposed
  in [assistant-mode.md](assistant-mode.md) §5.18.
- A cap on coordinator usage (§4.6).
- Judging across bots; one coordinator shared by a shared bot's agents.
- Carrying an assistant-mode `append` session's context into the coordinator.
- A background task gaining a thread: the coordinator opens no background task (§6.6), so nothing
  would gain one.
