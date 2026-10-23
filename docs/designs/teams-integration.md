# Microsoft Teams Integration Design

Status: Proposed (draft). Provider facts come from Microsoft's documentation as
of October 2026. Facts marked **measured** come from a live probe against a
test tenant; facts marked **unverified** still need one.

> Related: [platform modules](integration-plugin-architecture.md),
> [Google Chat](google-chat-integration.md), [DingTalk](dingtalk-integration.md),
> [session modes](channel-session-mode.md),
> [approval surfaces](slack-approval-dm.md),
> [product conventions](../product-conventions.md). Refs #3208.

## 1. Goal and scope

Add a native `msteams` integration. One Teams bot serves one agent across 1:1
chats, group chats, and the channels of the teams it is installed in. Teams
delivers every activity as an HTTPS POST, so ingress is a relay module; the
daemon sends, edits, and deletes through the Bot Connector REST API. No
Microsoft SDK is used.

| Capability           | Initial scope and boundary                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Distribution         | Each organization registers its own bot and Entra app and pastes the credentials into the Console (§2).                 |
| Ingress              | Relay-terminated HTTPS with Bot Framework token verification and durable admission (§3, §4.2).                          |
| Conversations        | Every message the app's resource-specific consent delivers, filtered by the existing channel triggers (§4.1).           |
| Sessions             | A 1:1 chat is one session; a channel post is a thread; a group chat follows the DingTalk reply-chain model (§4.1).      |
| Replies              | Post once, then edit in place; extended Markdown; no native streaming (§4.3).                                           |
| Questions, approvals | Adaptive Cards with `Action.Execute`, answered in place; who may approve follows session access sync (§4.4, §4.5).      |
| Setup                | A Console wizard that checks the credentials live and downloads the Teams app package for the admin to upload (§5).     |
| Access               | Microsoft sign-in links a person; session access sync checks conversation membership with the bot's credentials (§4.5). |

Outside this scope: files and attachments in either direction, meetings and
calls ([voice participation](voice-meeting-participation.md)), the Teams Store,
one app serving many customer tenants (§8), native streaming, and one bot
serving several agents.

## 2. Distribution model

A Teams bot needs two registrations the organization makes itself:

- **An Entra app registration** with a client secret. Its application (client)
  ID is the bot's ID.
- **A bot registration** that names that app and the messaging endpoint, either
  an Azure Bot resource (needs an Azure subscription; the Teams channel is free
  on every tier) or a bot in the Teams Developer Portal (no Azure subscription;
  no Bot Service single sign-on, which v1 does not use). Since 31 July 2025 a
  new bot registration is single-tenant or uses a managed identity. A managed
  identity only obtains tokens on Azure compute, so v1 supports a client secret.

Credentials are the **app ID**, the **tenant ID**, and the **client secret**.
They map onto existing columns with no migration: `externalAppId` ← app ID,
`externalTenantId` ← tenant ID, and the `botToken` secret slot ← client secret.
The relay's assignment carries the app and tenant IDs and the bot's mention
identity `28:<appId>`; the secret goes to the daemon alone, as with Google Chat.

Validation requests a client-credentials token from the tenant's endpoint
(`https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token`, scope
`https://api.botframework.com/.default`). That proves the app, tenant, and
secret together, but not the messaging endpoint or the Teams channel; only the
first inbound activity proves those. An unreachable Entra answers 503
(`MSTEAMS_CHECK_UNAVAILABLE`); a definitive refusal answers 400 with a code the
Console shows: `MSTEAMS_SECRET_INVALID` (a wrong or expired secret),
`MSTEAMS_APP_NOT_FOUND`, `MSTEAMS_TENANT_NOT_FOUND`, or
`MSTEAMS_CREDENTIALS_INVALID`. Both IDs are stored lower-cased, since the relay
matches them exactly. A Developer Portal bot obtains its token from the
tenant endpoint and receives Bot Framework tokens inbound (**measured**).

The Developer Portal creates the bot's Entra app as multi-tenant, open to all
tenants, by default (**measured**). It also ties the bots it lists to the
signed-in name of the person who created them: after that person's sign-in name
was changed to a custom domain, the portal listed none of their bots and could
not open one by its ID, while the bots themselves kept receiving traffic
(**measured**). A bot that needs another owner, or whose owner's sign-in name
may change, is safer as an Azure Bot resource.

## 3. Architecture

