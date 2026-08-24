# Session Visibility

> **Status:** Implemented for direct `private` / `org` visibility, Slack and
> Feishu/Lark conversation audiences, GitHub repository audiences, and their Console
> settings/profile-linking surfaces. Share-by-link and additional providers remain
> future work.
>
> **Scope:** protocol + control-plane + daemon + web. Console authorization is
> enforced on CP/BFF read paths. The daemon reports immutable source metadata,
> enforces source lineage, and receives a CP-pushed per-session shared-memory
> exclusion bit. Live platform messages and ACP update streams never pass
> through the CP, consistent with [resource-visibility.md](resource-visibility.md).

## 1. Background and goals

Before this design, sessions had no visibility of their own and derived it
entirely from the owning agent (see the taxonomy in
[resource-visibility.md §2](resource-visibility.md)). That exposed every
session of a visible agent to every allowed org viewer, including another
member's platform DM or Playground conversation.

This design gives every session its own visibility:

- **`private`** — visible only to the session owner (identity match).
  Like restricted-resource visibility, there is **no org-owner governance
  override**: a private session is a DM-grade transcript, and role grants no
  access to it. Default for platform **DM** sessions, **Playground /
  webchat** sessions, and sessions launched through the **Web API**. A
  Feishu/Lark custom-Bot p2p ownership matches through the user's cross-App
  `union_id`.
- **`org`** — visible to every organization member, independently from the
  owning Agent's Team visibility. Default for automation-originated sessions
  and shared IM sessions when the corresponding external-audience policy is
  disabled.
- **`external`** — visible only when the viewer currently has provider access
  to the immutable external source scope recorded when the session was created.
  Slack stores `(workspace, conversation)`: public channels admit linked,
  active full members of that workspace; private channels, group DMs, guests,
  and Slack Connect users require current conversation membership. GitHub hook
  sessions store the rename-proof numeric repository id: public repositories
  require no linked identity; private repositories require the viewer's
  currently linked GitHub account to retain read access.
  Feishu/Lark sessions created through any registered Bot app require current
  chat membership. The BFF uses that Bot App's durable tenant credential to
  list member `union_id` values and compares them with the viewer's verified
  sign-in identity. This covers both group chats and Bot p2p conversations and
  requires no stored user token.
- **Share-by-link ("public")** — future work; a session with an active share
  link is readable by anyone holding the link. Deliberately **not** a member of
  the visibility enum; see §8.

Session visibility is **independent from** Agent Team visibility. Passing the
session-level predicate grants access only to that Session's metadata,
transcript, and Session-scoped live updates. It does not grant access to the
owning Agent resource, configuration, workspace, or invocation controls. The
Console may project the Agent's display name as Session context, but links it
only when the Agent resource is independently visible.

## 2. The owner identity problem

