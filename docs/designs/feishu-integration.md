# Lark / Feishu Integration Design

> **Status:** Implemented. The integration supports topic-thread replies and
> authenticated attachment downloads. It supports **both** international Lark
> (`open.larksuite.com`) and mainland China Feishu (`open.feishu.cn`), selected
> per integration by a `region` field (see section 10). Inbound delivery supports
> daemon-owned Long Connection and relay-assisted HTTP callbacks. The Console
> defaults to Long Connection and offers HTTP when public callback delivery is
> available; outbound messages and attachment downloads remain on the daemon in
> both modes.
>
> Related documents:
> [architecture.md](architecture.md),
> [daemon-detailed-design.md](daemon-detailed-design.md),
> [slack-integration-install.md](slack-integration-install.md).

## 1. Goal

Add Lark, branded as Feishu in mainland China, as the fourth instant-messaging
platform adapter beside Slack, Telegram, and Discord. In the Console, a user can
install a Lark / Feishu bot for a placed agent. Mentioning the bot in a group or
sending it a direct message then drives the local coding agent, whose response
streams back to Lark / Feishu.

**Non-goals for v1:** Lark / Feishu Base, Docs, Approvals, and other Open API
capabilities; marketplace distribution or a prebuilt one-click application;
and one Lark / Feishu bot serving multiple agents. v1 supports a custom application,
one tenant, and text messages, matching Discord v1.

> **Region (Lark vs Feishu):** the integration supports **both** the international
> Lark region (`open.larksuite.com`) and mainland China Feishu
> (`open.feishu.cn`). The operator picks one when installing, and the choice
> rides a `region: 'feishu' | 'lark'` field end to end (see section 10). Both
> regions share the same app model (`appId` + `appSecret`), SDK
> (`@larksuiteoapi/node-sdk`), and message shapes — only the open-platform
> gateway host differs.
>
> Public-facing text uses Lark first. The stable internal platform key remains
> `feishu`, so identifiers, paths, and wire fields keep their Feishu-prefixed
> names for compatibility.

## 2. Key decision: support both Long Connection and HTTP callback ingress

The architecture has a hard constraint: **the daemon exposes no
public ingress endpoint**, because it may run behind NAT or on an internal
network. A direct platform transport therefore establishes its connection
outbound from the daemon; a platform that requires callbacks terminates them on
the optional public relay:

| Platform          | Inbound transport                    | Connection direction          | Credentials                                                  |
| ----------------- | ------------------------------------ | ----------------------------- | ------------------------------------------------------------ |
| Slack             | Socket Mode over WebSocket           | Outbound                      | `botToken` + `appToken`                                      |
| Telegram          | Long polling with `getUpdates`       | Outbound                      | One `botToken`                                               |
| Discord           | Gateway over WebSocket               | Outbound                      | One `botToken`                                               |
| **Lark / Feishu** | **Long Connection or HTTP callback** | **Outbound or inbound HTTPS** | `appId` + `appSecret`; callback verification values for HTTP |

Lark / Feishu offers a **long-connection mode**. `Lark.WSClient` in the official
`@larksuiteoapi/node-sdk` version 1.24.0 or later establishes a full-duplex
WebSocket to the platform with `appId` and `appSecret`. Events arrive through
that socket with **no public IP, tunneling, or custom callback signature and
decryption work**. This is structurally equivalent to Slack Socket Mode and the
Discord Gateway.

When a relay pool and stable public callback address are available, Lark / Feishu may
instead use HTTP callbacks. The relay verifies the exact raw request, decrypts
encrypted envelopes when configured, checks the Verification Token, deduplicates
the event ID, normalizes the message, and forwards a pre-addressed `rd/msg` to
the owning daemon. The daemon keeps an API-only Lark / Feishu client for replies,
identity lookup, and authenticated attachment downloads; it does not open
`WSClient` in this mode.

