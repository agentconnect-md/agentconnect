// auto-session-mode.md §4.9: opening the console on a pool agent prewarms its pod and the member's coordinator, at most once a minute.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openCoordinatorConversation } from '@/lib/api'
import type { Agent } from '@/lib/data'
import {
  COORDINATOR_PREWARM_REPEAT_MS,
  openAgentPlayground,
  playgroundAgentId,
  prewarmAgentOnOpen,
  prewarmsOnOpen
} from './coordinator'

vi.mock('@/lib/api', () => ({ openCoordinatorConversation: vi.fn(), prewarmAgent: vi.fn(async () => ({})) }))

afterEach(() => vi.unstubAllGlobals())

describe('prewarmsOnOpen', () => {
  it('prewarms only an agent on the pool, never one on a machine or the organization’s own group', () => {
    expect(prewarmsOnOpen({ placementKind: 'pool' }, new Set())).toBe(true)
    expect(prewarmsOnOpen({ placementKind: 'daemon' }, new Set())).toBe(false)
    expect(prewarmsOnOpen({ placementKind: 'set', setId: 'group-1' }, new Set(['group-1']))).toBe(false)
  })
})

describe('prewarmAgentOnOpen', () => {
  it('asks once a minute per agent', () => {
    const send = vi.fn(async () => ({ state: 'starting' }))
    prewarmAgentOnOpen('repeat-agent', 1_000, send)
    prewarmAgentOnOpen('repeat-agent', 1_000 + COORDINATOR_PREWARM_REPEAT_MS - 1, send)
    expect(send).toHaveBeenCalledTimes(1)
    prewarmAgentOnOpen('repeat-agent', 1_000 + COORDINATOR_PREWARM_REPEAT_MS, send)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('asks nothing from a hidden page', () => {
    vi.stubGlobal('document', { visibilityState: 'hidden' })
    const send = vi.fn(async () => ({ state: 'starting' }))
    prewarmAgentOnOpen('hidden-agent', 1_000, send)
    expect(send).not.toHaveBeenCalled()
  })

  it('swallows a refusal, so the first message only starts cold', async () => {
    const send = vi.fn(async () => {
      throw new Error('402')
    })
    expect(() => prewarmAgentOnOpen('unfunded-agent', 1_000, send)).not.toThrow()
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('playgroundAgentId', () => {
  it('reads the agent out of a playground id and nothing out of any other id', () => {
    expect(playgroundAgentId('pg_83cb2a71-6236-440f-bd31-d20f3e8e104a_99a2e82e-cbfb-4abf-8a64-853747205899')).toBe(
      '83cb2a71-6236-440f-bd31-d20f3e8e104a'
    )
    expect(playgroundAgentId('250de7f3-9b63-4b8e-a220-b18ca1dc353d')).toBeUndefined()
    expect(playgroundAgentId('pg_')).toBeUndefined()
  })
})

describe('openAgentPlayground', () => {
  const agent = { id: 'agent-1' } as Agent
  const open = vi.fn(
    (a: Agent, _m?: Agent[], o?: { conversationId?: string }) => `pg_${a.id}_${o?.conversationId ?? 'new'}`
  )
  afterEach(() => {
    open.mockClear()
    vi.mocked(openCoordinatorConversation).mockReset()
  })

  it('opens a fresh playground session where the agent has no coordinator', async () => {
    await expect(
      openAgentPlayground({ agent, orgId: 'org-1', coordinator: false, prewarm: false, openPlayground: open })
    ).resolves.toBe('pg_agent-1_new')
    expect(openCoordinatorConversation).not.toHaveBeenCalled()
  })

  it('opens the coordinator session once it has one, else a playground session on its conversation', async () => {
    const input = { agent, orgId: 'org-1', coordinator: true, prewarm: false, openPlayground: open }
    vi.mocked(openCoordinatorConversation).mockResolvedValueOnce({
      conversationId: 'conv-1',
      sessionId: 'session-1'
    } as never)
    await expect(openAgentPlayground(input)).resolves.toBe('session-1')
    vi.mocked(openCoordinatorConversation).mockResolvedValueOnce({ conversationId: 'conv-1' } as never)
    await expect(openAgentPlayground(input)).resolves.toBe('pg_agent-1_conv-1')
    vi.mocked(openCoordinatorConversation).mockRejectedValueOnce(new Error('offline'))
    await expect(openAgentPlayground(input)).resolves.toBe('pg_agent-1_new')
  })
})
