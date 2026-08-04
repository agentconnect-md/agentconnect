# Product conventions

This document records user-facing product behavior that implementations must preserve.
Architecture and protocol details belong in [`designs/`](designs/); this document is
the source of truth for cross-cutting product conventions.

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

Every Agent, Daemon, scheduled task, MCP provider, and skill source set to
**Selected** has at least one current organization member who can see it. The
selected-member list is the complete audience: creation attribution and the
organization Owner role do not add hidden access.

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

## Public platform app descriptions

Slack, Feishu/Lark, and Discord app or bot profiles use the fixed public description
`AI agent powered by AgentConnect.` They must never derive public profile copy from an
Agent description because that field is model context and may contain private operating
instructions.

## Planned daemon lifecycle status

A pending daemon upgrade or restart is a planned transition, not an unexpected outage.
While that lifecycle operation is pending, the console shows the daemon and its active
placed agents as `upgrading` or `restarting` with the paused-state color. An agent that
an operator explicitly paused remains `paused`. Once the operation succeeds, fails, or
expires, the console returns to the daemon's current connection status; a daemon that
did not return then reads `offline`.

## Moving an agent from an unavailable daemon

A normal agent move is the safe default: the current daemon must confirm that it has
stopped the existing copy before another daemon activates it. When the current daemon
is offline, the agent Configuration page and placement editor must say that safe move
is unavailable and name the daemon the operator needs to bring online. The target
picker must not lead to a request that can only fail without explaining this first.

A force reassign is disaster recovery, not another ordinary move mode. Offer it
only after the operator chooses an online, compatible target while the current daemon
is offline. It bypasses only confirmation from the source; target readiness, capacity,
runtime, model, MCP, and managed-skill compatibility remain mandatory. Before enabling
the destructive action, require the operator to confirm that the source machine is
permanently stopped and cannot reconnect, and warn that two copies may process messages
if that assertion is wrong.

Both paths preserve the Agent identity and its centrally managed settings. Neither
copies daemon-local workspace, memory, transcripts, or attachments. A source that later
reconnects after a force reassign is told to detach the stale local copy during
placement reconciliation.

## Where a streamed reply may be split

A long reply may be delivered as more than one chat message, but a split must always fall
on a boundary the reader can see. The streaming transport's own rhythm is not such a
boundary: model output arrives in token-sized pieces, so a pause in the stream routinely
lands mid-sentence or mid-word, and cutting there splits one answer across two messages at
a meaningless point.

So a split driven by elapsed time may only happen at a paragraph break outside a fenced
code block; text after the last such break stays buffered until more arrives, until the
agent finishes the text block (a tool call, a plan, a thinking step), or until the turn
ends. Splits the reader already expects — a completed text block before the agent starts
working, or a body longer than the platform's per-message limit — are unaffected.

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
- **an author is never the target**, on any path. This is the one absolute: an agent's
  own reply always matches its own rule, so self-activation would be unconditional
  rather than merely loop-prone;
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

### What `sendMessage` is for

`sendMessage` covers what the ordinary reply cannot do: a different conversation, a
direct message, a postless agent call, or a reply into the parent session. It has **no
visible in-thread form** — every visible send lands at the channel **root**:

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
  or addressing a human, as in case 2a / case 3.

The visible post is suppressed when the wake would be refused for a locally-decidable
reason (capability disabled, invalid target id, self, hop limit, or a local target that
disallows the caller), so a rejected hand-off leaves no misleading post. One accepted
best-effort edge: a target on another daemon whose call policy terminally rejects the
caller can still leave a visible post, because that policy verdict is only known on the
target's daemon after the post is made.

## Self-authored channel roots

When an agent uses `sendMessage` to publish a new channel-root message without waking
another agent (a bare `channel` post — the only post that does not wake a peer), the
returned platform message creates the agent's session for that new thread but does not run
a model turn. The root is already the agent's own output, not a new request: treating it
as an activation can make the agent post it again recursively.

The session starts idle, retains its parent-session lineage, and records the root for
transcript display. The first real reply in that thread receives the root as preceding
context before the new message. Session initialization itself produces no agent output,
tool calls, memory recall or capture, turn evaluation, or token usage.

## Parent-session replies are session-only

`sendMessage({"sessionId":"<parent>", …})` injects an answer into the session that woke
the caller. That delivery is **session-only by default**: the parent agent processes the
input and its work is recorded in the session transcript, but the resumed turn emits no
ordinary IM body, typing indicator, status message, status bar, footer, permission card,
or completion notification. Relaying an answer upward is a hand-off, not a broadcast —
publishing it into the parent's channel would usually duplicate what the child already
delivered.

