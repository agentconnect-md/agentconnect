# Design: Shared Bots and a Unified Inbound Relay

> **Status:** Implemented for Slack and Lark / Feishu HTTP ingress, webchat, and
> webhook ingress. Shared Telegram and Discord ingress are not implemented.
>
> **Naming note:** This is a historical filename. “Shared” here describes the
> relay pool's shared ingress plane, not `Bot.shareable`. `Bot.transport = 'http'`
> selects relay ingress; `Bot.shareable` separately controls whether one bot may
> serve multiple agents.

The relay pool is AgentConnect's public content-ingress plane. It accepts
platform callbacks and browser sessions that cannot terminate at a daemon,
authenticates them, resolves the target agent, and forwards content directly to
the target daemon over `rd/*`.

The Control Plane (CP) remains an orchestration plane. It distributes
credentials, route metadata, relay rosters, and revocations over control
channels. Live message ingress, attachments, replies, and ACP output streams do
not traverse it. Separately, an authorized Web UI request may cause the CP to
proxy a bounded daemon-local transcript, tool-body, memory, or workspace read
without persisting the response. This preserves the data-plane boundary in
[architecture.md](architecture.md); admission and turn control dependencies
remain subject to the [availability contract](high-availability.md).

## 1. Protocol Model

- A Slack bot with `Bot.transport = 'http'` receives Events API and interaction
  callbacks through the relay pool. This is true even when it has a single
  integration.
- `Bot.shareable` is the multi-agent switch within HTTP transport. When it is
  false, normal install validation permits at most a single integration. When
  it is true, the bot can back integrations for multiple agents.
- CP broadcasts each active HTTP bot's assignment to every connected relay.
  The assignment includes the Slack bot token, `signingSecret`, member
  daemons, agent directory, attributed routes, and default target.
- Any relay behind the public load balancer can authenticate and process an
  inbound Slack callback. Bot configuration does not select an ingress owner.
- Agent replies and ordinary platform API calls leave the member daemon
  directly with its bot token. The relay uses the token only for
  ingress-adjacent Slack operations such as identity lookup, channel
  membership refresh, and interactive configuration UI.
- A Slack bot with `Bot.transport = 'socket'` remains daemon-owned and
  single-agent. It does not use the shared ingress path.
- A Lark / Feishu bot with `Bot.transport = 'http'` receives
  `im.message.receive_v1` at `/feishu/events`. It remains single-agent in this
  phase. The relay receives only its Verification Token and optional Encrypt
  Key; the daemon retains `appId` + `appSecret` for all provider API egress.
- A Lark / Feishu bot with `Bot.transport = 'socket'` uses the daemon-owned official
  SDK Long Connection.
- Relay state is an in-memory projection of CP state. Relays do not persist
  message content.

## 2. Inbound Source Categories

| Source class             | Examples                                                        | Why a daemon cannot receive it directly                                | Relay behavior                                                                    | Egress                                                            |
| ------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Public platform callback | Slack Events API and interactions; Lark / Feishu message events | Daemons are outbound-only and do not expose a public callback endpoint | Authenticate the raw HTTP request, arbitrate, then forward over `rd/*`            | Agent replies go directly from the daemon                         |
| Webhook                  | GitHub and generic hooks                                        | The provider requires a public HTTPS endpoint                          | Verify the provider signature, match an attributed rule, then forward over `rd/*` | Follow-up provider API calls go directly from the daemon          |
| Browser session          | Webchat                                                         | The browser needs a public WebSocket endpoint                          | Verify a short-lived CP token and bridge the session to the placed daemon         | Output returns through the relay that owns the browser connection |

Direct integrations are unaffected. If a platform can be consumed safely from
the daemon without a public ingress surface, that direct transport remains
available as a deployment fallback or operator choice.

## 3. Architecture

```text
                     control only
             +--------------------------+
             |                          v
       +-----------+   rc/*       +-----------+
       |    CP     |<------------>| relay pool|
       +-----------+              +-----------+
              |                      ^       |
     roster + |                      |       | rd/* content
      config  |       HTTPS/WSS      |       v
              v   +------------------+  +----------+       ACP
          +--------+                     |  daemon  |------------> agent
          | Slack  |                     +----------+
          | hooks  |                           |
          |browser |<--------------------------+
          +--------+       direct API egress
```

Live content is visible in the source connection, relay memory while routing,
and daemon memory while dispatching. For an authorized bounded BFF read, the CP
may also hold the requested response transiently while proxying it; it does not
persist that content. CP stores control metadata and credential material behind
the configured secret-store seam.

## 4. Decisions

1. **Transport selects ingress.** `transport = 'http'` selects relay-pool
   ingress; `shareable` controls whether that HTTP bot may serve multiple
   agents.
2. **HTTP assignments are pool-wide.** Every connected relay receives the same
   active bot credentials and routing projection because any public callback
   can land on any instance.
3. **Routing happens at ingress.** CP compiles routes with explicit
   `{ agentId, daemonId, integrationId }` ownership. The relay arbitrates and
   sends one pre-addressed `rd/msg` per selected conversation participant; a
   target daemon does not repeat the routing ladder.
4. **Daemons initiate data-plane connections.** A daemon remains an
   outbound-only edge node and dials every relay in its CP-provided roster.
5. **Relays initiate control connections.** Each relay authenticates and
   registers with CP, receives its projection, and reports metadata-only
   changes.
6. **No relay-to-relay forwarding.** Public ingress must land on a relay that
   already has the target daemon connection. The baseline unsharded roster
   achieves this through daemon-to-pool connectivity.
7. **Delivery is bounded-loss.** Slack must receive a fast HTTP response.
   Successful HTTP acknowledgement does not mean a daemon durably accepted the
   event. Offline or unreachable targets are dropped and counted.
8. **No content persistence.** A durable broker or inbox would change the
   privacy and delivery model and requires a separate design decision.

Sharing across organizations, multi-tenant provider-owned Slack apps, and
pooled Telegram or Discord ingestion are outside the current implementation.

## 5. Logical Relay Connectivity

This section defines the address and identity contract required by the
protocol.

The relay has two distinct address surfaces:

- `PUBLIC_RELAY_URL` is the stable pool-wide HTTPS/WSS origin behind a load
  balancer. It serves Slack callbacks, hook ingress, and webchat. Requests may
  land on any healthy instance.
- `Relay.daemonUrl` is the daemon-facing address registered by a specific
  relay. It must route stably to that instance, using per-instance DNS or an
  instance-sticky path.

CP distributes alive relay entries as `{ relayId, url }`. Each daemon converges
an outbound WebSocket for every roster entry. During `rd/hello`, the relay
returns its `relayId`; a mismatch means the daemon reached the wrong instance,
so it closes the connection and retries with backoff.

