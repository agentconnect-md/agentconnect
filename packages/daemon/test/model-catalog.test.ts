import { describe, it, expect } from 'vitest'
import type { RuntimeDef } from '../src/config/config-schema.js'
import type { RuntimeCatalogMetaRecord, RuntimeModelCapRecord } from '../src/store/local-store.js'
import {
  ModelCatalogService,
  catalogFingerprint,
  modelsHash,
  codexModelsFromListResult,
  opencodeModelsFromProviders,
  serveInvocationFor,
  type CatalogStorePort,
  type EnumerateFn,
  type EnumerateResult,
  type ModelCatalogDriver
} from '../src/runtimes/model-catalog.js'
import { capsFromConfigOptions } from '../src/runtimes/config-caps.js'

const rt: RuntimeDef = { command: 'fake-agent', args: ['--acp'], env: [] }

/** In-memory CatalogStorePort mirroring LocalStore's semantics: a same-fingerprint
 *  meta write preserves complete/modelsHash, a new fingerprint resets both, and
 *  markRuntimeCatalogComplete only lands on a matching fingerprint. */
class FakeCatalogStore implements CatalogStorePort {
  private metas = new Map<string, RuntimeCatalogMetaRecord>()
  private caps = new Map<string, RuntimeModelCapRecord>()

  async recordRuntimeCatalogMeta(meta: Omit<RuntimeCatalogMetaRecord, 'complete' | 'modelsHash'>): Promise<void> {
    const prev = this.metas.get(meta.runtimeId)
    const same = prev && prev.fingerprint === meta.fingerprint ? prev : undefined
    this.metas.set(meta.runtimeId, {
      ...meta,
      complete: same?.complete ?? false,
      ...(same?.modelsHash ? { modelsHash: same.modelsHash } : {})
    })
  }

  async markRuntimeCatalogComplete(
    runtimeId: string,
    fingerprint: string,
    hash: string,
    observedAt: number
  ): Promise<void> {
    const prev = this.metas.get(runtimeId)
    if (prev && prev.fingerprint === fingerprint)
      this.metas.set(runtimeId, { ...prev, complete: true, modelsHash: hash, observedAt })
  }

  async upsertRuntimeModelCap(rec: RuntimeModelCapRecord): Promise<void> {
    this.caps.set(`${rec.runtimeId}\0${rec.modelId}`, rec)
  }

  async pruneRuntimeModelCaps(runtimeId: string, keepModelIds: string[]): Promise<void> {
    for (const [key, row] of this.caps) {
      if (row.runtimeId === runtimeId && !keepModelIds.includes(row.modelId)) this.caps.delete(key)
    }
  }

  async getRuntimeCatalogMeta(runtimeId: string): Promise<RuntimeCatalogMetaRecord | undefined> {
    return this.metas.get(runtimeId)
  }

  async listRuntimeModelCaps(runtimeId?: string): Promise<RuntimeModelCapRecord[]> {
    return [...this.caps.values()].filter((r) => runtimeId === undefined || r.runtimeId === runtimeId)
  }
}

interface EnumerateCall {
  runtimeId: string
  modelIds: string[]
  budget: { perModelMs: number; totalMs: number }
  resolve: (r: EnumerateResult | undefined) => void
  reject: (err: Error) => void
}

function harness(opts: { drivers?: ModelCatalogDriver[] } = {}) {
  const store = new FakeCatalogStore()
  const updated: string[] = []
  const calls: EnumerateCall[] = []
  let nowMs = 1_000_000
  const enumerate: EnumerateFn = (runtimeId, _rt, modelIds, budget) =>
    new Promise((resolve, reject) => calls.push({ runtimeId, modelIds, budget, resolve, reject }))
  const svc = new ModelCatalogService({
    store,
    now: () => nowMs,
    drivers: opts.drivers ?? [],
    enumerate,
    driverEnv: () => ({}),
    onUpdated: async (id) => {
      updated.push(id)
    }
  })
  return {
    svc,
    store,
    updated,
    calls,
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms
    },
    probe: (models: string[], probedVersion = '1.0.0') =>
      svc.noteProbe({ runtimeId: 'fake', rt, probedVersion, models })
  }
}

