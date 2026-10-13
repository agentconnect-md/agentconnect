# Product conventions

This document records user-facing product behavior that implementations must preserve.
Architecture and protocol details belong in [`designs/`](designs/); this document is
the source of truth for cross-cutting product conventions.

## Webchat reply boundaries

Each agent message shown as a separate block while streaming remains a separate block
in conversation history. A transcript refresh replaces a live block only after its
saved reply is available; saving a prompt alone must not hide an unfinished reply.
A completed turn with no text reply retires its live work on the next transcript
refresh after its prompt has been saved and all stream lanes finish.

## User-facing language

User-facing UI copy must describe concepts, actions, and outcomes that matter to the
user, not AgentConnect's internal architecture. Internal component names such as `CP`,
`Control Plane`, and `Relay` must not appear in labels, help text, settings descriptions,
empty states, toasts, or error messages. Rewrite the copy around what the user can do or
needs to know; if an implementation detail does not change either, omit it. Technical
component names belong in logs, developer tooling, and architecture documentation.

Visibility controls use audience language: show **Everyone** for the internal `org`
value, never **Org** or "org-visible". Keep **Organization** only when the copy is
actually about organization management, membership, or ownership.

## Team visibility always has an audience

Every Agent, Daemon, scheduled task, MCP provider, skill source, and Decision set to
**Selected** has at least one current organization member who can see it. The
selected-member list records explicit sharing. Organization Owners can also view,
edit, and re-share every resource in their organization; creation attribution
grants no access. Sharing controls must state the Owner exception on desktop and
mobile, and read-only access summaries include Owners alongside selected members.
Removing an Owner from the selection does not revoke their role-based access.

The Console must not add Owners to `sharedWith` merely to display this access:
explicit sharing also supplies the audience for gated DM defaults and approval
notification routing. Session audiences remain independent of the Owner exception.

The server intersects selected IDs with current organization membership and must
reject a change to **Selected** when no current member remains. This is a
transaction-time invariant, not merely a disabled Console control: a stale page
or a concurrent membership removal must not commit a resource that nobody can
reach. The Console initially selects the current user for convenience, but they
may be replaced after another member is selected. Removing an organization member
prunes them from every Selected audience and adds a deterministic current
organization owner only where the audience would otherwise become empty.

This convention governs human Console access only. The independently configured
agent-to-agent inbound and outbound policies may intentionally use **Selected**
with an empty peer list to deny peer discovery or calls.

## What people can do in chat

People choose how they use the product, and no choice may make it harder to use than it
must be. The product serves the experience first, and applies console permissions only where
it can tell who someone is.

Each agent has one setting, **What people can do in chat**. Each level includes the one
before it:

