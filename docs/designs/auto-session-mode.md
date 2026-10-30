# Auto Session Mode: the Coordinator Session and Tasks

> Status: Design. The coordinator's prompt and tool surface are validated in the local runtime
> matrix (§12). The task index of §6.1, the task action shapes of §5.1 with `messageId` refused,
> two-level nesting (§6.3) and the threaded rules of §6.2 that key on an attached thread are
> implemented; `stopTask` stays a tool of its own with the shape of §5.1. `listTasks` (§5.2) and
> `updateTask` (§5.3) with the summary and its reminder (§6.7) are implemented; `listTasks` lists the
> 20 most recently active. The `auto` value (§3.1) exists on the wire and in the
> Control Plane, behind the `session-mode-auto-v1` capability, which a daemon advertises only with
> its `features.autoSessionMode` switch; with the switch off it routes `auto` as Per thread. With it
> on, the coordinator session runs (`packages/daemon/src/auto-session/`): root and unowned-thread
> messages reach it in batches (§4.3), its prompt and tools are the ones §12 probes, it decides with
> `delegateTask` and `messageTask` carrying `messageId` and with `replyToMessage` (§4.2, §5.1), a
> task's threads reach that task (§7), and a mention left without an outcome, or caught by a failed
> turn, opens a threaded task (§4.5). It runs read-only, and in an empty working directory where its
> runtime reads the daemon's own disk (elsewhere it opens in the agent's). Its tools are the decision
> tools, `listTasks` and memory; `postMessage`, `callAgent` and the follow-up tools of §5.4 wait for
> P3. A threaded task is a session on its message's thread, attached in the task index. It answers
> each message in the thread the message came from (§6.4), counts as running while a turn of it runs,
> keeps a summary with `updateTask`, and closes after 7 idle days or with its purged session (§6.5). A
> background task cannot take a channel message yet (§6.6): the coordinator opens no background task
> before P3. Each message a coordinator turn decides shows 🤔 until the turn ends (§4.4), and `!new`
> and `!stop` act on a task in its threads and on the coordinator at the root (§8). Under `auto` every
> message of a conversation that is not Off reaches the coordinator, and `auto` is refused together
> with By decision and shared-bot routing (§3.3). Switching into `auto` makes the conversation's recent
> thread sessions the coordinator's tasks; switching out retires the coordinator and hands its tasks
> back as ordinary thread sessions (§3.5). The visibility lock for threaded tasks, assistant mode's
> move to `auto` (§3.4) and webchat (§10) are not implemented.
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
today.

Single session keeps its current meaning: root and thread messages all join one session.

## 2. Vocabulary

| Term                | Meaning                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Auto                | The session mode that turns the coordinator on                                                                                          |
| Coordinator session | One long session per agent per conversation. It receives root messages and messages in unowned threads, and only decides where they go  |
| Task                | A child session a session opens with `delegateTask`, with a title and a link to its parent. It replaces both topics and delegated tasks |
| Threaded task       | A task with one or more platform threads attached; people in those threads talk to it directly                                          |
| Background task     | A task with no thread; only its parent talks to it, and it reports to the parent at the end of each round                               |
| Owned thread        | A thread attached to a task that still exists                                                                                           |

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
together in its next turn, and it decides each one separately. Queued messages are never dropped.

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

- A message that mentions the agent opens a threaded task directly, as Per thread would.
- Any other message stays silent.

### 4.6 Usage

No separate cap: batching (§4.3) bounds it, and the console shows the coordinator's usage. A limit is
decided once real usage is known.

## 5. Tools

### 5.1 `sendMessage` task actions

The existing names stay, with `messageId` added (`SEND_MESSAGE_ACTIONS` in
`packages/daemon/src/mcp/ops/send-message-actions.ts`):

- `delegateTask {title, message?, messageId?}`: `message` or `messageId` is required.
  - With `messageId`: a threaded task. It receives the original message as it arrived (sender, text,
    attachments); `message` is the coordinator's background.
  - Without: a background task, as today.
  - `title` is required and shown in the console and in `listTasks`.
- `messageTask {taskId, message?, messageId?}`: with `messageId`, hands that platform message to the
  task and attaches its thread; a background task becomes threaded this way (§6.6).
- `stopTask {taskId}`: stops a task's current turn, either kind.
- `replyToMessage {messageId, message}`: the coordinator's own reply, in the message's thread.

`messageId` names a platform message the coordinator received, so calls carrying it, and
`replyToMessage`, are the coordinator's alone. Every other session (Per thread, Single session, a
threaded task) opens background tasks only.

### 5.2 `listTasks`

A tool of its own, not a `sendMessage` action. It lists the caller's tasks, follow-ups and approved
proposals included, and at most the 20 most recently active threaded tasks. Each entry: id, title,
whether a thread is attached, thread links, owner, last activity, whether it is running, and the
task's summary with its update time (§6.7). The coordinator uses it to place a new message and to
answer "how is that going".

