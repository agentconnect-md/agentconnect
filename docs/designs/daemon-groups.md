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
outside this module may branch on the placement kind; a later kind adds one arm here
and one join in the ledger's predicate, and the callers do not learn about it._ This
design holds it to that — and goes one step further than the module anticipated: the
`pool` arm it has today is not joined by a `group` arm but **replaced** by a single
`set` arm that is a membership lookup (§3), so the module ends with fewer branches
than it started with, not more.

## 2. Model

One concept: a **member set** — a named set of daemons within which an agent's duty may
be claimed. The pool and a local group are two rows of the same table, distinguished by
tenancy, not by kind:

- **`member_set`** — `(id, orgId, name)`. `orgId` is **nullable, and null means
  cross-org**, never "unassigned": an org-less set is served by org-less daemons and
  holds every organization's agents. The install-wide pool is one such row — **one per
  install**, shared by every organization; there is no per-org pool, and an
  organization that must not share a member gets a `daemon`-placed machine pinned to
  it, not a pool of its own. A local group is a row with an `orgId`: one organization's
  set of its own org-scoped daemons.
- **`member_set_member`** — `(setId, daemonId)`, one daemon in at most one set. Two
  write-time invariants, enforced where the row is written and nowhere else: an
  org-less set accepts only org-less daemons; an org set accepts only that org's
  daemons. Membership is control-plane metadata: an operator records it for org sets
  (console or CLI), and the control plane enrolls an org-less daemon in the org-less
  set itself when it authenticates (§6). It is never negotiated on the wire — the
  daemon is told which set it is in, it does not tell.
- **`Agent.placementKind ∈ {daemon, set}`** with `setId` as the ref for `set`. `daemon`
  is unchanged — pinned to one machine, outside the ledger. The `pool` kind #991
  introduced **goes away** as a stored value (§8): a pool agent is a `set` agent whose
  set is the org-less one.

That is the whole schema. The duty ledger (`duty_group`, `duty_group_member`) is
untouched: a duty group is the _thing claimed_, a member set is the _set that may claim
it_ — the two share a word and nothing else, and the ledger's rows already exist for
every agent regardless of how it is placed.

**Why `daemon` stays its own kind rather than an N=1 set.** A set's meaning is
replaceability — a member dies, the duty moves. A pinned machine has nowhere for a duty
to move; it needs no lease, no fence, no install-on-grant onto itself, and the reaper's
cascade unplaces it rather than re-granting it. Modeling it as a set would add every one
of those rituals for no benefit. A local daemon that wants failover does not become a
set — it **joins** one, and its agents are re-placed onto the set.

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

- A `daemon`-placed agent's duty may be held by exactly that daemon. Unchanged.
- A `set`-placed agent's duty may be held by exactly the members of that set. For the
  org-less set (the pool) those are the install-wide members — unchanged from today.
  For an org set those are org-scoped connections of that org that an operator enrolled.
- Because of the write-time invariants (§2), those two sentences already imply the
  narrowing: an install-wide member is _not_ eligible for an org set's agent (it can
  never be enrolled in an org set), and an org-scoped daemon is never eligible for a
  pool agent (it can never be enrolled in the org-less set). The pool does not absorb
  groups; groups do not reach the pool.

So `claimScopeOf(daemon)` stops being a two-valued predicate. It becomes "which set is
this daemon a member of, if any":

```
member(setId)   — the daemon is in member_set_member for setId
none            — in no set (today's single-org daemon)
```

and `mayHold(agent, claimant)` collapses to **one rule** for every set agent:

```
agent.placementKind = 'set'  ⇒  claimant.setId = agent.setId
agent.placementKind = 'daemon' ⇒ claimant.daemonId = agent.daemonId
```

The tenancy narrowing is not a branch in `mayHold` at all — it lives in the two
write-time invariants on `member_set_member` (§2). An org-less set can only ever contain
org-less daemons, so "claimant is in the pool's set" already implies "claimant is
install-wide"; an org set can only contain that org's daemons, so "claimant is in group
G of org X" already implies "claimant is an org-scoped connection of X". The read path
checks membership; the write path guarantees what membership means. That is what makes
one arm sufficient, and it is the argument for this shape over a per-kind branch. The
SQL mirror in the ledger repo (`eligibleAgent` / `noIneligibleAgent`) is a join to
`member_set_member` on `(agent.setId, holder)` — one join, no `CASE` on kind beyond
`daemon` vs `set`.

**What the three handlers do.** The `conn.orgId !== null ⇒ SCOPE_DENIED` line in
`duty-claim.ts`, `duty-fetch.ts` and `duty-release.ts` becomes "resolve this
connection's set; `none` ⇒ `SCOPE_DENIED`". The heartbeat handler forwards `duties`
for any connection in a set. The predicate then does the narrowing per agent, inside
the transaction, exactly as it does today for the pool. An org-scoped member of group G
that sends a `duty/claim` for an agent in another set, or placed on a specific machine,
gets `granted: false` from the same code path a pool member gets it for a
`daemon`-placed agent.

