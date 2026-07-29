# Session Visibility

> **Status:** Proposed. Nothing in this document is implemented yet.
>
> **Scope:** protocol + control-plane + web. The daemon changes are limited to
> reporting one extra field on the existing `event/session` telemetry frame;
> the execution data plane is otherwise unaffected. Sharing is enforced only on
> Console/BFF read paths — it never crosses the daemon wire, consistent with
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
([resource-visibility.md §14.3](resource-visibility.md) lists it as future
work).

**Decision: the owner is a namespaced identity string, not a `User` FK.**

```
ownerIdentity :=
  user:<app_user_id>          — console-originated (webchat, Web API launch)
  <platform>:<platform_uid>   — IM-originated, e.g. slack:U0123ABCD, feishu:ou_...
```

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
- Platform uids are scoped per workspace/tenant (a Slack user id is unique per
  workspace). The predicate is always additionally scoped by `orgId` and by
  agent visibility, so cross-org collisions are not reachable; a same-org
  collision across two workspaces of the same platform is theoretical and
  accepted. If it ever matters, the identity format can grow a tenant segment
  (`slack:<team>:<uid>`) without a schema change.

## 3. Data-model changes (`packages/control-plane/prisma/schema.prisma`)

New enum beside `ResourceVisibility`:

```prisma
enum SessionVisibility {
  private
  org
}
```

Three new columns on `SessionMeta`:

```prisma
orgId         String            // denormalized from agent.orgId at ingest
visibility    SessionVisibility @default(org)
ownerIdentity String?           // §2 format; null for automation/legacy rows
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

### 4.1 Protocol: one new field

`EventSession` (`packages/protocol/src/frames/telemetry.ts`) gains:

```ts
conversationKind?: 'dm' | 'group_dm' | 'channel'
```

The daemon already knows this (`NormalizedMessage.isDm` / `isGroupDm`,
`packages/daemon/src/messages/normalized.ts`); it is currently daemon-local and
never reaches the CP. The `thread === 'dm'` heuristic and an
`IntegrationChannel.kind` join were both considered and rejected: the former is
platform-inconsistent, the latter does not cover webhook/generic ingress and
moves a write-time fact to read time. Optional field ⇒ old daemons remain
compatible (absent = `channel` behavior, i.e. `org`).

### 4.2 Default rules

The CP classifies once, in the `event/session` ingest path
(`ws/handlers/event-session.ts` → `session.recordMilestone`), first-wins like
the other origin scalars:

| Origin (how detected)                                                        | `visibility` | `ownerIdentity`                                                            |
| ---------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------- |
| Webchat / Playground (`platform === 'webchat'`)                              | `private`    | `user:<WebchatConversation.userId>` via `channel == conversationId` lookup |
| Web API launch (`launchId` present, launch principal known)                  | `private`    | `user:<launch creator userId>`                                             |
| IM DM (`conversationKind` = `dm`)                                            | `private`    | `<platform>:<triggeredBy>`                                                 |
| IM group DM (`conversationKind` = `group_dm`)                                | `org`        | `null`                                                                     |
| IM channel (`conversationKind` = `channel` or absent)                        | `org`        | `null`                                                                     |
| Automation: cron / hook / dream / agent-to-agent (`triggeredBy` prefix/UUID) | `org`        | `null`                                                                     |

Notes:

- Webchat `triggeredBy` is the console user's **email** (set in
  `routes/webchat-token.ts`), which degrades under devAuth and is not a stable
  key — hence the `WebchatConversation` lookup rather than trusting the wire
  value. Under devAuth the stub principal has no conversation row mismatch
  concern; if the lookup misses, fall back to `org`.
- `group_dm` defaults to `org`, like a channel: `ownerIdentity` can only
  record one person, so treating a multi-party conversation as `private`
  would hide it from its own participants. Multi-participant conversations
  are treated as team-visible; a participant who wants it hidden can
  re-classify it via §4.3 once identity linking makes them the recognizable
  owner (org owners can always re-classify).

### 4.3 Changing visibility after the fact

`PUT /orgs/:orgId/sessions/:id/visibility` with body
`{ visibility: 'private' | 'org' }`. Allowed for the session owner (identity
match) and org owners; collaborators/viewers cannot re-classify other people's
sessions. This is the escape hatch for both directions: publishing a useful DM
transcript to the org, or pulling a channel-born session private (org owners
only, since a channel session has no owner).

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

| Surface                       | Where                                                                                     | Change                                                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| List + facets                 | `persistence/repositories/session.repo.ts` (`pageWhereSql` — raw SQL, not Prisma `where`) | `AND (visibility = 'org' OR owner_identity = ANY(:identitySet))`, skipped for org owners                                                              |
| Detail / messages / tool-body | `http/routes/sessions.ts` `getOrgViewableSession`                                         | apply `canViewSession` after the agent gate; fail as 404                                                                                              |
| Children                      | `session.repo.ts` `listChildren`                                                          | same predicate; invisible parent already renders `null`                                                                                               |
| SSE                           | `http/routes/stream.ts`                                                                   | today filters per **agent**; must additionally drop `event/session` envelopes for invisible sessions, else private-session live updates leak org-wide |
| Usage                         | `http/routes/usage.ts`                                                                    | same predicate on session-grained reads; org-aggregate rollups stay org-visible                                                                       |

Invariants preserved:

- The daemon wire is unaffected: internal reads keep the deliberate
  fail-open (`visibilityWhere(undefined)` semantics) — visibility is a Console
  concern, never an execution-plane concern.
- 404, never 403, for invisible sessions (no existence oracle).
- A `?triggeredBy=` / `?channel=` query filter remains a filter, not an
  authorization boundary; the predicate is applied regardless.

## 6. Web console

- Session list / homepage: no new affordance needed for correctness — the BFF
  simply returns fewer rows. Add a visibility badge (lock icon for `private`)
  and, on the session detail page, the visibility toggle from §4.3 for those
  allowed to use it.
- The existing client-side "mine" heuristic
  (`packages/web/src/lib/session-trigger.ts` email/userId matching) stays as a
  display concern (the "you" label) but is no longer doing authorization work.

## 7. Identity linking (future, separate design)

A `UserIdentity` table (`userId`, `platform`, `platformUserId`, verified-at,
unique on `(platform, platformUserId)` per org or globally) populated by an
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
  identity match × orphan owner); ingest classification table from §4.2
  including webchat-lookup fallback and absent `conversationKind`.
- **Integration (`test:int`):** list/detail/SSE visibility for a two-member
  org (owner sees all; collaborator sees own private + org sessions only);
  keyset pagination stability under the new predicate; migration backfill
  (`org` + `orgId`) on seeded legacy rows; visibility PUT authorization
  matrix.
