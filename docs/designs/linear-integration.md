# Linear Integration Design

> **Status:** Proposed.
>
> Related documents:
> [architecture.md](architecture.md),
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
| Assign/delegate an issue to the agent               | `AgentSessionEvent created` → new session                    | P1    |
| Mention with instructions in a comment              | Same webhook, comment context                                | P1    |
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
target, marketplace/public-app distribution, per-team configuration, and a
shared multi-agent app (a Linear app _is_ one agent's identity — sharing does
not fit the model; see §4.3).

## 2. Background: Linear's agent protocol in one page

Facts this design depends on (from Linear's developer docs; verify against
[linear.app/developers/agents](https://linear.app/developers/agents) when
implementing):

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
  `{content, status: pending|inProgress|completed|canceled}`, technology
  preview) and `externalUrls` / `addedExternalUrls` (`{label, url}`).
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
  skew). Failed deliveries retry after 1 min / 1 h / 6 h, then the webhook may
  be auto-disabled.
- **Tokens.** OAuth `authorization_code` grant returns an access token
  (~24 h) plus a refresh token; refresh rotates with a 30-minute replay grace
  window. Per-app opt-in `client_credentials` tokens (30-day, app actor) also
  exist — see §15. `https://api.linear.app/graphql` is the single API
  endpoint; rate limit 5 000 requests/hour per OAuth app per workspace.

No socket/long-poll transport exists — **webhooks are the only ingress**.

## 3. Architecture

