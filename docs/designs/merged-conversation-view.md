# Merged Conversation View

Status: draft for review
Owner: console/web + control plane
Related: [webchat-multi-agents.md](webchat-multi-agents.md) (§8/§9, milestone M3),
[session-visibility.md](session-visibility.md),
[daemon-centric-architecture.md](daemon-centric-architecture.md),
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

|                             | Webchat                                                                                                                                                               | Slack                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Identity (grouping key)** | `conversationId` (the session's `channel`)                                                                                                                            | `(platform, channel, thread)`                                                                    |
| **Duplicate identity**      | raw `ts` string (== canonical `at` minted at origin, collision-bumped — [webchat-multi-agents.md §5](webchat-multi-agents.md)), identical in every participant's copy | raw `ts` string (the platform message `ts`), identical in every participant's copy               |
| **Ordering**                | normalized event time (§6): canonical `at` (epoch ms) → µs                                                                                                            | normalized event time (§6): platform `ts` (decimal seconds) and daemon work-row stamps (ms) → µs |
| **Roster**                  | explicit, owner-assembled (`webchat_conversation_agent`; served on the session detail DTO)                                                                            | emergent — derived from the merged rows (senders + trusted a2a bots)                             |
| **Composer**                | full send (fans out to the roster, all-respond semantics)                                                                                                             | read-only; "Open in Slack" deep link (`threadUrl`)                                               |

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
[daemon-centric-architecture.md](daemon-centric-architecture.md) holds: the CP
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
- Slack: `platform:transportScope:channel:thread` (empty scope segment when
  null), base64url-encoded for the URL. `thread` falls back to the
  channel-root marker exactly as sessions record it, so a channel-root
  conversation groups its root-thread sessions.

Thread identity in this system is `(platform, channel, thread)` **plus the
daemon's `transportScope`** wherever a shared ingress multiplexes
installations — the scope is already part of the daemon session key and of
the daemon's transcript channel key, but it is not reported to the CP today.
C1 closes that gap: `event/session` gains an optional `transportScope`,
`SessionMeta` stores it (nullable), and the conversation key is
`(platform, transportScope ?? '', channel, thread)` — two installations
sharing a channel id can never merge into one conversation when the daemon
itself keeps them apart. Pre-upgrade rows carry a null scope and may
transiently render as a separate conversation from post-upgrade scoped rows
of the same thread — a display artifact that ages out with activity, accepted
for C1. Socket-mode connections have no transportScope; a cross-**workspace**
channel-id collision there is the same pre-existing (and unobserved) exposure
the daemon's own keys carry, and lifting workspace identity (the platform team
id) into both layers together is platform-identity work outside this design.

### 5.2 Grouped list is the default

`GET /sessions` returns **conversations by default**; `?view=flat` returns
today's raw session rows. The console passes the same parameter through (a
list-mode switch, defaulting to grouped). This deliberately changes the
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

Pagination stays newest-first by `lastActivityAt` with **no aggregate
query**, but naive streaming dedupe is not enough: dedupe state resets at
every page boundary, so a conversation whose members' activity straddles a
cursor would reappear on a later page (review finding). The stateless rule is
**emit-at-max**: a scanned row yields its conversation only if it IS the
conversation's newest member row, checked with an indexed exists-newer probe
per candidate on `(platform, transportScope, channel, thread, lastActivityAt)`
— the C1 replacement of today's `@@index([platform, channel])`, which also
serves the member backfill. Rows failing the probe are skipped: their
conversation already surfaced (or will) at its true max position, on whatever
page that position falls. The scan itself still pages on the existing
`session_meta_org_visibility_page_idx`, so grouped cost ≈ the flat scan + one
index probe per scanned row + one member-backfill batch per page.

Single-agent conversations (the overwhelming majority) come back as
1-participant rows — the web renders those exactly like today's session rows,
so grouped simply IS the list, with no toggle in the default UI.

Invisible members are simply **absent** — no count, no placeholder. The
established session-visibility bar is that a hidden session's existence is
itself hidden (a hidden parent is indistinguishable from no parent); the
grouped list and the merged page both hold to it (§7).

### 5.3 Routes and cross-links

- `/conversations/:key` — the merged page, and **the only surfaced page for a
  multi-participant conversation**.
- Sessions list rows link here when `participants.length > 1`, to the
  per-agent session page otherwise (for a single-agent session that page IS
  the conversation page — no change for the common case).
- Existing `/sessions/:id` deep links (GitHub check footers, shared URLs,
  crumbs) whose session belongs to a multi-participant conversation
  **redirect** to `/conversations/:key?focus=<agentId>` — the focus preserves
  "whose perspective was linked" as scroll/highlight rather than as a
  different page. Per-agent pages for such conversations are reachable only
  as this redirect; nothing links to them (product decision).
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
2. **Dedupe text rows by raw `ts` string equality** within the conversation
   (equality only — never order). Rows sharing the exact `ts` string are
   copies of the same message (webchat: canonical `at`, probe-and-bump
   guarantees distinct posts got distinct `ts`; Slack: the platform-assigned
   `ts`, identical in every delivery).
   Precedence among copies:
   - **Author copy wins**: the row whose source session's `agentId` matches
     the row's author (`sender === source.agentId`, or the daemon-relabeled
     own-bot frames). The author copy is the full-fidelity one.
   - Human/system rows (identical in every copy): first source in stable
     order — roster order for webchat, `sessionId` sort for Slack — so the
     merge is deterministic across reloads.
