# Slack Approval DM

> **Status:** Proposed (issue
> [#1648](https://github.com/agentconnect-md/agentconnect/issues/1648)).
> Nothing here is implemented yet; file/line references describe the shipped
> machinery this design composes.
>
> **Scope:** protocol + control-plane + daemon + web. Slack only — it is the
> one platform with a linked-identity **assertion** (see §4.4) and the one
> platform with DM-capable read ports today.
>
> Related documents:
> [slack-identity.md](slack-identity.md),
> [session-visibility.md](session-visibility.md) (§7 identity linking),
> [resource-visibility.md](resource-visibility.md),
> [shared-bot-relay.md](shared-bot-relay.md),
> [linear-integration.md](linear-integration.md) (the "open the console"
> fallback this design upgrades from).

## 1. Background and goal

When an ACP runtime asks `session/request_permission` (or Codex maps an MCP
tool approval onto `elicitation/create`), the daemon's
`PermissionCoordinator` resolves it on one of two paths:

- **Chat path** — only when the agent opts in
  (`allowRuntimeChangesInChat`) _and_ the session lives on Slack: an
  interactive card with one button per ACP option is posted **into the
  session's own conversation** (`awaitChatPermission`,
  `packages/daemon/src/permissions/coordinator.ts`). Anyone who can see the
  conversation can click it — which is exactly why it is opt-in.
- **Editor path** — the default: the ACP promise is parked, a durable row
  lands in the daemon's `permission_requests` table
  (`packages/daemon/src/store/local-store.ts`), and chat gets only a notice:
  _"🔒 Permission requested. Ask an Agent editor to allow it from the Agent
  or Session page."_ The console polls
  `GET /orgs/:org/agents/:id/permission-requests` (the CP proxies to the
  owning daemon and persists nothing) and an agent **editor** decides from
  the Agent or Session page.

The editor path is safe but silent: no human is told _personally_ that an
approval is waiting. If the editor is not watching the console, the turn
hangs until someone wanders by.

**Goal:** when an approval enters the editor path, the daemon additionally
**DMs one specific human on Slack** — a person who (a) is authorized to
decide (can edit the agent) and (b) has proven the Slack account is theirs
(linked identity). The DM carries the approval card, a console session deep
link, and — when the triggering message came from Slack — a permalink to it.
The approval itself keeps living on the web exactly as today; the console's
notification bell learns to show it as unread while pending and as read
("_name_ approved / declined") once resolved.

Non-goals: replacing the in-conversation chat card (it stays, unchanged
behind its opt-in), a server-side notification store (§8), any platform
other than Slack (§10), and a reverse Slack→console identity index (§4.4).

## 2. The trust model — why a DM is the editor path, not the chat path

The in-conversation card is gated by `allowRuntimeChangesInChat` because it
performs **no per-user authorization**: any conversation participant can
click it. The DM card is the opposite: its recipient is chosen by the same
`canEdit` predicate the console decision route enforces
(`packages/control-plane/src/http/routes/agents.ts`), and the Slack account
is bound to that console user by a Logto assertion (a Slack OIDC sign-in or
an Account API link under the user's own session — never an email guess).

So the DM surface is **the editor path delivered over Slack**, and:

- it is **not** gated by `allowRuntimeChangesInChat`;
- a click on a DM card is honored only when the acting Slack user **is the
  DM's addressed target** (§6.3) — the same person the CP authorized;
- everything else about the request (durable row, console surfaces, decision
  frames) is the unmodified editor path. A DM decision and a console
  decision race exactly like two console editors do today, settled by the
  existing compare-and-swap on `status = 'pending'`.

## 3. Recipient selection — the preference chain

One human is DM'd per pending request (no fan-out). Every rung must pass
both standing gates before it can win:

- **Authority:** the candidate's console user satisfies `canEdit(agent)`.
- **Identity:** the candidate has linked a Slack identity **in the bot's own
  workspace** — `slackIdentityFor(sub).teamId === bot.teamId`, keyed on the
  `(teamId, userId)` pair per [slack-identity.md](slack-identity.md).

The rungs, in order (from the issue discussion):

1. **Conversation turn owner** — `TurnPlan.requesterId`, the Slack sender of
   the triggering message. Already threaded into the approval record as
   `requesterId ?? session.triggeredBy`.
2. **Session owner** — `SessionMeta.ownerIdentity`. For chat-triggered
   sessions this is the `slack:T…:U…` pair; for webchat/API sessions it is
   `user:<id>`, a console user directly (which then only needs the identity
   gate to find its Slack account).
3. **Agent visibility audience** — for a `restricted` agent, the members of
   `Agent.sharedWith` (this is the _human_ console audience — not
   `callPolicy`, which governs agent-to-agent reach). The first member that
   passes both gates wins; ties break deterministically (stable audience
   order) so retries pick the same person.
4. **Agent creator** — `Agent.createdByUserId`.

If no rung produces a target, behavior is **exactly today's**: the chat
notice plus the console queue. Resolution failing can never fail, delay, or
auto-answer the approval itself — the DM is a best-effort notification
bolted onto a flow that already works without it.

Rungs 1–2 start from a _Slack_ id, and there is deliberately no reverse
index from a Slack user to a console account
([slack-identity.md](slack-identity.md), §4.4 below). So they are verified
by the same forward scan rung 3 uses: enumerate the console users who can
edit the agent, forward-resolve their linked Slack identities, and check
whether the rung's `(teamId, userId)` pair is among them. One scan serves
the whole chain.

## 4. Target resolution runs on the Control Plane

### 4.1 Why the CP

Everything the chain needs beyond rung 1 lives CP-side: `ownerIdentity`,
`Agent.visibility` / `sharedWith` / `createdByUserId` (none of which are in
`AgentSpec`, deliberately), the `canEdit` policy, and above all
`LogtoIdentityService.slackIdentityFor` — Logto is the only identity store.
Pushing the audience into `AgentSpec` would still leave the daemon unable to
resolve identities, so the daemon asks instead.

### 4.2 The frame pair

A synchronous daemon→CP request/reply over the existing WS, modeled on
`github/review-authorize` → `github/review-authorized`:

- **`agent/approval-route`** (daemon→CP):
  `{ agentId, sessionId, requestId, requesterId?, integrationId }` —
  `requesterId` is the turn owner's Slack member id when the turn came from
  Slack; `integrationId` names the bot whose workspace anchors the identity
  gate.
- **`agent/approval-routed`** (CP→daemon):
  `{ requestId, target?: { teamId, userId, displayName?, consoleUserId } }` —
  absent `target` means "no eligible recipient, keep today's behavior".

The CP evaluates the chain of §3 with the `linkedMemberIds` machinery
(`packages/control-plane/src/orchestrator/linkedDm.ts`): the same
per-subject-cached forward reads, the same `AUDIENCE_CONCURRENCY`, the same
fail-closed posture. `MAX_AUDIENCE` applies to rung 3 — an agent shared with
more than 200 people skips that rung rather than fanning out (rungs 1, 2,
and 4 are single lookups and always run).

### 4.3 Degradation

The CP is not on the message hot path and this does not put it there: the
route query is a bounded, best-effort control-signaling exchange. CP
unreachable, slow past a short timeout, or answering without a target ⇒ the
editor path proceeds untouched (notice + console). The daemon never blocks
the approval on the reply — it posts the DM when and if a target arrives.

### 4.4 What is deliberately not built

No `UserIdentity` / reverse-index table. Two designs
([slack-identity.md](slack-identity.md),
[session-visibility.md §7](session-visibility.md)) already record why the
forward read-through is the model: Logto stays the only store, and the
identity is an assertion because it entered Logto under the user's own
session. The chain is small by construction (three single candidates plus a
capped audience), so the forward scan is cheap and this design inherits it
unchanged.

## 5. The DM itself

### 5.1 Delivery

The daemon resolves the DM channel with the shipped primitive
`SlackConnection.openDirectMessage(userId)`
(`packages/daemon/src/slack/connection.ts` — `conversations.open` first;
posting to a raw `U…` id while customizing agent identity routes through
Slack's notification-only `USLACK` conversation, so the `D…` channel is
mandatory). All required scopes — `chat:write`, `im:write`, `im:read` — are
already in `SLACK_BOT_SCOPES` (`packages/protocol/src/slack-app-manifest.ts`);
**no new scope, no reinstall**.

### 5.2 Content

One message per pending request, containing:

- what is being asked — the same `permissionRequestSummary` /
  `elicitationApprovalSummary` text the console shows, secret-masked as
  today (the coordinator masks before any surface sees params);
- who triggered it (`requesterName`), and which agent/session;
- the **console session deep link** — the daemon already builds
  `<webAppUrl>/<orgSlug>/sessions/<id>` (`sessionLink`,
  `packages/daemon/src/cp/client.ts`);
- when the triggering turn came from Slack, a **permalink to the source
  thread** — built locally from pieces the daemon already holds
  (`packages/daemon/src/platforms/slack/permalink.ts`), no
  `chat.getPermalink` round trip;
- the Allow/Deny buttons (phase 2, §9) — `buildPermissionCard` /
  `buildElicitationCard` (`packages/daemon/src/slack/render.ts`) reused
  as-is, since their `action_id` / `value` encoding is
  channel-independent.

### 5.3 Routing the click back — both transports

The button's routing key is the `block_id`, not the conversation, so a card
in a DM channel routes exactly like one in the session thread:

- **Shared/HTTP bots:** the relay's `POST /slack/interactions` decodes the
  `encodeSharedSlackStatusTarget` block id into
  `{agentId, integrationId, sessionKey}` and forwards a
  `permission-choice` to the owning daemon
  (`packages/relay/src/platforms/slack/http-ingest.ts`). Today the daemon
  encodes that target only when `isHttpSlackIntegration`; a DM card must
  carry it on that path unconditionally.
- **Direct (Socket Mode) bots:** the daemon's own
  `app.action(ac_perm:*)` handlers fire regardless of channel; nothing
  changes.

### 5.4 Lifecycle

- **Coalescing:** at most one _live_ card per `(session, recipient)` DM. A
  second approval arriving while one is pending threads under the first
  message rather than stacking top-level pings.
- **Resolution:** whoever decides (DM click, console, or the in-thread chat
  card), the DM card is rewritten to the resolved state
  (`buildPermissionResolvedCard`) naming the decider — same treatment the
  in-thread card gets from `decideEditorPermission` today.
- **Cancellation / expiry:** the sweeps that already release pending
  approvals (turn cancel, session teardown, ownership takeover via
  `recoverPermissionRequests`) also rewrite the DM card to "expired". Dead
  buttons must not survive; a click on a stale card gets the existing
  "no longer pending" answer.
- **Restart survivability:** the in-memory card handle (`channel`, `ts`)
  dies with the daemon, so the row gains two nullable columns (§6.1) to let
  a takeover or restart rewrite the orphaned card instead of leaving live
  buttons pointing at a resolver nobody holds.
- **No timeout:** pending approvals have none today and this design adds
  none.

## 6. Recording the decision

### 6.1 Store (daemon SQLite, `permission_requests`)

New nullable columns:

- `resolvedBy` — who decided: `user:<consoleUserId>` for console decisions,
  `slack:<teamId>:<userId>` for DM/chat-card decisions (the `ownerIdentity`
  encoding, keyed on the pair per the standing rule);
- `resolvedByName` — display name captured at decision time;
- `notifyChannel`, `notifyTs` — the DM card handle, for §5.4.

The existing `ownerId` column is the daemon-pool lease and is **not** a
human — untouched.

### 6.2 Wire and DTO

`AgentPermissionRequestRecord` (`packages/protocol/src/frames/agent.ts`)
gains optional `resolvedBy` / `resolvedByName`; `AgentPermissionDecision`
gains the decider (the CP fills it from the authenticated console user —
today the decision frame carries no actor at all). CP DTO and web client
types follow. `protocol` is consumed by both daemon and CP — both sides
rebuild and both sides get checked, per the standing rule.

### 6.3 Actor verification on the DM card

`handlePermissionChoice` currently refuses when
`allowRuntimeChangesInChat` is off. It learns to distinguish card origin:
for a DM-originated request (the coordinator knows — it posted it), the
gate is replaced by **actor equality**: the clicking Slack user's
`(teamId, userId)` must equal the addressed target's. A 1:1 DM makes
mismatch nearly impossible, but the check is what makes the authorization
claim of §2 true rather than topological. In-thread cards keep their
existing gate unchanged.

## 7. Console notification states

The issue asks the notification system to show a pending approval as unread
and a resolved one as read with "_X_ has approved/declined".

The console's notification center is client-local
(`packages/web/src/lib/notifications.tsx`, localStorage, categories
`daemon_lifecycle | session_retention | session_access`). This design adds
an `approval` category fed by the polling the console already does
(`ApprovalRequestsCard`'s SWR key at a 3 s interval, plus a lightweight
pending-count read on the shell): a request in `pending` surfaces as an
unread notification deep-linking to the Agent/Session page; on resolution
the same notification flips to read and renders `resolvedByName` +
decision. Known limitation, accepted: read-state is per-browser, like every
existing category.

## 8. Explicit non-goal: a server-side notification store

Cross-device unread state, digests, or push would need a CP-persisted
notification model that does not exist for _any_ category today. That is an
independent piece of infrastructure with its own design; bundling it here
would couple a small routing feature to a large one. The client-local
category of §7 satisfies the issue's stated behavior.

## 9. Rollout phases

1. **Notify-only DM** — frames of §4.2, CP chain evaluation, daemon posts a
   _text_ DM (summary + session link + source permalink). No buttons: the
   decision still happens on the web. Small, shippable, already most of the
   user value.
2. **Interactive DM card** — buttons in the DM, actor verification (§6.3),
   `resolvedBy` columns/frames (§6), card lifecycle + restart
   survivability (§5.4), unconditional `block_id` target on DM cards
   (§5.3).
3. **Console notifications** — the `approval` category (§7).

## 10. Out of scope / future

- **Other platforms.** Feishu/Lark's linked identity asserts a cross-app
  `union_id` while its messages carry an app-scoped `open_id` — matching
  needs a resolution step `linkedMemberIds` deliberately refuses to guess
  at. Telegram/Discord have no linked-identity assertion at all. The frame
  pair of §4.2 is platform-shaped (`target` could grow a platform tag), but
  only Slack ships.
- **Multi-recipient fan-out / escalation.** One target per request. If the
  chosen human is away, the console queue is the backstop, as today.
- **Approval timeouts and reminders.** Orthogonal; nothing here precludes
  them.
