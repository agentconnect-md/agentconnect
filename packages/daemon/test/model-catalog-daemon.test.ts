import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import type { FactsRuntimeProfile } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { statePath } from '../src/paths.js'
import { LocalStore } from '../src/store/local-store.js'
import { catalogFingerprint } from '../src/runtimes/model-catalog.js'
import type { ResolvedRuntimeCatalog } from '../src/runtimes/registry.js'
import type { RuntimeDef } from '../src/config/config-schema.js'
import type { RuntimeProbeResult } from '../src/runtimes/runtime-prober.js'
import { FakeClock } from './cp/fake-clock.js'

/** Daemon-level integration tests for the runtime-model-catalog wiring
 *  (design runtime-model-catalog.md §4/§6/§9): startup hydrate, the sweep
 *  fold's phase-1 seeding + provenance flip, last-good advertisement fallback,
 *  and the cached-provenance activation gate. */

const FAKE_RT: RuntimeDef = { command: 'fake-agent', args: ['--acp'], env: [] }

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'ac-model-catalog-daemon-'))
  writeFileSync(join(path, 'config.json'), JSON.stringify({ version: 1, controlPlane: { enabled: false } }))
  return path
}

/** Installed catalog of non-curated (user-source) runtimes — always admitted,
 *  so hydrate + the ordinary sweep cover them without ACP admission. */
function catalogOf(runtimes: Record<string, RuntimeDef>): ResolvedRuntimeCatalog {
  return {
    entries: Object.fromEntries(
      Object.entries(runtimes).map(([id, rt]) => [
        id,
        { runtime: rt, source: 'user' as const, name: id, version: '', skillsAgentId: null }
      ])
    ),
    runtimes
  }
}

/** Pre-write last-good cache rows into the LocalStore the daemon will open. */
async function seedCache(
  rootDir: string,
  rows: Array<{
    runtimeId: string
    models: Array<{
      id: string
      caps: { efforts?: Array<{ value: string; name?: string }>; defaultEffort?: string; fastMode?: boolean }
    }>
    defaultModel?: string
  }>
): Promise<void> {
  const store = await LocalStore.open(statePath(rootDir))
  for (const row of rows) {
    await store.recordRuntimeCatalogMeta({
      runtimeId: row.runtimeId,
      fingerprint: 'fp-cache',
      source: 'acp',
      ...(row.defaultModel ? { defaultModel: row.defaultModel } : {}),
      permissionModes: [{ value: 'safe', name: 'Safe' }],
      observedAt: 1_000
    })
    for (const m of row.models)
      await store.upsertRuntimeModelCap({
        runtimeId: row.runtimeId,
        modelId: m.id,
        fingerprint: 'fp-cache',
        caps: m.caps,
        observedAt: 1_000
      })
  }
  await store.close()
}

/** Exactly the payload the CP client's `runtimeProfiles()` dep produces for the
 *  register-time `facts/daemon-runtimes` snapshot (cp/client.ts sends it at READY). */
function firstSnapshot(daemon: Daemon): FactsRuntimeProfile[] {
  const d = daemon as any
  return d.admittedRuntimeIds().map((id: string) => d.runtimeFacts.profileFor(id))
}

/** Capture post-sweep `facts/daemon-runtimes` emissions via the injected-cpClient
 *  idiom (daemon-hook.test.ts) — CP is disabled, so no real client exists. */
function captureEmits(daemon: Daemon): FactsRuntimeProfile[][] {
  const emitted: FactsRuntimeProfile[][] = []
  ;(daemon as any).cpClient = {
    emitDaemonRuntimes: (profiles: FactsRuntimeProfile[]) => {
      emitted.push(profiles)
    },
    stop: vi.fn(async () => {})
  }
  return emitted
}

/** Replace the real ModelCatalogService with a recording stub: these tests cover
 *  the daemon.ts wiring (hydrate / phase-1 fold / report path); the phase-2 gate
 *  and enumerator are unit-tested in model-catalog.test.ts. The stub also proves
 *  no phase-2 discovery is needed for the behaviors asserted here. */
function stubCatalogSvc(daemon: Daemon): ReturnType<typeof vi.fn> {
  const noteProbe = vi.fn()
  ;(daemon as any).modelCatalogSvc = { noteProbe, stop: vi.fn(async () => {}) }
  return noteProbe
}

