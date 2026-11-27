# Organization Session Policy

**Status:** storage, delivery, monthly session counting, admission, and
[enforcement](#enforcement) implemented; history retention is delivered to daemons,
[counted in a dry run](#the-dry-run), and [reclaimed](#reclaim) behind an install switch that is
off by default; see [Not yet](#not-yet).

## What it is

A session policy is one row per organization, `org_session_policy`, that says how many sessions
the organization may start and how long its hosted session history is kept. It also carries the
organization's artifact total ([artifacts.md](artifacts.md) §10.2), which applies whenever it is
set: `enforce` and the install switch govern the session limit only.

| Field                  | Type              | Meaning                                                                          |
| ---------------------- | ----------------- | -------------------------------------------------------------------------------- |
| `revision`             | integer ≥ 1       | The writer's monotonically increasing revision of this organization's policy.    |
| `monthlySessionLimit`  | integer ≥ 0, null | Sessions the organization may start per UTC month; `null` is no limit.           |
| `historyRetentionDays` | integer ≥ 1, null | Days hosted session history is kept; `null` means this policy does not bound it. |
| `enforce`              | boolean           | `false` counts only and never refuses; `true` refuses new sessions at the limit. |
| `artifactBytesLimit`   | integer ≥ 0, null | Bytes the organization's artifacts may hold; `null` or omitted is no limit.      |

An organization with no row has no policy: no limit, no retention bound, nothing enforced.

## Who writes it

A deployment-level service decides each organization's policy and delivers it to the Control
Plane, holding a credential of its own. Where the values come from is not the Control Plane's
concern: it stores them and, in later work, enforces them. This is the same split as the key
server's org standing ([key-server.md](key-server.md) §1, §2.3) and managed computer quotas
([computer-use.md](computer-use.md) §15.5): an outside system decides, the Control Plane enforces.

## Delivery contract

`PUT /api/v1/internal/orgs/{orgId}/session-policy` with `Authorization: Bearer <credential>` and
a strict JSON body of the fields above (unknown keys are refused); `artifactBytesLimit` may be
omitted, which stores no limit. The route is hidden from the OpenAPI document and sits outside
the organization subtree and human sign-in.

| Answer | When                                                                   |
| ------ | ---------------------------------------------------------------------- |
| 200    | `{ "appliedRevision": n }` — the revision the Control Plane holds now. |
| 400    | The body is malformed, out of range, or carries an unknown key.        |
| 401    | The credential is missing or wrong.                                    |
| 404    | The organization does not exist, or the route is not configured.       |
| 503    | The cluster token review could not be reached; retry.                  |

The write is one compare-and-set statement: it inserts the row, or replaces every field only if
the stored revision is lower than the delivered one. `appliedRevision` equals the delivered
revision when it was applied and is the higher stored one when the delivery was stale. Delivery is
therefore idempotent and order-independent: the writer may retry and may send revisions out of
order, and the highest revision always wins. A writer that sees a higher `appliedRevision` than it
sent knows a newer policy is already in place. Deleting the organization deletes its policy.

## Credentials

The route accepts either of two credentials, each configured on its own. It does not accept the
usage ingest secret or the usage ServiceAccounts.

| Form            | Configuration                                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared secret   | `SESSION_POLICY_TOKEN` (at least 32 characters), compared in constant time.                                                                                                                   |
| Projected token | A Kubernetes ServiceAccount token reviewed by TokenReview when the daemon pool is enabled; the ServiceAccount is `SESSION_POLICY_WRITER_SERVICE_ACCOUNT`, default `ac-session-policy-writer`. |

With neither configured the route is not registered, so the path answers 404.

## Monthly session count

`org_session_month` holds one row per organization and UTC month: `monthStart`, the first instant
of the month, and `used`, the sessions started in it. A session counts once, the first time the
Control Plane records it: the transaction that inserts its `session_meta` row from a daemon's
`event/session` milestone also increments the organization's row for the current month. Later
milestones of the same session update that row and count nothing, and a milestone the agent guard
drops (an unknown agent, or a session id another agent owns) writes nothing and counts nothing.

- **Month.** The UTC month is read from the database clock when the row is inserted, never from
  the time the daemon reports, so a late or skewed report counts in the month it arrived.
- **Every platform.** Every new session counts, whatever surface started it, except a memory
  dream the Control Plane exempts at admission as [maintenance](#maintenance-exemption).
- **Counting only.** The increment consults no limit and never refuses; a failed increment fails
  the whole milestone, like any other statement in that transaction.
- **No backfill.** Rows come only from sessions first recorded after this change shipped, so
  sessions that existed before it are never counted.
- **Reported or admitted sessions only.** The count covers sessions daemons report or admit; a
  session admitted first counts at [admission](#admission) instead, never twice.

The increment is the transaction's last statement, so concurrent new sessions of one organization
queue on its month row only until commit. Deleting the organization deletes its rows.

### Read route

`GET /api/v1/orgs/{orgId}/usage/sessions` sits beside the other usage reads and takes the same two
credentials: a signed-in member of the organization, or the install-level usage reader workload
(`usage-service-auth.ts`). A non-member and an unknown organization get 404.

| Field            | Meaning                                                                          |
| ---------------- | -------------------------------------------------------------------------------- |
| `used`           | Sessions counted in the current UTC month; 0 when none.                          |
| `limit`          | The policy's `monthlySessionLimit`; null without a limit or a policy.            |
| `policyRevision` | The stored policy revision; null without a policy.                               |
| `monthStart`     | The current UTC month's first instant, by the database clock.                    |
| `enforcing`      | Whether a new session past `limit` is refused now ([Enforcement](#enforcement)). |
| `resetsAt`       | The next UTC month's first instant.                                              |
| `asOf`           | The database time of the read; every field comes from that one SQL statement.    |

## Admission

A daemon may ask the Control Plane to admit a new session before it starts: `session/admit`
(D→C REQ `{ agentId, sessionId, purpose? }` → `session/admit/result`), where `sessionId` is the
session's outward id, the same id `event/session` later carries, and `purpose` is either absent
or `memory-dream`. The Control Plane advertises
`session-admit-v1` in `register/ok.serverFeatures`, and a daemon sends the request only to a
Control Plane that does. The reporting daemon must serve the agent, as for `event/session`; the
organization is the agent's own, read under the frame's organization fence.

`org_session_admission` keeps one row per admitted session id: its organization, agent, the UTC
month it was counted in or would have been, whether it counted, and `maintenance`, the purpose it
was exempted for or null. One transaction first takes the same session lineage fence a milestone
takes on that id, then:

1. **Already admitted.** The stored answer comes back unchanged, so a re-sent admit never counts
   twice. An admission another agent holds is refused.
2. **Already recorded.** A `session_meta` row exists, for example a session started before this
   feature or resumed on another daemon: the session is admitted with `counted: false`. A row
   another agent owns is refused.
3. **New maintenance.** An exemptable [maintenance](#maintenance-exemption) session is admitted
   with `counted: false` and its purpose stored, and the month is not incremented.
4. **New.** The session is admitted with `counted: true`, and the organization's current month is
   incremented by the database clock, with the same statement the milestone count runs. While the
   organization is [enforcing](#enforcement), the increment is conditional and a miss refuses
   the session instead.

The first two steps ignore `purpose`: a re-sent admit, exempt or not, gets its stored answer, and
a session the Control Plane already recorded is never exempted after the fact.

| Answer                                                                                         | When                                                                                                                  |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `{ admitted: true, counted, enforcing }`                                                       | Admitted; `counted` says whether this admission counted the session, `enforcing` whether the org enforces.            |
| `{ admitted: false, reason: 'session_limit_reached', limit, used, resetsAt, enforcing: true }` | The organization enforces its limit and the month reached it; only to a daemon that reads this variant.               |
| `RATE_LIMITED` (not retryable)                                                                 | The same refusal to a daemon that does not read the variant; `details` carries `reason`, `limit`, `used`, `resetsAt`. |
| `SCOPE_DENIED` (not retryable)                                                                 | The daemon does not serve the agent, or the id belongs to another agent.                                              |
| `INTERNAL` (retryable)                                                                         | The agent's placement is moving, or the write failed.                                                                 |

**Coexistence with the milestone count.** When a first milestone inserts the `session_meta` row,
it increments the month only if no admission row exists for that id. Admission and milestone take
the same lineage fence on the id before anything else, so whichever runs second sees the other's
committed row and the session counts exactly once in either order. A daemon that never sends
`session/admit` is counted at its first milestone exactly as before.

An organization that is not enforcing never has a session refused on policy: an authorized
request is answered `admitted: true`. Deleting the organization deletes its admission rows.

**When the daemon sends it.** A daemon admits a session when it first opens one it has no local
record of, before it prepares the session's workspace, issues its model credential, or starts its
runtime, so chat, cron, hook, delegation, and task turns are all admitted at that one point. A
later turn, or a runtime recreated after a failed load, finds the local record and sends nothing.
How long it waits depends on the organization's last answer; see
[The daemon under enforcement](#the-daemon-under-enforcement). A memory dream does not open its
session this way: the daemon admits it once per dream, with `purpose: 'memory-dream'` and the
outward id of the dream's execution session, before it issues the dream host's model credential or
starts that host.

### Maintenance exemption

A memory dream ([memory-dreaming.md](memory-dreaming.md)) is background maintenance of the
agent's own memory, so it does not consume the organization's count when the Control Plane can
verify it as such. A new session is exempt when all of these hold:

- the request carries `purpose: 'memory-dream'`;
- the agent's stored configuration runs dreaming on the managed memory provider, the same
  effective policy the daemon dreams under (no memory binding reads as managed with the default
  policy); and
- the agent has fewer than 24 exempt admissions since the current UTC day start by the database
  clock.

Otherwise the request falls back to normal counting: the session is admitted with `counted: true`
and `maintenance` null, exactly as without a purpose. The handler decides the first two conditions
from the agent it already loaded; the repository checks the daily cap under a transaction-scoped
advisory lock per agent, taken after the lineage fence, so concurrent exempt admits of one agent
cannot overrun it. The answer is the ordinary `{ admitted: true, counted: false }`; no new result
field says why. A re-sent admit of an exempt id returns that stored answer, and the dream's first
milestone counts nothing because its admission row exists. A daemon that does not send `purpose`,
or a Control Plane that predates it (whose schema strips the unknown key), counts the dream like
any other session.

## Enforcement

An organization is **enforcing** when its policy has `enforce: true` and a non-null
`monthlySessionLimit`, and the install switch has not turned enforcement off. Every other
organization, including one with no policy row, counts only: its sessions are admitted, recorded,
and counted exactly as described above, past any limit. A policy with `enforce: true` and no limit
enforces nothing, since there is nothing to refuse.

**Install switch.** `SESSION_POLICY_ENFORCEMENT=off` on the Control Plane makes every organization
count only, whatever its delivered `enforce` says; the default is `on`. It rolls enforcement back
without redelivering any policy, and counting stays accurate while it is off, so an organization
switched back on is judged against the sessions it actually started.

**Admission.** For an enforcing organization a new session that is neither already admitted, already
recorded, nor exempt [maintenance](#maintenance-exemption) is counted with a conditional increment
(`used = used + 1 WHERE used < limit`) on the organization's month row, and its admission row is
inserted only when that increment landed. A miss writes nothing and answers the refusal with the
month's `used`, the `limit`, and `resetsAt`, the next UTC month's first instant. Concurrent admits of
different ids queue on the month row, so of several new sessions racing for the last slot, on one
Control Plane or several sharing the database, exactly one is admitted and the count rises by one.
A re-sent admit of an admitted id gets its first answer even at the limit; a refused id has no row,
so a later admit of it is judged again against the policy and month it meets. Maintenance is
exempted before the limit is consulted and is never refused; a dream past its daily cap counts like
any session and can be refused.

The refusal variant `{ admitted: false, reason: 'session_limit_reached', limit, used, resetsAt,
enforcing: true }` goes only to a daemon that advertises `session-admit-refusal-v1` in its
`register` capabilities. An older daemon cannot decode it, so it gets a non-retryable
`RATE_LIMITED` error whose `details` carry the same fields. Every `admitted: true` answer carries
`enforcing`, so a daemon learns each organization's enforcement from its ordinary admissions; an
older daemon strips the unknown key.

**Milestone guard.** While an organization is enforcing, an `event/session` or
`event/session-sync` milestone for a session id that no agent admitted and the Control Plane never
recorded is admitted at that milestone, inside the milestone's transaction and after the same
lineage fence admission takes: the same conditional increment `session/admit` runs, without the
maintenance exemption since a milestone carries no purpose. This covers a session that started
while the daemon failed open, for example because its organization's last answer said it was not
enforcing or the 2-second attempt timed out.

- **Below the limit.** The admission row is inserted as counted and the milestone is recorded as
  usual; later milestones and a re-sent `session/admit` of the id replay that admission, so the
  session counts once, whichever of the admit and the first milestone runs first.
- **At the limit.** Nothing is written: no admission, no `session_meta` row, no count.
  `event/session-sync` is answered with a non-retryable `RATE_LIMITED` error whose `details` carry
  `reason: 'session_limit_reached'`, `limit`, `used`, and `resetsAt`, so a daemon may deliver the
  snapshot again once the month resets; the one-way `event/session` has no reply, so the Control
  Plane drops it and logs why.
- **Another agent's admission.** An id admitted under a different agent is never recorded for this
  one. `event/session-sync` is acknowledged, as for an id another agent recorded, so the daemon
  collects a row that can never be accepted.

A session already recorded, whether it started before enforcement or on a daemon that never admits,
keeps syncing without a check, so an older daemon's existing sessions stay visible and can continue;
its new sessions are admitted at their first milestone while the organization is below its limit.

**Session grants.** While an organization is enforcing, the daemon-wire grants that hand a session
authority of its own refuse a session id the agent never admitted or recorded, without admitting it
there, with their own
`denied` result: `computer-channel/grant` (the channel token to a Computer),
`computer-pool/acquire` (a managed computer), and `computer-lease/acquire` (a Computer's control
lease). Model credentials come from the key server, which the daemon asks directly, so the Control
Plane cannot check them; a daemon that admits sessions never asks for one before its admission.

### The daemon under enforcement

The daemon remembers, in memory and per organization, whether the last `session/admit` answer for
one of its agents said `enforcing`; an answer without the field, from an older Control Plane, reads
as not enforcing, and a restart forgets every answer.

- **Not enforcing, or no answer yet.** The daemon sends the admission once over a live link with a
  2-second timeout and fails open: with no link, no answer, or a Control Plane that does not admit
  sessions, the session starts, and one whose admission never committed is admitted and counted
  at its first milestone. A refusal is still honored, which is how a daemon learns that an organization started
  enforcing.
- **Enforcing.** The daemon waits for the answer within the turn-path budget of
  [high-availability.md](high-availability.md): 10 seconds in total, a reconnect included, and the
  same id is re-sent once over a replaced link. With no answer in that budget the session is refused
  as `session_quota_unavailable`, which is temporary: the next turn asks again.
- **Refused.** `session_limit_reached` is final for that attempt. The session's runtime never starts
  and no model credential is issued; the next turn in the same conversation asks again, since a
  refused id holds no admission.

Each entry reports a refusal through its own result. A Webchat or chat-platform turn shows the
refusal in the conversation: the organization's used sessions, its limit, and when the count resets,
or that the check is temporarily unavailable. A chat API turn (`ai-sdk-ui`, `ag-ui`) is admitted
before its acknowledgement, so the HTTP request is answered `429` for `session_limit_reached` and
`503` for `session_quota_unavailable`, with the same text as `message`, before any stream starts. A
hook run ends `failed` with the reason as its completion reason; a scheduled task, a delegation and
any other caller of the turn receive the turn's failure with the same text. A memory dream skips
the run ([memory-dreaming.md](memory-dreaming.md)).

## History retention

A daemon deletes a finished session's row, transcript and workspace when it has been idle longer
than the daemon's own window, `sessions.retention` (the console's "Expire sessions", delivered as
`register/ok.sessionRetention` and `config/push`). A pool member serves many organizations, so one
window per daemon cannot carry each organization's `historyRetentionDays`. The per-organization
window is delivered to the daemons, their retention sweep counts what it would decide in a
[dry run](#the-dry-run), and with the install's [reclaim switch](#reclaim) on it decides deletion.
With the switch off, the default, deletion is exactly the daemon-wide rule.

### Delivery

A daemon that advertises `org-history-retention-v1` receives, in `register/ok`,
`orgHistoryRetention: { orgIds, entries }`:

| Field     | Meaning                                                                                                  |
| --------- | -------------------------------------------------------------------------------------------------------- |
| `orgIds`  | Every organization the snapshot speaks for: the orgs of the agents in it and the connection's own org.   |
| `entries` | `{ orgId, revision, historyRetentionDays }` for each listed org with a policy; `null` days is unlimited. |

A listed org without an entry has no policy. When the [delivery route](#delivery-contract) applies
a revision, the Control Plane pushes that org's stored entry as `config/push` key
`sessions.orgHistoryRetention` to every READY daemon on the same replica that serves one of the
org's agents and advertises the feature. A stale delivery pushes nothing, and a failed push never
fails the delivery. A daemon on another replica, or offline, converges at its next `register/ok`.
An older daemon receives neither the field nor the key and keeps its daemon-wide window; an older
Control Plane sends neither, which the daemon reads as not synced.

### The daemon's table

The daemon keeps the delivered entries in memory, never on disk, and reads an org as:

| Reading  | When                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| policy   | An entry is held: the window is its days, or unlimited for `null`.                                                              |
| missing  | The org is listed without an entry, or the session's agent has no org (a local agent): today's daemon-wide window applies.      |
| unsynced | No `register/ok` carrying the field since the link last dropped, including after an older Control Plane's `register/ok`.        |
| stale    | A `register/ok` carried a revision below one already seen for the org, or omitted a policy seen before; a newer push clears it. |
| unknown  | No delivery since the link came up named the org, for example an org first served through a duty grant after `register/ok`.     |

The highest revision seen per org survives reconnects but not restarts. A push older than the held
entry changes nothing. Unsynced, stale and unknown are **paused**: the org has no window to act on.

### The dry run

Each retention sweep, once a Control Plane has answered a `register`, runs the dry run before any
pass that deletes, on the rows those passes are about to judge. It lists the finished sessions
older than the shortest window in play (the daemon-wide one and every delivered one), and for each
session this member judges compares today's decision (idle past the daemon-wide window) with the
org's: its policy window as a pool member applies it, on any daemon, today's window when missing,
or paused. When either would delete, it
first applies the guards the real pass applies before deleting anything: its backoff after a kept
workspace, a conversation's current append session, and the active-turn exclusions (a live or
queued turn, pending inbox work, background tasks, an agent not yet loaded or draining). A guarded
session is **protected** under both rules. The dirty-workspace check is not run, since judging a
workspace can wake a pod, so `wouldDelete` is an upper bound. One info line per sweep:

```text
retention dry run: org history retention candidates=… currentDeletes=… wouldDelete=… wouldKeep=…
  differs=… orgDeletesMore=… orgKeepsMore=… policyMissing=… paused=… pausedUnsynced=…
  pausedStale=… pausedUnknown=… protected=…
```

`candidates` is `wouldDelete + wouldKeep + paused + protected`; `differs` splits into
`orgDeletesMore` (the org window is shorter) and `orgKeepsMore` (longer or unlimited). A debug line
per session names its key, org, both decisions and the basis. The same counts are the gauge
`agentconnect.session.retention.dry_run.sessions`, by `outcome`. A failed dry run logs a warning
and the sweep continues.

## Reclaim

**Install switch.** `ORG_HISTORY_RECLAIM=on` on the Control Plane lets daemons delete under the
organization windows; the default is `off`. A daemon that advertises `org-history-reclaim-v1`
receives the switch as `register/ok.orgHistoryRetention.reclaim`, beside the snapshot it governs.
Changing it needs a Control Plane restart, which every daemon follows with a new `register/ok`; a
`register/ok` without the snapshot leaves the daemon's switch as it was. With the switch off, or on
a daemon that does not advertise the feature, deletion is exactly the daemon-wide rule and the
[dry run](#the-dry-run) keeps counting.

**Window rule.** With the switch on, the retention purge judges each finished session by its
organization's reading in [the daemon's table](#the-daemons-table):

| Reading | Pool member                                               | Self-hosted daemon                                        |
| ------- | --------------------------------------------------------- | --------------------------------------------------------- |
| policy  | The org's window replaces the daemon-wide one.            | The shorter of the org's window and the daemon's own.     |
| `null`  | Never deleted, however old.                               | The daemon's own window.                                  |
| missing | Today's daemon-wide window.                               | Today's daemon-wide window.                               |
| paused  | Nothing is deleted; there is no fallback to today's rule. | Nothing is deleted; there is no fallback to today's rule. |

A daemon is a pool member when its connection is install-wide (`organizationMode: 'frame'`, the
same predicate that makes it duty-governed, [k8s-daemon-pool.md](k8s-daemon-pool.md) §14); any
org-scoped connection is self-hosted. A session whose agent has no organization, such as a local
agent, keeps today's rule. Every guard of the purge still applies: the backoff after a kept
workspace, a conversation's current append session, the active-turn exclusions, the dirty and
unpushed workspace check, and on a shared store only the agent's holder judging its rows. The
workspace pass reads the same window when it leaves a row past its window to the purge, so a paused
organization's rows stay with the workspace pass. A deletion writes the same purge receipt and
reports the same `event/session-purged` as today.

**Re-confirmation.** Before the purge deletes anything, the daemon sends one
`history-retention/confirm` with every organization it is about to delete sessions for, and every
stale or unknown one it holds sessions of, and the
Control Plane answers each organization's stored `{ revision, historyRetentionDays }`, that it has
no policy, or that it is denied. The Control Plane answers only for organizations in which the
daemon serves an agent, by the same placement-and-duty union its roster uses, and an org-scoped
connection only for its own organization; every other organization is denied. The daemon deletes
an organization's sessions only when the answer is exactly what it would act on: the same
revision and window, or still no policy. Otherwise, or when the Control Plane is unreachable,
does not advertise `history-retention-confirm-v1`, or does not answer within 10 seconds, nothing
of that organization is deleted in this pass. A newer answer is folded into the table as a push
would be, so a policy applied on another Control Plane replica, a lengthened window, and an
organization first served through a duty grant take effect at the next pass instead of waiting
for the daemon's next `register/ok`; a stale or unknown organization deletes nothing in the pass
that asks about it. Each session is deleted only while its organization's reading
is still the one confirmed: a push, a dropped link or the switch going off during the pass keeps
the rest.

## Not yet

- A session that started fail-open and whose organization has reached its limit by its first
  milestone runs unrecorded: the [milestone guard](#enforcement) refuses its metadata, and the
  daemon's outbox keeps the snapshot and retries it, so it is recorded once the month resets.
- `historyRetentionDays` deletes nothing until the install turns [reclaim](#reclaim) on; the dry run
  still counts what it would decide.
