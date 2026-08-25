# Merged Conversation View

Status: draft for review
Owner: console/web + control plane
Related: [webchat-multi-agents.md](webchat-multi-agents.md) (§8/§9, milestone M3),
[session-visibility.md](session-visibility.md),
[architecture.md](architecture.md),
issue #415 (participants in agent standing context — the same
explicit-roster/emergent-roster duality, surfaced to agents instead of humans)

## 1. Summary

A conversation with several participants is one thing, but the console renders
it as N per-agent session pages — one per participating agent — because
sessions are agent-scoped 4-tuples (`platform:channel:thread:agentId`). This
design adds a **merged conversation view**: one page per conversation that
interleaves every participant's transcript — including each agent's private
work lanes (reasoning / tool steps), which today are only visible by switching
to that agent's own session page.

The view is **platform-neutral from day one** and ships with two adapters
together: **webchat** (multi-agent Playground conversations) and **Slack**
(threads where one or more agents participate alongside humans). It is a
read-composition layer only: no new content storage, no new daemon protocol,
no new authorization objects. The merge is computed in the browser over the
existing per-session read endpoints, so every architecture and visibility
invariant is inherited rather than re-implemented.

What each surface gains:

- **Webchat** — the live Playground already _is_ a merged view (every
  participant streams into one canvas). On refresh, the user currently lands on
  one agent's session page and the other participants' work lanes vanish. The
  merged view closes that live/persisted gap: refresh returns to the same
  merged canvas.
- **Slack** — a multi-bot ops thread becomes debuggable in one place: the
  thread timeline with each bot's reasoning and tool activity expandable
  inline, instead of tab-hopping across per-agent sessions to answer "why did
  this bot say that".
- **Both** — the sessions list stops showing N near-identical rows for one
  conversation.

## 2. Goals and non-goals

Goals:

1. One list row and one page per conversation, for webchat conversations and
   Slack threads alike.
2. The merged page shows the complete conversation in canonical order with
   per-participant attribution, each agent's work lanes collapsible inline.
3. Platform-neutral core (grouping key + ordering coordinate + dedupe rule +
   roster feed), with per-platform adapters — not a webchat feature with a
   Slack bolt-on.
4. Zero new content-plane surface: the CP still never persists or proxies
   anything beyond the existing bounded per-session reads.

Non-goals (v1):

- **No live streaming for the Slack merge.** The merged Slack page refreshes
  like today's session detail (poll/revalidate). Live console streaming of IM
  turns is future work that belongs to the CP ACP gateway track.
- **No conversation-level ACL.** There is no new shareable object; each
  transcript source is authorized independently by the existing session read
  policy (§7).
- **Per-agent session pages survive only where they are the conversation.**
  Single-agent sessions (the vast majority) keep today's page. For
  multi-participant conversations the per-agent page is no longer surfaced
  anywhere; existing deep links redirect to the merged page (§5.3).
- **No Telegram/Discord/Feishu adapters yet.** They are shaped like the Slack
  adapter (platform-assigned ordering coordinate, emergent roster) and can
  follow it mechanically once it exists.
- **No cross-thread channel view.** A conversation is one thread, mirroring
  the session model.

## 3. The conversation abstraction

A conversation is defined by four things. Everything else — rendering, turn
grouping, attribution — is shared.

