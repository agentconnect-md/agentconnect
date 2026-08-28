# Linear Integration Design

> **Status:** Proposed. Revised 2026-08 against the shipped
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
> GitHub-App model. An issue behaves like a channel with several agents bound
> to it: delegation reaches the workspace's default agent, `@<agent-name>` in
> the mention text addresses a specific one (GitHub-events semantics), and
> per-agent identity renders as in-content attribution (§4.3, §5).
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

| Linear agent experience                             | This design                                                  | Phase |
| --------------------------------------------------- | ------------------------------------------------------------ | ----- |
| Assign/delegate an issue to the app                 | `AgentSessionEvent created` → session with the default agent | P1    |
| Address a specific agent with instructions          | Same webhook; `@<agent-name>` in the mention text routes     | P1    |
| Instant acknowledgement in the feed                 | Daemon-side auto-ack `thought` before the turn starts        | P1    |
| Real-time activity feed (commands, files, progress) | `LinearConverger` → `agentActivityCreate`                    | P1    |
| Follow-up messages in the session thread            | `prompted` → same AgentConnect session                       | P1    |
| Stop signal puts the agent to sleep                 | `prompted` + `signal:"stop"` → `interruptTurn`               | P1    |
| Link to the agent's own session view                | `externalUrls` → console session deep link                   | P1    |
| Todo list synced to Linear's plan UI                | ACP `plan` updates → `agentSessionUpdate.plan`               | P2    |
| PR URL attached to the session                      | Detected PR links → `addedExternalUrls`                      | P2    |
| Moves the issue into a started status               | Workflow-state transition on delegation (config toggle)      | P2    |
| Playbook labels (`!plan`, `!implement`, …)          | Label → skill/prompt-preset mapping                          | P3    |
| Repo suggestions for multi-repo orgs                | `issueRepositorySuggestions`                                 | P3    |
| Linear-side automation triggers delegate issues     | Free — automation delegation raises the same `created` event | P1    |

**Non-goals for v1:** working document/project mentions without an attached
issue (they receive a bounded unsupported-surface response, §4.5 — never a
crash or silence),
proactive session creation (`agentSessionCreateOnIssue`) as a cron/sendMessage
target, marketplace/public-app distribution, per-team configuration (default
agents are per workspace; a per-team mapping is P3), and **dedicated
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
  body, keyed by the OAuth app's **webhook signing secret**), and a
  `webhookTimestamp` field to bound replay (docs recommend rejecting > 60 s
  skew). Payloads carry `organizationId` (the workspace) and the app's
  `oauthClientId`. Failed deliveries retry after 1 min / 1 h / 6 h, then the
  webhook may be auto-disabled.
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
whose members are the enabled agents. The Control Plane stays off the
message hot path.

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
Its sessions are conversations (channel = issue, thread = agent session) with
follow-ups and a streaming reply surface. Linear therefore implements all four
platform contracts and renders in the console as ordinary conversations
(`platform: 'linear'`).

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
  precedent). The workspace records a **default agent** among its members —
  a durable choice, which is why it rides the generic persisted preferred
  default of §9.2 (the orchestrator's compile today has no such input and
  falls back to the earliest non-gated member) rather than anything the
  provider could smuggle through its opaque assign bags.
- The cross-org `workspaceClaim` fence refuses a workspace another
  organization already holds — every workspace's events verify against the
  same deployment signing secret, so the tenant composite is the only thing
  standing between two organizations' attributions.

**Trigger model — GitHub-events semantics.** An issue behaves like a channel
with several agents bound to it:

- **Delegating an issue to the app** (no text) starts a session with the
  workspace's **default agent**. Linear-side automations that auto-delegate
  land here too.
