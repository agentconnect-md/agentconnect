// Which member of a connected workspace catches a bare delegation — the question
// the workspace card has to answer before it lets anyone remove a member (§7.4).
//
// It is NOT "the persisted pointer, else the earliest member". `HttpBotOrchestrator.compile`
// builds its fallback from ELIGIBLE members only, and applies the same test to the
// persisted preference:
//
//   placed = integrations whose agent resolves AND has a routable daemon
//   preferred = placed.find(p => p.agentId === bot.preferredAgentId && !p.gated)
//   default   = preferred ?? placed.find(p => !p.gated)
//
// so a pointer at a restricted or unplaced agent is IGNORED and the fallback runs on
// past it. Reading membership order alone marks the wrong row "default" and — the part
// that loses data — leaves the real default's Remove enabled.
//
// One input is genuinely not exposed to the console: whether a SET-placed agent has a
// confirmed duty hold right now (`routableDaemons` = placement targets ∪ confirmed
// holders, and a set placement names no target of its own). `placementReady` is not
// that predicate — it is liveness, which is both too strict for a daemon placement
// (placed-but-offline is still routable) and too loose for a set one (a live member
// that has not confirmed a hold is not). So a set-placed member is `unknown`, and every
// member that could be the default under that unknown is protected.

import { isSetPlacementKind, type Agent } from '@/lib/data'
import type { BotDto } from '@/lib/api'

/** The `Agent` fields the compiler's two eligibility tests actually read. */
export type LinearMemberAgent = Pick<Agent, 'visibility' | 'placementKind' | 'setId' | 'daemon'>

/** What `placementValueOf` yields for an agent whose placement names nothing. */
const UNPLACED_DAEMON = '—'

/**
 * Can this member be the compiler's default?
 *
 *  - `ineligible` — the compiler will never pick it: restricted (`isGatedAgent`, which
 *    is excluded from every unscoped rung), or placed nowhere at all.
 *  - `eligible` — a daemon placement that names a machine. Routable regardless of that
 *    daemon's liveness, which is exactly what `routableDaemon` answers.
 *  - `unknown` — a set placement (routable only while some member holds the duty), or a
 *    member this console cannot resolve to an agent at all. Never assumed away.
 */
export function linearMemberEligibility(agent: LinearMemberAgent | undefined): 'eligible' | 'ineligible' | 'unknown' {
  if (!agent) return 'unknown'
  if (agent.visibility === 'restricted') return 'ineligible'
  if (isSetPlacementKind(agent.placementKind)) return agent.setId ? 'unknown' : 'ineligible'
  return agent.daemon && agent.daemon !== UNPLACED_DAEMON ? 'eligible' : 'ineligible'
}

export interface LinearDefaultAgents {
  /** The member the card marks "default" — the compiler's most likely answer. Null when
   *  no member can be it (a workspace of only restricted or unplaced agents, which the
   *  compiler leaves with no fallback at all). */
  marked: string | null
  /** EVERY member that could be the effective default once the unknowns resolve. Removal
   *  is refused for all of them; with no unknowns in play this is exactly `[marked]`. */
  candidates: readonly string[]
}

/**
 * The default, and everything it could be.
 *
 * Mirrors the compile in order: the persisted pointer first (and it WINS outright when
 * it is definitely eligible — the fallback never runs), then the earliest eligible
 * member. Every `unknown` member the scan passes on the way is collected, because it
 * would have won had it been routable.
 *
 * Naming a definitely-eligible default is what collapses the set to one member: that is
 * both the operator's escape hatch and why the block's copy tells them to do it.
 */
export function linearDefaultAgents(
  bot: Pick<BotDto, 'preferredAgentId' | 'agentIds'>,
  agentOf: (agentId: string) => LinearMemberAgent | undefined
): LinearDefaultAgents {
  const eligibility = (id: string) => linearMemberEligibility(agentOf(id))
  const candidates: string[] = []

  const pointer = bot.preferredAgentId
  if (pointer && bot.agentIds.includes(pointer)) {
    const pointerEligibility = eligibility(pointer)
    // A definitely-eligible pointer is the answer, full stop — `preferred ?? …`.
    if (pointerEligibility === 'eligible') return { marked: pointer, candidates: [pointer] }
    // An unknown pointer might still win; an ineligible one is ignored exactly as the
    // compiler ignores it, and the fallback below decides.
    if (pointerEligibility === 'unknown') candidates.push(pointer)
  }

  for (const agentId of bot.agentIds) {
    const memberEligibility = eligibility(agentId)
    if (memberEligibility === 'ineligible') continue
    if (!candidates.includes(agentId)) candidates.push(agentId)
    // The first definitely-eligible member ends the scan: nothing after it can win.
    if (memberEligibility === 'eligible') break
  }

  return { marked: candidates[0] ?? null, candidates }
}
