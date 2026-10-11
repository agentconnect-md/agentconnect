import { describe, expect, it, vi } from 'vitest'
import type { MemoryDreamingPolicy } from '@agentconnect.md/protocol'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DreamRunner } from '../src/dream/runner.js'
import { DreamScheduler } from '../src/scheduler/dream-scheduler.js'
import { Daemon } from '../src/daemon.js'
import { sessionKey, type LocalStore } from '../src/store/local-store.js'
import { openTestStore } from './store-support.js'
import { waitBudget } from './wait-support.js'

/** A cron that fires every second, so a real tick is observable in a test. */
const EVERY_SECOND = '* * * * * *'

function make(): { fired: string[]; warned: string[]; scheduler: DreamScheduler } {
  const fired: string[] = []
  const warned: string[] = []
  const scheduler = new DreamScheduler({
    onFire: async (id) => {
      fired.push(id)
    },
    warn: (m) => warned.push(m)
  })
  return { fired, warned, scheduler }
}

describe('DreamScheduler', () => {
  it('schedules only an enabled policy that carries a cron', () => {
    const { scheduler } = make()
    const cases: [string, MemoryDreamingPolicy | undefined, number][] = [
      ['no policy at all', undefined, 0],
      ['disabled with a schedule', { enabled: false, schedule: '0 4 * * *' }, 0],
      ['enabled without a schedule (manual-only)', { enabled: true }, 0],
      ['enabled with a schedule', { enabled: true, schedule: '0 4 * * *' }, 1]
    ]
    for (const [label, policy, expected] of cases) {
      scheduler.sync('a1', policy)
      expect(scheduler.count('a1'), label).toBe(expected)
    }
    scheduler.stop()
  })

  it('converges on re-sync and drops the job on unregister', () => {
    const { scheduler } = make()
    scheduler.sync('a1', { enabled: true, schedule: '0 4 * * *' })
    const first = scheduler.nextRun('a1')
    expect(first).toBeInstanceOf(Date)

    // Re-syncing is idempotent (replace-all), so a reconcile may call it freely.
    scheduler.sync('a1', { enabled: true, schedule: '0 4 * * *' })
    expect(scheduler.count('a1')).toBe(1)

    // Turning dreaming off converges the agent to unscheduled.
    scheduler.sync('a1', { enabled: false, schedule: '0 4 * * *' })
    expect(scheduler.count('a1')).toBe(0)
    expect(scheduler.nextRun('a1')).toBeNull()

    scheduler.sync('a1', { enabled: true, schedule: '0 4 * * *' })
    scheduler.unregister('a1')
    expect(scheduler.count('a1')).toBe(0)
    scheduler.stop()
  })

  it('drops a malformed expression with a warning instead of throwing at the reconciler', () => {
    const { warned, scheduler } = make()
    expect(() => scheduler.sync('a1', { enabled: true, schedule: 'not a cron' })).not.toThrow()
    expect(scheduler.count('a1')).toBe(0)
    expect(warned[0]).toContain('a1')

    // One bad agent must not stop a good one from scheduling.
    scheduler.sync('a2', { enabled: true, schedule: '0 4 * * *' })
    expect(scheduler.count('a2')).toBe(1)
    scheduler.stop()
  })

  it('rejects an invalid timezone without scheduling the agent', () => {
    const { warned, scheduler } = make()
    scheduler.sync('a1', { enabled: true, schedule: '0 4 * * *', timezone: 'Mars/Olympus_Mons' })
    expect(scheduler.count('a1')).toBe(0)
    expect(warned).toHaveLength(1)
    scheduler.stop()
  })

  it('fires onFire for the scheduled agent', async () => {
    const { fired, scheduler } = make()
    scheduler.sync('a1', { enabled: true, schedule: EVERY_SECOND })
    // Wait for the tick itself, not for a window a tick usually fits in: the cron is real, so a
    // runner slow enough to miss a fixed one-second-and-a-bit sleep failed this for no reason.
    await vi.waitFor(() => expect(fired.length).toBeGreaterThanOrEqual(1), waitBudget(30_000, 10))
    scheduler.stop()
    expect(new Set(fired)).toEqual(new Set(['a1']))
  })

  it('stops firing once stopped', async () => {
    const { fired, scheduler } = make()
    scheduler.sync('a1', { enabled: true, schedule: EVERY_SECOND })
    scheduler.stop()
    // A genuine real wait, and deliberately so: proving nothing fires needs a window in which a
    // live job WOULD have. Slowness only widens it, so this cannot fail from a loaded runner.
    await new Promise((r) => setTimeout(r, 1200))
    expect(fired).toHaveLength(0)
  })
})