Linear is a **bot platform** (`Platform` value `'linear'`) whose _ingress_ is
relay-terminated (like Slack HTTP transport and GitHub hooks) and whose
_egress_ is daemon-direct GraphQL (like every other platform's outbound path).
The Control Plane stays off the message hot path.

```text
Linear workspace
  │  delegate / mention / follow-up / stop
  ▼
AgentSessionEvent webhook ──POST /webhooks/linear/:token──▶ relay ingress
                                    verify Linear-Signature + timestamp
                                    resolve rc/linear-assign rule
                                    │
                        rd/msg { source: 'linear' }
                                    │
                                    ▼
                                 daemon
              dedupe → ack thought ≤10 s → ACP turn
                                    │
             LinearConverger → agentActivityCreate / agentSessionUpdate
                                    │  (GraphQL, daemon-direct egress)
                                    ▼
                             api.linear.app

Control Plane: integration CRUD, OAuth install + token custody/refresh,
rc/linear-assign compilation, linearcred token broker, session metadata.
Never sees activity bodies or promptContext.
```

Precedents each leg reuses:

| Leg                                                         | Precedent                                                                                 |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Relay HTTP ingress, HMAC verify, rule table, dispatch retry | `packages/relay/src/hooks/github-ingress.ts`, `hooks/signature.ts`, `hooks/hook-table.ts` |
| CP → relay rule compilation & replay                        | `RcHookAssign` / `HookService` (`packages/control-plane/src/hooks/hook.service.ts`)       |
| Relay → daemon delivery + durable dedup                     | `rd/msg` + inbox `(sessionKey, msgId)` (`packages/protocol/src/frames/relay-daemon.ts`)   |
| Daemon platform silo (normalize / converger / apply)        | `packages/daemon/src/feishu/` (smallest complete adapter)                                 |
| Turn-scoped outbound poster w/ final-answer selection       | `packages/daemon/src/github/poster.ts`                                                    |
| Short-lived token brokered over the control WS              | `packages/protocol/src/frames/gitcred.ts` + `packages/daemon/src/cp/git-credential.ts`    |
| Durable token rotate-and-retry at the CP                    | Slack config-token rotation (`routes/slack-install.ts`)                                   |

## 4. Key decisions

### 4.1 Platform, not hook

Linear lands on the platform tables because its product hands us that shape
natively: the OAuth app _is_ the assignable identity users pick in the delegate
menu (§4.3), so each agent needs its own app — which is precisely a `Bot` row,
with `Integration` as one workspace installation of it. Those are the same
tables Slack uses. Linear therefore becomes the sixth persisted `Platform` with
its own daemon silo and converger, and its sessions render in the console as
ordinary conversations (`platform: 'linear'`, channel = issue, thread = agent
session).

The obvious follow-up — then why is GitHub on `HookDef` and not here? — has a
less obvious answer than earlier revisions of this section claimed, and it is
worth recording precisely because every _conceptual_ line once drawn between
the two seams has failed scrutiny:

- **Conversation is not the line.** An earlier revision claimed GitHub events
  are one-shot with no conversational identity; the GitHub-events work
  falsified that. GitHub hooks are `perThread` — the session key is the hook's
  immutable prefix plus the issue or pull-request number, later events resume
  the same ACP session, `@<agent-name>` addresses one agent while
  `@<app-slug>` broadcasts to the repository's matching hooks. A follow-up
  question in a thread continues the same conversation.
- **Streaming is not the line.** "Publishes once" is a point on the existing
  output-mode axis, which the daemon already reads live per dispatch; Slack
  streams through an edit loop, and Telegram/Discord differ again. The GitHub
  poster already implements the narrower Layer-2 output surface
  ([integration-plugin-architecture.md §7.6](integration-plugin-architecture.md)),
  so this is a capability difference _inside_ a contract, not a reason for a
  different seam.
- **A shared posting identity is not the line.** Every agent posts through the
  one GitHub App installation, with per-agent identity rendered inside the
  comment (avatar plus attribution footer) — but that is exactly what a Slack
  shared bot does, one app fronting many agents disambiguated per message, and
  Slack is a platform module.
- **Authorization direction is not the line either.** Both seams share one
  structure: _installation grants presence; per-event policy decides who may
  address the agent_. Chat platforms default open (anyone in the conversation)
  and our gating narrows; GitHub defaults strict (live write/admin check
  against `comment.user`) and a future policy could widen — "anyone may
  address" on a repository is the same knob as chat-side conversation gating,
  currently implemented once per seam. The strict default is threat-surface
  tuning, not structure: a public repository's audience is the whole internet
  and the agent holds repository credentials — but a public Discord server
  poses the same class of exposure and lives inside the platform contract.
- **Even the resource rows are isomorphic, not alien.** `HookDef` ≈
  `Integration` plus per-hook event-subscription filters, and one App
  installation fanning out to many hooks is the same shape as one shared `Bot`
  row fronting many `Integration` rows with per-message routing. A migration
  is feasible; it is not conceptually blocked.

What actually keeps GitHub on the hook seam today is discipline and economics,
not concept. The four platform contracts were settled from four chat
implementers; reshaping them around a fifth, non-chat implementer would be
extracting an interface from one example — the failure mode this codebase
explicitly defers on (the `CodeHostRepository` deferral in
[gitlab-com-integration.md §8.1](gitlab-com-integration.md)) — and the
migration's user-visible payoff today is nil. The convergence point is GitLab:
the §7.6 layering table already admits facet-subset implementers (the GitHub
poster ships Layer 2 with no Layer 1), so the expected end state is one module
system in which chat platforms implement the full facet set and code hosts a
subset plus facets of their own (event subscriptions, check/review
projections, repository authorization) — designed from two code hosts, not
asserted from one. GitHub does not "graduate into" a platform; the module
system learns to express it.

One consequence does not wait for GitLab: the "who may address the agent"
policy knob exists today as chat-side conversation gating and, separately, as
GitHub's write/admin gate — one policy family, implemented twice. The next
change to either should design it as the cross-platform policy it is, not
deepen it as a per-seam feature.

What Linear borrows from hooks anyway: relay-terminated signed ingress, the
in-memory assign-rule table with CP replay, delivery retry cadence, and the
daemon's durable inbox dedup. The second item is itself evidence for the
convergence above — the hook seam's assign-rule table restates platform
routing rules, and merging that duplication belongs to the same GitLab-time
consolidation.

### 4.2 Relay-terminated ingress is mandatory

Lark / Feishu chose a daemon-direct `WSClient` because the daemon must dial out.
Linear offers no such transport, so the integration **requires a configured
`PUBLIC_RELAY_URL` and at least one live relay** — the same precondition hooks
already enforce at creation time (`routes/hooks.ts` 409s without them). The
web tile for Linear is gated on relay availability _in addition to_ the
three-part daemon/CP/web capability invariant from
[feishu-integration.md §5](feishu-integration.md).

### 4.3 One Linear OAuth app per agent

In Linear, the OAuth app _is_ the assignable identity — its name and icon are
what users see in the delegate menu. "Assign it to MyAgent" therefore requires
each agent to have its own app, exactly as each Slack bot today is its own
Slack app. Linear has no app-creation API, so the user
creates the app manually in Linear settings and pastes three values into the
console (§7). A single shared app fronting many agents would collapse them
into one Linear identity and force label/keyword dispatch — rejected.

The mapping onto existing tables:

- **`Bot`** (platform `linear`) = the OAuth application. Durable identity,
  reusable after uninstall, `linearClientId` as public metadata (following
  `discordAppId`).
- **`Integration`** = one workspace installation of that app, bound to one
  agent. Installing the same app into a second workspace is a second
  integration on the same bot (`Integration.botId` is deliberately not
  unique). A Linear app has exactly **one** webhook URL, so ingress is
  bot-scoped and the verified `organizationId` selects the integration
  (§6.1).

### 4.4 Token custody: CP owns refresh, daemon gets brokered access tokens

Linear access tokens expire in ~24 h and refresh **rotates** the refresh
token. Rotating credentials need one durable writer; that is the CP with
Postgres (precedent: Slack config-token rotate-and-retry). The daemon never
holds the client secret or refresh token. Instead:

- The CP stores `{accessToken, refreshToken, expiresAt, workspaceId}` per
  integration, encrypted through the existing `SecretCipher` seam.
- `integrationToSpec` embeds the **current access token + expiry** in the
  pushed `IntegrationSpec.linear`, so `agent.json` always carries a ≤24 h
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
token; only _renewal_ touches the CP, at most ~once a day per integration.

### 4.5 Session mapping and dedup keys

- One Linear **AgentSession** ↔ one AgentConnect session.
  Local key: `linear:<channel>:<agentSessionId>:<agentId>`.
  - `channel` = Linear issue **UUID** when the session is attached to an
    issue (immutable; the human identifier `TEAM-123` changes when an issue
    moves teams, so it is display metadata only — `channelName` carries
    `TEAM-123 · <title>` and `threadUrl` the issue URL for console deep
    links). `app:mentionable` also covers documents and other editor
    surfaces, and Linear's schema makes the session's issue nullable, so a
    session **without** an issue is defined, not an error: `channel` falls
    back to the AgentSession UUID and `channelName` to the session/source
    title. Never `linear:undefined:…`. **v1 behavior for no-issue sessions:**
    after durable admission/dedup, the daemon posts one bounded `response`
    ("mention me on an issue — this surface isn't supported yet") and does
    **not** start an ACP turn; the key fallback exists so this path, and any
    future generic support, stays well-keyed.
  - `thread` = the AgentSession UUID. A second delegation or a new comment
    mention on the same issue is a new Linear session → a new AgentConnect
    session in the same channel, matching Slack's thread model.
- Follow-ups: `prompted` events carry the same `agentSession.id` → the relay
  computes the same session key → the daemon resumes the same ACP session.
- Dedup `msgId` is **content-derived**, not delivery-derived, so Linear's
  1 min/1 h/6 h redeliveries and relay-internal retries converge regardless of
  whether `Linear-Delivery` is stable across attempts:
  - `created` → `linear:<agentSessionId>:created`
  - `prompted` → `linear:<agentActivityId>`

  The daemon's durable inbox on `(sessionKey, msgId)` (same mechanism as
  hooks) absorbs duplicates.

