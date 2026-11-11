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

| Term          | Meaning                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root          | A message at the conversation's top level                                                                                                               |
| Thread        | A root and the replies under it, named by the root's id: its Slack `ts`, its webchat `postId`                                                           |
| Owned thread  | A thread a task holds (auto-session-mode.md §2); a task may hold several                                                                                |
| Thread record | The channel-record rows whose physical thread is the thread, whichever sessions admitted them, observations included                                    |
| Reply count   | Slack's count: every chat message in the thread record except the root, from people and agents alike; work rows (tool calls, reasoning) are not counted |
| Thread footer | The line under a root: reply count, participants and last reply time, the holding task's state and summary, and "is working…" while live                |

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
  task as one more thread (§6.4 there), except a webchat message at the root: it joins the task's
  thread in the conversation, where the task answers, and its own thread is not attached (§5.1). In
  webchat these go through the same `openTask` / `handTo` branch Slack uses; `openPageTask`,
  `messageForPageTask` and the link card are not used for a daemon that serves threads (§10).
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

### 4.3 As implemented (PR 5)

- **Keying.** `prepareTurn` still recognizes a coordinator conversation by `coordinatorCoordinate`, then
  asks the daemon's `keyCoordinatorMessage` where the message goes. It shares
  `threadTaskSession` with `autoCoordinateFor`, so a reply in a thread a task holds keys on the task's
  session and anything else stays on the coordinator. Webchat has no integration from which `keySession`
  could read a mode, so the call is made at turn preparation instead.
- **A held thread's reply** runs as the browser's own turn on the task. `PreparedChatTurn.answersIn`
  names the thread, and the turn's `output`, `done` and committed posts carry it as `thread`. The
  coordinator's turns carry no `thread`: they stay in the main timeline (§6.1). No turn in a
  coordinator conversation takes the browser's per-turn runtime or worktree (`coordinated`).
- **A root handed to a task** (`messageTask` on a webchat message at the root) joins the task's
  thread R: its session's thread, else its first held thread in the conversation. `handTo` attaches
  nothing, marks the row handed to R, and dispatches the message with `thread: R`, so the task
  answers and streams in R. The call answers `{ ok, taskId, joinedThread }`. A message in a thread,
  a legacy page task and every other platform keep attaching the message's thread.
- **A task the coordinator opens or hands a message to** has no browser turn. It runs with a post-only
  context (`WebchatTransport.webchatThreadContext`) and posts each answer with `initiator: 'agent'`
  and the thread, as an agent wake does. Its inbox row replays with the same context.
  `postAgentWakeInbound` never re-posts a person's message.
- **Opened with the thread.** A new task's session reads the rows on its thread as any session does.
  On a webchat task's first round, the replay also keeps the agent's own rows (`ownRowsAsContext`),
  so the coordinator's earlier answers are context too, under the agent's name. A Slack task's
  opening is unchanged.
- **`replyToMessage`** posts in `answerThreadOf(msg)` and records the row there. A report whose
  thread is not a root's postId is still answered at the root.
- **`threadless`** is now `platform === 'webchat'` without a `thread`. Only a message without a
  post, such as an MCP app's `ui/message`, still opens a page task.
- **Legacy page tasks** (§10). A message handed to one moves to its page, and the link card is posted
  in the message's thread. A reply in a thread such a task holds keys on its session, off the
  conversation's channel (`sessionChannel`).
- **Prompt.** The webchat form describes a conversation with threads; the threadless form is gone,
  so PR 14 removes only the page-task branch and link cards. `webchat-thread-follow-up` joins the
  coordinator probe (auto-session-mode.md §12).
- **Feature.** The daemon advertises `webchat-threads-v1` with `session-mode-auto-v1`.
- **Until PR 11**, the console ignored `thread` on posts and drew a task's answers in the main
  timeline, with the task's card from `openedForMessageId` under the coordinator turn (§6.1).

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

As implemented (PR 4):

- Only a coordinator conversation's turns get a `thread` and the per-post `msgId`. An ordinary
  conversation keeps `msgId: webchat:<conv>`, no `thread`, and its rows on `webchat:<conv>`, so its
  session key never moves.
