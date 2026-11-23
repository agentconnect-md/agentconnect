// Getting-started checklist logic (design: "Getting Started Placement" 1a/1b — the
// floating pill + slide-over drawer). Every item is DERIVED from live console state,
// never a stored "done" tick (preset-agents.md §6.2). The pill persists while any
// item is incomplete and vanishes for good once the list is complete — there is no
// manual dismiss, so the only state this module owns is the pure derivation.
//
// Steps in the design's order: daemon → runtime → Slack → GitHub+repo (one merged step) →
// first conversation → invite → session-access review. The daemon and runtime steps are dropped
// where the deployment offers the cloud pool (`poolEnabled`) — there is nothing to connect.
// The runtime step ticks only on a probe-confirmed runtime (`runtimeUsable`): `authRequired`
// absent alone also covers a pending or failed probe, so it never counts as ready by itself.
// Still not derivable client-side: the per-item "Ask agentconnect" automation (§6.3/§6.4).

import { daemonEverConnected, localDaemons, runtimeUsable, runtimeWarning } from './data'
import type { Agent, DaemonRow, IntegrationRow, Session } from './data'
import type { MemberDto } from './api'

// What the item's primary CTA drives. The component maps kind → a real handler
// (open a modal, route to a page) so this stays pure and testable.
export type GsAction =
  | { kind: 'daemon' }
  | { kind: 'daemon-reconnect'; daemonId: string }
  | { kind: 'daemon-detail'; daemonId: string | null }
  | { kind: 'runtime-login'; daemonId: string; runtimeId: string }
  | { kind: 'slack'; agentId: string | null }
  | { kind: 'github'; agentId: string | null }
  | { kind: 'github-profile' }
  | { kind: 'chat' }
  | { kind: 'members' }
  | { kind: 'session-access' }

