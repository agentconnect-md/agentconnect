import { describe, it, expect } from 'vitest'
import { computeGettingStarted } from './getting-started'
import type { Agent, DaemonRow, IntegrationRow, Session } from '@/lib/data'
import type { MemberDto } from '@/lib/api'

const agent = (over: Partial<Agent> = {}): Agent =>
  ({ id: 'a1', name: 'bot', model: 'default', runtime: 'claude', workspace: { mode: 'scratch' }, ...over }) as Agent
const daemon = (status: DaemonRow['status']): DaemonRow => ({ daemonId: 'd1', status }) as DaemonRow
const empty = { agents: [], daemons: [], integrations: [], sessions: [], members: [], authOn: true }

describe('computeGettingStarted', () => {
  it('starts all-incomplete for a fresh org and reports progress', () => {
    const gs = computeGettingStarted(empty)
    expect(gs.done).toBe(0)
    expect(gs.total).toBe(7) // 6 core + invite (auth mode)
    expect(gs.fraction).toBe(0)
    expect(gs.allDone).toBe(false)
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

  it('derives agent, repo, and github items from the agent shape', () => {
    const scratch = computeGettingStarted({ ...empty, agents: [agent()] })
    expect(scratch.items.find((i) => i.key === 'agent')!.done).toBe(true)
    expect(scratch.items.find((i) => i.key === 'repo')!.done).toBe(false)
    expect(scratch.items.find((i) => i.key === 'github')!.done).toBe(false)

    const wired = computeGettingStarted({
      ...empty,
      agents: [agent({ workspace: { mode: 'github', repo: 'acme/x' } as Agent['workspace'], hookKinds: ['github'] })]
    })
    expect(wired.items.find((i) => i.key === 'repo')!.done).toBe(true)
    expect(wired.items.find((i) => i.key === 'github')!.done).toBe(true)
  })

  it('marks slack, conversation, and invite from their signals', () => {
    const gs = computeGettingStarted({
      ...empty,
      integrations: [{ platform: 'slack', name: 's' } as IntegrationRow],
      sessions: [{ id: 's1' } as Session],
      members: [{ userId: 'u1' } as MemberDto, { userId: 'u2' } as MemberDto]
    })
    expect(gs.items.find((i) => i.key === 'slack')!.done).toBe(true)
    expect(gs.items.find((i) => i.key === 'conversation')!.done).toBe(true)
    expect(gs.items.find((i) => i.key === 'invite')!.done).toBe(true)
  })

  it('points agent-scoped CTAs at the first agent, else falls back to create-agent', () => {
    expect(computeGettingStarted(empty).items.find((i) => i.key === 'repo')!.action).toEqual({
      kind: 'agentRepo',
      agentId: null
    })
    const withAgent = computeGettingStarted({ ...empty, agents: [agent({ id: 'a9' })] })
    expect(withAgent.items.find((i) => i.key === 'slack')!.action).toEqual({ kind: 'slack', agentId: 'a9' })
  })

  it('reaches allDone with a full ring when every signal is satisfied', () => {
    const gs = computeGettingStarted({
      agents: [agent({ workspace: { mode: 'github', repo: 'acme/x' } as Agent['workspace'], hookKinds: ['github'] })],
      daemons: [daemon('online')],
      integrations: [{ platform: 'slack', name: 's' } as IntegrationRow],
      sessions: [{ id: 's1' } as Session],
      members: [{ userId: 'u1' } as MemberDto, { userId: 'u2' } as MemberDto],
      authOn: true
    })
    expect(gs.allDone).toBe(true)
    expect(gs.fraction).toBe(1)
    // dash length equals the full circumference (2π·10.5 ≈ 65.97)
    expect(gs.ring.split(' ')[0]).toBe(gs.ring.split(' ')[1])
  })
})
