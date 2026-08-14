// Pure duty-group math for k8s daemons: connected components of the
// agent↔daemon-held-bot graph (an enabled cron is an edge too), plus the
// deterministic reconcile plan that maps freshly computed components onto the
// persisted `duty_group` rows. No I/O — the repo applies the plan it returns.
import type { DutyMemberKind, DutyMemberKey, DutyReconcilePlan } from '../domain/duty.js'

export type { DutyMemberKind, DutyMemberKey, DutyReconcilePlan }

/** An active Integration row whose bot the daemon itself connects (socket transport). */
export interface DutyEdge {
  agentId: string
  botId: string
}

/** An enabled cron: the agent must belong to a claimable group even with no bots. */
export interface CronSeed {
  agentId: string
}

export interface ComputedComponent {
  /** Canonically sorted, deduplicated membership. */
  members: DutyMemberKey[]
}

export interface ExistingDutyGroup {
  groupId: string
  /** Live holdership as the caller judges it: holder set AND lease not expired. */
  held: boolean
  holder: string | null
  members: DutyMemberKey[]
}

const keyOf = (m: DutyMemberKey): string => `${m.kind}:${m.refId}`

const compareMembers = (a: DutyMemberKey, b: DutyMemberKey): number =>
  a.kind === b.kind ? (a.refId < b.refId ? -1 : a.refId > b.refId ? 1 : 0) : a.kind < b.kind ? -1 : 1

function canonical(members: Iterable<DutyMemberKey>): DutyMemberKey[] {
  const seen = new Map<string, DutyMemberKey>()
  for (const m of members) seen.set(keyOf(m), m)
  return [...seen.values()].sort(compareMembers)
}

/** Union-find over agent/bot nodes; every edge joins, every seed guarantees a node. */
export function computeDutyComponents(edges: DutyEdge[], seeds: CronSeed[]): ComputedComponent[] {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)!
    // Path compression keeps repeated finds cheap on wide shared-bot groups.
    let c = x
    while (c !== r) {
      const next = parent.get(c)!
      parent.set(c, r)
      c = next
    }
    return r
  }
  const add = (k: string) => {
    if (!parent.has(k)) parent.set(k, k)
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb)
  }

  for (const e of edges) {
    const a = keyOf({ kind: 'agent', refId: e.agentId })
    const b = keyOf({ kind: 'bot', refId: e.botId })
    add(a)
    add(b)
    union(a, b)
  }
  for (const s of seeds) add(keyOf({ kind: 'agent', refId: s.agentId }))

  const byRoot = new Map<string, DutyMemberKey[]>()
  for (const k of parent.keys()) {
    const root = find(k)
    const [kind, refId] = [k.slice(0, k.indexOf(':')) as DutyMemberKind, k.slice(k.indexOf(':') + 1)]
    const list = byRoot.get(root) ?? []
    list.push({ kind, refId })
    byRoot.set(root, list)
  }
  return [...byRoot.values()]
    .map((members) => ({ members: canonical(members) }))
    .sort((a, b) => compareMembers(a.members[0]!, b.members[0]!))
}

// The identity-assignment rule, stated once: existing groups are consumed in
// (held first, larger first, lower groupId first) order, and each takes the
// unassigned component holding most of its former members. This makes "the
// holder of the larger group keeps the merged group, ties broken by lower
// groupId" a corollary rather than a special case, covers splits (the id and
// holder follow the largest fragment), and is fully deterministic — two
// concurrent recomputes from the same rows produce byte-identical plans.
export function planDutyReconcile(existing: ExistingDutyGroup[], components: ComputedComponent[]): DutyReconcilePlan {
  const comps = components.map((c) => ({ members: canonical(c.members) }))
  const memberToComp = new Map<string, number>()
  comps.forEach((c, i) => c.members.forEach((m) => memberToComp.set(keyOf(m), i)))

  const order = [...existing].sort((a, b) => {
    if (a.held !== b.held) return a.held ? -1 : 1
    if (a.members.length !== b.members.length) return b.members.length - a.members.length
    return a.groupId < b.groupId ? -1 : 1
  })

  const compAssignee = new Map<number, ExistingDutyGroup>()
  const groupAssignedComp = new Map<string, number>()
  for (const g of order) {
    const overlap = new Map<number, number>()
    for (const m of g.members) {
      const ci = memberToComp.get(keyOf(m))
      if (ci !== undefined && !compAssignee.has(ci)) overlap.set(ci, (overlap.get(ci) ?? 0) + 1)
    }
    let best: number | null = null
    for (const [ci, n] of overlap) {
      if (best === null) best = ci
      else {
        const bn = overlap.get(best)!
        // Most former members first; then the component with the smallest lead member.
        if (n > bn || (n === bn && compareMembers(comps[ci]!.members[0]!, comps[best]!.members[0]!) < 0)) best = ci
      }
    }
    if (best !== null) {
      compAssignee.set(best, g)
      groupAssignedComp.set(g.groupId, best)
    }
  }

  const plan: DutyReconcilePlan = { unchanged: [], writes: [], creates: [], deletes: [], superseded: [] }

  // Contributors: which held groups previously owned each component's members (split inheritance).
  const memberToHeldGroup = new Map<string, ExistingDutyGroup>()
  for (const g of existing) if (g.held) for (const m of g.members) memberToHeldGroup.set(keyOf(m), g)

  comps.forEach((c, i) => {
    const assigned = compAssignee.get(i)
    if (assigned) {
      const same =
        assigned.members.length === c.members.length &&
        assigned.members.every((m, j) => keyOf(m) === keyOf(c.members[j]!))
      if (same) plan.unchanged.push(assigned.groupId)
      else
        plan.writes.push({
          groupId: assigned.groupId,
          members: c.members,
          regrantTo: assigned.held ? assigned.holder : null
        })
      return
    }
    const contributors = new Set(c.members.map((m) => memberToHeldGroup.get(keyOf(m))).filter((g) => g !== undefined))
    const sole = contributors.size === 1 ? [...contributors][0]! : null
    plan.creates.push({ members: c.members, grantTo: sole ? sole.holder : null })
  })

  for (const g of existing) {
    if (groupAssignedComp.has(g.groupId)) continue
    plan.deletes.push(g.groupId)
    if (!g.held || g.holder === null) continue
    // Not superseded when every surviving member stays with the same holder —
    // that is a re-grant elsewhere in the plan, not a loss.
    const destinations = new Set<string | null>()
    for (const m of g.members) {
      const ci = memberToComp.get(keyOf(m))
      if (ci === undefined) continue
      const winner = compAssignee.get(ci)
      if (winner) destinations.add(winner.held ? winner.holder : null)
      else {
        const create = plan.creates.find((cr) => cr.members.some((cm) => keyOf(cm) === keyOf(m)))
        destinations.add(create?.grantTo ?? null)
      }
    }
    const lost = destinations.size === 0 || [...destinations].some((h) => h !== g.holder)
    if (lost) plan.superseded.push({ groupId: g.groupId, holder: g.holder })
  }

  plan.unchanged.sort()
  plan.deletes.sort()
  plan.writes.sort((a, b) => (a.groupId < b.groupId ? -1 : 1))
  plan.superseded.sort((a, b) => (a.groupId < b.groupId ? -1 : 1))
  return plan
}