### 5.3 `updateTask`

`updateTask {summary, title?}`, a tool of its own. `summary` is required; the title changes only
together with the summary. Only a task calls it, for itself; both kinds can.

### 5.4 The coordinator's limits

- Only AgentConnect tools: `sendMessage` (the task actions and `replyToMessage`, plus `postMessage`
  and `callAgent`), `listTasks`, memory, and assistant mode's follow-up tools.
- A read-only runtime mode and no workspace (an empty directory). Anything that needs work becomes a
  task.
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
| Coordinate       | Platform threads, one or more                                   | `subsession:<id>`, never posts to the platform |
| Who talks to it  | Anyone in its threads; the parent through `messageTask`         | The parent only                                |
| Where results go | Into the thread; nothing is reported to the parent              | Reported to the parent each round (today)      |
| Permission cards | In its own thread                                               | As today                                       |
| Concurrency cap  | Not counted in `maxConcurrentSubsessions`                       | Counted                                        |
| Owner            | The sender of the message it opened for; later messages keep it | The parent's owner                             |

Both kinds inherit the parent's visibility and refuse changes to it.

### 6.3 Nesting

Two levels at most: a task opened by the coordinator or by any ordinary session may open background
tasks of its own, and those may not open more. This replaces today's "a task cannot delegate", for
every agent.

### 6.4 Several threads

A threaded task can hold several threads, one more for each `messageTask` with a `messageId`. A
message in any of them reaches the task, and the answer goes to the thread it came from (the delivery
coordinate is unchanged, [channel-session-mode.md](channel-session-mode.md) §3.1).

### 6.5 Lifetime

A threaded task lives as long as its session: when the session ages out after 7 idle days, the task
closes and leaves `listTasks`. A later reply in its thread is an unowned-thread message and goes to
the coordinator, which may open a task again.

### 6.6 A background task gaining a thread

`messageTask` with a `messageId` on a background task attaches the thread, and from then on the task
follows the threaded rules: no reports to the parent, outside the concurrency cap. The round running
when the thread attaches still reports once when it ends.

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

## 7. Thread routing

| Thread             | Goes to                                                     |
| ------------------ | ----------------------------------------------------------- |
| Attached to a task | That task, without the coordinator                          |
| Unowned            | The coordinator, which may still open a task for the thread |

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

## 9. Several agents

Each agent has its own coordinator, and each decides independently. The prompt lists the other
agents in the conversation, by name and description, so a message for one of them is recognized as
not addressed to this agent. Cost grows with the number of agents.

## 10. Webchat (the console home and playground)

- Opening an agent from the home page or the playground enters **that member's private coordinator**
  with the agent, like a DM.
- New session opens an **ordinary webchat session** without the coordinator, as today.
- Every task's page accepts messages (today it is read-only), for whoever may continue the parent.
- Webchat has no threads, so a threaded task appears as its own webchat conversation:
  - `delegateTask` with a `messageId` opens a task conversation; the coordinator posts a card with its
    title and link, and people continue there without the coordinator.
  - `messageTask` with a `messageId` moves the message into that conversation, which answers there;
    the coordinator posts a link card.
- Existing ordinary webchat conversations stay as they are.

## 11. Console

- The session-mode menu gains Auto beside Per thread and Single session.
- The session list labels the coordinator; tasks show their title and link to their parent.
- A parent's Tasks tab lists all its tasks, threaded and background grouped apart.

## 12. Validation

`packages/daemon/test/acp-matrix/coordinator-probe.ts` injects a candidate coordinator prompt and
tool surface (`sendMessage` with `delegateTask`, `messageTask` and `replyToMessage`, plus `listTasks`)
into a real runtime session over an HTTP MCP fixture, delivers channel messages in the format of
§4.3, and judges each message's outcome. Its scenarios: new work, a message for an open task, a
status question, a greeting, chatter between people, a request to another agent, a vague mention, a
small edit the coordinator must not do itself, and two mixed batches.

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
rerun.

The candidate prompt asks the coordinator to express every outcome as a call and to end its turn
with `AC_NO_RESPONSE`; the judge still accepts a one-message turn's text as its reply (§4.3).

Two findings changed the design. A bare Slack timestamp as the message id was passed as a number by
`qoder`, losing its trailing zeros, so ids carry a `msg-` prefix (§4.3). `github-copilot-cli` posted
a reply saying a message was for another agent, so the prompt states that ignoring is silent.

## 13. Not done / later

- A coordinator model setting of its own (the first version follows the agent).
- A cap on coordinator usage (§4.6).
- Judging across bots; one coordinator shared by a shared bot's agents.
- Carrying an assistant-mode `append` session's context into the coordinator.