- **Mentioning the app with text** starts a session with the agent the text
  names — `@<agent-name>` anywhere in the instruction, matched against the
  workspace's enabled members, exactly as a GitHub comment addresses one
  agent by name inside a thread the App owns. The name is plain text (agents
  are not Linear entities; only the app is mentionable), matched by
  the per-member keyword routes the HTTP-bot orchestrator's compile
  **already emits** — one unscoped `{ kind: 'keyword', value: agent.name }`
  rule per placed non-gated member (§6.2) — with `defaultAgentId` as the
  fallback.
- **One AgentSession binds to one agent at creation** and never changes
  hands: follow-ups and stop go to that agent. Addressing a _different_
  agent is a new mention on the issue → a new session → another thread in
  the same channel. Naming several agents in one mention selects the first;
  Linear mints exactly one session per mention, so there is nothing to
  broadcast to (unlike GitHub's `@app-slug` fan-out).
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
  - `channel` = Linear issue **UUID** when the session is attached to an
    issue (immutable; the human identifier `TEAM-123` changes when an issue
    moves teams, so it is display metadata only — session `channelName`
    carries `TEAM-123 · <title>` and the normalized message's `threadUrl`
    carries the issue URL for console deep links). `app:mentionable` also
    covers documents and other editor surfaces, and Linear's schema makes the
    session's issue nullable, so a session **without** an issue is defined,
    not an error: `channel` falls back to the AgentSession UUID and
    `channelName` to the session/source title. Never `linear:undefined:…`.
    **v1 behavior for no-issue sessions:** after durable admission/dedup, the
    daemon posts one bounded `response` ("mention me on an issue — this
    surface isn't supported yet") and does **not** start an ACP turn; the key
    fallback exists so this path, and any future generic support, stays
    well-keyed.
  - `thread` = the AgentSession UUID. A second delegation or a new comment
    mention on the same issue is a new Linear session → a new AgentConnect
    session in the same channel, matching Slack's thread model — and the
    natural way to bring a **different agent** onto the same issue (§4.3):
    each session is bound to one agent at creation and never changes hands.
  - The relay computes its session key from `(channel, thread)` exactly as it
    does for every shared bot; the daemon's local key adds the agent id as
    usual.
- Follow-ups: `prompted` events carry the same `agentSession.id` → the same
  coordinates → the daemon resumes the same ACP session.
- Dedup `msgId` is **content-derived**, not delivery-derived, so Linear's
  1 min/1 h/6 h redeliveries and relay-internal retries converge regardless of
  whether `Linear-Delivery` is stable across attempts:
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
  seams with) and the `webhookTimestamp` 60 s window on the host clock, and
  returns the typed parsed `AgentSessionEvent` — parsed exactly once.
- **`handle`**:
  - `created` / `prompted` → a `WireNormalizedMessage` (§6.3) through
    `host.forward(botId, msg)`. Relay-core arbitration resolves the target
    with the ladder it already runs for shared bots: `prompted` follows the
    session's thread affinity (the session's bound agent); a `created` from
    a mention matches the per-member **name routes** the shipped HTTP-bot
    compile already emits for every placed non-gated member
    (`@<agent-name>` in the text, §4.3/§6.2); anything
    else — bare delegation, automation delegation, no name matched — falls
    to `defaultAgentId`. Every event is explicitly addressed by
    construction.
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
// secrets bag — relay-only material
{ signingSecret }
// ingress bag — demux identity + self-echo metadata
{ clientId, organizationId, appUserId? }
```

The signing secret is the deployment app's (§7.1), stamped into each
workspace bot's secret row at connect; the client secret and the refresh
token never reach the relay. Everything else on the frame stays
core-assembled as for every platform — and for Linear the shared-bot members
are doing real work: `members`/`agents` list the workspace's enabled agents,
`routes` carries the per-member name rules (§6.1), `defaultAgentId` the
workspace default, and `credentialRevision` fences signing-secret rotation
(§10.6). Routing is assembled by the HTTP-bot orchestrator's core compile —
`projectBotAssign` deliberately carries **no routing**, only the two opaque
bags — and that compile **already emits the member-name rules Linear
needs**: one unscoped `{ kind: 'keyword', value: agent.name }` route per
placed non-gated member (its keyword-disambiguation loop), which is exactly
the `@<agent-name>` path, reused with zero new code. The one input the
compiler lacks is the default: it derives `defaultAgentId` as the earliest
non-gated member, so the bot row gains a generic **persisted preferred
default** it prefers when set and still routable (§9.2). The
earlier revision's `RcLinearAssign` / `RcLinearRemove` frames and the
relay-local Linear rule table are gone — replay-on-register, placement
re-broadcast, and lifecycle edges are the shared machinery.

### 6.3 Relay → daemon frames: `im` + `platform_action`

No new `rd/msg` union member. Events ride `RdMsgIm` with a
`WireNormalizedMessage`:

- `platform: 'linear'`, `channel` = issue UUID (or session UUID fallback,
  §4.5), `thread` = AgentSession UUID, `threadUrl` = issue URL,
  `sender.id = linear:<actorId>`, `isDm: false`.
- `text` = the member's instruction — the delegation line, the triggering
  comment's own text for a mention-created session (extracted so it is
  **never only inside fenced context**), or the follow-up
  `agentActivity.body` verbatim.
- `adapterExt.linear` = `{ agentSessionId, issueIdentifier?, issueTitle?,
promptContext?, guidance?, previousComments?, truncated? }` — the §6.4
  adapter-extension bag: opaque to core, round-tripped to the daemon's linear
  module, which owns fencing and prompt assembly (§8).

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

**Once per workspace — connect it (org console).** An org admin picks
**Connect Linear**, chooses the workspace's **default agent**, and is sent
to

```text
https://linear.app/oauth/authorize?client_id=…&redirect_uri=…&response_type=code
  &scope=read,write,app:assignable,app:mentionable&actor=app&state=<nonce>
