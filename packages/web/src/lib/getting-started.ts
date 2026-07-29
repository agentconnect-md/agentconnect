// Getting-started checklist logic (design: "Getting Started Placement" 1a/1b — the
// floating pill + slide-over drawer). Every item is DERIVED from live console state,
// never a stored "done" tick (preset-agents.md §6.2). The pill persists while any
// item is incomplete and vanishes for good once the list is complete — there is no
// manual dismiss, so the only state this module owns is the pure derivation.
//
// What is derivable client-side today is a subset of §6.2: the items whose backing
// (probe status, preset placement, the assistant, delegated-key "Ask" automation)
// isn't shipped yet are intentionally left out rather than faked — add them here as
// their signals land. See the note in GettingStarted.tsx.

import type { Agent, DaemonRow, IntegrationRow, Session } from '@/lib/data'
import type { MemberDto } from '@/lib/api'

// What the item's primary CTA drives. The component maps kind → a real handler
// (open a modal, route to a page) so this stays pure and testable.
export type GsAction =
  | { kind: 'daemon' }
  | { kind: 'agent' }
  | { kind: 'agentRepo'; agentId: string | null }
  | { kind: 'slack'; agentId: string | null }
  | { kind: 'github'; agentId: string | null }
  | { kind: 'chat'; agentId: string | null }
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
  // Pick a chat-capable / bindable agent for the agent-scoped CTAs. First agent is fine
  // — these steps only need *an* agent to act on, and the general preset will be it.
  const firstAgent = agents[0]?.id ?? null

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
      label: 'Create your first agent',
      expl: 'Give it a name, choose a daemon and model, and point it at a repo. Agents are the workers that answer in your channels.',
      done: agents.length > 0,
      ctaLabel: 'Create an agent',
      action: { kind: 'agent' }
    },
    {
      key: 'repo',
      label: 'Give your agent a repository',
      expl: 'Attach a GitHub repo and working directory so the agent can read and change real code instead of a scratch workspace.',
      done: agents.some((a) => a.workspace?.mode === 'github'),
      ctaLabel: 'Attach a repository',
      action: { kind: 'agentRepo', agentId: firstAgent }
    },
    {
      key: 'slack',
      label: 'Connect Slack',
      expl: 'Give an agent a bot identity so it can read and post in a Slack channel. Telegram and Discord work the same way.',
      done: integrations.some((i) => i.platform === 'slack'),
      ctaLabel: 'Connect Slack',
      action: { kind: 'slack', agentId: firstAgent }
    },
    {
      key: 'github',
      label: 'Connect GitHub',
      expl: 'Subscribe an agent to a repository so pushes, PRs, and issues can trigger it automatically.',
      done: agents.some((a) => (a.hookKinds ?? []).includes('github')),
      ctaLabel: 'Connect GitHub',
      action: { kind: 'github', agentId: firstAgent }
    },
    {
      key: 'conversation',
      label: 'Finish your first conversation',
      expl: 'Send an agent a message from the Playground or a connected channel and watch it work end to end.',
      done: sessions.length > 0,
      ctaLabel: 'Start a conversation',
      action: { kind: 'chat', agentId: firstAgent }
    }
  ]

  // Members only exist in auth mode; a no-auth deployment has no one to invite.
  if (authOn) {
    items.push({
      key: 'invite',
      label: 'Invite teammates',
      expl: 'Add people to this organization so they can share agents, daemons, and channels with you.',
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
