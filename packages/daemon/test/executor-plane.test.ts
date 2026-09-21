import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import type { ExecutorPrepareReq, ExecutorPrepareResult, ExecutorReleaseResult } from '@agentconnect.md/protocol'
import { sessionKeyDirName } from '../src/acp/host-key.js'
import { executorMount, ExecutorPlane } from '../src/execution/executor-plane.js'
import type { PlacementChoice } from '../src/execution/executor-placement.js'
import { sessionSandboxSubject } from '../src/remote/sandbox-subject.js'

// What the holder does with a launch (session-executors.md §6, §7): one uuid per launch, the
// executor's generation, a retired launch given up rather than replayed, and the loss rule.

const AGENT = '11111111-1111-4111-8111-111111111111'
const KEY = `slack:C1:1700000000.000100:${AGENT}`
const LEAF = sessionKeyDirName(KEY)
const SUBJECT = sessionSandboxSubject(AGENT, LEAF)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HOST: PlacementChoice = { daemonId: '22222222-2222-4222-8222-222222222222', strategy: 'host' }
const OTHER: PlacementChoice = { daemonId: '33333333-3333-4333-8333-333333333333', strategy: 'host' }
const quiet = { info: () => {}, warn: () => {} }

function ready(generation: number, over: Partial<Extract<ExecutorPrepareResult, { status: 'ready' }>> = {}) {
  return {
    status: 'ready' as const,
    generation,
    endpoint: { host: '10.0.0.2', port: 7100 },
    psk: Buffer.alloc(32, 7).toString('base64url'),
    runtimeRoot: '/var/lib/agentconnect/hs/ab12cd',
    helperRoot: '/opt/agentconnect-daemon',
    liveCount: 1,
    ...over
  }
}

function plane(
  answers: ExecutorPrepareResult[],
  over: { replace?: () => Promise<PlacementChoice | undefined>; release?: () => Promise<ExecutorReleaseResult> } = {}
) {
  const sent: ExecutorPrepareReq[] = []
  const released: Array<{ sessionKey: string; launchId: string; executorDaemonId: string }> = []
  const prepare = vi.fn(
    async (launch: {
      agentId: string
      sessionKey: string
      executorDaemonId: string
      launchId: string
      strategy: string
    }) => {
      sent.push({
        agentId: launch.agentId,
        sessionKey: launch.sessionKey,
        executorDaemonId: launch.executorDaemonId,
        launchId: launch.launchId,
        strategy: launch.strategy
      })
      const next = answers.shift()
      if (!next) throw new Error('no answer scripted for this prepare')
      return next
    }
  )
  const executor = new ExecutorPlane({
    prepare,
    release: async (placed, launchId) => {
      released.push({ sessionKey: placed.sessionKey, launchId, executorDaemonId: placed.executorDaemonId })
      return await (over.release?.() ?? Promise.resolve({ status: 'released' as const }))
    },
    replace: over.replace ?? (async () => undefined),
    log: quiet,
    clock: new FakeClock(Date.parse('2026-09-21T12:00:00.000Z'))
  })
  return { executor, prepare, sent, released }
}

describe('preparing a session at birth', () => {
  it('mints one launch id, asks the first candidate, and binds at the generation the reply returned', async () => {
    const { executor, sent } = plane([ready(4)])
    const landed = await executor.prepareAt(AGENT, KEY, [HOST, OTHER])
    expect('placed' in landed && landed.placed.executorDaemonId).toBe(HOST.daemonId)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      agentId: AGENT,
      sessionKey: KEY,
      executorDaemonId: HOST.daemonId,
      strategy: 'host'
    })
    expect(sent[0]!.launchId).toMatch(UUID)
    // The executor allocates it; the holder has no counter of its own.
    expect(executor.shimGenerationFor(SUBJECT)).toBe(4)
    expect(executor.rootsFor(KEY)).toEqual({
      runtimeRoot: '/var/lib/agentconnect/hs/ab12cd',
      helperRoot: '/opt/agentconnect-daemon',
      missingHelpers: []
    })
  })

  it('moves to the next candidate when the first is full, and to nowhere when every one is', async () => {
    const { executor, sent } = plane([{ status: 'full', liveCount: 8 }, ready(1)])
    const landed = await executor.prepareAt(AGENT, KEY, [HOST, OTHER])
    expect('placed' in landed && landed.placed.executorDaemonId).toBe(OTHER.daemonId)
    expect(sent.map((req) => req.executorDaemonId)).toEqual([HOST.daemonId, OTHER.daemonId])
    // Each candidate is a launch of its own: nothing of the session exists on the one that refused.
    expect(new Set(sent.map((req) => req.launchId)).size).toBe(2)

    const every = plane([{ status: 'full' }, { status: 'full' }])
    await expect(every.executor.prepareAt(AGENT, KEY, [HOST, OTHER])).resolves.toEqual({ refused: 'full' })
    expect(every.executor.placementOf(KEY)).toBeUndefined()
  })

  it('reports a refusal that is not a capacity one apart from `full`', async () => {
    const { executor } = plane([{ status: 'refused', reason: 'draining' }])
    await expect(executor.prepareAt(AGENT, KEY, [HOST])).resolves.toEqual({ refused: 'none' })
  })
})

