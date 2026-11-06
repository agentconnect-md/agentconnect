# Webchat Threads, and One Thread Shape for Every Coordinator

> **Status:** Proposal, decisions recorded 2026-11-06 (§12); implementation tracked as the PRs of §11.
> **Builds on:** [auto-session-mode.md](auto-session-mode.md) (§6–§8, §10 webchat),
> [channel-session-mode.md](channel-session-mode.md) (§3.1 session vs delivery coordinate),
> [message-intake.md](message-intake.md) (the channel record),
> [webchat-multi-agents.md](webchat-multi-agents.md) (posts, fan-out),
> [webchat-side-panels.md](webchat-side-panels.md) (the dock).
> **Supersedes when implemented:** auto-session-mode.md §10's "Webchat has no threads" bullets
> (page tasks on `subsession:` coordinates, link cards, the threadless coordinator prompt).
> **Primary implementation areas:** `packages/protocol`, `packages/relay`, `packages/daemon`,
> `packages/control-plane` (read routes and continuation checks), `packages/web`.

## 1. Summary

Webchat gets threads that look and behave like Slack's: a root message can be answered in a thread
under it, the root timeline shows each thread as a reply footer under its root, and the thread opens
in the side panel.

The main reason is the coordinator. On Slack a coordinator's task already _is_ a thread: it opens on
the message's thread, people reply there, and the task answers there. Webchat has no threads, so
§10 of auto-session-mode.md built a parallel model for it: the task runs on a background coordinate
(`subsession:<id>`), the message id stands in for a thread, the coordinator posts a link card, and
the task's page and the dock's task thread are a separate continuation conversation. With real
threads, a webchat coordinator runs the same model as a Slack one, and the console draws both the
same way.

Three decisions carry the design:

1. **Routing does not change.** A thread belongs to the conversation; a task holds threads.
   When the coordinator opens a task, it opens a thread (on a root message) or attaches the task to
   an existing thread. A new message in a thread the task holds goes into the task's ACP session;
   a message in a thread no task holds goes to the coordinator's session, with metadata saying which
   thread it sits in. In either case the message stays a message of that thread (§4).
2. **A message's thread is recorded, not derived from the session that admitted it.** Webchat posts
   join the channel record with a physical thread, exactly as Slack messages do
   ([message-intake.md](message-intake.md) §3), so a thread's content is everything said in it,
   whichever session said or received it (§5).
3. **A coordinator page renders the platform's thread shape.** A Slack coordinator's page shows each
   thread under its root, as Slack does; a webchat coordinator's page is the same component over the
   same reads (§6, §7).

## 2. Today (verified at `b20dd0357`)

- **No thread on the wire.** `WebchatPost` (`packages/protocol/src/frames/webchat.ts`) and the
  browser's `turn` op carry no thread, parent or reply-to. The relay mints `postId` and `at` once in
  `sendTurn` (`packages/relay/src/relay-browser-connection.ts`).
- **One coordinate per conversation.** `chatSessionKey` (`packages/daemon/src/session/chat-application.ts`)
  keys `webchat:<conv>:webchat:<conv>:<agent>`; `prepareTurn` sets `msgId: webchat:<conv>` and no
  `thread`. Every webchat row is recorded on channel `<conv>`, thread `webchat:<conv>`.
- **Webchat skips the Auto ladder.** `webchatCoordinator` (`packages/daemon/src/daemon.ts`) recognizes
  the member's private coordinator conversation and sets `sessionThread` to its append coordinate
  directly; `keySession` / `autoCoordinateFor`, which route Slack's owned and unowned threads, never
  run for webchat.
- **Page tasks.** `threadless(msg)` (`packages/daemon/src/auto-session/coordinator-turns.ts`) is
  `platform === 'webchat'`. For such a message `openPageTask`
  (`packages/daemon/src/auto-session/coordinator-sessions.ts`) opens the task on
  `a2a:<agent>` / `subsession:<ts>`, attaches the post id to `assistant_subsession_thread` as if it
  were a thread, dispatches `messageForPageTask` (a copy that is not a conversation post), and
  `postTaskLink` posts a `taskLink` card. A message sent from the task's page or dock is a separate
  session-targeted webchat conversation (`targetSessionId`, `task-page-messages-v1`).
