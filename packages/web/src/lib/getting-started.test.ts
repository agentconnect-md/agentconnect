import { describe, it, expect } from 'vitest'
import { computeGettingStarted } from './getting-started'
import type { Agent, IntegrationRow, Session } from '@/lib/data'
import type { MemberDto } from '@/lib/api'

const agent = (over: Partial<Agent> = {}): Agent =>
  ({
    id: 'a1',
    name: 'bot',
    model: 'default',
    runtime: 'claude',
    daemon: 'd1',
    workspace: { mode: 'scratch' },
    ...over
  }) as Agent
const empty = { agents: [], integrations: [], sessions: [], members: [], authOn: true }

describe('computeGettingStarted', () => {
  it('starts all-incomplete for a fresh org and reports progress', () => {
    const gs = computeGettingStarted(empty)
    // session-access always counts as done (it's a review step, not a setup task —
    // see its `optional` comment in getting-started.ts), so it contributes to both
    // done and total and never moves the fraction.
    expect(gs.done).toBe(1)
    expect(gs.total).toBe(6) // 4 core + session-access + invite (auth mode)
    expect(gs.fraction).toBe(1 / 6)
    expect(gs.allDone).toBe(false)
  })

  it('orders the steps per the design: agent, slack, github, conversation, session-access, invite', () => {
    // The "Runtime signed in" step is deferred until the explicit probe-status
    // signal ships (neither authRequired nor advertised models encode readiness).
    expect(computeGettingStarted(empty).items.map((i) => i.key)).toEqual([
      'agent',
      'slack',
      'github',
      'conversation',
      'session-access',
      'invite'
    ])
  })

  it('drops the invite AND session-access items in no-auth mode (no /settings there)', () => {
    expect(computeGettingStarted({ ...empty, authOn: false }).total).toBe(4)
    expect(computeGettingStarted({ ...empty, authOn: false }).items.some((i) => i.key === 'invite')).toBe(false)
    expect(computeGettingStarted({ ...empty, authOn: false }).items.some((i) => i.key === 'session-access')).toBe(false)
  })

  it('always marks session-access done (optional, look-not-fix) but keeps its CTA action', () => {
    const step = computeGettingStarted(empty).items.find((i) => i.key === 'session-access')!
    expect(step.done).toBe(true)
    expect(step.optional).toBe(true)
    expect(step.action).toEqual({ kind: 'session-access' })
  })

  it('hides session-access when its card would render nothing — the CTA must not point at a missing anchor', () => {
    const has = (sessionAccessAvailable?: boolean) =>
      computeGettingStarted({ ...empty, sessionAccessAvailable }).items.some((i) => i.key === 'session-access')
    expect(has(false)).toBe(false)
    // undefined (probe in flight / failed) keeps the step — same convention as githubEnabled
    expect(has(undefined)).toBe(true)
    expect(has(true)).toBe(true)
  })

  it('marks agent done only once some agent is placed (daemon + runtime)', () => {
    const done = (agents: Agent[]) =>
      computeGettingStarted({ ...empty, agents }).items.find((i) => i.key === 'agent')!.done
    expect(done([agent({ daemon: '—', runtime: '' })])).toBe(false) // the unplaced built-in preset
    expect(done([agent()])).toBe(true)
  })

  it('tracks the BUILT-IN preset when present — a placed custom agent alone must not tick the row', () => {
    const done = (agents: Agent[]) =>
      computeGettingStarted({ ...empty, agents }).items.find((i) => i.key === 'agent')!.done
    // placed custom agent + unplaced preset: the card still shows Set up, so the row stays open
    expect(done([agent({ id: 'custom' }), agent({ id: 'ac', builtin: true, daemon: '—', runtime: '' })])).toBe(false)
    expect(done([agent({ id: 'custom', daemon: '—', runtime: '' }), agent({ id: 'ac', builtin: true })])).toBe(true)
  })

  it('merges GitHub + repository into one step, done when a repo is attached', () => {
    const gh = (agents: Agent[]) => computeGettingStarted({ ...empty, agents }).items.find((i) => i.key === 'github')!
    expect(gh([agent()]).done).toBe(false)
    expect(gh([agent({ workspace: { mode: 'github', repo: 'acme/x' } as Agent['workspace'] })]).done).toBe(true)
    // the old separate 'repo' step is gone
    expect(computeGettingStarted(empty).items.some((i) => i.key === 'repo')).toBe(false)
  })

  it('marks slack, conversation, and invite from their signals', () => {
    const gs = computeGettingStarted({
      ...empty,
      integrations: [{ platform: 'slack', name: 's' } as IntegrationRow],
      sessions: [{ id: 's1', statusLabel: 'completed' } as Session],
      members: [{ userId: 'u1' } as MemberDto, { userId: 'u2' } as MemberDto]
    })
    expect(gs.items.find((i) => i.key === 'slack')!.done).toBe(true)
    expect(gs.items.find((i) => i.key === 'conversation')!.done).toBe(true)
    expect(gs.items.find((i) => i.key === 'invite')!.done).toBe(true)
  })

  it('marks the conversation done as soon as ANY session exists — no re-chat just to clear the step', () => {
    const convo = (sessions: Session[]) =>
      computeGettingStarted({ ...empty, sessions }).items.find((i) => i.key === 'conversation')!.done
    expect(convo([])).toBe(false)
    // running / channel-triggered / whoever ran it — a session existing at all means a
    // conversation has been driven here (product decision; see getting-started.ts).
    expect(convo([{ id: 's1', statusLabel: 'running' } as Session])).toBe(true)
    expect(convo([{ id: 's1', statusLabel: 'completed', triggeredBy: 'u_teammate' } as Session])).toBe(true)
  })

  it('prefers the org-wide orgHasSessions boolean over the caller-visible list', () => {
    const convo = (orgHasSessions: boolean | undefined, sessions: Session[] = []) =>
      computeGettingStarted({ ...empty, sessions, orgHasSessions }).items.find((i) => i.key === 'conversation')!.done
    // a collaborator who can see NO sessions still gets the tick when the org has some
    // (restricted/private rows are filtered out of GET /sessions)
    expect(convo(true)).toBe(true)
    // the boolean is authoritative in both directions once present
    expect(convo(false, [{ id: 's1' } as Session])).toBe(false)
    // not yet loaded / older CP: fall back to the visible list
    expect(convo(undefined, [{ id: 's1' } as Session])).toBe(true)
    expect(convo(undefined)).toBe(false)
  })

  it('points agent-scoped CTAs at the built-in agent first, else the first agent', () => {
    const withBuiltin = computeGettingStarted({
      ...empty,
      agents: [agent({ id: 'a9' }), agent({ id: 'ac', builtin: true })]
    })
    expect(withBuiltin.items.find((i) => i.key === 'slack')!.action).toEqual({ kind: 'slack', agentId: 'ac' })
    expect(computeGettingStarted(empty).items.find((i) => i.key === 'github')!.action).toEqual({
      kind: 'github',
      agentId: null
    })
  })

  it('adds the GitHub-profile step only for a signed-in user with NO GitHub identity', () => {
    const step = (githubLinked?: boolean) =>
      computeGettingStarted({ ...empty, githubLinked }).items.find((i) => i.key === 'github-profile')
    // auth off / no GitHub connector / account still loading → omitted entirely
    expect(step(undefined)).toBeUndefined()
    // GitHub sign-ins are born linked — never show them the step
    expect(step(true)).toBeUndefined()
    expect(step(false)).toMatchObject({ done: false, action: { kind: 'github-profile' } })
    // slots in right after the org-level GitHub install step
    const keys = computeGettingStarted({ ...empty, githubLinked: false }).items.map((i) => i.key)
    expect(keys.indexOf('github-profile')).toBe(keys.indexOf('github') + 1)
  })

  it('hides both GitHub steps when the deployment has no GitHub App provider', () => {
    const keys = (githubEnabled?: boolean, githubLinked?: boolean) =>
      computeGettingStarted({ ...empty, githubEnabled, githubLinked }).items.map((i) => i.key)
    expect(keys(false)).not.toContain('github')
    expect(keys(false, false)).not.toContain('github-profile')
    // undefined (probe in flight / failed) keeps the step — the hosted default
    expect(keys(undefined)).toContain('github')
    expect(keys(true)).toContain('github')
  })

  it('reaches allDone with a full ring when every signal is satisfied', () => {
    const gs = computeGettingStarted({
      agents: [agent({ workspace: { mode: 'github', repo: 'acme/x' } as Agent['workspace'], hookKinds: ['github'] })],
      integrations: [{ platform: 'slack', name: 's' } as IntegrationRow],
      sessions: [{ id: 's1', statusLabel: 'completed' } as Session],
      members: [{ userId: 'u1' } as MemberDto, { userId: 'u2' } as MemberDto],
      authOn: true
    })
    expect(gs.allDone).toBe(true)
    expect(gs.fraction).toBe(1)
    // dash length equals the full circumference (2π·10.5 ≈ 65.97)
    expect(gs.ring.split(' ')[0]).toBe(gs.ring.split(' ')[1])
  })
})