describe('a launch the executor has retired', () => {
  it('is given up and asked again under a new id, never replayed under the old one', async () => {
    const { executor, sent } = plane([{ status: 'refused', reason: 'launch_retired' }, ready(9)])
    const landed = await executor.prepareAt(AGENT, KEY, [HOST])
    expect('placed' in landed).toBe(true)
    expect(sent).toHaveLength(2)
    expect(sent[0]!.launchId).not.toBe(sent[1]!.launchId)
    expect(sent[1]!.launchId).toMatch(UUID)
    expect(executor.shimGenerationFor(SUBJECT)).toBe(9)
  })
})

describe('the lazy loss rule', () => {
  it('fails the turn and keeps the session where it is inside the grace', async () => {
    const lastSeenAt = new Date(Date.parse('2026-09-21T11:59:00.000Z')).toISOString()
    const replace = vi.fn(async () => OTHER)
    const { executor } = plane([{ status: 'offline', lastSeenAt }], { replace })
    await expect(executor.prepareAt(AGENT, KEY, [HOST])).resolves.toEqual({ refused: 'none' })
    expect(replace).not.toHaveBeenCalled()
  })

  it('prepares elsewhere past the grace, under a launch of its own', async () => {
    const lastSeenAt = new Date(Date.parse('2026-09-21T11:40:00.000Z')).toISOString()
    const replace = vi.fn(async () => OTHER)
    const { executor, sent } = plane([{ status: 'offline', lastSeenAt }, ready(1)], { replace })
    const landed = await executor.prepareAt(AGENT, KEY, [HOST])
    expect('placed' in landed && landed.placed.executorDaemonId).toBe(OTHER.daemonId)
    expect(replace).toHaveBeenCalledOnce()
    expect(sent.map((req) => req.executorDaemonId)).toEqual([HOST.daemonId, OTHER.daemonId])
    expect(sent[0]!.launchId).not.toBe(sent[1]!.launchId)
  })

  it('leaves the session where it is when there is nowhere else to put it', async () => {
    const lastSeenAt = new Date(Date.parse('2026-09-21T11:40:00.000Z')).toISOString()
    const { executor } = plane([{ status: 'offline', lastSeenAt }], { replace: async () => undefined })
    await expect(executor.prepareAt(AGENT, KEY, [HOST])).resolves.toEqual({ refused: 'none' })
  })
})

describe('the session life', () => {
  it('retires by naming the launch it last prepared, and forgets the placement', async () => {
    const { executor, sent, released } = plane([ready(2)])
    await executor.prepareAt(AGENT, KEY, [HOST])
    await executor.retire(AGENT, KEY)
    expect(released).toEqual([{ sessionKey: KEY, launchId: sent[0]!.launchId, executorDaemonId: HOST.daemonId }])
    expect(executor.placementOf(KEY)).toBeUndefined()
  })

  it('drops the launch when the session goes idle, so the next one prepares again under a new id', async () => {
    const { executor, sent } = plane([ready(2), ready(3)])
    await executor.prepareAt(AGENT, KEY, [HOST])
    await expect(executor.suspendIdle(SUBJECT)).resolves.toBe('suspended')
    expect(executor.shimGenerationFor(SUBJECT)).toBeUndefined()
    // The cached reply went with the launch, so the next turn asks rather than reusing a key that opens nothing.
    await executor.prepareAt(AGENT, KEY, [HOST])
    expect(sent).toHaveLength(2)
    expect(sent[0]!.launchId).not.toBe(sent[1]!.launchId)
    expect(executor.shimGenerationFor(SUBJECT)).toBe(3)
  })

  it('answers `absent` for a session with no launch here', async () => {
    const { executor } = plane([])
    await expect(executor.suspendIdle(SUBJECT)).resolves.toBe('absent')
  })

  it('releases every other session of an agent whose workspace was replaced', async () => {
    const otherKey = `slack:C2:1700000000.000200:${AGENT}`
    const { executor, released } = plane([ready(1), ready(1)])
    await executor.prepareAt(AGENT, KEY, [HOST])
    await executor.prepareAt(AGENT, otherKey, [HOST])
    await executor.discardSessions(AGENT, sessionKeyDirName(otherKey))
    expect(released.map((entry) => entry.sessionKey)).toEqual([KEY])
    expect(executor.placementOf(otherKey)).toBeDefined()
  })
})

describe('the mount a session composes on', () => {
  it('is the executor root its shim reported a session directory under', () => {
    expect(executorMount(`/var/lib/agentconnect/sessions/${LEAF}`, LEAF)).toBe('/var/lib/agentconnect')
    expect(executorMount('/agent', LEAF)).toBeUndefined()
    expect(executorMount(undefined, LEAF)).toBeUndefined()
  })
})
