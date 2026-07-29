# Session Visibility

> **Status:** Proposed. Nothing in this document is implemented yet.
>
> **Scope:** protocol + control-plane + daemon + web. Daemon changes: three
> optional fields on the existing `event/session` telemetry frame (§4.1), a
> memory-capture gate driven by local origin plus a CP-pushed per-session
> privacy bit (§5.1), and a privacy flag on A2A delegation commands. Console
> authorization itself is enforced only on CP/BFF read paths; live platform
> messages and ACP update streams never carry visibility, consistent with
> [resource-visibility.md](resource-visibility.md).

## 1. Background and goals

Sessions currently have **no visibility of their own** — they derive entirely
from the owning agent (see the taxonomy in
[resource-visibility.md §2](resource-visibility.md)). Any org member who can
view an agent sees **every** session of that agent, including other members'
platform DMs and other members' Playground conversations. `session_meta` has no
`orgId`, no owner column, and no `visibility` column; the only tenancy anchor is
`agentId → agent.orgId`.

This design gives every session its own visibility:

- **`private`** — visible only to the session owner (and org owners, via the
  governance exception). Default for platform **DM** sessions, **Playground /
  webchat** sessions, and sessions launched through the **Web API**.
- **`org`** — visible to every org member who can view the owning agent.
  Default for IM **channel** sessions and automation-originated sessions
  (cron, hook, dream, agent-to-agent).
- **Share-by-link ("public")** — future work; a session with an active share
  link is readable by anyone holding the link. Deliberately **not** a member of
  the visibility enum; see §8.