- **A page task is recognized by its coordinate.** Four gates test `isSubsessionCoordinate` or
  `isDelegatedTaskCoordinate` (§5.4): the parent the daemon reports (and with it the inherited
  audience and the publish cascade), the per-task admin MCP grant, the task's standing context, and
  where its permission requests are listed.
- **Who may write.** A task's page is continued by whoever may continue its parent
  (`packages/control-plane/src/domain/continuation-audience.ts`), so other members may write to the
  tasks of a published coordinator; the coordinator conversation itself is resumed by its owner only
  (`packages/control-plane/src/http/routes/webchat-token.ts`).
- **Coordinator prompt.** The webchat form says "no threads, one message a turn, the text written is
  shown" (`coordinator-prompt.ts`); `replyToMessage` posts at the conversation root.
- **History reads.** `session/history` returns the rows on the session's coordinate and the rows
  admitted into it; observations nobody admitted are not shown. Observations are swept once a
  channel has 100 newer text rows (message-intake.md §8).
- **Console.** The coordinator page is a flat transcript of the coordinator session. `TaskThreadCard`
  draws a task card from an inline `taskLink` or, from `openedForMessageId`, under the coordinator
  turn that answered the message; `dock/TaskThreadPanel.tsx` reads the task's session history and has
  its own `ThreadComposer`. No row has a "reply in thread" action.
- **Consequence on Slack.** A Slack coordinator's page draws a task's card and reply count under a
  later coordinator turn rather than under the thread's root, and the replies people wrote in that
  thread before the task opened, which the coordinator received, appear in the main timeline.

## 3. Vocabulary

| Term          | Meaning                                                                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root          | A message at the conversation's top level                                                                                                                  |
| Thread        | A root and the replies under it, named by the root's id: its Slack `ts`, its webchat `postId`                                                              |
| Owned thread  | A thread a task holds (auto-session-mode.md §2); a task may hold several                                                                                   |
| Thread record | The channel-record rows whose physical thread is the thread, whichever sessions admitted them, observations included                                       |
| Reply count   | Slack's count: every chat message in the thread record except the root, from people and agents alike; work rows (tool calls, reasoning) are not counted    |
| Thread footer | The line under a root: reply count, participants, last reply time and a one-line preview, the holding task's state and title, and "is working…" while live |

## 4. Routing (unchanged, now applied to webchat)

The routing table is auto-session-mode.md §7, and it is the whole rule:

| A message arrives…             | Its thread             | Admitted into                                                                                 |
| ------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------- |
| At the root                    | Its own (a new thread) | The coordinator's session                                                                     |
| In a thread a task holds       | That thread            | The task's ACP session, without the coordinator                                               |
| In a thread no task holds      | That thread            | The coordinator's session; its entry carries `thread: msg-<rootId>` (`coordinatorView` today) |
| From a task's page or the dock | The task's thread      | The task's ACP session; it is a reply in that thread (§6.3)                                   |

- **Opening a task opens a thread or attaches to one.** `delegateTask {messageId}` on a root message
  opens the task on that message's thread. On a message that is already in a thread, the task
  attaches to that thread. `messageTask {messageId}` attaches the message's thread to an existing
  task as one more thread (§6.4 there). In webchat these go through the same `openTask` / `handTo`
  branch Slack uses; `openPageTask`, `messageForPageTask` and the link card are not used for a daemon
  that serves threads (§10).
- **A task starts with the whole thread.** A task opened on a thread that already has replies, for
  example a coordinator answer and a person's follow-ups, receives the thread record so far as its
  first round's context, not only the message it was opened for.
- **The message stays the thread's.** Admission decides which session's context the message enters;
  it never moves the message. The row keeps its physical thread, so the thread record, its footer,
  and every reader of §5 see it in place.
- **Unowned threads tell the coordinator where they are.** A reply in an unowned thread, for
  example under the coordinator's own `replyToMessage` answer, reaches the coordinator with the
  thread named in its entry, so it can answer in that thread, hand the thread to a task, or open a
  task on it.
- **Answers go where the message came from.** The delivery coordinate (channel-session-mode.md
  §3.1) of a webchat thread message is its thread; a task's or the coordinator's answer posts and
  streams there. `replyToMessage` posts in the message's thread, as on Slack, not at the root.