The parent may still choose to speak: an explicit visible `sendMessage` from the resumed
turn is a new, separately authorized outbound action and behaves normally. So the promise
is "no automatic IM output", not "no IM output at all".

A reply whose parent lives on another daemon carries the same requirement. If that daemon
is too old to run the turn silently, the reply **fails** rather than being downgraded —
the alternative would leak the parent's entire ordinary response into its channel.

## Per-channel trigger

Every channel a bot is in carries a trigger, and every agent gets all three settings —
Off, every message, or @-mention (the default). Off is not a gating feature: an
org-visible agent is entitled to the same control as a restricted one.

Off means the agent does not respond in that channel at all. Not to an @-mention, not to
a follow-up in a thread it had already joined, not to a control command, and not through
a shared bot's slug or default-dispatch fallback. It leaves everything else intact: the
bot stays in the channel, the channel keeps its row and its owner, past sessions keep
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

## Shared-bot channel ownership

Every active channel served by a shared bot has exactly one default agent. A newly
observed or ownerless channel converges to the bot's earliest active agent, and removing
the current owner immediately transfers ownership to the earliest remaining agent.
Console surfaces must show the same effective owner and trigger from every member
agent's integration; they must not expose a `No default` state. The trigger is
replicated across every active membership row, backfilling a missing sibling, so
removing the owner does not discard the channel or its trigger.

A Console owner change preserves the channel's trigger. An in-Slack owner change or
automatic fallback to a restricted agent instead leaves the channel Off, because only
an authorized Console editor may enable it. Direct messages remain per-agent rather
than bot-scoped: every agent may independently enable or disable its own conversation
row.

## Direct messages

Every observed direct conversation appears under **Direct messages** on the Agent's
integration card, for both Everyone and Restricted visibility. A 1:1 DM has one binary
**Off / On** control: On responds to messages in that conversation; Off is an effective
routing fence, not merely display state.

Visibility determines the initial state, not whether the control exists:

- An **Everyone** agent's newly observed 1:1 DM starts **On**, preserving the normal
  open-DM behavior while making it explicitly reversible.
- A **Restricted** agent's newly observed 1:1 DM starts **Off** and remains unroutable
  until a Console editor enables it.

Direct rows are observed incrementally because platforms do not enumerate them as bot
membership. Switching Everyone → Restricted closes every known direct row before the
gated routing configuration is pushed. Switching back keeps the stored choices; the
rows stay visible and configurable.

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

- An **Everyone** agent's newly observed group DM starts on **@-mention** and may be
  changed to Off or Any message.
- A **restricted** agent's group DM is surfaced as a row that starts Off and stays
  unroutable until a Console editor enables it.

A shared bot is one Slack identity, so a mention in a group DM cannot name which agent
behind it is meant, and the slug that disambiguates a shared DM does not apply — a DM
activates on any message, which a slug can outrank, while a group DM activates on the
mention itself. A group DM served by a shared bot therefore converges on exactly one
agent: the bot's earliest active install among those whose row is enabled.

A conversation first mistaken for a channel converts to a group DM once resolved, and
that conversion receives the visibility-appropriate group-DM default (Mention for
Everyone, Off for Restricted): the trigger it carried was not a direct-conversation
choice. The resolved classification is durable — it lives on the conversation row, not
in daemon memory, so a daemon restart that re-reports the conversation provisionally as
a channel cannot reset a later operator choice.

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

**A shared channel is not part of that predicate — in either direction.** An agent-to-agent
wake is postless: nothing is left in any channel, so a shared channel is not evidence of
anything and must not act as an authorization key. It is also not expressible for the
populations that legitimately need to collaborate — peers that share no channel, and agents
with no IM integration at all (webchat, webhook, dreaming, memory-only). A channel may only
**narrow** a directory listing as an optional filter; it can never widen one. A caller
always sees **itself** in a listing, even under a `selected` outbound policy that does not
name it (a self-_wake_ is still refused separately).

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

Every session carries its own visibility, composed with — never widening — the visibility
of the agent that owns it. Platform direct messages, Playground and webchat conversations,
and sessions launched through the Web API default to **private**: only their owner can see
them — deliberately no role exception, org owners included. Channel sessions, group direct
messages, and automation-originated sessions (cron, hook, dream, agent-to-agent) default
to **org**, visible to every member who can already view the agent. A session's initiator
is recorded regardless of tier, and re-classification belongs to that recorded initiator
alone: the person who started a channel conversation may later pull it private, and only a
private session's owner may publish it back. Roles grant no re-classification rights — an
org owner cannot flip someone else's session in either direction.