function daemonWith(opts: {
  root: string
  catalog: ResolvedRuntimeCatalog
  clock: FakeClock
  probe: (runtimes: Record<string, RuntimeDef>) => Promise<RuntimeProbeResult[]>
}): Daemon {
  return new Daemon({
    root: opts.root,
    clock: opts.clock,
    resolveCatalog: async () => opts.catalog,
    installed: (runtimes) => runtimes,
    probeRuntimes: opts.probe as never,
    hostFactory: () => ({}) as never,
    sandboxMechanism: null
  })
}

const neverProbe = async (): Promise<RuntimeProbeResult[]> => []

describe('daemon model-catalog cache hydrate', () => {
  it('serves last-good models + matrix in the first facts snapshot, ignoring uninstalled runtimes', async () => {
    const dir = root()
    await seedCache(dir, [
      {
        runtimeId: 'fake',
        defaultModel: 'm-a',
        models: [
          { id: 'm-a', caps: { efforts: [{ value: 'low' }], defaultEffort: 'low', fastMode: false } },
          { id: 'm-b', caps: { efforts: [] } }
        ]
      },
      // Cache rows for a runtime that is NOT in the installed catalog: hydrate
      // must skip them (no advertise, no report) while keeping the rows on disk.
      { runtimeId: 'ghost', models: [{ id: 'm-ghost', caps: {} }] }
    ])
    const clock = new FakeClock()
    clock.advance(10_000)
    const daemon = daemonWith({ root: dir, catalog: catalogOf({ fake: FAKE_RT }), clock, probe: neverProbe })

    try {
      await daemon.start()
      const profiles = firstSnapshot(daemon)
      expect(profiles.map((p) => p.runtime)).toEqual(['fake'])
      const fake = profiles[0]!
      // Advertisement comes back from the cache, marked with its provenance.
      expect(fake.models).toEqual(['m-a', 'm-b'])
      expect(fake.modelsSource).toBe('cached')
      // The capability matrix rides the same first frame (raw efforts — non-claude
      // runtimes get no synthetic tiers).
      expect(fake.modelCatalog).toEqual({
        models: [
          { id: 'm-a', efforts: [{ value: 'low' }], defaultEffort: 'low', fastMode: false },
          { id: 'm-b', efforts: [] }
        ],
        defaultModel: 'm-a',
        permissionModes: [{ value: 'safe', name: 'Safe' }],
        source: 'acp',
        observedAt: new Date(1_000).toISOString()
      })
      // The uninstalled runtime is absent from memory but retained on disk
      // (it may only be temporarily unresolved).
      expect((daemon as any).runtimeFacts.models.has('ghost')).toBe(false)
      expect((daemon as any).runtimeFacts.catalogs.has('ghost')).toBe(false)
      expect(await ((daemon as any).store as LocalStore).getRuntimeCatalogMeta('ghost')).toBeDefined()
    } finally {
      await daemon.stop()
    }
  })

  it('never hydrates or advertises a catalog past its retention window', async () => {
    // Retention runs BEFORE the hydrate, synchronously — the ordering the removed
    // gcRuntimeCatalog used to provide. Without it this member boots advertising models it
    // has not seen in over a month, and the cached provenance keeps the activation gate
    // permissive over them.
    const dir = root()
    await seedCache(dir, [
      { runtimeId: 'fake', defaultModel: 'm-stale', models: [{ id: 'm-stale', caps: { efforts: [] } }] }
    ])
    const clock = new FakeClock()
    clock.advance(1_000 + 31 * 24 * 3_600_000)
    const daemon = daemonWith({ root: dir, catalog: catalogOf({ fake: FAKE_RT }), clock, probe: neverProbe })

    try {
      await daemon.start()
      const fake = firstSnapshot(daemon)[0]!
      expect(fake.models).toEqual([])
      expect(fake.modelsSource).toBeUndefined()
      expect(fake.modelCatalog).toBeUndefined()
      // Collected, not merely ignored: both catalog tables are empty afterwards.
      const store = (daemon as any).store as LocalStore
      expect(await store.listRuntimeCatalogMetas()).toEqual([])
      expect(await store.listRuntimeModelCaps()).toEqual([])
    } finally {
      await daemon.stop()
    }
  })
})