|                             | Webchat                                                                                                                                                                                       | Slack                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Identity (grouping key)** | `conversationId` (the session's `channel`)                                                                                                                                                    | `(platform, tenantScope, channel, thread)` (§5.1)                                                |
| **Duplicate identity**      | canonical `postId` (minted once at origin — [webchat-multi-agents.md §5](webchat-multi-agents.md)), persisted on the row and exposed to the merge at C2; independent of collision-bumped `ts` | raw `ts` string (the platform message `ts`), identical in every participant's copy               |
| **Ordering**                | normalized event time (§6): canonical `at` (epoch ms) → µs                                                                                                                                    | normalized event time (§6): platform `ts` (decimal seconds) and daemon work-row stamps (ms) → µs |
| **Roster**                  | explicit, owner-assembled (`webchat_conversation_agent`; served on the session detail DTO)                                                                                                    | emergent — derived from the merged rows (senders + trusted a2a bots)                             |
| **Composer**                | full send (fans out to the roster, all-respond semantics)                                                                                                                                     | read-only; "Open in Slack" deep link (`threadUrl`)                                               |

Two observations that make the Slack adapter _cheaper_ than the webchat one:

- Slack's platform `ts` is exactly the canonical duplicate-identity coordinate
  webchat had to mint for itself — and the mixed timestamp **domains** (platform
  decimal seconds for text rows vs daemon millisecond stamps for work rows) are
  an already-solved problem: the daemon store normalizes every stored form onto
  one epoch-microsecond axis for its own chronological reads
  (`transcriptEventTimeUs` + `(eventTimeUs, seq)` paging in `local-store.ts`);
  the merge reuses that normalization (§6) and never compares raw `ts` for
  order.
- §8.4 mid-thread backfill means every participating agent's transcript
  already contains the full thread _text_. The merge adds each agent's work
  lanes — the one thing per-agent pages structurally cannot show together —
  and dedupes the N text copies.

The grouping key deliberately matches the daemon's own session identity
(`platform:channel:thread:agentId` minus the agent): the conversation is the
set of sessions that share a thread. `SessionMeta` already stores
`platform/channel/thread` denormalized per row, so grouping is a metadata
query — no schema change.

## 4. Reading the conversation (no new content plane)

The defining constraint from
[architecture.md](architecture.md) holds: the CP
stores only metadata; transcript bodies are daemon-local and reach the console
as bounded, authorized, non-persisted reads (`GET /sessions/:id/messages`).

The merged view therefore reads exactly what the per-agent pages read:

1. Resolve the conversation's member sessions (one CP metadata query, §5).
2. Fetch each member session's transcript through the **existing** per-session
   messages endpoint — one bounded read per member, each independently
   authorized, each proxied live from its owning daemon (members may live on
   different daemons; that is already how cross-daemon a2a threads work).
3. Merge client-side (§6) in a pure, unit-testable module
   (`packages/web/src/lib/conversation-merge.ts`, mirroring how
   `webchat-lanes.ts` isolates lane resolution).

A member read that fails with 403/404 (restricted agent) or a daemon-offline
error degrades to a **partial merge** (silently for authorization failures,
with a notice only for offline daemons — §7) — never a
page-level failure, because the remaining sources are still a legitimate view
of the thread (it is what any one participant legitimately sees today).

Rejected alternative: a CP-side `/conversations/:key/messages` fan-out
endpoint. It would centralize retries and paging, but it puts the CP in the
business of joining message content across daemons — a step toward the content
plane it must not become — and re-implements per-source authorization that the
per-session endpoint already enforces. Client-side composition keeps the CP's
role unchanged. (If paging coordination proves painful in practice, a BFF
aggregation that still streams per-source and persists nothing is the fallback
— explicitly deferred.)

## 5. Conversation identity, grouping, and the list

### 5.1 Key encoding

- Webchat: `conversationId` (already a UUID; the session row's `channel`).
- Slack: `platform:tenantScope:channel:thread` (empty scope segment when
  unknown), base64url-encoded for the URL. `thread` falls back to the
  channel-root marker exactly as sessions record it, so a channel-root
  conversation groups its root-thread sessions.

Raw `(channel, thread)` coordinates are not a shared namespace across
installations — the daemon already keeps them apart (its session key and
transcript channel key both carry a scope). The conversation key needs a
scope too, and the right one already crosses the wire: `event/session`
carries the protocol's **durable workspace/tenant scope**
(`EventSession.transportScope` — a Slack team id, Feishu tenant key, or a
minted stable per-integration scope; the daemon fills it for Socket Mode and
HTTP ingress alike once the workspace is known). That field is explicitly
NOT the daemon session key's credential-derived physical transport scope —
that value is hashed from bot/app tokens and rotates with them, so grouping
on it would split a workspace's conversations at every token rotation
(review finding; the two scopes also carry different security semantics —
the durable one already anchors `ownerIdentity` for session visibility).
C1 persists the durable value under an unambiguous CP name — a nullable
`SessionMeta.tenantScope` column (today it is only folded into
`ownerIdentity`, not queryable) — and the conversation key is
`(platform, tenantScope ?? '', channel, thread)`. Pre-upgrade rows carry a
null scope and may transiently render apart from post-upgrade rows of the
same thread — a display artifact that ages out with activity, accepted for
C1.

### 5.2 Grouped list is the default

`GET /sessions` returns **conversations by default**; `?view=flat` returns
today's raw session rows. The console passes the same parameter through (a
URL-addressable diagnostic mode, defaulting to grouped) and keeps it on links
from the flat list into a raw session. This deliberately changes the
default response shape of a public REST operation — accepted by product
decision: console and CP ship on the same train, external consumers pin
`view=flat`, and the OpenAPI doc describes both shapes on the operation.

The default response is one row per conversation, computed over the same
visibility-filtered row set the flat list uses (a session invisible to the
caller never contributes):

```
{
  conversations: [{
    key,                 // §5.1
    platform, channel, thread, channelName, threadUrl,
    title,               // primary participant's title (webchat) / first session's (slack)
    lastActivityAt,      // max over members
    activityState,       // any member active ⇒ active
    participants: [{ agentId, sessionId, name }]   // VISIBLE member sessions, roster order (webchat) / first-seen (slack)
  }],
  nextCursor
}
```

Pagination stays newest-first with **no aggregate query**, but naive
streaming dedupe is not enough: dedupe state resets at every page boundary,
so a conversation whose members' activity straddles a cursor would reappear
on a later page (review finding). The stateless rule is **emit-at-max**,
made exact by two requirements (review finding):

- **Total order, not bare `lastActivityAt`.** The representative is the
  maximum member row under the flat cursor's full tuple
  `(lastActivityAt, startedAt, id)` — two members sharing the same
  millisecond cannot both win, so a conversation is emitted exactly once.
- **The probe applies the outer scan's own predicate.** The exists-newer
  check runs under the identical org and session-visibility filter —
  otherwise a newer invisible or cross-org member row would suppress a
  conversation the caller can legitimately see. Grouping is
  visibility-filtered, so the representative is the caller's newest VISIBLE
  member.

A scanned row yields its conversation only if no same-key member row is
strictly greater in that tuple under that predicate — one indexed probe per
candidate on the C1 index
`(orgId, platform, tenantScope, channel, thread, lastActivityAt, startedAt, id)`
(replacing today's `@@index([platform, channel])`; it also serves the member
backfill). Rows failing the probe are skipped: their conversation already
surfaced (or will) at its true max position, on whatever page that position
falls. The scan itself still pages on the existing
`session_meta_org_visibility_page_idx`, so grouped cost ≈ the flat scan + one
index probe per scanned row + one member-backfill batch per page.

Direct loads of `/conversations/:key` need the reverse lookup — key in hand,
members unknown. The activity-paginated grouped list cannot serve that
(scanning pages for a key is unbounded and misses idle conversations), so C1
also defines a **key-addressed resolver**: `GET /sessions?conversationKey=…`,
a bounded metadata-only query on the same C1 index — every row matching
`(orgId, platform, tenantScope, channel, thread)` under the same
org/visibility predicate, collapsed to the current session per agent (§6),
returned in the grouped row shape. Transcript bodies still flow through the
existing per-session endpoints; the resolver reads the same `SessionMeta`
rows the list reads, so no content-plane surface is added.

Single-agent conversations (the overwhelming majority) come back as
1-participant rows — the web renders those exactly like today's session rows,
so grouped simply IS the list, with no toggle in the default UI.

Invisible members are simply **absent** — no count, no placeholder. The
established session-visibility bar is that a hidden session's existence is
itself hidden (a hidden parent is indistinguishable from no parent); the
grouped list and the merged page both hold to it (§7).

### 5.3 Routes and cross-links

- `/conversations/:key` — the default surfaced page for a multi-participant
  conversation.
- Grouped Sessions list rows link here when `participants.length > 1`, to the
  per-agent session page otherwise (for a single-agent session that page IS
  the conversation page — no change for the common case). `view=flat` rows
  always link to their raw `/sessions/:id?view=flat` page.
- Existing `/sessions/:id` deep links (GitHub check footers, shared URLs,
  crumbs) whose session belongs to a multi-participant conversation
  **redirect** to `/conversations/:key`. The landing carries no per-participant
  focus: it opens the merged conversation exactly as any other entry point
  does, with no scroll jump and no highlighted block — "whose perspective was
  linked" is not worth a visual state the reader did not ask for. The
  header's participant selector remains available for picking whose
  Workspace/Details the header shows. The explicit `/sessions/:id?view=flat` diagnostic route
  suppresses that redirect and keeps `view=flat` through the session rail,
  lineage links, list back-navigation, and copied links.
- Participant chips link to the agent's page (`/agents/:id`); session-level
  lineage navigation lifts to the conversation level (§9).
- Webchat Playground adoption: a live multi-agent playground session reopened
  after refresh lands on `/conversations/:conversationId` instead of the
  primary's session page — this is what closes the live/persisted gap.

## 6. The merge algorithm

Member resolution first collapses the location's session rows to **one
current session per `agentId`** (newest `lastActivityAt`): an agent whose ACP
session was recreated leaves superseded `SessionMeta` rows at the same
location, and those must not become duplicate sources or fetch obsolete
session ids — the daemon transcript is keyed by `(channel, thread)`, so the
current session's read already covers the whole thread. Superseded rows stay
reachable only through `view=flat`.

Inputs: per-member transcript pages, each row carrying
`(sender, ts, kind, text, attachments, body, trustedAgentBot)` plus its source
session (`sessionId`, `agentId`).

1. **Union** all rows from all readable sources.
2. **Dedupe is scoped to `kind === 'text'` rows and is provenance-explicit**
   (identity equality only — never order). A row deduplicates across sources
   only when it carries an identity minted once for every copy:
   - **Webchat: canonical `postId`.** Timestamp shape cannot establish
     provenance here — canonical `at` and daemon-local `monotonicTs()` stamps
     share the integer-millisecond domain, so a local a2a report-back in one
     source colliding with a distinct canonical post in another would be
     wrongly merged (review finding). Instead, C2 has the daemon persist the
     origin-minted `postId` on webchat text rows (nullable column) and expose
     it on the messages DTO; the merge dedupes webchat rows only on equal
     `postId`. This is also more correct than raw `ts` in the OTHER
     direction: a collision-bumped copy carries a different `ts` than its
     siblings, which raw equality would fail to dedupe — `postId` identifies
     copies regardless of the bump, and the author copy's coordinates win
     for placement. Rows without a `postId` (daemon-local report-backs,
     pre-C2 legacy rows) never dedupe across sources — failing toward a
     visible duplicate, never toward data loss.
   - **Slack: provider-native `ts` form.** Rows qualify only when `ts` is
     exactly `^\d+\.\d+$` (anchored, dot escaped) — the platform message
     id, identical in every delivery; an integer `monotonicTs()` value can
     never match. Daemon-local text rows are single-source by construction
     and never dedupe: two daemons can mint the same millisecond for
     distinct rows.

   The merge tests carry integer-local vs decimal-provider fixtures for the
   Slack predicate, plus webchat canonical-vs-local same-millisecond
   collision and collision-bumped-copy fixtures. Work-lane rows never dedupe
   (step 3), so a coincidental `ts` collision between a text row and a
   tool/reasoning row is inert.
   Precedence among copies:
   - **Author copy wins**: the row whose source session's `agentId` matches
     the row's author (`sender === source.agentId`, or the daemon-relabeled
     own-bot frames). The author copy is the full-fidelity one.
   - Human/system rows (identical in every copy): first source in CANONICAL
     order — a `sessionId` sort on every platform, decoupled from the
     resolver's activity-ordered response (which is mutable and would flip
     the surviving copy between refreshes) — so the merge is deterministic
     across reloads.

