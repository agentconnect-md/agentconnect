# `sendMessage` Actions, Tasks, and On-Demand Tool Guide

**Status:** Revised: background sub-sessions are replaced by tasks (§2.1), started with
`startTask`, messaged with `messageTask`, and stopped by their owning session with `stopTask`
(§8.7); a self `callAgent` needs a channel and opens a session there; and replies are
addressed to a message, not to a session (§9.3–§9.6). The task half is implemented (§12
items 1–4 and the task parts of 8–9, recorded in §7.8 and §8.9); message-addressed replies
(§9.3–§9.6) are not, and the branch still implements the earlier multi-origin model (§9.8).

Keep one agent-facing `sendMessage` tool, add a required `action` discriminator,
and move detailed argument documentation into an on-demand `getToolGuide` tool. Existing
delivery argument names and semantics remain, except that background work of the agent's own
is a task (`startTask`, then `messageTask` with its `taskId`), and that `replyToSession` names
the message it answers by `messageId`. Calls without `action` are rejected before any
delivery, with instructions to read the guide and retry. This is an intentional
input-contract change, not transparent backward compatibility.

The design also includes two explicit capability extensions. Section 8: a session can
message its own tasks across rounds of work, tasks can message their owning session throughout
their lifetime, and the owning session can stop them. Section 9 adds explicit peer-session
targeting and message-addressed replies: every message one session sends another carries an
id and trusted metadata, a reply names that id, and the session's origin only records who
created it. It replaces the baseline single-effective-origin reply restriction without
changing task ownership. Both are new runtime work, separate from the behavior-preserving
action adapter audited in §7.

Baseline routing rules are defined by [`send-message-routing-rework.md`](send-message-routing-rework.md).

## 1. Problem

The original tool-payload measurement for an agent with Slack and Telegram
integrations is:

| Item                              | Characters |
| --------------------------------- | ---------- |
| `sendMessage` description         | 4363       |
| `sendMessage` input schema (JSON) | 9484       |

The binding constraint is Codex: OpenAI-hosted function tools are reported to
limit a description to 1024 characters. Codex sessions still run with the current
4363-character description, so the limit is not a hard request failure there. Whether
the description is truncated or the whole tool is silently dropped is unconfirmed;
the baseline probe in §10 settles it.

The current tool carries agent calls, origin-session replies, and platform posts behind
one top-level `oneOf`. Shortening its description alone does not remove the large
schema or the top-level union. An explicit action makes the intended operation
visible while retaining one tool name and the existing delivery arguments.

The current tool also gives one shape several meanings. A self-call without a channel
starts background work; a self-call with a channel starts visible work in that channel;
both are spelled `toAgent: <own id>`. The background form is called a sub-session, which
suggests a session hierarchy in which a conversation could hang under a piece of work.
Section 2.1 replaces that with tasks.

## 2. Goals and non-goals

Goals:

1. Keep the `sendMessage` name and existing delivery argument names and types;
   derive a new task's owner from trusted context and validate any supplied task id.
2. Require an explicit action, validated before any delivery or other effect.
3. Use a flat object schema without a top-level `oneOf` or `anyOf`.
4. Keep the tool description within 1024 characters and expose detailed usage
   through `getToolGuide`, including runnable argument examples with `action`.
5. Make old calls fail with actionable migration instructions rather than execute
   with inferred intent.
6. Use `startTask` to start a task of the current session, `messageTask` to message one it
   owns, and `replyToSession` for the task to message its owning session, across rounds of
   work (§8).
7. Let an agent call itself only into a channel, opening a session of that conversation
   that references the caller; a self-call without a channel is rejected with the exact
   `startTask` call to make instead (§3.1, §3.5).
8. Let the owning session stop its own task with `stopTask` (§8.7).
9. Allow an authorized caller to address an existing peer session, any number of times (§9.2).
10. Address every reply to the message it answers: a message from another session carries an
    id and trusted metadata naming its source, `replyToSession` takes that `messageId`, and the
    daemon decides from the message's metadata whether and where the reply may go. A message
    may be answered more than once (§9.3–§9.5).
11. Keep a session's origin as a record of who created it, from which session, and nothing
    more; it no longer authorizes or routes a reply (§9.6).

Non-goals:

- Changing the place write rule or Slack join handling. Preserve existing routing
  except the explicit task and reply extensions in §8–§9.
- Changing peer `needsReply` defaults. Section 9 scopes reply obligations to each
  message; task completion/failure reporting is extended per round in §8.
- Adding arbitrary session messaging, steering another agent's unrelated sessions,
  stopping anything other than one's own tasks, or an action that opens a free-standing
  session (§2.1).
- Renaming `toAgent` or introducing duplicate aliases for existing fields.
- Renaming patrols, approved proposals, or the console's sub-session surfaces in this
  change (§11).

### 2.1 Tasks, sessions, and conversations

Three things are kept apart:

- A **conversation** is shared by its participants: a channel thread, a DM, an exchange
  between agents. It belongs to them, not to any one agent.
- A **session** is one agent's private context. An agent in a conversation has its own
  session there; a conversation with two agents has two sessions. Sessions come from inbound
  routing or from the agent's own scheduled work, never from a free-standing "start a
  session" action.
- A **task** is a step of one session, beside its tool calls, that runs in the background in
  a context of its own. The session that started it is its **owning session**.

A task has these properties:

1. **Owned.** Only the owning session starts it, messages it, and stops it. The task's
   progress, questions, and results go back to the owning session, which speaks for it; none
   of the task's output is posted anywhere.
2. **No conversation.** A task cannot be started in a channel and has no conversation of its
   own. When work needs to talk in a channel, that is a conversation, so it gets a session:
   `callAgent` to yourself with `channel` (§3.1).
3. **No control between tasks.** Tasks of one session do not start, message, or stop one
   another, and a task cannot start tasks. The owning session orders them by dependency: it
   starts the tasks whose inputs are ready, may run independent ones at the same time, and
   receives each result before deciding what to start next. The order lives in the owning
   session's reasoning; the daemon enforces no dependency graph.
4. **Stoppable by its owner.** The owning session can stop a task whenever it decides the
   task should not continue: the plan changed, a task it depended on failed, or the result is
   no longer needed (§8.7). A person who wants a task stopped asks the owning session.
5. **Retained.** A task outlives one round of work; a later `messageTask` gives it new work in
   its retained context (§8.4).

A session reached by a call is not a task. It belongs to its conversation; the call is a
message into it whose metadata names the calling session, so the session can answer that
message (§9.3), and if the call created the session, its origin records the caller (§9.6).
Neither is ownership: the conversation can continue after the caller's topic, on other topics.

| Aspect               | Task                                       | Session reached by `callAgent`                         |
| -------------------- | ------------------------------------------ | ------------------------------------------------------ |
| Belongs to           | Its owning session                         | Its conversation                                       |
| Conversation         | None                                       | The channel or the peer conversation                   |
| Caller's relation    | Owner                                      | Sender of messages it may answer; creator if it was    |
| Started by           | `startTask` from the owning session        | Inbound routing, or a `callAgent` that reaches it      |
| Further input        | `messageTask` from the owning session only | The conversation, or `callAgent` with `sessionId` (§9) |
| Reporting            | Automatic, each round, to the owner        | Only what a call requests with `needsReply`            |
| Stopping             | `stopTask` from the owning session         | That conversation's own stop rules                     |
| Visible to people as | The owning session's account of it         | The conversation itself                                |

Why not a sub-session tree: hanging a conversation under a piece of work forces the
conversation to end with the work or lets unrelated talk leak into it; a child that answers
only to its parent cannot be joined by anyone else; and every level of nesting needs its own
stop and lifetime conventions. A task is a step and has none of these.

Assistant mode's patrols (assistant-mode.md §5.9) and approved proposals (§5.10) also run in
the background, but no session starts them as one of its steps: a patrol is the agent's own
check of an item, and an approved proposal starts on its approval. They keep their one-report
lifecycle, are not started with `startTask` or continued with `messageTask`, and are not
stopped with `stopTask`.

## 3. Design

### 3.1 Actions

| `action`         | Purpose                                                                    | Required target       | Optional arguments                                                                    |
| ---------------- | -------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------- |
| `callAgent`      | Call a peer, optionally in an existing session, or yourself into a channel | `toAgent`             | `channel` or `sessionId` (mutually exclusive); a self target requires `channel`       |
| `startTask`      | Start a background task of your current session                            | None                  | None                                                                                  |
| `messageTask`    | Send more work or an answer to a task your current session started         | `taskId`              | None                                                                                  |
| `replyToSession` | Answer a message another session sent you                                  | `messageId`           | None                                                                                  |
| `postMessage`    | Post to a person, channel, or another existing thread                      | `toUser` or `channel` | `thread`, `attachment`, `platform`, `integrationId`, subject to existing branch rules |

Every action also requires `message`. `callAgent` does not promise a fresh session:
existing routing may reuse the target's conversational context. Without `channel`,
`callAgent` accepts only a peer and is postless. With `channel`, a peer or self target
uses the existing platform-dependent post-and-wake behavior. A peer call with an
explicit `sessionId` instead targets that existing peer session without a new root
post; `channel` and `sessionId` are mutually exclusive. It must resolve to the
agent named by `toAgent`, pass existing agent-call policy and the session-admission
rule in §9.2, and must not create a replacement if lookup/admission fails. One session may
call another, or the same existing session, any number of times; each call is a new message
(§9.3).

**Calling yourself.** `callAgent` with your own agent id requires `channel`. It posts the
message at that channel's root and starts your work there, in the session of that new
conversation, where people can follow and answer. For example, an agent may post an
investigation into another project's channel and work on it as itself in that thread. The
call reaches the new session as a message from the calling session, so the new session can
report back with `replyToSession` on that message's id, and its origin records the calling
session as its creator (§9.6). The calling session does not own it, cannot message it with
`messageTask`, and cannot stop it with `stopTask`. Any later input reaches it through its
conversation.

A self `callAgent` without `channel` is rejected before effects. The error gives the exact
`startTask` call to make instead and the `startTask` guide's rules (§3.5): work of your own
that needs no conversation is a task. A self `callAgent` with `sessionId` is rejected as today.
Do not silently reinterpret either or keep a second spelling for starting a task. A plain
`postMessage` can seed idle context but does not explicitly activate a model turn. Preserve
these three distinctions, task, visible self-call, and post; the `callAgent` guide includes a
visible self-call example, and the description steers work without a channel to `startTask`.

`startTask` requires `action` and `message` and accepts nothing else. It starts a new task of
the current session, owned by it through trusted caller identity, and returns the task's
`taskId`. `messageTask` requires `action`, `message`, and a nonempty `taskId`: it sends into an
existing task, and the daemon must verify that the current session is its owning session. A
missing, invalid, unrelated, or unavailable task never falls back to starting one; a
`messageTask` without `taskId` is an argument error that points to `startTask`.

Neither task action accepts `toAgent`, `channel`, `thread`, `platform`, `integrationId`,
`attachment`, `sessionId`, `messageId`, or `needsReply`. A task reports completion or failure
automatically; a task cannot start tasks, and active per-agent concurrency limits still apply.
Every input the owning session sends a task is a message whose metadata names the owning
session as its source, so the task answers it with `replyToSession` for progress, questions,
and results. Message delivery alone must not mark the task's work complete; §8 specifies that
lifecycle.

`replyToSession` takes a required `messageId`: the id of a message another session sent the
current session. The daemon reads that message's recorded metadata to decide whether the reply
is allowed and where it goes, its source session (§9.4). It does not accept a session id, and
it does not consult the session's origin. Replies are point-to-point, not an automatic
broadcast: when C calls an existing B session, B can still answer A's earlier message by its id.
A message may be answered more than once, for example a progress note and then a result; each
reply is itself a message to the source, which can answer it in turn. Existing reciprocal reply
paths are thereby retained without granting arbitrary session access. The old single effective
origin remains part of the audited baseline (§7), not the authorization rule of this proposal.

