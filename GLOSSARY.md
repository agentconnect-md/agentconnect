# AgentConnect

AgentConnect connects people and agents through conversations. This glossary records
agreed domain terms as the product model is refined.

## Language

### Images in conversations

**Shared image**:
An image the agent has explicitly published into the current conversation as a
viewable preview. Original-file availability is independent of whether it is shared.
_Avoid_: Generated image (when referring to publication rather than creation)

**Original image**:
The complete image selected for sharing, before any reduction made for its chat
preview. Viewing or downloading the original refers to this version.
_Avoid_: Preview, current workspace version

**Image preview**:
The representation of a shared image displayed in the chat flow. It may be reduced
to fit the display limit and is distinct from the original image. A vector original
may have either a vector preview or a reduced raster rendering.
_Avoid_: Original image, thumbnail (when implying a fixed small dimension)

**Expired original**:
A previously available shared image's original that is no longer retained for
retrieval. Its preview remains part of the conversation.
_Avoid_: Expired link (a temporary access link can expire while the original remains available)

**Original delivery**:
The work that makes a shared image's original available for viewing and download.
It belongs to the shared image and can continue after the generating turn ends.
_Avoid_: Image generation, image publication

### Session collaboration

**Conversation**:
An exchange shared by its participants, such as a channel thread, a direct message,
or an exchange between agents. It belongs to its participants, not to any one agent.
_Avoid_: Session (when meaning the shared exchange)

**Session**:
One agent's private context, either in one conversation or in work the agent started
on its own schedule. A conversation with two agents has two sessions.
_Avoid_: Conversation, thread (when meaning the agent's private context)

**Task**:
Work that runs in the background in its own context and belongs to one session, the one it
reports to: a delegated task, a follow-up, or an approved proposal. Lists, limits, and permission
requests that cover all three use this name. A task has no conversation of its own.
_Avoid_: Background work, sub-session, background session, runtime job

**Delegated task**:
A task one session hands off with `delegateTask`. It runs for one or more rounds, does not
control other tasks, and returns each round's result to the session that delegated it.
_Avoid_: Sub-session, subagent, child session, started task

**Owning session**:
The session a task belongs to. For a delegated task it is the session that delegated it: only
it can message or stop the task, and the task's results return to it. The relationship lasts
across rounds of work. A follow-up belongs to its place instead: its owning session is that
place's current long session, the new one after `!new`.
_Avoid_: Parent, sub-session parent, most recent caller

**Follow-up**:
An assistant-mode agent's read-only task of the place it was taken in, which it takes with
`followUp` once the person confirms. Each round is a **check**, run in the follow-up's one retained
context when its next check comes due or its place messages it; a check reports, proposes, or
stays silent. It is addressed by `taskId` and lasts until it is done or stopped.
_Avoid_: Item, patrol, ledger

**Approved proposal**:
As a task, the run an approved proposal carries out, once, with the agent's own permissions,
reporting to the conversation the proposal belongs to.
_Avoid_: Approved work, approved task, sub-session

**This turn's tasks**:
What the agent's runtime itself reports for the current turn, such as a long shell command
running in the background or one of the runtime's own subagents. AgentConnect only shows them;
they are not tasks of the session and cannot be messaged or stopped from AgentConnect.
_Avoid_: Runtime jobs, background work, delegated task

**Session message**:
One input that one session sends another: a call, a task instruction, a reply, or a task's
report. It has its own id and records which session and agent sent it.
_Avoid_: Platform message, post (a person's message or a post is not a session message)

**Reply**:
An answer to one session message, addressed by that message's id and delivered only to the
session that sent it. A message may be answered more than once.
_Avoid_: Reply to a session, broadcast

**Origin session**:
The session from which another session was created, if any. It records creation only; it
neither authorizes nor addresses replies.
_Avoid_: Parent session, reply address, sole caller

**Reply obligation**:
The expectation that a particular session message will receive an outcome in the session
that sent it. Answering one message does not satisfy another, even from the same sender.
_Avoid_: Session ownership, broadcast subscription