Random load balancing is valid for the public origin but not for a registered
`daemonUrl`. Without stable daemon routing, roster state would not describe
the actual socket topology and a callback could land where its target daemon is
absent.

All active Slack and Lark / Feishu HTTP assignments, hook rules, and other pool-served
projections are broadcast to the connected pool. A newly registered relay
receives a full replay. Relay restart therefore reconstructs state from CP
rather than local disk.

Per-thread order is preserved only along the selected daemon connection.
Separate callbacks can land on different relay instances, so stable
idempotency keys and daemon-side deduplication are required.

## 6. CP Data Model

The relevant model is:

```prisma
model Relay {
  id         String    @id @db.Uuid
  name       String    @unique
  daemonUrl  String
  lastSeenAt DateTime? @db.Timestamptz(6)
  createdAt  DateTime  @default(now()) @db.Timestamptz(6)
}

model Bot {
  id           String         @id @db.Uuid
  shareable    Boolean        @default(false)
  transport    SlackTransport @default(socket)
  integrations Integration[]
}

enum SlackTransport {
  socket
  http
}

model SharedThreadAgent {
  botId      String   @db.Uuid
  sessionKey String
  agentId    String   @db.Uuid
  daemonId   String   @db.Uuid
  updatedAt  DateTime @updatedAt @db.Timestamptz(6)

  @@id([botId, sessionKey])
  @@map("shared_thread_agent")
}

model SharedThreadParticipant {
  botId      String   @db.Uuid
  sessionKey String
  agentId    String   @db.Uuid
  daemonId   String   @db.Uuid
  updatedAt  DateTime @updatedAt @db.Timestamptz(6)

  @@id([botId, sessionKey, agentId])
  @@map("shared_thread_participant")
}
```

`Integration.botId` is not unique because a shareable bot can back multiple
agent integrations. The integration create path enforces the single-install
limit for non-shareable bots.

Slack HTTP bots require both a bot token and signing secret in the bot secret
store. Lark / Feishu HTTP bots require `appId`, `appSecret`, Verification Token, and an
optional Encrypt Key. Secret reads and writes pass through the configured
`SecretCipher`; list and metadata APIs do not select secret material.

`IntegrationChannel.agentId` represents a conversation-scoped default agent. Exactly
one active integration row carries that owner for each shared conversation, including
an observed DM or group DM; sibling rows are null because membership is repeated per
integration.
`SharedThreadAgent` is the durable fallback for relay-local thread affinity. It
contains routing metadata only, never message text.
`SharedThreadParticipant` is the independently durable participant set. It lets
any healthy relay replica reconstruct every joined target after a restart or a
public-callback load-balancer hop without turning the legacy owner into a set.

## 7. Protocol

### 7.1 Relay and CP (`rc/*`)

The relay connects to `/api/v1/relays/ws` and uses a frame union separate from
daemon control and relay-daemon traffic.

```ts
rc/auth       { method: 'token' | 'apikey', credential }
rc/register   { name, daemonUrl }
rc/heartbeat  {}

rc/bot-assign {
  botId,
  platform,
  botUserId?,
  apiAppId?,
  secrets:
    | { botToken, signingSecret }         // Slack
    | { verificationToken, encryptKey? } // Lark / Feishu
  members: { daemonId, agentIds }[],
  agents: { agentId, name, daemonId }[],
  routes: { agentId, daemonId, integrationId, scope?, match }[],
  defaultAgentId?,
  defaultDaemonId?
}
rc/bot-unassign { botId }
rc/routes       { botId, members, agents, routes, defaultAgentId?, defaultDaemonId? }

rc/thread-assign    { botId, sessionKey, agentId, daemonId }
rc/assign           { botId, sessionKey, agentId, daemonId }
rc/thread-lookup    { botId, sessionKey }
rc/thread-lookup/ok { botId, sessionKey, target }

rc/bot-channels      { botId, channels }
rc/set-channel-agent { botId, channelId, agentId }
rc/bot-revoked       { botId, reason, credentialRevision?, eventAtMs?, evidence?: 'event' | 'probe', code? }
rc/bot-credential-check { botId, credentialRevision, result: 'ok' | 'rejected', code?, observedAtMs }
rc/daemon-revoke     { daemonId }
rc/verify            { kind: 'daemon-key' | 'daemon-token' | 'webchat-token', credential, daemonId?, conversationBinding?: 'v1' }
```

`rc/bot-assign`, `rc/routes`, and `rc/assign` are broadcast to the pool.
`rc/thread-assign` and `rc/bot-channels` are relay reports to CP. Route and
credential frames use full-replace or idempotent-upsert semantics so replay
converges cleanly. `rc/bot-revoked` and `rc/bot-credential-check` are the
acknowledged reports: the relay keeps each until the CP replies, and the CP
revokes only on the first and only marks the bot on a rejected check
([preset-agents.md](preset-agents.md) §5.3). Both come from a platform event or
from the relay's credential probe (Slack's `auth.test`), which runs when a bot is
assigned and then every `RELAY_CREDENTIAL_PROBE_INTERVAL_SEC` seconds (default
3600, jittered). A definitive answer (`account_inactive`, `token_revoked`) is an
`rc/bot-revoked` with `evidence: 'probe'` and the code; an ambiguous
`invalid_auth` is a `rejected` check and a success an `ok` check, sent once per
change for the probed revision and again after each registration. Because
`invalid_auth` depends on the caller's address, the CP keeps each relay's latest
observation (strictly newer per relay, fenced on the current revision) and marks
the bot while any relay's is `rejected`. Those rows go when the sweeper removes
their relay or a fresh credential lands. A CP that does not advertise
`bot-credential-check-v2` receives neither the check nor the new
`rc/bot-revoked` fields, and the relay reports `invalid_auth` to it as a
revocation, as before.

Hook assignments and removals follow the same pool-wide projection pattern.
Hook run reports carry identifiers and status, not the original payload.

### 7.2 Relay and Daemon (`rd/*`)

The daemon dials the relay's per-instance `/rd/ws` endpoint.

```ts
rd/hello    { apiKey, daemonId }
rd/hello/ok { relayId }

rd/msg {
  source: 'im' | 'slack_action' | 'hook' | 'webchat',
  agentId,
  sessionKey,
  msgId,
  // source-specific routing identifiers and payload
}
rd/ack  { msgId, accepted, turnId?, reason?, routeAdmission?, recoverable? }
rd/chat { chatId, seq, event }

// By decision routing (message-intake.md §6)
rd/route            { deliveryId, botId, sessionKey, toAgentId, frozenDaemonId, payload, selection, via?, backfill? }
rd/route/ack        { deliveryId, disposition: 'admitted' | 'rejected' | 'retry', reason?, daemonId? }
rd/route/report     { botId, sessionKey, channel, owner?, participants }
rd/route/report/ack { accepted, reason? }
```