Session visibility **composes with** agent visibility: a session is visible iff
the viewer can view the owning agent **and** passes the session-level
predicate. It never widens agent visibility.

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
```

The IM form carries a **workspace/tenant segment** from day one: platform uids
are only unique per tenant (Slack team, Feishu tenant, Telegram bot scope), and
one org can connect multiple workspaces of the same platform, so a two-segment
`slack:<uid>` form would allow same-org identity collisions. The workspace
value is **carried on the wire by the daemon** — the daemon already maintains
a physical transport scope per platform connection, and `EventSession` gains a
`transportScope` field (§4.1) that the CP persists verbatim into
`ownerIdentity`. The CP never reconstructs the scope from `platform` +
`channel` (ambiguous when an org connects multiple bots/workspaces), and the
design does not assume every adapter's integration record stores a usable
tenant key (Feishu's, for example, is not exposed the same way). A milestone
arriving **without** `transportScope` records no IM owner (`null`, fail
closed per §4.2) rather than a guessed one. Identity linking (§7) stores and
matches the same three-part tuple.

Matching is set membership: at request time the BFF computes the viewer's
**identity set** — today just `{ user:<userId> }`, later expanded with the
user's linked platform identities — and a `private` session is visible when
`ownerIdentity ∈ identitySet`.

Consequences:

- Before the identity mapping exists, a `private` IM DM session is an
  **owner-orphan**: no console user matches `slack:U…`, so only org owners see
  it. This is accepted — it errs toward hiding a DM rather than exposing it.
- When identity linking ships, those sessions become visible to the mapped
  user **automatically**, with no backfill: the stored `ownerIdentity` is
  already correct; only the viewer's identity set grows.
- The predicate is always additionally scoped by `orgId` and by agent
  visibility, so an identity match can never reach across orgs; the workspace
  segment above closes the remaining same-org, cross-tenant collision.

## 3. Data-model changes (`packages/control-plane/prisma/schema.prisma`)

New enum beside `ResourceVisibility`:

```prisma
enum SessionVisibility {
  private
  org
}
```

New columns on `SessionMeta`:

```prisma
orgId            String            // denormalized from agent.orgId at ingest
visibility       SessionVisibility @default(org)
ownerIdentity    String?           // §2 format; null for automation/legacy rows
visibilitySource VisibilitySource  @default(default)
```

```prisma
enum VisibilitySource {
  default           // classified by the §4.2 rules
  inherited_pending // A2A child awaiting parent resolution (§4.5)
  inherited         // settled from (or cascaded by) its parent
  explicit          // set by a human via §4.3 — never auto-overwritten
}
```

- `orgId` is denormalized so the list predicate and its index do not join
  `agent`. All existing paging indexes are `agentId`-prefixed; add
  `@@index([orgId, visibility, lastActivityAt(sort: Desc), id])` for the
  org-wide session list, keeping the existing keyset-pagination shape.
- No `sharedWith String[]` on sessions in this iteration. Per-session
  member-sharing can be added later with the same GIN pattern as agents;
  share-by-link (§8) covers the near-term "share this session" ask.

**Migration / backfill:** existing rows get `orgId` from their agent and
`visibility = 'org'`. Do **not** retro-classify DMs: the `thread === 'dm'`
convention is Slack/Discord-only (Feishu writes the chat id), and wrongly
flipping a session to `private` yanks it from members who can see it today.
Visibility tightening applies to **new sessions only**.

## 4. Classifying sessions at ingest

### 4.1 Protocol: new telemetry fields

`EventSession` (`packages/protocol/src/frames/telemetry.ts`) gains three
optional fields:

```ts
conversationKind?: 'dm' | 'group_dm' | 'channel'
transportScope?: string // trusted workspace/tenant scope for ownerIdentity, §2
launchCorrelationId?: string // Web API launch provenance, §4.4
```

The daemon already knows this (`NormalizedMessage.isDm` / `isGroupDm`,
`packages/daemon/src/messages/normalized.ts`); it is currently daemon-local and
never reaches the CP. The `thread === 'dm'` heuristic and an
`IntegrationChannel.kind` join were both considered and rejected: the former is
platform-inconsistent, the latter does not cover webhook/generic ingress and
moves a write-time fact to read time. All three fields are optional ⇒ old
daemons remain compatible (absent `conversationKind` = `channel` behavior,
i.e. `org`; absent `transportScope`/`launchCorrelationId` = no owner, fail
closed).

### 4.2 Default rules

The CP classifies once, in the `event/session` ingest path
(`ws/handlers/event-session.ts` → `session.recordMilestone`), first-wins like
the other origin scalars:

| Origin (how detected)                                 | `visibility`    | `ownerIdentity`                                                                                                                       |
| ----------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Webchat / Playground (`platform === 'webchat'`)       | `private`       | `user:<WebchatConversation.userId>` via `channel == conversationId` lookup; lookup miss ⇒ stays `private`, owner `null` (fail closed) |
| Web API session launch (§4.4 correlation)             | `private`       | `user:<launch principal userId>`; missing correlation ⇒ `private`, `null`                                                             |
| IM DM (`conversationKind` = `dm`)                     | `private`       | `<platform>:<workspace>:<uid>` (initiator)                                                                                            |
| IM group DM (`conversationKind` = `group_dm`)         | `org`           | `<platform>:<workspace>:<uid>` (initiator)                                                                                            |
| IM channel (`conversationKind` = `channel` or absent) | `org`           | `<platform>:<workspace>:<uid>` (initiator)                                                                                            |
| Agent-to-agent child (`triggeredBy` is an agent UUID) | inherits parent | inherits parent's `ownerIdentity`; parent unresolved ⇒ `private`, `null` (fail closed)                                                |
| Automation: cron / hook / dream                       | `org`           | `null`                                                                                                                                |

Notes:

- **Fail closed on missing ownership metadata.** A classification rule that
  defaults to `private` must never widen to `org` because a lookup failed —
  that would turn a metadata inconsistency into disclosure. An unresolvable
  owner yields `private` + `ownerIdentity = null` (an owner-orphan, visible to
  org owners only, recoverable via §4.3).
- Webchat `triggeredBy` is the console user's **email** (set in
  `routes/webchat-token.ts`), which degrades under devAuth and is not a stable
  key — hence the `WebchatConversation` lookup rather than trusting the wire
  value.
- **`ownerIdentity` is recorded for every human-triggered session regardless
  of visibility** (DM, group DM, and channel alike). It is orthogonal to the
  visibility default: for `org` sessions it is provenance and the anchor for
  §4.3 reclassification rights, not an access gate.
- `group_dm` defaults to `org`, like a channel: a multi-party conversation
  treated as `private` would hide it from its own participants, since the
  predicate can match only one owner. The initiator (or an org owner) can
  pull it `private` via §4.3.
- **Agent-to-agent children inherit.** A delegation from a private DM or
  Playground session copies the delegated prompt into the child transcript;
  classifying children `org` would expose that to every viewer of the target
  agent. The child takes the parent's `visibility` + `ownerIdentity` at
  ingest; §4.5 defines the durable reconciliation semantics for out-of-order
  arrival and later parent changes.

### 4.3 Changing visibility after the fact

`PUT /orgs/:orgId/sessions/:id/visibility` with body
`{ visibility: 'private' | 'org' }`. Allowed for the session owner (identity
match) and org owners; collaborators/viewers cannot re-classify other people's
sessions. This is the escape hatch for both directions: publishing a useful DM
transcript to the org, or pulling a channel/group-DM session private (its
recorded initiator — once identity linking makes them matchable — or an org
owner).

An explicit change sets `visibilitySource = 'explicit'`, which pins the row
against any later automatic reclassification (§4.5). **Tightening cascades to
descendants** (§4.5); the CP also notifies the owning daemon of the new
effective state (§5.1). The response/UI must surface the memory caveat from
§5.1: tightening stops future capture but does not scrub what agent memory
already distilled while the session was org-visible.

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
  `inherited`. A child that an org owner has meanwhile re-classified is
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
  decision by its owner or an org owner.

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

## 5. Enforcement points (control-plane)

The authoritative predicate, mirroring `canView`:

```ts
canViewSession(s, ctx, identitySet) =
  ctx.role === 'owner' || // governance exception
  s.visibility === 'org' ||
  (s.ownerIdentity != null && identitySet.has(s.ownerIdentity))