```

with a one-shot `state` nonce persisted in `linear_install_state`
(TTL-reaped via `pendingInstalls`; it carries the nonce, the initiating
org/user, and the chosen default agent — **no secrets**, unlike the earlier
per-agent revision's funnel). Core's relay-availability 409 applies at
funnel start. **No Bot or Integration row exists before the callback**:
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
   for the chosen default agent (`active` from birth) is written; and the
   tail's normal `syncBot` hand-off broadcasts `rc/bot-assign` +
   `integration/upsert`.
   `projectIntegrationConfig` resolves the token by the bot's D6 identity —
   already durable from step 1, so the ordering is guaranteed by
   construction rather than by a transaction the tail does not offer.

**Per agent — enable it on the workspace.** Adding an agent is one more
member Integration on the workspace bot (the generic existing-bot path — no
reuse fence exists or is needed under this model); the workspace card also
moves the default among members (persisted, §9.2 — the compiler's
earliest-member fallback alone cannot honor a choice). Every enabled agent's
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
- **Delete locally, unconditionally:** the row is dead weight in its
  organization regardless of who else holds the identity.
- **Revoke upstream only when no organization's Bot holds the identity
  globally:** the same Linear app + workspace backs the winner's live
  install, so a loser-initiated `POST /oauth/revoke` would tear it down.

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
| `state` nonce + default agent, pre-connect  | provider-owned `linear_install_state` funnel table (TTL-reaped; carries no secrets)                                                             | CP only                                                         |

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
the placement scope check (`agent.daemonId === conn.daemonId`); the
provider's token service owns the work: single-flight refresh when the stored
token is near expiry, durable persist of the rotated pair **before**
replying, then a spec re-push so `agent.json` converges.

### 7.4 Membership, disconnect, revocation

Three distinct lifecycle edges, because the token rides the connection
identity (§4.4), not any agent binding:

- **Remove an agent** — `DELETE /integrations/:id` drops one member from the
  workspace bot (standard broadcast: assign rebuild + `integration/remove`)
  and touches nothing else; its keyword route disappears, the workspace and
  its token stay live. Removing the default agent requires naming a new
  default first (or the workspace card blocks it) — a workspace with members
  but no default would strand bare delegations.
- **Disconnect the workspace** — deleting the **Bot** is the real teardown:
  best-effort `POST /oauth/revoke` at Linear plus deletion of the identity's
  `linear_token` row. The shipped `CpPlatformProvider` has no bot-delete
  lifecycle member, so this design adds one:
  `sideEffects.onBotDelete?(bot, secrets)` — best-effort by contract like
  `postCreate`, called from core's bot-delete path for any platform that
  declares it.
- **Dead token** (refresh rejected, app secret rotated, workspace revoked
  upstream) — the workspace connection flips `error` with a **Reconnect**
  CTA: the org-scoped reconnect route restarts the OAuth funnel against the
  existing bot, and the callback's step-1 upsert (§7.1) replaces the
  `linear_token` row in place. The `OAuthApp revoked` doorbell (§6.1)
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
- `platform-manifest.ts` — Linear becomes a manifest row, and it is
  **earned**: multi-agent sharing is gated today by a core interim predicate
  (`control-plane/src/platforms/sharing.ts#supportsMultiAgentBots`,
  Slack-only — without a change here, `validateShareableInstall` refuses a
  second Linear member before `addBotMembership` runs), and that module's
  own doc names the §5 `multiAgentShareable` manifest field as its
  replacement once a second platform needs it. Linear is that second
  platform, so the field lands with the rows it needs (`slack: true`,
  `linear: true`; `DEFAULT_MANIFEST` stays `false`) and retires the
  predicate at its two call sites — an install-time, pre-dispatch read, per
  the manifest's own rule. Every other axis keeps the fail-closed defaults
  (observed membership, no bot-sender routing, conversation-granularity
  leave).
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
  - `installRoutes('org')` — connect-workspace funnel start (records the
    chosen default agent), connect status, reconnect (§7.4), member/default
    management for the workspace card;
    `installRoutes('public-callback')` — the OAuth callback (§7.1). Repo
    OpenAPI conventions on every route.
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
  - **One generic core change**: a persisted bot-level **preferred default
    agent** (nullable), preferred by the orchestrator's compile over its
    earliest-non-gated fallback and settable from the workspace card —
    platform-free (Slack shared bots gain the same knob), and the only way
    "move the default" can actually move bare delegations (§6.2).
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
    resolves the issue, `getUserProfile` the Linear user — and returns
    empty/`null` elsewhere (no `listBotChannels`, no `leaveChannel`,
    `downloadFile` deferred).
  - `turn-output.ts` — the streaming Layer-2 surface + `LinearConverger` +
    `LinearAction` (§5).
  - message strategy — `adapterExt.linear` → prompt assembly and fencing
    (§8); no-issue unsupported-surface response (§4.5); stop decoder for the
    `platform_action` payload → `interruptTurn` + settling response.
  - The ≤10 s ack at `rd/msg` admission, after inbox dedup (§10.1).
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
- Session metadata: `channelName`/`threadUrl` from issue identifier/URL.
- Tests: normalize (created/prompted/stop, mention-comment `text`
  extraction, no-issue created event → session-UUID channel + bounded
  unsupported-surface `response` with **no ACP turn**), converger
  translation table per mode, coalescing caps, no-response **ack-only**
  (nothing posted after the pre-spawn ack; `none` mode remains
  zero-activity since it never acks), dedup-key derivation,
  **dedup-before-ack ordering including concurrent same-`msgId` deliveries
  collapsing to one ack** (fake clock).