3. **Work-lane rows pass through un-deduped**: `kind: tool | reasoning` rows
   exist only in their author's transcript. They interleave by `ts` and render
   inside that agent's collapsible work lane, exactly as on its own page.
4. **Sort on the normalized event-time axis, never on raw `ts`.** Raw `ts`
   mixes domains (Slack decimal seconds for text rows vs daemon millisecond
   stamps for work rows) and is an identity, not an order. The daemon store
   already normalizes every stored form onto epoch microseconds for its own
   chronological reads (`transcriptEventTimeUs`); the merge module implements
   the same normalization (the console's timestamp parser already matches it
   row-wise) and sorts ascending; ties group by source (deterministic across
   reloads) and then follow each source's own row order — a hierarchical,
   transitive tie-break that never reorders a source's internal sequence.
   (A sender-first tie-break was rejected in review: it reverses same-source
   rows sharing a timestamp and breaks comparator transitivity.)
5. **Attribution and turn grouping reuse the session detail machinery**: the
   merged row list feeds the same turn builder the per-agent page uses — the
   right side is reserved for the viewer, every agent renders as its own
   left-side block via the `agentId`-keyed grouping (`sameBotSpeaker`), humans
   render as sender rows. Each author row retains its maximal owner-authored
   run from the source transcript, so another agent's private work can
   interleave chronologically without splitting the source-local turn into
   several blocks. No new rendering rules; the merged view is "the per-agent
   page fed a union instead of one source".

