# Linear Integration Design

> **Status:** P1 shipped and live-verified on the test environment
> (2026-09-02, see §13 and the §14 live checklist). Revised 2026-08 against the shipped
> [integration-plugin-architecture.md](integration-plugin-architecture.md): Linear
> now lands as a standard platform module — the four host contracts, registry
> lines, and the enumerated daemon composition set of §9.4 — and this doc's
> earlier bespoke machinery
> (`RcLinearAssign` / `RdMsgLinear` frames, a capability-URL webhook, hook-table
> borrowings, per-enum change checklists) is superseded by the generalized seams
> that shipped since: `rc/bot-assign` opaque bags, `rd/msg` `im` +
> `platform_action`, the relay platform-ingress plugin, and the CP platform
> provider.
>
> Second 2026-08 revision: the identity model flipped from **one OAuth app per
> agent** to **one deployment-owned Linear app** fronting every agent — the
> GitHub-App model. Several agents share that one app: a bare delegation reaches
> the workspace's dispatch default, `@<agent-name>` in the mention text
> addresses a specific one (GitHub-events semantics), and per-agent identity
> renders as in-content attribution (§4.3, §5).
>
> Third revision, 2026-09: **a connected Linear workspace is one channel** — the
> analog of a single Slack channel, not of a Slack workspace — and the issue is
> display metadata rather than a channel of its own. Coordinates become `channel`
> = the Linear `organizationId`, `thread` = the AgentSession UUID (§4.5); the
> workspace's dispatch default is the ordinary per-conversation owner, carried
> into the shared-bot ladder's addressed-gated default rung, so the bot-level
> persisted preferred default this doc previously asked core for is
> **withdrawn** (§9.2); and Linear carries no per-conversation trigger control
> at all (§4.3). §15 records the reasoning.
>
> Related documents:
> [architecture.md](architecture.md),
> [integration-plugin-architecture.md](integration-plugin-architecture.md),
> [webhook-triggers-and-github-events.md](webhook-triggers-and-github-events.md),
> [shared-bot-relay.md](shared-bot-relay.md),
> [feishu-integration.md](feishu-integration.md),
> [github-app-git-credentials.md](github-app-git-credentials.md),
> [session-concept.md](session-concept.md).

## 1. Goal

Add Linear as a first-class platform so that a placed agent becomes a
**delegatable teammate inside Linear**:

1. A user **assigns (delegates) an issue** to the agent, or **@mentions** it in
   an issue comment with instructions.
2. The agent acknowledges within seconds, works in its daemon workspace, and
   streams progress into Linear's **agent session activity feed** — thoughts,
   tool actions, and a plan checklist.
3. Pull-request and console links attach to the session; the final answer
   lands as the session's response.
4. The user replies **in the same session thread** to steer the agent, or hits
   **Stop** to interrupt it.