An agent-to-agent child inherits its parent's visibility, because a delegation copies the
parent's prompt into the child's transcript. Tightening a session therefore cascades to its
descendants; publishing one never does — widening a child stays that child's own decision.

A session the caller may not see is reported as missing, not as forbidden: the console must
not reveal that it exists.

When Slack session access sync is enabled, a public-channel session is visible to a user
with a linked, active full-member identity in that Slack workspace even when the user has
not joined the channel. Private channels and group DMs require current conversation
membership. Guests and Slack Connect users also require current conversation membership,
including for a channel that is public to full members of the installing workspace. The
organization-owner role never bypasses these provider checks.

An external membership check that cannot complete fails closed: affected sessions stay
hidden. The console offers a provider-specific reconnect only when the failure occurred
while retrieving the signed-in user's own federated authorization; provider API failures
and unclassified degradation keep the generic unavailable notice. Feishu versus Lark is
named from the session scope's verified regional app, never from a URL hint. Diagnostics
may retain only the provider target, failure stage, HTTP status, and a bounded upstream
error code — never account ids, bearer tokens, or upstream error messages.
A reconnect that proves a different provider account must not replace the linked identity;
the console tells the user to reconnect with the linked account or unlink before switching.

Making a session private hides its transcript immediately, but agent memory is shared
across the whole agent, so the guarantee about memory is narrower and must be stated
plainly wherever the change is offered: capture into shared memory stops once the owning
daemon acknowledges the change (typically sub-second, surfaced as a pending state until
then), and anything the agent already distilled while the session was org-visible is not
retracted. Until a session's daemon has confirmed the current state, that daemon withholds
capture rather than assuming the session is shareable.

The block covers both ways a session reaches shared memory: the automatic post-turn
distillation, and an explicit write by the agent itself. A private session's memory-write
tools refuse with an explanation rather than failing silently, and reads stay available —
recalling what the agent already knows is not a disclosure of the current conversation.
Dream sessions skip private transcripts entirely.

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
- `native` may be offered only after both the harness's per-agent storage redirect and
  the console read/write root are verified. Redirecting a whole runtime home is not
  sufficient when that home also contains shared auth or unrelated state.

The single source of truth is
[`runtime-memory.ts`](../packages/daemon/src/agents/runtime-memory.ts). Match a known
registry id first and retain a command/args signature fallback for custom aliases and
package launchers such as `npx`. A new harness added to the curated ACP matrix must also
declare its expected `managed` / `none` / `native` capabilities in
[`profiles.ts`](../packages/daemon/test/acp-matrix/profiles.ts); the runtime-memory
contract test compares that declaration with the production policy. Adding or changing
a policy requires a focused env assertion and a source comment naming the verified
runtime lever.

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
content or verbatim from a current `readMemory` result. The injected index is only a
start-of-session snapshot, so instructions and replace-failure feedback must direct the
agent to `readMemory` after another write, when provenance is uncertain, or before
retrying a failed replacement.

## Memory backend selection

Present storage backends in the order `Managed`, `Native`, `External`, followed by a
visually separated `Off` choice. `Off` is the user-facing label for the protocol's
`none` value: it is the absence of persistent memory, not another storage backend.

Until narrower memory scopes are supported, the agent Memory page displays `Scope` as
a fixed, read-only `Agent` value. Its help text must explain that an agent's memory is
shared across every user who interacts with that agent; the console must not imply that
memories are isolated per user.

An existing agent's memory settings are edited as one explicit draft. Selecting a
backend, changing managed distillation, switching an external connection, or editing
external recall/capture policy must not take effect until the user saves the form. While
the draft differs, show both the currently active backend and the unsaved selection or
settings. Content and records continue to reflect the active backend until Save
succeeds.

On the agent Memory page the settings form is collapsed by default behind a one-line
summary of the persisted backend (backend name, its key policy values, and the fixed
Agent scope) so the memory content itself stays the page's focus. Expanding the form
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

An Agent failure is not a code-review finding. When a GitHub review turn ends without a
formal review verdict, keep the internal run failed for observability but complete its
informational Check as non-blocking `skipped`; a runtime failure may still say
`Review could not be completed`. A successfully submitted formal verdict remains
authoritative (`REQUEST_CHANGES` stays `action_required`), and an ambiguous formal-review
write remains a visible failure until it is reconciled.

GitHub's suite-level `Re-run all checks` action starts a new generation for every current
AgentConnect informational review Check in that App suite, with the same live maintainer
authorization and revision fences as a single-Check rerun. It does not depend on the
integration's ordinary event cadence.

