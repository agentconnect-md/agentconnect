# OSS Authorization Policy

> **Status:** Implemented
>
> **Scope:** Human Control Plane REST, SSE, and bounded daemon-backed reads.

## 1. Goal

Human authorization had three policy locations:

- organization-role guards in `http/rbac.ts`;
- shareable-resource and session predicates in `http/visibility.ts`;
- a route-local session visibility-change predicate.

The OSS policy now converges in `control-plane/src/authorization/policy.ts`.
Routes may keep readable adapters such as `canView`, but every in-memory
decision delegates to one `can(principal, request)` entry point. Prisma list
filters use the colocated `visibilityWhere` projection of the same resource
rule.

This is a behavior-preserving architecture seam except for the intentional
removal of the organization-owner visibility bypass described in section 4.

## 2. Boundary

The request pipeline remains layered:

1. `humanAuth` authenticates a user, personal key, or OAuth principal.
2. `org-scope` verifies path-organization membership, API-key organization
   binding, and OAuth scope confinement.
3. The OSS authorization policy evaluates organization role, resource
   visibility, and session ownership.
4. The handler executes only after the applicable decisions pass.

The policy does not absorb unrelated trust domains:

- daemon and relay WebSocket authentication;
- GitHub repository, git-credential, hook, and review authorization;
- agent-to-agent call policy;
- platform ingress routing;
- daemon reconciliation and other internal unfiltered reads.

Those boundaries have different principals and security invariants. Folding
them into the human Console policy would create a misleading global `can()`.

## 3. Principal, actions, and resources

The current principal is the organization membership context:

```ts
interface ViewCtx {
  userId: string
  role: 'owner' | 'collaborator' | 'viewer'
}
```

The action vocabulary represents the distinct OSS policies that exist today:

| Action                      | Resource facts                     | Baseline decision                                             |
| --------------------------- | ---------------------------------- | ------------------------------------------------------------- |
| `organization.write`        | none                               | owner or collaborator                                         |
| `organization.manage`       | none                               | owner only                                                    |
| `resource.view`             | visibility, ownership arm, shares  | org-visible, owned, or explicitly shared                      |
| `resource.edit`             | shareable resource                 | visible and role is not viewer                                |
| `resource.sharing.manage`   | shareable resource                 | same as `resource.edit`                                       |
| `session.view`              | tier, owner identity, identity set | org-visible or identity-owned                                 |
| `session.visibility.change` | tier, owner identity, identity set | identity-owned, or an org owner while the session remains org |

The vocabulary can gain finer-grained OSS actions when the product adds a new
role or capability. The principal and resource shapes do not need to change.

## 4. Role never widens visibility

Organization ownership is an administrative role, not a resource-discovery
capability.

For shareable resources:

```text
visible =
  resource is organization-visible
  OR principal is the resource ownership arm
  OR principal is explicitly shared

editable = visible AND principal role is not viewer
```

An organization owner therefore:

- can edit any organization-visible resource;
- can edit a restricted resource they own or that is shared with them;
- cannot discover, read, edit, or re-share another member's unshared restricted
  resource.

This matches session visibility: organization-visible content follows normal
role capabilities, while private content is not widened by role.

Invisible point reads and referenced writes preserve their existing
not-found-shaped responses so the policy does not create a resource-existence
oracle.

## 5. List-query equivalence

Human list queries apply:

```sql
WHERE "orgId" = $orgId
  AND (
    "visibility" = 'org'
    OR "ownerUserId" = $userId
    OR "sharedWith" @> ARRAY[$userId]
  )
```

Every human role, including owner, uses this predicate. Only callers that omit
the principal are unfiltered; this is reserved for daemon reconciliation,
placement, and other internal operations that must continue serving active
restricted resources.

The SQL projection and in-memory `resource.view` rule are colocated and covered
by the same truth-table tests. Paginated queries must not post-filter an
already-sized page.

## 6. Ownership transfer

`ownerUserId` supplies the resource-ownership arm; `createdByUserId` remains
immutable creation attribution. Removing a member transfers every owned
visibility carrier to a selected remaining organization owner and prunes every
share vector before deleting the membership.

Removal locks the departing and recipient memberships exclusively, in stable
order, before scanning resources. Resource creates and sharing writes hold
compatible shared membership locks and recheck the actor, initial owner, and
share targets inside the resource-write transaction. This prevents a queued
write from persisting a departed stable user ID after the removal scan, and
prevents a concurrent removal from invalidating the selected recipient.

Concurrent last-owner mutation remains tracked in
[#271](https://github.com/agentconnect-md/agentconnect/issues/271).

## 7. Verification

Focused verification covers:

- the action/role matrix;
- shareable-resource visibility and editing across every role;
- session read and visibility-change semantics;
- equality between human SQL filtering and `resource.view`;
- route-level 404/403 behavior for list, point read, derived credentials,
  referenced writes, usage, SSE, and MCP tool access;
- unchanged unfiltered daemon/orchestration reads.
