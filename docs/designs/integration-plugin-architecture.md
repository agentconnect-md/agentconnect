# Integration Plugin Architecture

> **Status:** Proposed.
>
> Related documents:
> [integration-plugin-audit.md](integration-plugin-audit.md) (the completed S0 branch audit),
> [daemon-centric-architecture.md](daemon-centric-architecture.md),
> [daemon-detailed-design.md](daemon-detailed-design.md),
> [feishu-integration.md](feishu-integration.md),
> [linear-integration.md](linear-integration.md),
> [gitlab-com-integration.md](gitlab-com-integration.md),
> [shared-bot-relay.md](shared-bot-relay.md),
> [session-concept.md](session-concept.md),
> [webhook-triggers-and-github-events.md](webhook-triggers-and-github-events.md),
> [slack-identity.md](slack-identity.md),
> [webchat-multi-agents.md](webchat-multi-agents.md).

## 1. Goal

Restructure the chat-platform integrations — Slack, Telegram, Discord,
Lark/Feishu, and every future platform — from hardcoded branches scattered
across four hosts into **per-host platform modules behind explicit
contracts**, so that:

1. **Adding a platform is a bounded, checklist-shaped task**: implement the
   published contracts in each host's `src/platforms/<id>/` directory and add
   one registry line per host, instead of editing the protocol enum in five
   places, threading ~100 branch lines through `daemon.ts`, extending the
   relay ingress manager's private maps, adding branches to the CP create
   route and spec assembly, and growing a 3,800-line install modal.
2. **Cross-platform features are written once** against the contract instead
   of four times against four transports, eliminating the recurring class of
   "implemented on Slack, forgotten on Feishu" defects.
3. The **Collaboration Arena virtual transports** and other test doubles
   implement a published interface instead of duck-typing internals of an
   18k-line class.

Two upcoming designs pay the current scatter cost imminently —
[linear-integration.md](linear-integration.md) and
[gitlab-com-integration.md](gitlab-com-integration.md) are both Proposed —
so the refactor amortizes immediately.

**Scope decision (honest goal):** this design delivers **first-party
modularity now** and **explicitly defers third-party extensibility**. A
third party cannot add a platform to a deployment without forking today (see
§15 for why, and for the short list of cheap decisions that keep that door
open). Stating third-party support as a present goal would warp the contract
design toward generality nobody can consume yet.

## 2. Non-Goals

- **No out-of-process plugins.** Adapters run in-process; outbound streaming
  (Slack `chat.update` edit loops, Feishu streaming cards) is a
  latency-sensitive hot path, and the trust boundary that justifies IPC does
  not exist for first-party code. The memory-plugin precedent
  (`packages/memory-plugin-mem0`) is _not_ the model here: it is a
  single-host, sparse-call, out-of-process seam — none of which holds for
  platform adapters.
- **No dynamic discovery or runtime loading.** Registries are static,
  explicit import tables; a deployment's platform set is visible in code and
  tree-shakeable.
- **No npm package per platform.** Explicitly rejected — see decision D1.
- **Webchat stays core.** It is the console's own surface (relay browser
  connection, CP conversation tables, MCP delegation) and shares almost
  nothing with external chat-platform transports.
- **GitHub/GitLab do not adopt the full platform contract.** They remain on
  the webhook/code-host seam (`relay/src/hooks/`, `control-plane/src/github/`,
  the daemon poster). They _do_ participate in the narrower Layer-2 output
  surface (§7.6) so the dispatch path stops carrying a hardcoded GitHub
  special case.
- **No product-behavior changes**, with the small carve-outs listed in §14
  (each is a latent defect being fixed, not a redesign).

## 3. Current State

A platform's code is spread across six locations today (non-test line
counts, approximate):

| Layer                   | Slack                                                                              | Feishu                                 | Discord            | Telegram |
| ----------------------- | ---------------------------------------------------------------------------------- | -------------------------------------- | ------------------ | -------- |
| `daemon/src/<p>/`       | 2,681                                                                              | 1,686                                  | 1,418              | 1,031    |
| `message/src/<p>-*.ts`  | 298                                                                                | 198                                    | 103                | 209      |
| relay ingress           | 843                                                                                | 254                                    | —                  | —        |
| CP install/registration | 1,066 (`slack-install` + `slack-platform-install`)                                 | 263                                    | —                  | —        |
| web console             | config card, mrkdwn, marks, wizard sections                                        | region switcher, wizard                | wizard             | wizard   |
| Prisma                  | `SlackInstall`, `SlackPlatformInstall`, `SlackUserConfig`, `Bot.slackAppId/teamId` | `FeishuAppRegistration`, `Bot.feishu*` | `Bot.discordAppId` | —        |

Structural symptoms, per host:

- **daemon** — `daemon.ts` (~18k lines) holds four connection arrays, four
  `connByIntegration` maps, per-platform reconcile loops, and roughly 100
  platform-comparison lines (69 `platform === '<p>'` / `case` lines plus
  ~30 negated or reversed comparisons). Each new platform adds one more of
  everything.
- **relay** — `relay-ingress-manager.ts` hardcodes `if (a.platform ===
'feishu')` forks and three Feishu-specific routing maps beside the Slack
  path.
- **control-plane** — three structurally different install funnels
  (`slack-install.ts`, `slack-platform-install.ts`,
  `feishu-registration.ts`) with no shared skeleton; `integrations.ts`
  validates each platform's credentials inline; `placement.ts`/`httpBot.ts`
  assemble the platform-discriminated `IntegrationSpec` wire union on the
  reconcile path.
- **web** — `AddIntegrationModal.tsx` (~3,800 lines) contains all four
  platforms' install wizards; the transcript renderer applies Slack mrkdwn
  semantics to every platform; bots settings, channel lists, API bindings,
  and conversation-merge all branch per platform.