See the Lark / Feishu "Receive events through WebSocket" documentation and the
`WSClient` plus `EventDispatcher` implementation in
[larksuite/node-sdk](https://github.com/larksuite/node-sdk).

Long Connection is the Console default. HTTP becomes an explicit operator
choice when callback delivery is available. HTTP transport does not imply a
multi-agent bot: Lark / Feishu remains one bot to one agent in this phase.

Lark / Feishu v1 differs from Discord v1 in only three important ways, expanded in
section 7:

1. It uses **two credentials**, `appId` and `appSecret`, rather than one token.
   These reuse the existing two credential slots:
   `bot_secret.botToken` and `bot_secret.appToken`.
2. **Attachments require authenticated downloads.** An `image_key` or
   `file_key` must be fetched through an API request carrying a
   `tenant_access_token`, making it more like Slack than Discord's public CDN.
3. Rich text and buttons use an **interactive message card** whose callbacks
   arrive as `card.action.trigger`. This is more involved than Discord message
   components. The current integration streams agent replies through CardKit and
   exposes Cancel run in the reply card; other session controls remain text commands.

## 3. Reuse the per-platform silo pattern

The codebase deliberately has no unified `Connection` interface. Each platform
is an **independent vertical silo** with its own connection array,
`Map<integrationId, Conn>`, reconciliation loop, converger, and apply path.
Each platform keeps a separate connection map, reconciliation loop, and
converger rather than sharing one connection abstraction.

The internal `feishu` silo follows the same package boundaries as the other
platform adapters while retaining its own credentials, connection lifecycle,
and event mapping.

## 4. Change inventory by layer

Every place that adds `'feishu'` to an enum is marked `[enum]`. Missing any one
can make the platform silently unavailable at one layer; see the three-part
capability invariant in section 5.

### 4.1 `packages/protocol`: the daemon-to-Control-Plane wire contract

- In `src/frames/integration.ts`:
  - Add the Zod schema `IntegrationFeishuConfig`:

    ```ts
    export const IntegrationFeishuConfig = z.object({
      mode: z.enum(['direct', 'shared']).default('direct'),
      appId: z.string(), // cli_... application ID; a semi-public identifier
      appSecret: z.string(), // Secret; never log it
      botOpenId: z.string().optional(), // Bot open_id for mention routing; resolve lazily through bot/info
      bindRules: z.array(IntegrationBindRule).default([])
    })
    ```

  - Add an `[enum]` branch to the `IntegrationSpec` discriminated union:
    `{ integrationId, agentId, platform: z.literal('feishu'), feishu:
IntegrationFeishuConfig }`.
  - Update the security header to state that `appSecret` is a plaintext secret
    and no body may be dumped.
- Add `'feishu'` to the `[enum]` `Platform` in `src/frames/route.ts`, which also
  defines `SessionKey` and `BindRule`.
- Add `'feishu'` to the cron target-platform `[enum]` in
  `src/frames/cron.ts`.
- Add a Lark / Feishu branch to round-trip tests in `src/codec.test.ts`.

### 4.2 `packages/control-plane`

**Prisma and migration**

- In `prisma/schema.prisma`:
  - Add `'feishu'` to `[enum] enum Platform { slack telegram discord feishu }`.
  - Keep Lark / Feishu API credentials in the existing slots: `appSecret` maps to
    `botToken` and `appId` maps to `appToken`.
  - Add encrypted nullable `verificationToken` and `encryptKey` fields to
    `BotSecret` for HTTP callback verification. These values are sent only to
    the relay; the App Secret is sent only to the daemon.
- Add migrations for the Lark / Feishu platform and callback credential columns.
- Run `prisma:generate`. The generated client under
  `src/generated/prisma` is committed.

**HTTP and routes**

- Add `src/http/feishu-identity.ts`, following `discord-identity.ts`:
  - `verifyFeishuBot(appId, appSecret)` returns
    `'ok' { name } | 'invalid' | 'unreachable'`. Verify both credentials with
    `POST /open-apis/auth/v3/tenant_access_token/internal`, then optionally
    obtain the bot name from `GET /open-apis/bot/v3/info`.
    **Only explicit credential error codes such as 10003 or 99991663 count as
    `invalid`. Network instability is always `unreachable` and does not block
    installation.** Never log the secret.
- Add a Lark / Feishu branch to `POST /integrations` in
  `src/http/routes/integrations.ts`: verify credentials, call
  `botRepo.create(...)`, store
  `{ botToken: appSecret, appToken: appId }` through `botSecret.put`, create the
  integration, then either send a direct spec or synchronize the HTTP bot with
  the relay and its send-only daemon spec.
- Add `POST /integrations/feishu/app` and
  `GET /integrations/feishu/app/:id` for the default one-click path. The first
  route starts the official app-registration device flow and returns only a
  direct authorization URL plus an opaque registration ID. The second polls
  the durable registration status.
- Keep the reviewable template in `src/http/feishu-app-template.ts`: use
  `createOnly: true`, the platform `PersonalAgent` preset, AgentConnect's
  tenant scopes (including `tenant:tenant:readonly`) and
  `im.message.receive_v1`.
- Start every device flow on the canonical `accounts.feishu.cn` issuer. For
  Lark, preserve the returned `user_code` while changing the user-facing
  launcher to `open.larksuite.com`; direct issuance from
  `accounts.larksuite.com` produces launcher codes that are rejected as
  expired. Keep polling the issuer until the provider reports a Lark tenant,
  then switch polling to `accounts.larksuite.com`.
- Persist the provider device cursor and provisional App Secret through
  `SecretCipher` in `feishu_app_registration`. A short database claim lets any
  Control Plane replica resume polling/finalization without duplicate installs;
  pre-reserved bot/integration IDs make retries idempotent. Clear both secrets
  on every terminal outcome and TTL-reap old rows.
- After approval, pass the returned App ID and App Secret directly to the same
  bot-secret installation helper used by the manual route only after the App's
  `tenant_key` matches the configured regional Login App's `tenant_key`. This
  requires every new App and the Login App to belong to the same Lark/Feishu
  organization, but does not require the same human to create or authorize
  them. Never return either credential from the registration routes.
- In `src/http/dto/index.ts`:
  - Add `'feishu'` to the `platform` `[enum]` in `CreateIntegrationBody`; add
    optional `feishu: z.object({ appId, appSecret })`; and update both
    `superRefine` guards for choosing exactly one of `botId` or a credential
    block and for rejecting cross-platform credential blocks.
  - Add `'feishu'` to the `Platform = z.enum([...])` used for cron and hook
    DTOs.
  - Add nullable `feishuAppId` to `BotDto` only if the public-column design is
    selected.
- Add `'feishu'` to the `IntegrationPlatform` `[enum]` in
  `src/http/daemon-platform-capability.ts`.
- Add optional `verifyFeishuBot?: FeishuBotVerifier` to `src/http/deps.ts`.
- Inject `verifyFeishuBot` from `src/container.ts`.
- Include `feishuAppId` in bot DTO mapping in `src/http/routes/bots.ts` only if
  the column is selected.

**Orchestration and persistence**

- Add a Lark / Feishu branch to `integrationToSpec()` in
  `src/orchestrator/placement.ts`:

  ```ts
  if (i.platform === 'feishu') {
    return {
      integrationId: i.id,
      agentId: i.agentId,
      platform: 'feishu',
      feishu: {
        mode: 'direct',
        appId: secret.appToken ?? '',
        appSecret: secret.botToken,
        bindRules
      }
    }
  }
  ```

  Observe the two-slot mapping from section 7.1:
  `botToken = appSecret`, `appToken = appId`.

- `httpIntegrationToSpec()` emits the same API credentials with
  `mode: 'shared'` plus the verified bot `open_id`. This tells the daemon to
  initialize API egress without opening `WSClient`.

- Pass `'feishu'` through unchanged in `toDbPlatform()` in
  `src/persistence/platform.ts`. It is a persisted platform, unlike
  session-only webchat or hook sources.
- If the public `feishuAppId` column is selected, add it to `BotRecord` and
  creation mapping in `src/persistence/ports.ts` and
  `repositories/integration.repo.ts`, following `discordAppId`.
- Add Lark / Feishu coverage to `test/fixtures/seed.ts` and
  `test/integration/integrations.route.test.ts`.

### 4.3 `packages/daemon`

**Add a `src/feishu/` silo modeled on `src/discord/`:**

- `connection.ts` defines `FeishuConnection`, `FeishuDeps`,
  `ConsolidatedFeishuGroup`, and `consolidateFeishu(agents)`. Consolidation
  groups by `appId`; connection identity also includes region and ingress mode.
  - `start()` always constructs `Lark.Client(...)` for outbound APIs:
    messages, resources, and bot info. In direct mode it also constructs
    `Lark.WSClient({ appId, appSecret })`, registers
    `im.message.receive_v1` on a `Lark.EventDispatcher`, and calls
    `wsClient.start(...)`. Shared mode stops after API-client initialization.
  - Outbound methods include `postMessage` through `im.message.create` with
    `msg_type: 'text'` and chunking at the platform limits, `postChrome`,
    `updateMessage` through `im.message.patch` or card
    `im.message.update`, and `sendChatAction`. Lark / Feishu has no typing API, so the
    last may be a no-op or a temporary "typing" card.
  - Use `chat_id` for conversations. Replies call the reply API with
    `root_id` and `parent_id`. The v1 simplification mirrors Discord's
    "thread = channel" model; normalization below refines it.
  - `downloadFile` is **authenticated**:
    `im.messageResource.get({ message_id, file_key, type })`, with tokens
    maintained by the SDK. Attachment bytes remain daemon-local.
  - MCP read tools include `getChannelInfo` through `im.chat.get`,
    `listMembers` through `im.chatMembers.get`, `listChannels` through
    `im.chat.list`, and `getUserProfile` through `contact.user.get`. The latter
    needs additional permission and degrades when unavailable.
  - Reuse `PlatformSendQueue` from `src/platforms/send-queue.ts` for FIFO outbound
    delivery.
  - **Three-second constraint:** event callbacks must return within three
    seconds. A handler only normalizes and enqueues through `onMessage`; it
    never waits synchronously for an agent.
- `normalize.ts` defines `normalizeFeishuMessage(msg, ctx)`,
  `FeishuMessageLike`, `toAttachment()`, and `humanizeFeishuText()`.
  - Set `platform: 'feishu'`, `channel = chat_id`, and for a group set
    `thread = root_id ?? message_id`; for a direct chat use `chat_id`.
    Group topics use their root as the session key and reply anchor, while P2P
    uses the chat. See section 7.4. Set `sender.id = union_id`; reject an event
    that does not provide it.
  - A mention matches when `event.message.mentions[]` contains the bot's own
    open ID.
  - `isDm` is `chat_type === 'p2p'`.
  - Lark / Feishu text represents mentions as placeholders such as `@_user_1` plus a
    mapping. Convert them to readable `@name`; flatten `post` rich text to plain
    text.
  - A top-level group message outside P2P and outside a topic may set
    `feishuTopLevel` so the daemon can open a topic. v1 may instead reply
    directly in the group; see section 7.3.
- `render.ts` defines `FeishuConverger`, constructed with output `mode` and
  providing `hasBuffered` and `flushBuffered`, producing `FeishuAction[]`; a
  `chunkForFeishu()` helper; CardKit reply builders; and the stable Cancel action
  value handled from `card.action.trigger` in either delivery mode.
- An optional `app-commands.ts` is unnecessary because Lark / Feishu has no native
  Discord-style slash-command registration. Existing `parseCommand` can handle
  `/status`, `/models`, `/effort`, `/permission`, `/fast`, `/stop`, `/cancel`,
  and `/queue` as text.
- Add `test/feishu-normalize.test.ts` for mentions, attachments, humanization,
  and chunking.

**Edit central `src/daemon.ts`**, following roughly forty Discord touchpoints:

- Import `consolidateFeishu`, `FeishuConnection`, `FeishuConverger`, and card
  builders.
- Add `private feishuConns: FeishuConnection[]` and
  `private fsConnByIntegration = new Map<string, FeishuConnection>()`. Keep the
  map separate so Slack reconciliation never reads `.appToken` from a non-Slack
  connection.
- Call `reconcileFeishuConnections()` from startup, periodic reconciliation,
  and soft reconciliation, matching Discord's three call sites.
- If topic creation is included, add `dispatchFeishuTopLevel()` and
  `feishuThreadName()`.
- Add `handleFeishuSelect()` for card selection and reuse
  `handleStatusAction()`.
- Route `applyFeishuAction(p, action)` through `enqueueApply()` by
  `p.platform`.
- Widen unions for `conv`, optional `conn`, converger construction,
  `replyConnFor`, `gatewayFor`, status links, and selection cards to include
  Feishu types.
- Add `'feishu'` to the `[enum]` platform list from
  `daemon.ts#capabilities()`: `['slack', 'telegram', 'discord', 'feishu']`.
- Stop all `feishuConns` during shutdown.
- Add `'feishu'` to `NormalizedMessage.platform` in
  `src/messages/normalized.ts`, plus optional `feishuTopLevel?: boolean`.
- Add a Lark / Feishu branch to `src/router/routing-rule.ts`, extracting
  `staticBotUserId` from `botOpenId` together with its `bindRules`.
- Add `FeishuConfigSchema` to the `IntegrationSchema` discriminated union and
  `'feishu'` to the cron target platform in `src/agents/agent-schema.ts`.
- Add a Lark / Feishu branch in `src/agents/write-integration.ts` so
  `IntegrationSpec.feishu` persists to `agent.json`. Persisting credentials lets
  the daemon recover after restart while the Control Plane is unavailable.
- Add `@larksuiteoapi/node-sdk` to `package.json`.

### 4.4 `packages/web`

- Add a `feishu` and optional `lark` branch with the Lark / Feishu brand SVG in
  `src/components/marks.tsx#PlatformMark`.
- In `src/components/console/modals/AddIntegrationModal.tsx`:
  - Add `{ key: 'feishu', label: 'Lark' }` to `BOT_PLATFORMS`; see the scope
    note in section 1.
  - Make **One-click** the default for a new bot. Open the authorization URL in
    a new tab, poll the opaque registration ID, and refresh the integration
    list when setup completes. This is a direct deeplink; the user does not
    need to scan a QR code.
  - Keep Long Connection as the default delivery mode. When public callback
    delivery is available, One-click may switch to HTTP; after authorization
    the Control Plane configures the relay Request URL and callback
    verification keys through the application-config OpenAPI.
  - Keep **Manual** as the advanced fallback. It renders App ID and App Secret
    inputs and defaults to Long Connection.
  - When public callback delivery is available, Manual may switch to HTTP and
    additionally collect the Verification Token plus optional Encrypt Key. Show
    the stable `/feishu/events` Request URL.
  - Show the setup checklist only for manual or existing-app setup and keep it
    synchronized with the selected transport.
  - Optionally derive an "Add to group" link from `feishuAppId`.
- Add
  `<PlatformBotsCard platform="feishu" label="Lark" ...>` to
  `src/components/console/views/SettingsView.tsx`.
- Extend the `CreateIntegrationInput` discriminated union and session-platform
  display in `src/lib/api.ts`, adding `feishuAppId` to `BotDto` only if selected.
  `DaemonCapabilities.platforms` naturally carries it.
- Add a Lark / Feishu demonstration row to `MOCK_BOTS` in
  `src/lib/data-context.tsx`.

## 5. Three-part capability invariant

Three layers jointly determine whether a platform can be installed. Missing any
one silently disables it:

1. The **daemon** lists supported adapters in `capabilities().platforms`.
2. The **Control Plane** stores that capability and
   `integrationPlatformAvailability()` checks
   `daemon.capabilities.platforms.includes(platform)`, otherwise returning
   unsupported with 409.
3. The **web** modal filters `BOT_PLATFORMS` by `daemon.caps.platforms`.

All three must include `'feishu'` for end-to-end selection.

## 6. Credential flow and security

At one-click installation, the Console starts registration and the Control
Plane returns a provider authorization deeplink. After the user confirms the
app and permissions, the SDK returns `appId` and `appSecret` only to the
Control Plane. It exchanges those credentials for a tenant token, calls the
tenant-information API, and compares the resulting `tenant_key` with the
configured regional Login App's `tenant_key`; a mismatch fails setup before
any Bot is installed. The manual credential path runs the same tenant check.
The Login App ID/Secret are mirrored from the Logto connector into deployment
configuration so this is an App-to-App comparison rather than an inference
from whichever human happens to be installing the Bot. Both Apps must publish
`tenant:tenant:readonly` so their tenant can be resolved.
`verifyFeishuBot` validates the credentials and `botSecret.put` stores
`{ botToken: appSecret, appToken: appId }`; `integrationToSpec` then distributes
the integration to the daemon, which persists it in `agent.json` and starts
`WSClient`.

The browser receives only the authorization URL, expiry, status, and final
integration ID. The manual fallback enters at `verifyFeishuBot` with an App ID
and App Secret supplied by the user. Long Connection follows the same direct
path. HTTP additionally stores `verificationToken` and optional `encryptKey`,
broadcasts only those callback credentials plus `appId` to the relay, and sends
the daemon a `mode: 'shared'` spec containing `appId` + `appSecret` for provider
API egress.

- `appSecret` is a plaintext secret. Wire frames and `agent.json` share the
  existing trust boundary, and the secret **must never be logged**. Preserve the
  security rule at the top of `integration.ts`; a decoding failure must not
  dump the body.
- `appId`, usually shaped like `cli_...`, is a semi-public identifier. It may
  additionally be mirrored to public `bot.feishuAppId` solely for a Console
  group link, but the connection still reads the two credential slots.
- Uninstalling through `DELETE /integrations` removes only integration
  metadata. It retains the bot and credentials and marks the bot free for reuse,
  matching existing behavior.
- Session audience checks use this already-required Bot credential to enumerate
  chat member `union_id` values. They do not store or refresh a human access
  token. The separately configured Login App secret is used only as the
  deployment tenant anchor during Bot installation; it is not on the Session
  authorization path.

## 7. Lark / Feishu-specific decisions

### 7.1 Store two credentials in the existing Slack slots

`bot_secret` already has `botToken` and nullable `appToken`, introduced for
Slack Socket Mode and made nullable for Telegram. Lark / Feishu maps its API
credentials onto those slots:

- `botToken` <- secret `appSecret`, the primary slot
- `appToken` <- identifier `appId`, the secondary slot

HTTP callback mode adds encrypted-at-rest `verificationToken` and optional
`encryptKey` fields to the same secret row. These are sent only to the relay;
the App Secret is never part of the relay assignment.

`integrationToSpec`, `write-integration`, and `verifyFeishuBot` follow the
mapping. Because `appId` is semi-public, it may be additionally mirrored into
`bot.feishuAppId`, following `discordAppId`, for Console links only. It never
participates in authentication from that public column.

The alternative adds explicit `appId` fields to `IntegrationFeishuConfig` and
`BotSecretMaterial`. That is clearer semantically but touches ports,
repositories, and DTOs. **Reuse the two slots first** for the smallest change
and a shape parallel to Slack.

### 7.2 Attachments use authenticated downloads

Images and files arrive as `image_key` and `file_key`. Fetch them through
`im.messageResource.get` using a `tenant_access_token`, whose refresh the
`Lark.Client` SDK maintains. Unlike a public Discord CDN fetch,
`downloadFile` receives `message_id`, `file_key`, and `type`. It still enforces
`DEFAULT_MAX_ATTACHMENT_BYTES`. Failure degrades to a resource link and never
breaks the turn.

### 7.3 Reply streaming uses CardKit; other controls stay text-first

- **Sending:** agent turns use one CardKit entity that streams cumulative text
  updates and is finalized in place. Short control messages remain
  `msg_type: 'text'` and respect the platform text limit.
- **Status, cancellation, and model selection:** the active reply card exposes
  Cancel run through an overflow item. Its `card.action.trigger` callback resolves
  the rendered message ID against daemon-local session state in both Long
  Connection and HTTP/Relay modes. Other controls continue to use text commands
  such as `/status`, `/models opus`, and `/permission`.
- **Typing indicator:** Lark / Feishu has no Discord-style typing API, so
  `sendChatAction` may be a no-op.

### 7.4 Session and topic model

Lark / Feishu **group chats** support topic threads by replying to a message.
`channel` is always `chat_id`. `thread` is the topic's root message ID:
`root_id` on a reply inside a topic, or the current `message_id` for the first
mention that starts a topic. An entire topic becomes one session, and the same
key is the **reply anchor**. The agent uses
`im.message.reply(reply_in_thread: true)` to remain in the topic rather than
posting flat in the group, aligning with Slack and Discord.

A P2P chat has no topic, so it is keyed by `chat_id` and the whole direct
message is one session. Prefixes distinguish anchors at the connection layer:
`om_...`, a message ID, means reply in a thread; `oc_...`, a chat ID, means a
flat send.

### 7.5 Platform setup prerequisites in the web checklist

The default one-click flow uses the official `PersonalAgent` app template and
pre-fills AgentConnect's event and permission additions. They include
`im.message.receive_v1`, message send/read and resource scopes,
`im:chat:read`, `im:chat.members:bot_access`,
`im:chat.members:read`, `contact:contact.base:readonly`,
`contact:user.base:readonly`, and `tenant:tenant:readonly`. The contact scopes
preserve best-effort participant names and avatars; the tenant scope lets the
Control Plane reject Apps outside the deployment's login organization. The
user still reviews and confirms the app, and tenant policy may require
administrator approval. For HTTP delivery, sensitive settings cannot travel in the deeplink:
after approval the Control Plane uses the returned credentials to set the
stable `/feishu/events` Request URL, Verification Token, and Encrypt Key through
the application-config OpenAPI, after assigning those same values to the relay.

The same creation deeplink pre-fills the bot avatar from the Agent's current
public icon URL. Uploaded icons use their public object-store URL; glyph and
runtime icons use the public Control Plane PNG endpoint. The Control Plane
response allows anonymous cross-origin reads, and the configured object-store
origin must do the same, because the Lark launcher rasterizes the avatar
in-browser. If neither public base is configured, avatar prefill is omitted and
app creation continues normally.

Manual setup must configure the same bot capability, scopes, publication state,
and `im.message.receive_v1` event, selecting either **Long Connection** or
**HTTP callbacks** for delivery. In both paths, adding the bot to a target group
remains a user action. The setup checklist documents those manual prerequisites
and requires every Bot App to be created in the same developer organization as
the sign-in App, then links to the selected Lark or Feishu Open Platform console.

## 8. Current implementation and remaining scope

- **Contract:** `IntegrationFeishuConfig` and platform enums flow through the
  protocol, Control Plane persistence and routes, daemon agent schema, and
  capability declaration.
- **Daemon runtime:** `feishu/{connection,normalize,render}.ts` uses `WSClient`
  for direct inbound delivery and an API-only client for HTTP mode. Both paths
  share normalization, CardKit rendering, outbound messages, and reconciliation.
- **Web:** `AddIntegrationModal` defaults to the official one-click
  authorization deeplink and keeps App ID/App Secret entry as an advanced
  fallback. Both flows default to Long Connection and expose HTTP when relay
  delivery is available. It also includes Lark /
  Feishu marks, a manual setup checklist, Settings card, and API types.
- **Control Plane:** a durable registration coordinator resumes the official
  device flow across replicas, leases each poll/finalize step, and installs
  credentials server-side through the same secret-store helper as the manual
  route. Both paths reject a Bot App whose `tenant_key` does not match the
  configured regional Login App's organization. HTTP registrations additionally
  configure the app's callback delivery after the relay assignment exists. App
  Secret never enters a browser response and is cleared from the pending row
  after settlement.
- **HTTP ingress:** the relay endpoint `/feishu/events` verifies/decrypts and
  deduplicates callbacks before forwarding normalized messages and CardKit
  actions directly to the owning daemon. Card actions return the daemon's
  callback response through the same request.
- **Attachments and topics:** `downloadFile` uses authenticated
  `im.messageResource.get`; topic replies use
  `im.message.reply(reply_in_thread)` and group sessions keyed by topic root.
- **Remaining optional work:** additional in-card session controls beyond Cancel,
  an add-to-group link, a prebuilt app with one-click installation, and
  multi-agent Lark / Feishu bots.

## 9. Tests

- **Daemon unit:** `feishu-normalize.test.ts` covers matching the bot open ID,
  humanizing `@_user_1`, `chat_type -> isDm`, attachment mapping, and chunking.
  Pure functions require no live connection.
- **Control Plane unit:** `CreateIntegrationBody` Lark / Feishu `superRefine` covers
  mutual exclusion of credentials and `botId`, and cross-platform credential
  guards.
- **Control Plane integration:** apply the migration and exercise the Lark / Feishu
  path in `integrations.route.test.ts` with `verifyFeishuBot` stubbed to
  success, invalid, and unreachable.
- **One-click integration:** stub the official provider endpoint, verify the
  complete scope/event preset, completion after reconstructing a second
  Control Plane instance, denied state, terminal secret clearing, and that
  registration responses never contain App ID or App Secret.
- **Live:** use a real custom application with either Long Connection or the
  `/feishu/events` Request URL, `im.message.receive_v1`, permissions, and group
  membership. Like Discord, this
  does not block the contract phase.

## 10. Region: Lark vs Feishu

A self-built app is registered in exactly one open-platform region —
international Lark (`open.larksuite.com`) or mainland China Feishu
(`open.feishu.cn`).
Both regions share the same app model, SDK, event shapes, and message rendering;
only the gateway host differs. Rather than a separate `platform`, the region is a
single field threaded end to end:

- **Protocol** — `IntegrationFeishuConfig.region: 'feishu' | 'lark'`
  (`FeishuRegion`), defaulting to `'feishu'` so existing installs are unaffected.
- **Daemon** — `consolidateFeishu` carries `region` onto the per-app group, and
  `FeishuConnection` passes it to the SDK factory, which sets `domain`
  (`Lark.Domain.Feishu` / `Lark.Domain.Lark`) on both the `Lark.Client` and the
  `WSClient` long connection.
- **Control Plane** — new create requests default an omitted region to `'lark'`;
  the selection is persisted on the `integration` row, while historical NULL
  rows still resolve to `'feishu'`. `integrationToSpec` reads it into the wire spec, and
  `verifyFeishuBot` exchanges credentials against the matching gateway (verifying
  a Lark app against the Feishu host would spuriously reject it).
- **Web** — the Add-integration region selector opens with Lark selected; the
  operator can switch to Feishu, and the "Open the console" link and copy follow
  that selection.

## 11. Current constraints and follow-ups

1. Schema, DTOs, and web have no public `bot.feishuAppId` column. The checklist
   remains the group-installation path until an add-to-group link is required.
2. The current integration supports **plain text plus text commands**;
   interactive cards remain deferred.
3. Determine whether `WSClient` reconnection needs an additional reconciliation
   fallback, or
   can it rely entirely on SDK internal reconnection? Decide after observing the
   SDK under sustained operation.
4. Converge on the minimum scope set through real tests of
   `im.messageResource.get` and `im.chat.list`.

## References

- Lark / Feishu, "Receive events through WebSocket," in the Open Platform documentation
- [larksuite/node-sdk](https://github.com/larksuite/node-sdk), including
  `WSClient` and `EventDispatcher`