- `threadForPlatformMessage` matches a row by its `ts` or its webchat `postId`. A `thread` is a root
  when its row's recorded thread is the post itself or the literal `webchat:<conv>`.
- The rows a turn writes follow the message's thread through the turn plan's `statusThread`, as on
  Slack. This covers the coordinator's streamed answer, its tool rows and its cards. They stay admitted
  into the coordinator's session, so `session/history` is unchanged. Readers tell coordinator turns
  apart by that admission (§6.1, §6.2), except the coordinator's own posts in a thread, which carry the
  same admission and are marked instead (§5.3, PR 7).
- Until `threadless` flips (PR 5), `answerThreadOf` still answers a webchat message at the root, and
  `replyToMessage` reports `at: 'root'`. A reply in a thread already reaches the coordinator with its
  `thread` named (§4).
- A session-targeted continuation (`targetSessionId`) that names a `thread` is refused
  `unknown_thread` unless the targeted task holds that thread (§6.3, PR 9).
- Peers' `context` copies stay on `webchat:<conv>`, because a coordinator conversation has no other
  participants (§4.1).

A root handed into a task's thread:

- The row stays where it was recorded: its thread is its own `postId`, and the task's admission of the
  same post adds no second row, since text rows dedupe on `(orgId, channel, ts)`.
- `transcript.handedTo` names the thread R it joined (store v78, both dialects).
  `LocalStore.markTranscriptHanded` sets it and bumps the row's revision, so open views see it.
- Readers place the row by `COALESCE(handedTo, thread)`: R's thread record and reply count include
  it, and it has no footer of its own. Messages handed before the change carry no mark. Their own
  thread stays attached to the task, so they keep their own footer.

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

As implemented (PR 7):

- **A thread** is named by a root text row whose `ts` or webchat `postId` it is, the same test the
  retention rule (§5.5) and `isRoot` use. A row recorded on a thread its root names is a reply in that
  thread; a row whose thread is its own, absent, or names no recorded root is at the root, which keeps a
  legacy `webchat:<conv>` row a root.
- **The thread record a session reads** is the root and the thread's rows, without the reading
  session's own turns (rows its agent sent that were admitted into it, unless the session's coordinate
  is the thread, as a task's is) and without other agents' work rows. People's replies, the
  coordinator's posts in the thread, the holding task's turns and observations are in it.
- **The coordinator's posts in a thread** (`replyToMessage`, a legacy link card) carry
  `UserTurnBody.threadPost`, since they share the coordinator's admission with its turns.
  `postWebchatAgentMessage` sets it whenever it posts in a thread.
- **A root handed into a thread** counts as one of its replies and gets no summary of its own (§5.1).
- **The summary** (`SessionThreadSummary`) carries the root's excerpt, the reply count, `lastReplyAt`,
  the latest reply's author and excerpt, up to five repliers newest first, the holding task's session
  id, title and state from the task index, and `running` while the task's session is prompting. Its
  content is filtered by the CP for a task the viewer may not read (§7.1, PR 8). `repliesOf` keeps
  counting a task's own session for the Activity view.

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
in which any row was admitted into a session is exempt: its observations are kept while any of its
rows is still admitted, and once the last admission goes with its session (message-intake.md §8
rule 1) the thread is swept as today. Threads no agent took part in are swept as today, so the
growth is bounded by the threads agents worked in.

As implemented (PR 6):

- `LocalStore.sweepObservations` skips a row whose thread is one an agent took part in: a thread
  that a `text` row names as its own (its `ts` or webchat `postId` equals its recorded thread, as a
  Slack or webchat root does) and that holds at least one admitted row. Both sets are computed once
  per sweep over the conversation, so the sweep stays one pass per conversation.