- **protocol** — the `Platform` enum appears in `frames/route.ts` and is
  inlined four more times in `frames/relay-daemon.ts`; `rd/msg` carries
  platform-typed variants (`source: 'slack_action'`); `IntegrationSpec` is a
  closed per-platform discriminated union that also embeds core routing
  knobs.

## 4. Decision Summary

- **D1 — Platform module = per-host directory, not an npm package.** Code
  lives in each host under `src/platforms/<id>/`; the contracts and manifest
  _types_ live in `@agentconnect.md/protocol`; each host keeps a static
  registry (`src/platforms/registry.ts`). One-npm-package-per-platform was
  evaluated and rejected: npm has no per-subpath dependency scoping (a
  daemon install would pull the web slot's React stack and vice versa); the
  web app currently depends on zero workspace packages and Tailwind v4's
  automatic content detection does not scan external packages (extracted
  fragments would render unstyled without per-package `@source` globs and
  `transpilePackages` bookkeeping); and the "one version across hosts"
  benefit is phantom because the four hosts deploy independently and each
  pins its own copy. Package extraction remains possible later (§13, optional
  stage) once an external consumer actually exists.
- **D2 — Four-way branch taxonomy with a stated dividing rule.** Every
  platform branch is classified as (a) _transport_ — moves into the platform
  module; (b) _manifest capability_ — a declarative value core reads; (c)
  _adapter strategy_ — a function the adapter exports; or (d) _core special
  case_ (webchat, hook, dream, headless). The dividing rule between (b) and
  (c): **a manifest capability is legitimate only if core reads it before a
  dispatch target is resolved** (routing, session keying, arbitration,
  gating). Anything evaluated after target resolution — rendering, chrome,
  footers, thread-opening mechanics, streaming edits — is adapter strategy
  behind the contract, because manifest flags in post-dispatch code invite
  core to keep growing branches ("capability explosion").
- **D3 — `OriginKind` × `PlatformId` split with a two-phase rolling
  migration.** The current `Platform` enum conflates message-origin kinds
  (`hook`, `dream`, `webchat`) with chat-platform identities. It splits into
  `OriginKind = 'chat' | 'hook' | 'dream' | 'webchat'` and an open
  `PlatformId` string. Because zod rejects unknown enum _values_ wholesale
  (unknown frame _types_ are graceful; unknown values inside a known frame
  are not, `protocol/src/wire.ts`), and `register` carries
  `capabilities.platforms`, emitting a new id before every peer reads
  tolerantly is a **fatal handshake loop**. Hence S1a/S1b staging (§13).
- **D4 — `IntegrationSpec` restructures into a core envelope plus opaque
  platform config.** Core routing knobs (`bindRules`, `allowedUserIds`,
  `mutedChannels`, `gated`, mode) move _out_ of the per-platform config
  objects into a shared envelope; everything platform-specific becomes an
  opaque, plugin-validated payload. This is a protocol prerequisite of the
  same magnitude as D3 and is what lets CP spec assembly
  (`placement.ts`/`httpBot.ts`) stop branching per platform.
- **D5 — The daemon contract is layered.** Layer 1 (connection + ingress +
  read port) is implemented only by chat platforms. Layer 2 (the per-turn
  _output surface_: renderer lifecycle over a converger/applier pair) is
  implemented by chat platforms **and** by the GitHub poster/collector, so
  the generalized turn record stops carrying a permanent `github` special
  case. Linear (per its design) lands as Layer 2 + hook-style ingress;
  Teams/Mattermost-class platforms take the full contract.
- **D6 — Bot demux identity stays in real columns.** `Bot.slackAppId +
teamId` is a load-bearing composite-unique demux key (admission and
  revocation CAS ride the row; `workspace_taken` fencing depends on the
  unique index). It generalizes to `externalAppId` / `externalTenantId`
  columns (unique together with platform, preserving today's NULL-distinct
  semantics) — **not** to JSON, which cannot carry a declarative unique
  constraint. Display-only ids (`discordAppId`, `feishuAppId`,
  `feishuRegion`) move to a per-platform JSON bag.
- **D7 — First-party now, third-party deferred** with four named
  keep-the-door-open items (§15).

## 5. The Platform Manifest

Pure data, defined in `@agentconnect.md/protocol`, one per platform module.
Every host consumes it; nothing in it is behavior.

```ts
interface PlatformManifest {
  id: string // 'slack' | 'telegram' | ... ; future ids namespaced
  originKind: 'chat'
  displayName: string
  // Regional API clouds (Lark vs Feishu): one wire platform, one adapter,
  // shared Bot rows — but region changes display name, help copy, portal
  // hosts, and bot-reuse eligibility. Recorded per bot/integration
  // (Bot.feishuRegion precedent). Any platform with regional clouds reuses
  // this axis instead of forking the platform id.
  regions?: { id: string; displayName: string; portalBaseUrl: string }[]

  // ---- pre-dispatch capabilities (the D2 rule: core reads these BEFORE a
  // dispatch target is resolved) ----
  ingress: 'socket' | 'http' | 'both' // which transports are installable
  threading: 'per-message' | 'topic' | 'none'
  topLevelReplies: boolean // channel-root sends allowed
  mentionIdPattern?: RegExp // raw platform user-id syntax (routing)
  botSenderRouting: boolean // bot-authored messages enter the ladder
  persistsPlacements: boolean // coordsDecision fail-closed membership

  // ---- CP-facing axes (read at install/config time, still pre-dispatch) ----
  credentialShape: 'token' | 'token+appToken' | 'appId+appSecret' | 'appId+appSecret+signing'
  // Demux identity shape: tenant-scoped (Slack app+team) or app/token-scoped
  // (Linear urlToken). Drives how core persists Bot identity columns (§11).
  // NOT a per-platform constant — amended in §5.1 below.
  identityScope: 'tenant' | 'app'
  multiAgentShareable: boolean
  membershipEnumeration: 'authoritative' | 'observed'
  leaveGranularity: 'conversation' | 'space' | 'none'

  // ---- cross-host declarations ----
  // e.g. Slack/Lark render per-message avatars from a public CP endpoint;
  // the CP implements the union of declared needs (CORS/cache behavior on
  // /v1/agents/:id/icon) instead of hardcoding per-platform comments.
  avatar?: { perMessageIconUrl: boolean }
}
```

Deliberately **absent** from the manifest (post-dispatch, therefore adapter
strategy per D2): footer style, streaming-edit mechanics, status-bar shape,
message length limits, parse mode, typing-indicator style, select-menu
ceilings, thread-open mechanics. The current code exhibits at least ten such
axes beyond the list above; encoding them as flags would reproduce the
switch farm in data form.

### 5.1 Amendment (S3): `identityScope` is per-ASSIGNMENT, not per-platform

The relay's demux work (S3 §8) found this axis mis-modelled. A per-platform
constant cannot express Slack, where **both shapes are live at the same
time**: an install of a distributed platform app is tenant-scoped (many
installs share one app id _and_ one signing secret, so only the composite
`(appId, tenantId)` identifies the bot), while a legacy sibling bot may carry
an app id alone — or no app id at all, if its CP row predates the column.
Declaring `identityScope: 'tenant'` for the platform would either strand the
legacy bots or, worse, invite a signature scan that resolves a callback to a
_sibling install of the same app_ — one workspace's messages delivered to
another tenant's bot. The axis therefore belongs to the assignment, derived
from the identity the CP actually stamped on it:

- **tenant id present** ⇒ composite index only. Assign-derived, **never
  learned** from traffic, eagerly evicted on unassign — and a re-assign that
  _gains_ a tenant id must evict the bot's stale app-only entry, or the
  weaker index would keep answering cross-tenant.
- **app id only** ⇒ app index, which **may** be learned from the first
  verified delivery (bounded, lazily evicted), precisely because a legacy row
  may not carry the id.
- **neither** ⇒ no index entry; the bot is reachable only through the bounded
  verify-scan, which skips same-secret siblings whose assigned tenant differs.

What survives at manifest scope is the weaker statement that a platform's
identity vocabulary _has_ a tenant axis at all (Slack `team_id`, Feishu
tenantless) — the CP still needs it to know which columns to persist (§11).
The relay reads scope from the assignment, never from the manifest.

### 5.2 What actually shipped, and the discipline that kept it small

The field list above is the **candidate** list derived from the S0 audit, not
a contract. The manifest that exists
(`packages/protocol/src/platform-manifest.ts`, promoted out of the daemon in
S3 when the relay became its second consumer) carries three fields:
`membershipEnumeration`, `botSenderRouting`, and `dmChannelPattern` — the
last of which is **not** in the published list above, and was earned by a
pre-dispatch read the audit surfaced (gated-conversation discovery must
recognize a DM before any target resolves, and a Slack `app_mention` can omit
`channel_type`). Each field landed in the same PR as the branches it retired.

The rule also rejected a field in review: status-bar shape reads like a
capability, but every read of it happens from a turn that already exists, so
it is post-dispatch and belongs to an adapter strategy. **A manifest field is
earned by a pre-dispatch read, in review, or it is a capability flag with
better branding** — the exact pattern this migration exists to delete. The
remaining candidates stay candidates until a branch is actually retired by
one.

## 6. Protocol Changes

### 6.1 `OriginKind` × `PlatformId`

`frames/route.ts`'s `Platform` enum and its four inline copies in
`frames/relay-daemon.ts` are replaced by:

- `PlatformId = z.string()` (with a naming convention; first-party ids stay
  bare),
- `OriginKind` carried where the _kind_ matters (session keying, dispatch
  admission), derived from the registry for known ids.

Origin-kind classification for ids the local peer does **not** know must be
resolvable: classification data (originKind per platformId) rides the wire
in collab snapshots / `rc/bot-assign` so an older relay or daemon can
classify ids a newer peer introduces. The safe default for an unknown
chat-shaped id in `coordsDecision` is **refuse** (fail-closed), replacing
the current hard-coded four-platform list.

### 6.2 Rolling migration: tolerant readers first

Constraint (verified): zod strips unknown object keys but **rejects unknown
enum values**; a known frame type with a failing payload is refused
(`wire.ts`), and `register.capabilities.platforms` is `z.array(Platform)` —
so a new platform id reaching an old CP kills the handshake and the daemon
enters a reconnect loop. The precedent for staged encoding already exists
(`codec.ts` down-levels `register/ok` for pre-M-5D daemons).

Sequence:

1. **S1a (tolerant readers):** every peer's _readers_ accept `z.string()`
   for platform fields while _writers_ still emit only legacy values.
   Per-frame unknown-id policy is documented: `register` — accept, ignore
   unknown capabilities; `event/session` — store verbatim; `rd/msg` — reject
   the item, never the socket. Deploy CP first, then wait one full daemon
   upgrade cycle (fleet gate).
2. **S1b:** schema restructuring lands and new ids may be emitted.

The schema change alone deploys safely; what is actually gated on the fleet
is **emitting the first non-legacy id**.

### 6.3 `narrowPlatform` dies

The daemon currently folds any unrecognized platform string into `'slack'`
when minting session keys (`daemon.ts`, ~12 call sites) — the code comment
records a real Feishu incident where this minted sessions nothing could
continue. Under an open `PlatformId` this becomes a standing correctness
bug for every new platform's A2A/orchestration/wake path. S1a deletes it
and threads the raw platform string through session keying.

### 6.4 `IntegrationSpec`: core envelope + opaque config

```ts
interface IntegrationSpec {
  integrationId: string
  agentId: string
  platformId: string
  core: { bindRules; allowedUserIds; mutedChannels; gated; mode } // owned & read by core
  config: unknown // opaque on the wire; validated by the platform module on the daemon
}
```

A legacy-emission shim (same pattern as the existing `codec.ts` down-level
encodings) keeps old daemons receiving the nested per-platform shape until
the fleet gate passes. The daemon-side agent-config schema
(`agents/agent-schema.ts`) and the protocol `AgentSpec` union migrate
together — they are the same closed union in two places today.

### 6.5 `NormalizedMessage`: generic thread coordinates + adapter extension

`threading: 'per-message' | 'topic' | 'none'` is a label, not a data model —
the current schema accretes named per-platform fields (a topic id vs a
reply-chain root vs a promote-to-thread flag). S1b introduces:

- a generic coordinate model `{ threadId?, topicId?, promoteToThread? }`
  consumed by core session-keying, and
- `adapterExt?: Record<string, unknown>` namespaced by platformId, opaque on
  the wire, round-tripped back to the adapter at render time.

Named `telegram*` / `discord*` fields are deprecated behind the projection.

### 6.6 `platform_action`: a semi-opaque envelope

`source: 'slack_action'` (and the Feishu analog) is replaced by one frame
whose **envelope is core-typed and whose payload is opaque to relay core**:

- The relay-side platform module parses the platform interaction and
  extracts `{ agentId, integrationId, sessionKey, userId?, msgId }` — relay
  core needs these for routing and for minting the dedup id.
- The payload is decoded only by the same platform's daemon-side module into
  core `StatusAction` / `PermissionChoice` / `Elicitation` calls.
- The ack carries an opaque `response?` slot (the existing
  `RdAck.feishuCardAction` toast round-trip is the precedent), and the frame
  declares an explicit dedup scope. Fencing is unaffected (dedup is
  msgId-based; the daemon replays the prior ack on retransmit).

### 6.7 `rc/bot-assign`: opaque secrets + opaque ingress config

Demux metadata is per-platform (Slack: `apiAppId` + `teamId` with the
shared-secret composite-key invariant; Feishu: `appId` only), so the
assignment frame gains `{ platformId, secrets: opaque, ingress: opaque }`
with shape validation delegated to the platform module on both ends.

### 6.8 Cron/hook targeting opens

`CronDef.targetPlatform` / `HookDef.targetPlatform` (and the web
`AddCronModal` coercion, which today lossily folds Discord/Feishu anchors)
migrate to the open `PlatformId`; the anchor platform derives from
`targetIntegrationId` instead of a client-coerced literal.

## 7. Daemon Slot

### 7.1 Three-facet adapter contract

The existing connections are not write-only pipes; core depends on a large
read/query surface (thread backfill for mid-thread context, authenticated
attachment download, the MCP MessageGateway channel/member/profile/DM
tools, bot-membership enumeration behind the console's channel triggers,
identity accessors for echo-drop and tenant scoping). The contract makes all
three facets explicit:

```ts
interface PlatformAdapter {
  // 1. transport lifecycle + identity
  start(): Promise<void>; stop(): Promise<void>
  identity(): { botUserId; botId?; appId?; workspaceUrl?; workspaceId? }

  // 2. ingress (events -> host callbacks; see 7.2)

  // 3. read/query port — the MessageGateway surface
  getThreadReplies(...); downloadFile(...)
  openDirectMessage(...); getChannelInfo(...); listMembers(...)
  listBotChannels(...); getUserProfile(...); leaveChannel(...)
}
```

The Collaboration Arena virtual connections
(`evaluation/virtual-connections.ts`) are already a de-facto enumeration of
this surface; the interface is lifted **from** them, and evals become the
contract's second implementer (a standing compatibility test — see the S2
exit criteria).