- **Commands** follow auto-session-mode.md §8 unchanged: `!new` / `!stop` in a held thread act on the
  task, at the root on the coordinator.

### 4.1 Several agents

Every agent of a webchat conversation participates in every one of its threads: the roster's
standing mention reaches into threads, so a message in a thread is delivered to each agent, and each
routes it by its own coordinator and tasks (auto-session-mode.md §9), rather than only to the agents
mentioned or already replying there. A webchat coordinator conversation takes no other participants
today, so this applies once one may, and the rule moves into webchat-multi-agents.md in the change
that allows a second participant. Slack's own thread participation rules are unchanged.

### 4.2 Prompts

- **The coordinator** drops its webchat form: a member's private conversation is described as a
  conversation with threads, a task answers in its thread, and the coordinator answers with
  `replyToMessage`, which posts in the message's thread. Its turn stays visible in the main timeline
  (§6.1). The one-message-per-turn rule stays, since a private conversation has one sender.
- **A webchat task** gets the threaded task's standing context (`THREADED_TASK_APPEND`): people talk
  to it in its thread, it answers there, and it reports nothing to the coordinator. The page wording
  (`PAGE_TASK_APPEND`) stays for legacy page tasks.

## 5. Recording

### 5.1 Webchat posts join the channel record with a thread

- The browser's `turn` op gains `thread?: string`, the root's `postId`. `WebchatPost` and
  `RelayWebchatOp.turn` carry it; agent posts (`rd/webchat-post`) and stream frames carry the thread
  they answer in.
- The relay stays content-free: it forwards `thread`, and checks only its shape.
- The daemon records a webchat row as Slack's normalizer does: a reply's physical thread is
  `thread`, and a root's is its own `postId`. Today's literal `webchat:<conv>` stays the recorded
  thread of rows written before the change and of ordinary conversations, so readers treat a
  `webchat:<conv>` row as a root.
- A `thread` that names no root the daemon recorded in this conversation, names a reply rather than
  a root, or arrives on a conversation that is not a coordinator conversation is refused with the
  turn ack reason `unknown_thread`. The root lookup is the reply-chain seam the DingTalk, Teams and
  Telegram threading already use (`LocalStore.threadForPlatformMessage`), not a second root index.
- `prepareTurn` sets `msg.thread` to the physical thread and `msgId` to `webchat:<conv>:<postId>`, so
  `inThread`, `replyThreadOf` and `platformMessageIdOf` give webchat the answers they give Slack, and
  `threadless` returns false for a threaded daemon.

### 5.2 Task coordinates

A coordinator task opened for a webchat message is keyed like a Slack threaded task: channel
`<conv>`, session thread = the thread's root id, so its key is `webchat:<conv>:<rootPostId>:<agent>`
and its first thread is that root. It is an ordinary threaded task (auto-session-mode.md §6.2): it
never reports to the coordinator, is outside the concurrency cap, and is owned by the message's
sender. Its visibility rules are §10's webchat exception, unchanged.

### 5.3 Thread summaries

The daemon serves, for a conversation's roots, a summary per thread computed from the channel
record and `assistant_subsession_thread`: the reply count (§3), `lastReplyAt`, the latest reply's
author and a short excerpt of its text for the footer's preview, the participants (people and
agents, at most a few), the holding task's session id, title and state, and whether a turn is
running in the thread. `repliesOf` (`packages/daemon/src/cp/assistant-activity.ts`) already counts a
task's replies; the summary generalizes it from "a task's" to "a thread's", so an unowned thread (a
coordinator answer and its follow-ups) has a footer too. Nothing new is stored on the Control Plane.

### 5.4 A task is recognized by the task index, not its coordinate

A task on `webchat:<conv>:<rootPostId>` matches none of today's coordinate tests, so each gate that
recognizes a page task by `subsession:` switches to the task index (`assistant_subsession`, reported
to the Control Plane as `taskParentSessionId`). The behaviour each gate gives stays what a page task
has today:

| Gate                    | Today's test                                                                                                              | Must stay                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parent and audience     | `pageTaskParent` (`session-manager.ts`) reports `parentSessionId`                                                         | The task inherits the coordinator's audience, and publishing the coordinator widens it                                                                                             |
| Admin MCP grant         | `adminMcpEntitlement` (`daemon.ts`) on a delegated-task thread                                                            | Each task gets its own grant inherited from the conversation, not the conversation's own                                                                                           |
| Standing context        | `pageTask` from `pageTaskParent`                                                                                          | The threaded wording of §4.2                                                                                                                                                       |
| Permission requests     | `request-conversation.ts` sets `parentSessionId` on `subsession:`                                                         | A task's requests list on the coordinator, marked as from a task, and in the task's thread                                                                                         |
| Continuation audience   | `continuation-audience.ts` swaps in the parent on `subsession:`                                                           | A task is continued by whoever may continue its coordinator (§6.3)                                                                                                                 |
| Current-session pointer | `session.repo.ts` advances `webchat_conversation.currentSessionId` for any webchat row on the conversation's UUID channel | The pointer stays on the coordinator: it advances only for a row on the conversation's own thread (`webchat:<conv>` or an `append:` coordinate), never for a thread-keyed task row |

The last gate exists only because tasks move onto the conversation's channel: today's page tasks
sit on `a2a:<agent>`, so they never reach it. Without it, the first task opened after the
coordinator would take the conversation's current-session pointer, which `webchat-token.ts` resumes
on and checks content reach against, and the owner's resume would bind to a task. The rule is a pure
function of the reported row's thread, so it does not depend on `taskParentSessionId` arriving
first; a row that reported no thread keeps today's behaviour.

On the daemon a webchat coordinator's task is a live work row of the task index holding a webchat
thread (`webchatCoordinatorTask`, `packages/daemon/src/auto-session/webchat-task.ts`), which only a
coordinator opens; a follow-up's checks, approved proposals and research never are. Its `page` flag
tells a legacy page task, which keeps `PAGE_TASK_APPEND`, from a thread-keyed one, which gets the
threaded wording through `isThreadedTask`. On the Control Plane it is a webchat session with
`taskParentSessionId` set (`continuation-audience.ts`). A Slack threaded task also holds a thread
and reports `taskParentSessionId`, but matches neither test, so its parent, audience, grant and
request listing do not change.

This change has no visible effect by itself and lands before the coordinator moves (§11, PR 3).

### 5.5 Retention of a thread's observations

A thread record includes observations, rows no session admitted, and message-intake.md §8 sweeps
those once the channel has 100 newer text rows, which would leave gaps in a thread panel. A thread
in which any row was admitted into a session is exempt: its observations are kept until its newest
admitted row is itself deleted. Threads no agent took part in are swept as today, so the growth is
bounded by the threads agents worked in.

## 6. The webchat conversation page

### 6.1 Main timeline

- The page shows roots and every coordinator turn in order, as today. A root's thread footer sits
  directly under the root; a root a task holds shows the task's state icon and title in the footer,
  which replaces the link card and the `openedForMessageId` card under a coordinator turn.
- Messages in a thread are not in the main timeline, even those the coordinator received because no
  task held the thread then; they are in the thread and in its reply count.
- A coordinator turn answering a thread message carries a label, "In thread: <the root's first
  words>", that opens the thread. A turn answering a root has none.
- A `replyToMessage` call shows in the main timeline as one line, "Answered in the thread", that
  opens the thread; the answer's text is only in the thread, and the footer previews it.
- Nothing is posted to the main timeline on a thread's behalf: there is no "also send to the
  conversation".
- Hovering a root offers **Reply in thread** beside Copy; on a phone, a tap on the footer or a
  long-press menu does.

### 6.2 The thread panel

- The thread opens in the side panel, replacing `TaskThreadPanel` with a general `ThreadPanel`: the
  root at the top, then the thread's chat messages in order (people, the coordinator's answers,
  other agents) and the holding task's turns with their work folded as today, then a thread
  composer. Coordinator turns are in the main timeline, not here.
- A thread a task holds shows the task's header as today: state, title, Stop, the task's runtime
  picker, its approvals, and a link to the task's own page. An unowned thread shows a plain header;
  the console offers no "make this a task" control, since opening a task is the coordinator's call.