/** Let a resolved discovery task run its post-await writes (one macrotask). */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('ModelCatalogService discovery gate', () => {
  it('schedules on an unseen fingerprint, closes after a complete discovery, reopens on a fingerprint change', async () => {
    const h = harness()
    await h.probe(['a', 'b'])
    expect(h.calls).toHaveLength(1)
    h.calls[0]!.resolve({
      models: [
        { id: 'a', efforts: [] },
        { id: 'b', efforts: [] }
      ]
    })
    await settle()
    await h.probe(['a', 'b'])
    expect(h.calls).toHaveLength(1) // complete + same fingerprint + same models ⇒ gate closed
    await h.probe(['a', 'b'], '2.0.0') // adapter upgrade ⇒ new fingerprint
    expect(h.calls).toHaveLength(2)
  })

  it('never schedules for an empty advertised model list', async () => {
    const h = harness()
    await h.probe([])
    expect(h.calls).toHaveLength(0)
  })

  it('a phase-1-style meta write does not satisfy the gate, and retries back off exponentially', async () => {
    const h = harness()
    const fp = catalogFingerprint('fake', '1.0.0', rt)
    // Phase 1 records the fingerprint but never sets complete.
    await h.store.recordRuntimeCatalogMeta({ runtimeId: 'fake', fingerprint: fp, source: 'acp', observedAt: h.now() })
    await h.probe(['a'])
    expect(h.calls).toHaveLength(1)
    h.calls[0]!.resolve({ models: [], aborted: 'broken enumerator' })
    await settle()
    await h.probe(['a'])
    expect(h.calls).toHaveLength(1) // first failure ⇒ 30s backoff window
    h.advance(30_000)
    await h.probe(['a'])
    expect(h.calls).toHaveLength(2)
    h.calls[1]!.resolve({ models: [], aborted: 'still broken' })
    await settle()
    h.advance(30_000)
    await h.probe(['a'])
    expect(h.calls).toHaveLength(2) // second failure doubled the window to 60s
    h.advance(30_000)
    await h.probe(['a'])
    expect(h.calls).toHaveLength(3)
  })

  it('a changed advertised model set triggers rediscovery; reordering does not', async () => {
    const h = harness()
    await h.probe(['a', 'b'])
    h.calls[0]!.resolve({
      models: [
        { id: 'a', efforts: [] },
        { id: 'b', efforts: [] }
      ]
    })
    await settle()
    await h.probe(['b', 'a'])
    expect(h.calls).toHaveLength(1) // the hash is order/duplicate-insensitive
    await h.probe(['a', 'c']) // server-side catalog update, same fingerprint
    expect(h.calls).toHaveLength(2)
  })

  it('a native catalog refreshes after the 24h TTL', async () => {
    const driver: ModelCatalogDriver = {
      supports: () => true,
      discover: async () => ({
        models: [
          { id: 'a', efforts: [] },
          { id: 'b', efforts: [] }
        ]
      })
    }
    const h = harness({ drivers: [driver] })
    await h.probe(['a', 'b'])
    await settle()
    expect((await h.store.getRuntimeCatalogMeta('fake'))?.source).toBe('native')
    expect(h.updated).toHaveLength(1)
    h.advance(3_600_000)
    await h.probe(['a', 'b'])
    await settle()
    expect(h.updated).toHaveLength(1) // 1h old — still fresh
    h.advance(24 * 3_600_000)
    await h.probe(['a', 'b'])
    await settle()
    expect(h.updated).toHaveLength(2) // past the TTL — rediscovered
  })
})

describe('ModelCatalogService single-flight and generation fencing', () => {
  it('a same-fingerprint evaluation while a task is in flight is a no-op', async () => {
    const h = harness()
    await h.probe(['a'])
    await h.probe(['a'])
    expect(h.calls).toHaveLength(1)
  })

  it('a fingerprint change cancels the in-flight task and drops its late writes', async () => {
    const h = harness()
    await h.probe(['a'], '1.0.0')
    await h.probe(['a'], '2.0.0')
    expect(h.calls).toHaveLength(2)
    // The superseded v1 task resolves late — every one of its writes is stale.
    h.calls[0]!.resolve({ models: [{ id: 'a', efforts: [{ value: 'stale' }] }] })
    await settle()
    expect(await h.store.listRuntimeModelCaps('fake')).toHaveLength(0)
    expect(h.updated).toHaveLength(0)
    // The v2 task is still current and commits under the new fingerprint.
    h.calls[1]!.resolve({ models: [{ id: 'a', efforts: [{ value: 'high' }] }] })
    await settle()
    const rows = await h.store.listRuntimeModelCaps('fake')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.fingerprint).toBe(catalogFingerprint('fake', '2.0.0', rt))
    expect(rows[0]!.caps.efforts).toEqual([{ value: 'high' }])
    expect((await h.store.getRuntimeCatalogMeta('fake'))?.complete).toBe(true)
    expect(h.updated).toEqual(['fake'])
  })

  it('stop() cancels in-flight discoveries and blocks new ones', async () => {
    const h = harness()
    await h.probe(['a'])
    await h.svc.stop()
    h.calls[0]!.resolve({ models: [{ id: 'a', efforts: [] }] })
    await settle()
    expect(await h.store.listRuntimeModelCaps('fake')).toHaveLength(0)
    await h.probe(['a'])
    expect(h.calls).toHaveLength(1)
  })
})