### 4.6 Single-writer egress

Only the daemon's `LinearConnection` writes to Linear for a session — the
converger's activity stream plus the session-level updates. The agent itself
gets no Linear token in its environment and no write tool in v1 (parallel to
the GitHub single-writer rule that prevents duplicate/overwrite races). Any
later Linear read tools (§10, P2) are daemon-local builtins that use the
connection's token without exposing it, following the Slack
`getChannelInfo` pattern.

## 5. Interaction mapping: ACP stream → Agent Activities

A new `LinearConverger` (`packages/daemon/src/linear/render.ts`) follows the
converger contract (`constructor(mode)`, `onUpdate`, `hasBuffered`,
`flushBuffered`, `onFinal`) and emits a Linear-shaped IR:

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

`applyLinearAction` maps `activity` → `agentActivityCreate`, `plan` /
`external-urls` → `agentSessionUpdate`, through the per-integration send queue.

### 5.1 Event translation

Unlike Slack, Linear activities are **append-only snapshots** — there is no
message editing. The converger therefore runs in a discrete-update posture:
coalesce aggressively, post meaningfully.

| ACP update                                                               | Linear activity                                | Notes                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| turn admission (`created`)                                               | `thought` (ephemeral)                          | The ≤10 s ack, posted by the dispatch path **before** agent spawn: "Reading TEAM-123 …" — or "Queued behind the current task" when the agent is busy                                                                                                                                                |
| `agent_thought_chunk`                                                    | `thought` (ephemeral)                          | Coalesced per idle window (reuse the 2 s idle-flush timer), tail-clamped like `MAX_REASONING`                                                                                                                                                                                                       |
| `agent_message_chunk` (intermediate, flushed at a tool boundary or idle) | `thought` (non-ephemeral)                      | Progress narration between tool calls stays visible in the feed                                                                                                                                                                                                                                     |
| `tool_call` → terminal `tool_call_update`                                | `action`                                       | Emitted once at terminal status: `action` = tool title, `parameter` = input summary, `result` = head-clamped output (~2 800 chars). Consecutive same-title calls collapse; per-turn cap with a final "… and N more" thought                                                                         |
| ACP `plan` update                                                        | `plan`                                         | Both sides are full-array replace — direct mapping                                                                                                                                                                                                                                                  |
| turn end (`onFinal`)                                                     | `response`                                     | The accumulated final answer (final-answer selection reuses the `GithubReplyCollector` heuristics: `_meta.codex.phase === 'final_answer'`, else message grouping, else last text run). Attribution footer appended per `output.showFooter`, Markdown-safe via the shared fence-aware chrome helpers |
| turn failure (quota / auth / crash)                                      | `error`                                        | Reuses `turnFailureReason`/`turnFailureCode`; converger buffer flushed first so runtime-narrated errors are not duplicated                                                                                                                                                                          |
| permission gate would block the turn                                     | `elicitation`                                  | v1 posts "This step needs approval — open the session in the console" + deep link; interactive approval from Linear is out of scope (§13)                                                                                                                                                           |
| `session_info_update` (title)                                            | —                                              | Persisted locally for the console; Linear names sessions itself                                                                                                                                                                                                                                     |
| stop (`prompted` + `signal: "stop"`)                                     | `response` "Stopped — reply here to continue." | After `interruptTurn` completes; a `response` settles the Linear session state instead of leaving it `active`                                                                                                                                                                                       |

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
published rate-limiting docs). The per-integration send queue (reuse `PlatformSendQueue`) enforces FIFO plus a
minimum interval (~1 s for activities), and the converger's coalescing keeps
a busy turn to tens of activities, not hundreds. `plan` and `external-urls`
updates are debounced (last-write-wins within the idle window).

