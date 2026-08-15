# Daemon groups

**Status:** design. Not built. Sequenced after the k8s pool runs enforced end to end,
which it now does ([k8s-daemon-pool.md](k8s-daemon-pool.md) §14 records the pool as the
degenerate case of what this document generalizes).

A _daemon group_ is a named set of daemons within which an agent's duty may be claimed.
The k8s pool is one such group — implicit, install-wide, its members every frame-mode Pod
of the install. This document makes the concept explicit and org-scoped so that
self-hosted installs can form groups out of ordinary local daemons: point an agent at a
group instead of a machine, and the same ledger, lease exchange, install-on-grant,
self-fence, and holder-following delivery distribute it within the group. For local
daemons this is the cross-machine generalization of the singleton pid lock — today two
local daemons configured with the same bot token fight over the platform API; a group
makes multi-machine failover safe for the first time.

Almost everything here is "reuse X". The one genuinely new thing is the **tenancy axis**
(§3), and it is the reason this is a design document rather than a PR description.

## 1. What is already in place

Every mechanism a group needs landed for the pool and is holder-shaped, not
member-shaped — none of it knows or cares whether the holder is a Pod or a laptop.

| Need                                                                               | Landed as                                                                                                                                                            |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A duty moving between machines needs the agent's durable state reachable on both   | Shared Postgres data plane (#958). For local groups this is the one operational prerequisite: the members must share a Postgres, and workspaces must be re-cloneable |
| No two members serve one agent across a partition                                  | Daemon self-fence with per-group deadlines anchored on CP-confirmed renewal, plus the general withdrawal guard (#976)                                                |
| A member that wins a duty for an agent it never had can serve it                   | Install-on-grant: `duty/fetch` pulls the bundle, authorized by holding the duty; the grant is applied only after the install (#972, #989)                            |
| Every later update reaches whoever holds the agent, not whoever it was placed on   | `AgentDelivery` + `servedAgents` (#978); MCP/memory definitions ride the bundle and the roster (#989)                                                                |
| Every agent has a group to be claimed under                                        | Components derived per agent, crons subsumed (#983)                                                                                                                  |
| Placement is a target, not a member; eligibility is one predicate                  | `placementKind ∈ {daemon, pool}` and `domain/placement.ts#dutyEligibility` / `mayHold`, mirrored row-wise in the ledger's SQL (#991)                                 |
| Ingress routes to a member only once it has admitted the grant                     | Routing-projection confirmation on `(holder, term)` (#991, #992)                                                                                                     |
| Healing is proactive: the sweep re-grants a lapsed holder's groups with no trigger | `incumbent` deleted (#991); verified on a real rollout                                                                                                               |

`domain/placement.ts` was written with this document in mind. Its contract: _nothing
outside this module may branch on the placement kind; a later `group` kind adds one arm
here and one join in the ledger's predicate, and the callers do not learn about it._ §4
holds it to that.

## 2. Model

**Two kinds of member set, distinguished by tenancy, not by size.** The install-wide
pool is **one per install**, shared by every organization: its members are org-less
daemon rows (`Daemon.orgId IS NULL`, frame-mode connections, every frame carrying its
own `orgId`), and one member serves many organizations' agents at once. There is no
per-org pool; an organization that must not share a member gets a _dedicated daemon_ —
a `daemon`-placed machine pinned to it — not a pool of its own. A daemon group, by
contrast, is **one organization's** set of ordinary org-scoped daemons. So "org-less"
on a member set never means "unassigned"; it means "serves every org". That is the
whole reason the two kinds are not one table (§7).

- **`daemon_group`** — `(id, orgId, name)`. Org-scoped: a group belongs to exactly one
  organization and can only contain that organization's daemons. There is no cross-org
  group; the install-wide pool is _not_ a row in this table (§3 explains why).
- **`daemon_group_member`** — `(groupId, daemonId)`, one daemon in at most one group.
  A daemon joins by an operator action in the console (or the CLI); membership is
  control-plane metadata, never negotiated on the wire.
- **`Agent.placementKind`** gains `group`, with `placementRef` naming the group id.
  `daemon` and `pool` are unchanged. A `group` agent has no `daemonId`, exactly like a
  `pool` agent.

That is the whole schema. The duty ledger (`duty_group`, `duty_group_member`) is
untouched: a duty group is the _thing claimed_, a daemon group is the _set that may claim
it_ — the two share a word and nothing else, and the ledger's rows already exist for
every agent regardless of how it is placed.

## 3. The tenancy axis — the only new thing

Today the ledger admits exactly one kind of claimant: an **install-wide** (frame-mode,
org-less) connection. Every org-scoped connection has its `duties` dropped at the
heartbeat handler, and the three duty request handlers (`duty/claim`, `duty/fetch`,
`duty/release`) answer `SCOPE_DENIED` to it. That door is a deliberate tenancy fence: an
org-scoped connection must never be able to claim, fetch, or release another
organization's work.

A local group's members are org-scoped connections. So the door has to open — but it
opens **narrower**, never wider. The rule from the pool design stands verbatim: _the
tenancy gate widens, never disappears._ Concretely:

- An install-wide claimant may hold a `pool` agent's duty. Unchanged.
- A `daemon`-placed agent's duty may be held by exactly that daemon. Unchanged.
- A `group`-placed agent's duty may be held by a claimant that is **(a) an org-scoped
  connection of the agent's own organization and (b) a member of that group**. Both
  conditions, always. An install-wide member is _not_ eligible for a group agent — the
  pool does not absorb groups — and an org-scoped daemon is never eligible for a `pool`
  agent.

So `claimScopeOf(daemon)` stops being a two-valued predicate:

```
install-wide            — orgId IS NULL                       (the pool)
group(orgId, groupId)   — orgId = X, member of group G in X   (a local group)
none                    — orgId = X, in no group              (today's single-org daemon)
```

and `mayHold(agent, claimant)` gains one arm: `agent.placementKind = 'group'` requires
`claimant.scope = group` with the same `orgId` and the same `groupId`. The SQL mirror
(`eligibleAgent` / `noIneligibleAgent` in the ledger repo) gains the matching join to
`daemon_group_member`. Nothing else in the claim path changes: `claimVacant`,
`claimAgentHome`, `holdsAgent`, `vacateIneligible` all already read the predicate rather
than the connection kind.

**Why the pool is not a group row.** The install-wide pool has no `orgId`; its members
are org-less by construction and serve every organization. A row for it would either
need a nullable `orgId` (and then every group query has to special-case null) or a
synthetic install org (a fiction). Keeping `pool` as its own placement kind, and letting
`group` mean "org-scoped set", is the honest encoding — and it is what keeps the tenancy
rule statable in one sentence.

**What the three handlers do.** The `conn.orgId !== null ⇒ SCOPE_DENIED` line in
`duty-claim.ts`, `duty-fetch.ts` and `duty-release.ts` becomes "resolve this
connection's claim scope; `none` ⇒ `SCOPE_DENIED`". The heartbeat handler forwards
`duties` for any connection whose scope is not `none`. The predicate then does the
narrowing per agent, inside the transaction, exactly as it does today for the pool. An
org-scoped connection that is in a group and sends a `duty/claim` for an agent in another
org, or in another group, or placed on a specific machine, gets `granted: false` from the
same code path a pool member gets it for a `daemon`-placed agent.

**What the daemon does.** `dutyEnforced()` today reduces to `organizationScope() ===
'frame'` (after #982). It becomes "this connection has a claim scope other than `none`",
learned from `auth/ok` — the CP tells the daemon at handshake whether it is a pool member
or a group member, alongside the lease horizon it already announces (#976). A daemon in
no group behaves exactly as today: no `duties` on the heartbeat, no enforcement, serves
what it is placed with. This is also the last step of #982's argument: the enforcement
predicate becomes "participates in a member set", which is what the design always
said membership should be.

## 4. What does not change

Stated so nobody rebuilds it: install-on-grant, the self-fence, the withdrawal guard,
holder-following delivery, MCP/memory bundle projection, routing-projection
confirmation, proactive re-grant, the drain release, the placement fence — every one of
these is keyed on _the holder_ and already runs for pool members. A group member is a
holder. The two things that read placement kind (`dutyEligibility` and the SQL mirror)
each gain one arm; the readers of those two do not change.

The console's placement selector already lists targets, not machines (#959, #961,
#991). A group is one more entry per group the viewer's org has.

## 5. Operational prerequisites for a local group

These are the operator's, not the code's:

- **Shared Postgres.** Group members must point at one data-plane Postgres, the same
  way pool members do. A duty that moves to a member whose store does not have the
  agent's history is not a move, it is a loss.
- **Re-cloneable workspaces.** A GitHub-mode workspace re-materializes on the new holder
  from its repo; a scratch workspace does not follow. This is already true for the pool
  and is documented there; a group inherits the same constraint and the same guidance
  (commit or discard before relying on failover).
- **A member's platform credentials.** Bots are org-scoped and ride the bundle, so a
  group member gets them on install; nothing per-machine is needed.

## 6. Sequencing and size

One PR, small, after #982 lands (it and this both edit `dutyEnforced()`):

1. Schema: `daemon_group`, `daemon_group_member`, `placementKind` gains `group`.
2. `domain/placement.ts`: the third claim scope and the one new `mayHold` arm; the SQL
   mirror gains its join.
3. The three duty handlers and the heartbeat handler: `SCOPE_DENIED` becomes "scope is
   `none`".
4. `auth/ok` announces the connection's claim scope; the daemon's enforcement predicate
   reads it.
5. Console: group CRUD (org settings), membership on the daemon detail, one more
   placement entry.

Load-bearing tests, all mutation-checked: an org-scoped member of group G in org X
claims a `group`-placed agent of X in G; the same member is refused a `group` agent of X
in another group, any agent of another org, any `pool` agent, and any `daemon`-placed
agent; an install-wide member is refused any `group` agent; and the pool's existing
"never claims a local-daemon agent" test still holds. Then the same rollout test the
pool passed: stop one member of a local group, and its agents re-grant to another
member with no message sent.

## 7. Rejected

- **A group row for the pool** (§3) — forces a nullable or fictional org onto every
  group query. The pool _is_ a member set conceptually, and the two kinds already share
  the claim predicate, the enforcement predicate, and every holder-keyed mechanism —
  what is unified is the reading, not the row. If several install-wide pools ever exist
  (say, per runtime tier), that is its own org-less table beside `daemon_group`, still
  not a row in it; with one pool today, that table would be an interface guessed from a
  single implementer.
- **A daemon in several groups.** Nothing needs it, and it turns "which group's
  eligibility applies" into a policy question. Add if a real case appears.
- **Cross-org groups.** They would be a second tenancy model. The pool already covers
  "one member set serving many orgs", with the org-less identity that makes it safe.
- **Negotiating membership on the wire** (a daemon announcing which group it is in).
  Membership is an operator decision recorded in the control plane; the daemon is told,
  it does not tell.