For a task, every message from the owning session names the owning session as its source, so
the task's replies go there whichever of those messages it answers. Starting, messaging, and
recovery must keep that metadata consistent. A message must not move the task to another
session. The owning session's authority over the task belongs to `messageTask` and `stopTask`
and is checked against the persistent ownership record (§8).

`callAgent` accepts no `platform` or `integrationId`: its platform and caller
identity come from trusted context. `postMessage` supports those selectors. Its
handler does not call the explicit agent-wake path, but existing platform ingress
routing remains intact; an existing-thread update can reach agents already in that
thread. Posts can seed or reuse the author's idle context, including for updates,
and do not invariably create a fresh conversation.

Except for the explicitly added `callAgent.sessionId` form (§9), existing combinations remain
strict: for example, `thread` belongs only to a bare-channel post, a `toUser` array requires
`channel`, and `attachment` is not accepted for an agent call. `action` selects the operation;
it does not relax its argument rules or grant authority.

### 3.2 Description and flat schema

Draft description:

```text
Send outside your current conversation. Required action: callAgent asks a peer to work
(sessionId continues an existing peer session); calling yourself needs channel and starts
visible work in that channel. startTask starts a background task of this session for long
work you do yourself; messageTask sends a task you started more (taskId). A task reports each
round's outcome automatically, and stopTask stops it. replyToSession answers a message another
session sent you, by its messageId, as often as needed; replies are not broadcast. postMessage
reaches a person, channel, or another existing thread and starts no work. For your current
conversation, write your ordinary reply. To get a peer's result, use toAgent: {agentId: "...",
needsReply: true}. Call getToolGuide {"tool":"sendMessage"} for arguments and examples. Calls
without action fail without sending anything.
```

The shipped wording may differ where the runtime matrix (§10) shows a model needs it, for
example to start a task before exploring long work itself; it stays within 1024 characters.

The input schema is a single object, with `action` and `message` required. `taskId` is
required for `messageTask`, `messageId` for `replyToSession`, and `sessionId` is optional for
`callAgent`:

| Field           | Type                                                                           | Meaning                                                           |
| --------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Field           | Type                                                                           | Meaning                                                           |
| --------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `action`        | enum: `callAgent`, `startTask`, `messageTask`, `replyToSession`, `postMessage` | Operation to perform; required                                    |
| `message`       | string                                                                         | Message body in Markdown; required                                |
| `toAgent`       | string or `{agentId, needsReply}`                                              | AgentConnect agent to call; `callAgent` only                      |
| `toUser`        | string or string array                                                         | Human platform member id(s)                                       |
| `channel`       | string                                                                         | Destination channel or chat                                       |
| `thread`        | string                                                                         | Existing thread root, for a bare-channel `postMessage` only       |
| `sessionId`     | string                                                                         | Existing peer session, for `callAgent` only                       |
| `taskId`        | string                                                                         | A task of the current session, for `messageTask` only             |
| `messageId`     | string                                                                         | The message being answered, for `replyToSession` only             |
| `attachment`    | string                                                                         | Received image name from an `[attached: …]` marker                |
| `platform`      | enum of the agent's platforms                                                  | Target platform                                                   |
| `integrationId` | string                                                                         | Bot selection when multiple integrations apply                    |

Preserve existing accepted field types for existing forms. `taskId` and `messageId` must be
nonempty strings; a null or empty value is an argument error, never an instruction to start a
task or to reply elsewhere. Apply the same no-fallback rule to an explicitly supplied
peer-session id. A task handle, a peer-session id, and a message id are three different
things; separate fields keep them from being swapped. Retain compatibility string
values for nested `toAgent.needsReply`. Do not add a top-level `needsReply` alias. The
remaining field-level unions are not top-level operation unions.

The complete proposal has five actions. Keep them and the `sessionId`, `taskId`, and
`messageId` fields discoverable rather than hiding replies based on a stale snapshot of the
turn.
Today's `toolsForIntegrations` descriptor is built from integrations, not fresh
per-turn authority. `getToolGuide` may tailor availability notes from trusted
current context; runtime authorization remains authoritative. Publish each new capability only when its runtime contract is implemented: `startTask`,
`messageTask`, and `stopTask` (§8), and explicit peer targeting with message-addressed replies
(§9). Do not advertise a target field that the daemon will silently ignore.

Keep messaging and its guide available without IM integrations: postless agent
calls, tasks, and replies to messages need no platform posting connection. A self
`callAgent` needs a channel and so a posting connection. Retain existing runtime-specific and
read-only patrol tool gates. Any later conditional injection needs proof that resumed
sessions and changing turn origins cannot lose a valid operation.

### 3.3 Validation and dispatch

Validate the action and its argument combination before platform sends, agent
wakes, session replies, approvals, joins, or session initialization:

1. Reject a missing, unknown, or incorrectly typed `action`.
2. Select the action's validator and reject conflicting or unexpected fields.
3. Validate existing target constraints and authorization.
4. Delegate to the existing messaging implementation with the validated payload.

Place action/shape validation before `resolveChannelArg` in the tool execution
pipeline; that helper can consult a gateway before the current handler runs. The
missing-action recovery path must perform no target lookup or delivery. Keep
existing stopped-turn and read-only patrol restrictions ahead of execution.

Never infer a missing action, silently choose another action based on the target,
or discard conflicting target fields. The action is a checked contract, not an
annotation. An adapter may remove the already-validated `action` before passing
arguments to the existing strict branch parser; it must preserve all other
validation and the existing write/join wrappers. For `startTask`, construct the internal
self-delegation from trusted caller identity and `message`. For `messageTask`, validate
ownership and admit into that existing task instead of invoking the old origin-reply branch.
For `replyToSession`, resolve `messageId` against the current session's received messages
(§9.4) before any delivery. Normalize and select the correct handler before
downstream routing and write/join classification.

Preserve the actual `isPlatformPost` predicate: it excludes both `toAgent` and
`sessionId`, even when an agent call contains `channel`. Thus `postMessage` keeps
the place-write/draft rule and join wrapper; `callAgent` with `channel` keeps its
existing reach check and agent policy, without being newly routed through the
ordinary-post draft/join path. `startTask`, `messageTask`, and `replyToSession` are
session-only paths, even though their public arguments omit `toAgent`.
Do not delegate them blindly to the old target inference or platform-post classifier.
Likewise, `callAgent` with `sessionId` is an explicit peer call, not the old
`sessionId` origin-reply branch, which no longer exists. Action dispatch must precede legacy target inference.

The daemon validates `action` even when a caller bypasses the advertised schema.
A harness may reject a missing required property before reaching the daemon; its
error wording is outside the daemon's control. The advertised description and
`getToolGuide` discovery must therefore also explain the new contract.

### 3.4 `getToolGuide`

```text
getToolGuide { tool: "sendMessage", action?: "callAgent" | "startTask" | "messageTask" | "replyToSession" | "postMessage" }
```

Without `action`, return the available operations, their required arguments, and
one minimal example each, sufficient to make a common call without a second guide
lookup. With `action`, return that operation's complete argument rules, examples,
and relevant platform/session restrictions. Every example includes `action`.