Notes:

- **Supersession needs nothing**: a regenerated webchat answer is already the
  only committed reply in its author's transcript; stale generations were
  live-stream chrome and never persisted.
- **A mid-conversation joiner's** transcript starts late; earlier rows come
  from the other sources' copies. The union is complete as long as any one
  participant observed the region.
- **Paging**: v1 loads each source's latest page and merges; "load earlier"
  fetches the earlier page of whichever sources still overlap the requested
  window (the merge module tracks per-source cursors). This is the one place
  client-side composition costs real logic — it is contained in the pure
  module and unit-testable.

## 7. Visibility and partial merges

No new authorization surface. Each source is fetched under the existing
session read policy; the merge renders what comes back:

- A **restricted participant** (agent the caller cannot view) contributes no
  source: its work lanes and its authored copies are absent. Its _messages_
  may still appear — via other participants' recipient copies, exactly as
  they appear on any per-agent page today. Hiding a session hides an agent's
  private work, not the thread messages every participant legitimately
  received.
- **Authorization-hidden sources are silent.** No count, no placeholder —
  disclosing that hidden records exist is itself a leak by the
  session-visibility bar this codebase already holds (a hidden parent is
  indistinguishable from no parent). Only non-authorization failures surface
  a notice: a daemon-offline source degrades with "some participants' records
  are on an offline daemon" — an operational condition, not a protected fact.