| Level                                                   | People in a conversation may                                                                                                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Talk to the agent**                                   | Talk to the agent. A tool call that needs approval goes to the agent's editors, in the console or, where the platform supports it, in their own direct messages. |
| **Talk and approve tool calls** (a new agent's default) | Also answer a tool call that the agent's permission policy asks about: allow it once, always allow that tool, or deny it.                                        |
| **Talk, approve and change settings**                   | Also change the agent's runtime settings from chat: model, effort, permission mode and fast mode.                                                                |

Who counts as "people" depends on whether the product can tell who someone is:

- **A platform whose permissions are synced with the console** (Slack or Feishu/Lark with the
  organization's session access sync on): only people whose console permissions allow the
  action, that is, the agent's editors, recognized by the account they linked under Sign-in
  methods in their console Profile: their Slack account in the app's workspace, or their
  Feishu/Lark account in the app's region. Anyone else, a guest or an editor who has not linked
  included, is refused privately, and the card stays as it is. A refused approval says only an
  Agent editor can answer it, and someone linked to no console account is told how to link one;
  it gives no console link, since the console shows that conversation only to the same people. A
  refused settings change also says where in the console an editor changes them, and tells
  someone linked to no console account how to link one. Where people may approve tool calls, a
  permission request's card also goes to an Agent editor in a direct message unless the person
  who asked is one, so a request never waits on a conversation with no editor in it; the first
  answer decides. Today that direct message is sent through the agent's Slack integration: on
  Feishu/Lark, an agent without one leaves the request to an editor in the conversation or in the
  console. When who someone is cannot be checked, because the Control Plane cannot
  be reached, the agent has more than 200 editors, or a Feishu/Lark click does not say who made
  it, the action is refused, and a refused approval says to try again in a moment. Switching the
  sync changes who may act from then on; settings already changed from chat stay.
- **A platform without that sync**: anyone who can talk to the agent in that conversation.
- **Webchat** always knows who someone is: the agent's editors, and at the second and third
  levels also the conversation's owner, even one whose role only lets them view. The owner
  answers the conversation's approvals, its background sub-sessions' included, among its pending
  requests above the composer. Anyone else who tries to change a setting there is told, on their
  own screen only, who may. A conversation started through the agent's chat API belongs to the
  API key's owner.

Every level keeps these rules:

- The setting never opens what a conversation keeps closed. A conversation switched off, or
  admitted per message by a Decision, stays closed, and a bot never answers. A closed
  conversation gets what the first level gives it, and a card posted before it closed decides
  nothing.
- In a conversation shared with another organization, an approval goes to an internal member
  instead, as an assistant-mode draft does: where people may approve tool calls, the person who
  asked, in their own direct message, when they are a full member of the installing workspace;
  otherwise the agent's editors. Where permissions are synced it goes to an Agent editor's
  direct message, the person who asked first when they are one.
- Slack, Telegram, Discord, Feishu/Lark and Google Chat post the approval card in the
  conversation the request came from: in its thread, its Telegram topic or reply chain, or at
  its top level when it is one long conversation. The card offers the runtime's own choices,
  "always allow" included where offered; a list longer than any card can show is declined with a
  notice, and nothing is allowed. Where no card is posted, the conversation gets a notice and the
  approval is answered in the console. QQ has no approval card, because its message buttons need
  a grant from QQ that a bot cannot count on: its conversation gets the notice, in a group only
  while QQ still allows a reply beside the answer, and its approvals are answered in the console.
- The first answer from any surface decides, and the request is rewritten to say who answered
  and how.
- A refusal names who can answer instead, or where to go. A refused click or tap is told only to
  the person who made it, and leaves the card as everyone else sees it: on Slack and Discord in a
  message only they see, on Telegram in an alert on the tap, on Feishu/Lark in a toast on the
  click, and on Google Chat in a private message.
- The setting does not change the agent's permission policy. Which tool calls need approval is
  set in the console, and an agent that allows every tool call never asks.

Three things are outside this setting:

- An assistant-mode patrol's proposal. Approving it is the same as asking the agent there, so
  whoever could ask there may approve it ("Assistant-mode proposals").
- Stopping a turn or a sub-session, which follows the `!stop` sender rule.
- Letting the bot join a public channel, which only a person behind the turn answers ("Joining a
  public channel").

Existing agents start where a new one does. An agent that had "Allow runtime changes in chat"
switched off, or never set, moves to the second level, and one that had it switched on moves to
the third. On a platform whose permissions are synced, both levels narrow who may act to the
agent's editors, as the rule above says. An agent that should take no answers from chat, such as
one in a public group, is set to the first level.

## Public platform app descriptions

Slack, Feishu/Lark, and Discord app or bot profiles use the fixed public description
`AI agent powered by AgentConnect.` They must never derive public profile copy from an
Agent description because that field is model context and may contain private operating
instructions.

## Planned daemon lifecycle status

A daemon reports `preparing` while it installs the target version and prepares its
sandbox image before stopping. The console keeps the daemon's actual connection status
and shows a separate `Preparing upgrade` badge; its agents remain online while it is
serving. Preparation during offline recovery must never imply that agents are online.
Once the daemon reports `restarting`, its active placed agents show `restarting` with
the paused-state color through drain and relaunch. An explicitly paused agent remains
`paused`. Operations without phase reports keep the generic `upgrading` or `restarting`
presentation. On success, failure, or expiry, the current connection status applies;
success still requires the new version to reach READY. A relaunch that has not
reconnected within the offline grace window reads as `offline`, not `restarting`, even
though its operation stays pending until the deadline. An upgrade still queued for the
daemon's next connection keeps its `upgrading` presentation.

## An unavailable agent is reported by its actual cause

A refusal must name the fault the user can act on. When a daemon owns an agent but the
agent's runtime would not start, the refusal says the agent could not start and carries
the one-line cause the daemon observed — it must not be reported as a missing or offline
daemon, which sends the user to look at infrastructure that answered correctly. "No live
daemon" is reserved for an agent that genuinely has no daemon serving it.

The cause shown to the user is bounded to one line and carries no absolute paths, so a
console reader learns what broke without learning the daemon's filesystem layout. The
full diagnostic stays in the daemon log.

A runtime that failed to start because its own installation is incomplete is repaired
and retried automatically before the agent is reported as unavailable at all.

When a runtime offers model selection but rejects an explicitly selected model, the
turn stops and reports the requested model with the runtime's detailed cause. It must
not silently run on a different model. Session metadata, usage, and reply attribution
prefer the concrete model reported during execution over a selector's `default` alias.

A runtime-reported terminal failure is a failed turn even when its prompt response says
`end_turn`. When the runtime explicitly offers a retry and no tool or answer has started,
the daemon retries once after five seconds within the same admitted task. A review keeps
its original review authority throughout that retry. A second failure, a failure after
work began, or a failure requiring user action is reported without another automatic attempt.

## Moving an agent from an unavailable daemon

A normal agent move is the safe default and uses a hard cutover. The current daemon
must first close admission, cancel already-admitted turns without waiting for a final
reply, and confirm that the old runtime authority has stopped. The Control Plane then
releases old session affinity and activates the new copy. Subsequent messages start a
fresh session on the target; no ACP session state is copied or replayed. When the
current daemon is offline, the agent Configuration page and placement editor must say
that safe move is unavailable and name the daemon the operator needs to bring online.
The target picker must not lead to a request that can only fail without explaining this
first.

A force reassign is disaster recovery, not another ordinary move mode. It becomes the
move's behavior only when the operator chooses an online, compatible target while the
current daemon is offline — there is no separate control to arm it. It bypasses only
confirmation from the source; target readiness, capacity, runtime, model, MCP, and
managed-skill compatibility remain mandatory. Before the operator commits, the editor
must say the move will force reassign, warn that two copies may process messages if the
source machine is in fact still running, and label the commit action as a force
reassign rather than a plain move.

Both paths preserve the Agent identity and its centrally managed settings. Neither
copies daemon-local workspace, transcripts, or attachments. Managed memory follows the
agent only when its home is the Control Plane (`memory.home: control-plane`); a
daemon-home tree stays in the source archive, and a move onto a group or the managed
pool is refused until the home is switched to the Control Plane (the only direction
that carries memory; forcing it back starts the agent empty). An agent placed on a
group or the pool always keeps managed memory in the Control Plane, because any member
may serve it; an agent pinned to one daemon keeps the daemon default. An unplaced agent
has no tree to lose, so placing it on a group or the pool switches its home to the
Control Plane in the same write, without a migration. A source that later
reconnects after a force reassign is told to detach the stale local copy during
placement reconciliation.

Historical session content remains owned by the daemon that created the session. The
move itself neither copies nor replays that content, and the target never loads it as
conversation context. Read-only transcript and tool-detail requests may still use the
recorded source daemon while it is online. A webchat session cannot resume after its
Agent moves because the ACP state did not move with it; the Console keeps any readable
transcript but replaces the composer with a disabled explanation. In a multi-Agent
webchat conversation, every participating Agent must still be on the daemon that owns
its corresponding session or the shared composer is disabled.

The same placement gate applies to **continuing an integration-origin session from the
console** (webchat-cross-integration-continuation.md): the composer appears only while
the owning Agent is still on the session's daemon and the deployment supports
continuation. Continuing a platform session from the console **posts the human input to the origin
thread before dispatch**, under the console user's own name and avatar where the platform
renders a per-message identity (Slack), and as `[<user> via console] …` elsewhere; the agent
reply keeps the session's existing output mode, and agents already participating in the
origin thread receive the mirror under its ordinary routing rules. The session remains
the single source of truth; console and platform are both projections of it.

A **hook-origin session** — one a GitHub or GitLab event or a generic webhook started —
is continued the same way, with one difference the user can see: there is no chat thread
on the other side, so nothing is mirrored. The console is that session's
only human surface. Neither the typed message nor the agent's reply appears on the pull
request, the issue, or anywhere else the trigger came from; both are ordinary session
history, readable in the console and carried into the agent's context like any other turn.
An agent that has a code-host tool can still act on the subject, as it could in any turn.

A **multi-agent hook-origin conversation**, such as a pull request that several agents
worked on, is continued as a whole from its merged conversation page:

- A message goes to the members it @-mentions.
- A message that mentions nobody goes to every member that can continue.
- Each addressed member receives the message in its own session.
- A member the message does not address receives no copy.
- The message appears once in the merged transcript.

A chat-origin multi-agent conversation still continues one member at a time, because
each continued message is mirrored into the chat thread, and a single message must
not be posted there once per member.

## Where a streamed reply may be split

A long reply may be delivered as more than one chat message, but a split must always fall
on a boundary the reader can see. The streaming transport's own rhythm is not such a
boundary: model output arrives in token-sized pieces, so a pause in the stream routinely
lands mid-sentence or mid-word, and cutting there splits one answer across two messages at
a meaningless point.

So a split driven by elapsed time may only happen at a paragraph break outside a fenced
code block; text after the last such break stays buffered until more arrives, until the
agent finishes the text block (a new tool call, a plan, a thinking step), or until the turn
ends. Splits the reader already expects — a completed text block before the agent starts
working, or a body longer than the platform's per-message limit — are unaffected.

Output and status updates for an already known tool, including background shell output,
do not finish the current text block or postpone a pending text flush. A tool first seen
through an update still starts a new work block.

A Markdown reference can depend on a link definition near the end of the same text
block. Once a paragraph contains a reference, a definition, or bracketed text that could
become a reference, it and the following text stay together until the agent finishes that
text block. Earlier paragraphs continue streaming normally, including in live previews,
so an incomplete link definition cannot expose a local file target before it is resolved.

File links in agent replies open the Console viewer for the replying Agent's workspace
and session. Relative paths resolve from the runtime's working directory, including a
configured subdirectory or an authorized additional repository. Isolated sessions keep
their own checkout in the link; an unavailable or purged checkout must never fall back
to a same-named file in the primary workspace. The viewer requires the reader's usual
Agent, session, and repository access. The URL contains only workspace-relative paths.

Inline links, reference-style links, and workspace image references use the same file
viewer. Line or column citations open the file without a line jump. Ordinary web links
stay unchanged, and code-host replies retain repository-relative links. Targets outside
the known workspaces keep the readable text fallback, with host paths reduced to their
file names. Webchat holds link-bearing text until its logical message is complete so its
live reply and saved transcript use the same destination.

## Session startup shows what the turn is waiting for

Before an agent can respond, its turn may need to wait for the agent to restart after a
settings change, start a sandbox, prepare a workspace, clone a repository, and start or
resume its runtime session. Each real wait updates one
startup notice. Stages that do not run are skipped, including sandbox startup when the
current session's own sandbox is already bound. Git clone has its own label within
workspace preparation; checkout and skills installation use the workspace label.

The console replaces one live wait line below the agent's name. Slack keeps its native
working indicator: its lifecycle API accepts a state, not phase text. Other chat
platforms post no startup message, because it would stay in the conversation's history
even when the turn ends silently; their typing indicator is the only wait signal. Google
Chat has none, so its wait signal is the turn's placeholder (see "A trigger is
acknowledged before it is answered"), which names no phase and never outlives the turn. A
code-host turn adds no startup comment. Status publication is best-effort and never
holds up initialization.

Startup notices are not recorded in the AgentConnect transcript. On success or
cancellation, the console clears the wait. A failed console turn may retain its last
phase beside the error. Standing notices, such as an unavailable approval, survive
startup updates and clearing.

Each observer belongs to its turn. Turns joining a shared host start see its current
phase, and a cancelled or displaced turn cannot publish late updates into its successor.

A Decision-driven chat shows **By decision** before the first message and **Pending**
after submission until its runtime and model are reported. The composer and session
details must not present the configured fallback as a completed selection. Effort and
permission controls appear only after the runtime is known; an explicit manual
runtime/model choice remains visible immediately.

## A settings change does not cut a running answer

Changing an agent setting that needs a fresh agent process — its model, reasoning
effort, modes, runtime, environment, secrets, skills, memory, or description — applies
from the next turn. A turn already running finishes first; a message that would start
on the old process waits, showing that the agent is restarting, and then runs with the
new settings. Where each session has its own process, other sessions start at once.

The wait is bounded. A turn still running at the limit, or one still starting when the
change lands, is stopped and its message runs again on the new process, and the
conversation is told that the message will be picked up again. A console turn cannot be
re-run and is told to send its message again. A daemon restart that stops a turn tells
the conversation the same way. A workspace change still stops running turns at once,
with a notice to send the message again.

## A trigger is acknowledged before it is answered

An agent's answer arrives late by nature: a turn boots a session, runs tools, and
only then writes. Until it does, whoever mentioned the agent has no way to tell
"working on it" from "never saw it" — and the surfaces differ in how much silence
they leave. Telegram has a typing hint that expires on its own, a message in a
channel has nothing, and an issue or pull request has nothing at all until one
comment appears at the very end.

So every turn with a real inbound message is acknowledged as it starts, and the
default form of that acknowledgement is a 👀 reaction on the exact message that
fired the turn — the comment a human wrote, not the thread it sits in and not the
issue that contains it — and on the issue or pull request itself only when the
subject is what fired. One rule across chat platforms and code hosts.

Slack is the one surface with a durable indicator of its own: the agent-session
lifecycle marks the thread "is working…", with a Stop control, for the whole turn
and withdraws it when the turn ends. Where Slack confirms it took that write, the
indicator **is** the acknowledgement and no reaction is placed — one signal instead
of two, and nothing left on the message once the answer has superseded it, which
matters in workspaces where 👀 already carries a meaning between people. Only when
the write is refused — the app lacks the scope, the API fails, the turn shows no
indicator — does the reaction fall back in, so a Slack turn never shows neither.
A typing hint is not an indicator in this sense: it acknowledges nothing, so
Telegram and Discord react as before.

Google Chat has neither: an app can react only with user authentication, and it has
no typing indicator. There the acknowledgement is one placeholder message in the
turn's conversation, posted only once the turn has shown nothing for two seconds, and
it becomes the answer — the first text, or a failure notice, replaces it in place.
Unlike a reaction it is swapped for the outcome, because a "working on it" line must
not outlive the work: a turn that ends silently on purpose, or is cancelled, withdraws
it; one that ends with no text says in its place that it finished without a reply; and
a turn cut to run again leaves it for that run to take over. A turn that answers within
two seconds never shows one.

The reaction is an acknowledgement, not a status: it is placed once and never
taken back or swapped for an outcome. That is deliberate — it records that the
turn was seen, which stays true whether the turn answers, is interrupted, or dies
with nothing to say, and a reader who returns later can still tell a message that
was picked up from one that was never routed. The answer itself supersedes it.

It is also chrome, never content. Nothing waits on it, a platform that cannot
react (or an installation that was never granted permission to) simply shows
nothing and the turn is unaffected, and origins with no inbound message to point
at — a schedule, another agent's wake, a session opened in the console — do not
acknowledge anything.

## A message sent during a running turn steers that turn

Someone who writes to an agent while it is still working is usually correcting or
adding to the work in progress, not opening a second request. When the agent's
runtime supports mid-turn steering (both managed runtimes, Claude and Codex, do),
the message is delivered into the running turn: the agent reads it as it works,
and the answer it is already streaming continues in place. There is no second turn,
no second answer, and the message is never re-asked once the turn ends.

The visible acknowledgement follows the delivery, not the queue. A surface that
would have said "queued behind the current task" says the message was added to the
running task instead. In the console, a message typed while a steerable turn
streams leaves the composer at once and appears in the conversation. Until the runtime
confirms it took the message, the reply keeps streaming in the block above it; once the
message is marked as steered into the running reply, the reply that follows it continues
in a fresh block below it. Only when the runtime cannot take it does the message wait in
the composer's queue, where it can still be cancelled. The running turn's own status and
reactions are unchanged.

Steering is for ordinary human messages on chat platforms and the console. The
explicit `!queue` command still parks its text until the agent is idle; scheduled
wakes, code-host events, and agent-to-agent calls always run as their own turns.
When the runtime cannot steer — it lacks the capability, it declined because the
turn was ending as the message arrived, the per-turn steering budget is spent, or
the operator turned the `sessionSteering` feature off — the message waits behind
the turn exactly as before. `!cancel` remains the way to abandon the work in
progress rather than redirect it.

## Slack message attribution footer

The attribution footer for an agent response must be attached to the final Slack
message containing that response. It must never be posted as a separate Slack message.

For example, a footer can render as:

```text
sent by <https://app.example.com/acme/agents/agent-id|agent-name> (Codex · model-name) · <https://app.example.com/acme/sessions/session-id|open in session>
```

If a response is split across multiple Slack messages, attach the footer only to the
last message. If streaming, retries, or later output change which message is last, move
or re-anchor the footer so it remains attached to the latest response message without
leaving a stale footer on an earlier message.

## Slack multi-agent mention routing

An explicit Slack mention wakes only the AgentConnect agent represented by that bot.
When a daemon receives a thread message containing mentions but none matches one of its
local agents, it must not fall back to thread affinity. It may retain the message for
later transcript catch-up, but it must not start a model turn. Thread affinity applies
only to follow-ups with no explicit mention.

A third-party Slack app or bot may wake an AgentConnect agent only by explicitly
mentioning that agent's bot. It must not enter through DM, thread-affinity, keyword, or
auto ("every message") routing.

### Addressing someone in the conversation you are already in

An agent that wants to reach an agent or a human **in its current thread** writes an
ordinary turn reply containing that recipient's platform-native `@mention`. It does not
call `sendMessage`. The ordinary reply already has the right channel, thread, transport
scope, streaming lifecycle, and sender identity; a second sending tool would only create
a competing delivery path into the same conversation. `listAgents`, when scoped to a
channel, returns each peer's exact `mention` token so the agent never has to guess an
address from a display name.

A finalized platform message authored by an AgentConnect agent takes the **same routing
ladder as any other message**, with the author removed from the candidate set:

- **a thread is a conversation: everyone in it hears what is said.** Once an agent is
  part of a thread, every later message reaches it — from a person or from another
  agent — without needing to name it again;
- **an `@mention` is how an agent JOINS a thread**, whether in the first message or
  halfway through. That is what a mention does; it is not a per-message address. An
  agent set to `auto` in a channel is already part of every conversation there;
- so agents do **not** need to name each other to keep talking, and naming someone
  does not narrow delivery — it only adds whoever was named;
- each participant is an independent delivery with its own session and its own `!stop`.
  A participant you stopped stays stopped, and still records the conversation for
  catch-up;
- **an ordinary reply never targets its author.** An agent's own reply always matches its
  own rule, so routing provider echoes back to the author would be unconditional rather
  than merely loop-prone. The explicit `toAgent` channel-root form below is the bounded
  exception: its one paired internal wake activates the new child exactly once;
- agent-authored text cannot issue control commands (`!stop`, `!resume`, configuration
  actions);
- a third-party bot is unchanged: where supported, it may activate an agent only through
  an explicit mention.

**What this means in a shared channel.** A multi-agent conversation now ends because it
reaches a limit, not because an agent stops addressing anyone. The agent-to-agent hop cap
and the durable loop guard are the ordinary stopping conditions. With dedicated bots the
effect compounds — each app receives the same channel event on its own connection, so one
agent message can wake every other agent present. If you want several agents in a channel
without them talking continuously, prefer @-mention addressing over the "every message"
trigger; the loop guard is a latch, and clearing it takes an explicit `!resume`.

`!stop` remains the direct control over a running exchange, and it applies to agents the
same way it applies to people: while a thread is stopped, an agent's reply is recorded but
wakes nobody. Clearing a stop is a **human** act — an `@mention` from a person, or
`!resume`. Agents talking among themselves cannot reopen a conversation you stopped.

Only the **final** message of a logical response routes. Replies are streamed, so an
earlier physical message may hold a prefix of the answer; the daemon marks exactly one
event final at turn end and carries the recipients resolved from the complete response,
so the recipients of a paired agent call are resolved from the whole answer, not from
whichever section happened to close it.

Activation requires a **verified** author: an authentic provider event, a sending app
that belongs to AgentConnect in this organization and conversation, a claimed author that
app actually backs there, a usable trusted hop depth, and an author-to-target edge that
passes current policy. Anything short of that is recorded in the transcript and routed to
nobody — in particular a shared bot that cannot prove an exact agent author fails closed,
because its platform identity stands for more than one agent.

Every agent-to-agent delivery — internal call or platform mention, same daemon or across
a relay — spends exactly one hop from the same shared budget, so a mention chain cannot
outlive the limit an internal call chain gets.

The hop limit is an exclusive delivery boundary: a candidate delivery whose depth is
greater than or equal to the configured cap is not admitted. The preceding agent reply
is therefore the last visible response in the autonomous exchange. When reply footers
are enabled, that final response's footer says that the agent conversation stopped after
reaching the hop limit; the warning follows the platform's existing footer placement and
is never posted as a separate Slack message.

### What `sendMessage` is for

`sendMessage` covers what the ordinary reply cannot do: a different conversation, a
direct message, a postless agent call, an update in a thread the agent is not answering,
or a reply into the parent session. Every visible send lands at the channel **root**
except the update form, which is the one branch that names an existing thread:

- `toAgent` **direct form** (`{"toAgent":"<agent id>","message":"..."}`, no `channel`) —
  a postless wake: nothing is posted to any channel and nothing is recorded in a shared
  transcript, so this coordination never appears as channel history. The child session is
  headless, and its coordinates are derived from the trusted caller session rather than
  from a channel the model named.
- `toAgent` **channel-root form** (`toAgent` + `channel`) — the daemon authorizes the
  target, renders its platform-native mention into the body, posts one visible message at
  the channel root, and anchors the woken agent's session to that post. The internal wake
  and the visible post are two observations of one delivery: they meet at a durable
  rendezvous keyed by the post, so the target is admitted exactly once in either arrival
  order, and the visible message and the direct delivery collapse to a single transcript
  row. A pairing whose internal call envelope never arrives is recorded as a delivery
  failure — never turned into a lineage-less child session.
- `toUser` — reach humans (Slack only for now): dm (`{"toUser":"<id>","message":"..."}`
  without `channel`, a direct message to exactly one person) or channel root (`toUser` +
  `channel`, one visible post at the root that @-mentions every listed person). The
  channel form accepts either one id or a non-empty array of unique ids such as
  `"toUser":["U1","U2"]`; an array never means group DM.
- `channel` **bare post** (`{"channel":"<channel id>","message":"..."}`, optionally
  `platform`) — publishes a visible message at the channel root without waking an agent
  or addressing a human, as in case 2a / case 3. It wakes nobody because the thread it
  creates has no participants yet, not because root posts are exempt from routing.
- `channel` + `thread` **update** (`{"channel":"<channel id>","thread":"<root id>","message":"..."}`)
  — places a message in an EXISTING conversation the agent is not answering, so an agent
  can act everywhere it can already read: the status update for a request crossposted to
  three channels belongs in each of those threads, not at three channel roots. It routes
  like any other agent-authored message (the thread's participants, author excluded),
  inherits the posting turn's hop rather than starting a fresh chain, obeys the thread's
  `!stop` mute without being able to lift it, and joins the author to that thread —
  seeding a session there whose origin is the posting session, so a reply has a parent to
  resume. A non-root thread, a platform that cannot address one, and the caller's own
  thread are refused rather than posted at the root. See
  [send-message-routing-rework.md](designs/send-message-routing-rework.md) §2.4.

Where a post may go, and when it waits for approval instead, is in "Writing to other
conversations".

The visible post is suppressed when the wake would be refused for a locally-decidable
reason (capability disabled, invalid target id, a postless self-call, hop limit, or a local target that
disallows the caller), so a rejected hand-off leaves no misleading post. One accepted
best-effort edge: a target on another daemon whose call policy terminally rejects the
caller can still leave a visible post, because that policy verdict is only known on the
target's daemon after the post is made.

### Sharing a produced file into the current conversation

`shareFile` posts an image from the agent's workspace into the conversation the agent is
answering — the one visible send that is not `sendMessage`'s job, since every `sendMessage`
post lands at a channel root. The model supplies only a workspace-relative path and an
optional plain-text caption; every coordinate comes from the trusted active turn, so the
image lands in the thread that asked, threaded the way that platform threads (Slack
`thread_ts`, Telegram reply placement, Discord thread channel, Feishu topic root — which is
refused rather than repurposed when it cannot be honored).

Images only — PNG, JPEG, or WEBP, decided from the file bytes, never the file name — and
the posted filename and type come from those bytes too. A GIF is refused by name. The file
is capped per send and per turn; failures name their rule. A headless turn, a postless
agent-call session, and a platform that cannot host files are refused before any file is
read. Captions are bounded, carried as one message, and have their mention syntax
neutralized — Slack/Discord control tokens, Feishu `<at>` tags, and the broadcast words; a
bare Telegram `@username` is the one form with no inert spelling and may still notify. A
caption labels a file; it must not page anyone.

The share never seeds or re-anchors a session — the thread already has one — and it posts
when called, so the image may appear before the streamed reply finishes. The transcript
records the share with its provenance (path, sniffed type, size, digest) and, when the
bytes fit the transcript budget, the image itself, so the console renders what the agent
shared exactly as it renders what a user uploaded. An upload the platform abandoned
mid-flight is reported as "may have been delivered — do not retry", never as a failure a
retry could double-post.

### Shared images in the console

In a console conversation (and a console continuation of a hook or webhook session),
`shareFile` publishes an image card under the agent's name instead of uploading to a
platform; an IM session continued from the console still delivers through its own
platform. The card shows a bounded preview, an optional caption, **View original** and
**Download**. Several images are several calls, and a reply that is only an image is a
complete answer. Text streamed before the image stays above the card; text after it starts
a new message. Reloading keeps the card as its own message, with its own identity, in
every open tab.

The card appears once its preview is saved, without waiting for the original:

- An image within the 160 KiB preview limit is its own original and needs no further
  request to view or download.
- A larger image gets a generated preview within that limit. With a transfer cache
  configured, its unchanged original uploads in the background and the card moves from
  **Uploading original…** to ready; a failed upload shows **Original upload failed** and
  never removes the preview or asks the agent to share again. An original whose cache
  object is gone shows **Original expired**, and a pending upload the daemon no longer
  runs shows **Original unavailable**. Without a transfer cache, the original stays in the
  workspace and downloads through the authenticated, digest-checked workspace download.
- **View original** and **Download** always target the original bytes and file name,
  never the preview. A failure leaves the preview visible.

PNG, JPEG, WEBP and self-contained static SVG are accepted; an oversized SVG gets a PNG
preview while its original stays SVG, and SVG only ever renders as an image, never as
live markup. The agent receives a short receipt — never the image bytes or a download
link — and is told not to repeat the image as Markdown. Peers in a multi-agent
conversation see the caption and card as transcript only; a shared image never wakes
another agent or feeds its pixels to another agent's model.

### Forwarding a received file

A `toUser` or bare-`channel` send may carry `attachment`, naming a file **this
conversation received** exactly as the agent's `[attached: …]` marker spells it. This is
the only way a shared image reaches another platform: an agent can describe what it saw,
but it cannot produce the bytes, and no send accepts model-supplied file content.

The daemon resolves the name against its own transcript for the caller's conversation, so
an agent can forward only what was delivered to it, and the bytes never pass through the
model. It forwards the bounded copy already retained for console replay rather than
re-fetching the original, so a forwarded image can be smaller than the one that arrived.

**Only that retained copy is forwardable — one image per message.** The `[attached: …]`
marker lists every file on a message, but a document, a second image on the same message,
and an image too large to retain have no bytes to forward. Naming one is refused as _not
forwardable_ rather than as an unknown name, because the agent read the name correctly and
would otherwise retry it.

A file share is its own message on the receiving platform, not a decorated text post: the
send's `message` becomes the file's caption, and each platform sends it the way that
platform shows a file — an image previews inline where the platform can do that, and a
caption too long for the platform's limit becomes its own message instead of being
truncated.

Such a send anchors like any other channel-root post, and so seeds a session, wherever the
platform answers with the message it created. Slack is the exception: its file share
returns the file and no message id, so a Slack forward anchors nothing and seeds no
session. Nothing else depends on which case applies — the send degrades to the same
behaviour as a post whose id never came back.

An unresolvable name, a target platform that cannot host files, or a share that posted
nothing fails the whole send rather than reporting an image as sent.

One caption limitation is worth stating because it contradicts the rest of the product: on
Slack a forwarded caption is **mrkdwn**, not the CommonMark every other message is written
in, so `**bold**` and `[label](url)` read literally there. Slack's file share ignores rich
blocks whenever a comment is supplied and offers no separate notification text, so the
alternative would cost every forwarded file its notification preview.

Where a platform cannot carry a file and its caption as one message it sends two, and it
sends the **file first** — so a failure before anything lands really did land nothing, and
a caption lost after it is reported as a notice on an otherwise successful send rather than
as a failure. The agent is never told nothing was sent while its words sit in the
conversation, because it would retry and post them twice.

## Self-authored channel roots

When an agent uses `sendMessage` to publish a new channel-root message without waking
another agent (a bare `channel` post — the only post that does not wake a peer), the
returned platform message creates the agent's session for that new thread but does not run
a model turn. The root is already the agent's own output, not a new request: treating it
as an activation can make the agent post it again recursively.

On Discord, publishing that root must immediately open a native thread from the posted
message. The initialized session uses `{channel: parent channel, thread: created thread}`;
it must never use the parent channel itself as the thread-affinity key. If Discord cannot
create the thread, the post remains visible but no follow-up session is initialized.

The session starts idle, retains its parent-session lineage, and records the root for
transcript display. The first real reply in that thread receives the root as preceding
context before the new message. Session initialization itself produces no agent output,
tool calls, memory recall or capture, turn evaluation, or token usage.

When the post instead carries `toAgent`, it is an explicit activation even when the
target is the posting agent itself. The visible root and internal wake remain one paired
delivery, so the new child runs exactly once; the platform's echo is only the second
observation of that delivery. A postless self-call remains invalid because it has no new
conversation boundary and can recurse without producing a user-visible hand-off. The one
exception is an agent in assistant mode, whose postless self-call opens a background
sub-session (see "Assistant-mode sub-sessions").

## A parent-session reply is injected, and the parent answers normally

`sendMessage({"sessionId":"<parent>", …})` injects an answer into the session that woke
the caller. What is invisible is the **report itself**: no component publishes the
injected body to a platform, so relaying an answer upward is a hand-off rather than a
broadcast.

The parent session is then resumed as an **ordinary turn** — it keeps its reply sink and
chrome, so what the parent decides to say lands in the parent's own conversation, where
the humans who delegated the work are waiting. Delegated work that reports back is
therefore visible to them, which is the point of reporting back at all.

The parent should not restate what its conversation already shows; that is the standing
"be quiet about mechanics" rule, not a transport guarantee. An earlier revision muted the
resumed turn to enforce it, and that silenced every report whose child had answered
somewhere else (its own channel-root thread) or nowhere at all (a postless child).

A reply whose parent lives on another daemon behaves identically. If that daemon is too
old to understand the delivery kind, the reply **fails** rather than being dispatched into
the wrong session.

## Per-conversation trigger

Every conversation a bot is in carries a trigger. Channels and group DMs expose all
three settings — Off, every message, or @-mention (the default); a 1:1 DM presents the
equivalent compact Off / On control. Off is not a gating feature: an org-visible agent
is entitled to the same control as a restricted one.

Off means the agent does not respond in that conversation at all. Not to an @-mention, not to
a follow-up in a thread it had already joined, not to a control command, and not through
a shared bot's slug or default-dispatch fallback. It leaves everything else intact: the
bot stays in the conversation, the conversation keeps its row and its owner, past sessions keep
their transcripts, and an agent may still post there when something else — a scheduled
task, another agent's hand-off — directs it to.

Off is therefore the Console's answer to "stop responding here" while the bot stays put.
Actually removing it is a separate action — see "Leaving a conversation and removing its
row".

A restricted agent expresses the same choice through its conversation gate, which is
independently fail-closed: a conversation it has never been enabled in stays unroutable
whether or not anyone set it to Off.

Those two states read alike on the row and mean different things, so they answer an
@-mention differently. A conversation a restricted agent was never enabled in replies
once, telling the person to ask an admin — the bot must not look broken to someone who
had no way to know it was private. A channel switched Off says nothing at all: an
operator already decided, and pointing the room at an admin would be both wrong and
noise. Off is silence; the gate is a closed door with a sign on it.

A place the platform marks as shared outside the organization (a Slack Connect channel)
starts Off for every agent, because "Everyone" means the organization
([resource-visibility.md](designs/resource-visibility.md) §14.9, with the detection in
[assistant-mode.md](designs/assistant-mode.md) §5.3). Nobody chose that Off, so it is the
closed door with a sign, not silence, until an editor picks a trigger for the row.

The same holds for any Off nobody chose, for every agent, external or not: a conversation seeded
Off while its agent was restricted, or while assistant mode gated it, answers an addressed message
once with the sign. An Off from before the console recorded who chose a trigger reads as nobody's,
so an operator's Off from that time may answer once too; nothing is migrated.

## Leaving a conversation and removing its row

Three different things can end a conversation, and the Console must not blur them:

- **Off** — the bot stays and goes quiet. Reversible in one click.
- **Leave** — the bot is removed at the platform, and the row goes with it. Undoing it
  means re-inviting.
- **Remove from this list** — the row stops being listed. Nothing outside AgentConnect
  changes.

A row offers exactly ONE of the last two: the strongest the platform allows. Where the
bot can be made to leave, Leave is the only choice on offer, because it already does
everything removing the row does; presenting both would ask an operator to choose
between two outcomes that differ only in reach, at the moment they least want a
taxonomy. Where the bot cannot be made to leave, removing the row is the only choice,
and its own wording carries the rest of the answer — that the bot is still in there and
has to be shown out in the chat app.

A direct conversation is the exception on both counts. Nobody is invited to one, so
there is no membership to end and nothing to point the operator at; removing the row
there is only ever removing a listing, and it says exactly that.

That collapse puts a requirement on Leave. On a leave-capable platform a row has no
second escape hatch, so Leave must also succeed when the bot is ALREADY out — the stale
row left behind by someone removing the bot in the chat app is the very case these
controls exist for, and a refusal there would strand an operator with a row they can
see and cannot clear. A platform saying "not a member" therefore completes the Leave;
any other refusal is still reported.

Removing the row exists because departure is not always observable. Only Slack reports
its own membership authoritatively; a Telegram, Discord, or Lark report can only ever
add, so a conversation the bot has already left would otherwise be listed forever with
no way to clear it. It follows that a removed row REAPPEARS on the next authoritative
listing if the bot is in fact still a member — which is the correct answer to "why did
it come back", not a bug: it never left, and removing a row never claimed to make it.

Ending a listing must OUTLAST the reporting that produced it. On a platform that cannot
enumerate, the conversation list is derived from session history, and leaving a
conversation does not erase the sessions held in it — so both actions are remembered
durably at the edge, or the next refresh would rebuild the row from that history and
quietly undo the operator. The suppression lifts when the conversation
sends a message again: a platform only delivers those for a conversation the bot is
actually in, so traffic is proof it was re-invited, and that is how re-inviting undoes
a Leave without anyone having to find a button for it.

What Leave can mean differs by platform, and the difference is real rather than
cosmetic. Telegram can withdraw from one conversation. A Discord bot has no
per-channel membership at all — it joins a server and sees that server's channels
through permissions — so the smallest thing it can leave is the whole server, taking
every channel of it along. That action therefore belongs to the server, is confirmed
as such, and is never offered on a channel row as though it were smaller than it is —
which makes a Discord channel row one that cannot leave, so it offers removing the row
and points at the server for the rest.

Slack is deliberately in that last group even though its API could leave a channel.
Doing so requires a scope that also grants creating, archiving, renaming and kicking,
and adding it would force every installed workspace to re-authorize — a steep price on
the one platform where leaving from the Console buys least, since Slack reports its own
membership authoritatively and removing the bot there clears the row unaided. The
Console says where to do it instead of offering a button it had to buy that way.

A platform's refusal is shown as the platform worded it. A missing scope, a
last-member channel, or a lost right is usually something the operator can act on, and
collapsing it into a generic failure would throw away the only useful part.

## Shared-bot conversation ownership

Every active conversation served by a shared bot has exactly one default agent. A newly
observed or ownerless conversation converges to the bot's earliest active agent, and
removing the current owner immediately transfers ownership to the earliest remaining
agent. Console surfaces must show the same effective owner and trigger from every
member agent's integration; they must not expose a `No default` state. The trigger is
replicated across every active membership row, backfilling a missing sibling, so
removing the owner does not discard the conversation or its trigger.

A Console owner change preserves the conversation's trigger. An in-Slack owner change
or automatic fallback to a restricted agent instead leaves the conversation Off,
because only an authorized Console editor may enable it. This same owner boundary
applies to observed 1:1 and group DMs; classic integrations remain per-agent.

## Slack Home tab

Every AgentConnect Slack app offers a Home tab with public getting-started guidance,
organization and agent configuration links, and documentation, support, and privacy links.
This includes custom agents: the page belongs to the Slack app, so agents sharing
one bot also share one Home tab. When the app serves one agent, its configuration
button opens that agent's Config tab. Shared HTTP apps use the visiting user's DM
route when available; without an unambiguous target, the button opens the organization's
agents list. Older assignments without an organization slug retain the generic console
entry point. The view never lists private agent names, configuration, organization
membership, or conversation history. Console access remains subject to the console's
normal authentication and authorization.

An HTTP Slack installation keeps serving Home after its last agent is disconnected.
Home then explains that no agent is connected and offers **Reconnect**, which opens
a focused dialog with the app and organization fixed. When the organization's
editable built-in agent is available, a built-in app targets it automatically;
other reconnections ask for an agent without preselecting the first one. Reconnecting
does not require another Slack authorization while the installation's token remains
valid, and does not enable sharing. A bound agent with no available daemon is not
shown as disconnected. Uninstalling the app in Slack or revoking its token stops
ingress; deleting the saved bot or its organization still deletes its credentials.

The distributed app can also be installed before an AgentConnect organization is
chosen. Its public install entry is `/v1/integrations/slack/install`. The unconnected
installation serves Home with **Connect AgentConnect**, and DMs or mentions explain
how to finish setup without starting a model turn. The installing Slack user signs
in, chooses an organization they can edit and an agent they can configure, and
connects the workspace using the authorization already granted. This binding applies
to the workspace, not to individual Slack accounts. It starts with one agent and
does not enable sharing or change the agent's access and trigger settings. Reinstalling
an already connected workspace preserves its organization and agent memberships.

Home opens publish a view for the visiting Slack user without starting a model
turn, posting a message, or requiring admission to a conversation. HTTP installs
serve this page from the relay even when no daemon can receive a task; Socket
Mode serves the same view from its connection. Existing apps enable Home through
the normal manifest refresh, after the serving component is upgraded.

## Direct messages

Opening Slack's Messages tab shows a short welcome in an empty DM and two suggested
prompts only when its current agent is the built-in preset. This is application UI:
it never starts a model turn or spends credits. Existing conversations receive no
new greeting, including after a daemon restart. Custom agents and conversations
whose replies are Off or restricted without a grant receive no built-in onboarding.

Every observed direct conversation appears under **Direct messages** on the Agent's
integration card, for both Everyone and Restricted visibility. A 1:1 DM has one binary
**Off / On** control: On responds to messages in that conversation; Off is an effective
routing fence, not merely display state.

Visibility determines the initial state, not whether the control exists:

- An **Everyone** agent's newly observed 1:1 DM starts **On**, preserving the normal
  open-DM behavior while making it explicitly reversible, unless the platform marks it
  external, which starts it Off.
- A **Restricted** agent's newly observed 1:1 DM starts **Off** and remains unroutable
  until a Console editor enables it.

Direct rows are observed incrementally because platforms do not enumerate them as bot
membership. For a shared bot, the row is repeated for each install but owner and trigger
are bot-scoped, and the Console offers the same default-dispatch picker as a channel.
Removing or leaving a shared conversation clears the repeated rows together; a classic
integration still removes only its own listing.
Switching Everyone → Restricted closes every known direct row before the gated routing
configuration is pushed. Switching back keeps the stored choices; the rows stay visible
and configurable.

Who sees a DM's session in the console follows the same test as "What people can do in
chat": where the platform's permissions are synced with the console, only the person in
the DM; elsewhere, every member of the organization, so the session never goes unseen.
That person can still make it private once the console recognizes them.

## Group direct messages

A Slack multi-person DM is a conversation between people that the agent happens to sit
in, not a room addressed to the agent. It therefore follows a channel's rule, not a
DM's: the agent answers when explicitly @-mentioned, and follow-ups in a thread it has
joined need no further mention. A group DM never activates on an unmentioned message the
way a DM does.

Slack never reports a group DM as bot membership, so one is surfaced the way a DM is —
on observation, when an inbound message names the bot — and never through a membership
snapshot. It appears under **Direct messages** for both visibilities, with the same
three-way trigger as a channel:

- An **Everyone** agent's newly observed group DM starts on **@-mentions** and may be
  changed to Off or All messages.
- A **restricted** agent's group DM is surfaced as a row that starts Off and stays
  unroutable until a Console editor enables it.

A shared bot is one Slack identity, so a mention in a group DM cannot name which agent
behind it is meant. A group DM served by a shared bot therefore converges on exactly one
selected owner; its trigger is replicated to every sibling row and its route targets
that owner. Shared 1:1 DMs follow the same owner boundary, with no per-agent DM slug
fan-out.

A conversation first mistaken for a channel converts to a group DM once resolved, and
that conversion receives the visibility-appropriate group-DM default (Mention for
Everyone, Off for Restricted): the trigger it carried was not a direct-conversation
choice. The resolved classification is durable — it lives on the conversation row, not
in daemon memory, so a daemon restart that re-reports the conversation provisionally as
a channel cannot reset a later operator choice.

## Assistant-mode places

Assistant mode uses the same conversation defaults as any agent with the same visibility: an
Everyone agent's new room answers @-mentions, a member's new 1:1 DM starts On and a conversation
shared with another organization starts Off, while a Restricted agent stays gated (see
"Per-conversation trigger", "Direct messages" and "Group direct messages"). Enabling a conversation
is not what keeps the agent's other conversations out of it: a read is judged by the person asking
(see "Reading other conversations") and memory by audience (see "Memory layers"). Turning the mode
on or off changes no conversation's trigger, so one set Off stays Off, and one nobody chose still
answers an addressed message once with the sign (see "Per-conversation trigger"). The switch, its
limits and the agent's responsible user (see "Assistant-mode drafts") are in the assistant mode
panel on the agent's Configuration tab; the panel names that person and offers no choice of them.
The console's `assistant-mode` flag decides only whether the mode can be switched on: an agent
already in assistant mode keeps the switch, so it can be switched off, and keeps its Activity tab,
Sub-sessions tab and proposals in the console whatever the flag says.

Turning the mode on also sets the agent's permission mode, so background work nobody is watching
does not stop to wait for approval: a mode that asks for approval or only reads, or no mode at
all, becomes the runtime's auto mode (Claude Code's Auto, Codex's Auto review), or its full-access
mode where the runtime has no auto mode. An auto or full-access mode, Claude Code's Don't ask, and
a mode chosen in the same edit are kept, and a runtime with neither keeps its mode. This happens
whether the mode is turned on in the console or through the API, and the agent's permission mode
row shows the result with no extra text. It is a default, not a requirement: an editor may pick
another mode afterwards and it stays while the mode is on. With Manual chosen, the assistant mode
panel warns that background work will often wait for approval; while the switch is being turned
on, it warns only when the runtime keeps the mode. Turning the mode off leaves the permission mode
as it is.

Each place keeps one long session while the mode is on: every room, and a 1:1 DM
on a platform whose DMs otherwise open a session per message. A conversation gated By
decision keeps its own session mode, and a platform whose rooms never append (a Linear
team) is left as it is. A new conversation keeps that one session from its first message,
before the console lists it. The row shows `Single session` and offers no other choice; the
stored choice returns when the mode is switched off.

A room or group DM is external when the platform says people from outside the organization are
in it. On Slack that is a Slack Connect conversation, read from the membership listing and from
every event Slack delivers from the conversation, or a guest or a member of another organization
joining it, found with one user lookup per join (a person who joins several conversations at once
is looked up once). A member of another workspace of the same Enterprise Grid organization is not
from outside, and having a console account or not plays no part. Before posting something no
message from the conversation prompted, such as a scheduled run and its opening message, a report
from background work, a post from another conversation or an approval card, the agent asks Slack
whether the conversation is shared now, at most once a minute per conversation. Every agent
detects outsiders this way, in assistant mode or not, and what it found applies wherever a rule
names an external conversation. When Slack cannot answer, a post from another conversation waits
for approval as in an external place. A share is lifted once Slack no longer reports it; a guest or
an outside member never is. Slack is never asked about a 1:1 DM, which never turns external.

Every agent, in assistant mode or not, replies in an external conversation as it does anywhere
else: the reply streams under the working indicator, its other writes there go through, and a
scheduled run's opening message and a reminder there are posted, never drafted. A conversation
that turns external while the agent is answering is not interrupted. Reads there are judged by who
is asking and memory by its audience, so what to share is the person's call. Only four things
differ in an external conversation: an approval goes to an internal member (see "What people can
do in chat"), its memory is its own place layer (see "Memory layers"), a post into it from another
conversation is drafted or refused (see "Writing to other conversations"), and one newly found
starts Off (see "Per-conversation trigger"). An agent in assistant mode is also not reminded there
of its open items, since its item ledger is internal.

## Reading other conversations

Every agent, in assistant mode or not, reads another conversation (its history, a thread in it,
its reactions or bookmarks, or its own transcript there through `recall`) only when the person
asking may see that conversation. The product checks access; whether to bring the content into the
current conversation is that person's call. The conversation the agent is answering in is always
readable.

**On the asker's own platform and bot**, the platform decides:

- a public channel, for a full member of that workspace or tenant. A guest, or a member of another
  organization, reads only conversations they are in. Where the platform cannot tell a guest from a
  full member, a channel it confirms public is readable;
- a private channel or group DM, for its current members, by the platform's own member list, looked
  up when the read happens and trusted for at most a minute;
- the asker's own 1:1 DM with the agent. Another person's DM never.

**On another platform or another of the agent's bots**, and for a webchat or console user, a person
the product can identify is judged on the target platform by the chat account they linked there,
and otherwise by what the console shows them. The linked account must be in the target bot's
workspace (Slack) or region (Feishu/Lark), and is judged by the rules above as if it had asked on
that bot. The product identifies a person as a console user: a webchat or console user already is
one, and a chat member is one once they linked their account under Sign-in methods in their console
Profile. A Slack member who also linked Feishu therefore posts into a Feishu group they are in, even
one the agent has never been in.

**What the console shows** them is the agent's sessions in that conversation. A Slack member linked
to an organization member therefore reads a Telegram or Discord group, which no one can link,
whose sessions every member sees while that platform's session access sync is off. Someone on a
platform the console cannot match reads nothing beyond their own platform and bot. A webchat
conversation and a DM on any platform stay readable only by their owner, even where the console
shows them to every member.

**Who is asking:**

- the sender of the turn's message, by their platform identity, with no console link needed for
  their own platform and bot. When a turn takes in messages from several people, every one of them
  must have access;
- in webchat or a console continuation, the console user;
- in a sub-session, the person whose turn opened it (a restart forgets them, and it then reads as
  no one); in a patrol, or a task approved from a proposal, the person who asked for the item; in a
  scheduled run, the console user who last edited the schedule, else the one who created it;
- no one, for a scheduled run that records no person, a hook run, a sub-session's report, and an
  agent's message to another agent. Such a turn reads only its own conversation and the public
  channels its own bot confirms. A hook or a schedule anchored to a conversation reads that
  conversation as its own.

**What each platform can tell:** Slack all of the above; Feishu/Lark membership (by union_id) and
public groups, but not a guest from a full member; Discord a guild channel that `@everyone` can
view, and nothing per member; Telegram, which has no history reads, a group with a public
@username, for `recall`; Google Chat nothing.

A refused read answers "I can't share that here." and never says whether the conversation exists.
Someone who linked no console account is also told that reading a conversation on another platform
or bot needs their account linked under Sign-in methods in their console Profile. Content from a
private channel, a group DM, a DM or a webchat conversation comes with a note naming it, and the
agent says where it came from in one short clause when it uses it; the note never blocks anything.
`recall` lists only public conversations the person may read; a private one is read by name.

Reading a private conversation restricts nothing afterwards: the conversation that read it still
writes as "Writing to other conversations" allows, changes items and sends to other agents.

## Writing to other conversations

Every agent, in assistant mode or not, posts or writes wherever the people asking could post
themselves. The product checks access; what is posted is their call. The rule covers every platform
write aimed at a conversation: `sendMessage` to a channel, a thread or a person (`toUser`),
`scheduleMessage`, reactions, message deletion, bookmarks, canvases, lists and `createConversation`.
The conversation the agent is answering in is always writable.

- **Another conversation** is writable when every person asking may read it, as "Reading other
  conversations" decides: a private channel or group DM needs them as members, a public channel a
  full member of that workspace (not a guest or someone from another organization), and on another
  platform or another of the agent's bots the same for the chat account they linked there, else
  what the console shows them. A refusal answers "I can't post there from here." and never says
  whether the conversation exists. Where the platform can tell nothing about a conversation (Google
  Chat), only what the console shows the person is writable.
- **A direct message** (`toUser`) goes only to a member of the organization: on Slack, a full member
  of the bot's workspace, so a guest or someone from another organization is refused with that
  reason. Elsewhere the platform's own limits on whom a bot may message apply, as before.
- **Something new** (a channel or a direct conversation from `createConversation`, a canvas outside
  any conversation) is made only for a full member of that workspace, and opened only with members
  of the organization.
- **A canvas or a list** is written as a write into every conversation it is shared in, and as
  something new where the whole workspace may open it or no conversation holds it. When the platform
  cannot say where it is shared, it is not changed.
- **A conversation shared with another organization** takes a post from another conversation only as
  a draft an internal member approves (see "Assistant-mode drafts"), for every agent; any other write
  aimed at it from elsewhere is refused. An agent outside assistant mode cards the draft to the
  person who asked when they are a full member of the organization, and refuses the post otherwise.
- **A turn no person is behind** (see "Who is asking") writes only to its own conversation, which
  for a hook or a schedule anchored to a conversation is that conversation. An agent in assistant
  mode drafts a post anywhere else for its responsible user, or for its Activity view when they
  cannot be reached; every other write, and any write of another agent, is refused. A run that
  reads as a person writes as them.

The agent-to-agent forms of `sendMessage` and the parent-session reply are not platform writes; the
`toAgent` channel form keeps its own reach (on Slack, a public channel, or a private conversation
only where the agent was invoked).

## Joining a public channel

A bot joins a channel only when a person says so. When a read or a write the rules above allow needs
the bot in a public channel it has not joined, the agent asks first. Only a platform whose bot can
enter a public channel by itself asks this; today that is Slack. The tool call does not wait for the
answer: it returns at once, saying whom it asked, and the answer arrives in the conversation later.

- **Where it asks.** A card in the conversation the request came from, in the turn's thread, reads
  "Let <agent> join #channel to read it?" (or "to post there?") with **Join** and **Don't join**. A
  run that reads as a person (a schedule's, an item's, a sub-session's) asks in its own conversation
  or, when it has none, in that person's direct message, routed as a draft's approver is. A
  conversation shared with another organization gets no card naming the channel; the person's direct
  message does. A webchat conversation lists it among its pending requests, where its owner answers
  it at every level of "What people can do in chat", "Talk to the agent" included; the owner still
  sees no tool-call approval at that level.
- **Who answers.** Only a person behind the turn, whatever "What people can do in chat" allows.
  Anyone else who clicks is refused privately and the card stays as it is, and a bot never answers.
  The first valid answer decides, and the card is rewritten to "✅ Joined #channel — Name" or "Not
  joined — Name", its buttons gone. There is no "always join".
- **What happens.** Join: the bot joins, the read or post runs as the agent asked for it, and its
  result reaches the agent as a message in that conversation, starting a turn there. That turn reads
  and writes as the person who answered Join, so a request that goes on ("read #a and post a summary
  to #b") is judged for them, and a second channel the bot is not in asks them again. Don't join, or
  no answer within 10 minutes, the window an API caller has to answer the agent's question: the bot
  does not join, nothing is read or sent, and the agent is told so the same way, in a turn no person
  is behind.
- **No one to ask.** A turn no person is behind never joins, and neither does a run whose person no
  card can reach: the call fails with "the bot is not in #channel; invite it, or ask from a
  conversation".
- **A configured target.** A target an editor configured for a schedule or a hook counts as
  consent: when the run posts into it and it is a public channel the bot is not in, the bot joins it
  without asking. Only that target; any other conversation the run reaches follows the rules above.

A card still waiting when the daemon restarts is rewritten as expired once its integration
reconnects, and its conversation's agent is told that nothing was read or sent. The `toAgent` channel form asks nothing: where the bot is not in the channel, the
platform refuses its post.

## Local time

Every agent, in assistant mode or not, reasons about "now", "today" and "this Friday" in the
people's time zone, never its host's. Every turn it takes is told the current local date, weekday
and time, to the minute, with the zone's name and offset, in one line given with the turn; the
conversation's history keeps only what people wrote. The zone is the first of these that is known:

1. **The person who sent the turn's message**, in their own zone: on Slack the zone in their
   profile, looked up once per person and refreshed every six hours; in the console, their
   browser's, sent with every message; on Feishu/Lark the zone in their user record, when the
   platform returns one. Telegram, Discord and Google Chat report none.
2. **A scheduled run**: the time zone its schedule is set in.
3. **Any other turn no person sent**, such as a patrol, a task, a sub-session, a report from
   background work, or another agent's message: the person who started it, as "Reading other
   conversations" names them, and for a report or another agent's message the person behind the
   conversation it came from. Their zone comes from the same sources as in step 1: a chat
   member's profile, a console user's browser as last seen, else the profile of the chat account
   that console user linked.
4. **The zone last seen from a person in that conversation.**
5. **UTC**, and the agent is told the local zone is unknown.

A zone that cannot be read, because a lookup failed or took more than two seconds, is skipped for
the next one; the turn never fails because of it. There is no setting for it.

## Assistant-mode drafts

An agent in assistant mode posts directly in the conversation it is answering, one shared with
another organization included (see "Assistant-mode places"), and wherever "Writing to other
conversations" allows. One kind of post waits for an internal member's approval instead: a post
into an external place from elsewhere. `sendMessage` from another conversation into a conversation
shared with another organization, or one Slack could not confirm is not shared, is drafted instead
of sent; so is a post of a turn no person is behind into any conversation but its own. Its target
need not be a conversation where the agent is enabled. A forwarded file cannot be drafted and is
refused. The agent-to-agent forms and the parent-session reply are unchanged.

An agent outside assistant mode drafts only a post from elsewhere into an external place, and only
to the person who asked when they are a full member of the organization (see "Writing to other
conversations"); it has no Activity view, so the card is where its draft is decided. A reply that
was drafted in an external place before such replies were posted directly stays waiting and is
decided like any other draft.

The draft goes as a card to one internal member's direct message: the person who asked when
they are an internal member (on Slack, a full member of the installing workspace, not a guest
and not from the other organization), otherwise the agent's responsible user. A session with no
conversation of its own (a hook or cron run) goes to the responsible user. Nobody chooses the
responsible user: it is the agent's creator while they are a member of the organization who may
edit the agent, otherwise the editor who joined the organization first. When neither the person who
asked nor the responsible user can be reached in a direct message, no card is sent and the draft
waits in the agent's Activity view. The card leads with one sentence naming the
actual destination (the conversation by name, the recipient of a direct message, and the
platform when it is not the card's own) and saying it will post, identifies the conversation and
any thread, shows the exact text, and offers Approve and Discard. Only the addressed member's click
counts, re-verified like an approval DM's when the responsible user was chosen for it. An agent
editor may also decide it from the agent's Activity view (see "Assistant-mode Activity"),
including a draft no one could be reached for.

Approve posts the text unchanged, once, where it was aimed. The approved post is
recorded and threaded like any message the agent sends, so a reply to it reaches the agent; no
turn runs for it. Discard drops it. A
draft expires after 24 hours and is never posted afterwards. A post whose outcome is uncertain
(no message id came back, the connection failed mid-post, or a restart cut it short) says "not
sure this went through" on the card and is never retried. Whether a post needs approval follows
from its target, never from the model's judgment.

Runtime permission requests in an external place get no card or notice in the conversation; who
is asked instead is in "What people can do in chat". Draft cards are
delivered on Slack; when no member can be reached the draft is kept in Activity until it
expires, nothing is sent, and for a post it attempted the agent is told so.

## No-response control marker

Every agent session receives the same standing response-choice instruction, independent
of whether it is a shared channel, DM, webchat, hook, cron, or direct agent call. Direct
messages and direct agent calls are explicitly treated as addressed. When an activation
is not for the agent, it should answer with exactly the product-specific
`AC_NO_RESPONSE` marker and no other text. At turn finalization, visible platform delivery
boundaries suppress pending reply output when either the complete trimmed body is the
marker or a non-compliant model places the marker on the final standalone line after an
explanation. The latter is a recovery rule, not a prompt format to encourage; the standing
instruction still requires the marker as the first and only output so an earlier streaming
flush cannot expose explanatory text.

Matching is case-sensitive and deliberately narrow. The generic text `NO_RESPONSE` is not
reserved and must be delivered normally, including when it appears alone or in code. An
inline mention of `AC_NO_RESPONSE`, a punctuated form, a fenced example, or a marker
followed by more content is also ordinary reply text and must not be suppressed.

An explicit platform @mention is also a trusted routing fact. The daemon carries that fact
into the turn as separate system context, so an opaque raw identifier such as Slack's
`<@U…>` cannot be mistaken for another participant merely because it does not resemble the
agent's AgentConnect name. Implicit thread, keyword, and auto routes never receive that
assertion, and the original user text is not rewritten.

## Assistant-mode item ledger

An agent in assistant mode keeps a ledger of what people asked of it. It takes an item only
after restating what it will do, what counts as done and when it should be checked next, and
the person confirming. At that time a patrol checks the item (see "Assistant-mode patrols"), so
it promises a check then, never an action. When an open item already covers a request, it asks
whether to attach the request to that item instead, and the asker follows the existing item on
a yes. The ledger is visible to the whole organization: an item records who asked for what and
where it stands, never the wording of a direct message, and the agent says so when it takes an
item asked in a DM. Every conversation of the agent is reminded of the same list of open items,
except one shared with another organization, since the ledger is internal; its item tools still
answer there when asked. An agent outside assistant mode is offered no item tools.

## Assistant-mode sub-sessions

An agent in assistant mode hands long work, such as "fix this bug and open a PR", to a
background sub-session of its own: `sendMessage` with its own agent id and no `channel`.
Ordinary conversation stays in the main conversation. The main conversation says the work
has started; the sub-session runs in a session of its own, never the conversation's long
session; none of its replies is posted anywhere, and it reports back into the conversation
that opened it when it finishes or fails, which then speaks for it. One that stops without
reporting is reported as ended, at the latest about ten minutes after nothing is left running for
it, and then no longer counts toward the agent's concurrent sub-sessions. It takes that
conversation's visibility and owner, and its visibility cannot be changed on its own;
making the main conversation private still makes it private. A sub-session cannot open
sub-sessions of its own. Only the assistant-mode agent is told about this form; for every
other agent, and for every other form, a postless self-call is refused as before.

Reports follow the language of the people in the conversation they report to. The conversation
tells a sub-session which language they use; a patrol or an approved task, which sees none of
their messages, goes by its item's title and summary. The conversation then answers them in their
language whatever language a report arrived in. Fixed text on cards is not translated.

The session page of a conversation that opened sub-sessions has a Sub-sessions tab in its side
panel; no other conversation shows it.
It lists the sub-sessions that conversation opened, newest first and a page at a time, each
with its state and start. A title and a link to its own session appear only to someone who may
view that session, as in the Activity view. A delegated sub-session is titled by its task, as its
cards name it, until its runtime gives it a title. Whoever may continue a running sub-session's
session may stop it there: Stop interrupts its current turn as the composer's stop does,
mutes nothing and undoes nothing it already did, and a process its runtime started in the
background may keep running. The sub-session then reports to the conversation that it ended,
its transcript names who stopped it, and the row says whether a turn was stopped or nothing
was running. A sub-session's own session page, a patrol's included, is read-only: it shows the
transcript with no composer and no composer stop, since nothing sent from there would reach the
sub-session. An agent whose daemon cannot list one conversation's sub-sessions says to upgrade
it.

A person can also ask the conversation that opened a sub-session to stop it, on any platform:
"stop the one writing the release notes". The agent asks which one is meant only when that is not
clear, then stops it the way the console's Stop does, with the same answer: stopped, or nothing
was running, and that a process it started in the background may keep running. Its transcript
names the person who asked. Only that conversation can stop it, only on a turn a person there
started, and only for someone `!stop` accepts there; in webchat, anyone who may continue the
conversation. A sub-session of another conversation is refused in the same words as one that
does not exist. A sub-session, patrol, approved task, hook or scheduled run cannot stop one. The
agent is reminded which sub-sessions its conversation has running, by id and label, and the
reminder is refreshed on the next turn after one starts or ends. An agent outside assistant mode
has no such tool and no such reminder.

## Assistant-mode sub-session permission requests

When a background sub-session needs permission to run a tool, whether delegated or an approved
proposal's task, the request goes to the conversation the work belongs to, and the sub-session
waits; its turn is not cancelled. A patrol never asks.

- In a Slack, Telegram, Discord, Feishu/Lark or Google Chat conversation where "What people can
  do in chat" includes approving tool calls, an approval card is posted there, where its reports
  land: in the conversation's thread (on Telegram its topic or reply chain), or at its top level
  when it is one long conversation. Anyone there may answer it; where permissions are synced
  (Slack, Feishu/Lark), only an Agent editor, and an editor also gets it in a direct message
  through the agent's Slack integration, when it has one. The card says a background sub-session is asking, names and links it, and offers the
  runtime's own choices, "always allow" included where offered.
- Where it does not, or the conversation is closed (switched off, admitted per message by a
  Decision, or routed), the conversation gets a notice that the sub-session is waiting, and an
  Agent editor gets the request in a direct message, as for any other request.
- A QQ conversation, which has no approval card, gets neither: an Agent editor answers the
  request in the console or in a direct message.
- In a webchat conversation, the request appears among the conversation's own pending requests,
  marked as from a background sub-session.
- A conversation shared with another organization gets no card. It goes to the agent's
  responsible user in a direct message, as drafts do, otherwise to an Agent editor in a direct
  message, as for any other request.
- Editors can also answer it on the sub-session's own page and in the Activity view.

The first answer from any of these places decides it, and the other cards show that decision. If
nobody answers within the agent's "Hours to wait for approval" (12 unless set), the request is
denied, the sub-session stops, and the conversation is told it ended; delegating the work again
asks again. A request whose turn ends any other way, a restart included, expires and can no
longer be answered. A main conversation's own requests, and agents outside assistant mode, keep
today's behavior.

## Assistant-mode patrols

When an active or waiting item's next check comes due, the daemon holding the agent's duty starts
one patrol of it: a background sub-session that looks at the item read-only, records what it saw
as an observation, sets the next check or marks the item waiting or done, and ends. It has three
outcomes. When something should be done, it asks for approval to do it (see "Assistant-mode
proposals"). Otherwise, only when something changed since the latest observation does it report,
and only into the conversation the item was taken in, whose long session then speaks for it; other
followers are not told yet. Otherwise it stays silent. The item gets its observation either way.
When that conversation has no long session the check is skipped, and the item records why. Only an
item's own next check wakes a patrol: there is no cadence and no event trigger yet. A next check
is patrolled once; one missed while the agent was paused is not replayed, and an overdue item is
checked once. An agent runs one patrol at a time, patrols do not count toward its concurrent
sub-sessions, and it starts at most `dailyPatrolBudget` of them in any 24 hours (50 when unset).
A failed patrol is recorded on the item and the next attempt waits min(60, 2ⁿ) minutes, n being
its failures in a row; a patrol that records nothing counts as failed. After five in a row the
item is patrolled no more until its next check is set to a new time, and its conversation is told
once. A failed patrol never sends the "ended without reporting" notice a delegated sub-session
gets. A patrol is listed among its conversation's sub-sessions; stopping it there ends it
silently and counts its check as done.

A patrol is offered only read tools, an item update limited to its own item and `propose`: no
platform write, no `sendMessage`, no new item and no draft, and any other tool it names is refused.
Its runtime runs in its own read-only mode (`read-only`, else `plan`) whatever the agent's permission
mode, and anything that would ask for approval is refused, never asked. It still runs on the
agent's own host, with the agent's credentials and workspace: the runtime's read-only mode is what
keeps it from writing there, and reads over the network that need no approval stay possible. The
assistant mode panel therefore marks patrols as degraded.

## Assistant-mode proposals

A patrol that finds something worth doing asks for approval with `propose`: one plain sentence
("I want to do X because Y"), the reason, and the task a background session would carry out, such
as "rebase PR #12 onto main and push". A patrol proposes at most once and runs nothing itself; no
other session and no agent outside assistant mode is offered `propose`.

The proposal is carded in the Slack conversation the item was taken in, where that conversation's
replies land: its top level when it is one long conversation, else its thread. Whoever could ask
the agent there may approve it: in a direct message, that person; in a channel, anyone whose own
message would start a turn of the agent there; never a bot. A click from anyone else does nothing.
Approving grants nothing that typing the request there would not: the task runs with the agent's
own permissions, and its permission requests follow "Assistant-mode sub-session permission
requests". "What people can do in chat" makes no difference to proposals. A conversation shared
with another organization, one gated By decision, one the card definitely could not be posted in,
and conversations on other platforms get the card where drafts go instead: the agent's responsible
user in a direct message, otherwise no card, and it waits in Activity. A post that timed out may
still land, so it is never sent a second time elsewhere. In a webchat conversation, the live Playground
included, there is no card: the proposal waits among the conversation's pending requests above the
composer, and is not sent to the responsible user. Whoever may continue that conversation may
approve or deny it there after a confirmation, and so may the agent's editors, who also find it in
the conversation's Requests popover. The row leads with the sentence, folds the reason and the task,
and shows the item and when it expires; once decided it says what happened until dismissed. An
editor may decide any proposal from the Activity view, including one no one could be reached for,
and the first answer decides it.

The card leads with the sentence, shows the reason and the task, and offers Approve and Deny; there
is no "always allow". Once decided it is rewritten in place: approved by whom and running, denied by
whom, or expired with nothing run, and later how the task ended. A card a restart left unedited is
rewritten when its integration reconnects. A proposal expires after 24 hours and never runs
afterwards, and a denied one never runs.

Approval runs the task once, in a background sub-session of the conversation the item was taken in,
under that conversation's long session, with the agent's own permissions rather than a patrol's
read-only mode. It reports back like a delegated sub-session: its own report, or the daemon's
"ended without reporting" when it ends without one. It counts toward the agent's concurrent
sub-sessions; while they are full the approval is refused with the reason, nothing runs and the
proposal keeps waiting. A proposal whose record changed after it was written, whose item was
closed or deleted, whose conversation has no long session, or whose agent left assistant mode is
refused and never runs. When a restart or handover cuts the task short before it reports, it is
never run again: the conversation is told once that it is not sure this went through and should
check, and the card says the same. Each step (approved, denied, expired, reported back, ended
without reporting, uncertain) is recorded on the item.

## Assistant-mode reminders

An agent in assistant mode can be asked to remind a conversation of something at a set time, such
as "remind me at 9 tomorrow to send the report". At that time it posts the text it agreed on,
exactly as written, once, in the conversation and thread where it was asked, within about a
minute. No model turn runs for it: the agent does not look again, rephrase it or follow it up. A
reminder posts only there, never in another conversation or someone's DM. It can be set up to 366
days ahead, and an agent holds at most 100 that have not posted yet. The agent lists and cancels
only the reminders of the conversation it is in.

While the agent is paused nothing posts; after it resumes, a reminder less than 24 hours late
still posts and an older one is dropped. One that the platform refuses three times is dropped. A
conversation shared with another organization sets and receives reminders like any other (see
"Assistant-mode places"). Background sessions, patrols and webchat cannot set reminders. A DM that
read a private conversation for its person can still set them, since they post only in that DM.

## Assistant-mode Activity

The page of an agent in assistant mode has an Activity tab. No other agent shows it, and a link to
it opens Integrations instead. It is read from the agent's daemon when it is shown and kept nowhere
else; each list shows the most recent entries, up to a limit, and says when more exist.

- **Items** are visible to everyone who can view the agent: the active and waiting ones, most
  recently updated first, each with what counts as done, its next check (when a patrol looks at it
  next), the places its followers follow it from and when it last changed. Expanding an item shows
  its summary and newest observations. Done and dropped items sit in a collapsed section that is read
  only when opened. An item never shows who follows it or the wording of a conversation. An editor
  may delete an item after a confirmation; the agent stops following it.
- **Sub-sessions** are listed for everyone who can view the agent, running ones first, each with
  its state and start; patrols are listed among them. Its title, a link to its session and the
  conversation that opened it appear only to someone who may view that conversation.
- **Waiting for approval** is shown to editors only: each pending draft's target, its exact text,
  who is asked to approve it and when it expires. An editor may approve or discard it here after a
  confirmation. The decision is the card's own: one post at most, whichever comes first, the
  editor recorded as the decider, and the card rewritten to the outcome. The row then shows how it
  ended: posted, discarded, failed, not sure it went through, expired, or already decided. A
  decision that got no answer keeps its row with a warning; once the draft is no longer waiting,
  it says to check the destination, since it may have been posted. Proposals are listed here too,
  labelled as proposals: the sentence, the reason, the task, the conversation it runs in, its item,
  who is asked and when it expires, with Approve and Deny. An approved one says it runs in the
  background and reports back in that conversation; one refused at the sub-session limit keeps its
  choices and says why. Sub-sessions waiting for permission are listed here as well: which
  sub-session and conversation (named only to someone who may view them), what it asks to run and
  when it is denied unless answered, with the runtime's own choices. An answer here is the same
  decision as the card's, and one answered elsewhere first says it is no longer waiting.

## Directional agent visibility

Agent-to-agent visibility is the intersection of two independently configured directions.
The source agent decides which peer agents it may discover and message; the target agent
decides which peer agents may call it. An A → B edge exists exactly when all four of these
hold, and nothing else is consulted:

1. A and B are both **known in the org-scoped peer directory**. An agent the directory has
   never seen — or that a missing or stale snapshot cannot prove — fails **closed**.
2. A and B are in the **same organization**.
3. A's outbound policy is `all`, or its allowed-target list contains B.
4. B's inbound call policy is `all`, or its allowed-caller list contains A.

**A shared channel is not part of that predicate — in either direction.** A direct
agent-to-agent wake is postless, and the optional visible post in the paired channel-root
form still does not make that channel evidence for the call-policy edge. A shared channel
must not act as an authorization key. It is also not expressible for the
populations that legitimately need to collaborate — peers that share no channel, and agents
with no IM integration at all (webchat, webhook, dreaming, memory-only). A channel may only
**narrow** a directory listing as an optional filter; it can never widen one. A caller
always sees **itself** in a listing, even under a `selected` outbound policy that does not
name it. That self entry may target the explicit `toAgent` channel-root form described
above; a postless self-wake is still refused separately, except as an assistant-mode
sub-session.

The agent-directory tool must hide peers that fail any part of this check. Message
delivery must repeat the same authorization instead of trusting discovery: a remembered,
guessed, or stale agent id must not bypass either policy. Rejection does not wake the
target and uses the same `not_allowed` result as an inbound-policy denial. Both directions
default to all peers, preserving the existing collaboration experience. An organization
owner may instead set the creation default to `selected` with an empty list in both
directions, so future agents discover no peers and accept no peer calls until configured.
An individual create may still override either direction. Changing the organization
default affects only future agents and never rewrites an existing agent's persisted policy.
A local or otherwise unconfigured agent also defaults to `all` for compatibility.
The organization-wide creation default is a first-class Settings card at the same
hierarchy as Session access, not a field inside the Edit organization dialog.
The Settings page starts directly with its Organization card rather than a generic
page subtitle, keeping organization-wide controls at the primary content level.

**Two unrelated settings are both called "visibility".** The `callPolicy` /
`outboundPolicy` pair above is what the console labels "Agent visibility", and it is the
whole agent-to-agent gate. `Agent.visibility` / `sharedWith` governs **human** console
access to an agent and is **never** consulted for peer discovery or wakes: a `restricted`
agent is still a discoverable, callable peer.

### Channel's remaining role: coordinate integrity

Channel checks did not disappear; they moved from authorization to the integrity of the
**coordinate a wake lands on**. The woken peer's session is keyed by its coordinate, so an
asserted channel a caller cannot reach would otherwise let that caller resume a
conversation it has no access to and read it back. Three cases, applied identically on
every wake path:

- **A coordinate the platform records, with known members** — the caller must be one of
  them, otherwise the wake is refused with `not_allowed`. When it is, the peer is woken in
  exactly that conversation, so a wake naming a channel a human is already looking at still
  lands in the same place it always did. Recorded conversations include direct and group
  conversations, which the product records separately from a bot's channel membership — a
  wake originating from one keeps working wherever such a row exists.
- **An unrecorded coordinate on a persisted IM platform** (Slack, Telegram, Discord,
  Feishu) — refused with `not_allowed`. Such a coordinate is either a conversation the
  caller cannot reach or a stale one whose record has gone, and admitting it is what would
  allow aliasing an existing session. This fails closed on purpose: a brief lag in the
  routing snapshot can transiently refuse a genuine wake, and the caller retries. A direct
  conversation that was never recorded — because nothing in the product had reason to
  observe it — falls here too, which is the same outcome it had before channel membership
  stopped being the authorization key.
- **A genuinely channel-free coordinate** (webchat, dreaming) — never refused, because this
  is the collaboration case the org-scoped directory exists to serve. Instead the asserted
  coordinate is not used at all: the peer is woken in a session derived from the calling
  agent's own identity, which cannot collide with any platform conversation. Two different
  asserted coordinates from the same caller therefore collapse into one pairwise
  conversation, which is the right shape for a postless agent-to-agent exchange.

An agent replying to the exact session that invoked it is a return path, not a new peer
selection. That reply remains governed by the existing origin-only session capability, so
a permitted one-way delegation can return its result without requiring a reverse
visibility grant.

## Session visibility

Every session carries its own audience, independent from the Team visibility of the Agent
that owns it. Passing the Session audience grants access to that Session's metadata and
transcript; it does not grant access to the Agent's page, configuration, workspace, or
invocation controls. The Console may show the owning Agent's display name as Session
context and as a Session-filter label, but makes it an Agent link only when the viewer
can also see that Agent. Selecting the label scopes Session results; it grants no Agent
access.

Platform direct messages, Playground and webchat conversations, and sessions launched
through the Web API default to **private**: only their owner can see them — deliberately no
role exception, org owners included. Channel sessions, group direct messages, and
automation-originated sessions (cron, hook, dream, agent-to-agent) default to **org**,
visible to every organization member. A session's initiator is recorded regardless of
tier, and re-classification belongs to that recorded initiator alone: the person who
started a channel conversation may later pull it private, and only a private session's
owner may publish it back. Roles grant no re-classification rights — an org owner cannot
flip someone else's session in either direction.

Usage summaries have a separate governance permission: organization Owners can
attribute the organization's complete persisted usage by Agent, model, source,
and time, including spend from private or external Sessions. Aggregate usage
does not expose Session IDs, titles, transcripts, or tool payloads, and grants
no access to those Sessions. Collaborators and viewers retain attribution only
for Agents and Sessions they can access; withheld usage remains in the
organization and metering-source totals and the `unattributed` rollup.

An agent-to-agent child inherits its parent's visibility, because a delegation copies the
parent's prompt into the child's transcript. Tightening a session therefore cascades to its
descendants; publishing one never does — widening a child stays that child's own decision.
The child remains readable to everyone in that inherited audience even when its target
Agent is hidden from them.

A session the caller may not see is reported as missing, not as forbidden: the console must
not reveal that it exists.

When Slack session access sync is enabled, a public-channel session is visible to a user
with a linked, active full-member identity in that Slack workspace even when the user has
not joined the channel. Private channels and group DMs require current conversation
membership. Guests and Slack Connect users also require current conversation membership,
including for a channel that is public to full members of the installing workspace. The
organization-owner role never bypasses these provider checks.

Whether a conversation (or GitHub repository) is public is itself a cached provider
observation with an accepted conversion window (session-access-cold-visit.md §2.1): after
a public→private conversion, its recorded sessions may stay visible to the pre-conversion
audience for up to `SESSION_ACCESS_PUBLIC_TTL_SEC` (default 60 minutes) while nobody reads
them. The first read past the recheck threshold (`SESSION_ACCESS_RECHECK_SEC`, default
2 minutes) serves the old audience once and fires the correcting re-observation, so a
viewer retains access only for their already-cached per-user verdict (a few minutes), and
the daemon's next channel snapshot independently drops a now-private channel's cached
public status. Per-user checks — workspace membership, conversation membership, repository
permission — never ride the long lease.

An external membership check that cannot complete fails closed: affected sessions stay
hidden. Provider API failures and unclassified degradation keep the generic unavailable
notice. A missing Lark/Feishu `union_id` offers a one-time sign-in identity refresh in
Profile; ordinary Session reads use the installed Bot App credential and never require a
recurring user-token reconnect. Feishu versus Lark is named from the session scope's
verified regional app, never from a URL hint. Diagnostics may retain only the provider
target, failure stage, HTTP status, and a bounded upstream error code — never account ids,
bearer tokens, or upstream error messages.

A self-deployed AgentConnect instance is bound to the organization of its Lark/Feishu
login App. Every Bot App installation, whether one-click or manual credentials, must
resolve that configured Login App's `tenant_key`, compare it with the candidate App's
`tenant_key`, and reject a mismatch. The authorizing human may be any member of the same
organization; tenant verification must not be weakened into a same-user `union_id`
comparison or require user-token storage.
A reconnect that proves a different provider account must not replace the linked identity;
the console tells the user to reconnect with the linked account or unlink before switching.

Making a session private hides its transcript immediately, but the agent's shared memory
layer is read in every conversation, so the guarantee about memory is narrower and must be
stated plainly wherever the change is offered: capture into that layer stops once the owning
daemon acknowledges the change (typically sub-second, surfaced as a pending state until
then), and anything the agent already distilled while the session was org-visible is not
retracted. Until a session's daemon has confirmed the current state, that daemon withholds
capture rather than assuming the session is shareable.

## Memory layers

Every agent's managed memory is layered by audience, automatically; there is no setting
for it. Each layer is a folder with its own `MEMORY.md`. A session reads, and is given at
its start, the shared layer plus at most one more specific layer, and it writes only to
the most specific one. Which one depends on who can see the conversation:

| Conversation                                                                                                                                                                                                                          | Reads                                    | Writes             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------ |
| A public channel the product can confirm holds only the organization's members: today a Slack public channel not shared with another organization and with no known guest                                                             | the shared layer                         | the shared layer   |
| A 1:1 DM, or a webchat or console conversation                                                                                                                                                                                        | the shared layer and that person's layer | the person's layer |
| Anything else: a private channel, a group DM, a conversation with people from outside (shared with another organization, or with a known guest), and any group the platform cannot confirm (Telegram, Discord and Lark/Feishu groups) | the shared layer and that place's layer  | the place's layer  |

A person's layer is keyed by their console account when they linked one, so their DMs on
every linked platform and their console conversations share one layer; otherwise it is
keyed by their platform identity. When someone links an account, a layer kept under their
platform identity moves to the console-keyed one once, if that one does not exist yet; if
both exist, the console-keyed one is kept and the other is no longer read, never merged.

A run with no person behind it (a schedule, a hook, a patrol, a report round, a message
from another agent) and a turn that folds several people's messages use the layer of the
conversation they are in: output landing in someone's DM uses that person's layer, output
in a channel uses the channel's. A code-host review or any other session that is not a
conversation uses the shared layer. The person of a DM is whoever typed in it, else whom
the platform says the DM is with, else whoever opened a session there; an agent or an
automation is never taken for that person, and a DM whose person cannot be told keeps a
place layer of its own. A channel shares only when a membership listing or a lookup has
confirmed it is not shared with another organization. A conversation that cannot be
described yet, as right after a restart before its platform answers, or whose sharing is
unknown, keeps a place layer of its own; a shared channel still reads its own earlier
folder beneath the shared layer.

Per-turn distillation and an explicit "remember this" write to the session's layer with no
card. "Remember this for everyone" writes to the shared layer. A person may read their own
layer with a memory tool from any conversation, as the one asking; it is injected only in
their own DM or console conversation. In the console the person sees their own layer under
Your memory on the agent's Memory page; nobody else sees it, editors included. Dreams consolidate the shared layer only, mining only the conversations that use
it; person and place layers are not dreamed. External memory is the shared layer alone: it
captures only from conversations that use the shared layer, has no person layer, and saves
an explicit write from anywhere else only when the person asks to remember it for everyone.
Every agent detects a guest or an outside member who joins, so a Slack public channel they
joined keeps a place layer of its own.

**Agents on native runtime memory are the exception, and the product must say so.** With
that backend the runtime persists memory inside its own process for the whole agent, with
no per-session control, so a private session on such an agent gets the transcript
guarantee but not the memory one. Anywhere an agent is configured for native memory, the
private tier must be described as "hides the transcript, not what the agent learns from
it" — silence is not an option.

## Runtime memory-provider compatibility

Memory-provider semantics are part of the support contract for every agent harness, not
an incidental spawn detail:

- `managed` remains available for every harness. When a harness has its own persistent
  memory, its verified off-switch must be registered so the runtime store cannot compete
  with AgentConnect's managed store.
- `none` is supported only when AgentConnect has verified either a native-memory
  off-switch or that the harness has no persistent memory of its own. Unknown behavior
  fails closed; `none` must never silently mean "AgentConnect memory is off, but the
  harness may still remember."
- `native` may be offered only after the harness's memory location is verified. It never
  redirects runtime directories, because a runtime home also holds the login: under the
  Host strategy the agent shares the host's runtime home and memory with every Host agent
  on that daemon, and under a sandbox the memory stays in the agent's private HOME. The
  console does not show native memory.

The single source of truth is
[`memory/runtime/capabilities.ts`](../packages/daemon/src/memory/runtime/capabilities.ts). Match a known
registry id first and retain a command/args signature fallback for custom aliases and
package launchers such as `npx`. A new harness added to the curated ACP matrix must also
declare its expected `managed` / `none` / `native` capabilities in
[`profiles.ts`](../packages/daemon/test/acp-matrix/profiles.ts); the runtime-memory
contract test compares that declaration with the production policy. Adding or changing
a policy requires a focused env assertion and a source comment naming the verified
runtime lever.

## Common memory operations and compatibility

The common memory browser and model tools expose actual provider capabilities.
Managed conditional mutations require a capable authoritative home; external and
older homes must not inherit guarantees their provider cannot enforce. Show only
supported actions and retain explicit provider tools for index/history and other
compatibility workflows. Conflicts and unknown write outcomes require inspection;
never silently retry through an unconditional legacy write.

Memory catalogs are reference context delivered through supported session system
context. New/native-resumed delivery does not imply automatic updates inside an
already-live runtime. Do not turn a catalog refresh into a user message or title.
See [unified memory operations](designs/unified-memory-interface.md) for the
implemented boundaries and remaining compatibility-retirement conditions.

## Managed-memory prompt provenance

The session-start `MEMORY.md` index must be enclosed in an explicit, labeled start/end
boundary. Prompt guidance must state that only text inside that boundary is memory-file
content; agent/session metadata, workspace or git status, user messages, recalled
context, and all other surrounding text are ordinary session context.

The boundary body must encode one layer of XML character references: `&` as `&amp;`, `<`
as `&lt;`, and `>` as `&gt;`. That reversible serialization keeps memory text readable
while preventing an embedded boundary-like string from closing or opening the structural
boundary. Prompt guidance must name the encoding and tell the agent to decode exactly one
layer to reconstruct file text; all other characters and line breaks remain unchanged.
The serialized boundary body, including any truncation notice, must remain within the
standing index's byte budget and may not split an XML entity or UTF-8 code point.

For targeted `writeMemory` edits, `oldString` must come from the decoded bounded file
content or verbatim from a current `readMemory` result; an `updateMemoryEntry` exact
edit likewise sources `oldText` from a complete current `getMemoryEntry` result. The injected index is only a
start-of-session snapshot, so instructions and replace-failure feedback must direct the
agent to `readMemory` after another write, when provenance is uncertain, or before
retrying a failed replacement.

## Memory backend selection

Present storage backends in the order `Managed`, `Native`, `External`, followed by a
visually separated `Off` choice. `Off` is the user-facing label for the protocol's
`none` value: it is the absence of persistent memory, not another storage backend.

The agent Memory page offers no scope choice: managed memory is layered by audience
(see [Memory layers](#memory-layers)). The managed backend's description says so plainly:
what the agent learns in public channels is shared across the people it serves, a person's
DMs stay theirs, and each private conversation keeps its own. A layer picker above the
memory browser offers the shared layer, **Your memory** (the signed-in user's own person
layer, read-only), and every conversation whose place layer holds memory. The place layers
are shown to whoever may see the agent's memory; a person layer is never listed, and the
route behind Your memory reads only the caller's own layer, so nobody can open another
person's, editors included.

An existing agent's memory settings are edited as one explicit draft. Selecting a
backend, changing managed distillation, switching an external connection, or editing
external recall/capture policy must not take effect until the user saves the form. While
the draft differs, show both the currently active backend and the unsaved selection or
settings. Content and records continue to reflect the active backend until Save
succeeds.

On the agent Memory page the settings form is collapsed by default behind a one-line
summary of the persisted backend (backend name and its key policy values) so the memory
content itself stays the page's focus. Expanding the form
edits the draft; closing or cancelling it discards the draft, so a collapsed form
always describes the persisted settings. A successful save collapses the form again.

External memory always requires a connection. If no connection is selected, explain
inline that the draft cannot be saved and that the current backend remains active. An
already-bound external agent must not offer an empty selection that merely looks
unbound while its previous connection is still in use; the user must choose another
connection or explicitly switch to a different backend or Off. Server-side schema and
daemon admission remain fail-closed even when the console validates the draft first.

## Managed-memory dreaming defaults

Managed memory defaults to dreaming once per day at 04:00 in the owning daemon's
timezone and leaving every completed store proposal for review. Users can turn dreaming
off, remove its schedule to keep only manual runs, or explicitly opt in to automatic
acceptance independently.

When explicitly enabled, automatic acceptance applies to every successfully completed
proposal, regardless of whether the runtime carries the dream policy through a dedicated
system-prompt channel. The console must warn that these results replace live memory
without content review.
An adoption fence conflict or failed swap still leaves the completed result available
for manual review instead of replacing newer live-memory changes.

Dream proposals preserve existing topic boundaries, filenames, and byte-identical
content by default. Small wording, formatting, ordering, or consistency changes do
not justify renaming a topic. A rename, merge, or split is appropriate only when a
material content change makes the existing structure misleading; equally faithful
proposals prefer the smallest diff.

Reviewing a completed dream shows each file as the same live-to-proposed line diff
used by managed-memory history. Added and deleted files use an empty live or proposed
side respectively, so their entire contents are visibly marked as additions or
removals before adoption.

Each dream model run appears in Sessions with its runtime, model, token/cost usage,
and its original ACP activity history. Dream history uses the same transcript
representation as an ordinary session: the exact extraction prompt, raw reasoning,
merged tool call/update bodies, and the model's final proposal are visible to anyone
authorized to view that agent's sessions. Those bodies can quote memory and
source-session content, so the agent's session access boundary is also the privacy
boundary; the daemon must not publish the Dream activity to the triggering chat,
generic evaluation events, or logs. The Memory page links the execution session;
source-session selection remains input metadata and must not displace that run's own
usage in the history presentation.

## GitHub informational review checks

An accepted review starts as `queued` until the daemon reports active preparation. When the daemon
begins preparing the review workspace, its Check becomes `in_progress` with the title
`Preparing review`; this can happen before the session exists, so no new session
link is added yet. After the session crosses the start barrier, the title becomes
`Analyzing this revision`. Preparation updates are best-effort and never delay the turn.

An Agent failure is not a code-review finding, but it cannot clear a required review Check.
When a GitHub revision review turn ends without a submitted formal verdict, complete its
Check as `failure` while retaining the turn's actual operational status. A provider quota
failure names the usage limit in the Check title. A submitted formal verdict
remains authoritative (`REQUEST_CHANGES` stays `action_required`), and an ambiguous
formal-review write remains a visible failure until it is reconciled. An active
terminal failure keeps the `Request review` action for a new attempt after the cause is resolved.

An inline review comment must name a line or range in the pull request's diff. Invalid
positions return an actionable error before publication, so the Agent can correct them
or move the finding into the review body and retry within the same authorized turn.
GitHub rejection details are returned to the Agent without changing the review verdict.

A review turn the platform itself ended — the Agent stopped being served where it was
running — is a distinct outcome from a review that ran and could not conclude, and must not
borrow the runtime-failure wording. Its Check states that the review was interrupted and
names the entry point that starts it again, because nothing about the change was judged and
the same review can simply be run once more. No automatic re-run is promised: the retry is
the maintainer's `Request review` action or a new mention, under the same authorization as
any other review request.

GitHub's suite-level `Re-run all checks` action starts a new generation for every current
AgentConnect informational review Check in that App suite, with the same live maintainer
authorization and revision fences as a single-Check rerun. It does not depend on the
integration's ordinary event cadence.

Every active informational review Check completed in a terminal state offers a
`Request review` action. It targets only that Check's Agent and opens a new generation
for the same revision after the same live maintainer authorization and revision fences.
A retired Check offers no action because it no longer has a live integration to run.
Each Check's pull-request reference links to that Agent's exact published result when
known: its submitted formal review first, otherwise its fallback comment. Parallel
reviewers must never link to one another's result. Before a result exists, or when its
public identity could not be retained, the reference continues to open the pull request.
A new review generation following a terminal Check publishes a fresh Check Run: GitHub
keeps a completed run terminal, so reusing it would leave the top-level status and icon
completed while its output claims the review is queued or in progress. The fresh run is
then updated through queued, in-progress, and terminal states; the previous run remains
historical. A request that supersedes an incomplete generation keeps that active Check
instead of leaving it permanently unfinished.

Automatic PR revision reviews are latest-wins while active or queued. When a newer
revision-bearing delivery for the same Agent, integration, repository, and pull request is
durably admitted, the daemon cancels the older active review, suppresses all of its remaining
output, and removes intermediate queued revisions. A head change arrives as
`pull_request:synchronize`; a target-branch change arrives as `pull_request:edited` with
signed `changes.base` metadata. Revision identity includes both base and head, so retargeting
an unchanged head still preempts work for the old diff. Relay ingest time determines
recency even if asynchronous authorization reorders delivery; the delivery key breaks
same-timestamp ties deterministically. Draft state does not change review eligibility: an
open draft PR follows the same formal review path as a ready PR, including approval when
the current revision passes. Transitions between draft and ready are status-only and do
not start another review generation. Explicit comments, review requests, and Check reruns
remain ordered work and are never discarded by revision supersession.
The trusted pull-request lane spans per-delivery anchor session keys but remains isolated by
the configured output platform, channel, and integration.

GitHub emits every root inline comment in one submitted PR review as a separate webhook.
The daemon groups those roots by the trusted review id during a bounded quiet window, runs
one model turn over the shared review context, and requires one independently authored reply
for every trusted thread root. A later reply inside any one thread remains a separate turn.
The open batch can span per-delivery anchor session keys; it, its individual publish fences,
and revision ordering survive daemon restarts.

## GitHub maintainer trigger authorization

GitHub Issue and pull-request integrations treat the actor's current repository role—not the
webhook's `author_association` label—as trigger authority. A **trigger-authorized role** is
`admin`, `write`, or `triage`: GitHub reports `maintain` as `write`, and `triage` is the role a
repository gives a trusted contributor to manage Issues and pull requests—requesting a pull
request review is one of its listed permissions—so it authorizes a trigger while granting no
push access. An Issue or pull request whose author holds none of those roles does not start an
Agent automatically, even when its body mentions the Agent or App. A trigger-authorized user can
explicitly `@` the Agent or App in a comment to request the first turn on that external
thread; the same mention from a read-only user does nothing.

Every comment author is checked live from the comment object; for edit/delete actions,
the top-level webhook sender is not treated as the content author. An unmentioned
comment follows the configured cadence only when both the commenter and the Issue/PR
author still hold a trigger-authorized role. This keeps automatic follow-ups on
maintainer-owned threads while requiring an explicit maintainer summon for externally
authored threads. Native review requests and Check reruns use the same
current-maintainer boundary. For an external pull request waiting on its first
review, approving its GitHub Actions workflows also starts the review when a
pull-request workflow begins. AgentConnect authorizes the workflow's triggering
actor as a current maintainer and coalesces multiple workflows for the same
pull-request revision into one review generation.

Trigger authorization is separate from effect authorization. A formal PR review still
requires the active HookRun, review policy, Agent repository grant, and GitHub App
permission checks at the moment the review is submitted. Binding a repository to an Agent is a
separate, stricter gate: it asks the console user for `write` or `admin` and never accepts
`triage`.

## GitHub review mention routing

An explicit `@<agent-name>` in GitHub targets only that AgentConnect agent's
matching review integration. On an organization-owned repository,
`@<owner>/<agent-name>` is the same targeted form written as a GitHub team
mention: an organization that creates a visible team named after the agent gets
that handle autocompleted in GitHub's comment composer, and the team needs no
members because matching only reads the authored text and the repository's own
owner. A same-named team in a different organization targets nobody, a personal
repository has no teams and so ignores the form entirely, and AgentConnect never
creates, renames, or deletes these teams. An explicit `@<github-app-name>` is the broadcast
form and targets every matching review agent for the repository. When both forms
are present, broadcast wins; mentioning an unrelated GitHub user does not change
the configured review cadence.

Mention routing does not bypass the integration's event family, label filter,
installation attribution, or live maintainer authorization. Bot-sender veto still
applies to comments and review comments. A revision-bearing PR event authored by the
installed App is admitted as a lifecycle event: same-repository PRs follow the internal
CI review lane, while fork PRs wait for workflow approval. A targeted agent
mention narrows an otherwise broader `updated` fan-out, while an event with no
AgentConnect mention continues to follow its configured cadence.
In a pull request conversation, an authorized explicit AgentConnect mention
starts a new review generation for the current revision when the integration
allows formal reviews, so its informational Check reopens and enters in progress
when analysis starts. Turning formal reviews off must not change trigger
matching: selected PR events and authorized mentions still activate the agent,
but an authorized mention no longer requests or permits a formal review, opens a
mention-driven review generation, or requires a review verdict. Independently
configured reporting for PR revision events remains separate. Review policy does
not select or change the hook's reply/output path; existing delivery behavior
continues to own that decision. The console presents review and reporting both
being off as `None`; selecting it changes neither trigger matching nor output
delivery. An ordinary unmentioned follow-up also remains conversation-only and
does not replace the current review verdict.

## Workspace navigation and repository access

The workspace options live in the agent's Workspace tab, above the files they
configure — not in Configuration, and not behind a summary row that navigates
there. A single `Edit` action owns the workspace source (scratch, GitHub,
GitLab, or a plain Git URL) together with repository, branch,
working-subdirectory, and repository-access settings; the card shows a derived
provider mark, never a stored source or a separate conversion switcher
(git-workspace-model.md §7). Replacing a workspace must replace the file
browser with it: the tree, the open preview, and the git status below the card
always belong to the workspace the card currently describes, never to the one
it replaced.

In the Workspace tab, callers who can edit the agent may create, edit, or delete
one file at a time when the workspace is scratch. New UTF-8 files use exclusive
creation and never overwrite an existing path; slash-separated names locate an
existing subdirectory or create the missing parent directories. Existing-file
edits load the complete file and save against the mtime they opened. Deletion also
requires the last-read mtime and an inline confirmation. Saving or deleting while
the agent is working surfaces a conflict; otherwise the daemon quiesces its
runtime before atomically applying the mutation, so an agent change is never
silently overwritten or removed. GitHub workspace files remain read-only, and
workspace bodies continue to transit the control plane without being persisted.
File creation and editing stay inline in the Workspace file browser, replacing the
preview pane instead of opening a modal. Desktop keeps the file tree visible;
mobile uses the browser's existing list-to-preview drill-in and back action. The
file-browser header shows the current workspace-relative breadcrumb on the left
and `Add file`, `Edit`, and `Delete` actions on the right. New-file naming happens
in that breadcrumb; completed slash-separated directory names become breadcrumb
segments. The preview pane does not repeat the file name, path, or workspace label.

A Markdown preview renders a leading YAML frontmatter block as a keyed table above
the document, the way GitHub does — a memory topic file, a `SKILL.md`, and a
knowledge body all open with one, and CommonMark would otherwise read it as a
thematic break plus a setext heading. A sequence renders as a row of cells and a
nested mapping as its own table. A block that is not a readable mapping is hidden
rather than shown as prose, and the document body still renders; the raw text stays
visible through the preview's Code toggle. Editing always shows the file verbatim.

Managed and external Memory open in the entry browser, which shares the Workspace
file browser's shell: the list pane, the preview summary row, and the header
actions. Runtime-native Memory, whose files the runtime itself formats, keeps the
file browser and its shared inline file editor and breadcrumb naming field. Neither
may introduce a separate prompt or modal flow for adding or editing; only the
persistence API and Memory's flat Markdown filename validation differ.
Entry-specific capabilities belong in the preview summary row: the entry browser
exposes `Edit`, `Delete`, and `History` there, and repository-backed Workspace
history must reuse the same action slot and history pane when it is added.

The Workspace card shows no `read` or `write` badge beside the repository; the Edit
workspace dialog owns that access, and an anonymous checkout is always `read`,
whatever preference is stored. The editor may switch freely between the sources,
choose another repository or branch, change the working subdirectory, edit
read/write access, or bind a manual checkout to the GitHub App. Before a mode,
repository, or branch change, state clearly that saving permanently replaces the
current daemon-local workspace files and cannot be undone. Use an explicit
`Replace workspace` save label for that destructive case. A working-subdirectory
or access-only edit preserves the current checkout.

The same Edit workspace dialog owns additional repository access for both GitHub and
scratch workspaces: it lists current grants, sets each one's access and checkout, adds
another repository, and revokes an existing grant. The Workspace card's repository
dropdown may also change an additional repository's or installation grant's access and
checkout, or revoke it. Both surfaces use the same options and vocabulary, and adding a
repository has one flow, **Authorize repository**, whose GitHub picker also offers an
organization owner "All of `<account>`" for each installation the agent does
not hold yet: the dropdown and contextual authorization prompts open the shared dialog at
the additional-repository step and return to the calling flow after authorization.

GitHub workspace settings expose one boolean named `Worktree`. When enabled, each
logical session runs in its own stable Git worktree under the Agent directory, so one
Agent can work on several sessions concurrently without sharing branch or file state.
When disabled, sessions use the primary checkout. Each worktree checks out its own
generated branch, `a10t/<user>/<word>-<word>`, naming the user who opened the session, so
the work a session produces can be pushed and reviewed under a name a human recognizes.
The `a10t` namespace is one no project names a branch, because Git refuses `x/…` beside an
existing branch `x`; a repository's own `dev` or `feature` branch never blocks a session.
Retention cleanup deletes that branch with the worktree, and only ever one under `a10t/`
(or the earlier `dev/`) whose commits are all already reachable from a remote. New GitHub
Agents default to enabled; existing Agents retain the shared-checkout behavior after
upgrade. A fresh manual Playground may override `Worktree` before its first turn without
changing the Agent; automatic triggers use the Agent setting.

The Workspace tab lets an authorized viewer switch between the primary checkout
and the stable worktree of any visible, unpurged session. Session details place a
Workspace link immediately before Details. For an unpurged session-scoped GitHub
checkout, it opens that session's worktree; for a shared GitHub checkout or Scratch,
it opens the Agent's primary workspace. Its git or folder icon reflects that source.
A session worktree is browse-only in the console: file editing and pull remain actions
on the primary workspace. When a selected session has no worktree, the browser says so
without naming a cause — a worktree that was cleaned up and one the session never had
are the same answer from this surface — and it must not present the missing worktree as
a new workspace with no files. That sentence belongs to the session whichever repository
is selected: a session-scoped read of an authorized additional repository addresses that
root's worktree for this session, so it may never answer with the Agent-scoped copy about
a repository the Agent materializes on its next session.

The checkout control occupies about one quarter of the Workspace file browser
header, opposite the current file breadcrumb. Its primary choice is named with
the main checkout's live branch, never a generic "Primary checkout" label. With no available
session worktree it is a static branch label with no menu; otherwise it switches
between that branch and the available worktrees. Worktree choices keep their
Session link so changing the viewed files and opening the originating conversation
remain distinct actions. Menu choices match the closed control's compact height,
while the menu itself may extend wider to keep titles legible. Their session time
stays out of the row and appears in its tooltip instead. Session links use their
message icon and label without a redundant external-link arrow. The Source card
remains directly above the browser and names the repository or scratch workspace
and, for a Git workspace, its configured branch.

Workspace changes are cold edits: active work is drained and existing cached
credentials are cleared before the new definition becomes active. Any edit that removes
write workspace authority for a repository must be rejected while an enabled GitHub
integration for that repository submits formal reviews or reports Checks; the user must
turn those actions off first. This conflict is a server-side invariant, not only an
editor validation.

An App-backed workspace follows a GitHub repository rename without treating it as a
workspace replacement. Its displayed repository and existing checkout origin converge
to the canonical new name while the branch, working subdirectory, and local files stay
in place.

For an isolated session with one open PR in its managed writable primary
repository, GitLab and Gitea feedback resumes that author session. No review
Trigger is required. The agent inspects current review and CI state and keeps
fixes on the existing branch. This association never guesses a session from a
shared checkout, a fork, or an additional workspace root. Provider event support
and delivery rules are documented in [Pull-request feedback continuation](designs/codehost-pr-feedback.md).

## Agent model credentials

Provider keys are organization-scoped, encrypted and write-only. On desktop,
Runs on and Credentials appear side by side in the same row. A self-hosted agent
has two credential choices:
Daemon credentials (the default) and Use saved credential (Beta). Only the saved
credential choice is Beta. With saved credentials, model pickers offer only models
whose Anthropic or OpenAI key is configured, including Decision rules and their
fallback. The daemon matches the key to each session's selected runtime and model.
While saved credentials load, the form preserves the selected model and blocks saving
without reporting a missing key. A failed lookup shows a retry action; a successful
empty lookup asks for a configured key. Save failures remain visible beside the
dialog's save controls, including when a daemon must be upgraded.
Cloud keeps its existing
subscription credentials and ignores this selection, including after a move from
a self-hosted daemon.

The daemon retrieves the selected key when starting the runtime process and applies
its key, endpoint and custom headers together in the child environment. Selecting a
key does not log in, log out, or modify the host's runtime login files. Missing keys
and credential delivery failures refuse that launch rather than falling back to a
different billing source. Runtime output masks the injected secrets. Key updates
take effect on the next process start; a running process keeps its original key.
Sandboxed launches with a selected key skip seeding host runtime settings and
credentials into their private runtime home.

## Agent secret environment variables

A write-only secret (the console's Secrets card, `AgentSpec.secrets`) is not an
ordinary env var, and the agent must never treat it as one. Two halves, both
mandatory:

- The daemon tells the agent WHICH env var names are secrets as standing session
  context — names only, never values — with the instruction to use them in place
  and refuse to reveal them.
- The daemon masks known secret values out of every agent-emitted surface —
  platform messages, the live webchat stream, persisted transcripts (including
  tool rawInput/rawOutput shown by the console's "View detail"), GitHub comments,
  memory extraction, and permission/elicitation cards — rendering `[secret:NAME]`
  in their place.

Masking is containment for accidental echoes, not a security boundary: the agent's
processes can legitimately read the value from their environment, and a hostile
prompt can re-encode it past any literal-match filter. Values too short to mask
meaningfully are left alone rather than mangling unrelated output. Neither half
substitutes for the other: the notice is what makes the agent behave; the mask is
what keeps a slip out of chat and the permanent record.

Agent env and secret values configured in the console enter only the ACP child
process environment; they are not configuration-template inputs. Every string in
`agent.json`, including descriptions and scheduled-task trigger text, is literal.
Environment values must never be copied into model context through interpolation.

## Local GitHub credential exposure

GitHub App installation tokens are internal transport material, not a public daemon
CLI feature. Credential-helper commands must stay hidden from normal help output and
the local credential socket must reject requests that do not carry the runtime-only
capability for the selected agent. The capability is generated in daemon memory and
must never be written to a shim, git config, agent config, or log.

Do not inject an AgentConnect-minted token as a long-lived `GH_TOKEN` in the ACP
runtime environment. Fetch it only for the specific `git` or `gh` invocation that
needs it, and log only the agent, repository, credential plane, and outcome.

This is defense in depth against casual extraction, not a claim that software can
hide a bearer token from a host administrator who can inspect or modify the daemon
and its child processes.

## Execution strategy names

The console names an execution strategy plainly: `host` is **Host**, the default
process-level sandbox (`srt` today) is **Sandbox**, and `microsandbox` is **VM**. The
generic **Sandbox** belongs to whichever process-level strategy is the default; every
other strategy shows its own name, so `srt` reads **SRT** once another strategy
becomes the default, and a strategy the console does not know shows its slug. The
technology and boundary behind a name (bubblewrap process isolation, one microVM per
session, no boundary) go in its tooltip, never in the label or in helper text.

## Sandbox availability and feature support

The daemon's **Runtimes** section has one tab per execution strategy in the daemon's
strategy table, in a fixed order (**Host**, **Sandbox**, **VM**, then any other), and
defaults to **Host**. A tab lists the runtimes that strategy can start, with the models
they advertise there, and counts the agents whose execution strategy it is; a strategy
the daemon cannot run shows its probe's reason instead of runtimes. A daemon that
predates the table keeps a **Host / Sandbox** switch when sandboxing is optional, and a
daemon that requires sandboxing, including a managed pool member, shows only the
sandbox view. Switching tabs changes only the displayed runtime facts; it does not
change an agent's execution setting. Image-only installation warnings belong to a tab
that starts the image (**VM**, or a legacy daemon's **Sandbox**), while the other tabs
show the host's runtime version and login result. A missing image binary must not mark
the host runtime unavailable. The tabs add no probe sweep.

Installation and login are independent. Each tab shows an installed runtime even
without a stored login, with **Login required** in that case. A stored login, or
provider credentials Claude Code accepts without that login (an API key, auth
token, or OAuth token in host env or `settings.json` env), or `GEMINI_API_KEY` in
the daemon environment for Gemini CLI, keeps a missing runtime visible with **Binary not installed on host** or **Binary not installed in image**,
according to the install the selected tab starts. Only a runtime with neither an
installation in that environment nor credentials is hidden. Missing binaries take
precedence over login warnings. Enumerating models does not prove that the runtime is
signed in; expired credentials remain visible and may require login. A custom provider
base URL without a secret is not credentials.
Runtime pickers group choices displaying **Login required** at the end, preserving
the order within each group. These choices remain selectable.

On self-hosted daemons, a tab that starts the image initially folds away runtimes
installed in the image but not on the host. A **Show runtimes not on host** control
reveals them with their existing login status. This is presentation only; discovery
and runtime selection keep the full inventory. Managed pools show their full image
inventory directly.

A daemon group's **Runtimes** section has the same tabs, names and order. A tab appears
when at least one serving member's table offers the strategy, the rule the picker and
placement apply to a group, and shows a probe reason when no serving member can run it.
A tab lists only what every serving member able to run that strategy offers there,
runtimes and models alike, read from their entries for it; a member that reports no
table counts in every tab with its single list, and a group whose serving members all
predate the table keeps one list. Login warnings name only the members a tab reads,
and a tab that starts the image folds a runtime any of them lacks on the host.

Every feature is supported in environments both **with and without** an OS sandbox,
and a trusted agent may deliberately run unsandboxed. A sandbox is a best-effort
isolation layer, never a precondition: no feature may fail closed just because the
host has no sandbox mechanism (for example macOS, or a Linux host without
bubblewrap) or because the agent is configured to run outside one. Doing so would
silently make the feature unavailable in a supported environment, which is a
regression, not a safety win.

When a feature processes attacker-influenced input — the clearest case is memory
dreaming, whose consolidation reads the agent's own past sessions — it confines that
work exactly when the agent itself runs sandboxed, as best-effort isolation of that
input from provider and host credentials. When the agent runs unsandboxed (trusted,
or no mechanism available) the feature still runs; the residual credential exposure
in that mode is an accepted, documented trade-off, closed later by per-runtime
credential brokering, not by refusing to run. Independent, sandbox-agnostic
mitigations (for example excluding an agent's tool credentials from a dream's
environment entirely) still apply in both modes.

## Model selection for runtimes without an ACP model selector

Some runtimes offer no model selector over ACP. Gemini CLI is the first: it reads
its model from `GEMINI_MODEL` when its process starts. For such a runtime the
console's model list comes from a native catalog driver rather than the ACP
selector (for Gemini CLI, the Gemini API's own model list, read with the daemon's
`GEMINI_API_KEY`), and the agent's configured model is applied when the runtime is
launched for a session. Changing the model on such an agent takes effect on its
next session; a session that is already running keeps the model it started with.
This is the same contract `ultracode` effort already follows, applying only when a
session is created or resumed. A runtime that advertises an ACP model selector is
unchanged: its model switches live within a running session.