- The address is `?thread=<rootId>` on the conversation's page, replacing `?task=<id>`; a task page's
  shrink link points at its first thread.
- On a desktop, a thread opens in the panel when its first reply starts while the person watches,
  the latest one when several do; threads already there when the page opened do not. A phone does
  not open the sheet; the footer shows "is working…" and the reply count.
- On a phone the panel is the dock's existing bottom sheet; the timeline and the thread share one
  responsive tree.

### 6.3 Writing in a thread

- **The owner** writes in any thread from the thread composer, which sends a `turn` with `thread` on
  the conversation's own socket; routing (§4) takes it to the task or the coordinator.
- **Other members of a published coordinator** may write in a thread a task holds, from the task's
  page or the thread panel, as they may write to a task's page today. Their message is sent through
  the session-targeted continuation, recorded as a reply in that thread, and routed to the task.
  They may not post roots or write in an unowned thread, since both reach the coordinator, which is
  the owner's alone.
- The `targetSessionId` path otherwise stays for legacy page tasks (§10) and for continuing sessions
  of other integrations.

## 7. A Slack coordinator's page has Slack's shape

A coordinator on Slack is drawn with the same components and rules as §6:

- **Roots** are the channel roots the coordinator received since its coordinate began, read from the
  channel record. A `!new` at the root starts a new coordinator page; the old one keeps its roots.
- **Coordinator turns** stay in the main timeline with the labels of §6.1; task reports to the
  coordinator show there too.
- **Thread footers** sit under their roots and count the Slack thread's record (§3): people, the
  coordinator's `replyToMessage`, the task's answers, other agents, observations included. A task
  that also holds a Code channel (auto-session-mode.md §6.8) shows the channel in its footer.
- **Thread replies the coordinator received** before a task held the thread are drawn in the thread,
  not in the main timeline.
- **The thread panel** reads the thread record, not the task's session history, so it shows the
  Slack thread as Slack does. "Open in Slack" links the thread's permalink.
- **Writing.** The panel's composer continues the holding task as today's task page does, mirrored
  into the Slack thread under the person's name
  ([webchat-cross-integration-continuation.md](webchat-cross-integration-continuation.md)). An
  unowned thread's panel has a composer too: the message is mirrored the same way and admitted as
  any message there (§4), to the coordinator with the thread named, or to a task that holds the
  thread by then. Who may write follows the existing continuation rules for the channel's
  coordinator.
- **The root composer** keeps today's behavior for the coordinator page.

Other platforms differ in their thread shape (Discord thread channels, Telegram topics or reply
chains, DingTalk reply chains). The web platform module declares it in its channel semantics
(`WebPlatformModule`), and the page reads that declaration, never a platform name. Webchat is
core-owned, not a platform module (integration-plugin-architecture.md §2), so its declaration is
core's own and PR 12 does not make webchat a module. This proposal implements Slack and webchat; a
platform without a declaration keeps the flat transcript.

### 7.1 Who may read a thread

A thread is read through its conversation: whoever may view the coordinator session may read its
roots, footers and unowned threads, observations included. This widens what the console shows of a
Slack conversation, from the rows admitted into sessions to the threads' full records, to the same
audience that may already view the coordinator. A thread a task holds is read only by someone who
may view that task's session; a task its sender made private before it became a task
(auto-session-mode.md §6.2) shows its footer with the count and no content to anyone else.

The audience is unchanged, but one case widens what it reads: while a platform's session access
sync is off, every member sees a Slack conversation's sessions (product-conventions.md "Session
visibility"), so the observations of a private channel, said by people who never addressed the
agent, are shown to every member. This is accepted (decided 2026-11-06): the thread panel shows the
same audience the whole thread, sync on or off. PR 8 adds the console's read of observations to
`.oss-scanner/threat_model.md`. This answers message-intake.md §13 question 1 for
coordinator pages.

## 8. Wire and reads