**What the daemon does.** `dutyEnforced()` today reduces to `organizationScope() ===
'frame'` (after #982). It becomes "this connection is in a set", learned from `auth/ok`
— the CP tells the daemon at handshake which set it belongs to, if any, alongside the
lease horizon it already announces (#976). A daemon in
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
lose the `pool` arm and gain a `set` arm that is one membership lookup; the readers of
those two do not change.

The console's placement selector already lists targets, not machines (#959, #961,
#991). A group is one more entry per set the viewer's org has. On the wire,
`{ kind: 'pool' }` stays accepted as **API sugar** for "the org-less set": the control
plane resolves it at the edge and stores `set`, so the console's existing "Cloud" entry
needs no change and storage has one representation. The sugar becomes ambiguous the
day a second org-less set exists, which is exactly when the console should start naming
the set explicitly.

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

Two PRs, after #982 lands (it and this both edit `dutyEnforced()`). The first is a
refactor with no behavior change; the second is the feature. Splitting them keeps the
pool's just-verified behavior separable from the new one if anything regresses.

**PR 1 — fold the pool into a member set (§8).** Schema: `member_set`,
`member_set_member`, `placementKind` gains `set` and loses `pool`; a migration creates
the one org-less row, rewrites every `pool` agent to `set` + that row's id, and enrolls
every org-less daemon row as its member. `domain/placement.ts` and the SQL mirror
replace the `pool` arm with the membership lookup. `{ kind: 'pool' }` stays as API sugar
at the edge. Every #991 test must pass unchanged — this PR is the proof that the pool
was a set all along. Also: a new org-less daemon row (a Pod that just authenticated)
must be enrolled in the org-less set as part of `upsertOnAuth`, so pool membership stays
automatic; a `daemon`-kind daemon row is never enrolled anywhere by itself.

**PR 2 — org sets.** Console: set CRUD in org settings, membership on the daemon detail,
one more placement entry per set. The three duty handlers and the heartbeat handler:
`SCOPE_DENIED` becomes "in no set". `auth/ok` announces the daemon's set; the daemon's
enforcement predicate reads it. Nothing in the ledger changes — PR 1 already made it
set-shaped.

Load-bearing tests, all mutation-checked: an org-scoped member of set G in org X claims
a `set`-placed agent of X in G; the same member is refused a `set` agent of X in another
set, any agent of another org, any pool agent, and any `daemon`-placed agent; a pool
member is refused any org-set agent; the write-time invariants reject an org-less
daemon joining an org set and vice versa; and the pool's existing "never claims a
local-daemon agent" test still holds. Then the same rollout test the pool passed: stop
one member of a local set, and its agents re-grant to another member with no message
sent.

## 7. Rejected

- **`group` as a third placement kind beside `pool`** (the shape an earlier draft of
  this document had). It costs the same as this one — the tenancy distinction moves
  from a write-time invariant to a read-path branch — and buys nothing but avoiding
  §8's migration; it makes a second install-wide pool a schema change instead of a row,
  and it leaves "why is the pool not a row" as a permanent question. The migration is
  small and has #991's tests as its net, so the two-shape version is not worth carrying.
- **`daemon` as an N=1 set** (§2). A pinned machine has no replaceability, so every
  set ritual (lease, fence, install-onto-self) would be pure cost.
- **A daemon in several sets.** Nothing needs it, and it turns "which set's eligibility
  applies" into a policy question. Add if a real case appears.
- **Cross-org sets with an org id** — a set with `orgId = X` that admits another org's
  daemons. That would be a second tenancy model; the org-less set already is the
  cross-org shape, with the org-less identity that makes it safe.
- **Negotiating membership on the wire** (a daemon announcing which set it is in).
  Membership is an operator decision recorded in the control plane; the daemon is told,
  it does not tell. The one exception is automatic pool enrollment on auth (§6 PR 1),
  which is the CP deciding, not the daemon.

## 8. Folding the pool: the migration

The pool exists today as `placementKind = 'pool'` on agents and as "org-less daemon
row" on daemons, with no set row anywhere. PR 1 makes it a set:

1. Create `member_set` and `member_set_member`; insert one org-less row (the pool).
2. `UPDATE agent SET placementKind = 'set', setId = <pool> WHERE placementKind = 'pool'`.
3. `INSERT INTO member_set_member SELECT <pool>, id FROM daemon WHERE "orgId" IS NULL`.
4. Drop `pool` from the `AgentPlacementKind` enum. `setId` is nullable (null for
   `daemon`-kind agents), like `daemonId` is nullable for `set`-kind agents.

Behavior must be identical before and after: the same members hold the same groups at
the same terms. The migration touches no ledger row. It is safe to run under load
because eligibility is re-read on every claim from current placement, and a claim in
flight across the migration sees either "pool agent, install-wide claimant" or "set
agent, claimant in the org-less set" — the same answer.

The daemon needs nothing for PR 1: it still learns "you are install-wide" from
`auth/ok` as today; PR 2 turns that into "you are in set S".