describe('ModelCatalogService driver path', () => {
  it('driver success writes a native catalog: rows, preserved phase-1 meta, complete, prune', async () => {
    const fp = catalogFingerprint('fake', '1.0.0', rt)
    const driver: ModelCatalogDriver = {
      supports: (id) => id === 'fake',
      discover: async () => ({
        models: [
          {
            id: 'a',
            name: 'Model A',
            efforts: [{ value: 'low' }, { value: 'high' }],
            defaultEffort: 'high',
            fastMode: true
          },
          { id: 'b', efforts: [] },
          // A driver may know models the probe selector did not advertise.
          { id: 'x', efforts: [] }
        ],
        defaultModel: 'a'
      })
    }
    const h = harness({ drivers: [driver] })
    await h.store.recordRuntimeCatalogMeta({
      runtimeId: 'fake',
      fingerprint: fp,
      source: 'acp',
      permissionModes: [{ value: 'safe' }],
      observedAt: h.now()
    })
    await h.store.upsertRuntimeModelCap({
      runtimeId: 'fake',
      modelId: 'gone',
      fingerprint: 'old',
      caps: {},
      observedAt: 1
    })
    await h.probe(['a', 'b'])
    await settle()
    expect(h.calls).toHaveLength(0) // no enumeration fallback
    const meta = (await h.store.getRuntimeCatalogMeta('fake'))!
    expect(meta.source).toBe('native')
    expect(meta.complete).toBe(true)
    expect(meta.defaultModel).toBe('a')
    expect(meta.permissionModes).toEqual([{ value: 'safe' }]) // phase-1 data preserved
    expect(meta.modelsHash).toBe(modelsHash(['a', 'b'])) // the PROBED set, so gate rule 3 stays closed
    expect((await h.store.listRuntimeModelCaps('fake')).map((r) => r.modelId).sort()).toEqual(['a', 'b', 'x'])
    expect((await h.store.listRuntimeModelCaps('fake')).find((r) => r.modelId === 'a')?.caps).toEqual({
      name: 'Model A',
      efforts: [{ value: 'low' }, { value: 'high' }],
      defaultEffort: 'high',
      fastMode: true
    })
    expect(h.updated).toEqual(['fake'])
  })

  it('a driver result matching fewer than half the advertised ids is discarded for enumeration', async () => {
    const driver: ModelCatalogDriver = {
      supports: (id) => id === 'fake',
      discover: async () => ({ models: [{ id: 'prov/a' }, { id: 'prov/b' }, { id: 'prov/c' }, { id: 'prov/d' }] })
    }
    const h = harness({ drivers: [driver] })
    await h.probe(['a', 'b', 'c', 'd'])
    await settle()
    expect(await h.store.listRuntimeModelCaps('fake')).toHaveLength(0) // alien-id rows never written
    expect(h.calls).toHaveLength(1) // fell back to the generic enumerator
    expect(h.calls[0]!.modelIds).toEqual(['a', 'b', 'c', 'd'])
  })

  it('a failing driver falls back to enumeration', async () => {
    const driver: ModelCatalogDriver = {
      supports: (id) => id === 'fake',
      discover: async () => {
        throw new Error('spawn failed')
      }
    }
    const h = harness({ drivers: [driver] })
    await h.probe(['a'])
    await settle()
    expect(h.calls).toHaveLength(1)
  })
})