### 9.5 `packages/web`

- `src/components/console/platforms/linear/` implementing
  `WebPlatformModule` + one `registry.ts` line:
  - `Mark` — Linear brand SVG (60 % box, `fillPct` convention).
  - `wizard` — for an agent, "enable on a connected workspace": the
    connected-workspace bots are the existing-bot list (`freeBotFilter`
    offers any of the org's connected workspaces, `buildReuseInput` adds the
    agent as a member — unfenced, §7.4), with a "connect a workspace first"
    hand-off to the org-level connect flow when none exists. Tile
    availability = daemon capability ∧ `relayCapability.available` ∧ the
    deployment app being configured.
  - `apiBindings` — connect-funnel, connect-status, reconnect, and
    member/default management calls.
  - `settingsFragments` — the workspace card: workspace name, connect
    status, member agents + default, reconnect action when the token is
    dead (§7.4).
  - `channelList` — `roomNoun: 'issue'`, no leave affordance.
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
2. **Issue status transition (P2)** follows Linear's best practice: on a
   delegated `created`, if the issue is not in a `started/completed/canceled`
   state, move it to the team's lowest-position `started` state — behind an
   integration-level toggle (default on), skipped for triage-status issues so
   Linear-side automation delegations keep human triage.
3. **PR links (P2).** The daemon already computes PR/commit links for GitHub
   attribution; a turn-scoped URL collector feeds `addedExternalUrls`
   (label `PR #123`), alongside the console session link added at session
   start.
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
  (Setup Server document + `envSchema` slice); CP provider (connect funnel +
  callback, member/default management, token service + broker, projectors,
  the persisted preferred default, the `onBotDelete` contract extension) +
  registry
  line; relay ingress plugin + registry line; daemon module (connection,
  ack with agent attribution, converger
  `thought`/`action`/`response`/`error`, follow-ups, stop, config schema) +
  the §9.4 composition lines; web module (workspace connect + agent enable,
  mark, settings, session display) + registry line. Exit criteria: delegate
  an issue → default agent acknowledges ≤10 s (named in the ack) → streamed
  activities → response; `@<agent-name>` routes to the named member; reply
  and stop work; sessions render in the console.