3. **Work-lane rows pass through un-deduped**: `kind: tool | reasoning` rows
   exist only in their author's transcript. They interleave by `ts` and render
   inside that agent's collapsible work lane, exactly as on its own page.
4. **Sort on the normalized event-time axis, never on raw `ts`.** Raw `ts`
   mixes domains (Slack decimal seconds for text rows vs daemon millisecond
   stamps for work rows) and is an identity, not an order. The daemon store
   already normalizes every stored form onto epoch microseconds for its own
   chronological reads (`transcriptEventTimeUs`); the merge module implements
   the same normalization (the console's timestamp parser already matches it
   row-wise), sorts ascending, and breaks ties by `(sender, sessionId)` while
   preserving each source's own relative row order (stable merge).
5. **Attribution and turn grouping reuse the session detail machinery**: the
   merged row list feeds the same turn builder the per-agent page uses — the
   right side is reserved for the viewer, every agent renders as its own
   left-side block via the `agentId`-keyed grouping (`sameBotSpeaker`), humans
   render as sender rows. No new rendering rules; the merged view is "the
   per-agent page fed a union instead of one source".

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
- The webchat per-conversation privacy model (owner-private by default) and
  Slack's org-visible default both pass through untouched — the merged page is
  as visible as its most visible member session, because that is literally
  what it fetches.

## 8. Composer and live behavior

|             | Webchat conversation                                                                                                                                                | Slack thread                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Composer    | Full: same conversation resume + all-respond fan-out as today's adopted session page; placeholder "Message everyone…"                                               | None. "Open in Slack" (threadUrl). The console is an observer of IM platforms, not a poster — replying belongs to Slack (a console→Slack composer is a separate product question, out of scope). |
| Live        | On resume the existing relay socket streams all lanes into the merged canvas — identical to the live Playground (which this page effectively replaces post-refresh) | SWR revalidate / poll, like the session detail today. Streaming deferred to the ACP gateway track.                                                                                               |
| Typing/busy | per-participant, from existing lane state                                                                                                                           | activity dot from `activityState`, as today                                                                                                                                                      |

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
lineage edge contributes only attribution: the woken agent's first turn can
carry a "woken by <agent>" affordance (C3 chrome). Membership neither grows
nor splits because of the edge, and intra-conversation edges are **excluded**
from the lifted navigation in §9.2 — otherwise a co-participant that is also
a lineage child (A wakes B and C into the same thread: room-mates AND
lineage-siblings) would be listed twice.

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
mapped to the conversation its target session belongs to, rendered as
**"Parent conversation"** and **"Delegations"** (child conversations, grouped
by the waking member). No new CP surface — the member detail DTOs already carry the
links, and mapping a session to its conversation key is a metadata lookup.
(C2 ships the links; grouping delegations by waking turn is C3.)

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
  `(platform, transportScope, channel, thread, lastActivityAt)` index, the
  `event/session` `transportScope` report + nullable `SessionMeta` column
  (§5.1), grouped rendering (participant avatar stack, single row per
  conversation, both platforms). Fixes the most visible confusion (N rows
  per conversation).
- **C2 — merged page.** `conversation-merge.ts` (union/dedupe/order, unit
  tests over both adapters' fixtures), `/conversations/:key` route, renderer
  reuse, partial-merge notices, session→conversation deep-link redirects
  (`?focus=<agentId>`), conversation-level lineage links (§9.2). Webchat
  composer wired through the existing adoption path; Slack read-only with
  deep link. Playground refresh lands here.
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
- **Slack composer in the console** — rejected for this design: posting to
  Slack from the console is an identity and product question (who is the
  author?), not a rendering one.
- **Webchat-first, Slack later** — rejected by product decision: the two
  adapters are what keep the core honest; Slack is also the higher-value
  debugging surface (multi-bot ops threads).

## 12. Decision log

1. **Grouped list replaces the flat list as the default.** `GET /sessions`
   returns conversations; `view=flat` (a UI parameter passed through to the
   CP) returns raw session rows. Accepted as a deliberate change to the
   operation's default response shape.
2. **Pagination is emit-at-max — still no aggregate query.** A scanned row
   yields its conversation only when it is the conversation's newest member
   row (indexed exists-newer probe on the C1
   `(platform, transportScope, channel, thread, lastActivityAt)` index); the
   plain streaming-dedupe shortcut was wrong across page boundaries and is
   rejected (review finding). The scan still pages on
   `session_meta_org_visibility_page_idx`.
3. **Per-agent session pages are not surfaced for multi-participant
   conversations.** Every entry point leads to the merged page; existing
   session deep links redirect with `?focus=<agentId>`; the conversation
   composer exists only on the merged page.
4. **Webchat and Slack adapters ship together** in every milestone — the
   platform-neutral core is the point.
5. **Lineage never changes conversation membership** — parent/child edges are
   linked (attribution in-thread, navigation across conversations), never
   merged (§9).
6. **Review revisions (v2).** Conversation keys carry the daemon's
   `transportScope` (reported on `event/session`, stored nullable on
   `SessionMeta`); authorization-hidden members are absent, never counted;
   ordering uses the daemon's normalized event-time axis (`transcriptEventTimeUs`
   semantics) with raw `ts` demoted to duplicate identity; member resolution
   collapses to one current session per agent, retiring superseded ACP rows
   from the merge.
7. **Co-membership is not siblinghood.** Sessions sharing a room relate
   through conversation membership only; "sibling" keeps its lineage meaning
   (same parent session). An edge whose endpoints share the conversation key
   renders as attribution and is excluded from lifted navigation — the
   room-mates-AND-siblings overlap is displayed once, not twice (§9.1).