describe('ModelCatalogService enumeration fallback', () => {
  it('a complete enumeration marks the catalog complete and prunes vanished models', async () => {
    const h = harness()
    await h.store.upsertRuntimeModelCap({
      runtimeId: 'fake',
      modelId: 'gone',
      fingerprint: 'old',
      caps: {},
      observedAt: 1
    })
    await h.probe(['a', 'b'])
    expect(h.calls[0]!.budget).toEqual({ perModelMs: 10_000, totalMs: 120_000 })
    h.calls[0]!.resolve({
      models: [
        { id: 'a', efforts: [{ value: 'high' }], fastMode: true },
        { id: 'b', efforts: [] }
      ]
    })
    await settle()
    const meta = (await h.store.getRuntimeCatalogMeta('fake'))!
    expect(meta.source).toBe('acp')
    expect(meta.complete).toBe(true)
    expect(meta.modelsHash).toBe(modelsHash(['a', 'b']))
    expect((await h.store.listRuntimeModelCaps('fake')).map((r) => r.modelId).sort()).toEqual(['a', 'b'])
    expect(h.updated).toEqual(['fake'])
    // An acp-sourced catalog has no TTL — only fingerprint/model-set changes reopen it.
    h.advance(25 * 3_600_000)
    await h.probe(['a', 'b'])
    expect(h.calls).toHaveLength(1)
  })

  it('an aborted enumeration keeps partial rows, stays incomplete, and still reports', async () => {
    const h = harness()
    const fp = catalogFingerprint('fake', '1.0.0', rt)
    await h.store.recordRuntimeCatalogMeta({ runtimeId: 'fake', fingerprint: fp, source: 'acp', observedAt: h.now() })
    await h.store.upsertRuntimeModelCap({
      runtimeId: 'fake',
      modelId: 'b',
      fingerprint: fp,
      caps: { efforts: [{ value: 'old' }] },
      observedAt: 1
    })
    await h.probe(['a', 'b'])
    h.calls[0]!.resolve({ models: [{ id: 'a', efforts: [] }], aborted: 'total budget exhausted' })
    await settle()
    expect((await h.store.getRuntimeCatalogMeta('fake'))?.complete).toBe(false)
    // 'a' was learned this round; 'b' keeps its last-good row (no prune on failure).
    expect((await h.store.listRuntimeModelCaps('fake')).map((r) => r.modelId).sort()).toEqual(['a', 'b'])
    expect(h.updated).toEqual(['fake'])
  })

  it('an unavailable enumerator (undefined) records nothing and retries on backoff', async () => {
    const h = harness()
    await h.probe(['a'])
    h.calls[0]!.resolve(undefined)
    await settle()
    expect(await h.store.listRuntimeModelCaps('fake')).toHaveLength(0)
    expect(await h.store.getRuntimeCatalogMeta('fake')).toBeUndefined()
    expect(h.updated).toHaveLength(0)
    await h.probe(['a'])
    expect(h.calls).toHaveLength(1) // inside the backoff window
    h.advance(30_000)
    await h.probe(['a'])
    expect(h.calls).toHaveLength(2)
  })

  it('drops the literal "default" id and caps the requested ids at 64', async () => {
    const h = harness()
    const many = ['default', ...Array.from({ length: 80 }, (_, i) => `m${i}`)]
    await h.probe(many)
    expect(h.calls[0]!.modelIds).toHaveLength(64)
    expect(h.calls[0]!.modelIds).toEqual(many.slice(1, 65))
  })
})

describe('capsFromConfigOptions', () => {
  const select = (options: unknown[]) =>
    [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'a', options }] as never

  it('carries every model option\u2019s display metadata, not just the current one', () => {
    const caps = capsFromConfigOptions(
      select([
        { value: 'a', name: 'Model A', description: 'The everyday one' },
        { group: 'More', options: [{ value: 'b', name: 'Model B' }, { value: 'c' }] }
      ])
    )
    expect(caps.currentModel).toBe('a')
    expect(caps.modelName).toBe('Model A')
    expect(caps.modelChoices).toEqual([
      { value: 'a', name: 'Model A', description: 'The everyday one' },
      { value: 'b', name: 'Model B' },
      { value: 'c' }
    ])
  })

  it('drops a display name that only repeats the value, and reports no choices without a model select', () => {
    expect(capsFromConfigOptions(select([{ value: 'a', name: 'a' }])).modelChoices).toEqual([{ value: 'a' }])
    expect(capsFromConfigOptions([]).modelChoices).toBeUndefined()
  })
})