`rd/msg` already names the destination agent. IM payloads contain normalized
message data and attachment metadata; attachment bytes are fetched by the
daemon directly from the platform. A webchat turn may instead carry one inline
PNG, JPEG, or WebP image: the browser rasterizes and compresses it to at most
160 KiB before sending, leaving room for base64 expansion under the 256 KiB
frame ceiling. The relay forwards those bytes without storing them. `rd/chat`
is used only to return webchat output to the browser connection held by that
relay.

An `im` ack from a daemon advertising `im-admission-v1` also carries
`routeAdmission` and `recoverable` beside the unchanged `accepted`/`reason`
pair when the delivery went through a platform strategy with an admission
member: `admitted` for a durable admission, or `rejected` with `recoverable`
saying whether a resend can succeed. The shared best-effort path acks on
dispatch, before durability, and carries no verdict. The relay's
`RelayIngressHost.forwardStrict` maps the verdict onto the `rd/route/ack`
dispositions for a platform whose HTTP answer depends on admission
([google-chat-integration.md](google-chat-integration.md) §4), and reads a
verdict-less ack, like a daemon without the feature, as
`rejected`/`unsupported` rather than through the old shape; `forward` keeps
its two-value result.

In a By decision routed conversation the relay sends each human message once,
as an `rd/msg` carrying a relay-minted `trustedRouting` (the constraint with
participant flags and the bot's candidate directory), to the evaluation host
only; it never falls back to per-candidate delivery. The host distributes a
frozen remote target with `rd/route`: the relay checks the socket is the named
host, resolves the target from its own directory, and forwards an `rd/msg` with
a relay-stamped `trustedRouteSelection` whose `hostDaemonId` comes from the
authenticated socket. Once every target of a selection is terminal, the host's
`rd/route/report` names the owner (set only where no affinity exists) and the
admitted participants, which the relay persists through `rc/thread-assign` and
`rc/thread-participant`; an unaccepted report is resent with backoff for a bounded
window (a converged `not_host` ends it), and the relay's affinity guard makes a
resend idempotent. The relay advertises `decision-routing-forward-v1`
in `rd/hello/ok`, and sends either routed field only to a daemon advertising
`decision-routing-v1`.

The same authenticated data plane also carries cross-daemon collaboration
frames. Their authorization rules are defined in
[agent-collaboration-implementation.md](agent-collaboration-implementation.md);
they do not alter shared-bot ingress arbitration.

### 7.3 Daemon Integration Spec

An HTTP bot member receives a send-only provider specification. Slack uses:

```ts
slack: {
  mode: 'shared',
  shareable,
  botToken,
  bindRules: []
}
```

The daemon receives neither the Slack signing secret nor relay-side routes.
Inbound arbitration has already happened. A socket-transport integration keeps
the direct specification and its daemon-owned connection.

Lark / Feishu uses:

```ts
feishu: {
  mode: 'shared',
  appId,
  appSecret,
  botOpenId,
  region,
  bindRules: []
}
```

The daemon uses these API credentials for replies and attachment downloads but
does not open `WSClient`. The relay never receives `appSecret`.

## 8. Relay-to-CP Authentication

The first control frame is `rc/auth`. CP supports:

- an instance-shared `RELAY_TOKEN`, compared in constant time and disabled
  when unset; or
- an org-less API key whose `principalType` is `relay`, verified through the
  existing pepper-hash key store.

Each relay process is configured with exactly one credential form. A successful
authentication returns the heartbeat cadence, after which the relay registers
its stable instance name and daemon-facing URL. Registration name is the
relay row's upsert key; the credential does not define instance identity.

The shared token is suitable only where the entire relay pool shares a single
operator trust boundary. Per-relay keys provide individual rotation,
expiration, revocation, and auditability. Credentials come from runtime secret
configuration and must never be logged.

## 9. Daemon-to-Relay Authentication

The daemon presents in `rd/hello` whatever it presents on its control socket:
its daemon API key, or — for an in-cluster daemon — the projected ServiceAccount
token, which wins when both are present. Because the relay has no database, it
delegates verification to CP with `rc/verify(kind = 'daemon-key' |
'daemon-token')` and caches the successful identity for the life of that socket.

The claimed `daemonId` travels with the token so the CP can require it to match
the cloud member record bound to the TokenReview-attested Pod UID (see "Identity is per Pod,
not per org" in [k8s-daemon-pool.md](k8s-daemon-pool.md)). Forwarding it
unverified is safe because the reviewed identity, never the claim, decides.

The claimed `daemonId` must match the identity resolved from the credential.
CP can send `rc/daemon-revoke` when authority or placement changes; each relay
then closes the matching connection and stops routing to it.

Existing authenticated sockets can continue through a CP outage. A new daemon
socket cannot be authenticated until the CP verification path recovers.

## 10. Inbound Routing

### 10.1 Slack arbitration

CP compiles attributed routes from active integrations, placed agents, and
conversation settings. The relay applies the shared routing ladder:

1. an explicit agent selection or scoped conversation owner;
2. existing thread affinity;
3. agent-slug keyword disambiguation;
4. the conversation's own default agent, where the platform compiles a row's
   owner to a default rather than to a scoped ownership route
   ([linear-integration.md](linear-integration.md) §6.2 — empty elsewhere, so
   the rung is invisible on every platform that does not use it);
5. the bot's default agent for a bare mention or direct message.

Before compiling routes, CP converges each observed conversation to one canonical
owner row and replicates its effective trigger across the sibling membership rows,
backfilling a missing row when a new install has not reported membership yet. A new
or ownerless conversation uses the earliest active integration, and a Console owner
change preserves the trigger. An in-Slack move or automatic fallback to a restricted
agent stays Off. Shared DMs and group DMs therefore have one scoped route, not one
route per installed agent or a per-agent slug fan-out. If that owner is active but
currently unplaced, CP emits no scoped route and adds the conversation to the relay
mute fence so it cannot fall through to another agent's unscoped default. This
availability fence does not count as `gatedOffChannels`; the trigger remains On.
This also preserves state and repairs ownership when an integration is removed;
`No default` is not an operator state.

Each target contains `agentId`, `daemonId`, and `integrationId`. A verified
AgentConnect-authored final is admitted through the collaboration policy and
hop/loop fences, then sent independently to every other participant. Unverified
managed-bot echoes still fail closed, and third-party bots remain exact-mention
only.

Channel membership changes trigger a coalesced Slack membership refresh. The
relay reports the complete channel snapshot through `rc/bot-channels`; CP
updates control metadata and recompiles routes.

Interactive controls rendered by a session carry an opaque target bound to the
exact agent, integration, and session that rendered them. They do not follow a
later channel-owner change. The app-level message shortcut starts only with the
selected message's channel and thread: the relay resolves current conversation
ownership, then the daemon resolves and authorizes the exact bot-scoped session.

### 10.2 Durable thread affinity and participants

Thread affinity uses three control legs:

1. The relay routes a new thread and reports its target through
   `rc/thread-assign`.
2. CP persists `(botId, sessionKey) -> { agentId, daemonId }` and broadcasts
   `rc/assign` to every connected relay.
3. On a local miss for an unmentioned thread follow-up, the receiving relay
   asks CP through `rc/thread-lookup` and caches the result.

Conversation membership uses the same control channel without overloading the
single owner. A relay reports each newly joined target with
`rc/thread-participant`; CP upserts `(botId, sessionKey, agentId) -> daemonId`,
broadcasts `rc/participant-assign` to the pool, replays the set to a restarted
relay, and returns the whole set with `rc/thread-lookup/ok`. Owner reports also
seed their target as a participant. These rows are control-plane routing
metadata only. The separate participant frames keep mixed-version peers from
mistaking a member update for a compatibility-owner replacement.

If CP is unavailable during a lookup, the follow-up is dropped rather than
routed to a different agent. A later explicit mention can re-anchor the
thread. Pending assignment reports and channel snapshots are bounded and
retried when the relay control connection becomes ready.

### 10.3 Hooks and webchat

Hook rules are compiled by CP and matched in the relay after signature
verification. A match produces a pre-addressed `rd/msg(hook)`. Accounting
returns over a control channel without the original payload. The detailed
rules remain in
[webhook-triggers-and-github-events.md](webhook-triggers-and-github-events.md).

A webchat browser presents a short-lived CP-minted token. For a new
conversation, CP allocates its id and persists only the ownership tuple
`(conversationId, userId, agentId, orgId)`. A resume mint succeeds for the
owner of that tuple, and for any other non-viewer member whom the
`session.continue` policy admits to every session the conversation currently
stands on (an org-visible session is continuable by the organization; a
private one stays its owner's, and a conversation with no turn yet has no
session to judge, so it is the owner's alone); unknown and foreign ids fail
closed. The token carries the authorized conversation id, and the relay uses
that token-bound value rather than trusting the browser query. Every
verification re-reads the token owner's organization membership and requires
them to still see every agent in the conversation; the relay reuses a
successful verdict for at most a minute and never past the token's expiry, so a
removed member or a revoked share stops dialing within a minute. A socket that
is already open is not closed by either check. The relay then resolves
the agent's current daemon placement and bridges browser turns and daemon
output without routing arbitration. Webchat verification carries a
`conversationBinding: 'v1'` fence and uses a v2 token-signing domain so mixed
old/new CP and relay instances fail closed instead of silently downgrading.
Conversation bodies remain daemon-local. While a turn is active or recently
completed, the daemon retains a bounded, short-lived output window keyed by the
browser-allocated turn id. A reconnecting browser reports its last contiguous
output index and an increasing connection generation through any healthy relay;
the browser rejects frames for any other turn while the daemon rejects stale
generations, rebinds the live stream, and replays the missing tail. The
transport that admitted the turn keeps receiving it after a rebind, so a
watcher that attaches mid-turn, such as the console opening a conversation an
Agent chat API request is streaming, never starves the requester. This window
is volatile, has explicit size and age limits, and does not create a durable
transcript or offline inbox.
An optional image upload follows the same browser-to-relay-to-daemon content
path, is bounded to one compressed image per turn, becomes an ACP image prompt
block at the daemon, and is never persisted by the relay or Control Plane.

### 10.4 Agent chat API

**Status:** The relay's `/ai-sdk/agents/:agentId/chat` and
`/ag-ui/agents/:agentId/chat` routes, the UI message stream and AG-UI encoders,
turn admission, key verification with its verdict cache, key permissions and
agent selection, and the per-agent API entry with its Console card are
implemented. The rest is proposed.

Chat frontends built on the AI SDK's `useChat`, such as a documentation site's
Ask AI panel, speak the AI SDK UI message stream protocol: one HTTP POST per
turn, answered with SSE parts under `x-vercel-ai-ui-message-stream: v1`. The
agent chat API serves that protocol from the relay, over the same conversation
binding and `rd/*` bridge as webchat. A caller presents its API key on every
request, the way a server calls a model API; there is no token step. A browser
never holds the key: a web app puts a same-origin route in front of the relay
that adds the key and forwards the request unchanged.

    POST <PUBLIC_RELAY_URL>/ai-sdk/agents/:agentId/chat
    Authorization: Bearer <API key>
    body: the useChat request, { id, messages, ... }

AG-UI clients, such as `@ag-ui/client`'s `HttpAgent` and the frontends built on
it, are served the same way over the AG-UI protocol: one POST per run, answered
with AG-UI events as SSE.

    POST <PUBLIC_RELAY_URL>/ag-ui/agents/:agentId/chat
    Authorization: Bearer <API key>
    body: an AG-UI RunAgentInput, { threadId, runId, messages, ... }

The key is an ordinary API key admitted for `agent:chat` whose selection
includes the agent, or a `full` key; a `read` key and a read-only OAuth token
are refused
([daemon-api-key-auth.md §6](daemon-api-key-auth.md#key-permissions-and-agent-selection)).
A personal key's conversations are its user's. A
[service-account member](daemon-api-key-auth.md#service-account-members), a
non-signing-in member that an owner creates and whose keys an owner mints, uses
the same permission and selection, and its sessions are org-visible by
identity. Nothing on this path forks on which of the two holds the key.

The agent must also accept the API. An agent's owner adds it under the agent's
Integrations, one entry per protocol (`ai-sdk-ui`, `ag-ui`), stored as an
`agent_api_entry` row and managed through `GET /agents/:agentId/api` and
`PUT`/`DELETE /agents/:agentId/api/:protocol`. A key's selection says which
agents its holder may reach; the entry says the agent is reachable over this
API at all, so a key selecting every agent still reaches only the agents that
added it. `rc/verify` returns the agent's entries as `apiProtocols`, and each
route answers 403 `api_disabled` when they do not name its protocol.

In the Console, API sits in the Add integration dialog's Workflow group, where
the owner picks AI SDK UI or AG-UI, preselecting the first one the agent has not
added; ACP 2, the remote ACP endpoint under Relation to ACP below, is listed as
coming and cannot be picked yet. The agent's Integrations tab then shows one API
card with a row per protocol and a single remove action. Each row's Quickstart
shows that protocol's chat endpoint, examples for curl, Node, and the browser
(`useChat` or `HttpAgent` behind a same-origin route that adds the key), and the
Agent chat keys that reach the agent: the caller's own, and for an owner each
service account's. Its Create key opens the key dialog preset to Agent chat on
that agent, with an Owner choice of the caller or, for an owner, a service
account.

**Verification:** the relay holds no database, so it asks the CP.

1. The relay sends `rc/verify { kind: 'agent-chat-key', credential, agentId,
chatId }`.
2. The CP authenticates the key with the same hash lookup as HTTP and applies
   the checks an HTTP route declaring `agent:chat` would: the permission, the
   selection, a membership in the key's org, and `canView` on the agent. It
   then resolves the conversation below and answers the verdict a webchat token
   gets: identity, agent, placement, conversation, roster, and `apiProtocols`.
   A refusal names its reason, which the relay answers as 401 for an unknown or
   revoked key, 403 for a key without the permission, 404 for an agent the key
   cannot reach, 409 `agent_moved` for the fence below, and 503 `no_agent` for an
   agent with no live daemon.
3. The relay caches an `ok` verdict for 60 seconds per instance, keyed by the
   hash of the key, agent, and chat id. A turn inside that window never touches
   the CP.

Revoking the key, removing the API entry, or losing access to the agent takes
effect within those 60 seconds. The cache is per instance, and a turn can land
on any instance behind `PUBLIC_RELAY_URL`, so during a CP outage a conversation
keeps working for up to 60 seconds only where it was already verified; new
conversations wait for the CP.

**Conversation:** the body's `id`, the chat id `useChat` generates, names the
conversation; it is 1 to 128 characters. On the AG-UI route the `threadId` plays
that part, and the `runId` is only echoed on the run's events. The CP maps it to
the webchat conversation `uuidv5(org, key owner, agent, chat id)`. The first
turn creates it, owned by the key's user, converging when two first turns race;
a later turn resumes it under the existing rules, including the 409 fence for an
agent whose next turn would reach a machine that does not hold its session.
Because the owner is part of the id, the same chat id sent with another member's
key is a different conversation, and a chat id can never reach a conversation
someone else owns. A same-origin route may therefore forward the `useChat` body
as is: a visitor reaches only the conversations its own random chat ids name. A
new chat is a new id. The protocol is not part of the id, so one key sending one
id over both routes reaches one conversation, and turn admission below spans
both.

The relay turns the last user message's text into a webchat turn. It ignores
the earlier messages, because the daemon session already holds the history, and
on AG-UI also the request's `tools`, `state`, `context`, and `forwardedProps`.
The turn carries no delegated MCP entitlement, and the relay streams the turn's
`rd/chat` output back in the route's protocol.

**Scope:** each route exposes one operation, a text turn to the path's agent,
and the AI SDK route also the answers to that turn's questions below; the AG-UI
route reads nothing else from its request. The webchat token route is the
console's alone: a key admitted only for `agent:chat` cannot mint a token, so the
browser socket's other operations, runtime and permission changes, per-turn
overrides, `targets`, `mentions`, and MCP App calls, are out of the key holder's
reach. The daemon's `allowRuntimeChangesInChat` gate is unaffected.

| `rd/chat` output            | UI message stream                                                           | AG-UI                                                     |
| --------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------- |
| turn admitted               | `start`, `start-step`                                                       | `RUN_STARTED`                                             |
| `message`                   | `text-start` / `text-delta` / `text-end`                                    | `TEXT_MESSAGE_START` / `_CONTENT` / `_END`                |
| `thinking`                  | `reasoning-start` / `reasoning-delta` / `reasoning-end`                     | `REASONING_START`, `REASONING_MESSAGE_*`, `REASONING_END` |
| `tool_call`, `tool_update`  | `data-tool`, keyed by `toolCallId`                                          | `ACTIVITY_SNAPSHOT` `tool`, one per `toolCallId`          |
| `plan`                      | `data-plan`                                                                 | `ACTIVITY_SNAPSHOT` `plan`                                |
| `session_info`              | `message-metadata` with the title                                           | `CUSTOM` `session_info` with the title                    |
| `notice`                    | `data-notice`                                                               | `ACTIVITY_SNAPSHOT` `notice`                              |
| `done`                      | `finish`                                                                    | `RUN_FINISHED`, `cancelled` outcome for a cancelled turn  |
| `done` with `error`         | `error`, with the reason                                                    | `RUN_ERROR`, with the reason                              |
| `elicitation`               | `agentconnect_ask` tool call; the stream ends                               | dropped                                                   |
| `permission`                | `agentconnect_approval` tool call with an approval request; the stream ends | dropped                                                   |
| MCP App, `superseded` kinds | dropped                                                                     | dropped                                                   |

A rejected ack arrives before any output, so the relay answers it with an HTTP
status instead of a stream: 409 for `busy`, 422 for `declined`, 503 when the
agent cannot take the turn now (`no_agent`, `paused`, `draining`), 502
otherwise, with the ack reason in the body. A daemon link that drops mid-turn
ends the stream with `error`.

**Questions and approvals:** on the AI SDK route an API turn's questions go to
its caller, in the AI SDK's own tool shapes, so `useChat` answers them with
`addToolOutput` and `addToolApprovalResponse` and a client may answer them in
code. The daemon marks the turn with its `origin` and treats a protocol in
`API_CALLER_ANSWER_PROTOCOLS` this way:

- An elicitation (an MCP form or URL ask, AskUserQuestion, a memory-write
  approval) streams as today's webchat card. The relay hands it out as a
  dynamic `agentconnect_ask` tool call whose input is the card, finishes the
  step with `tool-calls`, and ends the response without cancelling the turn.
- A runtime approval, an ACP `session/request_permission` or an MCP tool
  approval, streams as a `permission` event with the tool and its one-line
  detail, handed out as an `agentconnect_approval` tool call carrying a
  `tool-approval-request`. It is not an Agent editor's request yet: a refusal
  selects the runtime's narrowest reject option (an MCP approval declines) and
  no editor ever sees it, so a public client that refuses every approval in
  code never reaches the editors. An allow takes the narrowest allow option when
  the key's owner could decide the request in the console, a `full` key whose
  owner may write in the org and edit the agent, which the CP returns as
  `callerApproves`. Any other allow becomes an ordinary editor request, with its
  notice on the caller's stream, and the turn waits for that decision.

Each tool call's `providerMetadata.agentconnect` names the turn and the output
index it was handed out at, and the AI SDK returns it on the part. A request
whose last message is the assistant's, holding answered parts of ours, resumes
that turn rather than starting one: the relay `attach`es, `resume`s the stream
after that index, and forwards each answer as `elicitation_choice` or
`permission_choice`, stamped with the key's owner and `mayAllow`, then streams
the rest of the turn into the same assistant message. Any relay instance can
take it, since the stream rebinds on the daemon. An answer whose turn has ended
gets 409 `turn_ended`. A caller who sends a new message instead of answering has
moved on: the daemon cancels the waiting turn before the new one meets its gate. One
that does neither for `API_CALLER_ANSWER_TIMEOUT_MS`, 10 minutes, has its turn
cancelled by the daemon. On AG-UI, whose stream carries neither, both keep the
console behavior: approvals wait for an Agent editor, and elicitations for an
answer from the console's live session.

**Decision gate:** an added API can carry a Decision gate, a
`ChannelDecisionGate` chain saved through
`PUT /agents/:agentId/api/:protocol/gate` and stored in the agent's `apiGates`,
keyed by protocol. The AgentSpec ships each gate with the Decisions its chain
names, the way a code-host routing rides its host's spec, so admission reads
nothing from the CP: editing one of those Decisions bumps and re-pushes the
agent, and a gate whose condition no longer fits its Decision is left out of the
spec until it is saved again. The relay marks each agent chat API turn with its
route's protocol as `origin`, and the daemon evaluates that protocol's chain on
the turn's text where the op enters it, before a plain turn and a
session-targeted continuation diverge and before anything is recorded. An
answered no refuses the turn as `declined`; a match admits it; and, as with
every chat gate
([decisions.md §5](decisions.md#5-provider-execution-and-failure-behavior)), an
evaluation that is unavailable, over capacity, or past its deadline, inside the
relay's five-second acknowledgement, admits it. The daemon advertises
`api-decision-gate-v1`, and the CP refuses to save a gate (409
`DECISION_UNSUPPORTED_CONSUMER`) while a connected daemon serving the agent
lacks it; an offline one takes the gate from its reconnect roster. Removing the
API removes its gate, and a Decision a gate names cannot be deleted. In the
Console, each API row carries the same Decision chip and rules modal as a
channel's By decision; the modal's subtitle and help name what the API gate
judges, the call's own message.

The daemon records each gated turn's verdict in its own `decision_api_gate_evaluation`
table, keyed by agent and protocol, in the shape a channel gate's Recent evaluations
read: Triggered when the gate admitted the turn, Skipped when it refused it, and
Unavailable when it admitted it unanswered, with the frozen Decision, the call's text
and caller, the answer, the chain trace, and the root step's provider JSON. The CP
proxies `GET /agents/:agentId/api/:protocol/evaluations` and `.../evaluations/:seq`
from a serving daemon advertising `api-gate-evaluations-v1`, only to callers who can
edit the agent, since the rows are callers' messages; nothing is persisted on the CP.
The rules modal on an API row opens them in the Recent evaluations drawer. Bodies
expire after 24 hours or 20 newer verdicts per API, summaries after seven days.

**Try a message** on an API row previews a draft gate through
`POST /agents/:agentId/api/:protocol/gate/preview`, for callers who can edit the
agent. Its sample is the gate's own state minus what the agent binds —
`currentMessage.text` with an empty `history` (decisions.md §9.3) — and the CP
sends it to a serving daemon advertising `decision-preview-v1` exactly as the live
gate would build it (`source: 'chat'`, the agent, the text cut to 8 KiB). Nothing is
written; an unavailable evaluation reads as admitted, never refused.

Tool activity arrives as `data-tool` parts rather than AI SDK tool parts, and
as AG-UI activity snapshots rather than `TOOL_CALL_*` events, because webchat
carries a tool's title and status but not its name or arguments. A client that
ignores data parts or activities shows text only. Each protocol is one encoder
behind a shared interface over the `rd/chat` stream. AG-UI message ids are
prefixed by the turn, because an AG-UI client keeps ids unique across the
thread and a later run would otherwise replace an earlier run's plan. Each
stream's framing, the run or message boundaries, the terminator, and the
response headers, is pinned by tests that parse the relay's output with that
protocol's own client, `ai` and `@ag-ui/client`, not by string assertions.

**Protocol support across versions:** a protocol after the first names a daemon
feature, `api-ag-ui-v1` for AG-UI, which the daemon advertises to the CP and on
`rd/hello`. The relay refuses an AG-UI turn with 503 `unsupported` rather than
send it to a daemon without the feature, following a `not_holder` re-route the
same way. The CP refuses to add the API, and to save its gate, with 409 while a
connected daemon serving the agent lacks it; one offline then takes both from
its reconnect roster. The protocol fields a daemon decodes, a turn's `origin`,
`AgentSpec.apiGates` keys, and the gate evaluation requests, are plain strings
on the wire, so a later protocol never fails an older daemon's decode, and the
daemon refuses a turn whose `origin` it does not know as `unsupported`.

**Turn admission:**

- The relay allows one turn in flight per conversation. A second POST for the
  same conversation answers 409. This is correctness, not a rate bound: the daemon never queues
  a webchat turn, it steers a second message into the live turn or refuses
  `busy` (#1847), so a forwarded second POST would land inside the first turn
  and get no stream of its own.
- The slot is held until the daemon's `done` for that turn, not until the HTTP
  response ends. Closing the HTTP stream does not cancel the turn; the AI
  SDK's `stop()` aborts only the fetch, and the turn finishes into the session
  transcript. The slot is also released when the daemon link that admitted
  the turn drops, since its `done` can no longer arrive there, and after a
  30-minute silence as a last resort, which also sends the daemon a `cancel` so
  the conversation is not left busy. A stream that hands the caller a question
  releases the slot when it ends.
- The response carries only output whose `turnId` is the admitted turn's.
  Output from another participant on the same conversation, such as a browser
  socket, is not forwarded.

**Resume (later milestone):**

- `GET <PUBLIC_RELAY_URL>/ai-sdk/agents/:agentId/chat/:id/stream`, called with the
  key, issues `attach` and then `resume` from index `-1` against the daemon's
  bounded output window (§10.3).
- The replay works only while that window still holds the turn from its first
  output. Once the window has trimmed the head, the daemon refuses with
  `stream_gap`, because a tail alone cannot rebuild the reply.
- The route answers 204 for `stream_not_found` and for `stream_gap` alike. 204 is
  the no-active-stream answer that `useChat({ resume: true })` expects.
- A reply the visitor could not resume stays in the console transcript. This
  path defines no tail-only recovery.

**Sessions and limits:**

- The session is a webchat session of the key's user, classified by the
  existing webchat rule in
  [session-visibility.md §4.2](session-visibility.md#42-default-rules):
  `private`, owned by that user. The conversation records the key that opened
  it, and the console shows that key's name as the session's source, where a
  console conversation reads Playground.
- The admission bound above is per relay instance, not a global cap. There is
  no per-key request limit; personal keys are unlimited on every route, and
  this route is no exception. Per-visitor limits belong to the same-origin route.
- Usage is metered on the agent, as for any other turn.
- The key adds no tool restriction. An agent behind a public proxy receives
  untrusted input on every turn, so its own configuration is the boundary: no
  secrets, no write access to repositories, and a sandbox backend that isolates
  untrusted input ([daemon-sandbox-backends.md](daemon-sandbox-backends.md)).
  An audience narrower than the organization is drawn with an organization:
  a documentation agent whose visitor conversations should stay with its
  maintainers lives in an organization of its own.

**Relation to ACP:** this path is a lossy projection for chat UIs. A remote ACP
endpoint for agent clients such as editors would carry full fidelity, and the
two can coexist. It is proposed as the next protocol an agent can add, ACP 2,
as its own `AgentApiProtocol` entry.

**Milestones:**

1. **Relay:** the chat route, the UI message stream encoder, and turn
   admission.
2. **CP and Web:** key permissions and agent selection
   ([daemon-api-key-auth.md §6](daemon-api-key-auth.md#key-permissions-and-agent-selection))
   and the personal key dialog's two new choices.
3. **CP, relay, and Web:** the per-agent API entry and its Integrations card; it
   replaces the agent detail page's unfinished API tab.
4. **CP and relay:** the key on the chat route itself: `rc/verify` for an agent
   chat key, the chat id's conversation, and the 60-second verdict cache. It
   replaces the first design's token step, in which a proxy minted a webchat
   token with the key and sent turns under the token.
5. **Relay:** the stream-resume route.
6. **Protocol, CP, daemon, relay, and Web:** AG-UI as a second protocol, with
   its feature gate across versions.

Later, separately: the
[service-account member](daemon-api-key-auth.md#service-account-members).

## 11. Daemon Responsibilities

- `relay-manager.ts` converges the CP-provided relay roster.
- `relay-client.ts` maintains the authenticated `rd/*` connection, validates
  the echoed relay identity, and dispatches pre-addressed messages.
- The daemon deduplicates inbound work by stable source identifiers such as
  `(sessionKey, msgId)`.
- Shared Slack integrations create a send-only Web API connection with the bot
  token. Replies, attachment downloads, cron anchors, and platform tools reuse
  the normal daemon path.
- Direct Slack integrations retain their daemon-owned socket transport.
- Webchat output is returned through `rd/chat` to the relay holding the browser
  session. That relay delivers output, completion, and canonical posts to every
  verified browser connection for the conversation; opening or closing another
  tab preserves existing subscriptions. The daemon assigns monotonically
  increasing output indexes, retains the bounded replay window, and can rebind
  an accepted turn to a replacement relay connection.

Slack rate limits are global to a bot while send queues are local to member
daemons. Each daemon respects `429` and `Retry-After`; conversation ownership reduces
but does not eliminate concurrent sends from different daemons.

## 12. Delivery Semantics

Slack and Lark / Feishu event handling follows the providers' short response windows:

1. The relay parses the raw request with a bounded body size.
2. It resolves a bot assignment and authenticates the callback with that
   platform's assigned verification material.
3. It locally deduplicates `event_id`, returns HTTP 200, and processes the
   event asynchronously.
4. It normalizes, arbitrates, and sends `rd/msg` to the selected daemon.

Slack's URL-verification challenge is the bootstrap exception: the relay echoes
the non-secret challenge before an assignment exists. Every operational event
and interaction is authenticated.

Lark / Feishu resolves the assigned app, verifies the raw-body SHA-256 signature when
an Encrypt Key is configured, decrypts AES-256-CBC envelopes, checks the
Verification Token and app identity, deduplicates `event_id`, and then returns
200 before forwarding. URL verification is handled only after the app has been
connected, which is why the Console instructs operators to connect first and
save the Request URL second.

A missing daemon socket or failed `rd/msg` delivery is logged, counted per bot,
and dropped. There is no offline inbox. The provider may retry a request that
did not receive a successful HTTP response, but it cannot repair a failure
after the relay has already returned 200. Duplicate deliveries that reach
different instances are absorbed by daemon-side idempotency.

Slack interactions are also HMAC-verified. Handlers that must return options in
the HTTP response complete before the 200 response. Rendered controls are
forwarded to their exact session target; message shortcuts are forwarded by
conversation coordinates and resolved to an exact session by the daemon.

Hook ingress responds quickly after verification and admission. Stable
`deliveryKey` values support idempotency and observable run accounting, but
provider retry behavior is not treated as a durable queue.

Webchat uses connection semantics: `rd/ack` reports whether the daemon accepted
a turn, and `rd/chat` streams indexed output until completion. After a browser
reconnect, the browser sends the last contiguous index it assembled. The daemon
accepts only a newer reconnect generation, then either replays the missing tail
and continues the same turn or returns an explicit resume failure when the turn
is unknown, the reconnect is stale, the cursor is invalid, or the bounded replay
window has overflowed. Completion includes the final output index so the browser
does not render a response as complete while an earlier frame is still missing.
A not-found result is retried only through the original turn-admission window,
covering a resume that reaches the daemon before its delayed turn. Browser
reconnect behavior is separate from IM delivery, and replay is not guaranteed
after the bounded window expires.

All writers and retry caches must comply with
[high-availability.md](high-availability.md#backpressure-and-delivery):
bounded memory, an explicit overflow outcome, and no false claim of durable
delivery.

## 13. Architectural Degradation Semantics

The table describes degradation paths within the current control-loss limits.
Relay readiness follows the CP link; with the chart's probes, roughly 20–30
seconds without READY removes the relay from Service endpoints. CP roster
expiry is currently 45 seconds, after which daemons can lose that relay route.
Reconnect replays MCP bindings, hook rules and memory bindings as snapshots:
the relay keeps serving its tables during the replay and prunes what the
replay no longer names at its end. Existing connections alone do not establish
uninterrupted service through those transitions.

The proposed [CP rollout contract](high-availability.md#planned-rollout-and-reconnect-budget)
requires bounded waiting for all control-dependent verification/lookups,
bounded data-plane readiness through handoff, and atomic replacement snapshots.
When no CP can renew, it also requires established relay links to preserve
cached, authorized ingress in a non-authoritative control mode; new control
authority remains unavailable. A lost control link has bounded readiness grace;
longer preservation requires explicit non-authoritative mode and observable live
daemon routes ([readiness rules](high-availability.md#owner-failure-and-database-loss)).
Those changes are prerequisites, not existing
guarantees. Relay crash-delivery and replay guarantees remain unchanged.

| Failure                             | HTTP bot ingress                                                                                               | Hook ingress                                                     | Webchat                                                            | Agent API egress                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------- |
| CP unavailable                      | Cached assignments and existing daemon sockets continue; affinity misses and new authentication fail closed    | Cached rules continue; metadata reports may wait or fail visibly | Established sessions continue; new verification is unavailable     | Continues directly from online daemons        |
| Relay instance unavailable          | Other healthy instances continue receiving public callbacks; daemons reconnect according to the updated roster | Other healthy instances continue                                 | Browser reconnects and resumes from the daemon replay window       | Unaffected                                    |
| Entire relay pool unavailable       | HTTP bot callbacks cannot be processed                                                                         | Public hook ingress is unavailable                               | Browser sessions are unavailable                                   | Existing daemons can still call platform APIs |
| Target daemon unavailable           | Selected messages are dropped and counted; unrelated daemons continue                                          | Target delivery fails visibly                                    | Target session cannot start or continue                            | That daemon cannot send                       |
| Partial daemon-to-pool connectivity | A callback landing without its target socket is dropped and counted                                            | Same bounded-loss outcome                                        | A browser must reconnect to an instance with the target connection | Unaffected                                    |

Direct integrations do not depend on relay availability.

## 14. Security and Trust Boundaries

- The Slack signing secret is stored by CP and held in memory by every connected
  relay assigned the HTTP bot. It is never sent to a daemon.
- The Slack bot token is stored by CP, held by the relay for
  ingress-adjacent API calls, and sent to member daemons for direct egress.
- The Lark / Feishu Verification Token and optional Encrypt Key are stored by CP
  and held by assigned relays. The Lark / Feishu App Secret is sent only to member daemons
  and is never placed in a relay assignment.
- Hook verification secrets are stored by CP and broadcast only to trusted
  relays.
- Stored credential material passes through `SecretCipher`. Secret-bearing
  frames, request signatures, route projections, and message payloads must
  never be logged.
- Slack HMAC verification uses the exact raw request bytes, a timestamp replay
  window, and timing-safe comparison. An unverifiable event or interaction is
  rejected.
- Lark / Feishu encrypted-callback verification also uses exact raw request bytes and
  a timestamp replay window; every callback must match its Verification Token.
- GitHub signature verification is mandatory. Generic hook endpoints avoid
  revealing whether a token or signature was the failing component.
- Relay-to-CP, daemon-to-relay, and browser-to-relay authentication are separate
  trust boundaries with separate credential types.
- A daemon can receive only targets attributed to its authenticated identity.
  Cross-daemon collaboration has an additional relay authorization layer.
- The relay has no application database and does not write content to disk.

Compromise of a relay exposes the credentials and in-flight content available
to that pool member. Relays therefore belong inside the same high-trust
boundary as CP secret distribution, with minimal operator access and
strict log redaction.

## 15. Operational Boundaries

- Slack and Lark / Feishu HTTP apps use the stable public relay origin for their
  callback request URLs.
- Current readiness covers listeners and CP-link READY. The proposed CP handoff
  separates a previously converged data plane from transient link loss within
  its bounded grace; initial startup still requires a complete projection.
- Registration and reconnect trigger replay; complete atomic replacement is
  an HA requirement that the current MCP/hook and memory paths do not yet meet.
- `daemonUrl` must be independently routable to its registered relay identity.
- The pool must expose delivery-drop counters, control connection state,
  connected-daemon counts, signature failures, and assignment counts without
  labels that contain message text or credentials.

## 16. Validation

The smallest useful evidence for this design includes:

- protocol codec tests for secret-bearing assignment frames, thread-affinity
  frames, `rd/msg` variants, and strict authentication states;
- HTTP ingress tests for raw-body HMAC verification, replay timestamps,
  challenge handling, body limits, event deduplication, and interaction
  responses;
- routing tests for conversation ownership, keyword selection, default target,
  managed-bot echo suppression, thread report/broadcast/lookup, and session
  actions;
- orchestration tests proving HTTP bot assignments and updates reach every
  connected relay and replay after registration;
- relay-daemon tests for identity verification, relay identity mismatch,
  revocation, typed acknowledgement, offline-target drops, and daemon-side
  deduplication;
- webchat tests for ordered output assembly, reconnect replay in both
  turn/resume arrival orders, stale-generation fencing, terminal-frame gaps, and
  explicit replay-window overflow;
- end-to-end tests that confirm Slack ingress reaches the selected daemon while
  normal agent replies bypass the relay;
- security assertions that logs contain no credentials, signatures, message
  bodies, or attachment bytes.

Tests should target these boundaries and failure modes rather than duplicate
schema validation or implementation details without additional behavioral
value.

## 17. Scaling Evolution

The baseline protocol model is an unsharded relay roster:

- every daemon connects to every relay in its roster;
- every relay holds every pool-served bot and hook projection;
- the public load balancer may send a callback to any healthy instance.

This keeps routing local and avoids relay forwarding, but its connection matrix
and projection fan-out do not scale indefinitely. CP already treats the roster
as policy output, and daemons converge the returned set rather than assuming it
contains all registered relays. That leaves two explicit future directions.

### Partitioned relay homes

CP can assign each organization or daemon to a small replica set and return
only that set in the daemon roster. A stateless public routing layer would use
a stable tenant or hook key to forward the request directly to the appropriate
set. The routing layer must not depend on an individual relay identity in
public URLs, and it must not place CP on the content path.

This option preserves transit-only content and direct `rd/*` delivery, but
requires coordinated changes to public routing and projection scope. Sharding
must not be enabled by changing the daemon roster alone, because callbacks
could otherwise land outside the target's connection set.

### Durable broker rendezvous

For unidirectional IM and hook traffic, relays could publish authenticated,
pre-addressed messages to tenant-isolated subjects consumed by daemons. A
durable broker can provide an offline inbox and move provider acknowledgement
after durable admission. Webchat would remain a connection-oriented path.

This option changes the privacy model because message bodies exist in an
intermediate store. It requires explicit retention, encryption, tenant
isolation, idempotency, and self-hosting decisions. A CP database inbox is
excluded because it would put message content inside the orchestration plane.

Both directions must preserve:

- explicit target and stable idempotency identifiers on every delivery;
- typed failure when no delivery path exists;
- CP independence from message bodies;
- daemon set convergence over policy-provided endpoints;
- public URLs that remain stable as internal placement changes.