### 7.2 Host services

Enumerated from the union of the four existing `Deps` shapes rather than
invented: `onInbound`, `onAction` (a typed union covering
status/permission/elicitation/select/callback choices),
`onChannelsChanged(payload?)` (Telegram's chat-discovery carries a payload;
Slack's is a bare signal), `resolveSessionForCoordinates` (the synchronous
message-shortcut resolver — Slack modals must open within the ~3s trigger
window), `noteObservedChat`, `noteNames` (name-resolution is wired
per-platform today in core construction lambdas), `statusInfoFor`,
`newTraceId`, `log`, `clock`, plus an adapter-config channel (debug flags,
send pacing, send-only mode).

### 7.3 The renderer seam (Layer 2)

A shared action vocabulary already exists in the four renderers
(post / notice / progress / reasoning / plan / tool-output / live-reply with
identical transcript-vs-chrome semantics) — but ops _production_ is also
per-platform (chunking to 12,000/4,096/2,000/4,000-char limits, parse mode,
hint policy), and the streaming loop owns per-turn state (Feishu card
handles, Telegram reply-to chains). The seam therefore moves the pair:

```ts
interface TurnOutputSurface {
  createConverger(turnCtx): Converger // chunking, pacing, hint policy
  applier: Applier // action -> platform API calls
  hooks: { onStart?; onFailure?; onTerminal?; cadence? }
  // one opaque slot on the turn record replaces feishuCard/tgReplyTo/...
  initialTurnState(): unknown
}
```