- **Webchat send fence unchanged**: the composer on a merged webchat
  conversation resumes through the existing conversation-token mint, which
  already requires _all_ participants viewable. A caller with partial view
  gets a read-only merged page with the standard error on send.
- The webchat per-conversation privacy model (private by default; the owner
  may make a session org-visible, which also lets other non-viewer members
  continue the conversation) and
  Slack's org-visible default both pass through untouched — the merged page is
  as visible as its most visible member session, because that is literally
  what it fetches.

## 8. Composer and live behavior

|             | Webchat conversation                                                                                                                                                | Slack thread                                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Composer    | Full: same conversation resume + all-respond fan-out as today's adopted session page; placeholder "Message everyone…"                                               | Single-agent continuation via the session detail page (webchat-cross-integration-continuation.md); the MERGED multi-agent Slack view keeps "Open in Slack" (threadUrl) — its composer is that feature's multi-agent follow-up. |
| Live        | On resume the existing relay socket streams all lanes into the merged canvas — identical to the live Playground (which this page effectively replaces post-refresh) | SWR revalidate / poll, like the session detail today. Streaming deferred to the ACP gateway track.                                                                                                                             |
| Typing/busy | per-participant, from existing lane state                                                                                                                           | activity dot from `activityState`, as today                                                                                                                                                                                    |

