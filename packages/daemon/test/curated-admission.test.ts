import { describe, expect, it } from 'vitest'
import { CuratedRuntimeAdmission, CuratedRuntimeAdmissionError } from '../src/runtimes/curated-admission.js'
import type { ResolvedRuntimeCatalog } from '../src/runtimes/registry.js'
import type { RuntimeProbeResult } from '../src/runtimes/runtime-prober.js'

const runtime = { command: 'hermes', args: ['acp'], env: [] }
const catalog: ResolvedRuntimeCatalog = {
  entries: {
    'hermes-agent': { runtime, source: 'curated', name: 'Hermes Agent', version: '', skillsAgentId: null },
    explicit: {
      runtime: { ...runtime, command: 'custom' },
      source: 'user',
      name: 'explicit',
      version: '',
      skillsAgentId: null
    },
    registered: {
      runtime: { ...runtime, command: 'registry' },
      source: 'registry',
      name: 'Registered',
      version: '1',
      skillsAgentId: null
    }
  },
  runtimes: {
    'hermes-agent': runtime,
    explicit: { ...runtime, command: 'custom' },
    registered: { ...runtime, command: 'registry' }
  }
}

const result = (ok: boolean, error?: string): RuntimeProbeResult => ({
  runtime: 'hermes-agent',
  ok,
  models: ok ? ['model-a'] : [],
  ...(error ? { error } : {})
})

describe('CuratedRuntimeAdmission', () => {
  it('keeps curated candidates pending and filters only the curated winner', () => {
    const admission = new CuratedRuntimeAdmission()

    expect(admission.status('hermes-agent', 'curated')).toBe('pending')
    expect(Object.keys(admission.filterCatalog(catalog).runtimes).sort()).toEqual(['explicit', 'registered'])
    expect(admission.probeCandidates(catalog)).toEqual({ 'hermes-agent': runtime })
    expect(() => admission.assertLaunch('hermes-agent', 'curated')).toThrow(CuratedRuntimeAdmissionError)
    expect(() => admission.assertLaunch('explicit', 'user')).not.toThrow()
  })

  it('transitions pending to verified and preserves probe metadata', () => {
    let now = 100
    const admission = new CuratedRuntimeAdmission({ now: () => now, ttlMs: 1_000 })
    admission.record(result(true))

    expect(admission.status('hermes-agent', 'curated')).toBe('verified')
    expect(admission.result('hermes-agent')).toEqual(result(true))
    expect(Object.keys(admission.filterCatalog(catalog).runtimes).sort()).toEqual([
      'explicit',
      'hermes-agent',
      'registered'
    ])
    expect(() => admission.assertLaunch('hermes-agent', 'curated')).not.toThrow()
    expect(admission.probeCandidates(catalog)).toEqual({})

    now = 1_101
    expect(admission.status('hermes-agent', 'curated')).toBe('pending')
    expect(admission.probeCandidates(catalog)).toEqual({ 'hermes-agent': runtime })
    expect(() => admission.assertLaunch('hermes-agent', 'curated')).toThrow(/probe has not succeeded/i)
  })

  it('records a sanitized failure, omits it, and retries only after TTL', () => {
    let now = 100
    const admission = new CuratedRuntimeAdmission({ now: () => now, ttlMs: 1_000 })
    admission.record(result(false, 'token=[REDACTED] path=<path>'))

    expect(admission.status('hermes-agent', 'curated')).toBe('failed')
    expect(admission.probeCandidates(catalog)).toEqual({})
    expect(admission.filterCatalog(catalog).entries['hermes-agent']).toBeUndefined()
    expect(() => admission.assertLaunch('hermes-agent', 'curated')).toThrow(/token=\[REDACTED\]/)

    now = 1_101
    expect(admission.status('hermes-agent', 'curated')).toBe('pending')
    expect(admission.probeCandidates(catalog)).toEqual({ 'hermes-agent': runtime })
  })

  it('surfaces a fresh auth-required rejection for reporting without admitting it', () => {
    let now = 100
    const admission = new CuratedRuntimeAdmission({ now: () => now, ttlMs: 1_000 })
    admission.record({ ...result(false, 'Authentication required'), authRequired: true })

    // Reported (drives the console's login warning)…
    expect(admission.authRequiredIds(catalog)).toEqual(['hermes-agent'])
    // …but still failed for admission: not offered, not launchable, not re-probed early.
    expect(admission.status('hermes-agent', 'curated')).toBe('failed')
    expect(admission.filterCatalog(catalog).entries['hermes-agent']).toBeUndefined()
    expect(() => admission.assertLaunch('hermes-agent', 'curated')).toThrow(CuratedRuntimeAdmissionError)
    expect(admission.probeCandidates(catalog)).toEqual({})

    // A stale record stops driving the warning — the runtime is re-probed instead.
    now = 1_101
    expect(admission.authRequiredIds(catalog)).toEqual([])
  })

  it('keeps successes, plain failures and non-curated sources out of authRequiredIds', () => {
    const admission = new CuratedRuntimeAdmission()
    admission.record(result(false, 'spawn ENOENT'))
    expect(admission.authRequiredIds(catalog)).toEqual([])
    admission.record(result(true))
    expect(admission.authRequiredIds(catalog)).toEqual([])
    // Auth-required on a user-source runtime never rides the curated report path.
    admission.record({ runtime: 'explicit', ok: false, models: [], authRequired: true })
    expect(admission.authRequiredIds(catalog)).toEqual([])
  })
})
