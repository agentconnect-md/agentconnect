# Organization Session Policy

**Status:** storage and delivery implemented. Nothing reads the policy yet; see [Not yet](#not-yet).

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

## Not yet

- Nothing reads the policy today; no route, frame, or daemon behaves differently because of it.
- Counting sessions per organization and UTC month, and refusing a new session when `enforce` is
  true and the limit is reached, are later work.
- Applying `historyRetentionDays` to hosted session history is later work.