Every active informational review Check completed as `skipped` or `failure` offers a
`Request review` action. It targets only that Check's Agent and opens a new generation
for the same revision after the same live maintainer authorization and revision fences.
A retired Check offers no action because it no longer has a live integration to run.
A new review generation following a terminal Check publishes a fresh Check Run: GitHub
keeps a completed run terminal, so reusing it would leave the top-level status and icon
completed while its output claims the review is queued or in progress. The fresh run is
then updated through queued, in-progress, and terminal states; the previous run remains
historical. A request that supersedes an incomplete generation keeps that active Check
instead of leaving it permanently unfinished.

## GitHub maintainer trigger authorization

GitHub Issue and pull-request integrations treat current repository permission—not the
webhook's `author_association` label—as trigger authority. An Issue or pull request whose
author lacks current `write` or `admin` permission does not start an Agent automatically,
even when its body mentions the Agent or App. A current `write`/`admin` maintainer can
explicitly `@` the Agent or App in a comment to request the first turn on that external
thread; the same mention from a read-only user does nothing.

Every comment author is checked live from the comment object; for edit/delete actions,
the top-level webhook sender is not treated as the content author. An unmentioned
comment follows the configured cadence only when both the commenter and the Issue/PR
author still have `write` or `admin` permission. This keeps automatic follow-ups on
maintainer-owned threads while requiring an explicit maintainer summon for externally
authored threads. Native review requests and Check reruns use the same
current-maintainer boundary.

Trigger authorization is separate from effect authorization. A formal PR review still
requires the active HookRun, review policy, Agent repository grant, and GitHub App
permission checks at the moment the review is submitted.

## GitHub review mention routing

An explicit `@<agent-name>` in GitHub targets only that AgentConnect agent's
matching review integration. An explicit `@<github-app-name>` is the broadcast
form and targets every matching review agent for the repository. When both forms
are present, broadcast wins; mentioning an unrelated GitHub user does not change
the configured review cadence.

Mention routing does not bypass the integration's event family, label filter,
installation attribution, live maintainer authorization, or bot-sender veto. A
targeted agent mention narrows an otherwise broader `updated` fan-out, while an
event with no AgentConnect mention continues to follow its configured cadence.
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
there. A `Source` control owns conversion between scratch and GitHub; a single
`Edit` action owns repository, branch, working-subdirectory, and
repository-access settings. Replacing a workspace must replace the file browser
with it: the tree, the open preview, and the git status below the card always
belong to the workspace the card currently describes, never to the one it
replaced.

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

The managed and native Memory file browser uses the same shared inline file editor,
breadcrumb naming field, and header actions as Workspace. It must not introduce a
separate prompt or modal flow for adding or editing files; only the persistence API
and Memory's flat Markdown filename validation differ. File-specific capabilities
belong in the preview summary row: managed Memory exposes `History` there today, and
repository-backed Workspace history must reuse the same action slot and history pane
when it is added.

For a GitHub workspace, show the effective `read` or `write` access beside the
repository. The editor may switch freely between scratch and GitHub, choose another
repository or branch, change the working subdirectory, edit read/write access, or bind
a manual GitHub checkout to the GitHub App. Before a mode, repository, or branch
change, state clearly that saving permanently replaces the current daemon-local
workspace files and cannot be undone. Use an explicit `Replace workspace` save label
for that destructive case. A working-subdirectory or access-only edit preserves the
current checkout.

GitHub workspace settings expose one boolean named `Worktree`. When enabled, each
logical session runs in its own stable Git worktree under the Agent directory, so one
Agent can work on several sessions concurrently without sharing branch or file state.
When disabled, sessions use the primary checkout. New GitHub Agents default to enabled;
existing Agents retain the shared-checkout behavior after upgrade. A fresh manual
Playground may override `Worktree` before its first turn without changing the Agent;
automatic triggers use the Agent setting.

The Workspace tab lets an authorized viewer switch between the primary checkout
and the stable worktree of any visible, unpurged session. Session details place a
Workspace link immediately before Details. For an unpurged session-scoped GitHub
checkout, it opens that session's worktree; for a shared GitHub checkout or Scratch,
it opens the Agent's primary workspace. Its git or folder icon reflects that source.
A session worktree is browse-only in the console: file editing and pull remain actions
on the primary workspace.

The checkout control occupies about one quarter of the Workspace file browser
header, opposite the current file breadcrumb. Its primary choice is named with
the main checkout's live branch, never a generic "Primary checkout" label. With no available
session worktree it is a static branch label with no menu; otherwise it switches
between that branch and the available worktrees. Worktree choices keep their
Session link so changing the viewed files and opening the originating conversation
remain distinct actions. The Source card remains directly above the browser and
names only the repository or scratch workspace; it does not repeat the branch.

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

## Sandbox availability and feature support

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