describe('daemon activation gate provenance rule', () => {
  it('is permissive for a cache-hydrated model list and turns strict after the first live probe', async () => {
    const dir = root()
    await seedCache(dir, [{ runtimeId: 'fake', models: [{ id: 'm-old', caps: {} }] }])
    const clock = new FakeClock()
    clock.advance(10_000)
    const probe = vi.fn(async (): Promise<RuntimeProbeResult[]> => [{ runtime: 'fake', ok: true, models: ['m-old'] }])
    const daemon = daemonWith({ root: dir, catalog: catalogOf({ fake: FAKE_RT }), clock, probe })
    const agent = { runtime: 'fake', runtimeOverrides: { model: 'm-new' }, mcpServers: [] } as never

    try {
      await daemon.start()
      // Hydrated advertisement is non-empty but cached ⇒ NOT live knowledge: a
      // model added while the daemon was down must not be rejected at startup.
      expect((daemon as any).runtimeFacts.models.get('fake')).toEqual(['m-old'])
      expect((daemon as any).activationCapabilityError(agent)).toBeUndefined()

      stubCatalogSvc(daemon)
      const emitted = captureEmits(daemon)
      await (daemon as any).runtimeFacts.probeAndEmit(true)

      // The sweep flips provenance cached→probed in the emitted snapshot...
      expect(emitted).toHaveLength(1)
      expect(emitted[0]![0]).toMatchObject({ runtime: 'fake', models: ['m-old'], modelsSource: 'probed' })
      // ...and the gate now enforces the live list.
      expect((daemon as any).activationCapabilityError(agent)).toBe('model "m-new" is not offered by runtime "fake"')
    } finally {
      await daemon.stop()
    }
  })
})

describe('daemon last-good advertisement fallback', () => {
  it('a transient first probe failure keeps cached models + catalog; a later success replaces them without phase 2', async () => {
    const dir = root()
    await seedCache(dir, [
      { runtimeId: 'fake', defaultModel: 'm-a', models: [{ id: 'm-a', caps: { efforts: [{ value: 'low' }] } }] }
    ])
    const clock = new FakeClock()
    clock.advance(10_000)
    let results: RuntimeProbeResult[] = [{ runtime: 'fake', ok: false, models: [], error: 'spawn failed' }]
    const probe = vi.fn(async () => results)
    const daemon = daemonWith({ root: dir, catalog: catalogOf({ fake: FAKE_RT }), clock, probe })

    try {
      await daemon.start()
      const cachedCatalog = firstSnapshot(daemon)[0]!.modelCatalog
      expect(cachedCatalog).toBeDefined()
      const noteProbe = stubCatalogSvc(daemon)
      const emitted = captureEmits(daemon)

      await (daemon as any).runtimeFacts.probeAndEmit(true)
      expect(probe).toHaveBeenCalledTimes(1)
      const failed = emitted[0]![0]!
      // A disposable refresh can fail while established runtime homes remain
      // usable. Keep the last-good advertisement permissive until live evidence
      // replaces it, instead of making the picker disappear after restart.
      expect(failed.models).toEqual(['m-a'])
      expect(failed.modelsSource).toBe('cached')
      // Capability knowledge also survives the failure, on the wire and on disk.
      expect(failed.modelCatalog).toEqual(cachedCatalog)
      expect((await ((daemon as any).store as LocalStore).listRuntimeModelCaps('fake')).map((r) => r.modelId)).toEqual([
        'm-a'
      ])
      expect(noteProbe).not.toHaveBeenCalled() // failures never reach phase 2

      // Runtime comes back: the next sweep restores the advertisement directly —
      // no phase-2 rediscovery involved (the catalog service stub can't run one).
      clock.advance(6 * 60_000) // past the 5-minute probe TTL
      results = [{ runtime: 'fake', ok: true, models: ['m-a', 'm-b'] }]
      await (daemon as any).runtimeFacts.probeAndEmit(true)
      expect(probe).toHaveBeenCalledTimes(2)
      const restored = emitted[1]![0]!
      expect(restored.models).toEqual(['m-a', 'm-b'])
      expect(restored.modelsSource).toBe('probed')
      expect(restored.modelCatalog).toEqual(cachedCatalog)
    } finally {
      await daemon.stop()
    }
  })
})