The agent-call guide covers postless peers, existing peer sessions, repeated calls, and visible
self-calls into a channel, and says that a self-call without a channel is a task. The
`startTask` guide covers starting tasks, ordering them (start independent tasks together; start
a task that needs another's result once that result arrives), automatic reporting, the
no-nesting rule, and concurrency limits; the `messageTask` guide covers messaging a task and
`stopTask`. The reply guide covers finding a message's id in the input, replying more than
once, and why a reply needs no session id. The posting guide covers
DMs, human mentions, channel roots, thread updates, and image forwarding. Keep platform
capabilities and session availability consistent with the descriptor and authoritative
runtime rules.

Example delegation:

```json
{
  "action": "callAgent",
  "toAgent": { "agentId": "<agent-id>", "needsReply": true },
  "message": "Review this change and report your findings."
}
```

Example visible work by the same agent in a channel (a session of that conversation, not a task):

```json
{
  "action": "callAgent",
  "toAgent": "<own-agent-id>",
  "channel": "<project-channel-id>",
  "message": "Investigate this project's failing build here and discuss the findings in this conversation."
}
```

Example starting a task:

```json
{
  "action": "startTask",
  "message": "Investigate the flaky test in the background and report your findings."
}
```

Example additional instructions to a task, running or previously completed:

```json
{
  "action": "messageTask",
  "taskId": "<taskId returned by startTask>",
  "message": "Continue with the Windows failure and keep your earlier findings."
}
```

Example task progress update or question, answering the owning session's instruction:

```json
{
  "action": "replyToSession",
  "messageId": "<id of the instruction message>",
  "message": "The failure is isolated. Should the repair preserve the old configuration format?"
}
```

Example result for a peer's request:

```json
{
  "action": "replyToSession",
  "messageId": "<id of the request message>",
  "message": "Review complete: two issues found."
}
```

Example platform post:

```json
{
  "action": "postMessage",
  "channel": "<channel-id>",
  "message": "The review is complete."
}
```

Delegation examples request feedback explicitly. The guide also explains that a
bare agent id requests no feedback obligation on that call; it does not prohibit an
authorized explicit reply or clear a previously persisted reporting obligation.
Tasks retain automatic outcome reporting, with the round-aware changes in §8. The baseline
`needsReply` inference already exists: a clean delegated turn with an outstanding obligation
can have its ordinary final output forwarded, or an explicit no-result notice sent;
an already reported/failed obligation and live background work suppress inference.
This mechanism exists today and is not a future benefit of either proposal.

Every message from another session reaches the model with its id and source, and turn-scoped
instructions give the exact `replyToSession` call for it (§9.5). For a task the source is its
owning session, consistently across starting, messaging, and recovery. Peer-session guidance
lists the messages the session may still answer rather than claiming that the latest caller is
the only one. Optional guide reading cannot replace these instructions.

The guide distinguishes handles: `taskId` in the start receipt names the task and is what
`messageTask`, `viewSessionStatus`, and `stopTask` accept; `sessionId` names an existing peer
session for `callAgent`; `messageId` names a received message for `replyToSession`. Do not teach
agents to reconstruct ids or copy one kind into another's field. Sending a task reply is messaging, not a signal to close its work round
(§8).

Use a tool rather than an MCP resource so the guide is accessible through the
same tool channel as messaging. `tool` is an enum of documented tools; initially
only `sendMessage`. The name `getToolGuide` identifies a read operation returning
usage instructions, examples, and rules, rather than only a machine-readable schema.
Other tools can use the same guide entry point later.

### 3.5 Errors direct the agent to the tool guide

A missing action produces a tool argument failure, surfaced through the existing
MCP `isError` path, rather than a successful result with a migration notice:

```text
sendMessage: missing required argument `action`. Nothing was sent and no agent was woken.
Use an action listed by getToolGuide for this daemon. The complete tool supports callAgent,
startTask, messageTask, replyToSession, and postMessage.
Call getToolGuide {"tool":"sendMessage"} to get the arguments and examples, then retry
sendMessage with the appropriate action.
```

Invalid actions also direct the caller to the overview. For a recognized action
with invalid arguments, identify the conflicting or missing fields and point to
its guide, for example:

```text
sendMessage: action `replyToSession` requires `messageId` and does not accept `sessionId`.
Nothing was sent. Reply with the id of the message you are answering, shown with that message.
Call getToolGuide {"tool":"sendMessage","action":"replyToSession"} for the required arguments,
then retry with a valid action and target.
```

A self `callAgent` without `channel` returns the call to make and the `startTask` guide itself,
so the agent can retry without a lookup:

```text
sendMessage: action `callAgent` with your own agent id needs `channel`. Work of your own that
needs no conversation is a background task. Nothing was sent. Retry as:
  sendMessage {"action":"startTask","message":"<the same message>"}
startTask guide:
<the rules and example getToolGuide {"tool":"sendMessage","action":"startTask"} returns>
To work visibly in a channel instead, keep callAgent and add `channel`.
```

The error never echoes the supplied message body; the placeholder tells the agent to resend
its own text. A `messageTask` without `taskId` likewise names the `startTask` call. A reply
whose `messageId` is unknown, belongs to another session, or may not be answered is a runtime
refusal with one wording (§9.4), not an argument error.

Extend the existing self-correcting argument-error path from #2084. Errors include
argument names, not message bodies or other supplied values. Do not guess which
action the model meant when arguments conflict. Reading the guide is the instructed
recovery path, not a server-enforced prerequisite for later valid calls.

The no-effect statement applies only to argument rejection before execution.
Preserve existing partial-delivery and uncertain-delivery results after execution
begins; never encourage an unconditional retry of a message that may have landed.
Existing delivery receipts keep their shapes and semantics, except that a task receipt
names its handle `taskId` (§8.6) and a reply receipt names the message it answered (§9.4). In particular, an agent-call result can be
`{ok: true, wake: {delivered: false, ...}}`; `ok` alone is not proof of delivery. Replies
return `{delivered, targetSession?, inReplyTo?, reason?}` directly, without an `ok` wrapper.
Preserve draft receipts and partial/uncertain post outcomes. See the baseline comparison in
§7 and task receipts in §8.

## 4. Migration

| Existing usage                                              | New behavior                                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Peer calls or self-calls with `channel`                     | Rejected without effects; read guide and add `action: "callAgent"`                 |
| Self-call without `channel`                                 | Rejected without effects; the error gives the `startTask` call to make             |
| `sendMessage {sessionId, ...}`                              | Rejected without effects; use `action: "replyToSession"` with the `messageId`      |
| `sendMessage {toUser, ...}` or `{channel, ...}`             | Rejected without effects; read guide and add `action: "postMessage"`               |
| `stopSubsession {sessionId}`                                | Replaced by `stopTask {taskId}` with the owning-session authority in §8.7          |
| `childSessionId` in a self-delegation receipt               | Named `taskId`; the same handle value                                              |
| `Parent session` reply address in standing context          | Replaced by message ids on each input; the origin is shown as the creator only     |
| Agent descriptions, knowledge, and skills with old examples | Need updates; old model-generated calls receive migration guidance                 |
| Standing context and built-in examples                      | Updated in the same release, including message-addressed and task reporting        |
| Scripted callers and evaluation harnesses                   | Updated before rollout; they cannot be assumed to read an error and self-correct   |
| Warm sessions with cached tool schemas                      | Require runtime-specific verification of guide discovery and schema refresh/reload |

There is no silent legacy execution path or optional-action transition period.
Release notes must describe the required-field change for self-hosted deployments.
Retaining argument names makes migration smaller but does not make old calls valid.
Task examples must also remove the explicit `toAgent` and any feedback flag, since
`startTask` derives the owner and reports automatically. A session that was mid-exchange at the
upgrade has no message ids for inputs received before it; §9.6 migrates its origin into one
message record.

## 5. Size budget and validation

| Item                                | Target                                                       |
| ----------------------------------- | ------------------------------------------------------------ |
| `sendMessage` description           | ≤ 1024 characters                                            |
| `sendMessage` schema                | Measure a flat-schema prototype, including required `action` |
| `getToolGuide` description + schema | ≤ 600 characters                                             |
| Top-level `oneOf` / `anyOf`         | None                                                         |

The earlier approximately 2.2k combined estimate omitted the guide tool's payload.
Measure the full descriptor set rather than claim that number for this revision.
Guide responses enter conversation context too; total token cost and latency must
include guide calls, recovery attempts, and later turns, not just initial schemas.

Acceptance checks:

- Missing, unknown, or mistyped actions fail with guide instructions and zero
  platform writes, wakes, session injections, approval requests, or joins.
- Conflicting action/target fields fail before effects; existing forbidden field
  combinations remain forbidden.
- `startTask` derives the owner and rejects extra target fields; `messageTask` requires
  `taskId` and verifies the current session is the recorded owner. Both preserve automatic
  completion/failure reports and enforce the no-nesting and concurrency limits. A self
  `callAgent` without `channel`, and a `messageTask` without `taskId`, fail with the exact
  `startTask` call.
- A self `callAgent` with `channel` opens a session of that conversation whose input is a
  message from the caller and whose origin records the caller as creator; the caller cannot
  message or stop it as a task.
- `stopTask` stops only a task the calling session owns, on any of its turns (§8.7).
- Replies are authorized and routed only by the answered message's metadata (§9.4); they
  preserve local/remote routing, hop limits, and receipts, never broadcast, and never consult
  the session's origin. Repeated calls and repeated replies are each delivered. For tasks,
  verify that every owner message names the owning session and separate message delivery from
  work completion (§8).
- Every supported delivery form works with its explicit action and preserves the
  current authorization, routing, return receipt, and partial-delivery behavior,
  except the explicitly listed lifecycle and reply extensions in §8–§9.
- Guide examples satisfy their action validators; overview examples cover common
  operations without requiring a second lookup.
- Descriptors, guides, standing context, and resumed sessions expose consistent
  operations and include the guide wherever messaging is offered.
- Supported harnesses can discover `getToolGuide` and recover from legacy calls; record
  limitations when their local schema validation intercepts a call first.
- Model evaluations measure first-attempt success, final delivery and owner
  reporting, wrong destinations, guide/retry calls, total tokens, and latency.

## 6. Trade-offs

| Aspect           | Consequence                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| Intent           | Required `action` identifies the operation within one tool                                                     |
| Migration        | Tool name remains; every call adds `action`, and tasks omit the explicit agent target                          |
| Schema           | One flat schema; action-specific combinations require runtime validation                                       |
| Documentation    | Short common description plus on-demand guides, with lookup or error-recovery cost for unfamiliar calls        |
| Model            | Task and session are distinct: ownership never spans a conversation, and a conversation never hangs under work |
| Replies          | The model copies a message id instead of a session id; the daemon checks one record instead of session state   |
| Runtime behavior | Baseline audited; §8 adds task continuity and owner stop, §9 adds peer sessions and message-addressed replies  |

Explicit operation selection does not remove every conditional: `channel` still
changes agent-call delivery, and the shared schema exposes several operations'
fields. Interface changes alone do not guarantee correct feedback delivery;
validate behavior and model outcomes against §5 and the implementation contracts.

Addressing replies to messages makes every received message a durable record on the
receiving daemon, and its id must appear wherever the model needs it. In return the reply
rule is local and checkable: a reply goes to the session that sent the message, or nowhere,
whatever has happened to the session's origin or its other callers since.

Letting the owning session stop a task on any turn trades the `!stop` sender gate for
planning freedom: a person who may not `!stop` in the place, or a peer's reply, can now lead the
agent to stop a task. A stop undoes nothing and a later `messageTask` can give the task new
work, so the cost of a wrong stop is bounded (§8.7).

## 7. Implementation parity audit

Audited against source at commit `69dd916ee09ba7a569d83afe9ccef3b57e51ccd7`.
The “current” column describes that baseline, in which a task is still a background
sub-session; the “after” column describes the behavior-preserving adapter stage in task
terms. Sections 8 and 9 separately identify intentional additions to task lifecycle, peer-session
targeting, and reply authorization; those explicit changes supersede the relevant baseline
rows when implemented. Executable code and tests take precedence over older design prose and
tool descriptions when they disagree.

### 7.1 Source map

| Ref | Source and relevant symbols                                                                                                                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M   | [Messaging handler](../../packages/daemon/src/mcp/ops/messaging.ts): `SEND_MESSAGE_BRANCHES`, `parseAgentTarget`, `sendMessage`, `settlePost`                                                                                                              |
| C   | [Collaboration coordinator](../../packages/daemon/src/collab/coordinator.ts): `localWakeDecision`, `messageAgent`, `deliverReply`, `reportFromSubsession`, `maybeInferParentReply`, `failAgentDispatch`, `settleSubsessionTurn`                            |
| O   | [Tool execution](../../packages/daemon/src/mcp/ops.ts), [place gate](../../packages/daemon/src/mcp/ops/place-gate.ts), [channel names](../../packages/daemon/src/mcp/ops/channel-names.ts), [join handling](../../packages/daemon/src/mcp/ops/join-ask.ts) |
| G   | [Gateway selection](../../packages/daemon/src/mcp/ops/gateway.ts), [read ports](../../packages/daemon/src/platforms/read-ports.ts), [thread keys](../../packages/daemon/src/platforms/thread-keys.ts)                                                      |
| S   | [Session manager](../../packages/daemon/src/session/session-manager.ts), [standing context](../../packages/daemon/src/session/turn/standing-context.ts), [sub-session tools](../../packages/daemon/src/mcp/ops/assistant-subsessions.ts)                   |
| T   | [Tool descriptors](../../packages/daemon/src/mcp/tools.ts), [argument primitives](../../packages/daemon/src/mcp/ops/args.ts), [argument errors](../../packages/daemon/src/mcp/ops/argument-error.ts)                                                       |

### 7.2 Delivery forms: before and after

All examples below also carry `message`. Apart from the explicit input migrations
in §7.7, the same target, authority, delivery, bookkeeping, and receipt must result.

| Existing form / capability                   | Current implementation                                                                                               | Required after refactor                                                                              | Ref     |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------- |
| `toAgent: peer`, no channel                  | Postless, headless peer wake; current routing can reuse target context                                               | `callAgent` with the same target; no new-session guarantee                                           | M, C    |
| Object `toAgent` with `needsReply`           | Requests reporting; trusted metadata carries the obligation                                                          | Same nested field and normalization under `callAgent`                                                | M, C, S |
| `toAgent: self`, no channel                  | Fresh `subsession:<deliveryId>` coordinate, inherited parent context, no visible post                                | `startTask` constructs the same trusted self-delegation                                              | C       |
| `toAgent: peer` plus `channel`               | Attempts one channel-root post before wake, rendering a native mention when available                                | `callAgent` plus `channel`; retain target preflight and actual gateway behavior                      | M, C    |
| `toAgent: self` plus `channel`               | Visible self-activation; requires a real provider post id and paired delivery evidence                               | Same `callAgent` form; a session of that conversation created by the caller, not a task              | M, C    |
| Agent call plus `platform` / `integrationId` | Rejected by the strict agent branch                                                                                  | Still rejected; these are not supported agent-call selectors                                         | M, T    |
| `toUser: string`, no channel                 | Opens one DM; body is not prefixed with a mention                                                                    | `postMessage` with same `toUser`                                                                     | M, G    |
| `toUser: string` or array plus `channel`     | One root post with all human mentions; not multiple sends or a group DM                                              | Same under `postMessage`                                                                             | M       |
| Bare `channel`                               | Posts at the root, records outbound content, seeds/reuses author context when a real anchor is available             | Same under `postMessage`; no explicit `messageAgent` call                                            | M, G    |
| Bare `channel` plus `thread`                 | Posts into an existing supported thread, stamps final response/hop metadata, seeds/reuses the author's context there | Same under `postMessage`; preserve ingress delivery to existing participants                         | M, G    |
| `attachment` with user/channel branch        | Forwards retained received image bytes with message as caption, including supported thread updates                   | Same under `postMessage`; not a produced-file upload                                                 | M       |
| `sessionId`                                  | Replies only into the authorized active or durable origin                                                            | `replyToSession`; §9.4 replaces the outward id with the answered message's `messageId`               | M, C    |
| Reciprocal session reply                     | Reply metadata names the replier as origin, allowing the receiving turn to reply back                                | Preserve as a reply to the reply's own message id (§9.3); no arbitrary task messaging                | C       |
| No IM integration                            | Postless collaboration and replies to received messages still work without a posting gateway                         | Keep `sendMessage` and `getToolGuide` discoverable; tasks remain available subject to existing gates | T, C    |

Do not inherit the old proposal's claim that non-Slack channel-agent calls simply
fall back to postless delivery. The handler attempts the gateway post when a
channel is supplied and preflight allows it; `mcp-ops.test.ts` includes a Telegram
post-and-wake anchor case. Platform-specific pairing and routing restrictions stay
where the runtime enforces them, without adding a new fallback in the adapter.

### 7.3 Arguments and target resolution

| Behavior                          | Before                                                                                                                   | Required after                                                                                              | Ref  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ---- |
| Strict branch keys                | Reject mixed targets, unknown keys, caller identity overrides, and removed fields such as `correlationId`                | Same strict target payload after validating/removing `action`; no silently ignored fields                   | M    |
| Agent target encoding             | Bare id, structured object, and a JSON-stringified structured object are accepted                                        | Preserve all three, while guides recommend a real object                                                    | M    |
| `needsReply` values               | Boolean or case-insensitive `"true"`/`"false"`; absent/null means no new request                                         | Preserve accepted values; no top-level alias, default change, or clearing of sticky session obligations     | M, S |
| String parsing                    | Required strings are nonempty; optional strings are nullish, and optional empty strings are not globally normalized away | Reuse existing parsers for retained fields; do not silently tighten or reinterpret them during flattening   | M, T |
| User target validation            | Nonempty strings/arrays; aliases such as `U1` and `<@U1>` count as duplicates; arrays require channel                    | Preserve validation and mention rendering                                                                   | M    |
| `thread` / `attachment` placement | `thread` only on bare channel; attachments only on user/channel branches                                                 | Preserve, including rejection on agent/session/task actions                                                 | M    |
| Channel names                     | `resolveChannelArg` resolves a name on the selected bot when unambiguous                                                 | Preserve after action validation; ids and unresolved names retain existing behavior                         | O    |
| Posting platform default          | Explicit `platform` wins; otherwise current platform, except DM uses `directMessagePlatformFor`                          | Preserve capability-driven default; do not hardcode Slack or apply it to channel-user posts                 | M, G |
| Posting bot default               | Explicit integration, else current session's integration on that platform, else first candidate                          | Preserve existing selection; `sendMessage` does not opt into the resolver's optional bot-selection question | G, M |
| Missing connection                | Unknown platform/integration or no live gateway refuses; no implicit alternative bot                                     | Preserve errors and target selection                                                                        | G    |
| DM support                        | Both DM and channel-user forms require the DM capability; opening a DM also probes the selected live gateway             | Preserve both checks                                                                                        | M, G |
| Existing-thread support           | Current update registry permits Slack; own-thread comparison and readable-root verification run before posting           | Preserve current checks and refusal; never silently post at root instead                                    | M, G |

### 7.4 Authority, sessions, and feedback

| Behavior                         | Before                                                                                                                                                | Required after                                                                                                     | Ref  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---- |
| Ordinary posting authority       | `isPlatformPost` excludes `toAgent` and `sessionId`; ordinary posts get place-write/draft and join handling                                           | `postMessage` retains these wrappers; public omission of `toAgent` on task actions must not opt them in            | O    |
| Visible agent-call authority     | Even with channel, A2A bypasses ordinary-post draft/join wrappers and retains reach checking                                                          | Keep that distinction; a visible side effect alone does not select ordinary-post policy                            | O, M |
| Peer policy and coordinates      | Directional call policy, org snapshot, coordinate integrity, caller/target policy, and hop limits are checked                                         | Same checks for local and remote delivery; no model-supplied caller identity                                       | C    |
| Preflight and post/wake ordering | Locally decidable refusal suppresses the post; remote refusal can still follow an already-visible post                                                | Preserve ordering and partial outcome; do not present send+wake as atomic                                          | M, C |
| Paired activation                | Provider id and trusted metadata pair the root post with the wake; existing rendezvous avoids duplicate activation                                    | Preserve pairing, transcript deduplication, hop and transport scope                                                | M, C |
| Task admission                   | Requires a parent session, forbids nesting, and atomically enforces per-agent concurrency limits                                                      | Same refusal reasons and bookkeeping; caps do not newly apply to peers or visible self-wakes                       | C    |
| Origin authorization             | Active-turn origin overrides persisted origin; durable fallback supports later local follow-up turns                                                  | Superseded by §9.4: the answered message's metadata decides; the origin records creation only (§9.6)               | C, S |
| Reply addressing                 | Reply input uses outward session id; wake `childSessionId` currently contains `wake.targetSession`, a session key                                     | Preserve both formats; the receipt names the task handle `taskId` and documents the distinction                    | M, C |
| Reciprocal replies               | `deliverReply` stamps the stored replier session's outward id into the recipient turn's origin metadata                                               | Preserved as metadata on the delivered reply, which the recipient answers by its message id (§9.3)                 | C    |
| Reply lifecycle                  | No blanket refusal based on target session being done; `reportFromSubsession` rejects a caller whose index is `failed` or `reporting`                 | Preserve the actual caller-side guard; do not invent terminal-target rejection or reopening semantics              | C    |
| Local reply                      | Resolve outward id, inject without a platform post, and resume with the target's ordinary reply route                                                 | Preserve transport scope, code-host reply snapshots, and serial-gate admission; acceptance is not model completion | C    |
| Remote reply                     | Needs active inbound coordinates; uses `lineageReplyTo` and `deliveryKind: session-reply`, with existing remote admission/version fences              | Preserve; a durable id alone does not supply missing remote routing coordinates                                    | C    |
| Feedback opt-in                  | `needsReply` sets standing/turn-scoped guidance; existing persisted obligation can remain sticky                                                      | Preserve; a new bare-id call does not prohibit explicit reports or necessarily clear previous obligations          | C, S |
| Inferred successful report       | Outstanding `needsReply` wake can forward final prose; empty/no-response output becomes an explicit no-result report                                  | Preserve existing inference and duplicate suppression; do not label it an unimplemented future feature             | C    |
| Inference exclusions             | No inference for plain no-reply calls, unrelated follow-up turns, suppressed output, resolved obligations, or outstanding background work             | Preserve exact guards; do not promise every final output is forwarded                                              | C    |
| Failure reporting                | Requested peer dispatch failure can wake the parent; sub-session settlement/sweep reports unreported endings with existing admission/retry safeguards | Preserve existing handling and limits for tasks; do not promise infallible delivery                                | C    |
| Companion tools                  | `viewSessionStatus` reads authorized delegated work; `stopSubsession` has separate main-conversation, human-authority, and lifecycle gates            | `viewSessionStatus` accepts `taskId`; `stopSubsession` becomes `stopTask` with the authority in §8.7               | C, S |

The reciprocal reply row follows the actual metadata and authorization path. The
baseline tests verify origin delivery, durable fallback, and precedence, but the
full owning session → task → owning session → task exchange should receive an
explicit regression case when implementing the refactor. The existence of that
path is not a guarantee that every target state or admission gate accepts it.

### 7.5 Posting effects and results

| Behavior                | Before                                                                                                                        | Required after                                                                                                                 | Ref  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---- |
| Draft approval          | Eligible ordinary posts can return an intercepted draft receipt before sending; attachment drafts are refused                 | Preserve receipt and no-resend guidance; do not wrap as a completed post                                                       | M, O |
| Image provenance        | Resolve only retained bytes received by this conversation; no model-supplied path/bytes or arbitrary file forwarding          | Preserve resolution, supported retained formats, and no-caption-only fallback on failure                                       | M    |
| Image delivery failure  | Indeterminate upload says it may have landed and forbids retry; partial caption failure can be a success receipt with warning | Preserve uncertainty and notices; never convert all errors into “nothing sent”                                                 | M    |
| Thread identity         | Platform-specific roots/DMs use canonical thread keys; Discord guild roots require native thread creation                     | Preserve root/update differences and continuous DM behavior                                                                    | M, G |
| Native-thread failure   | Root may already be visible when thread creation fails; outbound is recorded and no seed follows                              | Preserve partial-failure error; do not retry automatically                                                                     | M    |
| Missing provider id     | Synthetic local id can record/display a post, but does not seed a session or prove a paired self-wake                         | Preserve; do not claim a session was started merely because `post.ts` exists                                                   | M, C |
| Session seeding         | Real anchors can seed/reuse author context without running a model turn; seed acceptance is not completion                    | Preserve no duplicate activation, including existing-thread updates                                                            | M    |
| Identity and transcript | Trusted agent identity, recorded body, platform id, integration, and canonical thread drive audit/display                     | Preserve; action stays tool metadata, not a new message-body prefix                                                            | M    |
| Wrong-root notice       | A root post into the parent/own conversation can warn that it did not answer the intended context                             | Keep notice, but rewrite suggested calls as `replyToSession` with the answered message's `messageId`                           | M    |
| Agent/post receipt      | `{ok: true, wake?, post?, childSessionId?, reply?, nextAction?, message?, notice?}`                                           | Preserve fields, omission conditions, and `wake.delivered`/reason; a task receipt carries `taskId` instead of `childSessionId` | M    |
| Session reply receipt   | `{delivered, targetSession?, reason?}` returned directly                                                                      | Preserve exact shape and reason values, including `not_authorized`, admission refusal, and the ended reason                    | M, C |
| Waiting guidance        | Admitted feedback-requesting calls/sub-sessions include `reply` and `nextAction: finish-turn-and-wait`                        | Preserve for calls and tasks; no synchronous result or guaranteed immediate steering                                           | M    |

### 7.6 Baseline verification and refactor acceptance

The following existing suites passed during this source audit: **10 files,
586 tests**. They established the baseline before the action adapter existed; the
adapter's own cases were then ported onto them (§7.8).

```bash
pnpm --filter @agentconnect.md/daemon exec vitest run \
  test/mcp-ops.test.ts \
  test/mcp-tool-args.test.ts \
  test/mcp-tool-argument-errors.test.ts \
  test/mcp-tools-self-delegation.test.ts \
  test/mcp-write-rule.test.ts \
  test/mcp-join-ask.test.ts \
  test/daemon-message-agent.test.ts \
  test/inferred-parent-reply.test.ts \
  test/assistant-subsession-safeguards.test.ts \
  test/assistant-stop-task.test.ts
```

When implementing, port the existing behavior cases through the new action
adapter, changing only tool inputs and intentionally updated guidance assertions.
Assert the same calls, effects, metadata, authorization decisions, and result
shapes. Update descriptor/validator parity tests for the flat schema plus strict
action validators. Add focused cases for missing/conflicting actions, the trusted
task-owner adapter, guide examples, and reciprocal replies. Validate at the MCP
execution boundary as well as the inner handler, so pre-handler gateway lookups
and policy wrappers cannot evade the no-effect migration error.

### 7.7 Intentional differences, exhaustively scoped

1. Every call requires `action`; legacy calls fail before target lookup/effects and
   point to `getToolGuide`. The name and existing backend delivery paths remain.
2. Postless self-delegation is spelled `startTask {message}` instead of `toAgent: self`; a
   self `callAgent` without channel is rejected with that exact call as its repair. This
   changes input shape and vocabulary, not task execution or feedback.
3. A flat shared descriptor and `getToolGuide` replace the top-level union and
   repeated prose. Runtime branch validation remains strict.
4. Existing generated instructions and corrective notices use the new action
   forms and task vocabulary. `replyToSession` replaces the draft name `replyToParent`
   because the original backend already authorizes reciprocal origin replies.
5. The self-delegation receipt names its handle `taskId`, and `stopSubsession` becomes
   `stopTask`; their stop authority changes in §8.7.

This adapter does not introduce arbitrary session targeting, peer feedback-default
changes, or cross-platform agent selectors. The requested persistent task messaging, owner
stop, peer-session calls, and message-addressed replies are specified in §8–§9 rather than hidden inside the adapter
or described as existing behavior.

### 7.8 Adapter implementation record

Records the implementation on this branch. The task half is in this revision's names
(`startTask`, `messageTask`, `taskId`, `stopTask`); replies are still addressed by `sessionId`
until §12 items 5–7 land. Decisions the sections above left open:

- **Descriptor.** At the adapter stage the §3.2 draft shipped without its continuation and
  peer-session clauses, because §3.2 publishes each capability only once its runtime exists:
  784 characters of description, a 1668-character flat schema, and `sessionId` described for
  `replyToSession` only. The task revision ships the §3.2 draft with two changes: its
  `replyToSession` clause still says "answers a session that called you, by its sessionId",
  because message ids do not exist yet and §3.2 forbids advertising them early; and the
  `startTask` clause keeps the matrix-earned steering "for "fix this bug and open a PR", call it
  before exploring, say it started, and end your turn". Measured for a Slack + Telegram agent,
  the description is 942 characters, the flat schema 1874, and `getToolGuide` description plus
  schema 486; `sessionId` is described for `callAgent` and `replyToSession`, `taskId` for
  `messageTask`.
- **Not-yet-available targets.** The adapter stage refused `callAgent.sessionId`; §9 lifted it
  for a nonempty string. A null, empty or mistyped `callAgent.sessionId` or `messageTask.taskId`
  fails as an argument error (§8.9, §9.8).
- **Task argument errors.** A `messageTask` whose `taskId` is missing, null, empty or not a
  string, and a self `callAgent` without `channel`, return §3.5's text: the exact
  `sendMessage {"action":"startTask","message":"<the same message>"}` call, then the
  `startTask` guide rendered as plain text (purpose, one line per rule, the example). Both
  guides live in `mcp/ops/task-guide.ts`, so the error and `getToolGuide` cannot drift. A
  `messageTask` carrying the old `sessionId` gets the same error, which also names `sessionId`
  as not accepted; a `startTask` carrying `taskId` is told to use `messageTask`. A self
  `callAgent` with `sessionId` points to the `messageTask` guide.
- **Validation placement.** `executeTool` validates `sendMessage` before `resolveChannelArg`,
  and the handler validates again before delegating, so a direct handler call cannot skip
  it. Validation covers the key check, the per-action zod validator, the existing strict
  branch for `postMessage` (so `thread` and `toUser` array rules fail before any lookup),
  and the postless self-target check. The adapter then removes `action` (or, for
  `startTask`, builds `{toAgent: <trusted caller>, message}`) for the unchanged delivery path;
  `messageTask` goes to the task admission of §8.9 instead.
- **Error text.** Every rejection is a `ToolArgumentError` through the #2084 path, so §3.5's
  sentences appear after `sendMessage: invalid arguments — ` and are followed by the
  accepted-arguments and received-keys lines. That path drops an issue's own leading tool name
  and a doubled final period. Every recognized action's argument error names its action guide,
  except the two task errors above, which carry the `startTask` guide itself.
  An unknown action is named by argument, not by its supplied value.
- **Classification.** `isPlatformPost` is true only for `action: "postMessage"` (still
  excluding `toAgent` and `sessionId`), so `callAgent` with `channel`, both task actions and
  `replyToSession` keep their non-post write and join handling.
- **Guide shape.** `getToolGuide` returns JSON. The overview has `rules`, one `actions`
  entry per action (`purpose`, `required`, `optional`, one `example`, optional
  `availability`), and a `next` pointer; an action guide has the same fields plus `rules`
  and `examples` of `{use, arguments}`. Availability notes come from the session's
  integrations (platforms, direct-message and thread-update support) and from the session's
  coordinate: inside a task, patrol or approved proposal both task actions are marked
  unavailable. The visible self-call example uses the session's own agent id. The guide shows
  a task's progress question, and its replyToSession text calls an approved proposal's work
  that, not a task (§11 question 11).
- **Receipts and status.** The `startTask` and `messageTask` receipts carry `taskId` where the
  self-delegation receipt carried `childSessionId`; a peer `callAgent`, with or without
  `channel` or `sessionId`, keeps `childSessionId`, because what it reaches is a session.
  `viewSessionStatus` takes exactly one of `taskId` and `sessionId` (the `childSessionId` of a
  call) and checks both the same way. The protocol frames' `childSessionId` fields are wire
  names and unchanged.
- **Live probe.** The runtime-matrix probe reads the daemon's own action errors; its
  fabricated action checks are removed. Its task receipts are the daemon's own (`TASK_STARTED`,
  `TASK_MESSAGED`): a `messageTask` id other than the scenario's task gets the daemon's
  `task_not_found` receipt, recorded as an error. With §9 the fabricated peer-session check is
  gone too: a peer-session call gets the daemon's own receipt, or its `session_not_found`
  refusal for an id outside the scenario's scope. The outcome kinds are `task-start` and
  `task-message`, and the new-only scenario is `message-task`, whose request says "background
  task"; the comparable scenarios' requests, classifier and verdicts are unchanged.

