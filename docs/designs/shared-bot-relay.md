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
without persisting the response. This preserves the hot-path boundary in
[architecture.md](architecture.md): established
message and agent-execution paths can continue while CP is unavailable.

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
rc/daemon-revoke     { daemonId }
rc/verify            { kind: 'daemon-key' | 'daemon-token' | 'webchat-token', credential, daemonId?, conversationBinding?: 'v1' }
```

`rc/bot-assign`, `rc/routes`, and `rc/assign` are broadcast to the pool.
`rc/thread-assign` and `rc/bot-channels` are relay reports to CP. Route and
credential frames use full-replace or idempotent-upsert semantics so replay
converges cleanly.

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
rd/ack  { msgId, accepted, turnId?, reason? }
rd/chat { chatId, seq, event }
```

`rd/msg` already names the destination agent. IM payloads contain normalized
message data and attachment metadata; attachment bytes are fetched by the
daemon directly from the platform. A webchat turn may instead carry one inline
PNG, JPEG, or WebP image: the browser rasterizes and compresses it to at most
160 KiB before sending, leaving room for base64 expansion under the 256 KiB
frame ceiling. The relay forwards those bytes without storing them. `rd/chat`
is used only to return webchat output to the browser connection held by that
relay.

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
that token-bound value rather than trusting the browser query. It then resolves
the agent's current daemon placement and bridges browser turns and daemon
output without routing arbitration. Webchat verification carries a
`conversationBinding: 'v1'` fence and uses a v2 token-signing domain so mixed
old/new CP and relay instances fail closed instead of silently downgrading.
Conversation bodies remain daemon-local. While a turn is active or recently
completed, the daemon retains a bounded, short-lived output window keyed by the
browser-allocated turn id. A reconnecting browser reports its last contiguous
output index and an increasing connection generation through any healthy relay;
the browser rejects frames for any other turn while the daemon rejects stale
generations, rebinds the live stream, and replays the missing tail. This window
is volatile, has explicit size and age limits, and does not create a durable
transcript or offline inbox.
An optional image upload follows the same browser-to-relay-to-daemon content
path, is bounded to one compressed image per turn, becomes an ACP image prompt
block at the daemon, and is never persisted by the relay or Control Plane.

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
  session. The daemon assigns monotonically increasing output indexes, retains
  the bounded replay window, and can rebind an accepted turn to a replacement
  relay connection.

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
- Relay readiness must cover the public listener, CP projection state, and the
  daemon-facing listener. A process should become unready before draining
  sockets.
- Registration and reconnect trigger authoritative replay. Incremental frames
  are an optimization, not the only reconstruction mechanism.
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