describe('daemon auth-required probe fold', () => {
  it('flags authRequired in the snapshot on an auth-rejected probe and clears it once a probe succeeds', async () => {
    const dir = root()
    await seedCache(dir, [{ runtimeId: 'fake', models: [{ id: 'm-cached', caps: {} }] }])
    const clock = new FakeClock()
    clock.advance(10_000)
    let results: RuntimeProbeResult[] = [
      { runtime: 'fake', ok: false, models: [], error: 'Authentication required', authRequired: true }
    ]
    const probe = vi.fn(async () => results)
    const daemon = daemonWith({ root: dir, catalog: catalogOf({ fake: FAKE_RT }), clock, probe })

    try {
      await daemon.start()
      stubCatalogSvc(daemon)
      const emitted = captureEmits(daemon)

      await (daemon as any).runtimeFacts.probeAndEmit(true)
      // Authentication rejection is authoritative and clears even a warm cache.
      expect(emitted[0]![0]).toMatchObject({
        runtime: 'fake',
        models: [],
        modelsSource: 'probed',
        authRequired: true
      })

      // Logged in meanwhile: the next sweep drops the flag off the frame
      // entirely (absent ⇒ ok, matching older-daemon semantics).
      clock.advance(6 * 60_000) // past the 5-minute probe TTL
      results = [{ runtime: 'fake', ok: true, models: ['m-a'] }]
      await (daemon as any).runtimeFacts.probeAndEmit(true)
      expect(emitted[1]![0]!.runtime).toBe('fake')
      expect(emitted[1]![0]!.authRequired).toBeUndefined()
    } finally {
      await daemon.stop()
    }
  })

  it('does not flag authRequired for non-auth probe failures', async () => {
    const clock = new FakeClock()
    clock.advance(10_000)
    const probe = vi.fn(async (): Promise<RuntimeProbeResult[]> => [
      { runtime: 'fake', ok: false, models: [], error: 'probe timed out after 30000ms' }
    ])
    const daemon = daemonWith({ root: root(), catalog: catalogOf({ fake: FAKE_RT }), clock, probe })

    try {
      await daemon.start()
      stubCatalogSvc(daemon)
      const emitted = captureEmits(daemon)
      await (daemon as any).runtimeFacts.probeAndEmit(true)
      expect(emitted[0]![0]!.authRequired).toBeUndefined()
      // With no last-good cache, there is nothing to preserve.
      expect(emitted[0]![0]).toMatchObject({ models: [], modelsSource: 'probed' })
    } finally {
      await daemon.stop()
    }
  })
})