```mermaid
flowchart LR
    T[Teams client] --> B[Bot Connector]
    B -->|Activity, HTTPS POST + JWT| X[Teams relay module]
    X -->|Pre-addressed rd/msg| D[Teams module on the daemon]
    D --> R[Existing routing and session]
    R --> A[Agent execution]
    A -->|Send, edit, card PUT| S[Bot Connector REST at serviceUrl]
    S --> T
```

The messaging endpoint is the relay's `POST /msteams/messages`. Every request
carries a JWT in `Authorization`. The relay verifies it before routing:

- keys from `https://login.botframework.com/v1/.well-known/openidconfiguration`,
  cached and refreshed at least daily, refetched once for an unknown `kid`;
- issuer `https://api.botframework.com`, audience equal to the candidate bot's
  app ID, five minutes of clock skew;
- the `serviceUrl` claim equal to the activity's `serviceUrl`.

Demultiplexing follows the existing ladder: an unverified app ID from the token
and the tenant ID from `channelData.tenant.id` pick the candidate `Bot` row by
`(externalAppId, externalTenantId)`, and verification confirms it. A token that
fails, or one no assigned bot owns, answers 401 before anything is forwarded.
Tokens issued by Entra rather than the Bot Framework are refused.

Outbound calls go to the `serviceUrl` the conversation's latest activity
carried, which the daemon records per conversation; proactive sends need that
recorded reference, since Teams offers no lookup by email or user principal
name. The `serviceUrl` is regional and tenant-specific
(`https://smba.trafficmanager.net/<region>/<tenantId>/`), so it is read, never
built (**measured**). A proactive 1:1 with someone who has not installed the
app in personal scope fails with 403 `BadArgument`, "Bot is not installed in
user's personal scope" (**measured**).

## 4. Behavior and invariants

### 4.1 Conversations, sessions, and mentions

`conversation.conversationType` is `personal`, `groupChat`, or `channel`.

- **1:1 chat.** One continuous session per chat, like every other platform's DM.
- **Channel.** Teams channels are threaded by construction: a top-level post
  opens a conversation whose ID ends in `;messageid=<root>`, and replies share
  it. The root ID is the thread key, so a new post starts a session and a reply
  continues it, as a Slack thread does. A reply's `replyToId` is empty, so the
  key comes from the conversation ID alone, and a post's subject line never
  reaches the bot, only its body (**measured**).