## 8. Persistent task messaging — explicit capability extension

**Status:** Implemented (§8.9), except message-addressed task replies, which wait for §9.3–§9.6:
a task still answers its owning session with `replyToSession` on that session's id.

The original [assistant-mode design §5.6](assistant-mode.md#56-sub-sessions)
identifies steering as re-delegating into the same background work and explicitly defers it.
Complete that capability with two actions: `startTask` starts a task and `messageTask` messages
an existing one by `taskId`. Every owner message is a message whose metadata names the owning
session as its source, so all task-to-owner messages use the existing `replyToSession` action
on one of those messages' ids. No separate owner-message action is needed.

### 8.1 The start and message contract

| Input                                                               | Behavior                                                              | Authorization                                                                        |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Input                                                               | Behavior                                                              | Authorization                                                                        |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `{action: "startTask", message}`                                    | Start a new task of the current session and deliver its instructions  | Trusted caller identity; existing self-delegation, no-nesting, and concurrency gates |
| `{action: "messageTask", taskId, message}`                          | Deliver into that existing task, running or retained after completion | The ownership record must name the current session as the owning session             |
| `{action: "replyToSession", messageId, message}` from the task      | Return progress, a question, or results to the owning session         | The answered owner message's metadata (§9.4), which names the owning session         |

`startTask` accepts only `action` and `message`. `messageTask` requires a nonempty `taskId`;
reject a missing, null, empty, or mistyped id as an argument error that names the `startTask`
call, never treat it as starting. Both reject `toAgent`, `channel`, `thread`, `platform`,
`integrationId`, `attachment`, `sessionId`, `messageId`, and `needsReply`.

A supplied target that does not exist, is unavailable, or is not owned by the
current session must fail; never fall back to starting another task. Do not infer
starting from a lookup failure or use agent identity alone as proof of ownership.
The distinction is deliberate: `startTask` requests new work in a new task; `messageTask`
requests continuity in that exact retained context.

### 8.2 Persistent ownership, origin, and handles

`startTask` returns the task's handle as `taskId`, which today's receipt carries as
`childSessionId` and which contains the task's session key. The owning session passes it
unchanged as `taskId` when messaging or stopping the task. Resolve a task key or outward id
through the persistent task index and verify the recorded owning session against the
trusted current caller session, including agent and transport scope. Do not accept
an ACP runtime id or another task merely because it shares the same agent.

Each start and message is recorded on the task as a message (§9.3) whose source is the owning
session, and the task's origin records the owning session as its creator. Recovery and
background-wake turns keep both; no caller may move a task to another owner through a message.
Inputs claiming a conflicting owner are refused. The task answers with `replyToSession` on one
of those messages' ids, never with its own handle.

Owner-to-task authorization does not depend on the owning session's current turn origin,
a recent incoming reply, or the in-memory `childSessionLinks` map. Retain the
ownership record while the task exists, including when a round is
done, failed, or stopped. A later human-triggered turn in the owning session can
message the task. Another session of the same agent gains no authority merely
by sharing a channel. Existing daemon-authored report recovery after `!new` is not
by itself a grant for a replacement session to steer or stop the old task: any
ownership migration must be explicit trusted state and validated consistently.

Ordinary non-task replies follow §9. A task's reply reaches the owning session as a message
too, so the owning session may answer it with `replyToSession` on its id; direct messaging
should use `messageTask`, whose durable ownership check does not depend on any one message.
Either way the input is admitted exactly like `messageTask`: all admitted owner inputs into a
task participate in the same round/admission accounting, so no entry point bypasses caps or
reporting.

“Any time” means authorization is independent of the current turn's origin.
Availability, pause/drain, bounded queues, retained session state, and execution
authority can still refuse admission. A purged task is not recreated implicitly.

### 8.3 Messages do not complete a task

Send owner inputs through the task's existing serial input path. Initially,
messages to a running task are queued for the next input opportunity; admission
does not cancel a running tool or promise immediate application. Preserve the
task's context and workspace identity under existing recovery behavior.

The task sends progress, questions, and results with `replyToSession` on an owner message's
id, any number of times. The reply body is injected into the owning session, not posted
to a platform; the owning session's ordinary turn keeps its existing visible reply route.
The owning session can answer through `messageTask` in this or a later turn.

A successful `replyToSession` from a task is a delivered message,
not a command to mark the work done, release a concurrency slot, or clear the
completion obligation. This intentionally changes the baseline wrapper that marks
an indexed sub-session done as soon as it reports. A task's reply never settles the answered
message's reply obligation either: the round's automatic report does (§8.5). Keep authorization and receipt shape;
move completion decisions to actual work settlement. Do not add a second reply
action or a model-supplied completion flag just to distinguish progress from results.

Questions do not create an implicit indefinite wait. If the task's current round
ends before an answer arrives, the owning session's later answer can begin another round
in the same task. Existing permission/background-work waiting rules still apply.

### 8.4 Work rounds and continuation

The task outlives one round of work. A round begins when input is
admitted into an idle task and includes inputs accepted while it is active. It
ends when execution, accepted pending input, and background work have settled, or
when failure/stop has explicitly accounted for that work.

| Task state                                                             | Existing-task `messageTask` behavior                                                                     |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Running or with pending accepted work                                  | Queue into the same task and round; no extra concurrency slot                                            |
| Completed and retained                                                 | Reuse its context; start a new round with a new completion/failure obligation                            |
| Failed or stopped but retained and eligible                            | An explicit new owner message may start a new round; never automatically retry old failed/stopped inputs |
| Paused, draining, unavailable, queue-full, or over the active-work cap | Refuse admission with a truthful reason                                                                  |
| Missing, purged, or not owned by the caller                            | Refuse without starting or retargeting a task                                                            |

Starting or resuming idle work rechecks current execution authority and atomically
acquires a slot under the existing per-agent active task cap. Retained idle
tasks consume no active slot. Simultaneous messages to one idle task open one
round, with later inputs appended in order; they do not independently acquire slots.
A task starting a task remains forbidden.

Scope pending inputs, status, completion obligations, and report deduplication to a
daemon-owned round identity. Admission racing with completion either joins the
old round before it settles or opens a new one afterward. Late outcomes from an
older round cannot complete a newer round or release its slot.

Stopping a task (§8.7) stops the active work and accounts for queued inputs so they cannot
restart it accidentally. An explicit later `messageTask` can request new work. Previously
performed effects and external processes retain their existing stop semantics; continuing is
not rollback.

### 8.5 Automatic outcomes and reply delivery

Every started or continued round owes a completion/failure outcome to its owning session,
without `needsReply`. Preserve final-output inference, no-result notices, and
failure fallback as appropriate, but scope them to the round and actual execution
settlement rather than treating any successful reply as task completion.

A progress reply must not suppress the eventual terminal outcome. A terminal
outcome already recorded as delivered for the settled round must not be duplicated
by inference or retry. That determination belongs to trusted round/report state,
not a heuristic that any earlier `replyToSession` means the task is complete.
Pending accepted input or live background work prevents premature settlement.

Replace task-wide report rejection for completed old rounds with round-aware
checks: the next admitted round must be able to send replies and report its own
outcome. Stale completion from a failed or stopped round cannot overwrite the new
round. Persist delivery identity and receipt state for recovery; retain bounded
failure handling when the owning session is unavailable or gone rather than guaranteeing
unconditional arrival.

These lifecycle changes apply to tasks. Peer `needsReply` defaults remain unchanged;
message-addressed replies and per-message obligations are specified separately in §9.
Explicit task replies use the reply result shape `{delivered, targetSession?, inReplyTo,
reason?}` (§9.4); delivery does not mean a human has read the owning session's response or that
the owning session has finished processing it.

### 8.6 Unified receipts and retry behavior

For `startTask`, preserve the existing self-delegation receipt fields and meanings, with the
handle renamed: `ok`, `wake`, `taskId`, `reply`, `nextAction`, and explanatory `message`.
For messaging an existing task, use that same result family: successful admission identifies
the same task in `taskId` and `wake.targetSession`, with waiting/reporting
guidance as appropriate. Do not describe a message as starting another task.

`ok` alone does not prove delivery; inspect `wake.delivered`. Admission is not
model completion or immediate steering. Known runtime refusals use typed reasons;
malformed input uses the argument-error path. Unknown and unowned targets
must not disclose other sessions' existence or trigger fallback starting.

Persist a stable per-submission identity and receipt across transport retries.
Replaying one submission must not start another task, record a second message, append the same input
twice, acquire two slots, or duplicate its terminal report. A new intentional
model call remains a new submission even if its text is identical. Uncertain
acknowledgement is not a known refusal and must not encourage an unqualified resend.

Do not change the meanings or shapes of `callAgent`, `replyToSession`, or
`postMessage` receipts beyond §9.4's `inReplyTo`. In particular, the task handle is not a
message id accepted by `replyToSession`.

### 8.7 Stopping a task

`stopTask {taskId}` replaces `stopSubsession`. It stops a task the way the console's Stop
does, through the same daemon core, logged with who stopped it: it interrupts the task's
current turn, drains its queued inputs so they cannot restart it, settles the round as
stopped, and answers stopped or nothing was running, adding that a process the task's runtime
started in the background may keep running. Stopping undoes nothing already done; only a later
explicit `messageTask` opens another round.

| Caller                                                       | `stopTask`                |
| ------------------------------------------------------------ | ------------------------- |
| The owning session, on any of its turns                      | Allowed for its own tasks |
| The task itself, or another task of the same owning session  | Refused                   |
| Another session of the agent, including the one after `!new` | Refused                   |
| Another agent, a patrol, an approved proposal, a hook        | Refused                   |

"Any of its turns" includes a turn a person started, a task's report, a reply from a peer, a
reminder, and a scheduled run. The owning session is the authority because the task is its own
step: deciding that a step is no longer needed is planning, and the reasons often arrive on
turns no person started, such as a report that a task it depended on failed. A person who wants
a task stopped asks the owning session, which decides; the `!stop` sender rule no longer gates
this tool. The console's Stop on the task's own page keeps its existing rule, whoever may
continue that session.

An id that is unknown, purged, or not owned by the calling session is refused with the same
words, so nothing about other sessions is revealed. Stopping a task moves no content, so a
session marked by a private read (assistant-mode.md §5.5) may still do it. `stopTask` never
stops a session reached by a self `callAgent` with `channel`: that session belongs to its
conversation and follows its own stop rules. Patrols and approved proposals keep their
existing stop paths.

Standing context reminds the owning session which tasks it has running, by id and label,
refreshed on the next turn after one starts or ends, and states that it may stop one when it is
no longer needed. The tool's description tells the agent to ask which task a person means
only when that is not clear.

### 8.8 Acceptance boundary

`startTask` is adapted existing behavior; messaging an existing task, round-aware reporting,
and owner stop are new runtime work. They may be reviewed separately, but publish the
complete `startTask`, `messageTask`, and `stopTask` contract only when all of it works. The 586 tests in
§7 verify the original baseline, not this extension.

Required additional behavior tests:

- `startTask` starts a task; `messageTask` with a valid id messages that same task. A
  missing, null, empty, unknown, unavailable, or unowned id never starts a replacement.
- The current session must be the task's recorded owning session, independent of
  active origin; other tasks, unrelated sessions of the same agent, and other agents are
  refused.
- Every owner message names the owning session as its source across starting, messaging,
  background turns, and restart. The task can answer any of them, more than once, with
  `replyToSession`; conflicting metadata cannot move it to another owner.
- Progress replies do not end work, release slots, or suppress terminal outcomes.
- Completed/failed/stopped retained tasks can receive explicitly requested new
  work when eligible; new rounds reacquire slots and report automatically.
- Simultaneous admission/settlement, duplicate delivery, late outcomes, and restart
  neither lose input nor report/finish the wrong round. The reciprocal reply entry
  path cannot bypass this accounting.
- `stopTask` from the owning session succeeds on a person's turn, a task-report turn, a peer
  reply turn, and a scheduled turn; it is refused from the task itself, another task, another
  session of the agent, and another agent, in the same words as an unknown id.
- Pause/drain, queue limits, owner recovery, purged tasks, and uncertain
  receipts behave as specified, without starting extra work or granting unauthorized access.
- Both messaging directions remain session-only; the owning session's ordinary response
  keeps its existing visible reply route.

Implement the durable round/admission state alongside indexing, dispatch, reports,
and cancellation. Merely widening origin authorization or adding an enum value
does not provide this contract.

### 8.9 Implementation record

Storage keeps its internal names (`assistant_subsession*`, the `subsession:` coordinate).

- **Scope.** Rounds apply to tasks, the sessions `startTask` creates.
  An approved task (assistant-mode §5.10) and a patrol (§5.9) run once and are never continued,
  so they keep the one-report lifecycle in which their own report settles them.
- **Round state.** The sub-session index row carries `round` (store schema v51). `open` is a
  running round that holds a slot; the round's report waits in `reporting`; `done` and `failed`
  are retained idle states that hold none. Every parent input carries its round in
  `CallMeta.subsessionRound`, which is persisted with the inbox row, so a replayed turn settles
  its own round and a late outcome of an older round changes nothing.
- **Admission.** Ownership is the index row's recorded parent: its session key and its outward
  id must both be the trusted caller session's. A sibling, the child itself, another session of
  the agent (including the replacement after `!new`), another agent, a patrol, a task, a purged
  child and an unknown id all get the same `task_not_found` receipt. Under the
  per-sub-session report lock, an `open` round is joined with no slot; a settled row reopens as
  round + 1 only below the per-agent cap, so concurrent messages to one idle child open one
  round. Pause, drain and a member that no longer serves the agent refuse before any slot is
  taken. A reopened round whose input the child then refuses goes back to its previous state.
- **Report race.** While the previous round's report is in `reporting`, a continuation waits
  for a send in flight and then, if the report is still unadmitted, refuses with
  `task_reporting` instead of opening a round, because that pending report lives on the
  row. Every task refusal reason is renamed the same way: `task_nesting` and `task_limit` as
  well as §12's three; `submission_in_flight` is unchanged.
- **Outcomes.** A child's `replyToSession` is only delivered: it no longer marks the row done,
  and a settled round refuses a late one with `task_ended`. The round's one report is the
  daemon's, through the existing durable `reporting` outbox, once no queued input, input being
  admitted, or background wake remains. A clean end is `[task finished]` with the round's last
  final output, which replaces the separate `[inferred reply]` for tasks; a failure or stop is
  `[task ended]`. Both name the `messageTask` call that continues the task, unless the report
  lands in a later session of the place (after `!new`), which cannot continue it and is told so
  instead; a report persisted before the rename, naming `messageSubsession`, is rewritten the
  same way. A patrol's or approved proposal's one report keeps its `[sub-session ended]` text
  until §11 questions 10–11 rename those. Each round's report has its own delivery
  identity. A joined input whose admission fails after the round's last turn ended leaves the
  round to the existing idle sweep. A clean turn end does not settle the round while the child
  still waits for a reply it asked another agent for; that reply's turn continues the round,
  and the idle sweep bounds the wait. A reopened round whose opening input is refused goes back
  to its previous state only if no other input joined it.
- **Reciprocal path.** A parent's `replyToSession` into its own delegated child keeps the
  origin authorization and is then admitted exactly like `messageSubsession`. It maps refusals
  to the existing reply reasons (`not_authorized`, `busy`, `hop_limit`, `queue_full`), so the
  reply receipt keeps its values. It is replaced by §9.4's routing when message ids land.
- **Submission identity.** The MCP bridge sends a `callId` (a per-process nonce plus the MCP
  request id). The daemon scopes it to the calling session and agent, claims it once in
  `assistant_subsession_input`, and keeps the receipt. A replay gets the first receipt; a
  concurrent replay is told `submission_in_flight`. A call without `callId` gets a fresh
  identity, and its delivery and inbox receipt ids derive from it either way. The bridge does
  not retry today; the identity is there so a retry cannot double an input.
- **Guidance.** A task's first input reads `From your own session, as a background task: …`
  and every later one `From the session that started this task (session <owner id>), a new
message for this background task: …`; both carry the recorded owner as origin. Approval
  cards strip both that wrapper and the pre-rename one from a task's label. A task's standing
  reporting block, headed `# Reporting back to the session that started this task`, says it
  may reply any time, that a reply does not end its work, and that the daemon reports each
  round's end. The standing collaboration text teaches `startTask`, ordering independent and
  dependent tasks, `messageTask` and `stopTask`.
- **Stop.** `stopTask {taskId}` goes through the cancel core the console's Stop uses, whose
  interrupt drains the task's queued inputs. Authority is the index row alone: a delegation
  row (never a patrol's, and never an approved proposal's `subsession:task-` coordinate) whose
  recorded owner key and outward id are both the calling session's. Anything else — the task
  itself, a sibling, the session after `!new`, a recreated session on the same key, another
  agent, an unknown or purged id — gets `This session started no task with that id. Nothing was
stopped.` No turn or sender gate remains; the stop is logged as the person whose message
  started the live turn, else as the agent itself (`isBot`). The tool is offered in every
  session that can start a task, so in every session except a task, patrol or approved
  proposal, which now includes hook runs, scheduled runs and peer sessions. There is no alias
  for `stopSubsession` (§4). The stop note always names `messageTask`.
- **Running tasks.** The reminder is built for every session that can own tasks and lists only
  its tasks, newest first, by `taskId` and label, saying it may stop one with `stopTask` once it
  is no longer needed; patrols and approved proposals are not listed.
- **Patrols and approved proposals.** The guide and descriptor say that only a task may reply
  any time; a patrol's or approved proposal's guide notes that its one reply, at the end,
  settles it. A report from an agent's own task records no reply source in the session it
  reaches, so it opens no standing path back into that task.

## 9. Peer sessions and message-addressed replies — explicit capability extension

**Status:** Existing-session `callAgent` (§9.2) is implemented. Message-addressed replies
(§9.3–§9.6) are not: the branch implements the earlier multi-origin model, recorded in §9.8.

A peer session can receive calls from several source sessions, and from one source many
times. Each call is a message, and the message carries what a reply needs: its id and the
source it came from. A reply names the message it answers, so the receiving session never
has to know which of its callers is current, and its origin is reduced to a record of who
created it. This does not give a task multiple owners: its owning session and §8's ownership
rule remain intact.

### 9.1 The A → B ← C scenario

1. Session A calls agent B. Existing routing starts or selects B's session B1. The call
   reaches B1 as message `m1`, whose metadata names session A and agent A as its source. If
   the call created B1, B1's origin records A as its creator.
2. Session C calls B with `sessionId` identifying B1. Once the existing-session call is
   authorized and admitted, it reaches B1 as message `m2`, whose source is C.
3. A calls B1 again with a follow-up; it reaches B1 as `m3`, a separate message from A.
4. B1 answers with `replyToSession` on `m1`, `m2`, or `m3`, regardless of which message most
   recently woke it, as many times as it needs. Each reply goes only to the answered message's
   source. No reply changes the owner of B1 or of any task.

C's call:

```json
{
  "action": "callAgent",
  "toAgent": { "agentId": "B", "needsReply": true },
  "sessionId": "<B1 handle returned by the earlier call>",
  "message": "Continue the discussion here and check the Windows behavior as well."
}
```

B1 answers A's first request:

```json
{
  "action": "replyToSession",
  "messageId": "<m1>",
  "message": "Here are the findings for your original request."
}
```

Or C's:

```json
{
  "action": "replyToSession",
  "messageId": "<m2>",
  "message": "Here are the Windows findings you asked for."
}
```

A, B, and C name agents in the example, but a message's source is a precise session. Two
sessions of agent A sending to B1 are distinct sources, and agent identity alone never
addresses a reply. B1 cannot reply to itself: a session never receives a message from itself.

The same model covers a self `callAgent` with `channel`: the session it opens in the channel
receives the call as a message from the calling session, so it can report back with
`replyToSession` on that id while the conversation in the channel continues on its own.

### 9.2 Existing-session `callAgent`

Keep `toAgent` required. `sessionId` is optional; when present it is a nonempty
existing target-session handle, must resolve to the agent named by `toAgent`, and
is mutually exclusive with `channel`. Preserve `toAgent.needsReply` and its existing
accepted representations. Still reject `platform`, `integrationId`, `thread`, and
`attachment` on this action.

Without `sessionId`, preserve existing peer routing; this need not create a new
session. With `sessionId`, resolve the session key the earlier call returned
or its outward id on the owning daemon. Do not accept an ACP runtime id. Deliver into
that exact retained context through normal admission, without posting a new root,
changing its conversation identity, or creating a replacement on failure. Do not
infer a headless/visible output change from the addressing form: preserve the
target's established output behavior and trusted delivery rules.

**Admission rule.** A call into an existing session is admitted only when all of these hold:

1. The existing checks of any agent call pass: the caller's outbound policy and the target's
   caller policy, the org-scoped directional call policy (`CpCollabRoutes.admits`), coordinate
   integrity of the caller's own channel, and the hop limit. Remotely, the relay and the owning
   daemon's terminal verify apply them again, as for an ordinary wake.
2. On the owning daemon, `sessionId` resolves to a session of the agent named by `toAgent`: by
   its session key (the handle a call returned) or by its outward id, never by an ACP
   id. A task, a patrol, and an approved proposal's work are refused, and so is the
   caller's own session.
3. The people on the calling turn may read the target session's conversation under the
   daemon's existing cross-conversation read rule — the one `getChannelHistory` and `recall`
   pass (assistant-mode.md §5.5, `judgePlaceRead`). The caller's current conversation is the
   current place, so a target in the same platform conversation is admitted; otherwise the
   target is described from its own session row and bot, and every person behind the calling
   turn must be allowed by `askerMayRead` with the target agent's lookups and the target
   session's outward id. A turn no person is behind (another agent's wake, a hook, an
   unattributed schedule) is never admitted, because the rule reads only public channels for
   such a turn and only on its own bot.
