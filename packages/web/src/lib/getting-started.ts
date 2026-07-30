// Getting-started checklist logic (design: "Getting Started Placement" 1a/1b — the
// floating pill + slide-over drawer). Every item is DERIVED from live console state,
// never a stored "done" tick (preset-agents.md §6.2). The pill persists while any
// item is incomplete and vanishes for good once the list is complete — there is no
// manual dismiss, so the only state this module owns is the pure derivation.
//
// Seven steps, in the design's order: daemon → runtime signed in → meet your agent →
// Slack → GitHub+repo (one merged step) → first conversation → invite. "Runtime signed
// in" is the needs-attention item: it derives from the daemons' probe-reported
// `authRequired` and turns amber when a daemon is online but no runtime can take a
// session. Still not derivable client-side (left out rather than faked): the per-item
// "Ask agentconnect" automation (§6.3/§6.4 delegated writes).

import { agentIsPlaced } from './data'
import type { Agent, DaemonRow, IntegrationRow, Session } from './data'
import type { MemberDto } from './api'

// What the item's primary CTA drives. The component maps kind → a real handler
// (open a modal, route to a page) so this stays pure and testable.
export type GsAction =
  | { kind: 'daemon' }
  | { kind: 'runtime'; daemonId: string | null }
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
  /** Needs-attention: the step is blocking (amber mark + note) rather than merely open. */
  warn?: boolean
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
  /** Some item is in the needs-attention state (drives the amber banner / pill tint). */
  hasWarn: boolean
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
  const firstAgent = (agents.find((a) => a.builtin) ?? agents[0])?.id ?? null
  // Every org is born with the unplaced built-in preset (daemon '—', deferred runtime),
  // so "an agent exists" is no longer the signal. The step is done once *some* agent is
  // placed on a daemon with a runtime — i.e. the built-in got configured (onboarding's
  // agent step) or a user created a real one.
  const placedAgent = agents.some(agentIsPlaced)

  // Runtime sign-in state, from the daemons' probe reports: a runtime whose last probe
  // was NOT rejected with ACP auth-required can take a session. Amber only when a daemon
  // is online yet nothing is signed in — with no online daemon the daemon step already
  // owns the attention.
  const onlineDaemons = daemons.filter((d) => d.status === 'online')
  const runtimes = (d: DaemonRow) => d.runtimeModels ?? []
  const runtimeSignedIn = onlineDaemons.some((d) => runtimes(d).some((r) => !r.authRequired))
  const runtimeWarn = onlineDaemons.length > 0 && !runtimeSignedIn
  const signInDaemon =
    onlineDaemons.find((d) => runtimes(d).some((r) => r.authRequired))?.daemonId ?? onlineDaemons[0]?.daemonId ?? null

  const items: GsItem[] = [
    {
      key: 'daemon',
      label: 'Connect a daemon',
      expl: 'Run one command on the host where your agents should live. It stays connected and runs agents locally over ACP.',
      done: onlineDaemons.length > 0,
      ctaLabel: 'Add a daemon',
      action: { kind: 'daemon' }
    },
    {
      key: 'runtime',
      label: 'Sign in an AI runtime',
      expl: 'Agents can’t take a session until a runtime (Claude, Codex, …) is signed in on the daemon host. Open the daemon page for the sign-in command.',
      done: runtimeSignedIn,
      warn: runtimeWarn,
      ctaLabel: 'Sign in',
      action: { kind: 'runtime', daemonId: signInDaemon }
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
      label: 'Complete your first conversation',
      expl: 'Send one message and watch the agent work — in a connected channel or in the Playground.',
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
    allDone: done === total,
    hasWarn: items.some((i) => !i.done && i.warn)
  }
}