| Surface                                   | Change                                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Browser → relay `turn`                    | `thread?: string`                                                                                                 |
| `RelayWebchatOp.turn`, `WebchatPost`      | `thread?: string`                                                                                                 |
| Daemon → relay posts and streams          | `thread?: string` on `WebchatPost`, `WebchatOutput` and `WebchatDone`: the thread they answer in                  |
| Turn ack reasons                          | `unknown_thread`                                                                                                  |
| Daemon feature                            | `webchat-threads-v1`, advertised with `session-mode-auto-v1` under `features.autoSessionMode`                     |
| Relay → browser hello                     | `webchat-threads-v1` in the `ready` frame's `features` once the relay forwards `thread`                           |
| `session/history` (daemon control RPC)    | A `roots` view: roots and coordinator turns with the §5.3 summaries, paged like today                             |
| `session/thread` (new daemon control RPC) | One thread record by `(sessionId, rootId)`, paged; authorized by §7.1                                             |
| BFF                                       | `GET /orgs/:org/sessions/:id/messages?view=roots` and `GET /orgs/:org/sessions/:id/threads/:rootId/messages` (C2) |

A task's own session keeps its four-part key, `webchat:<conv>:<rootPostId>:<agent>`, so the merged
conversation codec (merged-conversation-view.md §5.1) would group it as a conversation of its own.
Session lists leave tasks out by default and list them under "Show tasks" through
`taskParentSessionId` (product-conventions.md "Tasks"), so a task thread appears only there, as its
own entry linked to its coordinator, never folded into the coordinator's entry.

A `thread` is a root's `postId`, so the wire admits only a UUID (`WebchatThreadId`); the relay
refuses a turn whose `thread` is malformed rather than post it at the root. The protocol names the
feature `WEBCHAT_THREADS_FEATURE`; the daemon advertises it from PR 5, once its coordinator answers in
threads, so the console never offers threads to a daemon that only records them.

The BFF routes proxy bounded transcript reads to the owning daemon and persist nothing, as the
session history route does. Each route gets its OpenAPI `tags`, `summary`, `description` and
`operationId`.

## 9. Effect on existing agents

| Who                           | What changes                                                                                                                                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A webchat coordinator         | Its answers go into the message's thread; it gets a new kind of input, a follow-up in an unowned thread, marked with its thread; its prompt changes (§4.2). Its turns stay visible in the main timeline                                        |
| A webchat coordinator's task  | Keyed on its thread (§5.2) and opened with the thread so far; threaded standing context; audience, publish cascade, admin MCP grant and request listing stay as today through §5.4; other members of a published coordinator still write to it |
| A legacy page task            | Unchanged until it closes (§10)                                                                                                                                                                                                                |
| A Slack coordinator and tasks | Routing and behavior unchanged. New: a person may reply from the console in an unowned thread, mirrored into Slack under their name                                                                                                            |
| Storage                       | Observations in threads agents took part in are kept longer (§5.5)                                                                                                                                                                             |
| Unaffected                    | Ordinary webchat conversations, multi-agent webchat conversations, tasks' own threads (no nested threads), AHP                                                                                                                                 |

## 10. Compatibility and rollout

- **Gating.** `webchat-threads-v1` rides `features.autoSessionMode`, which is on by default, so an
  upgraded daemon moves its webchat coordinators to threads at once. The console offers threads only
  where the agent's daemon advertises the feature and the relay forwards `thread`; otherwise the
  coordinator runs as today (threadless prompt, page tasks, link cards). Each change is verified on
  the test environment after it merges; there is no separate merge gate.
- **Existing page tasks** keep their `subsession:` coordinate, their link cards and their
  `targetSessionId` continuation until they close; the console draws a legacy link card as a thread
  footer whose panel reads the task's session. New tasks after the upgrade are threaded. Nothing is
  migrated. Once the 90-day retention of closed tasks has passed, the page-task branch is removed.
- **A downgrade** loses grouping, not messages: an old daemon ignores `thread`, so a reply sent to it
  is recorded and routed as a root, and rows already recorded in a thread keep their thread for a
  later upgrade. The console stops offering Reply in thread as soon as the feature is gone.
- **Only coordinator conversations have threads.** An ordinary webchat conversation, a task's own
  page and the thread panel never offer Reply in thread (§5.1).

## 11. Pull requests

Each row is one PR, landed in this order where it depends on another; the type follows
CONTRIBUTING.md. Rows 5, 9, 11, 12 and 13 change what users see and update
[product-conventions.md](../product-conventions.md) "Tasks" and auto-session-mode.md §10 with them.

