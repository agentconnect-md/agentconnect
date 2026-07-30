import { describe, it, expect } from 'vitest'
import { computeGettingStarted } from './getting-started'
import type { Agent, DaemonRow, IntegrationRow, Session } from '@/lib/data'
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
const daemon = (
  status: DaemonRow['status'],
  runtimeModels: { runtime: string; authRequired?: boolean; models?: string[] }[] = []
) => ({ daemonId: 'd1', status, runtimeModels: runtimeModels.map((r) => ({ models: ['m1'], ...r })) }) as DaemonRow
const empty = { agents: [], daemons: [], integrations: [], sessions: [], members: [], authOn: true }

describe('computeGettingStarted', () => {
  it('starts all-incomplete for a fresh org and reports progress', () => {
    const gs = computeGettingStarted(empty)
    expect(gs.done).toBe(0)
    expect(gs.total).toBe(7) // 6 core + invite (auth mode)
    expect(gs.fraction).toBe(0)
    expect(gs.allDone).toBe(false)
    expect(gs.hasWarn).toBe(false) // no online daemon ⇒ the daemon step owns the attention
  })

  it('orders the steps per the design: daemon, runtime, agent, slack, github, conversation, invite', () => {
    expect(computeGettingStarted(empty).items.map((i) => i.key)).toEqual([
      'daemon',
      'runtime',
      'agent',
      'slack',
      'github',
      'conversation',
      'invite'
    ])
  })

  it('drops the invite item in no-auth mode', () => {
    expect(computeGettingStarted({ ...empty, authOn: false }).total).toBe(6)
    expect(computeGettingStarted({ ...empty, authOn: false }).items.some((i) => i.key === 'invite')).toBe(false)
  })

  it('marks daemon done only for an online daemon', () => {
    const done = (rows: DaemonRow[]) =>
      computeGettingStarted({ ...empty, daemons: rows }).items.find((i) => i.key === 'daemon')!.done
    expect(done([daemon('offline')])).toBe(false)
    expect(done([daemon('online')])).toBe(true)
  })

  it('turns the runtime step amber only when a daemon is online with nothing signed in', () => {
    const rt = (rows: DaemonRow[]) =>
      computeGettingStarted({ ...empty, daemons: rows }).items.find((i) => i.key === 'runtime')!
    // no online daemon: open but calm
    expect(rt([daemon('offline')])).toMatchObject({ done: false, warn: false })
    // online, every runtime auth-required: needs attention
    const warned = rt([daemon('online', [{ runtime: 'claude', authRequired: true }])])
    expect(warned).toMatchObject({ done: false, warn: true })
    expect(warned.action).toEqual({ kind: 'runtime', daemonId: 'd1' })
    // probe pending/failed (no advertised models) is NOT signed in — authRequired
    // absence alone must not tick the step
    expect(rt([daemon('online', [{ runtime: 'claude', models: [] }])])).toMatchObject({ done: false, warn: true })
    // online with a probed, signed-in runtime: done
    expect(rt([daemon('online', [{ runtime: 'claude' }])]).done).toBe(true)
    // hasWarn surfaces the amber state
    const gs = computeGettingStarted({
      ...empty,
      daemons: [daemon('online', [{ runtime: 'claude', authRequired: true }])]
    })
    expect(gs.hasWarn).toBe(true)
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

  it('requires a COMPLETED conversation — running or failed sessions do not tick the item', () => {
    const convo = (sessions: Session[]) =>
      computeGettingStarted({ ...empty, sessions }).items.find((i) => i.key === 'conversation')!.done
    expect(convo([{ id: 's1', statusLabel: 'running' } as Session])).toBe(false)
    expect(convo([{ id: 's1', statusLabel: 'failed' } as Session])).toBe(false)
    expect(convo([{ id: 's1', statusLabel: 'completed' } as Session])).toBe(true)
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

  it('reaches allDone with a full ring when every signal is satisfied', () => {
    const gs = computeGettingStarted({
      agents: [agent({ workspace: { mode: 'github', repo: 'acme/x' } as Agent['workspace'], hookKinds: ['github'] })],
      daemons: [daemon('online', [{ runtime: 'claude' }])],
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
