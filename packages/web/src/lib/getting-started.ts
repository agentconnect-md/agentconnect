// Getting-started checklist logic (design: "Getting Started Placement" 1a/1b — the
// floating pill + slide-over drawer). Every item is DERIVED from live console state,
// never a stored "done" tick (preset-agents.md §6.2). The pill persists while any
// item is incomplete and vanishes for good once the list is complete — there is no
// manual dismiss, so the only state this module owns is the pure derivation.
//
// Steps in the design's order: daemon → meet your agent → Slack → GitHub+repo (one
// merged step) → first conversation → invite. Still not derivable client-side (left
// out rather than faked, preset-agents.md §6.2): the "Runtime signed in"
// needs-attention item — neither `authRequired` (absence also means probe
// pending/failed) nor advertised models (a usable runtime may legitimately have no
// model selector) encode readiness; add it when the explicit
// pending|ready|auth_required|failed probe status ships. Same for the per-item
// "Ask agentconnect" automation (§6.3/§6.4 delegated writes).

import { agentIsPlaced } from './data'
import type { Agent, DaemonRow, IntegrationRow, Session } from './data'
import type { MemberDto } from './api'

// What the item's primary CTA drives. The component maps kind → a real handler
// (open a modal, route to a page) so this stays pure and testable.
export type GsAction =
  | { kind: 'daemon' }
  | { kind: 'agent' }
  | { kind: 'slack'; agentId: string | null }
  | { kind: 'github'; agentId: string | null }
  | { kind: 'chat' }
  | { kind: 'members' }

export interface GsItem {
  key: string
  label: string
  /** One-line explanation shown when the row is expanded. */
  expl: string
  done: boolean
  ctaLabel: string
  action: GsAction
}

export interface GettingStarted {
  items: GsItem[]
  done: number
  total: number
  /** Fraction complete, 0..1. */
  fraction: number
  /** `stroke-dasharray` value for a r=10.5 progress ring (dash then a full-circle gap). */
  ring: string
  allDone: boolean
}

// r=10.5 matches every ring svg in the design (pill, drawer header, rail).
const RING_CIRCUMFERENCE = 2 * Math.PI * 10.5

export function computeGettingStarted(input: {
  agents: Agent[]
  daemons: DaemonRow[]
  integrations: IntegrationRow[]
  sessions: Session[]
  members: MemberDto[]
  /** Auth mode: no-auth deployments have a single implicit org and no member list. */
  authOn: boolean
}): GettingStarted {
  const { agents, daemons, integrations, sessions, members, authOn } = input
  // Pick a chat-capable / bindable agent for the agent-scoped CTAs. Prefer the built-in
  // `agentconnect` preset — the canonical agent every org gets — else the first agent.
  const builtin = agents.find((a) => a.builtin)
  const firstAgent = (builtin ?? agents[0])?.id ?? null
  // The agent step tracks the BUILT-IN preset when the org has one — the step's card
  // (MeetYourAgents) renders that preset, so a placed custom agent alone must not tick
  // the row while the card still shows "Set up". Orgs without the preset (older
  // backfills) fall back to "some agent is placed".
  const placedAgent = builtin ? agentIsPlaced(builtin) : agents.some(agentIsPlaced)

  const items: GsItem[] = [
    {
      key: 'daemon',
      label: 'Connect a daemon',
      expl: 'Run one command on the host where your agents should live. It stays connected and runs agents locally over ACP.',
      done: daemons.some((d) => d.status === 'online'),
      ctaLabel: 'Add a daemon',
      action: { kind: 'daemon' }
    },
    {
      key: 'agent',
      label: 'Set up your agent',
      expl: 'Your org comes with a built-in AgentConnect agent. Place it on a daemon and pick a runtime and model so it can run — or create your own.',
      done: placedAgent,
      ctaLabel: 'Set up your agent',
      action: { kind: 'agent' }
    },
    {
      key: 'slack',
      label: 'Connect Slack',
      expl: 'Assign a bot so your agents can read and post in Slack channels — one click connects the built-in AgentConnect Bot.',
      done: integrations.some((i) => i.platform === 'slack'),
      ctaLabel: 'Connect Slack',
      action: { kind: 'slack', agentId: firstAgent }
    },
    {
      key: 'github',
      label: 'Connect GitHub and assign a repository',
      expl: 'Install the GitHub App, then point an agent at a repo, branch and working directory so it has code to work in.',
      done: agents.some((a) => a.workspace?.mode === 'github'),
      ctaLabel: 'Connect GitHub',
      action: { kind: 'github', agentId: firstAgent }
    },
    {
      key: 'conversation',
      label: 'Start your first conversation',
      expl: 'Send one message and watch the agent work — in a connected channel or in the Playground.',
      // Product decision (2026-07-30, mirrored in preset-agents.md §6.2): ANY session in
      // the org ticks this — a session existing at all means a conversation has been
      // driven here (Playground or a channel), which is exactly what this step teaches.
      // Requiring a terminal status (or "your own" session) made orgs with live
      // sessions re-run a chat just to clear the step.
      done: sessions.length > 0,
      ctaLabel: 'Start a conversation',
      action: { kind: 'chat' }
    }
  ]

  // Members only exist in auth mode; a no-auth deployment has no one to invite.
  if (authOn) {
    items.push({
      key: 'invite',
      label: 'Invite teammates',
      expl: 'Add operators to your workspace so they can run agents and watch sessions.',
      done: members.length > 1,
      ctaLabel: 'Invite teammates',
      action: { kind: 'members' }
    })
  }

  const done = items.filter((i) => i.done).length
  const total = items.length
  const fraction = total === 0 ? 1 : done / total
  return {
    items,
    done,
    total,
    fraction,
    ring: `${(fraction * RING_CIRCUMFERENCE).toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`,
    allDone: done === total
  }
}