| #   | Type       | Change                                                                                                                                                             | Areas            | Size | After |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | ---- | ----- |
| 1   | `docs`     | This proposal                                                                                                                                                      | docs             | S    | —     |
| 2   | `chore`    | `thread` on the webchat wire, `unknown_thread`, `webchat-threads-v1`; relay forwards and announces it                                                              | protocol, relay  | S    | —     |
| 3   | `refactor` | Recognize a task by the task index at the gates of §5.4, and keep the current-session pointer on the coordinator                                                   | daemon, CP       | M    | —     |
| 4   | `chore`    | Record webchat rows with their physical thread; `prepareTurn` thread and `msgId`; refuse `unknown_thread`                                                          | daemon           | M    | 2     |
| 5   | `feat`     | Webchat coordinator through `keySession` / `autoCoordinateFor`; tasks on thread coordinates opened with the thread; `replyToMessage` in the thread; prompts (§4.2) | daemon           | L    | 3, 4  |
| 6   | `chore`    | Keep the observations of threads agents took part in (§5.5)                                                                                                        | daemon           | S    | 4     |
| 7   | `chore`    | Thread summaries, the `roots` view and `session/thread`                                                                                                            | protocol, daemon | M    | 4     |
| 8   | `chore`    | BFF read routes, OpenAPI, thread read authorization and threat model (§7.1)                                                                                        | CP               | S    | 7     |
| 9   | `feat`     | Other members of a published coordinator write in a task's thread (§6.3)                                                                                           | CP, daemon       | M    | 3, 5  |
| 10  | `refactor` | `ThreadPanel` and the thread footer, generalized from `TaskThreadPanel` and `TaskThreadCard`, reading the thread record                                            | web              | M    | 8     |
| 11  | `feat`     | Webchat coordinator page: footers under roots, Reply in thread, thread composer, `?thread=`, auto-open, phones, the §6.1 labels                                    | web              | L    | 5, 10 |
| 12  | `feat`     | Slack coordinator page in Slack's shape; the platform module's thread-shape declaration                                                                            | web              | M    | 10    |
| 13  | `feat`     | Reply from the console in an unowned Slack thread                                                                                                                  | daemon, web      | M    | 12    |
| 14  | `chore`    | Remove the page-task branch, link cards and the threadless prompt after the 90-day retention                                                                       | daemon, web      | M    | later |

PR 3 and PRs 7, 8 and 10 can run beside PR 5. PR 5 carries the most risk: the coordinator's prompt
and where it answers change, so it adds the coordinator scenario "a follow-up in an unowned thread"
to the webchat scenarios of auto-session-mode.md §12 and is watched on the test environment.

## 12. Decisions (2026-11-06)

1. **Threads exist only in coordinator conversations.** An ordinary webchat conversation is already
   one session, and a task's thread is the task's conversation (§10).
2. **Every agent of a conversation participates in every thread** (§4.1).
3. **No "also send to the conversation"; the footer previews the latest reply** (§6.1).
4. **The console may reply in an unowned Slack thread** (§7).
5. **AHP is out of scope.** It is switched off today, and an AHP conversation stays an ordinary one
   (auto-session-mode.md §10).
6. **The coordinator answers in the thread** (§4), and **its turns stay in the main timeline**
   (§6.1), labelled when they answer a thread message, with `replyToMessage` as one line.
7. **The thread panel shows chat messages and the holding task's turns**, not coordinator turns
   (§6.2).
8. **A task opens with the whole thread so far** (§4) and **uses the threaded standing context**
   (§4.2).
9. **The Slack thread panel shows observations**, to whoever may view the coordinator (§7.1), and
   **threads agents took part in keep them** (§5.5).
10. **Legacy page tasks run unchanged until they close** (§10).
11. **The feature rides `features.autoSessionMode`, on by default**, verified on the test environment
    after each merge (§10).
12. **Other members of a published coordinator keep writing to its tasks**, in the tasks' threads
    only (§6.3).
13. **A task's permission requests list on the coordinator and in the task's thread** (§5.4).
14. **A thread opens in the panel when its first reply starts**, on a desktop only (§6.2).
15. **A private channel's observations show while session access sync is off too**, to everyone who
    sees the conversation (§7.1).