describe('codexModelsFromListResult', () => {
  it('maps camelCase RPC entries and skips the literal "default"', () => {
    const catalog = codexModelsFromListResult({
      data: [
        {
          id: 'gpt-5.2-codex',
          displayName: 'GPT-5.2 Codex',
          description: 'Reliable agentic workhorse for everyday tasks.',
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'Fastest' },
            { reasoningEffort: 'high', description: 'Deepest' }
          ],
          defaultReasoningEffort: 'high',
          additionalSpeedTiers: ['fast']
        },
        { id: 'default' }, // "no explicit model" — not a catalog entry
        'garbage'
      ]
    })
    expect(catalog).toEqual({
      models: [
        {
          id: 'gpt-5.2-codex',
          name: 'GPT-5.2 Codex',
          description: 'Reliable agentic workhorse for everyday tasks.',
          efforts: [
            { value: 'low', description: 'Fastest' },
            { value: 'high', description: 'Deepest' }
          ],
          defaultEffort: 'high',
          fastMode: true
        }
      ]
    })
  })

  it('maps snake_case on-disk-cache entries; a non-fast speed tier is not fastMode', () => {
    const catalog = codexModelsFromListResult({
      data: [
        {
          id: 'gpt-5.1',
          display_name: 'GPT-5.1',
          supported_reasoning_efforts: [{ reasoning_effort: 'medium' }],
          default_reasoning_effort: 'medium',
          additional_speed_tiers: [{ speed_tier: 'turbo' }]
        }
      ]
    })
    expect(catalog.models).toEqual([
      { id: 'gpt-5.1', name: 'GPT-5.1', efforts: [{ value: 'medium' }], defaultEffort: 'medium', fastMode: false }
    ])
  })

  it('returns an empty catalog for a shapeless result', () => {
    expect(codexModelsFromListResult(undefined)).toEqual({ models: [] })
    expect(codexModelsFromListResult({ data: 'nope' })).toEqual({ models: [] })
  })

  it('maps the wire isDefault marker to the catalog defaultModel (camel + snake)', () => {
    const camel = codexModelsFromListResult({
      data: [
        { id: 'gpt-5.6-sol', isDefault: true },
        { id: 'gpt-5.5', isDefault: false }
      ]
    })
    expect(camel.defaultModel).toBe('gpt-5.6-sol')
    const snake = codexModelsFromListResult({ data: [{ id: 'gpt-5.5' }, { id: 'gpt-5.4', is_default: true }] })
    expect(snake.defaultModel).toBe('gpt-5.4')
    expect(codexModelsFromListResult({ data: [{ id: 'gpt-5.5' }] }).defaultModel).toBeUndefined()
  })
})

describe('opencodeModelsFromProviders', () => {
  it('maps object-keyed provider models, variants become effort tiers', () => {
    const catalog = opencodeModelsFromProviders({
      providers: [
        {
          id: 'anthropic',
          models: {
            'claude-sonnet-4-5': { name: 'Claude Sonnet 4.5', variants: { high: {}, max: {} } },
            'claude-haiku-4-5': { name: 'Claude Haiku 4.5' }
          }
        }
      ]
    })
    expect(catalog.models).toEqual([
      { id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5', efforts: [{ value: 'high' }, { value: 'max' }] },
      { id: 'anthropic/claude-haiku-4-5', name: 'Claude Haiku 4.5', efforts: [] }
    ])
  })

  it('maps array-form provider models and skips malformed entries', () => {
    const catalog = opencodeModelsFromProviders({
      providers: [
        { id: 'openai', models: [{ id: 'gpt-5.2', name: 'GPT-5.2' }, { name: 'no id' }] },
        { models: { orphan: {} } } // provider without an id
      ]
    })
    expect(catalog.models).toEqual([{ id: 'openai/gpt-5.2', name: 'GPT-5.2', efforts: [] }])
  })

  it('returns an empty catalog for a shapeless payload', () => {
    expect(opencodeModelsFromProviders(null)).toEqual({ models: [] })
    expect(opencodeModelsFromProviders({ providers: 'x' })).toEqual({ models: [] })
  })
})

describe('serveInvocationFor', () => {
  const serveArgs = ['serve', '--port', '4097', '--hostname', '127.0.0.1']

  it('rewrites an npx-distributed runtime by replacing the trailing acp arg', () => {
    const rt: RuntimeDef = { command: 'npx', args: ['-y', '@kilocode/cli@7.4.9', 'acp'], env: [] }
    const out = serveInvocationFor('kilo', rt, serveArgs)
    // command resolves to an absolute path via PATH lookup — a `.CMD` launcher on Windows
    expect(out.command).toMatch(/npx(\.cmd|\.exe)?$/i)
    expect(out.args).toEqual(['-y', '@kilocode/cli@7.4.9', ...serveArgs])
  })

  it('rewrites a binary runtime def, replacing acp and anything after it', () => {
    const rt: RuntimeDef = { command: 'opencode', args: ['acp', '--verbose'], env: [] }
    // command resolves via PATH lookup; when unresolvable it falls through as-is
    const out = serveInvocationFor('opencode', rt, serveArgs)
    expect(out.args).toEqual(serveArgs)
    expect(out.command.endsWith('opencode')).toBe(true)
  })

  it('falls back to the bare bin when the runtime def has no acp arg (or no def)', () => {
    const rt: RuntimeDef = { command: 'weird', args: ['--serve-acp'], env: [] }
    expect(serveInvocationFor('opencode', rt, serveArgs)).toEqual({ command: 'opencode', args: serveArgs })
    expect(serveInvocationFor('kilo', undefined, serveArgs)).toEqual({ command: 'kilo', args: serveArgs })
  })
})