- **Group chat.** There are no threads, so group chats follow the DingTalk model
  ([DingTalk §4.1](dingtalk-integration.md#41-conversations-sessions-and-identity)),
  itself Telegram's reply chain for groups without topics: a message that
  quotes nothing starts a session rooted at itself, a quote of a recorded bot
  message continues that message's session, and a quote that resolves to
  nothing starts a new session rather than guessing. The module implements the
  daemon's `canonicalizeThread` member, the third after Telegram and DingTalk.
  A quoted reply carries a `quotedReply` entity whose `messageId` is the quoted
  activity's ID — for a bot message, the ID its send returned — with the
  quoted `senderId` and `validatedMessageReference: true`, so the lookup is by
  message ID, as on Telegram (**measured** in a 1:1 chat). The text starts with
  `<quoted messageId="…"/>` and the HTML attachment with the quoted block; the
  normalizer removes both. Channel threads offer no quote action.

That is the default `createNew` [session mode](channel-session-mode.md). Channel
and group-chat rows also offer `append`; a 1:1 chat offers no mode, so the
manifest declares `appendKinds: ['channel']`.

**Resource-specific consent (RSC).** By default Teams delivers only messages
that mention the bot. The app package requests `ChannelMessage.Read.Group` and
`ChatMessage.Read.Chat`, which the team owner or chat member who installs the
app grants for that team or chat alone. The install dialog lists them as "Read
messages in this team." and "Read this chat's messages." beside reading the
roster; an administrator's install from the Teams admin center grants them with
no prompt. Teams then delivers every message there — unmentioned top-level
posts and thread replies alike (**measured**) — the same shape as Slack, which
receives every message of the conversations it has joined. The existing
activation policy does the filtering, unchanged:

- the channel trigger `off`, `mention`, or `auto` decides whether an
  unmentioned new message starts work;
- thread affinity routes an unmentioned follow-up in a thread the agent already
  has an open session in, and a quote in a group chat lands in that thread
  through `canonicalizeThread`;
- anything else is dropped after admission and starts nothing.

The manifest therefore leaves `addressedByConstruction` unset. If a tenant
blocks RSC consent, the bot receives mentions only; `auto` and unmentioned
follow-ups then do nothing, and how the bot can detect that is **unverified**.

A mention arrives as a `mention` entity whose `mentioned.id` is the bot
(`28:<appId>`) and whose `text` is the `<at>…</at>` span in the activity text
(**measured**). The normalizer removes exactly that span and sets
`mentionedBots`, lower-casing a `28:` ID; a display name is never matched. The
relay reads a mention as addressing the bot only through the assignment's
`28:<appId>`, so a channel's first contact is a mention: it reaches the daemon,
which registers the channel for the Console, Off where the agent is gated.

Identity is tenant-scoped: `from.aadObjectId` with the tenant ID identifies a
person, and `from.id` is specific to the bot. Display names are for display
only. Email and user principal name are available from the conversation member
API without Graph permissions, as optional enrichment; they never merge people.

### 4.2 Admission and redelivery

The relay forwards with `forwardStrict` and answers from the daemon's admission
verdict, as Google Chat does
([Google Chat §4](google-chat-integration.md#ack-is-an-admission-boundary)):
200 after a durable admission or a duplicate its receipt settles, 200 after a
deliberate gate, and 503 for a retryable refusal or an admission timeout. The
route settles within 10 seconds, which keeps relay requests bounded.

Redelivery is minimal (**measured**). A 503 brings exactly one redelivery about
a second later, with the same activity ID, and nothing after it. An answer that
takes 20 seconds brings none, and the sender sees no error. A 503 therefore
buys one immediate retry, which no daemon restart or handover fits inside, so a
message that arrives while no daemon can admit it is lost, as on DingTalk, and
user documentation says so. The relay's dedup table and the daemon's durable
receipt both key on the bot, the conversation ID, and the activity ID, because
Teams message IDs are unique only within a conversation; the retry never starts
a second turn.

Non-message activities the module does not act on (typing, reactions,
`conversationUpdate`, `installationUpdate`) are answered 200 and not forwarded;
`installationUpdate` refreshes the recorded conversation reference.

### 4.3 Replies, editing, and Markdown

A turn posts one message as its acknowledgement and edits it in place
(`PUT /v3/conversations/{id}/activities/{activityId}`) as text arrives; a
channel reply posts into the thread's conversation ID. Microsoft's limits are
per bot per conversation — 7 operations a second, 60 per 30 seconds, 1,800 an
hour — and 50 requests a second per app per tenant, with 429 above them. The
turn output therefore:

- coalesces edits to at most one every two seconds per conversation, through a
  per-conversation send queue;
- shares a per-tenant write budget across the daemon, as the Google Chat module
  does;
- retries 429, 412, 502, and 504 with backoff, honoring `Retry-After`.

Text is sent with `textFormat: "extendedmarkdown"` (generally available since
8 October 2026), which renders headings, both list kinds, quotes, fenced code
with a copy button, and tables in the web client, and renders progressively as
a message is edited (**measured**; the fence's language label is not shown).
Rendering on mobile clients is **unverified**. A message is limited to 100 KB,
so the renderer splits an answer under 80 KB into consecutive messages.

Native streaming works only in 1:1 chats, one stream per chat, at one update a
second, for at most two minutes. Turns often run longer, so v1 uses post-then-
edit everywhere; native streaming in 1:1 chats is later work.

### 4.4 Questions and approvals

Questions and approvals are Adaptive Cards (schema 1.6 or lower), built by the
module's `ElicitCardFacet` and `ApprovalCardFacet`. Each button is an
`Action.Execute` whose `data` carries the request ID, the option's position
(never its value), and a token.

A click arrives as an `adaptiveCard/action` invoke on the same endpoint, with
`replyToId` set to the card's activity ID, and the client waits about five
seconds for the HTTP response before retrying. The relay verifies the token,
dedupes by a hash of the click as Google Chat does, forwards it to the
integration as a `platform_action`, and answers at once with a short text
response (`type: "application/vnd.microsoft.activity.message"`), never waiting
for the daemon; the clicker sees that text as a dismissible note under the
card. The daemon re-checks the agent and integration, hands the click to the
permission coordinator, and replaces the card (`PUT` on the card's activity)
with the question and its decision and no controls; the client then shows the
card as edited (**measured**). A refused click leaves the card as it
was and tells the clicker privately: the daemon returns the refusal in the
click's `rd/ack` `response`, and the relay answers the invoke with it in place
of the generic note when the ack arrives within its two-second wait; a later ack
leaves the generic note. Whether a targeted message in group chats and channels
could carry it instead is **unverified**.

Anyone who can see a question card may answer it, as on every surface. A tool
approval follows the chat-authority rule for in-chat cards
([approval surfaces](slack-approval-dm.md), "What people can do in chat" in
[product conventions](../product-conventions.md)). While the organization has
not enabled Teams session access sync, anyone in the conversation may approve at
the agent's chat level. With sync on, a click settles an approval only when the
clicker is linked to an editor of the agent (§4.5); an unlinked clicker or a
non-editor is refused privately and the card stays live. The module's
`chatMemberKey` is the clicker's `aadObjectId`, lower-cased.

### 4.5 Sign-in, linking, and session access sync

Teams joins the existing permission sync model as Telegram, Discord, and Google
Chat did ([Telegram and Discord permission sync](telegram-discord-permission-sync.md)):
one login application per installation proves who a person is, each
organization's own bot checks what that person may read, and an organization
owner turns sync on under **Settings → Session access**.

**What identifies a person (measured).** In the test tenant, one member's Entra
object ID, as the Entra admin center shows it, is the `from.aadObjectId` of
every activity that member sends, in a 1:1 chat and in a channel alike. The
Bot Connector member APIs return the same value with the bot's own token and no
Graph permission: `GET /v3/conversations/{teamId}/pagedmembers` as `aadObjectId`,
and the older `GET /v3/conversations/{id}/members` as `objectId`. Every member
also carries the bot's tenant ID and a `userRole` of `user` or `guest`. A
standard channel's member list is its team's roster (**measured**).

**Which ID each sign-in connector records.** The deployment's identity
provider offers three Microsoft connectors, and they record different IDs:

| Connector                     | Identity it records                                               | Usable as the link key                        |
| ----------------------------- | ----------------------------------------------------------------- | --------------------------------------------- |
| Azure AD social connector     | Graph `GET /me` `id`, the user's Entra object ID                  | Yes: equals `aadObjectId` for a tenant member |
| Microsoft Entra ID OIDC (SSO) | the ID token's `sub`, with the other claims kept as extra details | Not `sub`, which is pairwise per application  |
| Microsoft Entra ID SAML (SSO) | the SAML `nameID`                                                 | Only if `nameID` is mapped to the object ID   |

The social connector is the one to use. It is a social sign-in like the others
the Console already offers, so Setup manages it as it manages Discord: one Entra
application registered for the installation, multi-tenant and open to all
tenants, with authority `organizations` so personal Microsoft accounts cannot
sign in. Setup creates or updates the connector with target `azuread`, enables
the target, and keeps the client secret write-only. A person links Microsoft
under **Profile → Sign-in methods**, which records their object ID.

A sign-in through that connector, in the test tenant, recorded the member's
object ID as the identity's user ID, the same lower-case value as the
`aadObjectId` of their Teams activities (**measured**). The identity holds the
Graph profile and no tenant ID.

The connector runs with email sync off. Graph's `mail` is a directory attribute
any tenant's administrator can set, and with `organizations` the connector
accepts every tenant, so a synced address could equal an existing Console
user's email, and automatic account linking would then attach the foreign
identity to that user. With sync off the address stays in the raw profile and
never becomes an identifier (**measured**: the new identity's user has no
primary email).

Each person consents to the login application on first sign-in, and Entra
labels an application without a verified publisher **unverified** on that
prompt (**measured**). Tenants that allow user consent only for verified
publishers block that prompt, so the installation's application needs
publisher verification before customers use it, or an administrator in each
tenant consents for its members.

**The link key.** The Control Plane reads the linked identity as
`{ platform: 'msteams', tenant: 'global', memberId: <object ID, lower-cased> }`,
and the Teams provider's `chatMemberTenant` answers `global` while its bot is
live and the deployment offers Microsoft sign-in. The connector records no
tenant ID (Graph's `/me` carries none), but none is needed: Entra assigns every
object ID, so a person can link only their own, and the bot row already fences
each activity to its tenant (§3).

A guest is the one person this cannot link. A guest in the bot's tenant is a
separate directory object there, so Teams sends that object's ID, while the
guest signs in to the Console through their home tenant and links its ID.
Guests therefore stay unlinked, and with sync on they cannot approve or read
sessions in the Console.

**Access rules with sync on.**

- A 1:1 chat admits its one member.
- A channel admits the members of its team's roster; a group chat admits its
  members. The Control Plane asks the conversation's bot with client
  credentials and matches the viewer's linked object ID against each member's
  `aadObjectId` or `objectId`.
- The session's audience realm is the bot's tenant ID and its resource is the
  conversation ID. The member call needs the conversation's regional
  `serviceUrl`, so the audience also records it, and the Control Plane accepts
  only a Bot Framework origin there.
- Approvals and in-chat settings follow §4.4: linked editors only.
- A missing link, a revoked bot, a mismatched tenant, a malformed response, or a
  provider failure never grants access. A successful verdict lasts at most two
  minutes, as for the other providers.

Turning sync on and off, the fence on historical sessions, and the migration
that marks earlier Teams conversations pending follow the same rules as
Telegram and Discord. Only identity and membership metadata reach the Control
Plane; message bodies stay on the daemon.

**What exists and what is missing.** The daemon side exists: the card click
carries the clicker's `aadObjectId`, `chatMemberKey` reads it, and the daemon's
tenant scope is the bot's tenant. Sign-in exists: the Setup login application
(**Setup → Microsoft**, connector `agentconnect-azuread`), the Console's
Microsoft entry on the sign-in page and under **Profile → Sign-in methods**, and
the Control Plane's identity read that lists a linked object ID as an `msteams`
member. Missing are the Teams provider's `chatMemberTenant`, a session-access
plugin over the member APIs, the audience entries in the protocol, daemon, and
Control Plane, the Settings entry, and the migration.

## 5. Console setup

The wizard walks the admin through both registrations and then:

- shows the messaging endpoint to paste, `https://<relay>/msteams/messages`;
- takes the app ID, tenant ID, and client secret, and checks them live (§2);
- downloads the Teams app package: `manifest.json` in the current schema, a
  192×192 color icon, and a 32×32 outline icon. The manifest names the bot's app
  ID with the `personal`, `team`, and `groupChat` scopes, the two RSC
  permissions with the `webApplicationInfo` they require, the relay host in
  `validDomains`, and `supportsChannelFeatures: "tier1"`, without which Teams
  refuses a v1.25-or-later manifest that has the `team` scope (**measured**).
  The Control Plane builds it from the integration's row
  (`GET /integrations/:id/msteams/app-package`). Its app ID is a UUIDv5 of the
  bot's app ID, so a re-download, even after a reinstall, updates the same app,
  and its version grows with each download. The catalog
  assigns the uploaded app an ID of its own and keeps the manifest's as its
  external ID.

The admin uploads the package in the Teams admin center, or a user uploads it
where the organization's app setup policy allows custom apps. Installing it into
a team or group chat grants the RSC permissions for that place. The wizard
states both steps; neither can be automated without Graph permissions the
integration does not request.

The install paths differ widely in how fast they take effect (**measured** in
a new tenant). The admin center's "Add to team" installs at once: the bot
receives `conversationUpdate` and `installationUpdate` within a second. A
personal-scope install for chosen users took about three and a half hours to
reach the Bot Connector, and the Teams client took hours to list the uploaded
app. The wizard therefore leads with the admin center upload and "Add to team",
and says that 1:1 chats may take hours to open.

## 6. Platform module work

The integration implements the four host contracts of the
[platform module design](integration-plugin-architecture.md) plus one registry
line per host: a relay module (token verification, demux hints, `forwardStrict`,
invoke handling), a daemon module (connection, `canonicalizeThread`,
`chatMemberKey`, turn output, card facets, write budget), a Control Plane
provider (credential schema, live validation, the package builder), and a
Console module (wizard, settings, mark). Normalization lives in the message
package with sanitized fixtures. The new id follows the tolerant-reader rule:
readers accept it a release before writers emit it in `KNOWN_PLATFORMS`. The
relay route is added to the chart's HTTPRoute in the same change.

## 7. Unverified and open

- That a group-chat quote carries the same `quotedReply` entity as the measured
  1:1 quote (§4.1).
- What the bot receives when a tenant blocks RSC consent, and who may consent in
  a group chat (§4.1).
- Whether a refused clicker can be told privately in a group chat or channel
  (§4.4).
- What a member sees when their tenant blocks user consent to an unverified or
  any third-party application, and that an administrator's consent unblocks
  linking (§4.5).
- The member list of a group chat and of private and shared channels (§4.5).
- Extended Markdown on mobile clients (§4.3).
- Private and shared channels: Microsoft's pages disagree on whether bots may
  post there.

## 8. Later

- **One app for many tenants.** One bot, registered in the installation's own
  tenant, serves every customer tenant. Measured with a Developer Portal bot
  whose Entra app is multi-tenant, from a second, new tenant:
  - The customer's admin uploads the package in the Teams admin center and adds
    the app to a team; no Store listing or Partner Center review is needed.
    Installation events and a channel mention reached the bot's endpoint within
    two seconds of **Add to team**.
  - Installing created the app's service principal in the customer tenant: a
    client-credentials request against that tenant failed with AADSTS7000229
    before the install and succeeds after it.
  - Sending into the customer tenant takes a token from the bot's **home**
    tenant; tokens from the customer tenant and from `botframework.com` are
    refused with 401. The Bot Connector origin is regional and carries the
    customer tenant, for example `https://smba.trafficmanager.net/amer/<tenant>/`,
    and arrives as each activity's `serviceUrl`.
  - A new tenant's app management takes most of an hour to become usable; an
    upload made before then did not persist.

  The hosted app keeps one `Bot` row per customer tenant, as Google Chat's
  anchor-and-claim pattern does
  ([Google Chat §10](google-chat-integration.md#10-marketplace-distribution-and-multi-tenant-installs)):
  the relay fences each activity to a claimed tenant instead of the single
  `teamId`, and the daemon always signs outbound calls with the home tenant's
  token. The same multi-tenant Entra app can also be the deployment's
  Microsoft sign-in application (§4.5), with its own secret per consumer, so a
  customer consents once for both. Entra marks it unverified until publisher
  verification, which tenants that only allow verified publishers require; a
  Store listing has its own review and is optional.

- **Native streaming** in 1:1 chats (§4.3).
- **Files**: 1:1 file consent cards, and Graph access for channel and group-chat
  files.

## 9. Validation

Use sanitized fixtures for normalization and token verification, then a test
tenant:

- An admin connects a bot from the Console without editing files on the daemon
  host; the package uploads and installs.
- A 1:1 message starts a session whose reply edits in place.
- A channel post starts a session; a reply in its thread continues it with and
  without a mention; a new post starts another.
- A group-chat quote of a bot reply continues its session; a new message starts
  another.
- Without session access sync, a permission request shows as a card that anyone
  in the conversation can settle. With sync on, a click by a linked editor settles
  it, and a click by an unlinked person or a non-editor is refused privately.
- A person links Microsoft in the Profile; with sync on, a channel session is
  visible to a linked member of its team and hidden from a linked non-member.
- A redelivered activity does not start a second turn.
- A request with a missing or invalid token is rejected before routing.
- Edits stay within the per-conversation budget; 429 responses back off.
- The Control Plane never receives a message body.

## 10. References

- Bot Connector: [authentication](https://learn.microsoft.com/azure/bot-service/rest-api/bot-framework-rest-connector-authentication), [conversations](https://learn.microsoft.com/microsoftteams/platform/bots/build-conversational-capability), [channel and group chats](https://learn.microsoft.com/microsoftteams/platform/bots/how-to/conversations/channel-and-group-conversations), [proactive messages](https://learn.microsoft.com/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages), [rate limits](https://learn.microsoft.com/microsoftteams/platform/bots/how-to/rate-limit), [Teams context](https://learn.microsoft.com/microsoftteams/platform/bots/how-to/get-teams-context).
- Registration: [Azure Bot quickstart](https://learn.microsoft.com/azure/bot-service/abs-quickstart), [Developer Portal](https://learn.microsoft.com/microsoftteams/platform/concepts/build-and-test/manage-your-apps-in-developer-portal), [app manifest](https://learn.microsoft.com/microsoft-365/extensibility/schema/), [custom app policies](https://learn.microsoft.com/microsoftteams/teams-custom-app-policies-and-settings).
- Messages and cards: [formatting](https://learn.microsoft.com/microsoftteams/platform/bots/how-to/format-your-bot-messages), [Universal Actions](https://learn.microsoft.com/adaptive-cards/authoring-cards/universal-action-model), [streaming](https://learn.microsoft.com/microsoftteams/platform/bots/streaming-ux).
- Consent: [resource-specific consent](https://learn.microsoft.com/microsoftteams/platform/graph-api/rsc/resource-specific-consent).
