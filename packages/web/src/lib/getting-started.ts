// Getting-started checklist logic (design: "Getting Started Placement" 1a/1b — the
// floating pill + slide-over drawer). Every item is DERIVED from live console state,
// never a stored "done" tick (preset-agents.md §6.2). The pill persists while any
// item is incomplete and vanishes for good once the list is complete — there is no
// manual dismiss, so the only state this module owns is the pure derivation.
//
// Steps in the design's order: daemon → meet your agent → Slack → GitHub+repo (one
// merged step) → first conversation → invite. The daemon step is dropped where the
// deployment offers the cloud pool (`poolEnabled`) — there is nothing to connect. Still not derivable client-side (left
// out rather than faked, preset-agents.md §6.2): the "Runtime signed in"
// needs-attention item — neither `authRequired` (absence also means probe
// pending/failed) nor advertised models (a usable runtime may legitimately have no
// model selector) encode readiness; add it when the explicit
// pending|ready|auth_required|failed probe status ships. Same for the per-item
// "Ask agentconnect" automation (§6.3/§6.4 delegated writes).

import { agentIsPlaced, localDaemons } from './data'
import type { Agent, DaemonRow, IntegrationRow, Session } from './data'
import type { MemberDto } from './api'

// What the item's primary CTA drives. The component maps kind → a real handler
// (open a modal, route to a page) so this stays pure and testable.
export type GsAction =
  | { kind: 'daemon' }
  | { kind: 'agent' }
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
  /** Short chip after the label (e.g. "optional") — see `optional` below. */
  tag?: string
  /** Unlike every other item, has no live signal for "done" (it's a look-don't-touch
   *  review, not a setup task) — `done` is hardcoded true so it never drags the ring
   *  or blocks "Finish onboarding". `optional` keeps its CTA visible despite `done`,
   *  since GsRows normally hides the button once an item is done. */
  optional?: boolean
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
  /** Is the `daemon-pool` flag on for this deployment? On, agents run on the cloud pool, so
   *  "Connect a daemon" is dropped — the console offers no daemon to connect. Off (a self-hosted
   *  install) keeps it as the first step. */
  poolEnabled?: boolean
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
    poolEnabled
  } = input
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
    // Cloud pool on ⇒ no daemon to connect; the pool hosts the agents.
    ...(poolEnabled
      ? []
      : [
          {
            key: 'daemon',
            label: 'Connect a daemon',
            expl: 'Run one command on the host where your agents should live. It stays connected and runs agents locally over ACP.',
            // Registered is enough — an offline daemon has still been set up, and a laptop
            // that's merely asleep shouldn't un-tick a step the user already completed. Pool
            // Pods don't count: this step is about a machine, and they are hidden here anyway.
            done: localDaemons(daemons).length > 0,
            ctaLabel: 'Add a daemon',
            action: { kind: 'daemon' } as const
          }
        ]),
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
            done: agents.some((a) => a.workspace?.mode === 'github'),
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

  // Session access lives on /settings, which no-auth deployments don't have (they
  // bounce to /home) — gate it with the other auth-only step below. It also vanishes
  // when SessionAccessCard itself would render nothing (`sessionAccessAvailable === false`)
  // — same reasoning as the GitHub steps: a CTA must not point at a missing anchor.
  if (authOn && sessionAccessAvailable !== false) {
    items.push({
      key: 'session-access',
      label: 'Review session access policy',
      expl: "Decide who can see session content synced from Slack, GitHub, and Feishu — on by default, following each platform's own access.",
      done: true,
      optional: true,
      tag: 'optional',
      ctaLabel: 'Review session access',
      action: { kind: 'session-access' }
    })
  }
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
