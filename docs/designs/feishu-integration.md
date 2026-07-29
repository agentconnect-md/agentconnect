# Feishu Integration Design

> **Status:** Implemented. The integration supports topic-thread replies and
> authenticated attachment downloads. It supports **both** the mainland China
> Feishu region (`open.feishu.cn`) and the international Lark region
> (`open.larksuite.com`), selected per integration by a `region` field (see
> section 10).
>
> Related documents:
> [daemon-centric-architecture.md](daemon-centric-architecture.md),
> [daemon-detailed-design.md](daemon-detailed-design.md),
> [slack-integration-install.md](slack-integration-install.md).

## 1. Goal

Add Feishu as the fourth instant-messaging platform adapter beside Slack,
Telegram, and Discord. In the Console, a user can install a Feishu bot for a
placed agent. Mentioning the bot in a Feishu group or sending it a direct
message then drives the local coding agent, whose response streams back to
Feishu.

**Non-goals for v1:** Feishu Base, Docs, Approvals, and other Open API
capabilities; marketplace distribution of custom enterprise applications; and
shared bots with relay-managed ingress, described in section 9. v1 supports
only a custom application, one tenant, and text messages, matching Discord v1.

> **Region (Feishu vs Lark):** the integration supports **both** the mainland
> China Feishu region (`open.feishu.cn`) and the international Lark region
> (`open.larksuite.com`). The operator picks one when installing, and the choice
> rides a `region: 'feishu' | 'lark'` field end to end (see section 10). Both
> regions share the same app model (`appId` + `appSecret`), SDK
> (`@larksuiteoapi/node-sdk`), and message shapes — only the open-platform
> gateway host differs.

## 2. Key decision: use Feishu `WSClient` long connections with the direct template

The daemon-centric architecture has a hard constraint: **the daemon must
establish every inbound connection outbound**, because it runs behind NAT or on
an internal network with no public ingress endpoint. The three existing
platforms already comply:

| Platform   | Inbound transport                        | Connection direction | Credentials             |
| ---------- | ---------------------------------------- | -------------------- | ----------------------- |
| Slack      | Socket Mode over WebSocket               | Outbound             | `botToken` + `appToken` |
| Telegram   | Long polling with `getUpdates`           | Outbound             | One `botToken`          |
| Discord    | Gateway over WebSocket                   | Outbound             | One `botToken`          |
| **Feishu** | **Long-lived `WSClient` over WebSocket** | **Outbound**         | `appId` + `appSecret`   |

In addition to traditional webhooks that require a public callback URL, Feishu
offers a **long-connection mode**. `Lark.WSClient` in the official
`@larksuiteoapi/node-sdk` version 1.24.0 or later establishes a full-duplex
WebSocket to the platform with `appId` and `appSecret`. Events arrive through
that socket with **no public IP, tunneling, or custom callback signature and
decryption work**. This is structurally equivalent to Slack Socket Mode and the
Discord Gateway.