Core owns turn sequencing, suppression re-checks, and idle flush policy; the
adapter owns everything platform-shaped. The GitHub poster/collector
implements this same interface (no Layer-1 facets), removing the hardcoded
`github` turn field from the dispatch path.

### 7.4 Adapter strategy functions

The ~20 branches that are neither transport nor pre-dispatch capability
become adapter exports (per D2): `threadKeyForPost` (per-platform thread
coordinate derivation, currently `messages/normalized.ts`),
`loopGuardScopes(msg)` (Slack adds a channel-wide scope for top-level
posts), `tenantScope(integration, conn)` / `transportScopeIdentity(...)`
(session-visibility owner identity), `openThreadForTopLevel?` (Discord opens
a real thread and re-dispatches), command chrome renderers (the four-way
`/status` formatting), and DM inference.

### 7.5 The connection registry

What "one registry" must actually absorb: 4 conn-by-integration maps, 5
connection pools, in-flight-connect guards, retry timers, `botUserIds`,
channel snapshots — with **two connection modes per platform** (socket vs
send-only shared/HTTP) whose consolidation keys differ (Slack shared bots
key on `xoxb` because no app token exists). The registry entry is therefore
key-driven and adapter-parameterized:

```ts
interface RegistryEntry {
  consolidate(agents): Map<opaqueKey, ConnectionGroup>   // per mode
  connectionIdentity(conn): opaqueKey
  retryPolicy: { ... }
}
```

