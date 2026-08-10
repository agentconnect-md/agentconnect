# Session access for the infrequent visitor

Status: draft v2, revised after adversarial review. Companion to
[session-visibility.md](session-visibility.md) (the authorization model this
document does not change) and issue #775 (whose proposals this document absorbs,
re-motivates — and in one case demotes; see §7).

## 1. The problem is the cold visit, not the warm one

AgentConnect's primary surface is external — agents are talked to in Slack,
Telegram, Discord, GitHub. The console is opened _occasionally_: to check what an
agent did, to debug, to configure. That usage shape inverts the assumption behind
every cache on the session read path today: **the typical console request arrives
after every lease has expired.**

The read path has already been made cheap for the warm case. Landed work
(#739 request-collapse, #746 snapshot SWR, #751 predicate collapse, #777
designated checker, #782 identity refresh-ahead) brought the active-use p50 to
tens of milliseconds. None of it helps the visitor who arrives twice a day:

| Landed mechanism                     | Helps a cold visit?                              |
| ------------------------------------ | ------------------------------------------------ |
| Visibility predicate collapse (#751) | Yes — SQL runs every time                        |
| Per-request sweep collapse (#739)    | Yes — one sweep per page load instead of four    |
| Designated checker (#777)            | Partly — the cold sweep itself is cheaper        |
| Snapshot SWR (#746)                  | No — serves only within 60 s of a previous visit |
| Identity refresh-ahead (#782)        | No — first touch after idle still blocks         |

A fully cold visit today pays, in series (`forQuery` awaits `viewerFor`, then
scopes+policies, then the sweep; the page SQL needs `allowedScopes`, so it runs
after the resolver returns):

```
viewerFor: Logto GET /api/users/{sub}          ~400 ms p50 / ~1.1 s p95  (serial head)
listExternalScopes + policies (SQL, parallel)   ~50 ms
provider sweep                                 ~0.7–1.5 s
  Slack:  conversations.info × N scopes (concurrency 6), then users.info /
          conversations.members per the audience
  GitHub: repo shape (~420 ms) → permission (~340 ms), serial per private repo
page/count/facet SQL                           ~130 ms
────────────────────────────────────────────────────────
                                               ~1.5–2.5 s   (matches observed p95)
```

Every leased mechanism is access-triggered, so the infrequent visitor triggers
nothing until they are already waiting. The design goal, stated with its honest
boundary (§6 derives it):

> **A cold visit to an org whose external sessions live in public channels /
> public repos, and whose scopes saw activity the same day, completes in
> ≲ 500 ms server-side (Slack-only) to ≲ 650 ms (with a private-repo permission
> check) — without loosening any lease over per-principal access.** Orgs whose
> sessions are mostly DMs and private channels keep today's cold path for those
> scopes; §6 quantifies every case, and §7 names the two product options that
> could go further.

## 2. Principle: lease each fact by its change rate × its invalidation signal

Two axes — not implementation convenience — set each lease: how often the fact
changes, and whether we hold a signal when it does.

| Fact                                                 | Changes when                               | Invalidation signal we hold                                                                                | Lease today          | Lease under this design                                                                                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Viewer's linked identities (Logto projection)        | link / unlink                              | **Yes** — both flows invalidate through the CP (epoch fence); only an out-of-band Logto-admin edit escapes | 120 s hard           | **`SESSION_ACCESS_IDENTITY_TTL_SEC`** (default 120 s) — the epoch fence carries in-product changes, so only an out-of-band Logto edit waits out the knob; warmed at first authenticated touch (§3) |
| Channel audience (public / members / gone)           | public↔private conversion — rare, explicit | Partial — `integration/channels` snapshots carry `isPrivate` (§4.2)                                        | 120 s                | verdict-split: `public` → **60 min serving lease, 120 s revalidation threshold** (§2.1); `members` / `gone` stay 120 s                                                                             |
| GitHub repo shape (public flag)                      | rare                                       | None                                                                                                       | 120 s                | same split: public shape 60 min / 120 s revalidate; private shape stays 120 s                                                                                                                      |
| Workspace membership grade (`users.info`)            | join / leave / offboarding                 | None — **the offboarding enforcement point**                                                               | 120 s                | **unchanged**                                                                                                                                                                                      |
| Private-channel membership (`conversations.members`) | actually changes                           | Subscribed but unwired (member events)                                                                     | on demand            | **unchanged**                                                                                                                                                                                      |
| GitHub repo permission                               | revocable at GitHub any time               | None                                                                                                       | age-0 at every check | **unchanged**                                                                                                                                                                                      |

The long lease applies only to the _public_ verdict — a property of a resource,
where honoring a rare conversion late is a bounded, named cost (§2.1). It is
30–60 minutes, not hours: §4's re-warm loop, not the lease, is what carries
warmth through a workday. A shorter lease is the security bound; the warmer is
the availability mechanism. (v1 of this draft proposed 1–4 h leases; review
showed that both overstates the exposure bound and _understates_ what warming
must do — see §4.3.)

### 2.1 The named exposure: post-conversion content

A stale `public` verdict does not merely show _history_ late. While it lives,
the per-principal check for that resource is routed around entirely: a Slack
`public` audience admits any full workspace member on `users.info` alone
(members-check never runs), and a GitHub public shape short-circuits to allow
with no permission check at all. Sessions recorded **after** a public→private
conversion are therefore visible to that audience until the verdict expires or
is invalidated.

- Window today: ≤ 120 s (audience lease) + 60 s (snapshot ceiling) ≈ 3 min.
- Window under this design: split by whether anyone is looking (below).

**Touch revalidation is what keeps this honest.** A `public` verdict is
_servable_ for 60 minutes, but any read hit on one older than 120 s serves it
and immediately fires a background re-observation — the same refresh-ahead
pattern #782 established for identity, applied to the audience/shape caches
through their classifying wrappers (§4.2). The old 120 s lease survives as the
revalidation threshold rather than the serving bound. Consequences:

- **Viewed content self-limits.** The first console access during the stale
  window sees the pre-conversion state and triggers the correction; that viewer
  retains access only for their already-cached per-principal allow (≤ 120 s)
  plus the snapshot fresh window (≤ 30 s) — call it ~2–3 minutes after first
  touch. Any _other_ viewer arriving after the correction is routed to the
  members check immediately and denied.
- **The 60-minute bound governs only unviewed windows** — where, by
  definition, nothing was exposed. Its remaining cost is that the _first_
  viewer in a stale window sees the old state once; that is irreducible without
  blocking, which is the trade this whole design exists to make.

Further bounded by: the §4.2 `isPrivate` cross-check (invalidates on the
daemon's next channel snapshot) and the future member-event wiring (§7).
Phase 2 does not ship without the product-conventions.md and
session-visibility.md amendments that record this window (§8).

### 2.2 The verdict-lease mechanics this split forces

Review caught (and verified empirically against the installed lru-cache) that
the split breaks an existing invariant if implemented as a TTL bump alone. Both
plugins today lease an _allow_ from `start = min(evidenceAt, now)` with a 120 s
TTL, where `evidenceAt` is the shared audience/shape entry's `fetchedAt`. With
a 45-minute-old warmed `public` entry, that allow is **born expired** — lru-cache
deletes an entry whose start predates its TTL on the next read — silently
disabling the per-principal decision cache for exactly the warmed-public
population this design targets (and re-running uncached `conversations.members`
per request for guest viewers).

Phase 2 therefore includes a `putCache` redesign, and owns the semantic choice:

- An **allow** verdict's lease anchors to the newest **per-principal** evidence
  it rests on (`users.info` / `conversations.members` / permission observation
  time), with the 120 s TTL unchanged.
- The audience/shape entry's own (long) lease governs **routing only** — which
  check runs — and its age no longer bounds the allow verdict. This is the one
  place the old "leased from observation" guard is deliberately relaxed, and it
  is exactly the §2.1 widening, stated once and referenced here.
- Per-verdict TTLs (`public` long, `members`/`gone` short) require per-entry
  TTLs set from inside the fetch method; both caches take a single
  constructor-level TTL today. Mechanical, but part of Phase 2, not an
  afterthought — which also corrects v1's "Phase 2 depends on nothing" claim.

### 2.3 One serving function, three knobs — the unified cache policy

Every verdict-class cache on this path serves through one parametric function;
what look like different strategies are different parameters:

```
serve(age, R, S):        R = recheck threshold, S = serving ceiling
  age ≤ R        → return cached, do nothing
  R < age ≤ S    → return cached + background re-verify (single-flight,
                    failures logged and never cached)
  age > S        → block on a fresh check (the lease speaking)

hard lease         = R == S      (no background window)
refresh-ahead      = R == S/2    (#782's identity mechanism)
touch-revalidation = R << S      (the §2.1 shape mechanism)
```

| Cache                                                 | (R, S)                                                          | Why these parameters                                                                                                                          |
| ----------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack / GitHub / Feishu per-principal decision caches | (120 s, 120 s)                                                  | Revocable, no invalidation signal — the fresh check IS the revocation mechanism; no stale window permitted                                    |
| Slack `workspaceAccess` (membership grade)            | (120 s, 120 s)                                                  | Same; the offboarding enforcement point                                                                                                       |
| GitHub permission leg                                 | (0, 0) via caller cap                                           | The most sensitive revocable fact; same mechanism, strictest parameters                                                                       |
| Logto `users` / `logins` (identity projection)        | (S/2, S), S = `SESSION_ACCESS_IDENTITY_TTL_SEC` (default 120 s) | The only fact class with an in-product invalidation closure (epoch fence), so S is an operator knob; R = S/2 keeps active reads from blocking |
| Slack audience / GitHub shape (resource facts)        | (120 s, 60 min)                                                 | Viewer-independent, near-static, exposure self-limited by §2.1 touch-revalidation — the only R ≪ S row                                        |
| Session-access snapshot                               | (30 s, 60 s)                                                    | Same function; S must NOT grow (§7 — it is a per-viewer authorization lease)                                                                  |

Uniform across the table: `deny` 30 s and `unknown` 5 s (or never cached in
shared caches) are retry semantics, not leases, and take no (R, S).

**Two deliberate exceptions**, not forced into the function:

1. Token caches (Logto M2M, GitHub installation tokens): their expiry is
   issuer-assigned, not our policy — "expiry minus a safety margin, single
   flight" is their natural form.
2. Shared caches never cache `unknown` (a blip would pin every viewer), while
   per-principal caches hold it 5 s (bounded to one person).

**Orthogonal axes** the function does not own: _population_ (demand /
first-touch identity trigger §3 / activity warmer §4) decides who fills an
entry; _invalidation_ (revisions in keys — `aclRevision`,
`credentialRevision`, policy rev; the identity epoch fence; the §4.2
`isPrivate` cross-check) deletes entries event-style under any (R, S).

**Configuration — three knobs, everything else derived or fixed:**

```bash
# Any cached access decision older than this must be re-verified (seconds).
# Per-user checks (workspace membership, repo permission) block until
# re-verified; resource facts (channel/repo publicness) re-verify in the
# background while the cached value serves.
SESSION_ACCESS_RECHECK_SEC=120 # zod bounds [30, 600]

# How long a channel/repo may still be treated as public after its last
# confirmation. Bounds how late a public→private conversion is honored while
# nobody is looking; any access older than RECHECK re-verifies immediately.
SESSION_ACCESS_PUBLIC_TTL_SEC=3600 # zod bounds [300, 14400], ≥ RECHECK

# Serving lease for a viewer's provider-identity projection. Identity earns its
# own knob because it is the only fact class with an in-product invalidation
# closure — link/unlink bumps the epoch fence immediately, so only an
# out-of-band Logto edit waits out this lease.
SESSION_ACCESS_IDENTITY_TTL_SEC=120 # zod bounds [30, 86400]
```

`RECHECK` has one meaning everywhere — "older than this ⇒ re-verify"; whether
re-verification blocks is the fact-class's property, not the knob's. The
identity refresh-ahead threshold derives as half the identity lease. The
identity knob does not move the fixed 120 s cap on an identity-backed GitHub
allow (a verdict keyed only by local userId, which an unlink cannot
invalidate). The snapshot pair (30 s, 60 s) stays a code constant: changing
its ceiling is the §7 product decision, not an operator knob. `deny`/`unknown`
TTLs stay constants.

## 3. Pillar A — identity is warmed at first authenticated touch

The Logto identity projection is the serial head of every cold read: the SQL
predicate consumes the identity set, so nothing overlaps with it. #782 made it
refresh ahead of the lease _for actively-read subjects_; the infrequent
visitor's entry is expired, and their first `/sessions` blocks ~400 ms (p95
1.1 s).

**Change**: the authenticated-request path fires a fire-and-forget
`ensureIdentityFresh` for the resolved principal. Defined concretely — this is
three existing calls, not a new mechanism:

```
void slackIdentityFor(sub)                                   // users cache
void feishuIdentitiesFor(sub)                                // users cache (shared entry)
void githubLoginFor(sub, PROVIDER_IDENTITY_TTL_MS)           // logins cache
```

The `maxAgeMs` arm of the existing `refreshAheadDue` predicate then does the
right thing for both caches, including the band review flagged (an entry 2–5
minutes old is fresh by its own 10-minute TTL but stale against the 120 s
authorization cap — passing the cap makes the half-lease threshold 60 s, so the
warm fires exactly when `viewerFor` would otherwise block). Both caches must be
warmed: the `users` cache feeds the Slack/Feishu identity set, the separate
`logins` cache feeds the GitHub sweep leg — warming only one re-inserts a
serial ~400 ms hop inside the sweep.

Trigger keying: on the **resolved principal**, `userId → getOidcSubject`, not on
`req.oidcSubject` — API-key requests (agent-assistant MCP reads) carry no OIDC
subject yet still pay the Logto hop through the same mapping, and for them the
first authenticated request can _be_ `/sessions`. For OIDC console sessions the
overlap window is real but smaller than v1 claimed: `/me` and `/orgs` fire
concurrently and the org-scoped burst gates on `/orgs` alone, so the head start
is one `/orgs` round trip plus render (~60–200 ms), not a two-hop ladder. §6
carries the residue honestly at p50 and p95.

Properties preserved: the identity authorization lease is untouched
(`SESSION_ACCESS_IDENTITY_TTL_SEC`, default 120 s — this adds a
trigger, not a serving rule); the epoch fence is untouched — the background
refresh is the same fenced lookup, so a warm racing an unlink is returned to
nobody and never cached; a Logto outage degrades exactly as today. Cost ceiling,
stated precisely: up to **2 Logto lookups per subject per 60 s while any console
tab is open** (the console polls while visible, so the trigger population is
tab-open-shaped, not visit-shaped). For a handful of users that is a few
thousand calls/day against ~1.9 k today — acceptable, but named; if it grows,
gate the trigger to org-scoped requests or coalesce the two lookups (they fetch
the same Logto resource).

Out of scope for this pillar: persisting the projection (still a recorded
Phase-2-of-#782 option). Raising the identity lease was also out of scope
here, but its recorded trigger has since fired — post-rollout measurement
showed the residual tail dominated by blocking Logto fetches for viewers idle
past 120 s — so it shipped as the §2.3 `SESSION_ACCESS_IDENTITY_TTL_SEC`
knob. The win in this section still comes from _overlap_, not staleness.

## 4. Pillar B — resource shapes are warmed by session activity

The sweep's dominant cold cost is per-resource shape lookups. These are
viewer-independent, cached shared (`audiences`, `shapes`) — but populated only
by console reads, so the infrequent visitor always misses.

The product's own usage supplies the warming signal: console visits follow
external activity, and the CP already observes that activity — the
`event/session` ingest handler holds the full org-scoped `SessionMetaRecord`
(`orgId`, `platform`, `channel`, `tenantScope`, `externalScopeId`) after
`recordMilestone` commits.

### 4.1 The warmer

A `SessionAccessWarmer` service, poked fire-and-forget from the `event/session`
handler after the commit-then-publish point (the same pattern as the existing
`visibilityPush.notifySessions` call at that site). The poke carries **only
`(orgId, externalScopeId)`**; everything else is re-resolved at execution time.

For an external session's scope it refreshes the viewer-independent halves only:

- Slack: the audience entry for (recording bot, channel) — one
  `conversations.info`;
- GitHub: the shape entry for (installation, repo id) — one
  `GET /repositories/{id}`.

Never warmed, by design: `users.info`, `conversations.members`, repo
permission — per-principal, and we do not know who will visit. On a cold visit
they are the only provider work left, and they run in parallel across plugins.

### 4.2 Execution rules (each one closes a reviewed hole)

1. **Policy gate.** Before any provider call, read the org's external-access
   policy for the scope's provider; `disabled` (or no row) skips the warm
   entirely. An org that turned sync off has withdrawn consent for the CP to
   question its workspace; the read path honors that instantly and the warmer
   must too. A disabled provider costs zero warming calls.
2. **Run-time re-resolution.** The warmer resolves scope → credential → secret
   at execution through the same fences `resolveScope` applies (org match,
   platform, `revokedAt`, realm match; GitHub installation revoked/suspended
   precheck). A poke-time snapshot can be arbitrarily stale by run time; a
   failed fence skips, never caches.
3. **Warm through the classifying wrappers, not the raw caches.** The Slack
   "an `unknown` audience is never cached" invariant lives in `audienceOf`,
   _above_ the lru-cache fetch method — a warmer driving the cache handle
   directly would cache a transient `ratelimited` as `unknown` for the full
   long lease and convert a failed warm into hidden sessions at the next real
   read. The warm entry point is the plugin's wrapper (exposed for the
   purpose), or the delete-on-unknown moves into the cache layer. Either way
   the invariant must hold for every caller before Phase 3 ships.
4. **`isPrivate` cross-check (cheap invalidation).** Daemon
   `integration/channels` snapshots already reach the CP carrying per-channel
   `isPrivate`. When a snapshot marks a channel private whose cached audience
   verdict says `public`, drop that verdict. This is the first, nearly-free
   piece of event-driven invalidation and directly shrinks the §2.1 window.
5. **Touch revalidation (read-path half of §2.1).** The audience/shape read
   wrappers serve a hit older than 120 s and fire a background re-observation
   through the same classifying wrapper — single-flighted, `unknown` never
   cached, failures logged and swallowed. This rule belongs to Phase 2 (it is
   part of the verdict-split's safety story, not an optimization of Phase 3):
   the long lease must never ship without it.
6. **Rate discipline.** The warmer shares each bot token's provider budget with
   the fail-closed foreground sweep — an uncapped burst can push foreground
   checks into `ratelimited` → degraded → hidden sessions, which would falsify
   "a broken warmer degrades to today's behavior". So: a per-token concurrency
   cap with jitter; no pokes from replayed `event/session-sync` frames (a CP
   restart drains daemon outboxes and would otherwise fire one poke per active
   session within seconds against cold cooldown maps); first warms after a
   restart spread across the cooldown window.
7. **Secret economy.** A Slack warm needs `botToken` only; opening the full
   sealed secret costs up to five Vault decrypts per call. Decrypt the one
   field, or cache token material per (bot, cooldown window).

### 4.3 The working set and the re-warm loop

Review demolished v1's "any activity today keeps the shape warm for any visit
today": with warming only _at_ activity and a finite lease, warmth ends one
lease after activity stops — a 9 am conversation does not serve a 3 pm visit.

So Phase 3 is a **poke-maintained working set plus a periodic re-warm loop**,
not a pure debouncer: a poke marks the scope active (bounded map, per-entry LRU
eviction — not the doorbell's wholesale `clear()`, whose amnesia at hour-scale
cooldowns would trigger fleet-wide re-warm herds); a `CronRunReaper`-style loop
re-warms every working-set scope on a cadence of half the public-verdict lease,
and drops scopes with no activity for 24 h. Cost at the reference shape (~20
channel + ~5 repo scopes, activity through a workday, 30–60 min lease):
~500–1,200 provider calls per org-day — three orders of magnitude under Slack's
per-token tier — and an idle org costs zero. Nothing scales per-org-count;
everything scales per-activity.

Lifecycle: constructed in the container, armed by `startBackground()` only
(tests never see a timer), `stop()` cancels timers before `settle()` drains
in-flight warms _including_ chained re-pokes (loop until quiescent — the
doorbell's settle awaits only current pulls and is not sufficient as-is).

### 4.4 Hot-path discipline

The design docs constrain ingest: classification uses wire facts and local
lookups only, and the CP stays off the message hot path. The warmer respects
both: the ingest handler's only new work is a synchronous `poke()` (map write,
maybe arming a clock timer); every provider call happens on the warmer's own
execution. One v1 claim corrected: `event/session` does **not** fire only four
times per session — it fires at least twice per turn, plus title updates, plus
a display-name change fans one milestone per stored session. The argument
therefore rests where it should: the poke is O(1) regardless of rate, and the
working-set map + cooldown absorb bursts by construction, exactly as the
doorbell absorbs event storms.

## 5. Instrumentation (was: "measurable on the existing dashboard")

Review showed v1 asserted measurability the codebase cannot deliver: no cache
hit/miss counters exist, no per-upstream issuance counters, no
foreground/background or cold/warm labels — endpoint p50/p95 and provider-side
volume are the only observable series, and they conflate everything. Each phase
ships its own minimal instrumentation, without which its effect is genuinely
indistinguishable:

- Phase 1: a counter/log on identity warm triggers and on `viewerFor` blocking
  fetches (the cold-block rate is the success metric).
- Phase 2/3: fetch-method invocation counters on `audiences`/`shapes` (miss
  rate ⇒ warming hit rate is derivable), a warmer pull counter with outcome
  (the doorbell's per-pull info log is the precedent), and a
  foreground/background label on Slack/GitHub/Logto calls.
- Phase 4 is itself the observability item: background snapshot-refresh
  failures currently vanish (`noDeleteOnFetchRejection` keeps serving with
  `degraded: false`); they get a log/metric and a staleness marker.

## 6. The cold-visit budget, honestly

Serial shape (unchanged by this design): identity → scopes/policies SQL →
sweep → page SQL. What changes is what each term costs cold.

Per-term, after Phases 1–3, for a scope-warm org:

| Term                            | p50                   | Notes                                                                                                                                                     |
| ------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| identity residue                | ~0–250 ms             | Logto p50 400 ms minus one `/orgs` RTT + render of overlap; p95 residue can reach ~900 ms (Logto p95 1.1 s) — the tail is Logto's, overlap only shifts it |
| scopes + policies SQL           | ~50 ms                |                                                                                                                                                           |
| sweep, Slack public scope       | ~150 ms               | `users.info` only (audience warm)                                                                                                                         |
| sweep, Slack DM / private scope | ~150–500+ ms          | audience (if cold) + `conversations.members` pagination — **Pillar B does not apply**; the `members` verdict stays 120 s by design                        |
| sweep, GitHub public repo       | ~0 ms                 | shape warm ⇒ allow, no identity check                                                                                                                     |
| sweep, GitHub private repo      | ~340 ms               | permission, age-0 by design                                                                                                                               |
| sweep, historical cold scopes   | +⌈N_cold/6⌉ × ~200 ms | scopes outside the 24 h working set — the sweep spans the org's whole filtered history, not today's activity                                              |
| page/count SQL                  | ~130 ms               |                                                                                                                                                           |

Representative totals (p50): Slack-public org, scopes warm ≈ **330–480 ms**;
plus a private repo ≈ **520–650 ms**; DM/private-heavy org ≈ **0.7–1.5 s**
(today's sweep, minus the identity overlap); org with many never-active
historical scopes: add the residual term. A genuinely idle org pays today's
path minus the identity overlap (~1.1–2.1 s) — and note the honest corollary:
the same user's active org and idle org now differ visibly in load time.

Two structural caveats:

- All warm state is in-process; a CP deploy resets it, so the delivered
  validity is `min(lease, time since rollout)`. Frequent deploys erode Pillar B;
  this is a recorded trigger for persisting audience/shape observations, in
  the same follow-up bucket as identity persistence.
- The residual floor — membership grade, private-repo permission — is the
  security budget, deliberately untouched. Going below it is possible only via
  the §7 product options.

## 7. Product options — named, not committed

Two mechanisms would cut further and are **decisions, not defaults**, because
each changes what a revoked viewer can momentarily see:

1. **Snapshot ceiling raise** (#775 §3: 60 s → 10–15 min). Review corrected
   v1 here, and the correction cuts against absorbing it: the snapshot is keyed
   per viewer and, while it serves, _no_ per-principal check runs — so the
   ceiling **is** a per-viewer authorization lease, and raising it widens every
   per-principal revocation window (private-channel removal, deactivation,
   guest demotion, collaborator removal, token revocation) from ~3 min worst
   case to ~17 min, for list _and_ recently-opened detail/transcript reads. It
   also lengthens how long a broken refresh pipeline can silently vouch. That
   is the same class of exposure as the gradient below — it needs the same
   sign-off, with the ~17 min figure on the table. It serves the
   medium-frequency visitor only; the cold visit gains nothing from it.
2. **Privilege gradient.** Serve list _metadata_ past-lease with verify-behind
   and SSE retraction, while transcript opens keep the hard lease. Cuts the
   residual floor for the list; changes momentary visibility for revoked
   viewers; needs the product decision v1 already recorded.

Also explicitly not done, unchanged from v1: no provider ACLs persisted (the
session-visibility.md rule — "It never stores provider ACLs. Slack/Feishu/Lark
conversation-access and GitHub repository-access decisions are bounded,
short-lived in-process cache entries" — stands, with Phase 2 amending its
"short-lived" wording to the verdict-split rule rather than silently outgrowing
it); no per-principal lease widening anywhere in Phases 1–4; fail-closed
untouched; the Connect carve-out untouched; no event-driven ACL
materialization beyond the §4.2(4) cross-check.

## 8. Phasing

| Phase | Content                                                                                                                                                                                                                                                                                                            | Depends on                                                                              | Named risk                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1     | §3 identity warm-at-touch (3 calls, principal-keyed trigger) + its counters                                                                                                                                                                                                                                        | nothing                                                                                 | Logto volume ceiling (§3), bounded and measured                                                |
| 2     | §2 verdict-split (60 min public serving lease, 120 s touch-revalidation §4.2(5), per-entry TTLs) + §2.2 `putCache` redesign + §2.3 config knobs (`SESSION_ACCESS_RECHECK_SEC` / `SESSION_ACCESS_PUBLIC_TTL_SEC`) + §4.2(4) `isPrivate` cross-check + **product-conventions.md / session-visibility.md amendments** | nothing                                                                                 | §2.1: viewed content self-limits to first-touch + ~2–3 min; unviewed windows bounded by 60 min |
| 3     | §4 warmer (working set + re-warm loop + rate discipline) + §5 counters                                                                                                                                                                                                                                             | Phase 2 (leases make warmth durable); §2.2 (else warmed evidence kills verdict caching) | background provider volume; bounded per §4.3, measured per §5                                  |
| 4     | snapshot-refresh failure observability (#775 §4)                                                                                                                                                                                                                                                                   | nothing                                                                                 | none                                                                                           |

The #775 §3 ceiling raise is _not_ a phase; it moved to §7.

## 9. Open questions

1. ~~Public-verdict lease: 30 or 60 minutes?~~ **Decided: 60 minutes**, on the
   strength of §2.1's touch-revalidation split — the serving lease governs only
   unviewed windows, so the longer value buys warmth without buying exposure.
2. Should `ensureIdentityFresh` fire on every authenticated request or only
   org-scoped ones? (Trade: API-key coverage and simplicity vs. the §3 volume
   ceiling.)
3. Working-set retention: is 24 h right, or should it follow the org's own
   visit cadence once §5 gives us the data?
4. Do we take the §4.2(3) wrapper-exposure route or move delete-on-unknown into
   the cache layer? (Both close the hole; the latter helps future callers.)