## 6. Ingress detail

### 6.1 Relay endpoint

```text
POST /webhooks/linear/:token
```

- `:token` is a **bot-scoped** capability token (`lin_<32hex>`, ≥128-bit)
  minted when the bot (= OAuth app) is created — a Linear app configures
  exactly one webhook URL, so the URL identifies the app, not a workspace
  install. Unknown token → 404 (no oracle).
- Verify `Linear-Signature` = HMAC-SHA256(raw body) with the bot's signing
  secret, timing-safe (extend `packages/relay/src/hooks/signature.ts`
  with `verifyLinearSignature` — one home so implementations cannot drift).
  Invalid → 400. Reject `webhookTimestamp` skew > 60 s.
- Route by the verified payload identity: `oauthClientId` must equal the
  bot's client id (belt-and-suspenders with the signature), then
  `organizationId` selects, among the bot's assign rules, the one whose
  `workspaceId` matches — that rule names the integration, agent, and
  daemon. A verified event from a workspace with no matching integration
  (installed but not yet connected, or removed) → 200 drop with a log
  line — never a different workspace's integration.
- Ignore non-`AgentSessionEvent` events with 200 (the user may have enabled
  broader webhook categories; also accept the `OAuthApp revoked` event and
  forward it to the CP as a revocation doorbell, following the
  `rc/github-installation` cache-invalidation pattern — mark the integration
  revoked after re-verifying against the API, never trusting the payload).
- Per-integration token-bucket rate limit (reuse `hooks/rate-limit.ts`).
- Body cap 1 MiB; `promptContext`/`previousComments` truncated to a bounded
  excerpt (32 KiB budget, `truncateUtf8` on code-point boundaries) before the
  frame is built.
- **Always return 200 after signature verification**, before daemon dispatch
  resolves. Linear's retry ladder (1 min/1 h/6 h, then auto-disable) is too
  slow and too dangerous to use as our queue; the relay runs its own dispatch
  retry cadence (`[0, 1 s, 3 s, 8 s]`, as hooks do) toward the daemon. If the
  daemon stays offline the event is dropped and the Linear session honestly
  shows unresponsive/stale (§11).

### 6.2 Rule table

The CP compiles each active Linear integration into a broadcast rule,
mirroring `RcHookAssign` semantics (empty table at relay start, full replay
after register, re-broadcast on placement change):

```ts
// packages/protocol/src/frames/relay-cp.ts
export const RcLinearAssign = z.object({
  integrationId: z.string().uuid(),
  botId: z.string().uuid(),
  agentId: z.string().uuid(),
  daemonId: z.string().uuid(), // agent's current placement
  urlToken: z.string().min(1), // bot-scoped ingress routing key (§6.1)
  signingSecret: z.string().min(1), // bot-scoped; relay-only; never logged
  linearClientId: z.string().min(1), // bot-scoped, semi-public; §6.1 oauthClientId cross-check
  workspaceId: z.string().min(1) // Linear organizationId — selects this rule
})
export const RcLinearRemove = z.object({ integrationId: z.string().uuid() })
```