The reconcile/close loop compares opaque keys only. Drain leases and
eval-immunity (injected credential-less virtual connections are excluded
from consolidation input and immune to reconcile eviction) stay in the core
registry.

### 7.6 Contract layering summary

| Implementer                   | Layer 1 (connect + ingress + read port) | Layer 2 (turn output surface) |
| ----------------------------- | --------------------------------------- | ----------------------------- |
| Slack/Telegram/Discord/Feishu | yes                                     | yes                           |
| GitHub poster                 | no                                      | yes                           |
| Linear (per its design)       | no (hook-style ingress)                 | yes                           |
| webchat                       | core-owned                              | core-owned                    |

## 8. Relay Slot

`{ verify, toDelivery }` is insufficient (verified against both real
ingests); the slot is two-sided, mirroring the daemon's:

```ts
interface RelayPlatformIngress {
  start(): Promise<void>
  stop(): Promise<void>
  // Demux is stateful and per-platform: Slack signature-scans the assigned
  // bot registry with a learned (api_app_id, team_id) index; Feishu demuxes
  // on body app_id with optional AES decrypt. Challenge/url_verification
  // ordering relative to verification differs per platform — it is a
  // per-plugin hook, not a fixed pipeline step.
  extractDemuxHints(rawBody): Hints
  verify(secrets, rawBody, headers, now): Verified | Challenge | Reject
  // Two platforms require SYNCHRONOUS bodies on the HTTP 200 (Slack
  // block_suggestion options; Feishu card-action toast). handle() is async
  // because the sync body may depend on a daemon round trip: the Feishu
  // plugin awaits RelayHostServices.forwardAction(...) and surfaces the
  // daemon-produced toast in the same HTTP response. Deadline ownership:
  // the PLUGIN owns the platform-specific deadline (it races the daemon
  // round trip against the platform's response window — Feishu ~2.5s,
  // Slack's 3s trigger — using the host clock, degrading to an ack-only
  // body on timeout); the HOST enforces one outer hard cap on the route so
  // a misbehaving plugin cannot pin the HTTP worker.
  handle(event): Promise<{ syncResponse?: unknown; deliveries: PreAddressedDelivery[] }>
  // Slack performs relay-side egress (modals under the 3s deadline, notices,
  // channel snapshots, auth.test revocation backstop); Feishu deliberately
  // keeps egress on the daemon. Optional by design.
  egress?: { notice; openModal; channelSnapshot }
}

interface RelayHostServices {
  forward(delivery)
  forwardAction(action): Promise<AckResponse>
  reportRevoked(reason, atMs?)
  reportChannels
  reportConversation
  directory: { agents; channelOwner; resolveTarget } // arbitration reads
  getDaemonOnline
  clock
  selfRelayId
  log
}
```

Relay core keeps: bot arbitration, the 3-leg thread-affinity dance, pending
report queues, fencing, retry backoff, and event-identity dedup _storage_
(the plugin mints the dedup id since it derives from parsed action
semantics; core owns the table). Four platform reads currently inside
"core" become capability reads per D2: Slack-only bot-mention admission
(`botSenderRouting`), thread-root detection (adapter `isThreadRoot` or the
threading capability), the Feishu egress-ownership fork (`relayOwnsEgress`
derived from the `egress` facet), and the echo-suppression guard. The
existing `hooks/signature.ts` primitives are shared relay-core
infrastructure serving both this seam and the webhook seam.

### 8.1 Amendment (S3): the contract as it shipped

The sketch above survived contact with both real ingests in shape but not in
detail. What landed (`packages/relay/src/platforms/contract.ts`, three review
rounds):

- **The plugin is per-PLATFORM and stateless; the per-BOT object is what it
  builds.** The sketch conflated them. `RelayPlatformIngressPlugin<TIngest,
TVerified>` owns `buildIngest(assignment, host)`, `extractDemuxHints`,
  `verify` and `handle`; the returned `RelayBotIngress` owns that bot's
  credentials, its `stop()`, and the optional `egress` facet. Every lifecycle
  edge (assign → build, rotate → rebuild, unassign/revoke → stop) goes through
  the plugin, and core keeps one pool per platform.