- A thread no recorded root names is swept as today. This covers a whole-room thread (a DM keyed on
  its channel, or a constant thread such as QQ's), the literal `webchat:<conv>` of an ordinary
  conversation or of rows written before threads, rows with no thread, and a thread whose root the
  daemon never recorded. So the exemption never covers a whole conversation.
- Nothing new is stored: the exemption is computed from the channel record and its admissions.

## 6. The webchat conversation page

### 6.1 Main timeline

- The page shows roots and every coordinator turn in order, as today. A root's thread footer sits
  directly under the root; a root a task holds shows the task's state icon and title in the footer,
  which replaces the link card and the `openedForMessageId` card under a coordinator turn.
- Messages in a thread are not in the main timeline, even those the coordinator received because no
  task held the thread then; they are in the thread and in its reply count.
- A coordinator turn answering a thread message carries a label, "In thread: <the root's first
  words>", that opens the thread. A turn answering a root has none.
- The coordinator's work on a thread (its reasoning and tool calls, `replyToMessage` included) is
  drawn in that thread's panel, not in the main timeline; the answer's text is only in the thread.
- Nothing is posted to the main timeline on a thread's behalf: there is no "also send to the
  conversation".
- A person's message offers **Reply in thread** in its hover menu: in its own thread, or in the
  thread a redirected message joined. On a phone, a tap on the footer or a long-press menu does.

As implemented (PR 11):

- **Time lines** between turns lead with the date for a turn not from today (`turnTimeLabel`).
- **Every message has a bubble.** An agent's posts sit in the same neutral bubble as anyone else's
  message on the left (`AGENT_BUBBLE`), under its name line and above any open work panel; its
  cards and task cards sit inside the bubble at the bottom, and a thread's replies line sits under
  the bubble, outside it. Which side a message is drawn on does not change.
- **The roots view.** A webchat coordinator's page reads `session/history` with `view: 'roots'`
  (`useSessionTranscript`'s `rootsView`) and keeps each page's `threads` by root, the newest read
  winning; an open thread panel's own read updates its footer too. A 409 `DAEMON_FEATURE_MISSING`
  falls back to the flat view for the rest of the visit.
- **A person's row with `thread`** is drawn as no bubble: it ends the turn before it, and the
  coordinator turn after it is labelled "In thread: <first words>" from the footer's `rootExcerpt`,
  else the root's own text. A root (a person's row whose `postId` is a UUID and that has no
  `thread`) gets `ThreadFooter` under its bubble once a summary names it. The coordinator's prose
  rows stay in the main timeline; its other rows with `thread` (reasoning, tools) leave it for that
  thread's panel (`splitThreadWork`), a turn left with nothing dropped.
- **`replyToMessage`** is read off the coordinator's tool row (`rawInput.action`); where the row has
  no `thread`, its "Answered in the thread" line opens the thread of the message id it names.
- **Live steps** carry `thread` (`SessionStep.thread`): the owner's message sent in a thread, and
  every frame and post the daemon stamps with one. The main timeline leaves them out; a coordinator
  turn answering such a message streams there unstamped and takes the label. The typing indicator
  stays off for a thread turn until an unstamped step shows the coordinator is answering it.
- **No `openedForMessageId` cards** in the roots view: the root's footer carries the task. A legacy
  link card is a post in its thread, so it shows there.

### 6.2 The thread panel

- The thread opens in the side panel, replacing `TaskThreadPanel` with a general `ThreadPanel`: the
  root at the top, then the thread's chat messages in order (people, the coordinator's answers,
  other agents) and the holding task's turns with their work folded as today, then a thread
  composer. Under the root, the coordinator's work on the thread from the main timeline (§6.1); a
  "Replies" divider then separates what came from the main timeline from the replies below it.
- A message the coordinator redirected into the thread from the conversation (`handedTo`) is
  highlighted in the panel with "Redirected from coordinator" above it.
- Every message's hover menu offers **Share**: the Share dialog of the session it is read in, whose
  Copy link names the message (`#msg=<transcript seq>`). A message in a thread a task holds links to
  the task's own page, one in an unowned thread to the conversation's `?thread=` address, and one on
  the main timeline to the conversation. Arriving by such a link scrolls to the message and marks it
  briefly (`useLocateMessage`).
- A thread a task holds shows the task's header as today: state, title, Stop, the task's runtime
  picker, its approvals, and a link to the task's own page. An unowned thread shows a plain header;
  the console offers no "make this a task" control, since opening a task is the coordinator's call.
- The address is `?thread=<rootId>` on the conversation's page, replacing `?task=<id>`.
  A task page's Back and Close controls return to the coordinator.
- On a desktop, a thread opens in the panel when its first reply starts while the person watches,
  the latest one when several do; threads already there when the page opened do not. A phone does
  not open the sheet; the footer shows "is working…" and the reply count.