`urlToken`, `signingSecret`, and `linearClientId` are bot-level values
repeated on each of the bot's rules; the relay indexes rules by token and,
within a token group, by `workspaceId`.

### 6.3 Relay → daemon frame

A new `rd/msg` variant joins the discriminated union:

```ts
// packages/protocol/src/frames/relay-daemon.ts
export const RdMsgLinear = z.object({
  source: z.literal('linear'),
  agentId: z.string().uuid(),
  integrationId: z.string().uuid(),
  sessionKey: z.string().min(1), // linear:<issueId ?? agentSessionId>:<agentSessionId>
  msgId: z.string().min(1), // §4.5 content-derived dedup key
  action: z.enum(['created', 'prompted']),
  linear: z.object({
    agentSessionId: z.string(),
    issueId: z.string().optional(), // absent for document/editor-surface sessions (§4.5)
    issueIdentifier: z.string().optional(), // "TEAM-123", display only
    issueTitle: z.string().optional(), // sanitized, ≤200 chars
    issueUrl: z.string().optional(),
    actor: z.object({ id: z.string(), name: z.string().optional() }).optional(),
    signal: z.enum(['stop']).optional(),
    // prompted: agentActivity.body (the follow-up message).
    // created via mention: the triggering comment's own text — the member's
    // instruction, extracted so it is NOT only inside fenced promptContext.
    body: z.string().optional(),
    promptContext: z.string().optional(), // created: bounded excerpt
    guidance: z.string().optional(), // created: workspace agent guidance
    previousComments: z.string().optional(), // created: bounded excerpt
    truncated: z.boolean().optional()
  })
})
```

The daemon acknowledges admission with the existing `rd/ack`.

## 7. Install flow and credential model

### 7.1 Console flow (AddIntegrationModal, two steps like `webhook`)

**Step 1 — app credentials.** The user picks the agent and pastes three
values from a Linear OAuth app they create at
_Linear Settings → API → OAuth applications_:

- Client ID (public → `Bot.linearClientId`)
- Client Secret (CP-only)
- Webhook signing secret (relay-only)

The checklist (following `FEISHU_CHECKLIST`) tells them to: name the app
after the agent and upload the agent's icon (Linear renders the app's own
branding; AgentConnect cannot push it); set the callback URL to
`<PUBLIC_CP_URL>/v1/integrations/linear/oauth/callback` (note: the deployed
public prefix is `/v1`, per the Slack-callback precedent); enable webhooks
with **Agent session events** checked; and paste the webhook URL revealed in
step 2.

Creating the integration requires `PUBLIC_RELAY_URL` + a live relay (409
otherwise). The bot-scoped `urlToken` is minted with the bot (step 1); a
second workspace install on the same bot reuses it. The integration starts
`pending`.

**Step 2 — connect the workspace.** The console reveals the webhook URL
(`https://<relay>/webhooks/linear/<token>`) for the user to paste into the
Linear app config, then offers **Connect to Linear**: an authorize URL

```text
https://linear.app/oauth/authorize?client_id=…&redirect_uri=…&response_type=code
  &scope=read,write,app:assignable,app:mentionable&actor=app&state=<nonce>
```

with a one-shot `state` nonce (mirroring `GithubInstallState`). The CP
callback exchanges the code at `https://api.linear.app/oauth/token`, queries
`viewer { id organization { id name } }` to learn `workspaceId` and the app
user id, persists the token row, flips the integration `active`, and
broadcasts `rc/linear-assign` + `integration/upsert`. The token exchange
doubles as credential verification — there is no separate `verifyLinearBot`
probe (unlike Lark / Feishu, the client secret cannot be validated without OAuth).

### 7.2 Storage

| Value                                                                 | Where                                                                         | Visibility                                                                              |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Client ID                                                             | `Bot.linearClientId` (public metadata column)                                 | console, authorize URL                                                                  |
| Client Secret                                                         | `BotSecret.botToken`                                                          | CP only (code exchange + refresh)                                                       |
| Webhook signing secret                                                | `BotSecret.signingSecret`                                                     | relay only, via `rc/linear-assign` (existing column; already relay-only for Slack http) |
| Access + refresh token, expiry, workspaceId, workspaceName, appUserId | new `linear_token` table, 1:1 with Integration, values through `SecretCipher` | access token → daemon (spec + broker); refresh token → CP only                          |

The `IntegrationSpec.linear` pushed to the daemon:

```ts
// packages/protocol/src/frames/integration.ts
export const IntegrationLinearConfig = z.object({
  workspaceId: z.string(),
  workspaceName: z.string().optional(),
  appUserId: z.string().optional(), // the app's Linear user id (self-echo guard)
  accessToken: z.string(), // ≤24 h snapshot; refreshed via linearcred
  accessTokenExpiresAt: z.string().datetime()
})
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

CP handler: placement scope check (`agent.daemonId === conn.daemonId`, as
gitcred does), single-flight refresh when the stored token is near expiry,
durable persist of the rotated pair **before** replying, then also re-push
the integration spec so `agent.json` converges.

### 7.4 Uninstall / revocation

`DELETE /integrations/:id` revokes the token at Linear
(`POST /oauth/revoke`, best-effort), deletes the `linear_token` row,
broadcasts `rc/linear-remove` + `integration/remove`, and frees the bot for
reuse — matching existing uninstall semantics. The `OAuthApp revoked`
doorbell (§6.1) converges the same state when revocation originates on the
Linear side.

## 8. Prompt assembly and trust boundary

`buildLinearMessage` (new `packages/daemon/src/messages/linear-message.ts`,
shaped after `hook-message.ts`) synthesizes the `NormalizedMessage`:

- `platform: 'linear'`, `source: 'user'`, `trigger: 'mention'`,
  `sender.id = linear:<actorId>`, `isDm: false`, `headless: false` (the
  session has a live reply surface — the activity feed).
- **Trusted header** (daemon-authored): `Linear TEAM-123 "title" — delegated
by <actor>` + issue URL, with `sanitizeTitle` flattening.
- **Instruction text**: for `prompted`, the user's `agentActivity.body`
  verbatim — workspace members are the same trust class as Slack users, and
  their messages are instructions. For `created`, the instructions are the
  delegation line, **the triggering comment's own text** when the session was
  started by a mention (`@Agent fix X` is the member's directive — the relay
  extracts it into `linear.body`, bounded, so it never lives only inside the
  fenced context), and `guidance` (workspace-admin-authored).
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

## 9. Change inventory by layer

Following the [feishu-integration.md §4](feishu-integration.md) template;
`[enum]` marks every enumeration site. Linear's capability gate is
**four-part**: daemon `capabilities().platforms`, CP availability check, web
tile filter, **plus** relay presence (`PUBLIC_RELAY_URL` + live relay).

### 9.1 `packages/protocol`

- `frames/route.ts` — `[enum]` `Platform` += `'linear'`.
- `frames/integration.ts` — `IntegrationLinearConfig` (§7.2) + `[enum]`
  `IntegrationSpec` union branch.
- `frames/relay-daemon.ts` — `RdMsgLinear` (§6.3) into the `RdMsg` union;
  `[enum]` `WireNormalizedMessage.platform` and the three agentmsg coord
  enums stay in lockstep with `NormalizedMessage`.
- `frames/relay-cp.ts` — `RcLinearAssign` / `RcLinearRemove` (§6.2) +
  registration.
- `frames/linearcred.ts` — broker REQ/RES (§7.3).
- `frames/cron.ts` — **not** extended in v1 (no cron target).
- `codec.test.ts` round-trips for every new frame.

### 9.2 `packages/control-plane`

- Prisma: `[enum]` `enum Platform` += `linear` (migration `ALTER TYPE … ADD
VALUE`), `Bot.linearClientId String?`, `Bot.linearUrlToken String? @unique`
  (bot-scoped ingress token, §6.1), new `linear_token` and
  `linear_install_state` tables; `prisma:generate`.
- `persistence/platform.ts` — pass `'linear'` through `toDbPlatform`.
- `routes/integrations.ts` — `linear` create branch (mints the bot-scoped
  urlToken with a new bot, 409s without relay). Note: the existing create
  route caps a non-`shareable` bot at one integration; for Linear that cap
  becomes **one integration per (bot, workspace)** — same-bot installs into
  distinct workspaces are allowed without the Slack `shareable` semantics.
  `routes/linear-install.ts` — authorize-URL endpoint + public OAuth
  callback (mounted under the public `/v1` prefix alias, per the Slack
  callback precedent).
- `dto/index.ts` — `[enum]` `CreateIntegrationBody.platform`, `linear:
z.object({ clientId, clientSecret, signingSecret })` block + both
  `superRefine` guards; `IntegrationDto` gains `linear` status fields
  (workspaceName, connected).
- `http/daemon-platform-capability.ts` — `[enum]` += `'linear'`, plus the
  relay-presence check for this platform.
- New `linear/` service dir: `LinearAssignService` (compile/broadcast/replay,
  mirroring `HookService`), `LinearTokenService` (exchange, single-flight
  rotate-and-retry refresh, revoke), OAuth client.
- `orchestrator/placement.ts#integrationToSpec` — `linear` branch embedding
  the token snapshot.