- **`verify` returns the plugin's typed product, not a verdict.**
  `verify(ingest, rawBody, body, headers, now): TVerified | undefined`.
  A boolean verdict was the first blocking review finding: Feishu's verify
  _decrypts_, and the decrypted payload has to reach `handle` — deriving it a
  second time there is both wasteful and a place for the two derivations to
  disagree. `undefined` means reject.
- **Challenge is not a third arm.** Slack's `url_verification` is answered by
  the route BEFORE any candidate is selected (it is unauthenticated by
  design — the documented pre-candidate exception), while Feishu's challenge
  is _encrypted_ and therefore necessarily flows verify → handle like any
  other event.
- **`handle` returns only a sync body.** `handle(ingest, verified, host):
Promise<HandledDelivery>` where `HandledDelivery` is `{ syncResponse? }`.
  The sketch's `deliveries: PreAddressedDelivery[]` return does not exist:
  events are ACK'd inside the platform's window and handled asynchronously, so
  the plugin pushes through the host rather than returning work the route
  would have to wait for.
- **The host forwards NORMALIZED messages, not pre-addressed deliveries.**
  `host.forward(botId, WireNormalizedMessage)` — arbitration and the routing
  ladder stay in core (§12), so a plugin never resolves a target. Only
  `forwardAction(msg, route)` carries a route, and it must not re-resolve one.
- **`directory` has three trust models, not one lookup.** `targetForAgent`
  (requires a live routing rule — the status-modal action path),
  `integrationTarget` (directory-only, because a rendered card's target may
  outlive the rule that created it and the daemon's active-card map is the
  terminal fence), and `soleTarget` (single-install fallback for cards
  rendered before action values embedded a target). Collapsing them would
  either break stale-but-legitimate interactions or route them by guess.
- **`getDaemonOnline` became `canDeliver(route)`**, and it is load-bearing for
  one-shot triggers: a Slack shortcut's trigger id is consumed by returning
  `true`, so an offline daemon must fall back to the local unavailable modal
  while the trigger is still valid.
- **`reportRevoked` carries a credential revision.** Assignments start
  fire-and-forget, so an older ingest's `auth.test` can land after a newer
  assignment installed; the report is fenced with the revision the OBSERVING
  ingest was built from, never the mutable current one.
- **`egress` is `{ notice, lookupUserName }`** — what relay-side egress
  actually needs; modal and channel-snapshot work is driven through the
  ingest's own callbacks. Facet presence remains the `relayOwnsEgress`
  capability read, as designed.
- **Dedup identity is per-assignment composite**, per §5.1: the plugin mints
  `(appId, tenantId, eventId)`, core owns the TTL table.

## 9. Control-Plane Slot

The CP slot is **behavioral, not declarative** — a descriptor cannot express
what the three existing install funnels contribute: Fastify route plugins at
two mount-scope classes (org-scoped and unauthenticated public callbacks,
some deliberately mounted twice), dedicated pending-install Prisma models
with `SecretCipher` stores, TTL reapers, env-config keys, and DI members.

```ts
interface CpPlatformProvider {
  platformId: string
  // Mounted by server.ts at each scope; OpenAPI conventions (tags, summary,
  // operationId) apply to every contributed route.
  installRoutes(scope: 'org' | 'public-callback'): FastifyPluginAsync[]
  validateConfig(body): Promise<ValidatedIdentity> // live token checks
  credentialBodySchema: ZodType // composed into the create-DTO union
  secretShape: SecretShapeDecl
  pendingInstall?: { model: string; reaper: ReaperSpec }
  envSchema?: ZodRawShape
  // Install-time side effects: Discord message-content intent enablement,
  // agent-avatar pushes (Telegram/Discord/Feishu icon sync).
  sideEffects?: { postCreate?(integration): Promise<void> }
  // Per-USER provider tooling credentials (SlackUserConfig class): store +
  // rotation + status routes + a signal that changes the web wizard's mode.
  providerToolingCredentials?: ProviderToolingDecl
  // Wire projection: the ONLY code that turns persisted integration/bot
  // rows plus decrypted secret material into the opaque payloads of D4 and
  // §6.7. These are today's integrationToSpec / httpIntegrationToSpec /
  // HttpBotService.buildAssign branches, relocated behind the provider.
  // Both projectors are ASYNC, and the provider owns loading from any
  // additional secret stores it maintains: `secrets` carries the bot-level
  // material core already holds, but e.g. the Linear design keeps rotating
  // integration-scoped tokens in its own encrypted table — the provider
  // loads those itself inside the projector, and core always awaits,
  // never growing a per-platform preload branch. Secret material is never
  // persisted inside platformConfig JSON.
  projectIntegrationConfig(integration, bot, secrets): Promise<unknown> // -> IntegrationSpec.config (§6.4)
  projectBotAssign(bot, secrets): Promise<{ secrets: unknown; ingress: unknown }> // -> rc/bot-assign (§6.7)
}
```

Consequences the slot must own:

- **Create DTO / OpenAPI:** `POST /integrations`' closed discriminated union
  becomes a registry-composed union — each provider contributes its
  credential sub-schema and transport refinements; core folds them into the
  route schema at `buildContainer` time so `/docs` and `openapi.json` stay
  accurate.
- **Spec assembly moves into the provider — not out of the CP.** The CP
  still assembles the wire payloads (it holds the rows and the decrypted
  secrets), but through `projectIntegrationConfig` / `projectBotAssign`, so
  `placement.ts` / `httpBot.ts` stop branching per platform and merely
  await and forward provider output; shape validation of the opaque payload lives in
  the same platform's daemon/relay module. The Slack bot-identity
  reconciler and similar background loops register via the provider.
- **The common create skeleton stays core:** visibility gates, placement
  check, daemon capability gate, mutation lease, `replicateUpsert`.