4. Execution admission succeeds: the owning daemon serves the agent, it is not paused or
   draining, and the session's serial gate accepts the input durably.

The owning daemon makes checks 2–4 for local and remote calls alike. A remote call carries
`deliveryKind: "session-call"`, the `targetSessionId`, and the calling turn's people
(`callerAskers`), asserted by the authenticated source daemon like the rest of its lineage. The
relay forwards it only to a daemon that advertised `agent-session-call-v1`; an older relay
cannot decode the kind and fails closed. Knowing the id, or being allowed to call agent B, is
not enough by itself, and read-only console visibility is honored only through the same
console verdict the read rule already uses. The call's message record (§9.3) is created only
once the input is admitted. No invitation tool or automatic sharing operation is added.

A task is not turned into a shared peer session through this field. Reject
`callAgent.sessionId` aimed at a task and direct its owning session to `messageTask`. Preserve
the visible self-call with `channel`; this extension adds explicit existing-session targeting
for peers, not a new self-activation bypass.

A session may call the same existing session any number of times. Each admitted call is a new
message with its own id and its own reply obligation; calls are not merged, deduplicated by
content, or refused because an earlier one is still unanswered. Only a transport replay of one
submission is collapsed (§8.6).

### 9.3 Session messages and their metadata

A **session message** is one input that one session delivers into another: a `callAgent` call,
including into an existing session or a channel; a `startTask` or `messageTask` instruction;
a `replyToSession` reply; and a task's automatic round report. People's platform messages and
`postMessage` posts are not session messages and carry no message id; a person is answered in
the conversation as today.