- **P2 — workflow polish.** Plan sync; `externalUrls` (PR + console links);
  issue auto-start transition; daemon-local Linear read tool (bounded
  `getIssue`/comments via the connection token); elicitation deep-link card.
- **P3 — breadth.** Label → skill playbook mapping; per-team default-agent
  mapping (the delegation-granularity upgrade §4.3 defers); proactive
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
- **Daemon unit:** normalize (created/prompted/stop, mention-comment `text`
  extraction, no-issue created event → session-UUID channel + bounded
  unsupported-surface `response` with **no ACP turn**), converger
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
  touching the token; the compile prefers the persisted default over the
  earliest member; removing the default
  agent is blocked until a new default is named; reconnect replaces a dead
  token in place; broker scope denial for a foreign daemon; workspace
  disconnect (bot delete) revoke convergence.
- **Live checklist:** real OAuth app in a scratch Linear workspace —
  delegate, mention, follow-up, stop, redelivery replay (Linear's webhook
  console), token refresh across the 24 h boundary, workspace revoke.

## 15. Open questions

1. **`action` result delivery** — whether Linear renders a second
   `agentActivityCreate` as an update to the prior action or as a new row;
   affects whether we emit actions at start or only at terminal status.
   Resolve against the live API during P1 (design assumes terminal-only).
2. **`prompted` after `complete`** — whether Linear reopens the session or
   requires a new one; determines resume behavior after the stop `response`.
3. **Plan API stability** — Linear still marks it technology preview; P2
   should feature-flag plan sync per integration.
4. **`client_credentials` tokens** (30-day, per-app opt-in) are documented as
   app actors, so they could replace the refresh machinery for the app's home
   workspace. Open: whether they work for workspaces the app was installed
   into via OAuth (multi-workspace still needs `authorization_code`), and
   whether a 30-day non-rotating token is an acceptable custody trade-off.
   Evaluate before P2; the broker seam (§7.3) is unchanged either way.

## References

- Linear — "Getting Started" (agents), "Agent Interaction", "Interaction Best
  Practices", "Webhooks", "OAuth 2.0 Authentication" at linear.app/developers