describe('scheduled dream lifecycle gates (daemon)', () => {
  /** Minimal on-disk daemon root with one managed-memory agent that dreams on a cron. */
  function scaffold(): string {
    const root = mkdtempSync(join(tmpdir(), 'ac-dream-gate-'))
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({
        version: 1,
        controlPlane: { enabled: false },
        runtimes: { claude: { command: 'node', args: ['unused'] } }
      })
    )
    const adir = join(root, 'agents', 'bot-a')
    mkdirSync(adir, { recursive: true })
    writeFileSync(
      join(adir, 'agent.json'),
      JSON.stringify({
        id: 'bot-a',
        name: 'bot-a',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
        memory: { provider: 'managed', dreaming: { enabled: true, schedule: '0 4 * * *' } }
      })
    )
    return root
  }

  /** Fire the private schedule handler the way croner would, with the runner
   *  stubbed — so the assertion is purely "did the gate let this through?"
   *  (the real runner needs a started daemon, which the gates run before). */
  async function fire(daemon: Daemon, agentId: string): Promise<boolean> {
    let started = false
    const inner = daemon as unknown as {
      onDreamScheduleFire(id: string): void
      store?: { setDreamLastRun(id: string, at: number): void }
      dreamRunner(): {
        start(id: string, opts: unknown): Promise<unknown>
        hasNewSessionsSinceLastDream(id: string): boolean
      }
    }
    // The tick stamps its occurrence (#1031) ahead of the gates, and these daemons never start.
    inner.store ??= { setDreamLastRun: () => {} }
    inner.dreamRunner = () => ({
      start: async () => {
        started = true
        return { dreamId: 'drm-test' }
      },
      // Isolate the lifecycle gates from the "new sessions" gate — that gate has
      // its own unit coverage; here we only assert whether the gates let a tick through.
      hasNewSessionsSinceLastDream: () => true
    })
    inner.onDreamScheduleFire(agentId)
    await new Promise((r) => setTimeout(r, 20))
    return started
  }

  it('skips a tick while the agent is paused or the daemon is draining, without deregistering', async () => {
    const daemon = new Daemon({
      root: scaffold(),
      hostFactory: () => ({}) as any,
      dreamOperationPolicy: 'test-only'
    })
    const inner = daemon as unknown as {
      agents: Map<string, { pause?: boolean }>
      draining: boolean
      drainingAgents: Set<string>
      safetyDrainingAgents: Set<string>
    }
    inner.agents.set('bot-a', { pause: false })

    // Paused: an agent-wide operator stop must also stop background dreaming.
    inner.agents.set('bot-a', { pause: true })
    expect(await fire(daemon, 'bot-a')).toBe(false)

    // Interrupted turns still stopping.
    inner.agents.set('bot-a', { pause: false })
    inner.safetyDrainingAgents.add('bot-a')
    expect(await fire(daemon, 'bot-a')).toBe(false)
    inner.safetyDrainingAgents.delete('bot-a')

    // Per-agent drain, then daemon-wide drain.
    inner.drainingAgents.add('bot-a')
    expect(await fire(daemon, 'bot-a')).toBe(false)
    inner.drainingAgents.delete('bot-a')
    inner.draining = true
    expect(await fire(daemon, 'bot-a')).toBe(false)
    inner.draining = false

    // Gates are skips, not deregistrations: once they clear, the very next tick
    // runs. (That the cron object itself survives is covered by the
    // DreamScheduler sync/unregister tests above — the gate never touches it.)
    expect(await fire(daemon, 'bot-a')).toBe(true)
  })

  it('reaches the runner once the gates clear', async () => {
    const daemon = new Daemon({
      root: scaffold(),
      hostFactory: () => ({}) as any,
      dreamOperationPolicy: 'test-only'
    })
    const inner = daemon as unknown as { agents: Map<string, { pause?: boolean }> }
    inner.agents.set('bot-a', { pause: false })
    expect(await fire(daemon, 'bot-a')).toBe(true)
  })

  it('skips a tick when the runtime catalog offers no read-only or plan mode, and tries an unknown catalog', async () => {
    const daemon = new Daemon({
      root: scaffold(),
      hostFactory: () => ({}) as any,
      dreamOperationPolicy: 'test-only'
    })
    const inner = daemon as unknown as {
      agents: Map<string, { pause?: boolean; runtime?: string }>
      runtimeFacts: { modelCatalog(runtime: string): unknown }
    }
    inner.agents.set('bot-a', { pause: false, runtime: 'claude' })
    const catalog = (modes: string[]) => ({ models: [], permissionModes: modes.map((value) => ({ value })) })
    inner.runtimeFacts = { modelCatalog: () => catalog(['default', 'full-access']) }
    expect(await fire(daemon, 'bot-a')).toBe(false)
    inner.runtimeFacts = { modelCatalog: () => ({ models: [] }) }
    expect(await fire(daemon, 'bot-a')).toBe(false)
    inner.runtimeFacts = { modelCatalog: () => catalog(['default', 'plan']) }
    expect(await fire(daemon, 'bot-a')).toBe(true)
    inner.runtimeFacts = { modelCatalog: () => undefined }
    expect(await fire(daemon, 'bot-a')).toBe(true)
  })

  it('leaves the private sessions and places of an agent in assistant mode out of its dream sources (assistant-mode.md §5.5)', async () => {
    const daemon = new Daemon({ root: scaffold(), hostFactory: () => ({}) as any, dreamOperationPolicy: 'test-only' })
    const inner = daemon as unknown as {
      agents: Map<string, object>
      store: LocalStore
      channelSnapshots: Map<string, { channels: object[]; authoritative: boolean }>
      dreamRunner(): DreamRunner
    }
    inner.store = await openTestStore()
    // A DM (private session) and an org-visible session in a channel its membership listing reports private.
    for (const [channel, localExcluded, conversationKind] of [
      ['D1', true, 'dm'],
      ['G1', false, 'channel']
    ] as const) {
      const key = sessionKey('slack', channel, channel, 'bot-a')
      await inner.store.upsertSession({
        key,
        agentId: 'bot-a',
        platform: 'slack',
        channel,
        thread: channel,
        acpSessionId: `acp-${channel}`,
        state: 'idle',
        lastDeliveredTs: null,
        updatedAt: Date.now()
      })
      await inner.store.setLocalCaptureGate('bot-a', key, localExcluded)
      await inner.store.setSessionClassification(key, { conversationKind })
    }
    inner.channelSnapshots.set('int-1', { channels: [{ id: 'G1', isPrivate: true }], authoritative: true })
    const agent = {
      id: 'bot-a',
      memory: { provider: 'managed', dreaming: { enabled: true } },
      integrations: [{ id: 'int-1', platform: 'slack' }]
    }
    inner.agents.set('bot-a', agent)
    expect(await inner.dreamRunner().hasNewSessionsSinceLastDream('bot-a')).toBe(true)
    inner.agents.set('bot-a', { ...agent, assistantMode: { enabled: true, responsibleUserId: 'user-1' } })
    expect(await inner.dreamRunner().hasNewSessionsSinceLastDream('bot-a')).toBe(false)
    // Right after a restart nothing is known about G1 yet: still skipped, not counted as new activity.
    inner.channelSnapshots.clear()
    expect(await inner.dreamRunner().hasNewSessionsSinceLastDream('bot-a')).toBe(false)
    // Only the listing reporting it public makes the channel a source.
    inner.channelSnapshots.set('int-1', { channels: [{ id: 'G1', isPrivate: false }], authoritative: true })
    expect(await inner.dreamRunner().hasNewSessionsSinceLastDream('bot-a')).toBe(true)
    await inner.store.close()
  })

  it('suppresses schedules without the explicit test-only policy and rejects a stale tick before state', async () => {
    const root = scaffold()
    const hostFactory = vi.fn(() => ({}) as any)
    const daemon = new Daemon({ root, hostFactory, probeRuntimes: async () => [] })
    await daemon.start()
    try {
      const inner = daemon as any
      expect(inner.dreamScheduler.count('bot-a')).toBe(0)

      await expect(inner.dreamRunner().start('bot-a', { trigger: 'manual' })).rejects.toThrow(
        'model_readable_credentials'
      )
      await expect(
        inner.runDreamExtraction('bot-a', 'system', 'prompt', new AbortController().signal, {
          dreamId: 'drm-direct',
          trigger: 'manual',
          sessionIds: []
        })
      ).rejects.toThrow('model_readable_credentials')
      expect(await inner.store.listDreams('bot-a', 10)).toEqual([])
      expect(existsSync(join(root, 'agents', 'bot-a', 'memory-dreams'))).toBe(false)

      const info = vi.spyOn(inner.log, 'info')
      await inner.onDreamScheduleFire('bot-a')
      expect(info).toHaveBeenCalledWith(expect.stringContaining('model_readable_credentials'))
      expect(await inner.store.listDreams('bot-a', 10)).toEqual([])
      expect(hostFactory).not.toHaveBeenCalled()
    } finally {
      await daemon.stop()
    }
  })

  // task #36 A2 — the dream runs on a DEDICATED one-off host, torn down after.
  // Sandboxed when the AGENT runs sandboxed (best-effort isolation of the
  // attacker-controlled transcript), but supported WITH OR WITHOUT a sandbox and
  // never fail-closed on a missing mechanism (owner principle: trusted agents
  // may run unsandboxed).
  const stubDreamHost = (onStop: () => void) =>
    ({
      start: async () => {},
      hasSession: () => true,
      usesMetaSystemPrompt: () => false,
      newSession: async () => 'dream-sess',
      modelOptions: () => null,
      permissionModeOptions: () => ({ modes: ['read-only'] }),
      setSessionPermissionMode: async () => true,
      prompt: async () => ({ stopReason: 'end_turn' }),
      discardSession: () => {},
      cancel: async () => {},
      stop: async () => onStop()
    }) as any

  it('runs the dream without a sandbox mechanism, on an unsandboxed dedicated host', async () => {
    const root = scaffold()
    let stopped = 0
    const hostFactory = vi.fn(() => stubDreamHost(() => stopped++))
    const daemon = new Daemon({ root, hostFactory, dreamOperationPolicy: 'test-only' })
    await daemon.start()
    try {
      const inner = daemon as any
      inner.sandboxMechanism = undefined // no OS sandbox available on this host
      const buildSpy = vi.spyOn(inner, 'buildAcpHost')
      const res = await inner.runDreamExtraction('bot-a', 'system', 'prompt', new AbortController().signal, {
        dreamId: 'drm-nosandbox',
        trigger: 'manual',
        sessionIds: [],
        inputDir: join(root, 'in'),
        materializeInputs: async () => {}
      })
      // Never fail-closed: the dream still runs, on an unsandboxed dedicated host.
      expect(buildSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'bot-a' }),
        expect.anything(),
        expect.objectContaining({ strategy: 'host', cwd: join(root, 'in') })
      )
      expect(stopped).toBe(1)
      expect(inner.hosts.has('bot-a')).toBe(false)
      expect(res.sessionId).toBe('dream-sess')
    } finally {
      await daemon.stop()
    }
  })

  it('retires the dream staging once when an update turns dreaming off', async () => {
    const daemon = new Daemon({
      root: scaffold(),
      hostFactory: () => stubDreamHost(() => {}),
      dreamOperationPolicy: 'test-only'
    })
    await daemon.start()
    try {
      const inner = daemon as any
      const retire = vi.spyOn(inner.dreamRunner(), 'retireStaging').mockResolvedValue(undefined)
      const upsert = (memory: unknown) =>
        inner.cpConfigApply().applyAgentUpsert({ agentId: 'bot-a', spec: { name: 'bot-a', runtime: 'claude', memory } })
      await upsert({ provider: 'managed', dreaming: { enabled: true, schedule: '0 4 * * *' } })
      expect(retire).not.toHaveBeenCalled()
      await upsert({ provider: 'none' })
      await upsert({ provider: 'none' })
      expect(retire).toHaveBeenCalledTimes(1)
      expect(retire).toHaveBeenCalledWith('bot-a')
    } finally {
      await daemon.stop()
    }
  })

  it('retires the dream staging of an agent that loads with dreaming already off', async () => {
    const root = scaffold()
    const agentFile = join(root, 'agents', 'bot-a', 'agent.json')
    writeFileSync(
      agentFile,
      JSON.stringify({ ...JSON.parse(readFileSync(agentFile, 'utf8')), memory: { provider: 'none' } })
    )
    const retire = vi.spyOn(DreamRunner.prototype, 'retireStaging').mockResolvedValue(undefined)
    const daemon = new Daemon({ root, hostFactory: () => stubDreamHost(() => {}), dreamOperationPolicy: 'test-only' })
    try {
      await daemon.start()
      await vi.waitFor(() => expect(retire).toHaveBeenCalledWith('bot-a'))
    } finally {
      retire.mockRestore()
      await daemon.stop()
    }
  })

  it('never materializes the dream inputs on a runtime without a read-only mode', async () => {
    const root = scaffold()
    let stopped = 0
    const host = { ...stubDreamHost(() => stopped++), permissionModeOptions: () => ({ modes: ['default'] }) }
    const daemon = new Daemon({ root, hostFactory: vi.fn(() => host), dreamOperationPolicy: 'test-only' })
    await daemon.start()
    try {
      const materializeInputs = vi.fn(async () => {})
      await expect(
        (daemon as any).runDreamExtraction('bot-a', 'system', 'prompt', new AbortController().signal, {
          dreamId: 'drm-no-read-only',
          trigger: 'schedule',
          sessionIds: [],
          inputDir: join(root, 'in'),
          materializeInputs
        })
      ).rejects.toThrow('read-only/plan mode')
      expect(materializeInputs).not.toHaveBeenCalled()
      expect(stopped).toBe(1)
    } finally {
      await daemon.stop()
    }
  })

  it('sandboxes the dedicated dream host when the agent runs sandboxed, then tears it down', async () => {
    const root = scaffold()
    let stopped = 0
    const hostFactory = vi.fn(() => stubDreamHost(() => stopped++))
    const daemon = new Daemon({ root, hostFactory, dreamOperationPolicy: 'test-only' })
    await daemon.start()
    try {
      const inner = daemon as any
      inner.sandboxMechanism = 'bwrap'
      inner.agents.get('bot-a').execution = 'srt' // the agent opts into the sandbox
      const buildSpy = vi.spyOn(inner, 'buildAcpHost')
      const res = await inner.runDreamExtraction('bot-a', 'system', 'prompt', new AbortController().signal, {
        dreamId: 'drm-sandboxed',
        trigger: 'manual',
        sessionIds: [],
        inputDir: join(root, 'in'),
        materializeInputs: async () => {}
      })
      // Sandboxed (agent runs sandboxed + a mechanism exists) + cwd = the
      // materialized input dir — never the agent's warm host.
      expect(buildSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'bot-a' }),
        expect.anything(),
        expect.objectContaining({ strategy: 'srt', cwd: join(root, 'in') })
      )
      // One-off: stopped after the extraction, and never memoized as the warm host.
      expect(stopped).toBe(1)
      expect(inner.hosts.has('bot-a')).toBe(false)
      expect(res.sessionId).toBe('dream-sess')
    } finally {
      await daemon.stop()
    }
  })

  it('applies the agent configured model to the dream extraction session while retaining read-only mode (#2277)', async () => {
    const root = scaffold()
    let stopped = 0
    let modelSet: string | undefined
    let permModeSet: string | undefined
    const host = {
      start: async () => {},
      hasSession: () => true,
      usesMetaSystemPrompt: () => false,
      newSession: async () => 'dream-sess',
      modelOptions: () => (modelSet ? { current: modelSet } : null),
      setSessionModel: async (_sess: string, model: string) => {
        modelSet = model
      },
      permissionModeOptions: () => ({ modes: ['read-only'] }),
      setSessionPermissionMode: async (_sess: string, mode: string) => {
        permModeSet = mode
        return true
      },
      prompt: async () => ({ stopReason: 'end_turn' }),
      discardSession: () => {},
      cancel: async () => {},
      stop: async () => {
        stopped++
      }
    } as any
    const daemon = new Daemon({ root, hostFactory: vi.fn(() => host), dreamOperationPolicy: 'test-only' })
    await daemon.start()
    try {
      const inner = daemon as any
      const agent = inner.agents.get('bot-a')
      agent.runtimeOverrides = { model: 'opencode/mimo-v2.6-flash-free' }
      agent.permissionMode = 'full'
      const res = await inner.runDreamExtraction('bot-a', 'system', 'prompt', new AbortController().signal, {
        dreamId: 'drm-model-test',
        trigger: 'manual',
        sessionIds: [],
        inputDir: join(root, 'in'),
        materializeInputs: async () => {}
      })
      expect(modelSet).toBe('opencode/mimo-v2.6-flash-free')
      expect(permModeSet).toBe('read-only')
      expect(res.model).toBe('opencode/mimo-v2.6-flash-free')
      expect(stopped).toBe(1)
    } finally {
      await daemon.stop()
    }
  })
})