See Feishu's "Receive events through WebSocket" documentation and the
`WSClient` plus `EventDispatcher` implementation in
[larksuite/node-sdk](https://github.com/larksuite/node-sdk).

**Feishu uses a direct daemon connection, not relay or webhook ingress.** Shared
relay ingress is not part of the current Feishu integration.

Feishu v1 differs from Discord v1 in only three important ways, expanded in
section 7:

1. It uses **two credentials**, `appId` and `appSecret`, rather than one token.
   These reuse the existing two credential slots:
   `bot_secret.botToken` and `bot_secret.appToken`.
2. **Attachments require authenticated downloads.** An `image_key` or
   `file_key` must be fetched through an API request carrying a
   `tenant_access_token`, making it more like Slack than Discord's public CDN.
3. Rich text and buttons use an **interactive message card** whose callbacks
   arrive as `card.action.trigger`. This is more involved than Discord message
   components. The current integration uses plain text and text commands.

## 3. Reuse the per-platform silo pattern

The codebase deliberately has no unified `Connection` interface. Each platform
is an **independent vertical silo** with its own connection array,
`Map<integrationId, Conn>`, reconciliation loop, converger, and apply path.
Each platform keeps a separate connection map, reconciliation loop, and
converger rather than sharing one connection abstraction.

The Feishu silo follows the same package boundaries as the other platform
adapters while retaining its own credentials, connection lifecycle, and event
mapping.

## 4. Change inventory by layer

Every place that adds `'feishu'` to an enum is marked `[enum]`. Missing any one
can make the platform silently unavailable at one layer; see the three-part
capability invariant in section 5.

### 4.1 `packages/protocol`: the daemon-to-Control-Plane wire contract

- In `src/frames/integration.ts`:
  - Add the Zod schema `IntegrationFeishuConfig`:

    ```ts
    export const IntegrationFeishuConfig = z.object({
      appId: z.string(), // cli_... application ID; a semi-public identifier
      appSecret: z.string(), // Secret; never log it
      botOpenId: z.string().optional(), // Bot open_id for mention routing; resolve lazily through bot/info
      allowedUserIds: z.array(z.string()).default([]),
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
- Add a Feishu branch to round-trip tests in `src/codec.test.ts`.

### 4.2 `packages/control-plane`

**Prisma and migration**

- In `prisma/schema.prisma`:
  - Add `'feishu'` to `[enum] enum Platform { slack telegram discord feishu }`.
  - Optionally add `feishuAppId String?` to `model Bot`, following
    `discordAppId`, as public metadata for a Console "Add to Feishu" link. See
    the tradeoff in section 7.1.
  - Do **not** change `model BotSecret`. Feishu maps `appSecret` to `botToken`
    and `appId` to `appToken`. `appToken` has been nullable since Telegram.
- Add a `prisma/migrations/2026..._feishu_platform/` migration:
  `ALTER TYPE "Platform" ADD VALUE IF NOT EXISTS 'feishu';`. If
  `feishuAppId` is selected, add its column in this or a separate migration.
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
- Add a Feishu branch to `POST /integrations` in
  `src/http/routes/integrations.ts`: verify credentials, call
  `botRepo.create({ ..., feishuAppId? })`, store
  `{ botToken: appSecret, appToken: appId }` through `botSecret.put`, create the
  integration, and call
  `replicateUpsert(integration, agent.daemonId)`, which sends
  `integrationUpsert(daemonId, integrationToSpec(...))`. This nearly copies the
  Discord branch.
- Add `POST /integrations/feishu/app` and
  `GET /integrations/feishu/app/:id` for the default one-click path. The first
  route starts the official SDK's `registerApp` device flow and returns only a
  direct authorization URL plus an opaque registration ID. The second polls
  the short-lived registration status.
- Configure `registerApp` with `createOnly: true`, the platform
  `PersonalAgent` preset, AgentConnect's tenant scopes, and
  `im.message.receive_v1`. After approval, pass the returned App ID and App
  Secret directly to the same bot-secret installation helper used by the
  manual route. Never return either credential from the registration routes.
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

- Add a Feishu branch to `integrationToSpec()` in
  `src/orchestrator/placement.ts`:

  ```ts
  if (i.platform === 'feishu') {
    return {
      integrationId: i.id,
      agentId: i.agentId,
      platform: 'feishu',
      feishu: {
        appId: secret.appToken ?? '',
        appSecret: secret.botToken,
        allowedUserIds: [],
        bindRules
      }
    }
  }
  ```

  Observe the two-slot mapping from section 7.1:
  `botToken = appSecret`, `appToken = appId`.

- Pass `'feishu'` through unchanged in `toDbPlatform()` in
  `src/persistence/platform.ts`. It is a persisted platform, unlike
  session-only webchat or hook sources.
- If the public `feishuAppId` column is selected, add it to `BotRecord` and
  creation mapping in `src/persistence/ports.ts` and
  `repositories/integration.repo.ts`, following `discordAppId`.
- Add Feishu coverage to `test/fixtures/seed.ts` and
  `test/integration/integrations.route.test.ts`.

### 4.3 `packages/daemon`

**Add a `src/feishu/` silo modeled on `src/discord/`:**

- `connection.ts` defines `FeishuConnection`, `FeishuDeps`,
  `ConsolidatedFeishuGroup`, and `consolidateFeishu(agents)`. Consolidation
  groups by `appId`, with one `WSClient` per app.
  - `start()` constructs `Lark.WSClient({ appId, appSecret })`, registers
    `im.message.receive_v1` and optionally `card.action.trigger` on a
    `Lark.EventDispatcher`, and calls `wsClient.start(...)`. It also constructs
    `Lark.Client(...)` for outbound APIs: messages, resources, and bot info.
    Resolve `botOpenId` lazily.
  - Outbound methods include `postMessage` through `im.message.create` with
    `msg_type: 'text'` and chunking at Feishu limits, `postChrome`,
    `updateMessage` through `im.message.patch` or card
    `im.message.update`, and `sendChatAction`. Feishu has no typing API, so the
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
  - Reuse `SlackSendQueue` from `src/slack/send-queue.ts` for FIFO outbound
    delivery.
  - **Three-second constraint:** event callbacks must return within three
    seconds. A handler only normalizes and enqueues through `onMessage`; it
    never waits synchronously for an agent.
- `normalize.ts` defines `normalizeFeishuMessage(msg, ctx)`,
  `FeishuMessageLike`, `toAttachment()`, and `humanizeFeishuText()`.
  - Set `platform: 'feishu'`, `channel = chat_id`, and for a group set
    `thread = root_id ?? message_id`; for a direct chat use `chat_id`.
    Group topics use their root as the session key and reply anchor, while P2P
    uses the chat. See section 7.4. Set `sender.id = open_id`.
  - A mention matches when `event.message.mentions[]` contains the bot's own
    open ID.
  - `isDm` is `chat_type === 'p2p'`.
  - Feishu text represents mentions as placeholders such as `@_user_1` plus a
    mapping. Convert them to readable `@name`; flatten `post` rich text to plain
    text.
  - A top-level group message outside P2P and outside a topic may set
    `feishuTopLevel` so the daemon can open a topic. v1 may instead reply
    directly in the group; see section 7.3.
- `render.ts` defines `FeishuConverger`, constructed with output `mode` and
  providing `hasBuffered` and `flushBuffered`, producing `FeishuAction[]`; a
  `chunkForFeishu()` helper; `buildFeishuCard()` for status and selection cards;
  and `parseFeishuCardAction()` for `card.action.trigger` callback values.
  **If v1 uses plain text, card buttons may be deferred** and all actions can
  use text commands.
- An optional `app-commands.ts` is unnecessary because Feishu has no native
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
- Add a Feishu branch to `src/router/routing-rule.ts`, extracting
  `staticBotUserId` from `botOpenId`, `bindRules`, and `allowedUserIds`.
- Add `FeishuConfigSchema` to the `IntegrationSchema` discriminated union and
  `'feishu'` to the cron target platform in `src/agents/agent-schema.ts`.
- Add a Feishu branch in `src/agents/write-integration.ts` so
  `IntegrationSpec.feishu` persists to `agent.json`. Persisting credentials lets
  the daemon recover after restart while the Control Plane is unavailable.
- Add `@larksuiteoapi/node-sdk` to `package.json`.

### 4.4 `packages/web`

- Add a `feishu` and optional `lark` branch with the Feishu brand SVG in
  `src/components/marks.tsx#PlatformMark`.
- In `src/components/console/modals/AddIntegrationModal.tsx`:
  - Add `{ key: 'feishu', label: 'Feishu' }` to `BOT_PLATFORMS`; see the scope
    note in section 1.
  - Make **One-click** the default for a new bot. Open the authorization URL in
    a new tab, poll the opaque registration ID, and refresh the integration
    list when setup completes. This is a direct deeplink; the user does not
    need to scan a QR code.
  - Keep **Manual** as the advanced fallback. It renders App ID and App Secret
    inputs and submits
    `{ platform: 'feishu', feishu: { appId, appSecret } }`.
  - Show `FEISHU_CHECKLIST` only for manual or existing-app setup: enable bot
    capability, subscribe to `im.message.receive_v1`, select long connection,
    grant required scopes, and add the bot to a group.
  - Optionally derive an "Add to group" link from `feishuAppId`.
- Add
  `<PlatformBotsCard platform="feishu" label="Feishu" ...>` to
  `src/components/console/views/SettingsView.tsx`.
- Extend the `CreateIntegrationInput` discriminated union and session-platform
  display in `src/lib/api.ts`, adding `feishuAppId` to `BotDto` only if selected.
  `DaemonCapabilities.platforms` naturally carries it.
- Add a Feishu demonstration row to `MOCK_BOTS` in
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

At one-click installation:
Console starts registration -> the Control Plane returns a provider
authorization deeplink -> the user confirms the app and requested permissions
in Feishu/Lark -> the SDK returns `appId` and `appSecret` only to the Control
Plane -> `verifyFeishuBot` validates them -> `botSecret.put` stores
`{ botToken: appSecret, appToken: appId }` -> `integrationToSpec` constructs
`IntegrationSpec.feishu` -> `integration/upsert`, with
`RegisterOk.integrations[]` as reconciliation fallback, distributes it to the
daemon -> the daemon persists it in `agent.json` and starts `WSClient`.

The browser receives only the authorization URL, expiry, status, and final
integration ID. The manual fallback enters at `verifyFeishuBot` with an App ID
and App Secret supplied by the user and then follows the same installation
path.

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

## 7. Feishu-specific decisions

### 7.1 Store two credentials in the existing Slack slots

`bot_secret` already has `botToken` and nullable `appToken`, introduced for
Slack Socket Mode and made nullable for Telegram. Feishu fits exactly and
requires **no table change**:

- `botToken` <- secret `appSecret`, the primary slot
- `appToken` <- identifier `appId`, the secondary slot

`integrationToSpec`, `write-integration`, and `verifyFeishuBot` follow that
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

### 7.3 v1 uses plain text and text commands; card buttons are deferred

- **Sending:** use `msg_type: 'text'` in v1 because native Feishu Markdown
  support is limited, and chunk at Feishu's text limit. Rich `post` messages
  and cards belong to v2.
- **Status, cancellation, and model selection:** Feishu's equivalent to
  Discord components and Telegram inline keyboards is an **interactive card
  with buttons**, whose callback is `card.action.trigger`. It is more involved
  than Discord components and resembles Slack block actions. v1 should use text
  commands such as `/stop` and `/models opus`, already supported by
  `parseCommand`. If v1 requires buttons, have `render.ts` emit `FeishuCard` and
  register `card.action.trigger -> handleFeishuSelect` in `EventDispatcher`.
- **Typing indicator:** Feishu has no Discord-style typing API, so
  `sendChatAction` may be a no-op.

### 7.4 Session and topic model

Feishu **group chats** support topic threads by replying to a message.
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
`contact:contact.base:readonly`, and `contact:user.base:readonly`. The last
scope is required for participant names instead of raw `ou_...` IDs. The user
still reviews and confirms the app, and tenant policy may require administrator
approval.

Manual setup must configure the same bot capability, long-connection event,
scopes, and publication state. In both paths, adding the bot to a target group
remains a user action. `FEISHU_CHECKLIST` documents those manual prerequisites
and links to [open.feishu.cn](https://open.feishu.cn).

## 8. Current implementation and remaining scope

- **Contract:** `IntegrationFeishuConfig` and platform enums flow through the
  protocol, Control Plane persistence and routes, daemon agent schema, and
  capability declaration.
- **Daemon runtime:** `feishu/{connection,normalize,render}.ts` uses `WSClient`
  for inbound normalization, outbound messages, and reconciliation.
- **Web:** `AddIntegrationModal` defaults to the official one-click
  authorization deeplink and keeps App ID/App Secret entry as an advanced
  fallback. It also includes Feishu marks, a manual setup checklist, Settings
  card, and API types.
- **Control Plane:** a short-lived registration broker owns SDK polling and
  installs credentials server-side through the same secret-store helper as the
  manual route. App Secret never enters a browser response.
- **Attachments and topics:** `downloadFile` uses authenticated
  `im.messageResource.get`; topic replies use
  `im.message.reply(reply_in_thread)` and group sessions keyed by topic root.
- **Remaining optional work:** interactive-card status and callbacks, an
  add-to-group link, and relay-managed shared-bot ingress.

## 9. Tests

- **Daemon unit:** `feishu-normalize.test.ts` covers matching the bot open ID,
  humanizing `@_user_1`, `chat_type -> isDm`, attachment mapping, and chunking.
  Pure functions require no live connection.
- **Control Plane unit:** `CreateIntegrationBody` Feishu `superRefine` covers
  mutual exclusion of credentials and `botId`, and cross-platform credential
  guards.
- **Control Plane integration:** apply the migration and exercise the Feishu
  path in `integrations.route.test.ts` with `verifyFeishuBot` stubbed to
  success, invalid, and unreachable.
- **One-click integration:** stub `registerApp`, verify the complete scope/event
  preset, complete and denied states, secret persistence, and that registration
  responses never contain App ID or App Secret.
- **Live:** use a real custom application with long connection,
  `im.message.receive_v1`, permissions, and group membership. Like Discord, this
  does not block the contract phase.

## 10. Region: Feishu vs Lark

A Feishu self-built app is registered in exactly one open-platform region —
mainland China (`open.feishu.cn`) or international Lark (`open.larksuite.com`).
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

- Feishu, "Receive events through WebSocket," at open.feishu.cn
- [larksuite/node-sdk](https://github.com/larksuite/node-sdk), including
  `WSClient` and `EventDispatcher`