## 9. Conversations and session lineage (parent/child)

Sessions carry a second graph besides the conversation: **lineage** —
`parentSessionId` edges recorded when one session wakes another via
`sendMessage`, plus the sibling/child links the session detail route derives
from them. The two graphs are orthogonal by construction:

- a **conversation groups by location** — sessions sharing a thread ("who is
  in the room");
- **lineage links by causation** — who woke whom, freely crossing rooms.

The design connects them at three points:

### 9.1 Intra-conversation edges are attribution, not navigation

The classifying rule is **whether the edge's two sessions share the
conversation key** — not the wake form. An in-thread `sendMessage` wakes an
agent into the same `(platform, channel, thread)`, so both endpoints are
already in the room; the merged view shows both parties in full, and the
lineage edge contributes only attribution. Membership neither grows
nor splits because of the edge, and intra-conversation edges are **excluded**
from the lifted navigation in §9.2 — otherwise a co-participant that is also
a lineage child (A wakes B and C into the same thread: room-mates AND
lineage-siblings) would be listed twice.

Attribution still has to be **surfaced**, and the merged transcript cannot do
it: it interleaves its members by time, so "who woke whom" is unreadable from
the ordering. The rail carries it, anchored on the OPEN row — never as a
navigation row, which would name a member of this room as another conversation
and link back to the page you are already on. Anchoring on the open row is what
keeps it directional: the representative is the newest visible member and
rotates whenever either agent speaks, and one A → B edge is A's child and B's
parent at once, so a side-agnostic filter would mislabel one of the two. Rows
are deduplicated against the ordinary list exactly as family rows are, which
preserves the displayed-once invariant above.

The rail's Related tree is **exactly three levels — whatever woke the open row,
the open row, whatever it woke — and direction is drawn as position on them**,
with no group headings. An in-room `wokenBy` and a cross-room parent are one
edge seen from two locations, so they share level 0 rather than nesting; `woke`
and cross-room delegations share level 2 for the same reason. Nesting them
would assert a chain the lift does not have: §9.2 unions parents across every
member **without recording which member each one woke**. The headings this
replaced ("Parent conversation" / "Delegated by" / "Delegated to" /
"Delegations") each spent a line restating the indent directly beneath them,
and usually the title too, since a conversation is named after its first
message — typically the human @mentioning the very agent that then delegates.
Kind is already in the row: an agent mark and a name that do not click, against
a platform mark and a title that do. The words move into each row's hover
tooltip — **the same two words for the navigation row and the attribution row**,
since they are one edge — and stay as `sr-only` text besides, because
indentation is a visual relation that a screen reader hears nothing of and a
tooltip never reaches.

Each row is built around the AGENT, not the session: agent mark and agent name
(org roster, then the relation's own projection, then the raw id). A session
title cannot carry attribution here — participants of one thread routinely
share one, since it is derived from the same first message, and they
necessarily share the platform — so a row showing title and platform would
name nobody.

These rows do NOT navigate, which is this section's title taken literally.
Their target is a participant of the conversation already on screen, so
`/sessions/:id` would redirect straight back to this page — §5.3 carries no
`?focus`, by decision — costing a round trip to land the reader where they
already were. They render the fact instead: no link, and no pin, which is a
shortcut to another conversation.

Co-membership itself is NOT siblinghood: "sibling sessions" keeps its precise
lineage meaning (other children of the same parent session). Sessions in one
room are already fully related by conversation membership — encoding that
relation a second time as synthetic lineage would demand a fabricated common
parent (a user message is not a session) and retroactive edge maintenance as
the roster grows. The per-agent detail DTO's parent/sibling/child computation
is untouched by this design.

### 9.2 Cross-conversation edges lift to conversation-level navigation

A DM-form (channel-free) wake creates the child session on its own a2a
coordinate — its own, usually single-member, conversation. That edge crosses
conversations, and its navigation today lives on the per-agent session detail
page (parent/sibling/child links) — a page this design stops surfacing for
multi-participant conversations. The merged page therefore inherits it at
conversation level: the union of member sessions' lineage links whose target
lies in a DIFFERENT conversation (§9.1 filters the intra-room ones), each
mapped to the conversation its target session belongs to, rendered on §9.1's
three levels — parents above the open row, child conversations below it,
grouped by the waking member. No new CP surface — the member detail DTOs
already carry the links, and mapping a session to its conversation key is a
metadata lookup.
(C2 ships the links; grouping delegations by waking turn is C3.)

The lifted shape carries **all** waking conversations in one list, and carries
no sibling slot at all. A conversation has as many parents as it has members
woken from elsewhere, and they are peers — the union that produced them does
not record which member each one woke, so nothing ranks one of them first.
Level 0 holds every one of them, alongside `wokenBy` for the same reason.

An earlier shape kept a single `parentSession` and spilled the remainder into
`siblingSessions`, which is where it collided with §9.1's last paragraph: on a
single-session page that field means the other children of ONE parent, and the
rail draws it at the open row's own level below a divider. So a conversation
that WOKE this one was rendered beside the row it woke rather than above it —
two meanings in one slot, and the wrong one drawn. The conversation-level
structure therefore names only what it actually has, parents and delegations,
and the per-session DTO keeps `siblingSessions` to itself.

One invariant stays absolute: **lineage never changes membership**. A child
spawned elsewhere is linked, never merged in — merging by causation would
break the location-pure dedupe (§6) and blur the structural guarantees around
context delivery (context frames never activate; a delegation is not a
participant).

### 9.3 Report-backs surface naturally

A child's `sessionId`-form reply to its parent is delivered only into the
parent session's transcript. In the merged view it appears exactly once (it
exists in exactly one source), attributed to the child agent inside the
parent's conversation — the union needs no special casing. Cron / hook /
headless sessions are ordinary single-member conversations and keep their
lineage links unchanged.

## 10. Milestones

Per the product decision, **webchat and Slack ship together in each milestone**
— the platform-neutral core is the point, and building webchat-only first is
how divergence starts.

- **C1 — grouped sessions list.** CP grouped-by-default list with the
  `view=flat` escape hatch (emit-at-max scan + member backfill, §5.2), the
  key-addressed member resolver (`conversationKey=…`, §5.2), the
  `(orgId, platform, tenantScope, channel, thread, lastActivityAt, startedAt, id)`
  index, persistence of the already-reported durable tenant scope as
  `SessionMeta.tenantScope` (§5.1), grouped rendering (participant avatar
  stack, single row per conversation, both platforms). Fixes the most
  visible confusion (N rows per conversation).
- **C2 — merged page.** `conversation-merge.ts` (union/dedupe/order, unit
  tests over both adapters' fixtures), `/conversations/:key` route, renderer
  reuse, partial-merge notices, session→conversation deep-link redirects,
  conversation-level lineage links (§9.2). Daemon
  prerequisite: persist the canonical `postId` on webchat text rows and
  expose it on the messages DTO (§6 step 2). Webchat composer wired through
  the existing adoption path; Slack read-only with deep link. Playground
  refresh lands here.
- **C3 — polish.** Conversation-level usage roll-up (sum of member sessions),
  "load earlier" cross-source paging, mobile pass, default-collapsed work
  lanes for non-focused participants.

## 11. Alternatives considered

- **CP-side merge endpoint** — rejected in v1 (§4): moves the CP toward the
  content plane and duplicates per-source authorization. Revisit only if
  client paging proves unworkable, and then as a non-persisting BFF
  aggregation.
- **Materializing a conversation object** (row per conversation, membership,
  ACL) — rejected: webchat already has its object (the conversation row), and
  Slack's membership is emergent; a second registry would drift from both.
  The conversation stays a _view_ over sessions.
- **Slack composer in the console** — out of scope for this design; the
  identity/product question is answered by
  [webchat-cross-integration-continuation.md](webchat-cross-integration-continuation.md)
  (bot-attributed mirror, single-agent v1); the merged view's multi-agent
  composer is that feature's follow-up.
- **Webchat-first, Slack later** — rejected by product decision: the two
  adapters are what keep the core honest; Slack is also the higher-value
  debugging surface (multi-bot ops threads).

## 12. Decision log

1. **Grouped list replaces the flat list as the default.** `GET /sessions`
   returns conversations; `view=flat` (a UI parameter passed through to the
   CP and preserved on raw session links) returns raw session rows. Accepted
   as a deliberate change to the operation's default response shape.
2. **Pagination is emit-at-max — still no aggregate query.** A scanned row
   yields its conversation only when it is the conversation's newest member
   row under the full `(lastActivityAt, startedAt, id)` total order AND the
   outer scan's own org/visibility predicate (indexed exists-newer probe on
   the C1 index, §5.2); the plain streaming-dedupe shortcut was wrong across
   page boundaries and is rejected (review finding).
3. **Per-agent session pages are not surfaced for multi-participant
   conversations.** Every entry point leads to the merged page; existing
   session deep links redirect to it plainly (no `?focus` scroll/highlight —
   revised, see §5.3); the conversation composer exists only on the merged
   page.
4. **Webchat and Slack adapters ship together** in every milestone — the
   platform-neutral core is the point.
5. **Lineage never changes conversation membership** — parent/child edges are
   linked (attribution in-thread, navigation across conversations), never
   merged (§9).
6. **Review revisions (v2).** Authorization-hidden members are absent,
   never counted; ordering uses the daemon's normalized event-time axis
   (`transcriptEventTimeUs` semantics) with raw `ts` demoted to duplicate
   identity; member resolution collapses to one current session per agent,
   retiring superseded ACP rows from the merge. (v2's scope proposal is
   superseded by v3's durable tenant scope.)
7. **Review revisions (v3).** Conversation scope is the protocol's DURABLE
   workspace/tenant scope (`EventSession.transportScope`, persisted as
   `SessionMeta.tenantScope`) — never the credential-derived rotating
   physical scope; emit-at-max selects its representative by the full
   `(lastActivityAt, startedAt, id)` tuple under the outer scan's own
   org/visibility predicate; text-row dedupe is provenance-aware (webchat
   canonical `at` always, Slack only provider-native decimal `ts`,
   daemon-local millisecond rows never).
8. **Review revisions (v4/v5).** Direct conversation loads resolve members
   through a bounded key-addressed metadata query
   (`GET /sessions?conversationKey=…`); the Slack provenance predicate is
   exact (`^\d+\.\d+$`); webchat duplicate identity moves from raw `at`
   equality to the origin-minted canonical `postId` persisted on the row —
   timestamp shape cannot prove provenance in webchat's integer-millisecond
   domain, and `postId` also survives collision-bumped copies. No-`postId`
   rows never dedupe (duplicate over data loss).
9. **Co-membership is not siblinghood.** Sessions sharing a room relate
   through conversation membership only; "sibling" keeps its lineage meaning
   (same parent session). An edge whose endpoints share the conversation key
   renders as attribution and is excluded from lifted navigation — the
   room-mates-AND-siblings overlap is displayed once, not twice (§9.1).
   Attribution is surfaced in the rail as tree position around the open row —
   waker above it, woken below — and kept out of the family shape, whose parent
   slot means "another conversation" and navigates away (§9.1). The lifted
   family has NO sibling slot: every waking conversation is a parent and
   shares the level above the open row, so the per-session meaning of
   `siblingSessions` is never borrowed to hold one (§9.2).