export interface GsItem {
  key: string
  label: string
  /** One-line explanation shown when the row is expanded. */
  expl: string
  done: boolean
  ctaLabel: string
  action: GsAction
  /** Selects state-specific copy for the item (e.g. a daemon created but never connected); absent ⇒ the default. */
  variant?: string
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

// How long a never-connected daemon reads as "waiting" before the copy names likely causes.
export const DAEMON_CONNECT_GRACE_MS = 10 * 60_000

// r=10.5 matches every ring svg in the design (pill, drawer header, rail).
const RING_CIRCUMFERENCE = 2 * Math.PI * 10.5

/** `stroke-dasharray` for the r=10.5 progress ring at `fraction` (0..1) complete. */
export function ringDash(fraction: number): string {
  return `${(fraction * RING_CIRCUMFERENCE).toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`
}

// Pool Pods never count: these steps are about a machine the org connected, and the pool hides them anyway.
function daemonItem(local: DaemonRow[], now: number): GsItem {
  const base = {
    key: 'daemon',
    label: 'Connect a daemon',
    expl: 'Run one command on the host where your agents should live. It stays connected and runs agents locally over ACP.',
    // Ever connected is enough: a laptop that's merely asleep must not un-tick a step the user already completed.
    done: local.some(daemonEverConnected),
    ctaLabel: 'Add a daemon',
    action: { kind: 'daemon' } as GsAction
  }
  if (base.done || local.length === 0) return base
  // Created but never connected: point at the newest row, the one the user most likely just added.
  const newest = local.reduce((a, b) => (Date.parse(b.createdAtIso) > Date.parse(a.createdAtIso) ? b : a))
  const age = now - Date.parse(newest.createdAtIso)
  const late = Number.isFinite(age) && age >= DAEMON_CONNECT_GRACE_MS
  return {
    ...base,
    expl: late
      ? 'A daemon was created but has never connected. Usually the command was not run on the host, the process stopped, or the host cannot reach this console. Get a fresh command and run it there.'
      : 'Waiting for the daemon to connect. If you have not run the command on the host yet, get it again.',
    ctaLabel: 'Get the connect command',
    action: { kind: 'daemon-reconnect', daemonId: newest.daemonId },
    variant: late ? 'not-connected' : 'waiting'
  }
}

function runtimeItem(local: DaemonRow[]): GsItem {
  const connected = local.filter(daemonEverConnected)
  const base = {
    key: 'runtime',
    label: 'Get a runtime ready',
    expl: "Agents run on a coding runtime such as Claude Code or Codex, installed and signed in on the daemon's host.",
    done: connected.some((d) => d.runtimeModels.some(runtimeUsable)),
    ctaLabel: 'Check runtimes',
    action: { kind: 'daemon-detail', daemonId: connected[0]?.daemonId ?? null } as GsAction
  }
  if (base.done || connected.length === 0) return base
  // A login is a concrete fix, so it wins over a runtime whose probe has not settled.
  for (const d of connected) {
    const login = d.runtimeModels.find((r) => runtimeWarning(r) === 'auth-required')
    if (login) {
      return {
        ...base,
        expl: "A runtime on your daemon needs a login. Run the login command on the daemon's host.",
        ctaLabel: 'Show login command',
        action: { kind: 'runtime-login', daemonId: d.daemonId, runtimeId: login.runtime },
        variant: 'login'
      }
    }
  }
  // Online with no reported issue yet: the probe may still be running, so no fix is asked for.
  const checking = connected.find(
    (d) => d.status === 'online' && (d.runtimeModels.length === 0 || d.runtimeModels.some((r) => !runtimeWarning(r)))
  )
  if (checking) {
    return {
      ...base,
      expl: "Your daemon hasn't confirmed a working runtime yet. Its check may still be running; open the daemon to see each runtime.",
      action: { kind: 'daemon-detail', daemonId: checking.daemonId },
      variant: 'checking'
    }
  }
  return base
}

export function computeGettingStarted(input: {
  agents: Agent[]
  daemons: DaemonRow[]
  integrations: IntegrationRow[]
  sessions: Session[]
  members: MemberDto[]
  /** Auth mode: no-auth deployments have a single implicit org and no member list. */
  authOn: boolean
  /** Org-level "any session exists" (GET /sessions `orgHasSessions`, a bare boolean over
   *  the FULL org). Preferred over `sessions` for the conversation step: the list is
   *  caller-visibility-filtered, so restricted/private-only orgs would under-report.
   *  Undefined (not yet loaded / older CP) falls back to the visible list. */
  orgHasSessions?: boolean
  /** Whether the caller's own profile has a GitHub identity linked (per-user — the
   *  App install above is org-level; repo access checks act as the user). Undefined
   *  ⇒ unknowable or not applicable (auth off, no GitHub connector, account still
   *  loading): the step is omitted rather than shown un-tickable. */
  githubLinked?: boolean
  /** Whether this deployment's GitHub App provider is configured (GITHUB_APP_* env —
   *  the installations probe 404s otherwise). False ⇒ the GitHub steps are hidden:
   *  there is nothing to install. Undefined (probe in flight / failed) keeps them. */
  githubEnabled?: boolean
  /** Whether SettingsView's SessionAccessCard would render anything (mirrors its own
   *  `hasNothingToOffer`, one per provider). False ⇒ the session-access step is hidden —
   *  its CTA would land on a page with no card to scroll to. Undefined (probe in
   *  flight) keeps the step. */
  sessionAccessAvailable?: boolean
  /** Whether the user has clicked through to review the session access policy. The CP
   *  has no signal for a look-don't-touch review, so the caller records the click
   *  client-side (localStorage) and feeds it back here. */
  sessionAccessReviewed?: boolean
  /** The `daemon-pool` flag: on, agents run on the cloud pool and the daemon and runtime steps are dropped. */
  poolEnabled?: boolean
  /** Clock for the never-connected grace; tests pin it. */
  now?: number
}): GettingStarted {
  const {
    agents,
    daemons,
    integrations,
    sessions,
    members,
    authOn,
    orgHasSessions,
    githubLinked,
    githubEnabled,
    sessionAccessAvailable,
    sessionAccessReviewed,
    poolEnabled,
    now = Date.now()
  } = input
  // Pick a chat-capable / bindable agent for the agent-scoped CTAs. Prefer the built-in
  // `agentconnect` preset — the canonical agent every org gets — else the first agent.
  const builtin = agents.find((a) => a.builtin)
  const firstAgent = (builtin ?? agents[0])?.id ?? null

  const local = localDaemons(daemons)

  const items: GsItem[] = [
    // Cloud pool on ⇒ no daemon to connect; the pool hosts the agents.
    ...(poolEnabled ? [] : [daemonItem(local, now), runtimeItem(local)]),
    {
      key: 'slack',
      label: 'Connect Slack',
      expl: 'Assign a bot so your agents can read and post in Slack channels — one click connects the built-in AgentConnect Bot.',
      done: integrations.some((i) => i.platform === 'slack'),
      ctaLabel: 'Connect Slack',
      action: { kind: 'slack', agentId: firstAgent }
    },
    // Both GitHub steps vanish when the deployment has no GitHub App provider at
    // all (`githubEnabled === false`) — installing and profile-linking are dead
    // ends without it.
    ...(githubEnabled === false
      ? []
      : [
          {
            key: 'github',
            label: 'Connect GitHub and assign a repository',
            expl: 'Install the GitHub App, then point an agent at a repo, branch and working directory so it has code to work in.',
            done: agents.some((a) => a.workspace?.mode === 'git' && a.workspace.provider === 'github'),
            ctaLabel: 'Connect GitHub',
            action: { kind: 'github', agentId: firstAgent } as const
          },
          // The App install above is org-level; SEEING private repositories is per-user
          // (repo probes act as the caller — GITHUB_IDENTITY_REQUIRED otherwise). Only a
          // member signed in WITHOUT GitHub (Google/Slack — no GitHub identity on the
          // profile) gets this step; GitHub sign-ins are born linked, and for them the
          // row would be permanent done-noise. Also omitted when unknowable
          // (see `githubLinked`).
          ...(githubLinked !== false
            ? []
            : [
                {
                  key: 'github-profile',
                  label: 'Link your GitHub profile',
                  expl: 'You signed in without GitHub. Link it to your profile so repository pickers and access checks act as you — private repositories included.',
                  done: false,
                  ctaLabel: 'Link GitHub profile',
                  action: { kind: 'github-profile' } as const
                }
              ])
        ]),
    {
      key: 'conversation',
      label: 'Start your first conversation',
      expl: 'Send one message and watch the agent work — in a connected channel or in the Playground.',
      // Product decision (2026-07-30, mirrored in preset-agents.md §6.2): ANY session
      // in the org ticks this — a session existing at all means a conversation has
      // been driven here (Playground or a channel), which is exactly what this step
      // teaches. Requiring a terminal status (or "your own" session) made orgs with
      // live sessions re-run a chat just to clear the step. `orgHasSessions` is the
      // org-wide boolean (unfiltered by visibility); the caller-visible list is only
      // the fallback while it hasn't loaded / on an older CP.
      done: orgHasSessions ?? sessions.length > 0,
      ctaLabel: 'Start a conversation',
      action: { kind: 'chat' }
    }
  ]

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
  // Session access lives on /settings, which no-auth deployments don't have (they
  // bounce to /home) — gated like invite above. It also vanishes when SessionAccessCard
  // itself would render nothing (`sessionAccessAvailable === false`) — same reasoning as
  // the GitHub steps: a CTA must not point at a missing anchor. Last, as a review step.
  if (authOn && sessionAccessAvailable !== false) {
    items.push({
      key: 'session-access',
      label: 'Review session access policy',
      expl: "Decide who can see session content synced from Slack, GitHub, and Feishu — on by default, following each platform's own access.",
      // A look-don't-touch review has no CP signal — the caller records the CTA click
      // client-side (`sessionAccessReviewed`) and that's what ticks the row.
      done: !!sessionAccessReviewed,
      ctaLabel: 'Review session access',
      action: { kind: 'session-access' }
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
    ring: ringDash(fraction),
    allDone: done === total
  }
}
