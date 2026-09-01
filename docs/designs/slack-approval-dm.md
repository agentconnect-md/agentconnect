# Slack Approval DM

> **Status:** Accepted (issue
> [#1648](https://github.com/agentconnect-md/agentconnect/issues/1648));
> shipping as two stacked changes (§9). File/line references describe the
> shipped machinery this design composes.
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
The approval itself keeps living on the web exactly as today, and the
console's approval cards learn to show **who** decided (§6).

Non-goals: replacing the in-conversation chat card (it stays, unchanged
behind its opt-in), console notifications (§7, deferred), a server-side
notification store (§8), any platform other than Slack (§10), and a reverse
Slack→console identity index (§4.4).

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
  DM's addressed target** and **still passes both gates at click time**
  (§6.3) — routing-time authorization is not an indefinite grant;
- everything else about the request (durable row, console surfaces, decision
  frames) is the unmodified editor path. A DM decision and a console
  decision race exactly like two console editors do today, settled by the
  existing compare-and-swap on `status = 'pending'`.

## 3. Recipient selection — the preference chain

One human is DM'd per pending request (no fan-out, no escalation, no
per-user or per-org opt-out — the console queue is the backstop). The chain
is anchored to one Slack workspace at a time; when the agent is connected
to more than one, it runs per workspace in a stable order and the first hit
wins (§4.2). Every rung must pass both standing gates before it can win:

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
([slack-identity.md](slack-identity.md), §4.4 below). So a Slack-id rung is
verified by a forward scan over the **eligible-editor set** — the console
users who can edit the agent: forward-resolve their linked Slack identities
and check whether the rung's `(teamId, userId)` pair is among them. One
scan serves every Slack-id rung plus rung 3. That set is small for a
`restricted` agent (its `sharedWith`), but for an `org`-visible agent it is
the org's whole editor-capable membership — so the scan is capped, not
assumed cheap (§4.2).

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
  `{ agentId, sessionId, requestId, requesterId?, integrationIds }` —
  `requesterId` is the turn owner's Slack member id when the turn came from
  Slack; `integrationIds` are the agent's connected Slack integrations in
  the order to try, the session's own bot first when the session is on
  Slack. Each names a workspace that anchors its own identity gate.
- **`agent/approval-routed`** (CP→daemon):
  `{ requestId, target?: { integrationId, teamId, userId, displayName?,
consoleUserId } }` — the CP evaluates the chain once per workspace in the
  given order and answers with the first hit; absent `target` means "no
  eligible recipient, keep today's behavior".

Sessions **not** triggered from Slack (webchat, GitHub, webhook, Telegram…)
are covered by the same shape — they are precisely the approvals with no
chat surface at all, so the DM matters most there. The daemon simply lists
every Slack integration the agent is connected to (almost always one) and
lets the CP pick.

The same pair also serves the decision-time revalidation of §6.3:
`agent/approval-route` with `verify: { integrationId, teamId, userId,
consoleUserId }` set asks not "whom should I DM" but "is this Slack pair,
**right now**, still the linked identity of this console user, and can that
user still edit this agent" — answered by `{ requestId, allowed,
displayName? }`. Naming the addressed console user makes the check a single
forward lookup instead of a scan. Routing is best-effort (§4.3);
verification is not — it authorizes an action, so an unanswerable verify
fails closed.

The CP evaluates the chain of §3 with the `linkedMemberIds` machinery
(`packages/control-plane/src/orchestrator/linkedDm.ts`): the same
per-subject-cached forward reads, the same `AUDIENCE_CONCURRENCY`, the same
fail-closed posture. `MAX_AUDIENCE` bounds the forward scan of §3, and the
scan's input is the eligible-editor set — `sharedWith` for a `restricted`
agent, the org's editor-capable membership for an `org`-visible one. When
that set exceeds the cap, every rung that needs the scan — rung 3 and any
rung whose candidate is a Slack id (rung 1; rung 2 for chat-triggered
sessions) — is skipped rather than fanned out, keeping the fail-closed
default of no DM. Rungs whose candidate is already a console user (rung 2
for `user:<id>` owners; rung 4, the creator) are genuine single lookups and
always run.

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
- the Allow/Deny buttons — `buildPermissionCard` /
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

- **One top-level message per request**, no threading and no cross-request
  coalescing: a DM thread is easy to miss, and every pending approval must
  trip the recipient's unread badge on its own. Approvals are rare enough
  that a burst is itself the signal something is wrong.
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
gate is replaced by two checks, both required:

- **Actor equality** — the clicking Slack user's `(teamId, userId)` must
  equal the addressed target's. A 1:1 DM makes mismatch nearly impossible,
  but the check is what makes the authorization claim of §2 true rather
  than topological.
- **Decision-time revalidation** — routing-time `canEdit` is not an
  indefinite grant: these requests have no timeout, and before the click
  lands the target may have left the org, been demoted, dropped from
  `sharedWith`, or unlinked the Slack identity. So the daemon revalidates
  through the CP (the `verify` form of §4.2) that the actor's pair still
  maps to a console user who can edit the agent — the same predicate the
  console decision route evaluates at action time. The verify failing,
  answering `allowed: false`, or being unanswerable (CP down) all **fail
  closed**: the click is refused, the card is annotated "decide from the
  console", and the request stays pending. The routed target's
  `consoleUserId` plus the verify's fresh `displayName` are what land in
  `resolvedBy` / `resolvedByName`.

In-thread cards keep their existing gate unchanged.

### 6.4 Elicitation clicks carry no actor today

§2's addressed-target rule must hold for approval **elicitations** (Codex
MCP approvals over `elicitation/create`) too — but the current elicit-choice
path drops the actor on both transports: `onElicitChoice` has no actor
parameter, the Socket Mode handler never calls `actorOf`, and the relay's
`elicit-choice` frame omits the acting user. That plumbing is therefore in
scope for this delivery (§9) — actor on the Socket Mode handler, an
acting-user field on the relay frame, and the §6.3 checks in
`handleElicitChoice` for DM-originated cards — so both request kinds get
identical interactive DMs; the two runtimes must not diverge here.

## 7. Console notification states — deferred

The issue also asks the notification bell to show a pending approval as
unread and a resolved one as read ("_X_ has approved/declined"). Deferred
out of this delivery: the console has **no cross-agent pending signal** to
feed a bell — the only live source is the per-agent daemon proxy (polled
on detail pages), and the protocol's `agent/activity` frame with
`ActivityState.awaiting_permission` is declared but never emitted by any
daemon nor handled by the CP. A future effort can revive that frame (emit
on park/release, persist the enum `SessionMeta.activityState` already has
a column for) and hang a client-local `approval` category off it. Until
then the decider's name lands on the approval cards themselves (§6), which
is where an editor already looks — tracked in a follow-up issue.

## 8. Explicit non-goal: a server-side notification store

Cross-device unread state, digests, or push would need a CP-persisted
notification model that does not exist for _any_ category today. That is an
independent piece of infrastructure with its own design; bundling it here
would couple a small routing feature to a large one. Whatever revives §7
stays client-local unless that infrastructure arrives first.

## 9. Delivery

One delivery — notify **and** interactive DM together — as two stacked
changes:

1. **Protocol + CP** — the §4.2 frame pair, the CP chain evaluation, and
   the decision-time verify.
2. **Daemon + web** — DM delivery (§5), actor equality + revalidation
   (§6.3), the elicitation actor plumbing (§6.4), `resolvedBy`
   columns/frames (§6.1–6.2) with the console approval cards showing the
   decider, card lifecycle + restart survivability (§5.4), and the
   unconditional `block_id` target on DM cards (§5.3).

Console notifications (§7) are deferred to a follow-up issue.

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