```

All of these already gate on agent visibility; each additionally applies the
session predicate:

| Surface                       | Where                                                                                     | Change                                                                                                                                                                                                                                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List + facets                 | `persistence/repositories/session.repo.ts` (`pageWhereSql` — raw SQL, not Prisma `where`) | `AND (visibility = 'org' OR owner_identity = ANY(:identitySet))`, skipped for org owners                                                                                                                                                                                                           |
| Detail / messages / tool-body | `http/routes/sessions.ts` `getOrgViewableSession`                                         | apply `canViewSession` after the agent gate; fail as 404                                                                                                                                                                                                                                           |
| Children                      | `session.repo.ts` `listChildren`                                                          | same predicate; invisible parent already renders `null`                                                                                                                                                                                                                                            |
| SSE                           | `http/routes/stream.ts`                                                                   | today filters per **agent**; must apply the session predicate to **every session-scoped envelope variant** — both `event/session` milestones and `event/session-activity` invalidations (the latter still expose `sessionId`, revision, and live activity), plus any future session-bearing frames |
| Usage                         | `http/routes/usage.ts`                                                                    | same predicate on session-grained reads; org-aggregate rollups stay org-visible                                                                                                                                                                                                                    |

Invariants preserved:

- Console **authorization** stays a CP concern: internal/daemon read paths
  keep the deliberate fail-open (`visibilityWhere(undefined)` semantics), and
  no message content ever flows because of visibility. The one daemon-facing
  addition is the §5.1 privacy bit pushed over the WS control channel — a
  capture gate, not an authorization check the daemon performs for readers.
- 404, never 403, for invisible sessions (no existence oracle).
- A `?triggeredBy=` / `?channel=` query filter remains a filter, not an
  authorization boundary; the predicate is applied regardless.

### 5.1 Agent-scoped memory is a bypass — must be plugged

Console read gates alone do not contain private content: **managed memory is
agent-scoped and shared across users.** A private DM/Playground turn can be
distilled into agent memory (including by dream sessions) and later surface —
via memory reads or recall in someone else's session — to any user who can
view the agent, bypassing every gate in the table above.

Origin inference alone cannot carry this: once §4.3 exists, **origin is not
effective visibility** — a channel session pulled `private` still looks like a
channel to the daemon, and a cross-daemon A2A child cannot infer its inherited
privacy from `isDm`/webchat/launch-correlation at all. The gate therefore has
two layers:

1. **Daemon-local initial state.** For turns the daemon can classify itself
   (`isDm`, `platform === 'webchat'`, §4.4 launch correlation) memory capture
   is excluded from the first turn, with no CP round-trip. For an A2A child,
   the delegation command carries the parent session's current privacy flag,
   so a private parent's children start excluded even across daemons; a
   delegation whose parent flag is unavailable starts excluded (fail closed).
2. **CP-pushed effective state.** The CP is the authority on effective
   visibility (§4.3 changes, §4.5 settlements and cascades). On every change
   it sends a `session/visibility` control frame over the existing daemon WS
   to the owning daemon (and to daemons running affected descendants), and
   the daemon updates its local capture gate. This is control signaling — the
   channel's stated purpose — and carries a single privacy bit per session,
   not message content.

**Already-captured memory is not scrubbed.** Distilled memory cannot be
reliably attributed back to source turns, so tightening a session stops
_future_ capture but does not retract what was distilled while it was
org-visible. This is a stated product caveat, surfaced in the §4.3 flow —
the guarantee is "private stops the transcript and stops feeding shared
memory from the moment of tightening", not retroactive amnesia.

Per-owner memory namespaces are a possible future relaxation, but the
exclusion gate is the shipping requirement — the `private` tier's guarantee
is dishonest without it. If it is deferred, the product docs must explicitly
narrow the guarantee ("private hides the transcript, not what the agent
learned from it"); silence is not an option.

## 6. Web console

- Session list / homepage: no new affordance needed for correctness — the BFF
  simply returns fewer rows. Add a visibility badge (lock icon for `private`)
  and, on the session detail page, the visibility toggle from §4.3 for those
  allowed to use it.
- The existing client-side "mine" heuristic
  (`packages/web/src/lib/session-trigger.ts` email/userId matching) stays as a
  display concern (the "you" label) but is no longer doing authorization work.

## 7. Identity linking (future, separate design)

A `UserIdentity` table (`userId`, `platform`, `workspace`, `platformUserId`,
verified-at, unique on the `(platform, workspace, platformUserId)` tuple —
matching the three-part identity format of §2) populated by an
explicit link flow (e.g. the bot DMs a code, the user pastes it in the
console). Once it exists, the BFF's identity-set computation reads it and
owner-orphan DM sessions light up for their owners retroactively — no session
backfill, per §2.

## 8. Share-by-link (future, separate design)

Modeled on `OrgInviteLink`: a `SessionShareLink` row with peppered `tokenHash`,
`displayTail`, `expiresAt`, `revokedAt`, `createdByUserId`. Read path is a
**separate, org-scope-free, read-only route** (the `/orgs/:orgId` subtree
404s non-members by design, so public reads cannot live there), proxying the
same bounded transcript reads the BFF already does. "Public" is therefore a
property of an active link's existence, not a third enum member — revoking the
link ends public access without touching the session row.

## 9. Test plan

- **Unit (`test:unit`):** `canViewSession` truth table (role × visibility ×
  identity match × orphan owner); ingest classification table from §4.2,
  including every fail-closed path (webchat lookup miss, unresolved launch
  correlation, unresolved parent, missing `transportScope`) and absent
  `conversationKind`; the §4.5 state machine — pending settlement is
  one-time and conditional (never overwrites `explicit`), tightening
  cascades transitively, widening never cascades.
- **Integration (`test:int`):** list/detail/SSE visibility for a two-member
  org (owner sees all; collaborator sees own private + org sessions only);
  SSE assertion that **neither** `event/session` nor `event/session-activity`
  for a private session reaches an unauthorized subscriber; keyset pagination
  stability under the new predicate; migration backfill (`org` + `orgId`) on
  seeded legacy rows; visibility PUT authorization matrix (initiator of an
  `org` channel session may pull it private; a non-owner collaborator may
  not).