The sending daemon assigns each session message an id when the submission is made: opaque,
unguessable, unique across the install, and derived from the submission identity, so a
transport replay carries the same id (§8.6). The receiving daemon records the message when it
admits the input, before the model sees it:

| Field              | Meaning                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `messageId`        | The id above                                                                                         |
| Recipient          | The receiving session's key and agent: the only session that may answer the message                  |
| Source session     | The sending session's outward id                                                                     |
| Source agent       | The sending agent                                                                                    |
| Return route       | Local, or the remote coordinates and transport scope a reply needs, and any code-host reply snapshot |
| Kind               | `call`, `taskInput`, `reply`, or `report`                                                            |
| In reply to        | For a reply, the message it answers                                                                  |
| Reply requested    | Whether the source asked for an outcome (`needsReply`, or always for a task input), and its state    |
| Hop count and time | For the existing hop limit and for display                                                           |

The sending daemon also records each message it sent: id, sending session, and receiving agent.
Every field comes from trusted context: the authenticated delivery lineage and the daemon's own
state, never from the model or the message body. Bodies stay in the transcript on the data plane
as today; the record holds metadata only. A delivery whose id is already recorded for another
recipient is refused, so an id names one message.

A record lives as long as both its recipient and its source session: purging either, removing
either agent, or leaving the organization drops it. It does not expire because newer messages
arrived or the turn that received it ended.

