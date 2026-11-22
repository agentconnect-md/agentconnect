# Organization Session Policy

**Status:** storage, delivery, monthly session counting, and admission implemented. Nothing
refuses a session yet; see [Not yet](#not-yet).

## What it is

A session policy is one row per organization, `org_session_policy`, that says how many sessions
the organization may start and how long its hosted session history is kept.

| Field                  | Type              | Meaning                                                                          |
| ---------------------- | ----------------- | -------------------------------------------------------------------------------- |
| `revision`             | integer ≥ 1       | The writer's monotonically increasing revision of this organization's policy.    |
| `monthlySessionLimit`  | integer ≥ 0, null | Sessions the organization may start per UTC month; `null` is no limit.           |
| `historyRetentionDays` | integer ≥ 1, null | Days hosted session history is kept; `null` means this policy does not bound it. |
| `enforce`              | boolean           | `false` counts only and never refuses; `true` lets the later admission refuse.   |

An organization with no row has no policy: no limit, no retention bound, nothing enforced.

## Who writes it

A deployment-level service decides each organization's policy and delivers it to the Control
Plane, holding a credential of its own. Where the values come from is not the Control Plane's
concern: it stores them and, in later work, enforces them. This is the same split as the key
server's org standing ([key-server.md](key-server.md) §1, §2.3) and managed computer quotas
([computer-use.md](computer-use.md) §15.5): an outside system decides, the Control Plane enforces.

## Delivery contract

`PUT /api/v1/internal/orgs/{orgId}/session-policy` with `Authorization: Bearer <credential>` and
a strict JSON body of the four fields above (unknown keys are refused). The route is hidden from
the OpenAPI document and sits outside the organization subtree and human sign-in.

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
- **Every platform.** Every new session counts, whatever surface started it.
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

| Field            | Meaning                                                                       |
| ---------------- | ----------------------------------------------------------------------------- |
| `used`           | Sessions counted in the current UTC month; 0 when none.                       |
| `limit`          | The policy's `monthlySessionLimit`; null without a limit or a policy.         |
| `policyRevision` | The stored policy revision; null without a policy.                            |
| `monthStart`     | The current UTC month's first instant, by the database clock.                 |
| `resetsAt`       | The next UTC month's first instant.                                           |
| `asOf`           | The database time of the read; every field comes from that one SQL statement. |

## Admission

A daemon may ask the Control Plane to admit a new session before it starts: `session/admit`
(D→C REQ `{ agentId, sessionId }` → `session/admit/result`), where `sessionId` is the session's
outward id, the same id `event/session` later carries. The Control Plane advertises
`session-admit-v1` in `register/ok.serverFeatures`, and a daemon sends the request only to a
Control Plane that does. The reporting daemon must serve the agent, as for `event/session`; the
organization is the agent's own, read under the frame's organization fence.

`org_session_admission` keeps one row per admitted session id: its organization, agent, the UTC
month it was counted in or would have been, and whether it counted. One transaction first takes
the same session lineage fence a milestone takes on that id, then:

1. **Already admitted.** The stored answer comes back unchanged, so a re-sent admit never counts
   twice. An admission another agent holds is refused.
2. **Already recorded.** A `session_meta` row exists, for example a session started before this
   feature or resumed on another daemon: the session is admitted with `counted: false`. A row
   another agent owns is refused.
3. **New.** The session is admitted with `counted: true`, and the organization's current month is
   incremented by the database clock, with the same statement the milestone count runs.

| Answer                         | When                                                                     |
| ------------------------------ | ------------------------------------------------------------------------ |
| `{ admitted: true, counted }`  | Admitted; `counted` says whether this admission counted the session.     |
| `SCOPE_DENIED` (not retryable) | The daemon does not serve the agent, or the id belongs to another agent. |
| `INTERNAL` (retryable)         | The agent's placement is moving, or the write failed.                    |

**Coexistence with the milestone count.** When a first milestone inserts the `session_meta` row,
it increments the month only if no admission row exists for that id. Admission and milestone take
the same lineage fence on the id before anything else, so whichever runs second sees the other's
committed row and the session counts exactly once in either order. A daemon that never sends
`session/admit` is counted at its first milestone exactly as before.

Admission consults no limit and refuses no session on policy: an authorized request is always
answered `admitted: true`. Deleting the organization deletes its admission rows.

**When the daemon sends it.** A daemon admits a session when it first opens one it has no local
record of, before it prepares the session's workspace, issues its model credential, or starts its
runtime, so chat, cron, hook, delegation, and task turns are all admitted at that one point. A
later turn, or a runtime recreated after a failed load, finds the local record and sends nothing.
It sends once, over a live link only, with a short timeout and no retry, and it fails open: the
session starts whatever the answer, and one whose admission never committed is counted at its first
milestone instead. Memory-maintenance runs do not open sessions this way and never send it.

## Not yet

- Refusing a new session at admission when `enforce` is true and the limit is reached is later
  work, as an additive refusal variant of `session/admit/result`, and the daemon then waits on the
  answer instead of failing open; until then the policy changes no route, frame, or daemon
  behavior, and the count is only read.
- Applying `historyRetentionDays` to hosted session history is later work.