Linear ships a purpose-built protocol for exactly this — **Agent Sessions and
Agent Activities** ([linear.app/developers/agent-interaction](https://linear.app/developers/agent-interaction)) —
the same surface the coding agents listed in Linear's integration directory
build on. This design maps that protocol onto AgentConnect's existing seams
rather than inventing a Linear-shaped side channel.

### Feature checklist

| Linear agent experience                             | This design                                                                          | Phase |
| --------------------------------------------------- | ------------------------------------------------------------------------------------ | ----- |
| Assign/delegate an issue to the app                 | `created` → session with the workspace's dispatch default                            | P1    |
| Address a specific agent with instructions          | Same webhook; `@<agent-name>` in the mention text routes                             | P1    |
| Instant acknowledgement in the feed                 | Daemon-side auto-ack `thought` before the turn starts                                | P1    |
| Real-time activity feed (commands, files, progress) | `LinearConverger` → `agentActivityCreate`                                            | P1    |
| Follow-up messages in the session thread            | `prompted` → same AgentConnect session                                               | P1    |
| Stop signal puts the agent to sleep                 | `prompted` + `signal:"stop"` → `interruptTurn`                                       | P1    |
| Link to the agent's own session view                | `externalUrls` → console session deep link                                           | P1    |
| Session listed in the issue's Resources             | `attachmentCreate` at the first turn (URL-idempotent per issue) → the same deep link | P1    |
| Todo list synced to Linear's plan UI                | ACP `plan` updates → `agentSessionUpdate.plan`                                       | P2    |
| PR URL attached to the session                      | Detected PR links → `addedExternalUrls`                                              | P2    |
| Moves the issue into a started status               | Workflow-state transition on delegation (config toggle)                              | P2    |
| Playbook labels (`!plan`, `!implement`, …)          | Label → skill/prompt-preset mapping                                                  | P3    |
| Repo suggestions for multi-repo orgs                | `issueRepositorySuggestions`                                                         | P3    |
| Linear-side automation triggers delegate issues     | Free — automation delegation raises the same `created` event                         | P1    |

**Non-goals for v1:** working document/project mentions without an attached
issue (they receive a bounded unsupported-surface response, §4.5 — never a
crash or silence),
proactive session creation (`agentSessionCreateOnIssue`) as a cron/sendMessage
target, marketplace/public-app distribution, per-team configuration (the
dispatch default is per workspace; a per-team mapping is P3), and **dedicated
per-agent Linear apps** — every agent fronts through the one deployment app
with in-content attribution; §4.3 records why the per-agent-app model of
earlier revisions was dropped.

## 2. Background: Linear's agent protocol in one page

Facts this design depends on (from Linear's developer docs, re-verified
2026-08; check [linear.app/developers/agents](https://linear.app/developers/agents)
again when implementing):

- **Identity.** A standard Linear OAuth application, authorized with
  `actor=app`, becomes an **app user** in the workspace: it appears in the
  assignee/delegate and mention menus with the app's own name and icon. Scopes
  `app:assignable` and `app:mentionable` gate those surfaces. Installation
  requires a workspace admin; each workspace install yields its own token.
- **Sessions.** Delegating an issue or mentioning the app creates an
  **AgentSession**. Linear pushes `AgentSessionEvent` webhooks (enabled per
  OAuth app under "Agent session events"):
  - `created` — carries `agentSession` (with `issue`, optional `comment`),
    `promptContext` (Linear-formatted XML of issue title, description, and
    context), `previousComments`, and `guidance` (workspace-configured agent
    guidance).
  - `prompted` — a follow-up user message in `agentActivity.body`; a **stop**
    request arrives as `prompted` with `agentActivity.signal: "stop"`, not as a
    separate action.
- **Activities.** The agent responds via GraphQL `agentActivityCreate` with
  content types `thought`, `action` (`action`/`parameter`/`result` fields),
  `elicitation`, `response`, `error`. Bodies support Markdown. `thought` and
  `action` accept an `ephemeral` flag (transient display).
  `agentSessionUpdate` sets `plan` (full-array replace; entries
  `{content, status: pending|inProgress|completed|canceled}`, still a
  technology preview as of this revision) and `externalUrls` /
  `addedExternalUrls` / `removedExternalUrls` (`{label, url}`).
- **Session state is inferred**, not set: activities drive
  `pending → active → complete/error/awaitingInput`, with `stale` after
  ~30 minutes of silence (recoverable by a new activity).
- **Hard timing rules.** The webhook endpoint must return 2xx **within
  5 seconds**. After `created`, the agent must emit an activity **within
  10 seconds** or the session renders as unresponsive.
- **Webhook envelope.** Headers `Linear-Event: AgentSessionEvent`,
  `Linear-Delivery` (UUID), `Linear-Signature` (HMAC-SHA256 hex over the raw
  body, keyed by the OAuth app's **webhook signing secret**), and
  `Linear-Timestamp` (epoch ms). Replay is bounded by the **signed body's**
  `webhookTimestamp` (reject > 60 s skew), checked after HMAC verification —
  the header is NOT covered by the signature, so it can be at most a
  consistency cross-check, never the freshness authority. Payloads carry
  `organizationId` (the workspace) and the app's `oauthClientId`. Failed
  deliveries retry after 1 min / 1 h / 6 h, then the webhook may be
  auto-disabled. (Live-verified 2026-09, §15.)
- **Tokens.** OAuth `authorization_code` grant returns an access token
  (~24 h) plus a refresh token; refresh rotates with a 30-minute replay grace
  window. Per-app opt-in `client_credentials` tokens (30-day, app actor) also
  exist — see §15. `https://api.linear.app/graphql` is the single API
  endpoint; rate limit 5 000 requests/hour per OAuth app per workspace.

No socket/long-poll transport exists — **webhooks are the only ingress**.

## 3. Architecture

Linear is a **chat-kind platform module** (`PlatformId` `'linear'`,
`originKind: 'chat'`) whose _ingress_ is relay-terminated (like Slack HTTP
transport and Feishu callbacks) and whose _egress_ is daemon-direct GraphQL
(like every other platform's outbound path). Its Linear-side identity is the
**deployment's one OAuth app** (§4.3); a connected workspace is a shared bot
whose members are the enabled agents, and that workspace is also the bot's
**one conversation** (§4.5), so its dispatch default is an ordinary
conversation owner. The Control Plane stays off the message hot path.

Adding it is close to the checklist-shaped task the plugin architecture
exists for: implement the four host contracts in each host's
`platforms/linear/` directory, and touch **no core switch, no protocol enum,
and no Prisma platform migration** — `Platform` is an open string with
tolerant readers (S1a), bot identity rides the generic D6 columns, and
`IntegrationSpec` carries an opaque per-platform config (§6.3 of the parent
design). "Close to", honestly: relay, CP, and web are registry-only (one line
each), but the daemon's connection lifecycle is not yet registry-driven end
to end, so Linear also lands a small **enumerated** set of composition lines
in `daemon.ts` — additive registrations, no branch grows — listed in §9.4.

```text
Linear workspace
  │  delegate / mention / follow-up / stop
  ▼
AgentSessionEvent webhook ──POST /linear/events──▶ relay linear ingress plugin
                                verify Linear-Signature + timestamp
                                demux (oauthClientId, organizationId)
                                    │
                     rd/msg im { platform: 'linear' }   (stop → platform_action)
                                    │
                                    ▼
                                 daemon linear module
              inbox dedup → ack thought ≤10 s → ACP turn
                                    │
             Layer-2 output surface → agentActivityCreate / agentSessionUpdate
                                    │  (GraphQL, daemon-direct egress)
                                    ▼
                             api.linear.app

Control Plane: platform provider (install routes, OAuth custody/refresh,
spec + bot-assign projection), linearcred token broker, session metadata.
Never sees activity bodies or promptContext.
```

What each leg reuses — every row is a **shipped seam**, not a precedent to
imitate:

| Leg                                                 | Shipped seam                                                                                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Relay signed HTTP ingress, demux, per-bot lifecycle | `RelayPlatformIngressPlugin` (`packages/relay/src/platforms/contract.ts`); HMAC/timestamp primitives shared with the webhook seam            |
| CP → relay credential + demux distribution, replay  | `rc/bot-assign` opaque `secrets`/`ingress` bags, produced by the provider's `projectBotAssign`                                               |
| Relay → daemon delivery + durable dedup             | `rd/msg` `im` / `platform_action` + the daemon inbox on `(botId, sessionKey, msgId)`                                                         |
| Daemon spec ingestion (opaque config, fail-closed)  | `platforms/integration-config.ts` `CONFIG_SCHEMAS` — the daemon's platform-set authority, advertised as `capabilities.platforms`             |
| Turn rendering                                      | Layer-2 `TurnOutputSurface` (`packages/daemon/src/platforms/turn-output.ts`) — the streaming trio: converger + apply + opaque per-turn state |
| Outbound pacing                                     | `PlatformSendQueue` (`packages/daemon/src/platforms/send-queue.ts`)                                                                          |
| Final-answer selection                              | The GitHub Layer-2 member's heuristics (`packages/daemon/src/platforms/github/turn-output.ts`)                                               |
| Short-lived token brokered over the control WS      | `gitcred` (`packages/protocol/src/frames/gitcred.ts`, `packages/daemon/src/cp/git-credential.ts`)                                            |
| Durable token rotate-and-retry at the CP            | Slack config-token rotation (`packages/control-plane/src/platforms/slack/`)                                                                  |
| Install funnel state + TTL reaper                   | `CpPendingInstallDecl` + the shared reaper class                                                                                             |

## 4. Key decisions

### 4.1 Platform, not hook

Earlier revisions of this section argued at length why GitHub sits on the
webhook/code-host seam while Linear gets the platform tables. That argument is
settled and recorded where it belongs —
[integration-plugin-architecture.md §2–3](integration-plugin-architecture.md)
(code hosts implement only Layer-2 turn output plus the review adapter; chat
platforms implement the full contract) and
[gitlab-com-integration.md](gitlab-com-integration.md) (the code-host seam's
second implementer, which extracted the shared members the old text predicted
would be "designed from two code hosts, not asserted from one"). The one-line
summary that survives: **no conceptual line separates the seams** —
conversation identity, streaming, shared posting identity, and authorization
direction all failed as dividing lines; what keeps GitHub and GitLab off the
platform tables is that they have no chat ingress and implement a much
narrower surface.

Linear has chat ingress in all but name. Its product hands us the platform
shape natively: the deployment's OAuth app is the identity users delegate to
and mention (§4.3), a connected workspace is a `Bot` row with `Integration`
rows as its enabled-agent members — the same tables every chat platform uses.
Its sessions are conversations (channel = the connected workspace, thread =
agent session) with follow-ups and a streaming reply surface. Linear therefore
implements all four platform contracts and renders in the console as ordinary
conversations (`platform: 'linear'`).

What the earlier revision "borrowed from hooks" — signed relay-terminated
ingress, an in-memory assign table with CP replay, dispatch retry toward the
daemon, durable inbox dedup — has since been generalized into relay core and
the platform-ingress plugin contract. There is nothing left to borrow: the
shipped seam already **is** that machinery, and the bespoke
`RcLinearAssign` / `RdMsgLinear` frames this doc used to define would now be a
second copy of it.

### 4.2 Relay-terminated ingress is mandatory

Lark / Feishu chose a daemon-direct `WSClient` because the daemon must dial out.
Linear offers no such transport, so a Linear bot exists **only on the `http`
transport** and the integration requires a configured `PUBLIC_RELAY_URL` and
at least one live relay — the same relay-availability 409 core already
enforces for `transport: 'http'` at create time. The web wizard tile is gated
on the daemon advertising `linear` (`capabilities.platforms`, read by the CP's
pre-install gate and the console) **and** on `WizardHost.relayCapability`.

### 4.3 One deployment-owned Linear app; a Bot row per connected workspace; agents are members

The deployment operates **one Linear OAuth app** — the same class of
deployment infrastructure as its GitHub App, Google App, and Slack platform
app, administered the same way (Setup Server owns the typed deployment
document and write-only secrets for a self-host; a managed deployment ships
one product-branded app for every customer workspace). Linear has no
app-creation API, so this one app is created manually, **once per
deployment**, never per agent and never per organization (§7.1).

The mapping onto existing tables — the Slack shared-bot shape, not a new one:

- **`Bot`** (platform `linear`) = **one connected workspace**. D6 identity
  columns: `externalAppId` = the deployment app's client id (constant across
  rows), `externalTenantId` = the Linear `organizationId` — always complete,
  because the rows are created at the OAuth callback (§7.1), never before
  the workspace is known. `transport` is always `http`, and the provider
  stamps **`shareable: true` structurally** on every workspace bot —
  `Bot.shareable` is the switch the shipped install validation gates
  multi-integration membership on
  ([shared-bot-relay.md §1](shared-bot-relay.md): a non-shareable bot caps
  at one integration), and a connected workspace is definitionally
  multi-agent, so this is not a caller flag the provider honors but a
  constant it sets.
- **`Integration`** = one **enabled agent** on that workspace
  (`Integration.botId` is deliberately non-unique — the shared-bot
  precedent). The workspace's **dispatch default** is not a Linear-shaped
  field at all: the workspace IS the bot's one conversation (§4.5), so the
  default is the ordinary per-conversation owner (`IntegrationChannel.agentId`,
  [shared-bot-relay.md §10.1](shared-bot-relay.md)) — the row is its storage
  and its console control, edited through the generic
  `PATCH /integrations/:id/channels/:channelId`, and the compile carries it
  into the ladder's addressed-gated **default rung** rather than into a
  channel-scoped route (§6.2).
- The cross-org `workspaceClaim` fence refuses a workspace another
  organization already holds — every workspace's events verify against the
  same deployment signing secret, so the tenant composite is the only thing
  standing between two organizations' attributions.

**Trigger model — one channel, GitHub-events semantics.** A connected
workspace behaves like a single channel several agents sit in, and every agent
session in it is a thread (§4.5):

- **Delegating an issue to the app** (no text) starts a session with the
  workspace conversation's **dispatch default** — the row's owner, reaching
  the ladder as `defaultAgentId` on its last rung (§6.2). Linear-side
  automations that auto-delegate land here too.
- **Mentioning the app with text** starts a session with the agent the text
  names — `@<agent-name>` anywhere in the instruction, matched against the
  workspace's enabled members, exactly as a GitHub comment addresses one
  agent by name inside a thread the App owns. The name is plain text (agents
  are not Linear entities; only the app is mentionable), matched by
  the per-member keyword routes the HTTP-bot orchestrator's compile
  **already emits** — one unscoped `{ kind: 'keyword', value: agent.name }`
  rule per placed non-gated member (§6.2) — and outranking the row's owner,
  which sits one rung below on the default (§6.2).
- **One AgentSession binds to one agent at creation** and never changes
  hands: follow-ups and stop go to that agent. Addressing a _different_
  agent is a new mention on the issue → a new session → another thread in
  the workspace channel. Naming several agents in one mention selects the
  **first**, silently and on purpose: member names are ordinary words in
  issue prose, so an ambiguity error would fire on text that never meant to
  address anybody, while the ≤10 s ack and the response's attribution footer
  already say which agent took the turn. Linear mints exactly one session per
  mention, so there is nothing to broadcast to (unlike GitHub's `@app-slug`
  fan-out).
- **No trigger control, and no Off state.** Slack needs a per-conversation
  trigger because its integration granularity (the workspace) and its
  conversation granularity (the channel) differ, and because a bot enters
  channels without the agent owner's consent — the row is where that missing
  consent is repaired. For Linear the two granularities **coincide** (one
  connected workspace is exactly one conversation) and linking the workspace
  to an agent IS the consent act, so a trigger could only restate the link.
  Muting is unlinking. Linear conversation rows are therefore born enabled
  (`mention`) for every member, **including a private agent's**, whose rows
  every other platform seeds `off` (§9.2) — and, for the same reason, a
  private member here is not conversation-gated at all, so it keeps its
  `@<agent-name>` rung and can hold the workspace default (§6.2). The write
  surfaces refuse it too — silencing a workspace is unlinking, so a `trigger`
  write is rejected with a message naming that path, while the same route's
  owner change keeps working (§9.1). Slack's
  `any` has no Linear meaning either: the platform emits no unaddressed
  traffic to opt into — every event is a delegation, an app mention, a
  follow-up inside a session the agent already owns, or a stop.
- **Identity renders in content**, not in the sender: the feed shows the one
  app's name and icon, the ≤10 s ack opens with the acting agent's name, and
  the final `response` carries the attribution footer — the GitHub comment
  model, using the same chrome helpers (§5).

**Rejected — one OAuth app per agent** (the model of every earlier revision
of this section): it made each agent a first-class assignable identity in
Linear's delegate menu, but Linear has no app-creation API, so it priced
every agent at a manual app-creation checklist and cluttered the delegate
menu in proportion to fleet size; the integrations in Linear's own agent
directory are one app per product. A hybrid (shared app plus optional
dedicated apps) was also rejected as two install stories to explain and
maintain. The cost accepted in exchange: `@<agent-name>` works only inside
an app mention, and per-agent avatars do not appear in the feed.

### 4.4 Token custody: CP owns refresh, daemon gets brokered access tokens

Linear access tokens expire in ~24 h and refresh **rotates** the refresh
token. Rotating credentials need one durable writer; that is the CP with
Postgres (precedent: Slack config-token rotate-and-retry). The daemon never
holds the client secret or refresh token. Instead:

- The provider stores `{accessToken, refreshToken, expiresAt}` per
  **connected workspace** in its own `linear_token` table, encrypted through
  the existing `SecretCipher` seam — keyed by the **connection identity**
  `(orgId, clientId, organizationId)`, the same pair the bot's D6 columns
  mirror, **not by the Bot row id**. The token is the workspace's
  authorization of the app, so it belongs to that identity and survives both
  agent-membership churn and the Bot row itself. Two things fall out of the
  key choice: the OAuth callback can write the token **before** any Bot row
  exists (which is what makes §7.1's ordering implementable against the
  shipped create tail, whose bot id is minted internally), and adding or
  removing member agents never touches the credential. (The CP provider
  contract's projectors are async for exactly this case — the provider loads
  from its own secret store inside `projectIntegrationConfig`, resolving by
  the bot's D6 identity; core awaits uniformly.)
- `projectIntegrationConfig` embeds the **current access token + expiry** in
  the opaque `IntegrationSpec.config`, so `agent.json` always carries a ≤24 h
  token — the daemon can restart and keep posting activities while the CP is
  briefly down (graceful degradation, bounded by token lifetime).
- A `linearcred/request { integrationId }` REQ on the control WS (mirroring
  `gitcred`) returns a fresh token; the CP refreshes on demand behind a
  single-flight, persists the rotated pair durably before replying, and the
  daemon re-requests when its cached token is within a safety margin of
  expiry (e.g. 2 h).

Rejected alternative — daemon-side refresh: requires shipping the client
secret to the edge, makes the daemon the writer of a rotating credential held
only on its disk, and loses the token permanently if `agent.json` is wiped
mid-rotation. The hot path does not need it: egress works from the cached
token; only _renewal_ touches the CP, at most ~once a day per workspace
install.

### 4.5 Session mapping and dedup keys

- One Linear **AgentSession** ↔ one AgentConnect session, through the
  ordinary normalized coordinates — no Linear-shaped keying:
  - `channel` = the Linear **`organizationId`**: the connected workspace,
    which is what a channel means here (§15) — the mount point every
    configuration fact already hangs on. It is stable for the life of the
    connection and always present, including on the issueless surfaces below.
  - `thread` = the AgentSession UUID. Every session in the workspace is a
    thread in that one channel, matching Slack's thread model: two
    delegations on the same issue, a mention on a different issue, and a
    document mention are four threads side by side. Each is bound to one
    agent at creation and never changes hands, which is the natural way to
    bring a **different agent** onto the same issue (§4.3).
  - **`channelName` is the workspace name, full stop.** It is the display
    slot of the `channel` coordinate — one label shared by every session in
    the channel — so an issue-derived name is not merely imprecise there, it
    **relabels the siblings**: each event would rewrite the one field and the
    sessions from other issues would start reading as if they belonged to the
    latest one.
  - **The issue is display metadata, not a coordinate.** `TEAM-123` is a
    human identifier that changes when an issue moves teams, and its
    immutable UUID would be stable but buys nothing, because nothing is ever
    configured per issue. It surfaces in exactly two per-session slots plus
    the prompt: the **session title** (`TEAM-123 · <title>`), the normalized
    message's **`threadUrl`** (the issue URL, for console deep links), and
    the prompt's trusted header (§8).
  - `app:mentionable` also covers documents and other editor surfaces, and
    Linear's schema makes the session's issue nullable, so a session
    **without** an issue is defined, not an error — and needs no key fallback
    now that neither coordinate mentions the issue: it is one more thread in
    the workspace channel, under the same `channelName`, with the session
    title falling back to the session/source title and no `threadUrl`. Never
    `linear:undefined:…`. **v1 behavior for
    no-issue sessions:** after durable admission/dedup, the daemon posts one
    bounded `response` ("mention me on an issue — this surface isn't
    supported yet") and does **not** start an ACP turn.
  - The relay computes its session key from `(channel, thread)` exactly as it
    does for every shared bot; the daemon's local key adds the agent id as
    usual.
- Follow-ups: `prompted` events carry the same `agentSession.id` → the same
  coordinates → the daemon resumes the same ACP session.
- Dedup `msgId` is **content-derived**, not delivery-derived, so Linear's
  1 min/1 h/6 h redeliveries and relay-internal retries converge regardless of
  whether `Linear-Delivery` is stable across attempts — and, being derived
  from the event rather than from the coordinates, it is untouched by the
  workspace-is-the-channel correction:
  - `created` → `linear:<agentSessionId>:created`
  - `prompted` → `linear:<agentActivityId>`

  The plugin mints the identity; relay core's TTL dedup table absorbs
  same-pod replays and the daemon's durable inbox on
  `(botId, sessionKey, msgId)` absorbs the rest.

### 4.6 Single-writer egress

Only the daemon's `LinearConnection` writes to Linear for a session — the
converger's activity stream plus the session-level updates. The agent itself
gets no Linear token in its environment and no write tool in v1 (parallel to
the GitHub single-writer rule that prevents duplicate/overwrite races). Any
later Linear read tools (§10, P2) are daemon-local builtins that use the
connection's token without exposing it, following the Slack
`getChannelInfo` pattern.

## 5. Interaction mapping: ACP stream → Agent Activities

The daemon module registers a **streaming Layer-2 surface**
(`TurnOutputSurface`, `packages/daemon/src/platforms/linear/turn-output.ts`)
for `'linear'`: `createConverger(ctx)` builds a fresh `LinearConverger` per
turn, `apply(turn, action)` maps its actions to GraphQL calls through the
per-integration `PlatformSendQueue`, and `initialTurnState` carries the
per-turn Linear state (activity caps, last plan hash). GitHub's turn-final
shape is deliberately **not** used: Linear's product is the live feed, so it
emits as it goes, like the chat platforms.

Because every agent posts through the one deployment app (§4.3), **the acting
agent's identity is rendered in content** — the ≤10 s ack opens with the
agent's name ("**review-bot** · reading TEAM-123 …") and the final `response`
carries the attribution footer — the GitHub comment model, reusing the shared
fence-aware chrome helpers. Intermediate thoughts and actions stay unprefixed:
the session is single-agent (§4.5), so the ack has already named its owner.

The converger emits a Linear-shaped IR:

```ts
export type LinearAction =
  | { kind: 'activity'; type: 'thought'; body: string; ephemeral?: boolean }
  | { kind: 'activity'; type: 'action'; action: string; parameter: string; result?: string }
  | { kind: 'activity'; type: 'response'; body: string }
  | { kind: 'activity'; type: 'error'; body: string }
  | { kind: 'activity'; type: 'elicitation'; body: string }
  | { kind: 'plan'; entries: { content: string; status: 'pending' | 'inProgress' | 'completed' | 'canceled' }[] }
  | { kind: 'external-urls'; add: { label: string; url: string }[] }
```

`apply` maps `activity` → `agentActivityCreate`, `plan` / `external-urls` →
`agentSessionUpdate`.

### 5.1 Event translation

Unlike Slack, Linear activities are **append-only snapshots** — there is no
message editing. The converger therefore runs in a discrete-update posture:
coalesce aggressively, post meaningfully.

| ACP update                                                               | Linear activity                                | Notes                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| turn admission (`created`)                                               | `thought` (ephemeral)                          | The ≤10 s ack, posted by the dispatch path **before** agent spawn, opening with the acting agent's name: "**review-bot** · reading TEAM-123 …" — or "… queued behind the current task" when the agent is busy                                                                               |
| `agent_thought_chunk`                                                    | `thought` (ephemeral)                          | Coalesced per idle window (reuse the 2 s idle-flush timer), tail-clamped like `MAX_REASONING`                                                                                                                                                                                               |
| `agent_message_chunk` (intermediate, flushed at a tool boundary or idle) | `thought` (non-ephemeral)                      | Progress narration between tool calls stays visible in the feed                                                                                                                                                                                                                             |
| `tool_call` → terminal `tool_call_update`                                | `action`                                       | Emitted once at terminal status: `action` = tool title, `parameter` = input summary, `result` = head-clamped output (~2 800 chars). Consecutive same-title calls collapse; per-turn cap with a final "… and N more" thought                                                                 |
| ACP `plan` update                                                        | `plan`                                         | Both sides are full-array replace — direct mapping                                                                                                                                                                                                                                          |
| a pull/merge-request URL anywhere in the agent's message text            | `external-urls` (`addedExternalUrls`)          | Collected over the whole turn, each URL once, labelled `PR #123` / `MR !45`; published once, immediately before the settling `response` (§10.3)                                                                                                                                             |
| turn end                                                                 | `response`                                     | The accumulated final answer (final-answer selection reuses the GitHub Layer-2 heuristics: `_meta.codex.phase === 'final_answer'`, else message grouping, else last text run). Attribution footer appended per `output.showFooter`, Markdown-safe via the shared fence-aware chrome helpers |
| turn failure (quota / auth / crash)                                      | `error`                                        | Reuses `turnFailureReason`/`turnFailureCode`; converger buffer flushed first so runtime-narrated errors are not duplicated                                                                                                                                                                  |
| permission gate would block the turn                                     | `elicitation`                                  | v1 posts "This step needs approval — open the session in the console" + deep link; interactive approval from Linear is out of scope (§13)                                                                                                                                                   |
| `session_info_update` (title)                                            | —                                              | Persisted locally for the console; Linear names sessions itself                                                                                                                                                                                                                             |
| stop (`prompted` + `signal: "stop"`)                                     | `response` "Stopped — reply here to continue." | After `interruptTurn` completes; a `response` settles the Linear session state instead of leaving it `active`                                                                                                                                                                               |

`AC_NO_RESPONSE` keeps the product invariant with one **explicit, structural
exception**: the pre-spawn acknowledgement (§10.1) is posted before the ACP
turn runs, so it already exists by the time the sentinel can be known. A
suppressed turn is therefore **ack-only** — after the ack, no further
activity of any kind is posted (Linear keeps an ephemeral activity displayed
until another activity replaces it, which is precisely why nothing may
follow), no settling `response`, and the Linear session is left to go stale.
In practice the sentinel should not fire here: every Linear turn is
explicitly addressed to the agent (delegation, mention, or a direct session
prompt), so the prompt prelude carries the explicit-mention reminder exactly
as chat platforms do.

### 5.2 Output modes

`output.mode` keeps its meaning, re-read per dispatch as today:

| mode            | ack | thoughts (reasoning) | progress thoughts | actions     | plan | response            |
| --------------- | --- | -------------------- | ----------------- | ----------- | ---- | ------------------- |
| `none`          | —   | —                    | —                 | —           | —    | — (transcript only) |
| `minimal`       | ✓   | —                    | —                 | —           | —    | ✓                   |
| `low` (default) | ✓   | —                    | ✓                 | ✓           | ✓    | ✓                   |
| `medium`        | ✓   | ephemeral            | ✓                 | ✓           | ✓    | ✓                   |
| `high`          | ✓   | ephemeral            | ✓                 | ✓ + results | ✓    | ✓                   |

Note the default differs from chat platforms: an agent-session feed is _for_
progress visibility (that is the product), so `low` already includes actions
and plan. `none` is **truly silent** — no ack, no activities, transcript
only — which means Linear will render the session unresponsive/stale. That is
the invariant-preserving behavior, not a bug; the console flags
`output.mode: none` on an agent with a Linear integration as a
misconfiguration warning.

### 5.3 Rate limiting

Linear allows 5 000 requests/hour per OAuth app per workspace (per its
published rate-limiting docs). The per-integration `PlatformSendQueue`
enforces FIFO plus a minimum interval (~1 s for activities), and the
converger's coalescing keeps a busy turn to tens of activities, not hundreds.
`plan` and `external-urls` updates are debounced (last-write-wins within the
idle window).

## 6. Ingress detail

### 6.1 Relay platform-ingress plugin

`packages/relay/src/platforms/linear/` implements
`RelayPlatformIngressPlugin` plus one registry line. Per member:

- **`installRoutes`** mounts `POST /linear/events` — plugin-declared like
  `/slack/events` and `/feishu/events`, raw-body content-type parser (the
  HMAC is over the exact request bytes), pinned by
  `platforms/route-mounts.test.ts`. One **static, shared** URL: a Linear app
  configures exactly one webhook URL, and the trust model is the same as
  Slack's shared endpoint — the signature authenticates, the verified payload
  identity demuxes. The earlier revision's minted capability-URL token is
  dropped: it added a second secret that only re-proved what the HMAC already
  proves. A delivery no assigned bot owns answers 401.
- **`extractDemuxHints`** reads the platform's identity vocabulary from the
  body: `appId` = `oauthClientId`, `tenantId` = `organizationId`. Every
  Linear assignment is **tenant-scoped** (§5.1 of the parent design):
  assign-derived, never learned from traffic, eagerly evicted on unassign —
  sibling installs of the same app share a signing secret, so the composite
  index is the only demux that cannot leak one workspace's events into
  another's bot.
- **`buildIngest`** validates the assignment's opaque bags (§6.2) and builds
  the per-bot ingest: a pure HTTP decoder — no `start`, no-op `stop`, no
  relay-side `egress` facet (the daemon owns all Linear egress, like Feishu).
- **`verify`** checks `Linear-Signature` (timing-safe HMAC-SHA256 over raw
  bytes, via the shared signature primitives relay core already serves both
  seams with), then parses and enforces the 60 s window on the **signed
  body's** `webhookTimestamp` against the host clock — the unsigned
  `Linear-Timestamp` header may only be cross-checked for equality, never
  trusted for freshness — and returns the typed parsed `AgentSessionEvent`,
  parsed exactly once.
- **`handle`**:
  - `created` / `prompted` → a `WireNormalizedMessage` (§6.3) through
    `host.forward(botId, msg)`. Relay-core arbitration resolves the target
    with the ladder it already runs for shared bots: `prompted` follows the
    session's thread affinity (the session's bound agent); a `created` from
    a mention matches the per-member **name routes** the shipped HTTP-bot
    compile already emits for every placed non-gated member
    (`@<agent-name>` in the text, §4.3/§6.2); anything
    else — bare delegation, automation delegation, no name matched — reaches
    the ladder's last rung, `defaultAgentId`, which carries the workspace
    row's owner (§6.2) or, before that row exists, the compile's
    earliest-non-gated derivation. Every event is explicitly addressed by
    construction, which is what keeps that rung — and the keyword one above
    it — reachable at all.
  - `prompted` + `signal: "stop"` → `host.forwardAction` with a
    `platform_action` envelope (§6.3) routed via the directory — an
    interaction, not a message, exactly like a Slack cancel button.
  - The plugin mints the content-derived dedup identity (§4.5);
    `host.dedupSeen` drops same-pod replays before any forward.
  - Non-`AgentSessionEvent` events are dropped with 200 (the user may have
    enabled broader webhook categories) — except `OAuthApp revoked`, which
    flows to `host.reportRevoked(botId, reason, eventAt, credentialRevision)`;
    the CP re-verifies against the API behind the revision fence before
    flipping the integration, exactly as platform revocations already
    converge.
  - **Always return 200 after signature verification**, before daemon
    delivery resolves. Linear's retry ladder (1 min/1 h/6 h, then
    auto-disable) is too slow and too dangerous to use as our queue; relay
    core's own forward retry/backoff covers transient daemon absence. If the
    daemon stays offline the event is dropped and the Linear session honestly
    shows unresponsive/stale (§11).
  - Body cap 1 MiB; `promptContext`/`previousComments` truncated to a bounded
    excerpt (32 KiB budget, `truncateUtf8` on code-point boundaries) before
    the frame is built. A per-bot ingress token bucket reuses the shared
    limiter.

### 6.2 CP → relay distribution: `rc/bot-assign`, nothing bespoke

Linear rides the standard bot assignment. The provider's `projectBotAssign`
produces the two opaque bags:

```ts
// secrets bag — relay-only material (a NEW accepted shape for the relay's
// assignment mapper: signing secret alone, no bot token — the platform's
// egress is entirely the daemon's)
{ signingSecret }
// ingress bag — demux identity + self-echo metadata, in the bag's GENERIC
// slots: relay core indexes {appId: apiAppId, tenantId: teamId} and its
// tenant fence reads teamId, so platform-named keys would be dropped
{ apiAppId: clientId, teamId: organizationId, botUserId: appUserId? }
```

The signing secret is the deployment app's (§7.1), stamped into each
workspace bot's secret row at connect; the client secret and the refresh
token never reach the relay. Everything else on the frame stays
core-assembled as for every platform — and for Linear the shared-bot members
are doing real work: `members`/`agents` list the workspace's enabled agents,
`routes` carries the per-member name rules (§6.1), `defaultAgentId` **is the
workspace conversation's owner**, and `credentialRevision` fences
signing-secret rotation (§10.6). Routing is assembled by the HTTP-bot
orchestrator's core compile — `projectBotAssign` deliberately carries **no
routing**, only the two opaque bags — and that compile already emits the
member-name rules Linear needs: one unscoped
`{ kind: 'keyword', value: agent.name }` route per placed non-gated member
(its keyword-disambiguation loop), which is exactly the `@<agent-name>` path,
reused with zero new code.

**The conversation row is the carrier of the dispatch default, not a route.**
It is where the default is stored, edited, and displayed (§4.3, §9.5); what
the compile does with it is map its owner onto the group's `defaultAgentId` —
the ladder's **last, addressed-gated rung** — and emit **no channel-scoped
route** for it. Which of the two an owner compiles to is the platform's
`soleConversation` manifest axis (§9.1), read where routes are projected, not
a Linear branch in the compiler.

That distinction is the whole correctness argument, because channel ownership
is the ladder's **first** rung and outranks everything below it. A
channel-scoped owner route would therefore win ahead of thread continuity and
ahead of the unscoped keyword slug: it would shadow `@<agent-name>` on every
mention and drag an already-bound session onto whoever the row currently
names. Mapping the owner to the default rung instead leaves the order Linear
needs:

| Linear event                                       | Rung that decides it  | Target                                                           |
| -------------------------------------------------- | --------------------- | ---------------------------------------------------------------- |
| `created` from a mention naming a member           | unscoped keyword slug | the named member                                                 |
| `prompted` follow-up in a bound session            | thread continuity     | the session's agent — an owner change never moves a live session |
| bare `created` (delegation, automation delegation) | `defaultAgentId`      | the row's owner                                                  |
| any of these before the row exists                 | `defaultAgentId`      | earliest non-gated member — the backstop (§9.4)                  |

Both the keyword rung and the default rung are gated on the bot actually being
addressed — which every Linear event is by construction (§6.1), so the gate
never costs a delivery here, and thread continuity in between needs no such
gate. `defaultAgentId` keeps its generic earliest-non-gated derivation as the
backstop above, and the earlier revision's persisted bot-level preferred
default is withdrawn (§9.2, §15).

**A restricted member of such a bot is not conversation-gated at all.**
Conversation gating (resource-visibility.md §14) exists to keep a private agent
out of conversations nobody granted it; where the install names the only
conversation there is, linking the agent WAS that grant, so the gate has
nothing left to guard and its fail-open worry presumes conversations that do
not exist. This is the axis's third read, and it is deliberately **one**
predicate — `gatesNewConversations(platform, agent)`, computed where the
compile builds its `placed` set — rather than a patch at each fence, because
the four things it decides have to move together: the member's unscoped
keyword rung (§4.3's `@<agent-name>`), its eligibility to hold the default,
its treatment under continuity gating, and its attribution as a relay target.
De-gating is per bot and derived from that bot's platform, so the same agent
stays fully gated on its other bots and its name routes nowhere else.

Rejected there: giving gated members **channel-scoped keyword routes**
instead. Scoped keyword sits above thread affinity, so a follow-up that merely
names another member would hijack the bound session — the same rung-order bug
as the owner route, arriving through a different door. The
earlier revision's `RcLinearAssign` / `RcLinearRemove` frames and the
relay-local Linear rule table are gone — replay-on-register, placement
re-broadcast, and lifecycle edges are the shared machinery.

### 6.3 Relay → daemon frames: `im` + `platform_action`

No new `rd/msg` union member. Events ride `RdMsgIm` with a
`WireNormalizedMessage`:

- `platform: 'linear'`, `channel` = the workspace `organizationId` (§4.5),
  `thread` = AgentSession UUID, `threadUrl` = the issue URL when the session
  has an issue, `sender.id = linear:<actorId>`, `isDm: false`.
- `text` = the member's instruction — the delegation line, the triggering
  comment's own text for a mention-created session (extracted so it is
  **never only inside fenced context**), or the follow-up
  `agentActivity.body` verbatim.
- `adapterExt.linear` = `{ agentSessionId, event?, issueId?, issueIdentifier?,
issueTitle?, promptContext?, guidance?, previousComments?, truncated? }` — the
  §6.4 adapter-extension bag: opaque to core, round-tripped to the daemon's
  linear module, which owns fencing and prompt assembly (§8). `event` names
  the webhook that opened the turn (`created` | `prompted`) so the daemon can
  tell the session-opening delegation from a follow-up (§10.2); `issueId` is
  the issue UUID the issue-scoped writes key on (Resources, state).

Stop rides `RdMsgPlatformAction` (`platformId: 'linear'`, payload
`{ kind: 'stop', agentSessionId }`): the daemon-side linear module decodes it,
short-circuits to `interruptTurn`, and posts the settling `response` — no
turn, no arbitration, dedup on the same `(botId, sessionKey, msgId)` scope as
every interaction.

## 7. Install flow and credential model

### 7.1 Once per deployment, once per workspace, then per agent

**Once per deployment — create the Linear app.** A deployment administrator
creates the one OAuth app at _Linear Settings → API → OAuth applications_
and records its three values as **deployment credentials**, exactly like the
deployment's GitHub App: on a self-host the Setup Server flow owns them
(typed deployment document, write-only secret entries); a managed deployment
configures its product-branded app the same way. The checklist: name and
icon are the **product's** (per-agent branding does not exist in this model,
§4.3); callback URL
`<PUBLIC_CP_URL>/v1/integrations/linear/oauth/callback` (the public `/v1`
form — the provider's `public-callback` routes are mounted at both scopes by
core, per the Slack precedent); webhooks enabled with **Agent session
events** checked, pointed at `https://<relay>/linear/events`. No
organization and no agent ever handles these credentials: the provider
receives them as its config slice (`envSchema` / deployment document — the
`SLACK_PLATFORM_*` precedent), and the console's Linear surface stays hidden
until they exist, the platform-app funnel's self-disable pattern.

**Once per workspace — connect it.** The flow starts where every other
integration does: an agent's integrations page, from the Linear card's
**Connect another workspace…** hand-off (§9.5). There is **no default-agent
step** — the agent the flow started from becomes the workspace's first member
and, being its only member, its initial dispatch default; moving the default
later is the conversation row's selector (§6.2), not an install decision. The
admin is sent to

```text
https://linear.app/oauth/authorize?client_id=…&redirect_uri=…&response_type=code
  &scope=read,write,app:assignable,app:mentionable&actor=app&state=<nonce>
```

with a one-shot `state` nonce persisted in `linear_install_state`
(TTL-reaped via `pendingInstalls`; it carries the nonce, the initiating
org/user, and the **linking agent** — **no secrets**, unlike the earlier
per-agent revision's funnel). The row **survives its callback** rather than
being deleted, carrying the terminal outcome the console polls: the OAuth
tab is a throwaway, so a tail refusal below has no other channel back. That
is also where "one-shot" is enforced — the callback CLAIMS the nonce with a
compare-and-set before it spends the code, so a replayed or concurrent
delivery of the same `state` never reaches Linear (the Slack platform-app
funnel's settled-row precedent). Core's relay-availability 409 applies at
funnel start, and so does the daemon `linear`-capability gate of §4.2.
**No Bot or Integration row exists before the callback**:
`IntegrationStatus` has no pending value, and `installNewBot` synchronizes
an `http` bot immediately, which would drive `projectIntegrationConfig`
before any `linear_token` exists — the funnel-creates-the-rows shape is the
Feishu one-click and Slack platform-app precedent.

The public callback exchanges the code at
`https://api.linear.app/oauth/token`, queries
`viewer { id organization { id name } }`, and proceeds in an order the
shipped create tail supports **without a new persistence seam** — possible
only because `linear_token` is keyed by the connection identity, not the Bot
row id (§4.4; `installNewBot` mints the bot id internally and calls
`syncBot` before returning, so a bot-keyed row could never be inserted in
between):

1. **Upsert `linear_token`** under `(orgId, clientId, organizationId)` —
   idempotent, replacing any prior row for the same workspace (the
   reconnect flow of §7.4 is this same arm).
2. **Run the shared create tail unchanged**: `buildNewBotInstall` packs the
   Bot columns (D6 identity `externalAppId` = the deployment app's client
   id, `externalTenantId` = `organizationId`; display
   `workspaceId`/`workspaceName`; `botUserId` = the app user id;
   **`shareable: true`** — structural, §4.3, so member additions pass the
   shipped multi-integration gate) and stamps the deployment app credentials
   into the workspace bot's `BotSecret` row (which is what the shipped
   assign machinery projects and revision-fences); the D6 composite
   pre-check and the cross-org `workspaceClaim` fence run; the Integration
   for the **linking agent** (`active` from birth) is written; the
   **workspace conversation row** is written with that agent as owner and
   `trigger: 'mention'` (§9.2), so the dispatch default is durable before the
   first delegation can arrive; and the
   tail's normal `syncBot` hand-off broadcasts `rc/bot-assign` +
   `integration/upsert`.
   `projectIntegrationConfig` resolves the token by the bot's D6 identity —
   already durable from step 1, so the ordering is guaranteed by
   construction rather than by a transaction the tail does not offer.

**Per agent — enable it on the workspace.** Adding an agent is one more
member Integration on the workspace bot (the generic existing-bot path — no
reuse fence exists or is needed under this model), plus its sibling
conversation row, written by the same path (§9.2) and repeating the
conversation's state without taking the owner from the member that holds it.
Moving the dispatch
default is a separate and entirely generic act: the workspace row's owner
selector (§6.2), offered on any member's Linear card. Every enabled agent's
name already compiles into a member keyword route (the shipped compile,
§6.2), which is what makes `@<agent-name>` addressing work.

If the tail refuses after step 1 (identity taken, workspace claimed), the
orphaned token row is inert: no bot references it, and the next connect
attempt for the same workspace overwrites it. Inert is not unbounded — the
row holds an encrypted refresh token and has no Bot FK for §7.4's delete
flow to find, so the provider registers an **orphan-token sweeper** via the
contract's `backgroundLoops`. Its selection and its upstream revocation are
deliberately conditioned on **two different scopes**, because the identity
fences are global while token rows are org-scoped — the cross-org loser
(refused because another organization's Bot already holds the
`(clientId, organizationId)` pair) must be sweepable even though the
winner's Bot is alive:

- **Select org-scoped:** a row is an orphan when its _own_ organization has
  no Bot for the identity and its last write is older than a grace window
  (long enough to never race a callback between steps 1 and 2, e.g. 1 h).
  The ownership test belongs **inside** the selection query, not to a filter
  over its result: the oldest stale rows are overwhelmingly healthy installs,
  so a batch taken before filtering is spent on them and the orphans behind
  them are never reached.
- **Claim, ask and act in ONE hold:** the grace window is a heuristic, not a
  lock — a retry can re-grant a long-stale identity at any moment. So the
  whole collection happens inside a single acquisition of the identity lock:
  the row is deleted under a condition on the `updatedAt` the snapshot saw
  (zero rows affected ⇒ skip), the ownership question is asked, and the
  upstream revoke is made, without ever releasing. Splitting those was a bug
  in both directions — a **same-org** retry could commit a fresh grant in the
  gap between the claim and the question, and because the question excludes
  the caller's own organization (so a disconnect does not count the row it is
  removing) the sweep read "unowned" and revoked the authorization backing
  that brand-new grant. The revoke uses the token the claim returned, so it
  can never act on a grant that arrived after the snapshot.
- **Delete locally, unconditionally:** the row is dead weight in its
  organization regardless of who else holds the identity.
- **Revoke upstream only when no organization relies on this app's
  authorization of this workspace** — the same Linear app + workspace backs
  the winner's live install, so a loser-initiated `POST /oauth/revoke` would
  tear it down. This is the one question here that another organization can
  falsify **without touching any row the sweep looked at**: it completes a
  connect for the same `(clientId, organizationId)` and the loser's own stale
  row is still exactly as the snapshot left it, so every row-level guard
  passes. It is therefore re-asked durably at the moment of acting, under a
  **per-identity advisory lock** (`persistence/linear-identity-lock.ts`,
  keyed on `(clientId, organizationId)` and deliberately **not** org-scoped),
  with the revoke inside that lock — releasing first would only narrow the
  window, since a winner admitted in between still loses its grant. The
  answer is "owned" when any organization's Bot holds the D6 identity **or**
  any other organization holds a token row for it; the second disjunct
  catches a winner that is mid-callback, having written its grant but not yet
  its Bot. §7.1 step 1's upsert takes the same lock, which is what makes the
  answer stable for the duration — and, because that write always precedes
  the create tail, locking it fences bot admission too. That upsert is
  therefore a **waiter**, and its transaction budget must exceed the longest
  a sweep may hold the lock (one bounded upstream call): expiring while
  queued would abort a callback that has _already spent its OAuth
  authorization code_, which Linear will not honour twice. The three
  constants — API request timeout &lt; maximum hold &lt; waiter budget — live
  beside the lock and are asserted in a unit test so they cannot drift apart.

The same sweep is the backstop for a failed best-effort `onBotDelete`
(§7.4). The funnel row's TTL reaper separately bounds stale connect
attempts (the funnel row carries no secrets in this model, §7.1).

### 7.2 Storage

| Value                                       | Where                                                                                                                                           | Visibility                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Deployment app credentials (id + 2 secrets) | deployment config / secret store (Setup Server document, `envSchema` slice), stamped into each workspace bot's `BotSecret` at connect (§7.1)    | CP; signing secret additionally to the relay via the assign bag |
| Client ID                                   | `Bot.externalAppId` (D6 column; constant across rows)                                                                                           | console, authorize URL, relay ingress bag                       |
| Workspace (organization) id                 | `Bot.externalTenantId` + display `workspaceId`/`workspaceName`                                                                                  | console, relay ingress bag                                      |
| Client Secret                               | `BotSecret.botToken` slot (`secretShape.slots` labels it)                                                                                       | CP only (code exchange + refresh)                               |
| Webhook signing secret                      | `BotSecret.signingSecret` slot; `httpAssignRequires: ['signingSecret']`                                                                         | relay only, via the `rc/bot-assign` secrets bag                 |
| Access + refresh token, expiry              | provider-owned `linear_token` table, keyed by the connection identity `(orgId, clientId, organizationId)` (§4.4), values through `SecretCipher` | access token → daemon (spec + broker); refresh token → CP only  |
| `state` nonce + linking agent + outcome     | provider-owned `linear_install_state` funnel table (TTL-reaped; carries no secrets; claimed once, then settled with the round trip's outcome)   | CP only                                                         |

The opaque `IntegrationSpec.config` payload the provider projects (validated
on the daemon by the linear module's schema in `CONFIG_SCHEMAS`):

```ts
{
  workspaceId: string
  workspaceName?: string
  appUserId?: string           // the app's Linear user id (self-echo guard)
  accessToken: string          // ≤24 h snapshot; refreshed via linearcred
  accessTokenExpiresAt: string // ISO datetime
}
```

`agent.json` therefore holds a short-lived token, not a durable secret — a
strictly smaller exposure than the other platforms' permanent bot tokens.

### 7.3 Token broker frames

```ts
// packages/protocol/src/frames/linearcred.ts
export const LinearCredRequest = z.object({ integrationId: z.string().uuid() })
export const LinearCredGrant = z.object({
  accessToken: z.string(),
  expiresAt: z.string().datetime()
})
```

The CP handler follows the `gitcred` shape — core owns the frame family and
the scope check, which is `gitcred`'s own service-scope predicate rather than
a placement equality: a pool member serves agents its row does not name, so
"may this connection act for that agent?" is placement OR a duty it holds; the
provider's token service owns the work: single-flight refresh when the stored
token is near expiry, durable persist of the rotated pair **before**
replying, then a spec re-push so `agent.json` converges. That re-push is the
SHARED integration converge, not a new mechanism: the token service reports
whether the answer it returned is newer than the stored pair the caller read,
and a rotated grant runs the same converge a visibility flip runs, whose
http-bot arm re-syncs the workspace bot — so every member's spec is re-pushed,
not only the requesting agent's. It is best-effort and follows the reply: a
grant that already landed must not fail on a fan-out, and the reconcile roster
carries the spec to any daemon the push missed.

### 7.4 Membership, disconnect, revocation

Three distinct lifecycle edges, because the token rides the connection
identity (§4.4), not any agent binding:

- **Remove an agent** — `DELETE /integrations/:id` drops one member from the
  workspace bot (standard broadcast: assign rebuild + `integration/remove`)
  and touches nothing else; its keyword route disappears, the workspace and
  its token stay live. Removing the member that currently owns the workspace
  conversation needs no Linear-specific guard rail: the shipped ownership
  convergence re-homes the row to a remaining member, and "no default" is not
  an operator state ([shared-bot-relay.md §10.1](shared-bot-relay.md)).
  Removing the **last** member leaves a connected workspace nobody is in —
  inert, not broken, and repaired by linking an agent again; tearing the
  workspace down is Disconnect, below.
- **Disconnect the workspace** — deleting the **Bot** is the real teardown,
  offered as a row action in the org-level Bots card and nowhere else (§9.5):
  best-effort `POST /oauth/revoke` at Linear plus deletion of the identity's
  `linear_token` row — both inside ONE hold of the identity's advisory lock,
  for the same reason the sweep's claim is (§7.1). Released between the
  ownership decision and the removal, a `put` queued on that lock publishes a
  fresh grant the instant the section ends and the unconditional delete then
  removes _that_ row, leaving the create or reconnect tail behind it believing
  its grant is durable. The ownership question is asked before the removal on
  purpose: it excludes the caller's own organization, so it already reads the
  world as it will be once the row is gone. The shipped `CpPlatformProvider`
  has no bot-delete lifecycle member, so this design adds one:
  `sideEffects.onBotDelete?(bot, secrets)` — best-effort by contract like
  `postCreate`, called from core's bot-delete path for any platform that
  declares it.
- **Dead token** (refresh rejected, app secret rotated, workspace revoked
  upstream) — the workspace connection flips `error` with a **Reconnect**
  CTA: the org-scoped reconnect route restarts the OAuth funnel against the
  existing bot, and the callback's step-1 upsert (§7.1) replaces the
  `linear_token` row in place. Its nonce is **bound to that bot**, so
  authorizing a different workspace is refused before anything is written
  rather than silently rotating the other one's grant. Replacing the grant is
  only half the repair: the usual cause is the revoked doorbell below, which
  stamps `Bot.revokedAt` and flips every membership to `revoked`, so the
  reconnect goes through the shared **credential install** (store, advance
  `credentialRevision`, restore the memberships revoked with the replaced
  generation — one transaction) before it re-broadcasts. A bare re-push would
  instead assign an empty member set and leave a delayed revoke report for the
  dead grant able to pass the fence. The `OAuthApp revoked` doorbell (§6.1)
  converges the same state when revocation originates on the Linear side —
  re-verified at the CP behind the `credentialRevision` fence, never trusted
  from the payload.

## 8. Prompt assembly and trust boundary

The daemon linear module owns turning the delivered `im` message into the
dispatch prompt (its per-platform strategy seat, fed by the round-tripped
`adapterExt.linear` bag):

- `platform: 'linear'`, `source: 'user'`, `trigger: 'mention'`,
  `sender.id = linear:<actorId>`, `isDm: false`, `headless: false` (the
  session has a live reply surface — the activity feed).
- **Trusted header** (daemon-authored): `Linear TEAM-123 "title" — delegated
by <actor>` + issue URL, with `sanitizeTitle` flattening.
- **Instruction text**: `msg.text` (§6.3) — the follow-up body verbatim for
  `prompted` (workspace members are the same trust class as Slack users, and
  their messages are instructions), or the delegation line plus the
  triggering comment's own text for `created`, plus `guidance`
  (workspace-admin-authored).
- **Quoted context**: `promptContext` and `previousComments` wrap in the
  existing `UNTRUSTED_CONTENT_BEGIN/END` fence with `neutralizeDelimiters`.
  Issue bodies can contain text authored outside the workspace (customer
  intake, forwarded email), so they are context, not commands — same stance
  as GitHub event bodies, softened by the trusted header carrying the
  actionable identity. Truncation appends "(context truncated)"; P2's read
  tool restores full access.
- Standing context is unchanged (agent meta gains `- Source: linear` and the
  channel/thread locator lines for free). No Linear-specific formatting
  instructions are injected — activities take CommonMark, so rendering is
  last-mile in the converger like every other platform.

## 9. Change inventory by host

Adding Linear is implementing the four contracts, plus one registry line in
relay, CP, and web, plus an **enumerated** composition set in the daemon
(§9.4, whose connection lifecycle is not yet registry-driven end to end) — no
core `switch`, no closed union, no platform enum migration. The capability
chain that gates availability end to end: the daemon's `CONFIG_SCHEMAS`
registry line → `capabilities.platforms` in the register handshake → the CP's
daemon-platform-capability gate (plus the relay 409 for `http`) → the console
tile.

### 9.1 `packages/protocol`

- `frames/linearcred.ts` — broker REQ/REP (§7.3) + codec round-trips. **The
  only new frames.** `Platform` is already an open string with tolerant
  readers (`platform-tolerance.test.ts`); `rd/msg` and `rc/bot-assign` carry
  Linear without change.
- `platform-manifest.ts` — **landed.** Linear is a manifest row, and it was
  **earned**: multi-agent sharing was gated by a core interim predicate
  (`control-plane/src/platforms/sharing.ts#supportsMultiAgentBots`,
  Slack-only — without this, `validateShareableInstall` would refuse a
  second Linear member before `addBotMembership` runs), and that module's
  own doc named the §5 `multiAgentShareable` field as its replacement once a
  second platform needed it. Linear is that second platform, so the field
  landed with the rows it needs (`slack: true`, `linear: true`;
  `DEFAULT_MANIFEST` stays `false`) and retired the predicate at its two
  call sites — an install-time, pre-dispatch read, per the manifest's own
  rule. Apart from the axis below, every other one keeps the fail-closed
  defaults (observed
  membership, no bot-sender routing, conversation-granularity leave); the
  refusal copy `sharing.ts` still owns now names the refused platform
  instead of enumerating the supported set.
  - **One new axis this design earns: `soleConversation`** (`linear: true`,
    `DEFAULT_MANIFEST` `false`) — one install **names the single conversation
    it can reach**, so a connected account IS one conversation (§4.3). It
    carries **four co-varying reads** — three pre-dispatch, one on the
    trigger-write surfaces — all in CP core and all today's platform branches
    waiting to happen:
    1. **Route projection** — the conversation row's owner maps to the group's
       `defaultAgentId`, and the compile emits **no** channel-scoped route for
       it (§6.2).
    2. **The trigger seed** — rows are born `mention`, written synchronously by
       the install paths, because link-is-consent overrides §14's
       restricted-agent `off` seed. Every seat that seeds, re-derives, or
       projects a row's trigger reads the **one** predicate
       `gatesNewConversations(platform, agent)`: the compile's
       `ensureConversationOwners`, the read-side `GET /integrations`
       projection, the daemon channels-report handler, and the install paths
       themselves. One predicate rather than four patched fences is what keeps
       the console from showing a conversation Off while the compile publishes
       its enabled route.
    3. **Gating itself** — a restricted member of such a bot is not
       conversation-gated (§6.2), from that same predicate at the compile's
       single `placed` seat.
    4. **The write-surface guard** — the generic per-conversation `PATCH` and
       the `setChannelTrigger` MCP tool **refuse a `trigger` write** on such a
       platform, answering with the unlink path instead of storing a value
       nothing reads. The **owner** change rides the same `PATCH` untouched,
       because that is the one setting the conversation really has (§9.5).
       Without this the seed and the gating read would be quietly editable
       back into the state they exist to prevent; Slack and every other
       platform keep both writes.

    The four co-vary by construction: the seed is only right if gating is
    vacuous, gating is only vacuous because the install granted the one
    conversation, and a trigger nobody may write is the only honest end of
    that argument. Fail-closed `false` keeps every other platform on the
    ordinary §10/§14 arms.
- The opaque integration-config payload shape (§7.2) is documented beside its
  peers in `frames/integration.ts`.
- `frames/cron.ts` — **not** extended in v1 (no cron target).

### 9.2 `packages/control-plane`

- `src/platforms/linear/` implementing `CpPlatformProvider` + one
  `registry.ts` line:
  - `envSchema` / deployment-document slice — the deployment app's client
    id, client secret, and signing secret (§7.1, the `SLACK_PLATFORM_*`
    precedent); the provider self-disables without them.
  - `credentialBodySchema` is vestigial by design: `validateConfig`
    **refuses the generic `POST /integrations` credential path** with a
    pointer at the connect flow — there are no per-org app credentials to
    paste, and a member Integration must never exist outside a connected
    workspace (§7.1).
  - `buildNewBotInstall` — invoked from the OAuth callback's finalize (the
    Feishu one-click precedent), stamping the deployment credentials into
    the workspace bot's secret row, setting `shareable: true` structurally
    (§4.3 — the multi-integration gate), and declaring the D6
    `externalIdentity` `(clientId, organizationId)` + the `workspaceClaim`.
  - `secretShape` (§7.2); `projectBotIdentity` (clientId / organizationId +
    workspace display metadata in `platformConfig`).
  - **The install paths write the workspace conversation row**, synchronously
    and before any traffic: the connect tail (§7.1) creates
    `(integrationId, organizationId)` with the linking agent as owner, and
    each add-member writes its sibling row, the shared-bot shape where every
    active integration repeats the conversation's state and exactly one row
    carries the owner. `trigger: 'mention'` at birth, from the
    `soleConversation` axis (§9.1) rather than a Linear branch. No new
    broadcast is needed: both paths already end in `syncBot`, which publishes
    the routes the new row changes.
  - `installRoutes('org')` — connect-workspace funnel start (records the
    **linking agent**, §7.1), connect status, reconnect (§7.4), and member
    management; `installRoutes('public-callback')` — the OAuth callback
    (§7.1). The dispatch default is deliberately **not** a provider route:
    it is the generic per-conversation owner PATCH (§6.2). Repo OpenAPI
    conventions on every route.
  - `pendingInstalls` — `linear_install_state` + TTL reaper.
  - `projectIntegrationConfig` (async, loads `linear_token` by the bot's D6
    identity — write-before-create ordering per §7.1) and `projectBotAssign`
    (§6.2, strictly the two opaque bags — routing, including the per-member
    keyword rules, is the core compile's, which already emits them).
  - `LinearTokenService` — exchange, single-flight rotate-and-retry refresh,
    revoke; surfaced to the WS `linearcred` handler (§7.3).
  - `backgroundLoops` — the orphan-token sweeper (§7.1): org-scoped
    selection, local delete always, upstream revoke only for globally
    unowned identities, behind a grace window.
  - **One contract extension** this design needs core to grow, consulted
    only for platforms that declare it:
    `sideEffects.onBotDelete?(bot, secrets)` for the disconnect revoke
    (§7.4), best-effort like `postCreate`. (The earlier revision's
    `validateBotReuse` reuse fence died with the per-agent-app model, and a
    `projectMemberRoutes` extension briefly sketched here died on
    inspection: the shipped compile's keyword-disambiguation loop already
    emits exactly the member-name routes §4.3 needs, so member addressing
    costs no contract change at all.)
  - **No generic core change.** An earlier revision asked core for one — a
    persisted bot-level **preferred default agent** (`Bot.preferredAgentId`),
    preferred by the orchestrator's compile over its earliest-non-gated
    fallback. It is **withdrawn** (§15): it existed only because
    issue-as-channel left a connected workspace with no standing conversation
    row, and therefore nowhere durable to keep a default. Once the workspace
    IS the conversation, that row is the carrier, the compile needs no new
    input, and the console's dispatch selector is the generic
    conversation-owner PATCH. Where the column or its DTO field has already
    landed, it comes back out.
- Prisma: new `linear_token` and `linear_install_state` tables only — Bot
  identity rides the existing D6 columns, and `platform` columns are already
  text.
- Tests: provider unit (schema guards, projector shapes incl. keyword
  routes); connect-funnel + OAuth callback + broker integration tests
  against a fake Linear token endpoint; workspace-claim and
  external-identity 409s.

### 9.3 `packages/relay`

- `src/platforms/linear/` implementing `RelayPlatformIngressPlugin` (§6.1) +
  one `registry.ts` line; a `platforms/route-mounts.test.ts` row pins
  `POST /linear/events`.
- Tests: signature/timestamp vectors, demux-hint extraction, verified-but-
  unmatched workspace → no candidate, truncation budgets, dedup-identity
  derivation, stop → `platform_action`, revoked-event doorbell.

### 9.4 `packages/daemon`

- `src/platforms/linear/`:
  - `connection.ts` — the per-integration egress client, a **minimal
    Layer 1**: `start()` warms the token (no socket to open), `stop()` clears
    timers; GraphQL over plain `fetch` (the `@linear/sdk` dependency is
    unnecessary — the agent surface is four mutations and two queries); token
    cache + `linearcred` renewal; `PlatformSendQueue`; self-echo guard on
    `appUserId`. The read port answers what Linear affords — `getChannelInfo`
    names the connected workspace (the channel, §4.5), `getUserProfile` the
    Linear user behind a `linear:`-prefixed sender id — and returns
    empty/`null` elsewhere (no `listBotChannels`, no `leaveChannel`,
    `downloadFile` deferred).
  - `turn-output.ts` — the streaming Layer-2 surface + `LinearConverger` +
    `LinearAction` (§5).
  - message strategy — `adapterExt.linear` → prompt assembly and fencing
    (§8); no-issue unsupported-surface response (§4.5); stop decoder for the
    `platform_action` payload → `interruptTurn` + settling response.
  - The ≤10 s ack at `rd/msg` admission, after inbox dedup (§10.1), and from
    the same hook the §10.2 auto-start (`LinearConnection.startIssue`, one
    state read + at most one `issueUpdate`, both on the paced queue) when the
    bag says the turn is the session-opening `created` and names an issue.
  - `codeHostLinks` in `turn-output.ts`: the §10.3 collector over the turn's
    message text, emitted as one `external-urls` action before the response.
  - **The conversation report is a name refresh, not the seeder.** The
    connection reports the workspace as its single conversation — one
    `integration/channels` row, `id` = the `organizationId`, `name` = the
    workspace name, `kind: 'channel'`, non-authoritative — but the row it
    reports already exists: the **CP writes it synchronously in the install
    paths** (§9.2), so the report only refreshes the workspace name and
    re-asserts a row that somehow went missing. Seeding the dispatch default
    from a daemon report would have made it depend on a live daemon and on
    report timing, and the window that opens is exactly the one a bare
    delegation arrives in.
- `platforms/integration-config.ts` — the `linear` `CONFIG_SCHEMAS` line
  (+ the schema in `agents/agent-schema.ts`). This line flips
  `capabilities.platforms` — the **advertisement**, not the wiring.
- **Enumerated `daemon.ts` composition lines** — the daemon's connection
  lifecycle is not yet registry-driven end to end (production connections
  still live in per-platform typed maps behind `bindSlack`/`bindTelegram`/…
  lambdas with explicit reconcile call sites, and the turn/action registries
  are assembled inline), so Linear lands the same additive set its four
  peers have, stated here so nobody mistakes `CONFIG_SCHEMAS` for the whole
  seam: a `linear` connection map + bind lambda, `reconcileLinearConnections`
  wiring at the shared reconcile call sites, one
  `TurnOutputRegistry.register(linearSurface)` line, and one
  `platformActionDecoders` entry for the stop decoder (without it the payload
  answers `unsupported_action`). All registrations, no branches; folding
  these maps into the §7.5 key-driven `ConnectionPool` registry is the parent
  design's remaining daemon stage and deliberately **not** a prerequisite
  here.
- Session metadata: `channelName` = the workspace name on every session; the
  issue identifier and URL reach the **session title** and `threadUrl` and
  stop there (§4.5).
- Tests: normalize (created/prompted/stop → the workspace `organizationId` as
  `channel` and the workspace name as `channelName` — two sessions from
  different issues agree on it — mention-comment `text` extraction, no-issue
  created event → the same channel and `channelName`, no issue-derived
  session title, no `threadUrl`, and a bounded
  unsupported-surface `response` with **no ACP turn**), the one-row
  conversation report as a name refresh, converger translation table per
  mode, coalescing caps,
  no-response **ack-only**
  (nothing posted after the pre-spawn ack; `none` mode remains
  zero-activity since it never acks), dedup-key derivation,
  **dedup-before-ack ordering including concurrent same-`msgId` deliveries
  collapsing to one ack** (fake clock).

### 9.5 `packages/web`

- `src/components/console/platforms/linear/` implementing
  `WebPlatformModule` + one `registry.ts` line:
  - `Mark` — Linear brand SVG (60 % box, `fillPct` convention).
  - `wizard` — for an agent, "link a connected workspace": a **single-select
    list of the org's connected workspaces**, names only, shaped like the
    GitHub repo picker — one add links one workspace (`freeBotFilter` offers
    the org's connected workspaces, `buildReuseInput` adds the agent as a
    member — unfenced, §7.4) — with a **Connect another workspace…**
    hand-off to the OAuth funnel (§7.1) that doubles as the empty state.
    There is no default-agent step and no member counts in the rows: the
    linking agent becomes a member, and the first member of a freshly
    connected workspace is its dispatch default by construction. Tile
    availability = daemon capability ∧ `relayCapability.available` ∧ the
    deployment app being configured.
  - `apiBindings` — connect-funnel, connect-status, reconnect, and member
    calls. The dispatch default is the generic conversation-owner PATCH, not
    a Linear binding.
  - `settingsFragments` — the agent's **Linear card**: one row per linked
    workspace, carrying the workspace name, the **dispatch selector** (the
    conversation row's owner, over any member — §6.2), connection status
    with an inline **Reconnect** when the grant is dead or deliveries have
    gone silent (§7.4, §15), and **unlink this agent**, which removes
    exactly one membership and nothing else. No issue list and no
    member-management panel: there is one conversation per row and no
    per-issue state to show (§4.3).
  - **Whole-workspace teardown lives in the org-level Bots card
    (`IntegrationsView`), not on the agent card.** A connected workspace is
    an **ordinary bot row** there — no Linear-shaped panel — with
    **Reconnect** and **Disconnect** as row actions; Disconnect is
    §7.4's teardown (revoke + token deletion + bot delete) and takes the
    workspace away from every member. Keeping it off the agent card is what
    makes "unlink" and "disconnect" impossible to confuse.
  - `channelList` — `roomNoun: 'workspace'`, no leave affordance. The
    generic conversation card has nothing Linear-specific left to render
    (one row, no trigger, §4.3), which is why the module draws its own.
  - `messageIdentity` — agent-activity id, else `null` (never dedupes).
  - `transcriptOrdering` — default `'seq'`.

## 10. Linear-specific decisions

1. **The ≤10 s ack is daemon-authored, pre-spawn, and dedup-gated.** Agent
   spawn/resume can exceed 10 s, so the dispatch path posts the ephemeral ack
   thought before `SessionManager.handle()` (even when queued behind a busy
   turn) — but only **after** the durable inbox has admitted the delivery.
   Activities are append-only, so the ordering is strict: record
   `(sessionKey, msgId)` first, ack second; concurrent or replayed deliveries
   of the same `msgId` collapse before any feed row is written. This is the
   only activity ever posted outside the converger.
2. **Issue status transition** follows Linear's best practice: on the
   session-opening `created` (the bag's `event`), if the issue is not in a
   `started/completed/canceled` state, move it to the team's lowest-position
   `started` state (`LinearConnection.startIssue`: one paced read of the
   issue's state and the team's workflow, then at most one `issueUpdate`).
   Skipped for triage-status issues so Linear-side automation delegations
   keep human triage, and for a team with no `started` state. It runs from
   the same post-admission hook as the ack, **after the ack has posted** —
   both ride the connection's one FIFO queue, so the state read must not sit
   ahead of the ≤10 s acknowledgement — and the receipt CAS that collapses
   redeliveries also keeps the issue from moving twice; a follow-up
   `prompted` never touches the state the humans left it in. `output.mode:
none` skips it along with everything else Linear-visible. There is **no
   toggle**: the earlier "integration-level toggle (default on)" was dropped
   for the smaller surface — an integration that must not move issues has no
   such case today, and one can be added when it does.
3. **PR links.** The converger collects pull/merge-request URLs from the
   agent's own message text over the turn (`codeHostLinks`: `PR #123` for a
   GitHub pull, `MR !45` for a GitLab merge request, each URL once) and
   publishes them as `addedExternalUrls` immediately before the settling
   `response`, in every mode from `low` up. Reading the agent's text rather
   than a tool hook is deliberate: `gh pr create` prints the URL and every
   runtime's model repeats it in the answer, so this catches the PR on every
   runtime without knowing any tool. The console session link is separate —
   it lands in the issue's **Resources** (`attachmentCreate`, keyed by URL)
   on the first turn, so it is visible from the issue itself, not only inside
   the session panel.
4. **`elicitation` is a pointer, not a protocol, in v1.** True interactive
   approval (Linear reply → permission grant) needs an approval-card
   equivalent over activities; deferred (§13). Until then the agent's
   configured `permissionMode` governs, exactly like GitHub hook turns.
5. **No Linear-side title push.** Linear names agent sessions from the issue;
   AgentConnect's session titles remain console-local.
6. **Signing-secret rotation is a deployment action**: update the deployment
   credentials (Setup Server / deployment config), then a provider-owned
   re-stamp fans the new secret out to every Linear workspace bot's secret
   row, advancing each `credentialRevision` and re-broadcasting
   `rc/bot-assign` so the plugin rebuilds every ingest. No dual-key window in
   v1; rotation races drop deliveries for seconds, recovered by Linear's
   retry ladder (the one case where we _want_ the non-200: an unverifiable
   delivery returns 401 and Linear retries).

## 11. Failure and degradation semantics

| Failure                                                     | Behavior                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CP down, daemon up                                          | Established sessions keep streaming (cached/spec token, ≤24 h). New `created`/`prompted` events still flow (assignments live in relay memory; delivery is relay→daemon). Token renewal and install/uninstall stall.                                                                                                                                                       |
| Daemon offline                                              | Relay core's forward retry/backoff, then drop; the Linear session shows unresponsive/stale — an honest signal, surfaced in the console alongside daemon health. A CP-posted failure activity was considered and **rejected**: the CP performing provider egress would create a second Linear writer and put it on the message path, violating the architecture invariant. |
| All relays down                                             | Linear gets timeouts/5xx → its retry ladder (1 min/1 h/6 h) redelivers after recovery; content-derived dedup absorbs replays. Repeated failure risks Linear auto-disabling the webhook — surface `lastDeliveryAt` staleness in the console.                                                                                                                               |
| Token refresh fails (secret rotated at Linear, app deleted) | Broker returns terminal error; daemon posts `error` activity while its cached token lasts, else goes silent; integration flips `error` in the console with a re-connect CTA.                                                                                                                                                                                              |
| Linear API down                                             | Send-queue retries with backoff; activities are droppable chrome (the transcript is authoritative); the final `response` retries hardest (bounded, like the GitHub finalizer's 15 s budget).                                                                                                                                                                              |
| Duplicate webhook delivery                                  | Relay TTL dedup + daemon inbox (§4.5).                                                                                                                                                                                                                                                                                                                                    |
| Workspace admin revokes the app                             | `OAuthApp revoked` doorbell → fenced re-verify → integration `revoked`, assignment removed.                                                                                                                                                                                                                                                                               |

## 12. Security checklist

- Signing secret: relay-only, via the `rc/bot-assign` secrets bag — never in
  daemon specs, logs, or DTOs. Client secret: CP-only. Refresh token:
  CP-only, `SecretCipher`-encrypted. Access token: daemon memory +
  `agent.json` (≤24 h lifetime).
- HMAC verified timing-safe over raw bytes before any parsing side effects;
  `webhookTimestamp` replay window; demux is the tenant-scoped
  `(clientId, organizationId)` composite — assign-derived, never learned, so
  sibling installs of the same app (same signing secret) can never receive
  each other's workspaces' events. Unmatched delivery → 401, no oracle.
- Event bodies never transit or persist at the CP (activity bodies flow
  daemon → Linear only; CP stores session metadata, not content).
- Untrusted-content fencing for issue-derived text (§8); sanitized trusted
  header; delimiter neutralization.
- Agent environment contains no Linear credentials; all writes go through
  the daemon-owned single writer (§4.6).
- OAuth `state` one-shot nonces; callback exchanges bind to the funnel row
  that minted them; cross-org `workspaceClaim` fence at connect; no
  Bot/Integration row exists before the token does (§7.1).
- Rate limits both directions (per-bot ingress bucket; egress send queue).

## 13. Phasing

- **P1 — the core loop.** `linearcred` frames; deployment-app configuration
  (Setup Server document + `envSchema` slice); the `soleConversation`
  manifest axis and its two core reads (§9.1); CP provider (connect funnel +
  callback, the install-path conversation row, member management, token
  service + broker, projectors, the
  `onBotDelete` contract extension) + registry line; relay ingress plugin +
  registry line; daemon module (connection, the workspace-conversation
  report, ack with agent attribution, converger
  `thought`/`action`/`response`/`error`, follow-ups, stop, config schema) +
  the §9.4 composition lines; web module (workspace link + connect hand-off,
  mark, the Linear card, session display) + registry line. Exit criteria:
  delegate an issue → the workspace's dispatch default acknowledges ≤10 s
  (named in the ack) → streamed activities → response; `@<agent-name>` routes
  to the named member; moving the row's selector moves the next bare
  delegation; reply and stop work; sessions render in the console.
  **Shipped 2026-09-02.** Two items the live pass added on top of the list
  above: the session sits in the issue's Resources from its first turn
  (`attachmentCreate`, §5 table), and the delegator is named in the §8 header
  and the session list (a `created` event carries only `creatorId`, so the
  daemon resolves the name itself, full name first).
- **P2 — working inside the issue.** Re-scoped 2026-09 against what a
  delegated issue looks like when a competing agent handles it (the issue
  moves to In Progress on delegation, the PR is linked, the plan is posted,
  an empty ticket gets clarifying questions) and against Linear's own MCP
  server (~25 tools: issue list/get/create/update, statuses, labels,
  comments, projects, teams, users, cycles, documents). Three layers, in
  merge order:
  1. **Automatic behavior, no agent involvement** (done): plan sync (§5.1),
     the auto-start transition (§10.2), PR links plus the console Resources
     entry (§10.3).
  2. **A Linear tool family for the agent**, self-built on the connection's
     brokered app token — never Linear's hosted MCP server, which is a
     user-token identity that would bypass §4.4 custody and single-app
     attribution. Names follow the official MCP's vocabulary in camelCase so
     models need no learning (`listIssues`, `getIssue`, `createIssue`,
     `updateIssue`, `listIssueStatuses`, `listIssueLabels`,
     `createIssueComment`, `listIssueComments`, `listProjects`, `getProject`,
     `listTeams`, `listUsers`, `listCycles`, `listDocuments`, `getDocument`).
     `updateIssue` accepts state, assignee and labels **by name** and
     resolves them against the team, so the agent can "move it to In
     Progress" without a second lookup. **Injected only into a session ON
     the Linear platform** — the daemon's port-gated tools are
     session-platform-scoped, so a Linear-connected agent's Slack sessions
     carry none of these; cross-platform reach ("open a Linear issue from
     Slack") was considered and deferred until someone asks, because no other
     platform offers it either. Not in the first cut: initiatives, project
     updates, milestones, Linear's own documentation search, image loading
     (attachment download stays deferred, §9.4).
  3. **A daemon-authored Linear context block** in the §8 trusted header:
     the issue's UUID, identifier, team, current state, assignee and labels
     (the coordinates the tools take), plus a few lines of working convention
     — the issue is the record, so plans and outcomes go into its description
     or a comment; branch and PR names carry the identifier so Linear's own
     GitHub integration links them; an empty ticket earns a clarifying
     `response` before work. **Not a skill**: the tools only exist in Linear
     turns, so a per-turn prompt block is the deterministic seat, and the
     customer-side customization seat is Linear's own admin `guidance`,
     which §8 already passes through.
     Still in P2: the elicitation deep-link card.
- **P3 — breadth.** Label → skill playbook mapping; per-team dispatch
  defaults — the one upgrade that would split a workspace into several
  conversations, so it reopens §15's granularity argument rather than merely
  extending this design; proactive
  sessions (`agentSessionCreateOnIssue`) as a cron/sendMessage target
  (extends `frames/cron.ts`); `issueRepositorySuggestions` for multi-repo
  agents; interactive permission approval over activities.

## 14. Tests

- **Protocol:** codec round-trips for `linearcred/*`; the existing
  platform-tolerance suite already covers an unknown-to-peer `'linear'` id.
- **Relay unit (plugin):** signature/timestamp verification vectors,
  demux-hint extraction, tenant-composite candidate selection (incl.
  verified-but-unmatched workspace → no candidate, sibling-install
  isolation), truncation budgets, dedup-identity derivation, stop →
  `platform_action`, revoked doorbell, route-mounts row.
- **Daemon unit:** normalize (created/prompted/stop → the workspace
  `organizationId` as `channel` and the workspace name as `channelName` —
  two sessions from different issues agree on it, and issue text reaches only
  the session title and `threadUrl` — mention-comment `text` extraction,
  no-issue created event → the same channel and `channelName` and a bounded
  unsupported-surface `response` with **no ACP turn**), the one-row
  conversation report as a name refresh, converger
  translation table per mode, coalescing caps, no-response **ack-only**
  (nothing posted after the pre-spawn ack; `none` mode remains
  zero-activity since it never acks), dedup-key derivation,
  **dedup-before-ack ordering including concurrent same-`msgId` deliveries
  collapsing to one ack** (fake clock), config-schema fail-closed reads.
- **CP unit:** provider schema guards; token service rotate-and-retry with a
  failing-then-succeeding fake token endpoint; single-flight refresh;
  projector output shapes.
- **CP integration:** connect funnel → callback → active lifecycle against a
  stubbed Linear OAuth server, asserting **no Bot/Integration row exists
  before the callback** and that the token upsert precedes the create tail
  (a tail refusal after step 1 leaves an inert row the next connect
  overwrites, and the sweeper's cross-org split never revokes a live
  winner); D6 external-identity and workspace-claim 409s; the workspace bot
  is created `shareable: true` and a second member Integration is admitted
  (the manifest's `multiAgentShareable` row, §9.1); member add/remove
  recompiles the compile's existing member-name keyword routes without
  touching the token; **the connect tail and each add-member create the
  conversation row themselves** — `mention` even for a gated (private)
  member, owner on the linking agent, no daemon involved — and the compile
  turns that owner into `defaultAgentId` while emitting **no channel-scoped
  route**, so a named mention still reaches the named member and a bound
  session survives an owner change; with no row, `defaultAgentId` falls back
  to the earliest non-gated member; a **restricted** member of the workspace
  bot keeps its keyword route and may hold the default, while the same agent
  stays gated on an ordinary bot, and the console projection and the compile
  agree on its trigger (one predicate, §9.1); a `trigger` write is **refused**
  on both generic surfaces (the per-conversation `PATCH` and the
  `setChannelTrigger` tool) with the unlink path named, an owner change
  through the same `PATCH` **succeeds**, and a Slack conversation still
  accepts both; moving the row's owner moves bare
  delegations; removing the owning member re-homes the row instead of
  stranding the workspace; reconnect replaces a dead
  token in place; broker scope denial for a foreign daemon; workspace
  disconnect (bot delete) revoke convergence.
- **Live checklist:** real OAuth app in a scratch Linear workspace —
  delegate, mention, follow-up, stop, redelivery replay (Linear's webhook
  console), token refresh across the 24 h boundary, workspace revoke. Run the
  loop once against an agent served by a managed daemon-pool member as well as
  a self-hosted daemon — the pool leg additionally proves the deployment's
  egress policy admits `api.linear.app` and that `linearcred` brokerage works
  through pool placement.
  **Run 2026-09-02** against the test environment, both legs: delegate,
  follow-up on the same session, the default-dispatch switch, the ack /
  footer attribution, the console deep link and the Resources entry all
  passed. Still to exercise live: `@<agent-name>` mention routing, stop,
  redelivery replay, the 24 h token refresh, and workspace revoke. Two
  lessons the run left behind — the gateway route set is part of the
  platform contract (`/linear/events` was missing from the chart's relay
  rule, and the render contract now pins it), and a self-hosted daemon behind
  the release train writes its old model into the shared directory rows, so
  a stale-looking label is a version question before it is a code question.

## 15. Open questions

1. **`action` result delivery** — RESOLVED against the live API (2026-09,
   scratch workspace). `agentActivityCreate` is **purely append-only**: every
   call is a new activity row with its own id, and even a second create with an
   identical `(action, parameter)` does **not** update the first — it stacks a
   second row. Two consequences for §5.1: (a) the design's terminal-only posture
   is correct and required — emit each tool call **once** at terminal status, or
   the feed shows a start row and a result row for the same call; (b) the
   "consecutive same-title calls collapse" line is **our converger's job**, not
   Linear's — Linear will not coalesce, so the collapse must happen before the
   GraphQL call. (Rendering note: the **issue-embedded** activity card shows only
   a collapsed most-recent-action indicator — "Finished …" after a `response` —
   while the **agent-session detail panel** shows the full append-only timeline;
   both are driven by the same activity rows.)
2. **`prompted` after `complete`** — RESOLVED. A `response` activity settles the
   session to `status: complete` (`endedAt` set), inferred from the activity, not
   set explicitly. A user follow-up on a completed session **reopens the same
   session in place** (status → `pending`/`active`, same `agentSession.id`) — it
   does not require a new session. The `prompted` webhook carries the same
   `agentSession.id`, so §4.5's "follow-ups resume the same ACP session" holds
   after a stop `response`: stop settles the session, and the next prompt
   resumes it. (Observed `prompted` shape: `agentActivity.content.type: "prompt"`
   with `body`, `sourceCommentId`, and the prompting `user`; a stop would instead
   carry `agentActivity.signal: "stop"`, per §5.1.)
3. **Plan API stability** — Linear still marks it technology preview; P2
   should feature-flag plan sync per integration.
4. **`client_credentials` tokens** (30-day, per-app opt-in) are documented as
   app actors, so they could replace the refresh machinery for the app's home
   workspace. Open: whether they work for workspaces the app was installed
   into via OAuth (multi-workspace still needs `authorization_code`), and
   whether a 30-day non-rotating token is an acceptable custody trade-off.
   Evaluate before P2; the broker seam (§7.3) is unchanged either way.
5. **`addedExternalUrls` across turns** — the §10.3 collector dedups within
   a turn, but a follow-up turn that names the same PR sends it again. Whether
   Linear collapses an `addedExternalUrls` entry on URL (as `attachmentCreate`
   does) or stacks a second one is unverified; if it stacks, the fix is a
   per-session set on the daemon, not a change to the IR.

### Live-probe corrections to earlier assumptions (2026-09)

A scratch OAuth app in a test workspace exercised the full delegate → activity →
follow-up loop. Beyond the two resolved questions above, three facts correct or
sharpen the design:

- **The delivery carries a `Linear-Timestamp` header (epoch ms), but it is
  unsigned.** `Linear-Signature` covers only the raw body, so the header can be
  replayed fresh alongside a captured body — the `>60 s` replay window must be
  enforced on the **signed body's** `webhookTimestamp` after HMAC verification;
  the header serves at most as an equality cross-check.
- **Agent sessions are an app-level opt-in that gates delegation entirely.**
  Until the app enables webhooks with **Agent session events** checked,
  delegating an issue only sets the `delegate` badge and **no session is
  created** — `agentSessionCreateOnIssue` returns "Agent sessions are not enabled
  for this application." §7.1's webhook-configuration step is therefore a **hard
  prerequisite**, not advisory, and its absence must surface in the console as a
  misconfiguration (symptom: delegation with no agent response).
- **Adding webhook/event subscriptions forces existing installs to
  re-authorize.** Enabling Agent session events on an already-installed app
  raises a new "Receive realtime updates about your workspace" scope; Linear
  warns that prior authorizations must re-authorize before webhooks arrive. This
  is the same re-consent the §7.4 reconnect flow and §10.6 signing-secret
  rotation already drive — the connect UI's Reconnect CTA covers it. Detection
  is the §11 staleness signal, not the token: a pre-subscription install keeps a
  perfectly valid token while receiving nothing, so the console must surface
  the Reconnect CTA on webhook silence (`lastDeliveryAt` staleness), not only
  on a dead grant.
- **Delegation self-assigns the issue.** Delegating to the app also sets the
  issue **assignee** to the delegating user (assignee and delegate are distinct
  fields); the `created` event also mints a Linear-authored anchor comment
  ("This thread is for an agent session with …") whose id rides `agentSession.commentId`.

### Decision — the workspace is the channel (2026-09)

Earlier revisions mapped a Linear **issue** to a channel and treated a connected
workspace as the Slack-**workspace** analog — a shared bot with member
management and a bot-level default of its own. That is wrong, and the
correction is: **a connected Linear workspace is the analog of ONE Slack
channel.** `channel` is the `organizationId`, `thread` stays the AgentSession
UUID, and the issue is display metadata (§4.5).

**The criterion is what a channel is FOR.** A channel here is not merely a
container of threads — it is the **configuration mount point**: the granularity
at which a dispatch default and conversation gating are stored, edited, and
read — for Linear, on the ladder's addressed-gated **default rung** (§6.2, and
deliberately not the channel-ownership rung, which would outrank the very
addressing it exists to serve). Judged as a container, an issue does
look like a channel — it holds sessions the way a channel holds threads, which
is how the earlier mapping was arrived at. Judged as a mount point it fails
every part of the test. Issues are unbounded and born with their traffic, so a
row would exist before anyone could configure it and nobody would ever return
to it; and every configuration fact we actually have — which agents are
enabled, which one takes a bare delegation, which credential signs the events —
is a property of the workspace. The tell is what the console would have had to
render: a conversation list of thousands of dead issue rows, each with a
selector nobody ever set. Under the correction that list holds exactly one row,
and it is the row an operator does configure.

Nothing is lost in the flattening. One issue holding several sessions becomes
several threads in the workspace channel — the shape a busy Slack channel
already has — and the issue survives everywhere it was doing real work: the
session title, the `threadUrl` deep link, and the prompt's trusted header. It
does **not** survive in `channelName`, which is the display slot of the
`channel` coordinate and therefore one label shared by every session in the
workspace: writing an issue into it would relabel the siblings on each event
(§4.5).

**The granularity coincidence removes the trigger control.** Slack needs a
per-conversation Off because integration granularity (the workspace) and
conversation granularity (the channel) differ there, and because a bot is added
to channels by people who are not the agent's owner — the row is where that
absent consent is repaired. For Linear the two coincide, one connected
workspace being exactly one conversation, and the link IS the consent act, so a
trigger could only restate it; muting is unlinking. Linear conversation rows
are therefore born `mention` for every member, private agents included — and
born in the **install paths**, written by the CP as the link is made rather
than seeded from a daemon report, because a default that waits on a live
daemon is a default that is missing exactly when the first delegation lands
(§9.2, §9.4). Slack's
`any` has no Linear meaning either: the platform emits no unaddressed traffic
to opt into — only delegations, app mentions, follow-ups inside a session the
agent already owns, and stops. And a setting nobody reads must be a setting
nobody can write: the generic trigger-write surfaces refuse it and name the
unlink path instead, while the owner change on the same route goes through, so
the console and the tool surface offer exactly the one control this
conversation has.

The same argument settles what a **private member** means here, and it settles
it once rather than fence by fence. Conversation gating guards a restricted
agent against conversations nobody granted it; on a bot whose install names the
only conversation there is, that grant already happened, so such a member is
not conversation-gated at all — one predicate at the compile's `placed` seat
restores its `@<agent-name>` rung, its eligibility to hold the default, its
continuity gating, and its relay attribution together, and only on that bot.
The alternative considered was scoped keyword routes for gated members, which
fails for the reason the owner route fails: scoped keyword outranks thread
affinity, so a follow-up naming another member would hijack a bound session.

**Multi-name mentions keep the silent first-pick.** An ambiguity error was
considered and rejected: member names are ordinary words in issue prose, so the
error would fire on text that never meant to address anybody, and the ≤10 s ack
plus the response's attribution footer already say which agent took the turn.

**Consequence: `Bot.preferredAgentId` is reverted.** §9.2's "one generic core
change" — a persisted bot-level preferred default — existed only because
issue-as-channel left the workspace with no conversation row of its own, and so
no standing place to keep a default. Once the workspace IS the conversation,
the per-conversation owner the ladder already reads on its default rung is the
right carrier, and the new column has nothing to do: core gains no field, the
compile gains no per-bot input, and the console's dispatch selector is the
generic conversation-owner PATCH. What core does gain is one manifest axis,
`soleConversation` (§9.1) — how an owner compiles, how a new row seeds, and
whether gating applies at all — which is a statement about the platform, not a
second place to store a default.
The compile's earliest non-gated member derivation survives, demoted to the
backstop covering the window before the row exists at all (§9.4).

## References

- Linear — "Getting Started" (agents), "Agent Interaction", "Interaction Best
  Practices", "Webhooks", "OAuth 2.0 Authentication" at linear.app/developers