### 9.4 Replying by message id

`replyToSession {messageId, message}` is decided from the answered message's record alone:

1. The id must name a message recorded on this daemon whose recipient is the calling session,
   with its agent and transport scope. An unknown id, a message to another session or agent, a
   dropped record, and a forged id all get the same refusal, `message_not_found`, which reveals
   nothing about other sessions.
2. The source must still be answerable: its session and agent exist in the same organization,
   and the existing delivery fences, remote admission, and hop limit allow the reply. A source
   that has ended keeps the existing ended reason.
3. The reply is delivered to the source session by the recorded return route, as a new session
   message of kind `reply` whose metadata names the replier and the answered message. The
   source can answer it in turn; the hop limit bounds an exchange that never settles.
4. A remote source's daemon accepts the reply only into the session that sent the answered
   message to the replying agent, by its own sent-message record, so neither side has to trust
   the other's routing alone.

Nothing else is consulted: not the session's origin (§9.6), not which message woke the current
turn, not the latest caller. A message may be answered any number of times; each reply is
delivered separately and gets its own receipt, `{delivered, targetSession?, inReplyTo,
reason?}`. A reply never fans out to other sources, and an unavailable source fails rather than
delivering anywhere else. Replying into one of the session's own tasks is admitted like
`messageTask` (§8.2).

### 9.5 Reply obligations and what the model sees

An obligation belongs to one message. A message sent with `needsReply` opens one; the first
delivered explicit reply to it settles it, and later replies to the same message are still
delivered. A reply to another message, even from the same source, settles nothing else. For a
task, explicit replies settle nothing: the round's automatic report does (§8.5).

Inference and failure reporting are addressed by message as well. A turn started by one message
with an open obligation can have its final output forwarded as the reply to that message; a
turn into which several messages were folded infers nothing and leaves their obligations open.
A call whose turn fails is reported to that call's source, whoever called since.

Every session message reaches the model with its id, its source agent and session, and, when a
reply is requested, the exact `replyToSession` call for it. Standing context lists the messages
the session may still need to answer, open obligations first, bounded to a few entries with the
rest counted and still valid; dropping an entry from the prompt never drops its record. The
singular `Parent session` reply address is gone.

### 9.6 The origin records creation only

A session's origin records who created it: the creating agent, its session, the kind of message
(call, self call into a channel, or task start), and when. It is written once, when the session
is created by a session message, and later calls never overwrite it. A session created by a
person or a schedule has none.

The origin is informational: status views and the console may show it. It authorizes no reply,
routes no reply, and supplies no standing reply address. The creating call is itself a session
message, so the session can answer its creator by that message's id like any other. A task's
owner is its ownership record (§8.2), which the origin happens to match but does not replace.

Sessions created before the upgrade have an origin and no message records. The upgrade gives
each such session one synthesized `call` record from its origin, carrying any outstanding
reply request, so in-flight work can still answer; after that the origin is never read for
replies.

### 9.7 Acceptance boundary

- A calls B1, then C calls that same B1 by session id, then A calls it again; B1 holds three
  messages and answers each by id, during the triggering turn and later, including after
  restart. Each reply reaches only that message's source.
- Answering one message twice delivers twice and settles its obligation once; answering A's
  first message leaves A's second message and C's message open.
- An unknown, foreign, dropped, or forged id fails with `message_not_found`, without delivery or
  a new record. A legacy `replyToSession {sessionId}` is an argument error.
- Replies never read the origin: a session whose origin names A but which holds no message from
  a given source cannot reply to it, and an origin change or absence changes nothing.
- B1's owner and conversation identity stay unchanged; no new root post or substitute session
  appears on explicit-target failure. Target-agent mismatch, missing/invalid session id,
  unauthorized participation, and task bypass attempts fail without recording a message.
- Different source sessions of the same agent remain distinct; no session can answer itself.
- Replies to replies work and the hop limit stops an endless exchange.
- Local and remote delivery assign and check ids identically; a replayed submission records one
  message and one obligation; a remote source accepts a reply only into the sending session.
- Inference and failure reports go to the message's own source; folded turns infer nothing.
- A self `callAgent` with `channel` lets the channel session answer the caller's message, and
  its origin names the caller.
- Tasks: owner messages name the owning session, the task answers them by id any number of
  times, and §8's ownership, `messageTask`, `stopTask`, and round reporting are unchanged.
- Sessions from before the upgrade can answer their origin's outstanding request once migrated.

Implement message ids, the message record on both sides, reply resolution by id, per-message
obligations, origin-as-creation, and model-facing message display as one reviewable capability.
A new id field alone, or reply authority still read from session state, is insufficient.

