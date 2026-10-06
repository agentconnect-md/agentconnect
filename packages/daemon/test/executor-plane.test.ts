import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import type { ExecutorPrepareReq, ExecutorPrepareResult, ExecutorReleaseResult } from '@agentconnect.md/protocol'
import { sessionKeyDirName } from '../src/acp/host-key.js'
import { executorMount, ExecutorPlane } from '../src/execution/executor-plane.js'
import type { PlacementChoice } from '../src/execution/executor-placement.js'
import { sessionSandboxSubject } from '../src/remote/sandbox-subject.js'
import { cwdWorkspaceIncarnation } from '../src/skills/workspace-incarnation.js'

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

  it('stops at an environment made under another strategy: a startup error, no other candidate, nothing placed (§5)', async () => {
    const { executor, sent } = plane([{ status: 'refused', reason: 'strategy_mismatch' }, ready(1)])
    await expect(executor.prepareAt(AGENT, KEY, [HOST, OTHER])).rejects.toThrow(
      `session ${LEAF} has an environment on daemon ${HOST.daemonId} made under another strategy than host`
    )
    // Moving on would start the session over on another machine, away from the work its environment holds.
    expect(sent.map((req) => req.executorDaemonId)).toEqual([HOST.daemonId])
    expect(executor.placementOf(KEY)).toBeUndefined()
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

describe("the .codex split a placed session's executor reported", () => {
  const HOME = '/srv/agentconnect/sessions/s/home'
  const codexState = { home: HOME, readOnly: [`${HOME}/.codex`], secret: [`${HOME}/.codex/config.toml`] }

  it('is handed over for the HOME the launch runs in', async () => {
    const { executor } = plane([ready(2, { codexState })])
    await executor.prepareAt(AGENT, KEY, [HOST])
    expect(executor.codexStateFor(SUBJECT, HOME)).toEqual({ readOnly: codexState.readOnly, secret: codexState.secret })
  })

  it('is none for another HOME, or from an executor that reports none: the launch denies `.codex` whole', async () => {
    const { executor } = plane([ready(2, { codexState })])
    await executor.prepareAt(AGENT, KEY, [HOST])
    expect(executor.codexStateFor(SUBJECT, '/elsewhere/home')).toBeUndefined()
    const older = plane([ready(2)])
    await older.executor.prepareAt(AGENT, KEY, [HOST])
    expect(older.executor.codexStateFor(SUBJECT, HOME)).toBeUndefined()
  })
})

describe('the key a placed session keeps its skill ledger under', () => {
  const WORKSPACE = 'workspace:5e7b6f7c0d0a4c1f9a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f'

  it('is the session directory the executor reported, the same after an idle close relaunches it', async () => {
    const { executor, sent } = plane([
      ready(2, { workspaceIncarnation: WORKSPACE }),
      ready(3, { workspaceIncarnation: WORKSPACE })
    ])
    await executor.prepareAt(AGENT, KEY, [HOST])
    expect(executor.workspaceIncarnationFor(SUBJECT)).toBe(WORKSPACE)
    await executor.suspendIdle(SUBJECT)
    await executor.prepareAt(AGENT, KEY, [HOST])
    // A new launch over the same directory: its skills are the ones the ledger already records, not foreign ones.
    expect(sent[0]!.launchId).not.toBe(sent[1]!.launchId)
    expect(executor.workspaceIncarnationFor(SUBJECT)).toBe(WORKSPACE)
  })

  it('is the launch for an executor that reports no directory', async () => {
    const { executor, sent } = plane([ready(2)])
    await executor.prepareAt(AGENT, KEY, [HOST])
    expect(executor.workspaceIncarnationFor(SUBJECT)).toBe(sent[0]!.launchId)
  })
})

describe('the skills a placed session installs', () => {
  const CWD = `/var/lib/agentconnect/sessions/${LEAF}/workspace`

  /** A bound shim session that records what the skills seam asks of it. */
  function bound() {
    const { executor } = plane([])
    const request = vi.fn(async () => ({ intact: [] }))
    const session = { isAttached: () => true, hasCapability: () => true, request }
    ;(executor as unknown as { binder: { sessionFor: () => unknown } }).binder.sessionFor = () => session
    return { executor, request }
  }

  // The shim is rooted at the session directory, above the checkout where runtimes scan for project skills.
  it('aims every request at the cwd it is given', async () => {
    const { executor, request } = bound()
    await executor.skillClientFor(SUBJECT, CWD)!.verify([])
    expect(request).toHaveBeenCalledWith('skills', { cwd: CWD, request: { op: 'verify', roots: [] } }, undefined)
  })

  it('sends the bare request without one, which the shim installs at its own root', async () => {
    const { executor, request } = bound()
    await executor.skillClientFor(SUBJECT)!.verify([])
    expect(request).toHaveBeenCalledWith('skills', { op: 'verify', roots: [] })
  })

  it('keeps the receipts of installs into a cwd apart from those at the session directory', () => {
    const reported = 'workspace:5e7b6f7c0d0a4c1f9a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f'
    // Receipt paths are relative to the directory installed into: one at the session root must never vouch for the checkout.
    expect(cwdWorkspaceIncarnation(reported, CWD)).not.toBe(reported)
    expect(cwdWorkspaceIncarnation(reported, CWD)).toBe(cwdWorkspaceIncarnation(reported, CWD))
    expect(cwdWorkspaceIncarnation(reported, CWD)).not.toBe(cwdWorkspaceIncarnation(reported, `${CWD}/sub`))
  })
})

describe('the adapter a placed session starts', () => {
  // What this machine's own store would launch: its node and a tree only it has.
  const own = { command: '/opt/holder/node', args: ['/srv/holder/runtimes/adapter@1.0.0/bin.js', '--acp'], env: [] }
  const installed = { command: '/usr/bin/node', args: ['/var/lib/agentconnect/runtimes/adapter@1.1.0/bin.js', '--acp'] }

  it('is the install its executor named in the reply, the rest of the definition kept', async () => {
    const { executor } = plane([ready(1, { runtimeLaunch: installed })])
    await executor.prepareAt(AGENT, KEY, [HOST])
    const env = [{ name: 'EXAMPLE_FLAG', value: '1' }]
    expect(executor.runtimeDefFor(KEY, { ...own, env })).toEqual({ ...installed, env })
  })

  it("stays this machine's definition when the executor named none, and for a session placed nowhere", async () => {
    const { executor } = plane([ready(1)])
    await executor.prepareAt(AGENT, KEY, [HOST])
    expect(executor.runtimeDefFor(KEY, own)).toBe(own)
    expect(executor.runtimeDefFor(`slack:C9:1700000000.000900:${AGENT}`, own)).toBe(own)
  })

  it('goes with the launch, so an idle session asks its executor again', async () => {
    const { executor } = plane([ready(1, { runtimeLaunch: installed }), ready(2)])
    await executor.prepareAt(AGENT, KEY, [HOST])
    await executor.suspendIdle(SUBJECT)
    expect(executor.runtimeDefFor(KEY, own)).toBe(own)
    await executor.prepareAt(AGENT, KEY, [HOST])
    expect(executor.runtimeDefFor(KEY, own)).toBe(own)
  })
})

describe('the mount a session composes on', () => {
  it('is the executor root its shim reported a session directory under', () => {
    expect(executorMount(`/var/lib/agentconnect/sessions/${LEAF}`, LEAF)).toBe('/var/lib/agentconnect')
    expect(executorMount('/agent', LEAF)).toBeUndefined()
    expect(executorMount(undefined, LEAF)).toBeUndefined()
  })
})