- WS: `linearcred` handler; revocation doorbell handler.
- OpenAPI: tags/summary/operationId on every new route.
- Tests: DTO guards unit; integration-route + OAuth callback + broker
  integration tests with a fake Linear token endpoint.

### 9.3 `packages/relay`

- New `src/linear-ingress.ts` (§6.1) registered when any rule exists;
  `hooks/signature.ts#verifyLinearSignature`; rule table keyed by urlToken
  (reuse `HookTable` shape); dispatch retry identical to hooks.
- `relay-cp-client.ts` — handle `rc/linear-assign` / `rc/linear-remove` +
  replay-on-register.

### 9.4 `packages/daemon`

- New `src/linear/` silo:
  - `connection.ts` — `LinearConnection` per integration: GraphQL client
    (plain `fetch` against `api.linear.app/graphql`; the `@linear/sdk`
    dependency is optional — the agent surface is four mutations and two
    queries), token cache + `linearcred` renewal, send queue,
    `createActivity`, `updateSession`, `resolveTeamStates`,
    `moveIssueToStarted` (P2), `stop()`/`start()` (no socket — start warms
    the token). Self-echo guard on `appUserId`.
  - `normalize.ts` — `RdMsgLinear` → `NormalizedMessage` (§8), stop-signal
    short-circuit to `interruptTurn`.
  - `render.ts` — `LinearConverger` + `LinearAction` (§5).
- `daemon.ts` touchpoints (the ~40-site checklist from Lark / Feishu): conns map by
  integrationId, `reconcileLinearConnections()` at the three call sites,
  `applyLinearAction` in `enqueueApply`, converger construction branch,
  `replyConnFor`/`connForIntegration` union widening, ≤10 s ack in the
  relay-msg admission path, `[enum]` `capabilities().platforms` += `'linear'`,
  shutdown.
- `messages/normalized.ts` — `[enum]` platform union += `'linear'`.
- `messages/linear-message.ts` (§8).
- `router/routing-rule.ts` — Linear branch (trivial: relay delivery is
  pre-attributed with explicit `agentId`, so no arbitration ladder;
  mirrors the hook path).
- `agents/agent-schema.ts` — `[enum]` `IntegrationSchema` union +
  `write-integration.ts` branch.
- `handleRelayMsg` — route `source: 'linear'`.
- Session metadata: `channelName`/`threadUrl` from issue identifier/URL.
- Tests: `linear-normalize.test.ts`, `linear-render.test.ts` (converger
  translation table, coalescing, no-response ack-only), dedup-before-ack
  ordering unit.

### 9.5 `packages/web`

- `components/marks.tsx#PlatformMark` — Linear brand SVG.
- `AddIntegrationModal.tsx` — `linear` in `BOT_PLATFORMS`, two-step flow
  (§7.1), `CREATE_DESC.linear`, `LINEAR_CHECKLIST`, availability =
  daemon capability ∧ relay present.
- `SettingsView.tsx` — Bots card tab.
- `AgentDetailView.tsx` — Integrations card row (workspace name, connect
  status, re-connect action when `pending`/token-revoked).
- `lib/api.ts` — `CreateIntegrationInput` union + `linear` DTO fields;
  `lib/data.ts#sessionPlatform` + session filters; `lib/data-context.tsx`
  mock rows.

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
6. **Signing-secret rotation** = paste the new secret in the console (bot
   secret update → recompile → `rc/linear-assign` re-broadcast). No dual-key
   window in v1; rotation races drop deliveries for seconds, recovered by
   Linear's retry ladder (the one case where we _want_ the non-200: an
   unverifiable delivery returns 400 and Linear retries).

## 11. Failure and degradation semantics