describe('daemon sweep phase-1 catalog seeding', () => {
  const configOptions = [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'a',
      options: [
        { value: 'a', name: 'Model A' },
        { value: 'b', name: 'Model B' }
      ]
    },
    {
      id: 'thought-level',
      name: 'Thinking',
      category: 'thought_level',
      type: 'select',
      currentValue: 'high',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' }
      ]
    },
    {
      id: 'permission-mode',
      name: 'Permissions',
      category: 'mode',
      type: 'select',
      currentValue: 'safe',
      options: [
        { value: 'safe', name: 'Safe', description: 'Ask before editing files or running commands.' },
        { value: 'yolo', name: 'YOLO', description: 'Run without approval prompts.' }
      ]
    },
    {
      id: 'fast-mode',
      name: 'Fast',
      category: 'model_config',
      type: 'select',
      currentValue: 'off',
      options: [
        { value: 'on', name: 'On' },
        { value: 'off', name: 'Off' }
      ]
    }
  ] as unknown as SessionConfigOption[]

  const rawEfforts = [
    { value: 'low', name: 'Low' },
    { value: 'high', name: 'High' }
  ]

  it.each([
    ['fake-agent', false],
    ['claude-code-acp', true]
  ])(
    'seeds the default model raw in the cache and reports augmented efforts iff the command is claude (%s)',
    async (command, claude) => {
      const rt: RuntimeDef = { command, args: ['--acp'], env: [] }
      const clock = new FakeClock()
      clock.advance(10_000)
      const probe = vi.fn(async (): Promise<RuntimeProbeResult[]> => [
        { runtime: 'probed', ok: true, models: ['a', 'b'], currentModel: 'a', probedVersion: '1.0', configOptions }
      ])
      const daemon = daemonWith({ root: root(), catalog: catalogOf({ probed: rt }), clock, probe })

      try {
        await daemon.start()
        const noteProbe = stubCatalogSvc(daemon)
        const emitted = captureEmits(daemon)
        await (daemon as any).runtimeFacts.probeAndEmit(true)

        // Store: phase-1 meta (fingerprint, resolved default model, permission
        // modes) with the discovery gate left OPEN (complete=false)...
        const store = (daemon as any).store as LocalStore
        expect(await store.getRuntimeCatalogMeta('probed')).toEqual({
          runtimeId: 'probed',
          fingerprint: catalogFingerprint('probed', '1.0', rt),
          source: 'acp',
          defaultModel: 'a',
          permissionModes: [
            { value: 'safe', name: 'Safe', description: 'Ask before editing files or running commands.' },
            { value: 'yolo', name: 'YOLO', description: 'Run without approval prompts.' }
          ],
          // The mode select's currentValue — the runtime's own default mode.
          defaultPermissionMode: 'safe',
          complete: false,
          observedAt: 10_000
        })
        // ...and ONE model row for the default model, storing RAW advertised
        // efforts — augmentation is report-time only, never persisted.
        const caps = await store.listRuntimeModelCaps('probed')
        expect(caps.map((r) => r.modelId)).toEqual(['a'])
        expect(caps[0]!.caps).toEqual({ efforts: rawEfforts, defaultEffort: 'high', fastMode: true })

        // Wire: the emitted catalog entry augments claude runtimes with the
        // synthetic tiers; non-claude runtimes report the raw levels as-is.
        expect(emitted).toHaveLength(1)
        const profile = emitted[0]![0]!
        expect(profile).toMatchObject({ runtime: 'probed', models: ['a', 'b'], modelsSource: 'probed' })
        expect(profile.modelCatalog).toEqual({
          models: [
            {
              id: 'a',
              efforts: claude ? [...rawEfforts, { value: 'max' }, { value: 'ultracode' }] : rawEfforts,
              defaultEffort: 'high',
              fastMode: true
            }
          ],
          defaultModel: 'a',
          permissionModes: [
            { value: 'safe', name: 'Safe', description: 'Ask before editing files or running commands.' },
            { value: 'yolo', name: 'YOLO', description: 'Run without approval prompts.' }
          ],
          defaultPermissionMode: 'safe',
          source: 'acp',
          observedAt: new Date(10_000).toISOString()
        })

        // The fold hands the probe outcome to the phase-2 discovery gate.
        expect(noteProbe).toHaveBeenCalledWith({ runtimeId: 'probed', rt, probedVersion: '1.0', models: ['a', 'b'] })
      } finally {
        await daemon.stop()
      }
    }
  )

  it('seeds caps under a runtime-advertised literal "default" model; meta.defaultModel stays unset', async () => {
    const rt: RuntimeDef = { command: 'fake-agent', args: ['--acp'], env: [] }
    const clock = new FakeClock()
    clock.advance(10_000)
    // Probe session sits on the literal "default" the runtime advertises.
    const defaultOpts = configOptions.map((o) =>
      (o as { id?: string }).id === 'model' ? { ...o, currentValue: 'default' } : o
    ) as unknown as SessionConfigOption[]
    const probe = vi.fn(async (): Promise<RuntimeProbeResult[]> => [
      {
        runtime: 'probed',
        ok: true,
        models: ['default', 'a', 'b'],
        currentModel: 'default',
        probedVersion: '1.0',
        configOptions: defaultOpts
      }
    ])
    const daemon = daemonWith({ root: root(), catalog: catalogOf({ probed: rt }), clock, probe })
    try {
      await daemon.start()
      stubCatalogSvc(daemon)
      await (daemon as any).runtimeFacts.probeAndEmit(true)
      const store = (daemon as any).store as LocalStore
      // meta.defaultModel is never the literal "default" (feeds the concrete
      // preselection/hint) — but the caps row IS seeded under "default" so
      // selecting it surfaces the runtime's own effort/fast.
      expect(await store.getRuntimeCatalogMeta('probed')).not.toHaveProperty('defaultModel')
      expect((await store.listRuntimeModelCaps('probed')).map((r) => r.modelId)).toEqual(['default'])
    } finally {
      await daemon.stop()
    }
  })
})