- **Adjacent per-platform services get audit homes, not new slots:** the
  session-audience resolvers (`SlackSessionAccessService` /
  `FeishuSessionAccessService`) are platform plugins to the
  session-visibility system; preset default-binding is a documented
  core→plugin reference (preset provisioning names a platform's install
  machinery); viewer-identity composition (`${platform}:${scope}:${user}`)
  is declared per platform.

## 10. Web Slot

The real per-platform web surface is roughly nine items, not three: install
wizard, transcript text renderer, `PlatformMark`, bots-settings fragments
(Slack refresh/reinstall state machines, portal deep-links per region),
CP API-client bindings + install-polling hooks, channel-list semantics
(`roomNoun`, leave-ability, glyphs), conversation-merge id/timestamp domain
knowledge, per-platform marketing/help copy, and helper libs
(`slack-manifest.ts`, `discord-invite.ts`, `telegram-privacy-auto-refresh`).

```ts
interface WebPlatformModule {
  wizard: {
    Body: ComponentType<{ agent; host: WizardHost }>
    freeBotFilter(bot): boolean          // per-platform reuse eligibility
    buildReuseInput(bot): CreateIntegrationInput
    affordances: { transport?: boolean; share?: boolean }
  }
  settingsFragments?: { botCard?; lifecycleActions? }
  apiBindings: { ... }                   // typed CP client calls
  textRenderer?: (text, ctx) => ReactNode
  Mark: ComponentType                    // inline SVG
}

interface WizardHost {                    // host services — the modal chassis
  createIntegration; relayCapability; freeBots; daemonCaps
  mockMode; isMobile; close; invalidate  // SWR keys
}
```

Host-owned chassis: platform picker tiles (gated on
`daemon.caps.platforms`), existing/create mode cards, the generic free-bot
list, footer, and the mobile bottom-sheet behavior (the wizard is one
responsive tree today; fragments must stay that way). The webhook/GitHub
wizard sections are explicitly core fragments.

Two decisions specific to this host:

- **Renderer selection is a (small) behavior change.** Today one global
  renderer applies Slack mrkdwn semantics to all platforms. The platform key
  already rides merged-conversation rows (`MergeSource.platform`); a
  renderer registry keyed by platformId ships with the Slack renderer as the
  default for all chat platforms, then per-platform overrides land
  separately (§14).
- **Modules stay in the web tree** (`src/components/console/platforms/<id>/`
  or equivalent) per D1 — no cross-package React, no Tailwind `@source`
  bookkeeping, `use client` stays an app convention.

## 11. Data Model

- **`enum Platform` → `text`** on the six columns that carry it. Cheap:
  `session_meta.platform` is already text; defaults and indexes carry over;
  the generated Prisma client's type loosens from the enum to `string`
  (callers already funnel through protocol types).