- On a phone the panel is the dock's existing bottom sheet; the timeline and the thread share one
  responsive tree.

As implemented (PR 10):

- **`ThreadPanel`** (`dock/ThreadPanel.tsx`, formerly `TaskThreadPanel`) reads a thread's record
  through the conversation's session when given `record: {sessionId, rootId}`
  (`useThreadRecord`, `task-thread.ts`), and a task's own session when given only `task`, as every
  caller does until PR 11. The holding task comes from `task` or the record's footer; it gives the
  header, Stop, the page link, approvals and the composer, which still continues the task's session.
  An unowned thread gets a plain header and no composer until PR 11. A footer that is not
  `readable` gets a notice and no content, a root the session never received a notice, and a long
  thread a "Show earlier messages" control that pages back with `cursor`.
- **409 `DAEMON_FEATURE_MISSING`** from the thread read falls back to the task's session when the
  panel knows the task; an unowned thread then shows a load failure.
- **`ThreadFooter`** (`ThreadFooter.tsx`, formerly `TaskThreadCard`) draws a `ThreadFooterView`, held
  or not, as the replies line (up to five repliers, the count, the last reply's time and "working…"
  while `running`; repliers are drawn with their picture or agent icon; the line has no hover
  text), then the holding task's card: its state, its title and, beneath in a
  lighter face, the task's own summary where it wrote one. On a root (`part`), the line stays under
  the person's bubble and the card is drawn on the left as the coordinator's message (`from`): its
  mark, name and the task's state, over a bubble holding a card showing the task's summary alone.
  On the agent's own post at the root, the card sits at the bottom inside the post's bubble and
  the line sits under the bubble, outside it. Hovering the
  card shows a toolbar on its top edge with Reply (opens the thread at its composer) and the task
  session's Share, the dialog its own page's header opens (`SessionShareButton`); a held thread's
  panel header offers the same Share. `footerOfSummary` builds it from a `SessionThreadSummaryDto`, and
  `RootThreadFooter` adds the summary from the conversation's task list. A held thread rests between
  turns, as a threaded task does. An unreadable footer names "a task you can't open", shows no
  preview and opens nothing; one whose task is `starting` says it is starting instead, until its
  session exists.
  `TaskThreadFooter` builds the same footer from a task's row, which is how today's link and
  `openedForMessageId` cards are drawn, so they look as before.
- **Bindings** (`lib/api.ts`): `fetchSessionMessages(id, {view: 'roots'})` returns `threads`, and
  `fetchSessionThreadMessages(id, rootId, {cursor | after, limit})` reads one thread.

As implemented (PR 11):

- **Opening.** A footer, an "In thread" label, an "Answered in the thread" line or Reply in thread
  opens `ThreadPanel` with `record: {sessionId: <coordinator>, rootId}`, and with `task` from a
  readable footer, so a daemon without thread reads falls back to the task's session. The page's
  address follows the open thread (`?thread=<rootId>`, written with `router.replace`), and an
  address it did not write opens the thread it names. `?task=<id>` still opens a legacy page task.
- **Auto-open** (desktop only, `threadToAutoOpen`) opens the latest thread whose first reply arrives
  while the page is open: a root that had no replies when the page first saw it and now has some, or
  a thread an agent starts speaking in live. Each opens once.
- **Phones** reach Reply in thread through a long press on the root, which opens a one-item menu;
  the footer opens the thread in the dock's bottom sheet, and nothing opens by itself.

### 6.3 Writing in a thread

- **The owner** writes in any thread from the thread composer, which sends a `turn` with `thread` on
  the conversation's own socket; routing (§4) takes it to the task or the coordinator.
- **Other members of a published coordinator** use the same `session.continue` policy as any shared
  session. Non-viewer members may post roots and write in any readable thread on the conversation's
  socket, under their own identity. The daemon reads the recorded coordinator coordinate, so roots
  and unowned threads reach the existing coordinator and held threads reach their task. A task's
  own page still uses session-targeted continuation.
- The `targetSessionId` path otherwise stays for legacy page tasks (§10) and for continuing sessions
  of other integrations.

As implemented (PR 9):