The daemon does not know Control-Plane user ids. What it knows is the platform
sender id: `SessionMeta.triggeredBy` is an opaque, platform-namespaced string
(a Slack/Discord/Telegram/Feishu user id, an agent UUID, `cron:<id>`,
`hook:<id>`, or — for webchat — the console user's email). There is no
platform-identity → `app_user` mapping today
([resource-visibility.md §14.6](resource-visibility.md) lists it as future
work).

**Decision: the owner is a namespaced identity string, not a `User` FK.**

```
ownerIdentity :=
  user:<app_user_id>                     — console-originated (webchat, Web API launch)
  <platform>:<workspace>:<platform_uid>  — IM-originated, e.g. slack:T024BE7LD:U0123ABCD
  feishu:<region>:<bot_app_id>:<union_id> — Lark/Feishu custom-Bot ingress
```

The IM form carries a **workspace/tenant segment** from day one: platform uids
are only unique per tenant (Slack team, Feishu tenant, Telegram bot scope), and
one org can connect multiple workspaces of the same platform, so a two-segment
`slack:<uid>` form would allow same-org identity collisions. The workspace
value is **carried on the wire by the daemon** — `EventSession` gains a
`transportScope` field (§4.1) that the CP persists verbatim into
`ownerIdentity`. The reported value must be a **durable tenant identifier**
(Slack team id, Feishu tenant key): the daemon's existing physical transport
scope is credential-derived and rotates with tokens, so reusing it would
orphan historical identity matches on rotation. An adapter whose platform
exposes no durable tenant id mints a stable per-integration scope once and
persists it. The CP never reconstructs the scope from `platform` +
`channel` (ambiguous when an org connects multiple bots/workspaces), and the
design does not assume every adapter's integration record stores a usable
tenant key (Feishu's, for example, is not exposed the same way). A milestone
arriving **without** `transportScope` records no IM owner (`null`, fail
closed per §4.2) rather than a guessed one. Identity linking (§7) stores and
matches the same three-part tuple.

Matching is set membership: at request time the BFF computes the viewer's
**identity set** — `{ user:<userId> }` for every caller, plus the caller's
verified Slack identity (`slack:<teamId>:<userId>`) or a same-developer-org
Feishu/Lark identity (`feishu:<region>:<botAppId>:<unionId>`) when linked by its
Session-access plugin (§7) — and a `private` session is
visible when `ownerIdentity ∈ identitySet`.

Consequences:

- Before the identity mapping exists for a platform (today: Telegram and
  Discord), a `private` IM DM session is an **owner-orphan**: no console user
  matches the stored tuple, so no one sees it. This is accepted — it errs
  toward hiding a DM rather than exposing it.
- When identity linking ships for a platform, those sessions become visible
  to the mapped user **automatically**, with no backfill: the stored
  `ownerIdentity` is already correct; only the viewer's identity set grows.
- The predicate is always additionally scoped by `orgId`, but never by Agent
  Team visibility. The organization boundary prevents cross-org access; the
  workspace segment above closes the remaining same-org, cross-tenant collision.

## 3. Data-model changes (`packages/control-plane/prisma/schema.prisma`)

New enum beside `ResourceVisibility`:

```prisma
enum SessionVisibility {
  private
  org
  external
}
```

New columns on `SessionMeta`:

```prisma
orgId            String            // denormalized from agent.orgId at ingest
visibility       SessionVisibility @default(org)
ownerIdentity    String?           // §2 format; null for automation/legacy rows
visibilitySource VisibilitySource  @default(default)
visibilityRev    Int               @default(0) // monotonic, bumped in the same
                                               // tx as any visibility change (§5.1)
externalProvider String?            // null for direct private/org sessions
externalScopeId  String?            // immutable source-scope reference
externalResolution ExternalResolution? // pending | settled | invalid
classifiedPolicyRev BigInt?         // provider-policy revision at classification
```

`visibilityRev` is a **dedicated counter**: the existing transcript revision
and WS sequence numbers version different things and are not reused for the
privacy gate.

```prisma
enum VisibilitySource {
  default           // classified by the §4.2 rules
  inherited_pending // A2A child awaiting parent resolution (§4.5)
  inherited         // settled from (or cascaded by) its parent
  explicit          // set by a human via §4.3; only a §4.5 tightening
                    // cascade may override it (privacy wins)
}
```

- `orgId` is denormalized so the list predicate and its index do not join
  `agent`. All existing paging indexes are `agentId`-prefixed; add an
  `(orgId, visibility, …)` index whose trailing columns **mirror the existing
  keyset tuple exactly** (`lastActivityAt desc, startedAt, id` — whatever the
  current `agentId`-prefixed page indexes use) so the org-wide session list
  pages with the same cursor shape.
- No `sharedWith String[]` on sessions in this iteration. Per-session
  member-sharing can be added later with the same GIN pattern as agents;
  share-by-link (§8) covers the near-term "share this session" ask.
- `ExternalScope` stores only the stable provider resource identity and the
  credential locator needed to ask the provider. It never stores provider ACLs.
  Slack/Feishu/Lark conversation-access and GitHub repository-access decisions are bounded
  in-process cache entries, leased by verdict (session-access-cold-visit.md §2): per-user
  decisions stay short-lived (`SESSION_ACCESS_RECHECK_SEC`, default 2 minutes), while a
  conversation's or repository's `public` verdict may serve for up to
  `SESSION_ACCESS_PUBLIC_TTL_SEC` (default 60 minutes), with any read past the recheck
  threshold re-verifying it in the background and daemon channel snapshots invalidating
  a stale `public` on observation. Linked Slack, Feishu/Lark, and GitHub identities
  remain provider-owned and are resolved from Logto rather than copied into the
  AgentConnect database. Feishu/Lark membership checks reuse each installed Bot
  App's required credential. The Login App secret remains static deployment
  configuration for install-time tenant validation, but Session reads store no
  additional credential and use no human access token.
- `SessionExternalAccessPolicy` is per organization and provider. Its revision
  and read fence make enablement fail closed while historical rows converge.
  History whose scope cannot be reconstructed only settles if new trusted
  activity rebinds the same session, so treating it as degradation would pin any
  organization with pre-existing history to a permanent fault state and bury the
  one signal that matters. Enablement therefore stamps
  `SessionMeta.legacyUnresolved` on the rows that are already unresolved
  at that instant, and `degraded` means an unresolved row exists **without** that
  mark — a candidate that failed to resolve after the policy was turned on. The
  provenance is per row on purpose: a mere count of the backlog is fungible, so
  settling one legacy row would offset a live post-enable failure and silently
  clear the fault. A2A descendants inherit the mark with the audience they
  inherit; the backlog stays reportable to owners as `hiddenSessions`.

**Migration / backfill:** the original visibility migration populated `orgId`
and kept legacy rows `org`; it did not guess DM ownership. The Slack-audience
migration separately tags historical Slack-shaped shared sessions as provider
candidates. Their source scope cannot be reconstructed safely, so enabling the
Slack policy hides unresolved history instead of guessing an audience. The
GitHub migration uses accepted `HookRun` snapshots only when every run tied to
a session agrees on one numeric repository id; ambiguous history remains a
hidden unresolved candidate after GitHub sync is enabled.

## 4. Classifying sessions at ingest

### 4.1 Protocol: new telemetry fields

`EventSession` (`packages/protocol/src/frames/telemetry.ts`) gains five
optional fields:

```ts
conversationKind?: 'dm' | 'group_dm' | 'channel'
transportScope?: string // trusted workspace/tenant scope for ownerIdentity, §2
launchCorrelationId?: string // Web API launch provenance, §4.4
sourceBindingKind?: 'local' | 'external' // daemon-pinned source provenance
directDestination?: true // this row's coordinates are its own conversation, §4.2
```

Shared-source sessions additionally report a provider-specific
`externalOrigin`. Slack reports:

```ts
{
  provider: 'slack'
  realmKey: string          // Slack workspace/team id
  resourceKind: 'conversation'
  resourceKey: string       // Slack conversation id
  integrationId?: string    // direct ingress only; stripped from A2A lineage
}
```

GitHub direct ingress reports:

```ts
{
  provider: 'github'
  realmKey: 'github.com'
  resourceKind: 'repository'
  resourceKey: string // numeric, rename-proof repository id
  hookId: string
  deliveryKey: string
  sourceInstallationId: string
  repoFullName: string // validated snapshot; not the ACL identity
}
```

Feishu/Lark direct ingress uses provider `feishu`, a `conversation` resource,
and realm `<region>:<appId>`. The App ID identifies and validates the registered
Bot credential that received the message; it does not need to match the
sign-in App ID because authorization compares developer-org-scoped `union_id`
values rather than app-scoped `open_id` values.

The daemon pins that tuple on first use. A later input from a different source
is rejected rather than silently reusing the session. A2A descendants carry
only the audience identity (without Slack integration ids or GitHub delivery
proof) and inherit the parent's access boundary across daemons.

`sourceBindingKind` distinguishes a provider-bound session from local
automation that deliberately keeps platform-shaped coordinates for session-key
compatibility. An explicit `local` binding bypasses the legacy Slack-candidate
fallback; an absent value still takes that fail-closed path for older daemons.
Existing classifications are left unchanged.

Headless GitHub messages also namespace the daemon-local session key with the
numeric repository id. The first post-upgrade delivery therefore starts a clean
runtime instead of claiming an unscoped legacy runtime whose repository cannot
be proved locally; historical Control-Plane metadata is still backfilled from
accepted `HookRun` snapshots.

The daemon derives this from `NormalizedMessage.isDm` / `isGroupDm`
(`packages/daemon/src/messages/normalized.ts`) and reports the normalized fact
to the CP. The `thread === 'dm'` heuristic and an
`IntegrationChannel.kind` join were both considered and rejected: the former is
platform-inconsistent, the latter does not cover webhook/generic ingress and
moves a write-time fact to read time. All four fields are optional ⇒ old
daemons remain compatible (absent `conversationKind` = `channel` behavior,
i.e. `org`; absent `transportScope`/`launchCorrelationId` = no owner, fail
closed).

### 4.2 Default rules

The CP classifies once, in the `event/session` ingest path
(`ws/handlers/event-session.ts` → `session.recordMilestone`), first-wins like
the other origin scalars:

| Origin (how detected)                                         | `visibility`            | `ownerIdentity`                                                                                                                       |
| ------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Webchat / Playground (`platform === 'webchat'`)               | `private`               | `user:<WebchatConversation.userId>` via `channel == conversationId` lookup; lookup miss ⇒ stays `private`, owner `null` (fail closed) |
| Web API session launch (§4.4 correlation)                     | `private`               | `user:<launch principal userId>`; missing correlation ⇒ `private`, `null`                                                             |
| IM DM (`conversationKind` = `dm`)                             | `private`               | `<platform>:<workspace>:<uid>` (initiator)                                                                                            |
| Slack or Feishu/Lark group chat with trusted `externalOrigin` | `org` or `external`     | External source scope; `org` while sync is disabled, `external` while enabled                                                         |
| Feishu/Lark Bot p2p chat with trusted `externalOrigin`        | `private` or `external` | Owner-only baseline (`union_id` identity match) while sync is disabled; current conversation membership while enabled                 |
| GitHub hook with an accepted delivery snapshot                | `org` or `external`     | Repository source scope; `org` while sync is disabled, `external` while enabled                                                       |
| Other IM group DM / channel (or absent kind)                  | `org`                   | `<platform>:<workspace>:<uid>` (initiator)                                                                                            |
| Agent-to-agent child (`triggeredBy` is an agent UUID)         | inherits parent         | inherits direct owner or external source scope; unresolved parent ⇒ private/unreadable (fail closed)                                  |
| Automation without a trusted external destination             | `org`                   | `null`                                                                                                                                |

Notes:

- **Fail closed on missing ownership metadata.** A classification rule that
  defaults to `private` must never widen to `org` because a lookup failed —
  that would turn a metadata inconsistency into disclosure. An unresolvable
  owner yields `private` + `ownerIdentity = null`, a row visible to no one.
  Note the distinction from the §2 owner-orphan: a stored-but-unmatched
  platform tuple (`slack:T…:U…`) lights up retroactively when identity
  linking (§7) grows the viewer's identity set, whereas a `null` owner has
  nothing to match and stays inaccessible unless a separate repair/backfill
  populates it.
- Webchat `triggeredBy` is the console user's **email** (set in
  `routes/webchat-token.ts`), which degrades under devAuth and is not a stable
  key — hence the `WebchatConversation` lookup rather than trusting the wire
  value.
- **`ownerIdentity` is recorded for every human-triggered session regardless
  of visibility** (DM, group DM, and channel alike). It is orthogonal to the
  visibility default: for `org` sessions it is provenance and the anchor for
  §4.3 reclassification rights, not an access gate.
- A shared provider-bound conversation or repository never uses one initiator
  as its access owner. A Feishu/Lark Bot p2p is the narrow exception: while
  sync is disabled its one human participant is the private owner, proven by
  exact `union_id` identity. With Slack sync enabled,
  public-channel access follows active
  full workspace membership while restricted conversations and restricted
  users follow current conversation membership. With provider sync disabled,
  new provider sessions remain `org`.
- A cron or daemon-owned continuation delivered into an attributable Slack
  conversation is provider-bound at creation just like a human-started thread.
  Automation without a trusted external destination remains `org` with no owner.
- **Agent-to-agent children inherit.** A delegation from a private DM or
  Playground session copies the delegated prompt into the child transcript;
  classifying children `org` would expose that to every viewer of the target
  agent. The child takes the parent's `visibility` + `ownerIdentity` at
  ingest; §4.5 defines the durable reconciliation semantics for out-of-order
  arrival and later parent changes.
- **A self-post channel root binds where it landed, not where it came from.**
  An agent's channel-ROOT post seeds a new session for the thread it just
  created, so that thread's own conversation is its external source scope. The
  origin session travels as lineage only: inheriting its scope would bind the
  seed to a conversation it does not live in — readable by that channel's
  audience, and rejecting the first human reply as a cross-source turn.
  Such a row reports `directDestination` and is classified here rather than by
  inheritance, even though it keeps `parentSessionId`: a DM destination (which
  binds no audience by design) becomes `private`, any other conversation `org`,
  and both are unowned — the reporting trigger is the agent, not a person. A
  shared destination re-binds its own trusted candidate, which outranks both.
  Classifying itself does not exempt it from privacy travelling DOWN the
  lineage: a settled-private parent tightens it exactly as §4.3 would, whichever
  of the two rows arrives first — and if the parent landed inside the child's own
  classification window, the child re-runs that tightening after it commits, the
  same recheck `inherited_pending` rows get. Its own `explicit`
  re-classification survives the convergence; only a human tighten of the parent
  overrides that.
- **The lineage fence.** Both halves of that convergence read rows that may not
  exist yet, and a row lock cannot serialize two rows that are both still
  uncommitted — each transaction would see no counterpart and commit its own
  view. Ingest, §4.3 reclassification, and the post-commit recheck therefore
  take a transaction-scoped advisory lock keyed on the session id
  (`persistence/session-lineage-lock.ts`) before any row lock, so one side waits
  and observes the other's committed state. Taken lock-first, never while
  holding rows, which is what keeps a blocking lock deadlock-free.

### 4.3 Changing visibility after the fact

`PUT /orgs/:orgId/sessions/:id/visibility` with body
`{ visibility: 'private' | 'org' }`. Allowed ONLY for the session's recorded
owner (identity match) — roles grant no re-classification rights in either
direction, mirroring the view predicate: an org owner pulling someone's
published session back to `private` would override the owner's own decision,
so the org-owner arm was removed deliberately. A row with no recorded owner is
re-classifiable by no one. For direct sessions this is the escape hatch for
both directions, such as publishing a useful DM transcript to the org or
tightening an owned non-provider session.

Provider-bound sessions are immutable through this endpoint: no single human
owns a shared Slack conversation, and changing such a row to `private` or
`org` would detach it from its source audience.

For direct sessions, an explicit change sets `visibilitySource = 'explicit'`, which pins the row
against any later automatic reclassification (§4.5). **Tightening cascades to
descendants** (§4.5); the CP also notifies the owning daemon of the new
effective state (§5.1). The response/UI must surface the memory caveat from
§5.1: tightening stops future capture but does not scrub what agent memory
already distilled while the session was org-visible.

### 4.4 Web API launch provenance

The Web API rule in §4.2 is not implementable from what exists today:
`AgentLaunch` has no creator column, its `launchId` is an agent-runtime
lifecycle fence (part of the `sessionEpoch`/`seq`/`launchId` fencing tuple),
and daemon `event/session` telemetry does not populate it. Ownership therefore
needs explicit provenance:

- The Web API session-launch flow is CP-mediated: the authenticated principal
  (personal API key → `userId`) is known at the moment the CP issues the
  launch command. The CP mints a **launch correlation id** and records
  `correlationId → user:<userId>` (new column or side table on the launch
  record — distinct from the fencing `launchId`).
- The daemon echoes the correlation id in the session's `event/session` frame
  (optional protocol field, added alongside `conversationKind` in §4.1).
- At ingest, a frame carrying a known correlation id classifies the session
  `private` with that owner. A Web API launch whose correlation cannot be
  resolved fails closed per §4.2.

### 4.5 A2A inheritance: durable reconciliation semantics

Inheritance must survive out-of-order arrival and later human changes without
ever silently overwriting one with the other. `visibilitySource` (§3) is the
state marker:

- **Out-of-order child.** A child milestone whose parent row does not exist
  yet is classified `private` + `ownerIdentity = null` with
  `visibilitySource = 'inherited_pending'`. When the parent's milestone lands,
  the CP performs a **conditional one-time settlement**: copy the parent's
  `visibility` + `ownerIdentity` onto the child **iff** the child is still
  `inherited_pending` (compare-and-set on the source column), then mark it
  `inherited`. A child that a human has meanwhile re-classified is
  `explicit` and the settlement is a no-op — reconciliation never overwrites
  a human decision.
- **Parent tightened later (`org` → `private`).** The child contains content
  copied from the parent, so leaving it org-visible would defeat the change.
  Tightening a session **cascades to all its descendants** (transitively,
  via `parentSessionId`), including `explicit` ones — privacy tightening wins
  over an earlier widening decision, matching the fail-closed rule of §4.2.
  Cascaded rows get the parent's owner and `visibilitySource = 'inherited'`.
- **Parent widened later (`private` → `org`).** Never cascades. Each
  descendant stays as classified; widening a child remains a per-session §4.3
  decision by its owner (a private child is invisible to everyone else,
  org owners included).

`explicit` is therefore protected against **settlement** (the automatic
reconciliation above) but not against a **tightening cascade** — the §3 enum
semantics are exactly these two rules, and privacy wins on the conflict.

**Serialization.** Child classification and parent tightening race: a child
milestone that reads its parent's `visibility = 'org'` could otherwise commit
after the parent has been tightened, retaining stale org visibility. Both
operations must serialize on the parent row:

- Child ingest classifies inside the same transaction as the child insert and
  takes a shared row lock on its **immediate parent** (`SELECT … FOR SHARE`).
- The §4.3 tightening handler cascades **lock-then-scan, level by level, to a
  fixpoint**: lock the tightened session `FOR UPDATE`; then repeatedly lock
  the current frontier's children `FOR UPDATE` and update them, re-scanning
  each level _after_ its parent locks are held, until no new descendants
  appear. A scan-everything-then-update cascade is **not** sufficient: a
  grandchild insert holding `FOR SHARE` on its mid-level parent could commit
  a stale snapshot after a one-shot scan missed it.

This closes the race at every depth by induction on the level: for any
descendant D with parent P, either the cascade acquires `FOR UPDATE` on P
first — D's `FOR SHARE` waits and D then reads P as `private` — or D's
insert commits first, and the cascade's post-lock re-scan of P's children
sees D and updates it. The integration test plan (§9) exercises both commit
orders, including the depth-2 grandchild interleaving.

## 5. Enforcement points (control-plane)

The authoritative predicate, mirroring `canView`:

```ts
canViewSession(s, ctx, identitySet) =
  // deliberately NO role-based governance exception — private is owner-only
  s.externalProvider != null
    ? s.visibility === 'private'
      ? identitySet.has(s.ownerIdentity)
      : currentExternalAudienceAllows(s, ctx)
    : s.visibility === 'org' || (s.ownerIdentity != null && identitySet.has(s.ownerIdentity))
```

`currentExternalAudienceAllows` requires a settled scope and matching durable
policy/scope revisions. Slack additionally requires a linked identity and
current Slack access: active full workspace membership for a public channel,
or current conversation membership for private channels, group DMs, guests,
and Slack Connect users. GitHub permits a currently public repository without
a linked identity; a private repository requires the linked GitHub user to
retain read permission. Provider errors, timeouts, unresolved history, and
stale revisions deny access. Organization roles, including owner, never bypass
this predicate.

Denial and degradation are separate outcomes. A provider that **answers** —
Slack `channel_not_found` / `not_in_channel` (the conversation is deleted, or
the bot is no longer in it) or `user_not_found`, GitHub returning no repository
for the id — is a verdict: deny, cached for the deny TTL, `degraded` stays
false. Losing access to a conversation is an ordinary event and must not be
reported as a broken deployment. Only a check that could not be completed —
auth, missing scope, rate limiting, an outage, an unrecognized error code, a
transport failure — is `unknown`: deny plus `degraded`, which is what raises
"external access checks are unavailable" and is re-asked on the short unknown
TTL.

Session read surfaces use the Session predicate as their authorization boundary:

| Surface                       | Where                                                                                     | Change                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List + facets                 | `persistence/repositories/session.repo.ts` (`pageWhereSql` — raw SQL, not Prisma `where`) | enumerate the org's Agent ids only as a storage scope, then apply `AND (visibility = 'org' OR owner_identity = ANY(:identitySet))` to every viewer (no org-owner bypass)                                                                                                                    |
| Detail / messages / tool-body | `http/routes/sessions.ts` `getOrgViewableSession`                                         | require the row's `orgId` plus `canViewSession`; fail as 404 without consulting Agent Team visibility                                                                                                                                                                                       |
| Children                      | `session.repo.ts` `listChildren`                                                          | same predicate; an invisible parent renders `null`, while a visible child is retained even when its owning Agent is hidden                                                                                                                                                                  |
| SSE                           | `http/routes/stream.ts`                                                                   | apply the predicate to every session-scoped envelope (`event/session` milestones and `event/session-activity` invalidations) and recheck live organization membership for each event                                                                                                        |
| Usage                         | `http/routes/usage.ts`                                                                    | scope ATTRIBUTION, not the sums: the intersection (Agent visibility plus the Session predicate) decides which rows a caller may see attributed to an agent and scopes the spend series, while `totals` stay the org's and what is withheld is returned as one id-less `unattributed` rollup |

Invariants preserved:

- Agent facets return Session-scoped display labels only for Agents represented
  by the visible facet result. A hidden Agent can therefore filter readable
  Sessions without gaining an Agent link or exposing Agents with no readable
  Session.

- Console **authorization** stays a CP concern: internal/daemon read paths
  keep the deliberate fail-open (`visibilityWhere(undefined)` semantics), and
  no message content ever flows because of visibility. The one daemon-facing
  addition is the §5.1 privacy bit pushed over the WS control channel — a
  capture gate, not an authorization check the daemon performs for readers.
- Usage **totals** are the org's, not the reader's: the reader learns an amount,
  never an identity. What is withheld comes back as one id-less `unattributed`
  rollup, and it is withheld by EITHER predicate — a restricted Agent, or another
  user's private Session on an Agent the reader can see — so it is unattributable
  **usage**, not hidden Agents, and every surface naming it says so.
  `Σ agents + unattributed = totals` is an independently summed invariant — never
  `totals` minus the visible rows — so an attribution bug breaks it rather than
  being absorbed by a plug figure that leaves the page adding up perfectly;
  `session-usage.repo.ts` checks it and throws rather than serve a money figure
  that is wrong and looks right.

- The residual is an **accepted inference channel, at arbitrary time
  resolution.** With a single restricted Agent it _is_ that Agent's spend, and
  `from`/`to` belong to the caller (bounded only by a maximum span), so a member
  who wants the timeline can difference consecutive narrow windows — splitting
  again by `source` — and recover it at whatever resolution they choose. An
  accurate total over a caller-chosen window IS a timeline. No response-shape
  scoping changes that, and no k-anonymity rule can, because the residual is
  implied by subtraction whether or not it is sent: accurate totals and
  concealing the residual are mutually exclusive.

  Keeping the spend **series** viewer-scoped therefore buys that the timeline is
  never disclosed _incidentally_ — reconstructing it takes a deliberate scripted
  read rather than one glance at a chart, which separates an accidental
  disclosure from an attack, and not much more. It is not a security boundary and
  must not be described as one.

  This is accepted because an org's own spend is in any case published to every
  member by the billing ledger, and because the alternatives are worse for the
  problem the residual exists to solve: a minimum window span buys day resolution
  at best and stops the 24-hour view reconciling, and dropping accurate totals
  returns the console to a spend figure that cannot be checked against an
  invoice. Revisit both if the threat model tightens to members who must not
  learn a restricted Agent's activity pattern at all — that needs the residual
  gone, not narrowed.

- 404, never 403, for invisible sessions (no existence oracle).
- A `?triggeredBy=` / `?channel=` query filter remains a filter, not an
  authorization boundary; the predicate is applied regardless.

### 5.1 Agent-scoped memory is a bypass — must be plugged

Console read gates alone do not contain private content: **managed memory is
agent-scoped and shared across users.** A private DM/Playground turn can be
distilled into agent memory (including by dream sessions) and later surface —
via memory reads or recall in someone else's session — to any user who can
view the agent, bypassing every gate in the table above.

> **Dream-path carve-out (#36 follow-up).** The two-layer gate below governs the
> **per-turn capture path**. Offline **dreams** deliberately do NOT apply it:
> a dream mines every session the owning agent itself participated in — channel,
> DM, webchat, external (GitHub), A2A, and launched alike — because that agent
> already saw that content and consolidating it into the same agent's own memory
> adds no new audience. Peer isolation still holds structurally: the dream reads
> only `agentId`-scoped sessions and, within them, only the rows this agent sent,
> received, or was delivered, so a peer's private session never enters. The
> residual bypass — a private one-to-one exchange becoming **shared organization
> knowledge** — is contained by the dream policy prompt instead of a hard
> pre-filter: the dreamer is instructed never to surface a person's private or
> personal conversation as organization knowledge (org knowledge must be general,
> reusable convention). This is an owner-accepted trade-off favoring dream
> usefulness for DM/external-centric agents over the strict capture gate.

Origin inference alone cannot carry this: effective visibility can change, and
a cross-daemon A2A child cannot infer its inherited privacy or external source
from `isDm`/webchat/launch-correlation alone. The gate therefore has two layers:

1. **Daemon-local initial state.** For turns the daemon can classify itself
   (`isDm`, `platform === 'webchat'`, §4.4 launch correlation) memory capture
   is excluded from the first turn, with no CP round-trip. For an A2A child,
   the delegation command carries the parent session's current privacy flag,
   but the flag is **one-directional — it can only tighten**: a `private`
   hint excludes the child immediately; an `org` hint (or a missing flag)
   does **not** enable capture. An A2A child always starts excluded and
   capture enables only once the CP-confirmed gate state for that child
   (the frame pushed after the child's ingest classification) says `org`.
   This is what makes the §4.3 cutover causally sound: a stale-`org`
   delegation already in flight when its parent daemon acks `private`
   cannot open capture on the receiving daemon, because opening requires a
   CP confirmation — and by then the CP has classified the child under the
   post-cascade parent state (§4.5 serialization guarantees `private`).
2. **CP-pushed effective state.** The CP is the authority on effective
   visibility (§4.3 changes, §4.5 settlements and cascades). On every change
   it sends a `session/visibility` control frame over the existing daemon WS
   to the owning daemon (and to daemons running affected descendants), and
   the daemon updates its local capture gate. This is control signaling — the
   channel's stated purpose — and carries a single privacy bit per session,
   not message content.

   The push must be **durable, not fire-and-forget**, or races and restarts
   reopen the bypass:

   - Each frame carries the session's **`visibilityRev`** (§3) — a dedicated
     durable counter bumped atomically in the same transaction as every
     visibility change, settlement, and cascade. It is deliberately **not**
     the transcript revision (a daemon-local cursor) nor the WS
     `sessionEpoch`/`seq` fences (connection-scoped); neither advances with
     visibility. Delivery is at-least-once, so duplicate handling is
     explicit: a frame whose rev is ≤ the stored rev is **not reapplied but
     is still acknowledged** (as already-satisfied/superseded) — "ignore"
     must never mean "don't ACK", or a lost ACK leaves the CP retrying
     forever.
   - The daemon **acknowledges** the frame and persists the gate state (with
     its rev) in its local store alongside the session; the CP retries
     unacked frames, per the WS channel's existing command semantics.
   - The frame names the **owning agent** as well as the session, and the
     stored gate is keyed by that pair. ACP session ids are runtime-local, so
     on a pool's install-wide shared store the id alone would let one
     organization's push answer for another organization's gate.
   - On daemon **register/reconnect**, the CP replays the current
     `(agentId, sessionId, private?, visibilityRev)` set for the daemon's
     active sessions (a snapshot, not a diff), closing the window where a
     change happened while the daemon was offline.
   - **Fail closed on known-unknown state:** a session whose _locally stored_
     gate state is missing or pre-snapshot (e.g. right after a daemon
     restart) is treated as private for capture until the snapshot confirms
     otherwise. A missed or delayed frame can only under-capture, never leak.

   **Tightening cutover is staged, not instantaneous.** A daemon cannot fail
   closed for an update it has not yet learned exists: between the CP
   committing `private` and the daemon applying the frame, the daemon
   legitimately holds confirmed `org` state — a concurrent turn can still be
   captured, and an A2A delegation can carry the stale bit. The design makes
   this window explicit rather than pretending it away:

   - **CP-side read gates apply at commit**: list/detail/SSE hide the session
     immediately.
   - **The memory boundary takes effect at daemon ACK.** The §4.3 endpoint
     reports the tighten as `pending` until every affected daemon has acked
     the new rev, then `applied`; the console shows that state. Turns
     captured inside the window fall under the existing "already captured is
     not scrubbed" caveat — the promise is "capture stops at daemon
     acknowledgement, typically sub-second", not "at the moment of the API
     call".

**Already-captured memory is not scrubbed.** Distilled memory cannot be
reliably attributed back to source turns, so tightening a session stops
_future_ capture but does not retract what was distilled while it was
org-visible. This is a stated product caveat, surfaced in the §4.3 flow —
the guarantee is "private hides the transcript at CP commit and stops
feeding shared memory once every affected daemon has acked (`applied`)",
not retroactive amnesia.

External-source (Slack/Feishu channel) sessions are **not** excluded from managed
shared-memory capture merely for being external — they behave like any other
channel (Discord/Telegram already did), so agents remember what happens in the
channels they work in. Only an explicitly `private` session is excluded; the
external audience is still tracked for console access and source-binding, but no
longer forces a memory hard-deny. The product tradeoff (an external channel may
seat non-org members whose words then enter agent-scoped memory) is accepted by
default; set a session `private` to exclude it. DM / webchat / A2A-child /
launch-correlated sessions stay excluded as before. The gate covers
AgentConnect-managed and external memory paths; a runtime's own opaque/native
memory cannot be isolated per session by AgentConnect and must not be presented as
covered by this guarantee.

Per-owner memory namespaces are a possible future relaxation, but the
exclusion gate is the shipping requirement — the `private` tier's guarantee
is dishonest without it. If it is deferred, the product docs must explicitly
narrow the guarantee ("private hides the transcript, not what the agent
learned from it"); silence is not an option.

## 6. Web console

- Session list / homepage correctness comes from the BFF returning fewer rows.
  The session detail page renders a lock badge for `private`, a provider badge
  for `external`, and the §4.3 visibility control only for direct-session
  owners allowed to use it.
- Settings exposes owner-only provider access-sync switches, disabled by
  default. Slack follows current channel access (workspace access for public
  channels; conversation membership for restricted audiences); Feishu/Lark
  follows current chat membership; GitHub follows current repository visibility
  and user access. Provider-bound visibility is
  read-only; unresolved history and transient provider failures are surfaced
  without widening access.
- Session links emitted into Slack, Feishu/Lark, and GitHub carry a non-authoritative provider
  hint. When such a deep link still resolves to the generic 404 page, the Console
  uses the viewer's own profile status to offer `Link <provider> profile` when
  unlinked or `Review <provider> profile` when linked. The unavailable state lists
  those possible reasons explicitly: the session may not exist or may have been
  removed, or the required profile may be absent or linked to another workspace.
  Unsupported providers and ordinary/handwritten URLs get no provider action. The
  hint is intentionally forgeable and never consulted for authorization, so none
  of this guidance can confirm whether the session exists; the protected session
  route remains 404.
- The existing client-side "mine" heuristic
  (`packages/web/src/lib/session-trigger.ts` email/userId matching) stays as a
  display concern (the "you" label) but is no longer doing authorization work.

## 7. Identity linking

**Slack (shipped).** The BFF expands the identity set without a table of its
own: the sign-in provider already holds a verified Slack identity — it exists
in Logto only after a Slack OIDC sign-in or an Account API link driven by the
user's own session — so the Slack Session-access plugin reads it per request
(`LogtoIdentityService.slackIdentityFor`, cached per subject) and adds
`slack:<teamId>:<userId>`, keyed on the pair per
[slack-identity.md](slack-identity.md). Owner-orphan Slack DM sessions light
up for their owners retroactively — no session backfill, per §2. Only a real
OIDC session qualifies (devAuth and API-key callers have no verified subject),
and a provider miss or error fails closed to the console identity.

**GitHub (shipped in the provider adapter).** The BFF keeps the session scope as
a numeric repository id and resolves its current canonical name with the
installation credential. Public repositories need no user identity. For a
private repository, `GithubUserAuthzService` resolves the caller's linked GitHub
login from Logto and asks GitHub for that user's current effective repository
permission. AgentConnect stores neither the GitHub login nor a copied provider
ACL; only bounded allow/deny/error verdicts are cached in process.

**Feishu/Lark (shipped).** Logto provides the verified sign-in identity's
regional `union_id`. Lark/Feishu guarantees that this value is shared for the
same human across Apps owned by one developer organization, while `open_id`
remains App-scoped. The Feishu/Lark Session-access plugin therefore projects
the sign-in `union_id` into every active Bot App domain in the current
AgentConnect organization: `feishu:<region>:<botAppId>:<unionId>`. Inbound
events must carry `sender_id.union_id`; events without it are rejected.

For live chat access, the BFF exchanges the installed Bot App's durable App
ID/Secret for a tenant token and calls `chats/:chat_id/members` with
`member_id_type=union_id`. Group and Bot p2p sessions compare that current
member list with the viewer's sign-in `union_id`; provider failures fail closed.
No browser Account API token, federated user token, Login App credential, or
user-token refresh loop participates in Session reads. One bounded member-list
snapshot is shared per Bot App and chat across viewers, and concurrent reads are
coalesced. Console reads that resolve Session access (lists, facets, details,
transcripts, and usage) refresh from SSE where available, focus/reconnect, and
explicit actions instead of timers. Bot tenant-token exchanges remain
deduplicated within one authorization read. A provider quota response fails
closed, pauses further checks for that organization and region, and gives the
operator a specific recovery action. Planned OIDC token rotation reopens the SSE
stream without invoking gap recovery; a failed reopen restores the normal
reconnect invalidation.

Every installation enforces the deployment tenant before storing a Bot. The
Control Plane resolves the configured regional Login App's `tenant_key`,
resolves the candidate App's `tenant_key` with that App's tenant token, and
rejects a mismatch as `org_mismatch`. This applies to one-click creation and
pasted credentials, and allows any member of the same organization to authorize
the one-click flow. The comparison does not persist either `tenant_key`; the
Login App ID/Secret remain deployment configuration, and no human access token
is stored.

**Other platform session access (future, separate design).** Telegram and
Discord still need an explicit verified identity binding before their platform
identities can enter the session identity set.

## 8. Share-by-link (future, separate design)

Modeled on `OrgInviteLink`: a `SessionShareLink` row with peppered `tokenHash`,
`displayTail`, `expiresAt`, `revokedAt`, `createdByUserId`. Read path is a
**separate, org-scope-free, read-only route** (the `/orgs/:orgId` subtree
404s non-members by design, so public reads cannot live there), proxying the
same bounded transcript reads the BFF already does. "Public" is therefore a
property of an active link's existence, not a third enum member — revoking the
link ends public access without touching the session row.

## 9. Test coverage

- **Unit (`test:unit`):** `canViewSession` truth table (role × visibility ×
  identity match × orphan owner); ingest classification table from §4.2,
  including every fail-closed path (webchat lookup miss, unresolved launch
  correlation, unresolved parent, missing `transportScope`) and absent
  `conversationKind`; the §4.5 state machine — pending settlement is
  one-time and conditional (never overwrites `explicit`), tightening
  cascades transitively, widening never cascades.
- **Integration (`test:int`):** list/detail/messages/SSE visibility for a
  two-member org (each member sees identity-owned private + org sessions; the
  owner role does not widen private visibility), plus a handoff child whose
  Session remains readable while its restricted owning Agent stays 404;
  SSE assertion that **neither** `event/session` nor `event/session-activity`
  for a private session reaches an unauthorized subscriber; keyset pagination
  stability under the new predicate; migration backfill (`org` + `orgId`) on
  seeded legacy rows; visibility PUT authorization matrix (initiator of an
  `org` channel session may pull it private; a non-owner collaborator may
  not); the §4.5 serialization race — concurrent child ingest and parent
  tightening in either commit order never yields an org-visible child of a
  private parent, including the depth-2 interleaving (grandchild insert
  racing an ancestor cascade); tighten-cutover staging — the §4.3 response
  stays `pending` until daemon ACK and flips to `applied`; the §5.1 capture
  gate — an A2A child starts with capture excluded, an `org` child opens
  capture only after its CP-confirmed gate frame (exercising the initial
  revision, so local fail-closed state is not mistaken for an
  already-stored duplicate), and a stale-`org` delegation racing a parent
  tighten never opens capture; duplicate delivery — losing the first ACK
  and retrying with an equal revision yields a fresh ACK without
  reapplying state.
- **Slack external audience:** disabled baseline and owner-only enablement;
  linked full-workspace access for public channels; current-membership checks
  for restricted audiences; allow/deny/error behavior; Slack
  Connect home-team validation; unresolved-history hiding; list, detail,
  relationships, transcript/tool-body reauthorization, SSE, and usage parity;
  immutable direct source binding; A2A lineage across local and relay paths;
  managed-memory recall, mutation, automatic recall, capture, and Dream gates.
- **GitHub external audience:** accepted-delivery and installation-claim
  validation; numeric repository identity across rename; public, private-linked,
  no-access, and provider-error decisions; ambiguous-history hiding; A2A scope
  inheritance; owner-role non-bypass; and parity across every session read path.
- **Feishu/Lark external audience:** sign-in `union_id` extraction; same-org
  one-click App validation; registered custom-Bot source validation; regional
  member enumeration with the Bot App tenant credential and
  `member_id_type=union_id`; group and Bot p2p classification; definitive denial
  versus degraded provider failure; and absence of user-token storage.