- **Bot demux identity → generic columns** (D6):

  ```prisma
  model Bot {
    platform          String
    externalAppId     String?   // Slack A… app id; Linear urlToken; …
    externalTenantId  String?   // Slack T… team id; '-' sentinel where tenantless
    platformConfig    Json?     // display ids, region, portal hints
    @@unique([platform, externalAppId, externalTenantId])
  }
  ```

  **Tenantless identities need a sentinel, not NULL.** Postgres treats
  NULLs as distinct in unique indexes, so a NULL `externalTenantId` would
  not enforce uniqueness for tenant-free identities — and Linear's
  bot-scoped `urlToken` (this table's replacement for the Linear design's
  `linearUrlToken @unique`) must stay unique because the relay selects the
  bot by it. Rule: **NULL is reserved for legacy rows only** (pre-capture
  Slack rows keep today's NULLs-distinct behavior); every new row on a
  tenantless platform writes the sentinel `'-'` as `externalTenantId`, so
  the composite unique index enforces `(platform, externalAppId)`
  uniqueness declaratively — no partial index, no `NULLS NOT DISTINCT`
  migration hazard. Which shape a row persists follows the identity the
  install funnel captured for **that bot**, not a per-platform constant
  (§5.1): a tenantless platform writes the sentinel, and a tenant-capable
  platform writes the sentinel too for any bot whose install never yielded a
  tenant id.
  `discordAppId`, `feishuAppId`, `feishuRegion` fold into `platformConfig`.
  If a platform later needs a _second_ identity axis, the fallback is a
  `bot_platform_identity(botId, platformId, identityKind, identityValue)`
  table with one generic unique index — deferred until needed.

- **Install-state tables stay per-platform for now** (`SlackInstall`,
  `SlackPlatformInstall`, `FeishuAppRegistration`), contributed via the CP
  provider's `pendingInstall` facet. A single generic install-state table is
  a third-party-era consolidation (§15), not a prerequisite.
- **`SlackUserConfig`** remains, classified under
  `providerToolingCredentials` (§9) — the pattern any platform with
  programmatic app-minting will reproduce.

## 12. What Stays in Core

Routing rules and the mention ladder, bot arbitration, thread-affinity maps
and their CP legs, session keys and fencing, visibility, cron/hook
scheduling, the webhook ingress seam (shared signature primitives), webchat
end-to-end, GitHub/GitLab services (participating only via Layer 2), the
drain/lease machinery, and the common CP create skeleton. The registries
themselves are core files; adding a platform edits exactly one line per
host.

## 13. Staging

Each stage lands independently and is independently valuable.

| Stage   | Content                                                                                                                                                                                                                                                                                                                        | Exit criteria                                                                                                                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S0**  | Branch audit: classify every platform branch under the D2 four-way taxonomy. Grep scope: `===`, `!==`, and reversed comparisons (the `===`-only pattern finds 69 lines in `daemon.ts`; the full pattern ~100), across daemon, relay, CP (routes + orchestrator + ws handlers), web, `coordsDecision`, and cron/hook targeting. | A classification table with per-class counts; the manifest field list and strategy-function list are derived from it, not guessed.                                                                                                     |
| **S1a** | Tolerant readers everywhere (platform fields read as `string`); delete `narrowPlatform`; `coordsDecision` becomes registry-driven with fail-closed unknown-chat default; document per-frame unknown-id policy.                                                                                                                 | CP deployed, then one full daemon upgrade cycle (fleet gate). No new ids emitted yet.                                                                                                                                                  |
| **S1b** | Protocol restructure: `OriginKind`×`PlatformId`, `IntegrationSpec` envelope+opaque config (with legacy-emission shim), `NormalizedMessage` thread coordinates + `adapterExt`, `platform_action` envelope, `rc/bot-assign` opaque secrets/ingress, cron/hook targeting. Prisma migrations (enum→text, Bot identity columns).    | Wire round-trips green on both old-shape and new-shape fixtures; behavior-preserving on the four existing platforms.                                                                                                                   |
| **S2**  | Daemon: three-facet adapter contract + renderer seam + key-driven registry; platform code moves to `src/platforms/<id>/`; strategy functions extracted.                                                                                                                                                                        | **`daemon.ts` compiles with zero platform-conditional edits remaining for the four chat platforms** (the audited branches are gone or reclassified); **evals implement the published interface** and the Arena suite passes unchanged. |
| **S3**  | In parallel: relay two-sided ingress contract + registry; CP behavioral providers (routes/reaper/env/DI registration, composed create DTO); web platform modules + `WizardHost`.                                                                                                                                               | Each host's registry is the single platform-set authority; `AddIntegrationModal` is chassis + fragments.                                                                                                                               |
| **S4**  | _(optional, deferred)_ Extract per-platform npm packages.                                                                                                                                                                                                                                                                      | Gated on an actual external consumer; not scheduled.                                                                                                                                                                                   |

## 14. Known Defects Fixed En Route

1. **`narrowPlatform` fold-to-slack** — mints `slack:`-prefixed session keys
   for unknown platforms (already bit Feishu once; recorded in the code
   comment). Fixed in S1a.
2. **Cron anchor coercion** — the web modal coerces Discord/Feishu anchors
   into the closed two-platform union today. Fixed in S1b (§6.8).
3. **Transcript renderer** — Slack mrkdwn token rewriting applies to
   Telegram/Discord/Feishu transcripts. The registry default keeps today's
   behavior; per-platform overrides are an explicit, separately-shipped
   behavior change (§10).
4. **Revocation fenced with the wrong generation** — the relay reported a
   platform revocation against the router's _current_ credential revision, so
   a stale ingest's `auth.test` finishing after a re-assign could revoke the
   replacement credential. Fixed in S3 by capturing the observing
   assignment's revision at ingest construction (§8.1).
5. **An offline daemon ate a Slack one-shot trigger** — the message-shortcut
   path returned "handled" without checking deliverability, consuming the
   trigger id and leaving the operator with neither a modal nor a retry.
   Fixed in S3 by the synchronous `canDeliver` check (§8.1).
6. **Slack event/interaction discrimination by absence** — classifying "no
   `event` field ⇒ interaction" misroutes any envelope shape that omits it.
   Fixed in S3 by discriminating positively on `type === 'event_callback'`;
   caught by the route-conversion tests.
7. **The relay ignored the ingress bag it was sent** — `toBotAssignment` read
   only the legacy named fields, so a CP that had already moved to the §6.7
   opaque ingress bag would have had its new-shape emission silently dropped.
   Fixed reader-first in S1b, one release before the emission flip.

## 15. Third-Party Extensibility: Deferred, Not Foreclosed

Under this design a third party would still need: registry edits in four
hosts (= fork), core-authored Prisma migrations, and public ingress/OAuth
paths added to deployment gateway configuration. That is _upstream
contribution_, which this design makes cheap — not third-party
extensibility. The honest goal is stated in §1.

Four decisions in this design deliberately keep the door open, and are the
minimum future work if third-party support is later funded:

1. Generic bot install-identity columns (D6) — done here.
2. A single generic install-state table replacing the per-platform
   pending-install models.
3. A catch-all public ingress namespace (`/ingress/:platformId/*`) so new
   platforms need no gateway configuration changes.
4. Treating the web registry as the accepted rebuild boundary (a deployment
   recompiles the console to change its platform set).

## 16. Risks

- **Rolling updates (highest).** The S1a fleet gate is a hard precondition
  for emitting any new platform id; skipping it reproduces the
  handshake-loop failure mode. Mitigation: tolerant readers ship first, and
  the codec's existing down-level machinery carries the `IntegrationSpec`
  transition.
- **S2 scope discipline.** The daemon refactor fails if the contract omits
  per-turn adapter state or the converger — that is how "file moves" becomes
  a hidden contract redesign. Mitigation: the S2 exit criteria are stated in
  terms of `daemon.ts` content, and the renderer seam explicitly includes
  converger + applier + turn state (§7.3).
- **Behavior regressions.** The four platforms' behavior is pinned by the
  existing test surface (the daemon suite alone has 50+ Slack-touching test
  files); S1/S2 are behavior-preserving by construction and reviewed against
  that suite. The three known behavior changes are enumerated (§14) and ship
  separately.
- **Capability explosion.** Guarded by the D2 dividing rule; manifest
  additions require a pre-dispatch core read as justification, in review.
- **Audit blind spots.** S0's grep must include negated/reversed
  comparisons and non-`daemon.ts` scopes (relay arbitration, CP orchestrator
  spec assembly, web cron modal), all of which held platform branches the
  `===`-only pattern misses.