| Failure                                                     | Behavior                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CP down, daemon up                                          | Established sessions keep streaming (cached/spec token, ≤24 h). New `created`/`prompted` events still flow (relay rules are in relay memory; delivery is relay→daemon). Token renewal and install/uninstall stall.                                                                                                                                                         |
| Daemon offline                                              | Relay retries `[0, 1 s, 3 s, 8 s]`, then drops; the Linear session shows unresponsive/stale — an honest signal, surfaced in the console alongside daemon health. A CP-posted failure activity was considered and **rejected**: the CP performing provider egress would create a second Linear writer and put it on the message path, violating the architecture invariant. |
| All relays down                                             | Linear gets timeouts/5xx → its retry ladder (1 min/1 h/6 h) redelivers after recovery; content-derived dedup absorbs replays. Repeated failure risks Linear auto-disabling the webhook — surface `lastDeliveryAt` staleness in the console.                                                                                                                                |
| Token refresh fails (secret rotated at Linear, app deleted) | Broker returns terminal error; daemon posts `error` activity while its cached token lasts, else goes silent; integration flips `error` in the console with a re-connect CTA.                                                                                                                                                                                               |
| Linear API down                                             | Egress-queue retries with backoff; activities are droppable chrome (the transcript is authoritative); the final `response` retries hardest (bounded, like `GithubFinalPoster`'s 15 s finalize budget).                                                                                                                                                                     |
| Duplicate webhook delivery                                  | Daemon inbox dedup (§4.5).                                                                                                                                                                                                                                                                                                                                                 |
| Workspace admin revokes the app                             | `OAuthApp revoked` doorbell → verify → integration `revoked`, rules removed.                                                                                                                                                                                                                                                                                               |

## 12. Security checklist

- Signing secret: relay-only; never in daemon specs, logs, or DTOs. Client
  secret: CP-only. Refresh token: CP-only, `SecretCipher`-encrypted. Access
  token: daemon memory + `agent.json` (≤24 h lifetime).
- HMAC verified timing-safe over raw bytes before any parsing side effects;
  `webhookTimestamp` replay window; verified `organizationId` selects the
  integration within the bot's token group (unmatched workspace → drop);
  capability-URL token ≥128-bit, 404 on unknown.
- Event bodies never transit or persist at the CP (activity bodies flow
  daemon → Linear only; CP stores session metadata, not content).
- Untrusted-content fencing for issue-derived text (§8); sanitized trusted
  header; delimiter neutralization.
- Agent environment contains no Linear credentials; all writes go through
  the daemon-owned single writer (§4.6).
- OAuth `state` one-shot nonces; callback exchanges bind to the pending
  integration id.
- Rate limits both directions (ingress bucket per integration; egress queue).

## 13. Phasing

- **P1 — the core loop.** Protocol frames + enums; CP schema, create/OAuth/
  callback routes, assign compiler, token service + broker; relay ingress;
  daemon silo with ack, converger (`thought`/`action`/`response`/`error`),
  follow-ups, stop; web install flow, marks, session display. Exit criteria:
  delegate an issue → acknowledged ≤10 s → streamed activities → response;
  reply and stop work; sessions render in the console.
- **P2 — workflow polish.** Plan sync; `externalUrls` (PR + console links);
  issue auto-start transition; daemon-local Linear read tool (bounded
  `getIssue`/comments via the connection token); elicitation deep-link card.
- **P3 — breadth.** Label → skill playbook mapping; proactive sessions
  (`agentSessionCreateOnIssue`) as a cron/sendMessage target (adds the cron
  `[enum]`); `issueRepositorySuggestions` for multi-repo agents; interactive
  permission approval over activities; multi-workspace install UX.

## 14. Tests

- **Protocol:** codec round-trips for `RdMsgLinear`, `RcLinearAssign/Remove`,
  `linearcred/*`, `IntegrationLinearConfig`.
- **Relay unit:** signature/timestamp verification vectors, workspace →
  integration routing within a token group (incl. verified-but-unmatched
  workspace → 200 drop, and `oauthClientId` ≠ rule `linearClientId` → drop),
  truncation budgets, rule replay, retry cadence, 200-after-verify ordering.
- **Daemon unit:** normalize (created/prompted/stop, mention-comment `body`
  extraction, no-issue created event → session-UUID channel + bounded
  unsupported-surface `response` with **no ACP turn**), converger
  translation table per mode, coalescing caps, no-response **ack-only**
  (nothing posted after the pre-spawn ack; `none` mode remains
  zero-activity since it never acks), dedup-key derivation,
  **dedup-before-ack ordering including concurrent same-`msgId` deliveries
  collapsing to one ack** (fake clock).
- **CP unit:** DTO `superRefine` guards; token service rotate-and-retry with
  a failing-then-succeeding fake token endpoint; single-flight refresh.
- **CP integration:** migration; create → pending → callback → active
  lifecycle against a stubbed Linear OAuth server; broker scope denial for a
  foreign daemon; uninstall/revocation convergence.
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
3. **Plan API stability** — Linear marks it technology preview; P2 should
   feature-flag plan sync per integration.
4. **`client_credentials` tokens** (30-day, per-app opt-in) are documented as
   app actors, so they could replace the refresh machinery for the app's home
   workspace. Open: whether they work for workspaces the app was installed
   into via OAuth (multi-workspace still needs `authorization_code`), and
   whether a 30-day non-rotating token is an acceptable custody trade-off.
   Evaluate before P2; the broker seam (§7.3) is unchanged either way.

## References

- Linear — "Getting Started" (agents), "Agent Interaction", "Interaction Best
  Practices", "Webhooks", "OAuth 2.0 Authentication" at linear.app/developers