### 9.8 Implementation record

Records the earlier multi-origin implementation on this branch, in its own names: reply
authority from recorded source relations and the durable origin, addressed by session id. §12
lists how it changes.

- **Refusals.** Every resolution or participation failure — an unknown id, an ACP id, another
  agent's session, a sub-session, a session the calling people may not read, a turn no person
  is behind — returns one receipt, `wake: {delivered: false, reason: "session_not_found"}` with
  a message pointing to `childSessionId` and to `messageTask` for a task, so a
  refusal never says that a session exists. A remote one is the ack's `not_found`. Policy, hop
  and execution refusals keep their existing reasons (`not_allowed`, `hop_limit`, `busy`,
  `queue_full`, `offline`, `unsupported`). Nothing is posted, no replacement session is opened,
  and no relation is recorded.
- **Arguments.** `callAgent.sessionId` is validated before any lookup: a null, empty or mistyped
  id, `sessionId` beside `channel`, and your own agent id in `toAgent` are argument errors; the
  last points to the `messageTask` guide. The call is postless and its receipt is the
  agent-call one (`{ok, wake, childSessionId, reply?, nextAction?, message?}`).
- **Delivery.** The input lands on the target session's own coordinates and its ordinary reply
  route, the way a reply into an origin does: no `headless` stamp, no root post, no new
  conversation, and the caller-framed `From <caller>: …` text.
- **Relations.** The daemon records a source wherever it settles an admission
  (`dispatch`), so local and remote wakes, session calls, paired channel calls and origin
  replies all add one: the table `session_reply_source` keeps the replying session's key and
  agent, the source's outward id and agent, its landing coordinates and its code-host reply
  snapshot. A task records none (§8.2), no session records its own agent's task, a
  duplicate admission adds nothing, and a session is never its own source. Purging a session or
  removing an agent drops its relations.
- **Reply authority.** `replyToSession` is authorized for this turn's origin, the session's
  durable origin, or any recorded source, and refused for the caller's own id and for anything
  else. A remote destination is reached by its recorded coordinates and agent, so a later turn
  or a restart can still answer it; the durable origin keeps its bound code-host snapshot.
- **Obligations.** Each admitted call with `needsReply` opens a row in
  `session_reply_obligation`, keyed by its delivery. A delivered reply to a source answers one
  of that source's open requests — the current turn's own call (or a call folded into it) if
  open, else the oldest — never every request and never another source's. Inference and the
  failure report read the call's own row instead of the single parent link, so a newer caller
  never cancels an earlier one's report, and both go only to the call's own source. A turn into
  which another call was folded infers nothing, leaving its requests open. Sessions with no
  tracked request keep the sticky `needsParentReply` behavior.
- **Model-facing context.** Standing context names the durable origin as `Parent session`; its
  report-back directive stands for that origin's own open request once requests are tracked. A
  call asking for a reply from another source gets a turn block naming that source. A turn of a
  session with several sources, or whose input came from another source, carries a "Sessions
  you can reply to" block: the input's source, and up to eight sources (newest first, with
  their open requests), the rest counted and still valid. The descriptor (§7.8), the guide and
  the collaboration text advertise the form.
- **Participation.** A session call is judged as a read of the target's conversation from the
  caller's place. The synthetic `a2a:<agent>` coordinate is shared by every peer one agent woke
  without a channel, so it never counts as the caller's own conversation: such a call is judged
  by who is asking, and a turn no person is behind is refused.
- **Failures and inference.** An admitted session call whose turn then fails is reported to its
  own source and settles its request, as an ordinary local wake's failure is; a remote source
  gets no report, as for a remote wake. Inference is suppressed after a failed explicit reply to
  the same source, so the callee is never reported as having made no reply.
- **Probe.** The fabricated peer-session rejection is removed. A peer-session call now passes the
  daemon's validation and gets its own receipt, or its `session_not_found` refusal for an id
  outside the scenario's scope.

## 10. Runtime matrix verification

Unit suites prove the adapter's parity; they cannot show whether a runtime loads the
descriptor or whether a model picks the right action from a short description plus
an on-demand guide. Add a `sendMessage` probe to the local live runtime matrix
(`packages/daemon/test/acp-matrix/`, run with `test:runtime-matrix`) and run it once
under every admitted runtime.

- **Tools.** Serve the real descriptors from `toolsForIntegrations`, plus
  `getToolGuide`, through the matrix's HTTP MCP fixture. The fixture records each
  call's arguments and runs the real action validators; it never posts, wakes an
  agent, or injects into a session.
- **Prompts.** One prompt per case: ask a peer for a result (feedback must be
  requested), start long work of your own in the background (a task), open visible work in
  a channel, DM a person, post an update into an existing thread, reply to a received message, and give
  an existing task more work. One negative prompt asks for a reply in the current
  conversation, where no tool call is correct. The task prompts say "background task", never
  "sub-session"; the comparable baseline prompts name no mechanism and stay unchanged.
- **Verdicts.**

  | Outcome                                                          | Cell     |
  | ---------------------------------------------------------------- | -------- |
  | `sendMessage` or `getToolGuide` absent from the runtime's tools  | `✗`      |
  | Wrong arguments, corrected after one guide lookup or error retry | Degraded |
  | Wrong action or target, or a tool call on the negative prompt    | `✗`      |
  | Provider logged out, rate-limited, or out of quota               | `U`      |

- **Baseline first.** Run the probe against the current `sendMessage` before the
  change. Its Codex result answers the truncation-or-drop question in §1.

This is a compatibility smoke test, not a quality statistic: one sample per case is
too noisy to compare designs, so it gates "loads and is used correctly" only.

## 11. Open questions

**Status:** Questions 1–6 are resolved in favour of the document as written: a hard break with
no transition period (§4); nested field unions kept, with no top-level `needsReply` alias
(§3.2); the names `action`, `getToolGuide` and `replyToSession`; receipt shapes unchanged
except the task handle and the reply's `inReplyTo` (§7.5, §9.4). They record the questions as
raised against an earlier, compatibility-first revision. For the task revision, 7 and 8 are
resolved (`startTask`; reject with the exact `startTask` call), 9 is deferred with §8.7 as
written, and 10–11 are follow-ups outside this change.

1. **Required `action` versus an unchanged contract.** The earlier revision kept every
   existing call valid; a survey of one production deployment found the old forms in
   one agent description and one knowledge article. This revision rejects calls
   without `action` (§4). Is a hard break acceptable, or should missing-`action`
   calls stay valid for a transition period?
2. **Field-level unions.** The review chose to advertise one canonical spelling per
   field (`needsReply` as a boolean, `toUser` as an array, `toAgent` as a string) while
   the handler keeps accepting legacy spellings. §3.2 keeps the nested unions and
   rejects a top-level `needsReply`. Which holds if a runtime rejects nested `oneOf`?
3. **Rules that must stay in the description.** The review kept four rules because the
   model decides before reading any guide, including "a visible post opens a new
   conversation at the channel root". §3.1 records that posts can reuse the author's
   idle context, so that rule needs rewording before it can return.
4. **Consequence notes in results.** The review asked every result to state which
   operation ran and its consequence, e.g. that a call without `needsReply` returns
   nothing and must not be re-sent. §3.5 and §7.5 preserve receipt shapes unchanged.
   Can a notice field be added without breaking that parity?
5. **Naming.** The review settled on "form", `toolGuide`, and `originReply`; this
   revision uses `action`, `getToolGuide`, and `replyToSession`. Pick one vocabulary
   for the guide, the errors, and standing context.
6. **Other tools over 1024 characters.** `writeMemory`, `listChannels`,
   `listChannelAgents`, `listAgents`, and `shareFile` also exceed the limit. They are
   out of scope unless the §10 baseline shows Codex drops oversized tools rather than
   truncating them.
7. **Action name.** Resolved: `startTask` starts a task and `messageTask {taskId}` messages
   one, instead of one start-or-message `messageTask`. The extra action costs description
   budget; the description stays under 1024 characters (§3.2).
8. **Self-call without a channel.** Resolved: rejected, and the error returns the exact
   `startTask` call and the `startTask` guide (§3.5). Running it as a task with a notice would
   keep two spellings for one operation.
9. **Owner stop on turns no person started.** Deferred: §8.7 stands as written, so a task
   report, a peer's reply, or a scheduled run may lead the owning session to stop a task.
   Revisit whether a peer's reply should be excluded, since its text comes from another agent.
10. **Product vocabulary.** Follow-up: product conventions, assistant-mode §5.6–§5.8, the
    console's Sub-sessions tab, and the permission-request cards still say sub-session.
11. **Patrols and approved proposals.** Follow-up: assistant mode calls an approved proposal's
    work a task (§5.10), which under §2.1 it is not; rename it so "task" has one meaning.

## 12. Changes from the sub-session revision

The branch implemented §3–§9 in sub-session and multi-origin terms. Items 1–4 and the task
parts of 8–9 are done (§7.8, §8.9); the rest remain. To reach this revision:

1. **Task actions and field.** Split `messageSubsession` into `startTask {message}` and
   `messageTask {taskId, message}`, with `taskId` required on `messageTask`, in the schema,
   validators, guide (a `startTask` and a `messageTask` entry), errors, and every generated
   text. `sessionId` is then no longer accepted on either.
2. **Receipt.** Name the self-delegation and continuation handle `taskId` instead of
   `childSessionId`; `viewSessionStatus` and `stopTask` accept it. Refusal reasons such as
   `subsession_not_found` become task names (`task_not_found`, `task_reporting`, `task_ended`).
3. **Self `callAgent`.** Keep the channel form; the rejection without a channel, and a
   `messageTask` without `taskId`, return the exact `startTask` call and the `startTask` guide
   (§3.5). Add a regression test that the channel session can answer the caller's message.
4. **Stop.** Rename `stopSubsession` to `stopTask`, drop the person-started-turn and `!stop`
   sender gates, and refuse every caller other than the owning session (§8.7). Update the stop
   note and the running-tasks reminder.
5. **Message ids.** Assign an id to every session message on the sending daemon from its
   submission identity, carry it on local and remote deliveries (a relay frame field, behind a
   new capability so an older peer fails closed), and record it on both sides (§9.3). Replace
   `session_reply_source` and `session_reply_obligation` with the message record and its
   per-message obligation; migrate each existing durable origin into one record (§9.6).
6. **Replies.** `replyToSession` takes `messageId`, not `sessionId`, and is decided by §9.4
   alone: drop the active-origin, durable-origin, and recorded-source authorization, add the
   `message_not_found` refusal and the receipt's `inReplyTo`, and route a reply to an owned
   task through `messageTask` admission. Inference and failure reports key on the message.
7. **Origin.** Write the origin once at creation and stop reading it for replies, routing, or
   standing reply guidance (§9.6).
8. **Model-facing text.** Descriptor, guide, standing context, the message header on every
   session-message input, the "messages you may answer" block replacing "Sessions you can reply
   to" and `Parent session`, report headers (`[task finished]`, `[task ended]`), and
   continuation input use task and message vocabulary. Keep the description within 1024
   characters (§5).
9. **Probe.** Rename the probe's task scenarios and outcome kinds, and make its reply scenario
   answer a message id from the prompt; keep the comparable scenarios' prompts, classifier, and
   verdicts so the baseline still applies (§10).
10. **Documents and comments.** Update `GLOSSARY.md` and code comments that cite §9.3–§9.4 of
    the earlier revision; product conventions and assistant-mode follow §11 questions 10–11.

Storage names (`assistant_subsession_*` tables, the `subsession:` coordinate) are internal
and may keep their names; nothing model- or person-facing may show them.