- **Who.** `continuableSession` (`packages/protocol`) accepts a webchat session with
  `taskParentSessionId`, the Control Plane's mark of a coordinator's task (§5.4). The composer, the
  token and every dial judge it by the coordinator's audience (`continuationAudience`, PR 3), so
  other members write once the owner publishes the coordinator. Session-targeted continuation
  remains for tasks; the coordinator and ordinary conversations resume on their own socket.
- **Feature.** The Control Plane mints and verifies such a continuation only where the daemon
  advertises `webchat-threads-v1` (`taskContinuationFeature`, which still asks a page task's daemon for
  `task-page-messages-v1`). Without it the composer reads `unavailable`.
- **Where.** `ChatSessionContinuation.prepare` recognizes the target by the task index
  (`webchatCoordinatorTask`). It takes the turn's `thread`, or without one the task's own thread,
  only when the task holds it among its webchat threads. Any other thread, an unowned one included,
  is refused `unknown_thread`, and a closed task's session `not_found`. The message keeps the task's
  coordinate as `sessionThread`, so it runs on the task's session, and is recorded in the thread under
  its relay `postId`, a reply there for the thread reads (§5.3) like any other.
- **Console-only.** As for a page task, nothing is mirrored and the answer streams to the writer's own
  page. Its frames and posts carry no `thread`, since a task's page has no threads (§10), and nothing is
  posted into the owner's conversation; the owner reads both in the thread.
- **AHP** is out of scope (§12): an AHP grant still refuses a thread-keyed task, as a continued webchat
  session that is not its conversation's current one.

As implemented (PR 11):

- **The owner** writes from `ThreadPanel`'s composer in any readable thread, held or not, through
  `pgSendThread(conversationSessionId, agentId, text, rootId, conversationId)`: a `turn` with
  `thread` on the conversation's own socket, with a draft of the thread's own, so the conversation's
  composer, its image and its files are untouched. The panel draws the live steps stamped with its
  thread and is busy only for a turn sent in it (`getPgTurnThread`).
- **A thread message never steers**: one sent while a turn runs, or any message while a thread turn
  runs, queues and goes out in turn; the conversation's composer does not list a queued thread message.
- **Reconciling** is scoped (`liveThreadScope`): a thread's record retires its own turns, and the
  roots view retires the root's turns and a thread message the coordinator answered.
- **Another member** writes in a held thread through the task's session-targeted continuation, now
  with `thread` set to the panel's root, so it lands in that thread among the task's; its steps are
  not stamped, since the frames that answer it carry no thread.
- **Who sees the composer**: Reply in thread and the conversation's composer show where the page's
  reader may continue the conversation, it can resume, its agent's daemon advertises `webchat-threads-v1`,
  and the relay's `ready` frame, once read, lists it (`getPgRelayFeatures`).

## 7. A Slack coordinator's page has Slack's shape

A coordinator on Slack is drawn with the same components and rules as §6:

- **Roots** are the channel roots the coordinator received since its coordinate began, read from the
  channel record. A `!new` at the root starts a new coordinator page; the old one keeps its roots.
- **Coordinator turns** stay in the main timeline with the labels of §6.1, their work on a thread
  drawn in its panel; task reports to the coordinator show there too.
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
chains, DingTalk reply chains). The web platform module declares it (`WebPlatformModule.threadShape`),
and the page reads that declaration, never a platform name. Webchat is
core-owned, not a platform module (integration-plugin-architecture.md §2), so its declaration is
core's own and PR 12 does not make webchat a module. This proposal implements Slack and webchat; a
platform without a declaration keeps the flat transcript.

As implemented (PR 12):

