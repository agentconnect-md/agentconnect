# Integration Plugin Architecture

> Related documents:
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

Two designs pay the current scatter cost —
[linear-integration.md](linear-integration.md) is still Proposed and
[gitlab-com-integration.md](gitlab-com-integration.md) is now Implemented —
so the refactor amortizes immediately.

**Scope decision (honest goal):** this design delivers **first-party
modularity now** and **explicitly defers third-party extensibility**. A
third party cannot add a platform to a deployment without forking today (see
§13 for why, and for the short list of cheap decisions that keep that door
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
  the webhook/code-host seam (`relay/src/hooks/`,
  `control-plane/src/{codehost,github,gitlab}/`,
  `daemon/src/{codehost,github,gitlab}/`). They _do_ participate in the
  narrower Layer-2 output surface (§7.6) so the dispatch path stops carrying a
  hardcoded GitHub special case, and in the review-adapter member the seam
  gained when GitLab became its second implementer.
- **No product-behavior changes.** The contracts are a structural seam; where
  a platform's behavior differs, that difference is a manifest field or a
  strategy function, never a core branch.

## 3. Shape of the Result

A platform is four contract implementations plus one registry line per host:

| Host          | Directory                                | Contract                                                               |
| ------------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| daemon        | `src/platforms/<id>/`                    | three-facet adapter (connect / ingress / read port) + turn output (§7) |
| relay         | `src/platforms/<id>/`                    | `RelayPlatformIngressPlugin` (§8)                                      |
| control plane | `src/platforms/<id>/`                    | `CpPlatformProvider` (§9)                                              |
| web           | `src/components/console/platforms/<id>/` | `WebPlatformModule` (§10)                                              |

The shared, pre-dispatch capability table is
`packages/protocol/src/platform-manifest.ts` (§5); everything else a platform
needs to say lives behind its host's contract.

Two rules keep the seam from eroding:

1. **A platform name is never core knowledge.** Core reads a capability, a
   manifest field, or a registry entry — never `platform === '<id>'`. If you
   find yourself editing a `switch` in core, the seam is missing a member and
   that is the bug to fix.
2. **A manifest field is earned by a pre-dispatch read**, or it is a
   capability flag with better branding and belongs in a host contract (§5.2).

GitHub and GitLab are deliberately outside this set — they have no chat
ingress and implement only the narrower code-host surface: Layer-2 turn output
(§2, §7.6) plus the review adapter. Webchat is core-owned for the same class of
reason.

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
  pins its own copy. Package extraction remains possible later, once an
  external consumer actually exists.
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
  `capabilities.platforms`, emitting a new id to a peer that does not read
  tolerantly is a **fatal handshake loop**. Hence the tolerant-reader rule
  (§6.2): readers open first, and emitting a new id is what waits on the
  fleet.
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
  constraint. Public per-platform metadata (`discordAppId`, `feishuAppId`,
  `feishuRegion`) lives in a per-platform JSON bag instead, so the fifth
  platform costs a registry line rather than a migration.
- **D7 — First-party now, third-party deferred** with four named
  keep-the-door-open items (§13).

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

### 5.1 `identityScope` is per-ASSIGNMENT, not per-platform

A per-platform constant cannot express Slack, where **both shapes are live at
the same time**: an install of a distributed platform app is tenant-scoped
(many installs share one app id _and_ one signing secret, so only the
composite `(appId, tenantId)` identifies the bot), while a bot created against
a single-workspace app carries an app id alone, or no app id at all. Declaring
`identityScope: 'tenant'` for the platform would either strand those bots or,
worse, invite a signature scan that resolves a callback to a _sibling install
of the same app_ — one workspace's messages delivered to another tenant's bot.
The axis therefore belongs to the assignment, derived from the identity the CP
actually stamped on it:

- **tenant id present** ⇒ composite index only. Assign-derived, **never
  learned** from traffic, eagerly evicted on unassign — and a re-assign that
  _gains_ a tenant id must evict the bot's stale app-only entry, or the
  weaker index would keep answering cross-tenant.
- **app id only** ⇒ app index, which **may** be learned from the first
  verified delivery (bounded, lazily evicted).
- **neither** ⇒ no index entry; the bot is reachable only through the bounded
  verify-scan, which skips same-secret siblings whose assigned tenant differs.

What survives at manifest scope is the weaker statement that a platform's
identity vocabulary _has_ a tenant axis at all (Slack `team_id`, Feishu
tenantless) — the CP still needs it to know which columns to persist (§11).
The relay reads scope from the assignment, never from the manifest.

### 5.2 What the manifest actually carries

The field list above is the **candidate** list, not a contract. The manifest
that exists (`packages/protocol/src/platform-manifest.ts`) carries three
fields: `membershipEnumeration`, `botSenderRouting`, and `dmChannelPattern`.
The last is **not** in the published list above; it was earned by a
pre-dispatch read (gated-conversation discovery must recognize a DM before any
target resolves, and a Slack `app_mention` can omit `channel_type`). A field
lands in the same change as the branches it retires.

Status-bar shape is the counter-example: it reads like a capability, but every
read of it happens from a turn that already exists, so it is post-dispatch and
belongs to an adapter strategy. **A manifest field is earned by a pre-dispatch
read, or it is a capability flag with better branding** — the exact pattern
this architecture exists to delete. The remaining candidates stay candidates
until a branch is actually retired by one.

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

### 6.2 Tolerant readers

Constraint (verified): zod strips unknown object keys but **rejects unknown
enum values**; a known frame type with a failing payload is refused
(`wire.ts`), and `register.capabilities.platforms` rides the handshake — so a
closed enum means a new platform id reaching a peer that predates it kills
the handshake and the daemon enters a reconnect loop.

Every peer's _readers_ therefore accept `z.string()` for platform fields, and
the per-frame unknown-id policy is fixed:

- `register` — accept; unknown capability ids are simply never matched.
- `event`/`session` — store the value verbatim.
- `rd`/`msg` — decode succeeds; refusal, if any, is a semantic per-item
  verdict, never a socket-level failure.

This is what lets a platform ship without a lockstep fleet upgrade: a daemon
older than the CP keeps working, and the id it does not recognize stays inert
rather than fatal. The rule is pinned by
`packages/protocol/src/platform-tolerance.test.ts`. Writers still emit only
ids the registry knows; **emitting** a new id is what waits on the fleet, not
the schema.

### 6.3 `IntegrationSpec`: core envelope + opaque config

```ts
interface IntegrationSpec {
  integrationId: string
  agentId: string
  platform: string // open; `platformId` in an earlier draft of this section
  core: { bindRules; allowedUserIds; mutedChannels; gated; mode } // owned & read by core
  config?: unknown // opaque on the wire; validated by the platform module on the daemon
}
```

The daemon-side agent-config schema (`agents/agent-schema.ts`) migrates with
it — the same closed union lived in two places.

**As shipped (#634), with three corrections to the sketch above.** The field
is `platform`, not `platformId`: the wire spells this axis `platform`
everywhere else, and renaming it here would have bought a second name for one
concept. `core` is **required** and a core-less spec fails the frame — by the
time this landed, an absent envelope could only come from a stale writer, and
defaulting it would silently mint a rule-less integration. `config` is
optional and is validated by the **reader**, not the frame: a spec whose
config is missing or malformed is skipped with a warning rather than failing
the whole `register/ok` snapshot it rides in. On the daemon side the migrated
schema is `IntegrationSchema` in `agents/agent-schema.ts`; the protocol's
`AgentSpec` is a different object and was not the union in question.

**The legacy-emission shim was never built and is no longer reachable.** This
section originally paired the flatten with a down-level encoding (the
`codec.ts` pattern) so old daemons would keep receiving the nested
per-platform shape until a fleet gate passed. That staging was overtaken: the
deployment is pre-release with a self-controlled fleet, so #634 shipped a
single-release cutover instead — a new CP skips specs an old daemon cannot
read, and an old CP fails the handshake against a new daemon. See that PR's
compatibility notes for the enumerated at-rest cases.

### 6.4 `NormalizedMessage`: generic thread coordinates + adapter extension

`threading: 'per-message' | 'topic' | 'none'` is a label, not a data model —
the current schema accretes named per-platform fields (a topic id vs a
reply-chain root vs a promote-to-thread flag). S1b introduces:

- a generic coordinate model `{ threadId?, topicId?, promoteToThread? }`
  consumed by core session-keying, and
- `adapterExt?: Record<string, unknown>` namespaced by platformId, opaque on
  the wire, round-tripped back to the adapter at render time.

`threadUrl?` is the generic presentation coordinate for the integration that
owns the normalized session coordinates: an ingress adapter attaches the exact
provider message/thread URL when one exists, and core only persists and
forwards it. An event anchored into another integration therefore uses that
target's link strategy when available rather than its original source URL. A
link that depends on live adapter identity (Slack's workspace URL) remains a
post-dispatch adapter strategy per D2, not a manifest flag or a console platform
branch.

Named `telegram*` / `discord*` fields are deprecated behind the projection.

`channel` consistently names the enclosing configurable conversation; `thread`
names the logical thread inside it. This includes Discord even though its provider API
models a thread as a channel: Discord ingress emits `{ channel: parentChannelId,
thread: threadChannelId }`, and its output adapter selects `thread ?? channel` as the
concrete API destination. The retired `parentChannel` normalized field and the former
`{ channel: threadChannelId, thread: threadChannelId }` shape are migrated daemon-locally.

### 6.5 `platform_action`: a semi-opaque envelope

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

### 6.6 `rc/bot-assign`: opaque secrets + opaque ingress config

Demux metadata is per-platform (Slack: `apiAppId` + `teamId` with the
shared-secret composite-key invariant; Feishu: `appId` only), so the
assignment frame gains `{ platformId, secrets: opaque, ingress: opaque }`
with shape validation delegated to the platform module on both ends.

### 6.7 Cron/hook targeting opens

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

The slot is two-sided, mirroring the daemon's, and it splits along two axes:
the **plugin** is per-platform and stateless, while the **per-bot ingress** it
builds owns that bot's credentials (`packages/relay/src/platforms/contract.ts`).

```ts
interface RelayPlatformIngressPlugin<TIngest, TVerified> {
  // Every lifecycle edge goes through the plugin — assign → build,
  // rotate → rebuild, unassign/revoke → stop — and core keeps one pool per
  // platform.
  buildIngest(assignment, host): TIngest
  // Demux is stateful and per-platform: Slack signature-scans the assigned
  // bot registry with a learned (api_app_id, team_id) index; Feishu demuxes
  // on body app_id with optional AES decrypt.
  extractDemuxHints(rawBody): Hints
  // Returns the plugin's TYPED product, not a boolean verdict: Feishu's
  // verify decrypts, and the decrypted payload has to reach handle() —
  // deriving it a second time there is both wasteful and a place for the two
  // derivations to disagree. `undefined` means reject.
  verify(ingest, rawBody, body, headers, now): TVerified | undefined
  // Two platforms require SYNCHRONOUS bodies on the HTTP 200 (Slack
  // block_suggestion options; Feishu card-action toast), so handle() is async:
  // the Feishu plugin awaits host.forwardAction(...) and surfaces the
  // daemon-produced toast in the same HTTP response. Deadline ownership: the
  // PLUGIN races the daemon round trip against the platform's response window
  // (Feishu ~2.5s, Slack's 3s trigger) using the host clock, degrading to an
  // ack-only body on timeout; the HOST enforces one outer hard cap so a
  // misbehaving plugin cannot pin the HTTP worker. Events are ACK'd inside
  // that window and handled asynchronously — the plugin pushes through the
  // host rather than returning work the route would have to wait for.
  handle(ingest, verified, host): Promise<{ syncResponse?: unknown }>
}

interface RelayBotIngress {
  stop(): Promise<void>
  // Slack performs relay-side egress; Feishu deliberately keeps egress on the
  // daemon. Facet presence IS the `relayOwnsEgress` capability read.
  egress?: { notice; lookupUserName }
}

interface RelayHostServices {
  // NORMALIZED messages, not pre-addressed deliveries: arbitration and the
  // routing ladder stay in core (§12), so a plugin never resolves a target.
  forward(botId, WireNormalizedMessage)
  // The one call that carries a route — and it must not re-resolve one.
  forwardAction(msg, route): Promise<AckResponse>
  // Fenced with the revision the OBSERVING ingest was built from, never the
  // mutable current one: assignments start fire-and-forget, so an older
  // ingest's auth.test can land after a newer assignment installed.
  reportRevoked(reason, credentialRevision, atMs?)
  reportChannels
  reportConversation
  // Three trust models, not one lookup. targetForAgent requires a live routing
  // rule (status-modal actions); integrationTarget is directory-only, because a
  // rendered card's target may outlive the rule that created it and the
  // daemon's active-card map is the terminal fence; soleTarget is the
  // single-install fallback for cards rendered before action values embedded a
  // target. Collapsing them would either break stale-but-legitimate
  // interactions or route them by guess.
  directory: { targetForAgent; integrationTarget; soleTarget }
  // Load-bearing for one-shot triggers: a Slack shortcut's trigger id is
  // consumed by returning true, so an offline daemon must fall back to the
  // local unavailable modal while the trigger is still valid.
  canDeliver(route): boolean
  clock
  selfRelayId
  log
}
```

Challenge handling is not a third arm of `verify`. Slack's `url_verification`
is answered by the route BEFORE any candidate is selected (it is
unauthenticated by design — the documented pre-candidate exception), while
Feishu's challenge is _encrypted_ and therefore necessarily flows
verify → handle like any other event.

Relay core keeps: bot arbitration, the 3-leg thread-affinity dance, pending
report queues, fencing, retry backoff, and event-identity dedup _storage_.
Dedup identity is per-assignment composite, per §5.1 — the plugin mints
`(appId, tenantId, eventId)` because it derives from parsed action semantics,
and core owns the TTL table. Four platform reads that would otherwise sit in
core are capability reads per D2: Slack-only bot-mention admission
(`botSenderRouting`), thread-root detection (adapter `isThreadRoot` or the
threading capability), the Feishu egress-ownership fork (`relayOwnsEgress`
derived from the `egress` facet), and the echo-suppression guard. The
existing `hooks/signature.ts` primitives are shared relay-core
infrastructure serving both this seam and the webhook seam.

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
  // §6.6. These are today's integrationToSpec / httpIntegrationToSpec /
  // HttpBotService.buildAssign branches, relocated behind the provider.
  // Both projectors are ASYNC, and the provider owns loading from any
  // additional secret stores it maintains: `secrets` carries the bot-level
  // material core already holds, but e.g. the Linear design keeps rotating
  // integration-scoped tokens in its own encrypted table — the provider
  // loads those itself inside the projector, and core always awaits,
  // never growing a per-platform preload branch. Secret material is never
  // persisted inside platformConfig JSON.
  projectIntegrationConfig(integration, bot, secrets): Promise<unknown> // -> IntegrationSpec.config (§6.3)
  projectBotAssign(bot, secrets): Promise<{ secrets: unknown; ingress: unknown }> // -> rc/bot-assign (§6.6)
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
- **Adjacent per-platform services get audit homes, not new slots:** Session
  visibility has its own `SessionAccessPlugin` list. Each provider contributes
  its verified viewer identities and resolves its current external scopes;
  core only composes `canView(agent)` with those results. Preset default-binding
  remains a documented core→plugin reference (preset provisioning names a
  platform's install machinery).

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
  default for all chat platforms; a per-platform override is a separate,
  explicit behavior change, never a side effect of the registry landing.
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
  a third-party-era consolidation (§13), not a prerequisite.
- **`SlackUserConfig`** remains, classified under
  `providerToolingCredentials` (§9) — the pattern any platform with
  programmatic app-minting will reproduce.

## 12. What Stays in Core

Routing rules and the mention ladder, bot arbitration, thread-affinity maps
and their CP legs, session keys and fencing, visibility, cron/hook
scheduling, the webhook ingress seam (shared signature primitives), webchat
end-to-end, GitHub/GitLab services (participating via Layer 2 and the review
adapter), the drain/lease machinery, and the common CP create skeleton. The
registries themselves are core files; adding a platform edits exactly one line
per host.

## 13. Third-Party Extensibility: Deferred, Not Foreclosed

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

## 14. Risks

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
  files). Extraction is behavior-preserving by construction and reviewed
  against that suite; any behavior change ships separately and explicitly.
- **Capability explosion.** Guarded by the D2 dividing rule; manifest
  additions require a pre-dispatch core read as justification, in review.
- **Audit blind spots.** S0's grep must include negated/reversed
  comparisons and non-`daemon.ts` scopes (relay arbitration, CP orchestrator
  spec assembly, web cron modal), all of which held platform branches the
  `===`-only pattern misses.