- **The declaration.** `WebThreadShape` (`platforms/contract.ts`) says how a thread is named
  (`isThreadId`: a Slack ts), how it is linked on the platform (`threadUrl`, from the conversation's
  channel, its workspace and the root's id), and whether a continued task takes the thread a message
  is written in (`continuesInThread`, webchat only). Slack's module declares one. Webchat's,
  `WEBCHAT_THREAD_SHAPE`, lives in `coordinator-threads.ts`, and `threadShapeOf(platform)` resolves
  either; a coordinator's page reads the roots view only where it returns one.
- **Roots** are a person's rows without `thread` whose id (`postId`, else the Slack `ts`) the shape
  names; everything else of §6.1 (footers, hidden thread replies, labels, the answered line, `?thread=`,
  auto-open) is shared with webchat. Reply in thread and the owner's composer stay webchat's
  (`threadsWritable`); a Slack root offers neither until PR 13.
- **The panel** links the thread with "Open in Slack" (`ThreadPanel`'s `threadUrl`): the web client's
  `app.slack.com/client/<team>/<channel>/thread/<channel>-<ts>`, the team being the coordinator
  session's `tenantScope`. In a held thread the composer continues the task with `pgSend`, naming no
  thread, so the daemon writes it in the task's own Slack thread as the task's page does, and the hint
  says so; webchat's `pgSendThread` is kept for a shape with `continuesInThread`. A thread no task
  holds has no composer.
- **A Slack task's page** returns to the coordinator through Back or Close.
- **Not drawn yet:** a task's Code channel in its footer. The summary (§5.3) names only the holding
  task, not the other threads it holds, so the footer cannot show the channel until it does.

As implemented (PR 13):

- **Who.** Reply in thread on a Slack root, and the panel's composer in a thread no task holds, show
  where the reader may continue the coordinator (the page's own `canContinue`), its agent's daemon
  advertises `continuation-threads-v1`, and the relay's `ready` frame, once read, lists it. The panel
  writes through the coordinator's session-targeted continuation (`writer.continues`) with `thread`
  set to the root's ts, and draws the message in the thread (`markSessionTarget(…, threads)`); the
  coordinator's answer streams in the main timeline, labelled. A held thread's composer still
  continues the task.
- **Wire.** This row also touches protocol and relay. A turn's `thread` is a `TurnThreadId`: a webchat root's UUID, or, on a continued
  session's socket only, a platform root id (`PlatformThreadId`). The relay refuses a non-UUID
  `thread` on any other conversation, keeps it out of peers' context copies, and announces
  `continuation-threads-v1` in `ready`. An older relay refuses the frame, so nothing posts at the
  root.
- **Daemon.** `ChatSessionContinuation.prepare` takes a `thread` on a coordinator's coordinate when
  the coordinator received that root (`sessionReceivedRoot`, the check `session/thread` makes), and
  refuses any other `unknown_thread`, as an older daemon does. The mirror posts in the thread and
  becomes the message's own id, then `keyCoordinatorMessage` keys it as `autoCoordinateFor` keys a
  Slack reply: on the task holding the thread, else on the coordinator with the thread named. The
  daemon advertises `continuation-threads-v1` with `session-mode-auto-v1`. Nothing names a platform:
  the daemon reads a coordinate and the channel record, the console the module's thread shape.

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

As implemented (PR 8):

- **The conversation's audience** is the session read's: both routes first require that the caller
  may view the session they read through, and re-check it after the daemon answers, as the session
  history route does.
- **A held thread** is a summary with `task`. Its content is shown only when the caller may view
  `task.sessionId`, a session of the same agent (`threadReadable`, `domain/thread-read.ts`). A task
  whose session does not exist yet, or that the CP has no row for, is read by nobody, so the check
  fails closed while a task is starting; its footer's `task.starting` says so, so the console shows
  "starting" rather than "a task you can't open" for those few seconds.
- **Without that view** a footer keeps the reply count, authors, last reply time, the task's state
  and `running`, and loses `rootExcerpt`, the latest reply's excerpt and the task's title; it says
  `readable: false`. The thread read answers that footer with no messages and no cursors.
- **The row marks of the roots view are not filtered.** Every row the view returns was admitted into
  the session being read, so the caller may already read it in the flat view.

## 8. Wire and reads

| Surface                                   | Change                                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Browser → relay `turn`                    | `thread?: string`; a platform root id only on a continued session's socket (§7)                                   |
| `RelayWebchatOp.turn`, `WebchatPost`      | `thread?: string`                                                                                                 |
| Daemon → relay posts and streams          | `thread?: string` on `WebchatPost`, `WebchatOutput` and `WebchatDone`: the thread they answer in                  |
| Turn ack reasons                          | `unknown_thread`                                                                                                  |
| Daemon feature                            | `webchat-threads-v1`, advertised with `session-mode-auto-v1` under `features.autoSessionMode`                     |
| Continued coordinator threads             | `continuation-threads-v1` from the daemon (same switch) and in the relay's `ready` (§7, PR 13)                    |
| Relay → browser hello                     | `webchat-threads-v1` in the `ready` frame's `features` once the relay forwards `thread`                           |
| `session/history` (daemon control RPC)    | A `roots` view: roots and coordinator turns with the §5.3 summaries, paged like today                             |
| Session message rows                      | `handedTo?: string` on a webchat root handed into a task's thread: that thread's root id (§5.1)                   |
| `session/thread` (new daemon control RPC) | One thread record by `(sessionId, rootId)`, paged; authorized by §7.1                                             |
| Daemon feature for the reads              | `session-thread-reads-v1`, static; the CP sends neither read to a daemon without it                               |
| BFF                                       | `GET /orgs/:org/sessions/:id/messages?view=roots` and `GET /orgs/:org/sessions/:id/threads/:rootId/messages` (C2) |

A task's own session keeps its four-part key, `webchat:<conv>:<rootPostId>:<agent>`, so the merged
conversation codec (merged-conversation-view.md §5.1) would group it as a conversation of its own.
Session lists leave tasks out by default and list them under "Show tasks" through
`taskParentSessionId` (product-conventions.md "Tasks"), so a task thread appears only there, as its
own entry linked to its coordinator, never folded into the coordinator's entry.

A `thread` is a root's `postId`, so the wire admits only a UUID (`WebchatThreadId`), except a
continued coordinator's platform root (§7, PR 13); the relay refuses a turn whose `thread` is
malformed rather than post it at the root. The protocol names the
feature `WEBCHAT_THREADS_FEATURE`; the daemon advertises it from PR 5, once its coordinator answers in
threads, so the console never offers threads to a daemon that only records them.

As implemented (PR 7):

- **`session/history` with `view: 'roots'`** pages the session's own rows as the flat view does,
  without the coordinator's posts in threads. Each row that is a reply in a thread carries `thread`, the
  root's id: the coordinator's turn rows there, and the thread message the coordinator received that
  started such a turn, which the console draws as the turn's "In thread" label rather than as a
  message. A turn answering a root also sits on the root's thread, and starts at the root itself.
  `threads` carries the summaries of the roots and threads the kept rows name, each counted once in the
  frame budget; a forward page (`after`) adds up to 20 threads whose rows changed since the cursor and
  whose root the session received. When more changed, its cursor stops before the first one left out
  and `liveMore` is set, so the next poll reports it.
- **A handed root** keeps its place in both views and carries `handedTo`. In the `roots` view it names
  that thread's summary instead of one of its own. `session/thread` for R includes it in order among
  R's replies, also with `handedTo`, and the BFF routes pass the field through.
- **`session/thread`** (`agentId` required) answers only for a root the session received, on its
  coordinate or admitted into it; a reply's id, an unknown root or another agent's session get an empty
  page without `summary`. It pages by event time where ids order natively, else by seq, and tails by
  revision, as `session/history` does.

The BFF routes proxy bounded transcript reads to the owning daemon and persist nothing, as the
session history route does. Each route gets its OpenAPI `tags`, `summary`, `description` and
`operationId`.

As implemented (PR 8):

- **`GET /orgs/:org/sessions/:id/messages?view=roots`** (`getSessionMessages`) passes `view: 'roots'`
  to the daemon and returns each row's `thread` and the page's `threads`, each footer filtered by
  §7.1 and marked `readable`. Without `view` the route is unchanged and never carries `threads`.
- **`GET /orgs/:org/sessions/:id/threads/:rootId/messages`** (`getSessionThreadMessages`) takes
  `cursor` or `after` and `limit` as the history route does, and returns the page with `summary`.
  A root the session never received, or a reply's id, answers 404; so does a purged session.
- **Feature gate.** Each read checks that the daemon about to answer advertises
  `session-thread-reads-v1` before the frame is sent. A daemon without it is skipped for the next
  holder of the store, and a read no holder can serve answers 409 `DAEMON_FEATURE_MISSING`, the
  answer the shared-image read already gives.

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
| 14  | `chore`    | Remove the page-task branch and link cards after the 90-day retention (PR 5 already replaced the threadless prompt)                                                | daemon, web      | M    | later |

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
