/**
 * Resolution precedence for organization variables and secrets
 * (organization-secrets-and-variables.md §3.2, §9). Pure — no I/O.
 *
 * The three permitted collision combinations, the ONE forbidden one, and the
 * tombstone behavior that keeps a missing/forbidden key from silently falling back
 * to the agent value it was meant to replace.
 */
import { describe, it, expect } from 'vitest'
import {
  crossKindConflicts,
  emptyOrganizationEnvironmentValues,
  planEffectiveKeys,
  resolveEffectiveEnvironment,
  type OrganizationEnvironmentValues
} from './organizationEnvironment.js'

function organizationValues(input: {
  variables?: Record<string, string>
  secrets?: Record<string, string>
  invalid?: string[]
}): OrganizationEnvironmentValues {
  return {
    variables: new Map(Object.entries(input.variables ?? {})),
    secrets: new Map(Object.entries(input.secrets ?? {})),
    invalidKeys: new Set(input.invalid ?? [])
  }
}

describe('effective environment resolution', () => {
  it('passes agent-only configuration through unchanged', () => {
    const resolved = resolveEffectiveEnvironment(
      { LOG_LEVEL: 'debug' },
      { API_KEY: 'agent-secret' },
      emptyOrganizationEnvironmentValues()
    )
    expect(resolved).toEqual({ env: { LOG_LEVEL: 'debug' }, secrets: { API_KEY: 'agent-secret' }, tombstoned: [] })
  })

  it('layers assigned organization entries into the two wire maps', () => {
    const resolved = resolveEffectiveEnvironment(
      { LOG_LEVEL: 'debug' },
      {},
      organizationValues({ variables: { REGION: 'us-east-1' }, secrets: { SHARED_TOKEN: 'org-token' } })
    )
    expect(resolved.env).toEqual({ LOG_LEVEL: 'debug', REGION: 'us-east-1' })
    expect(resolved.secrets).toEqual({ SHARED_TOKEN: 'org-token' })
  })

  // ── the three PERMITTED collision combinations ──

  it('an organization variable overrides a same-key agent variable', () => {
    const resolved = resolveEffectiveEnvironment(
      { REGION: 'local' },
      {},
      organizationValues({ variables: { REGION: 'us-east-1' } })
    )
    expect(resolved.env).toEqual({ REGION: 'us-east-1' })
    expect(resolved.secrets).toEqual({})
  })

  it('an organization secret overrides a same-key agent secret', () => {
    const resolved = resolveEffectiveEnvironment(
      {},
      { API_KEY: 'agent-value' },
      organizationValues({ secrets: { API_KEY: 'org-value' } })
    )
    expect(resolved.secrets).toEqual({ API_KEY: 'org-value' })
    expect(resolved.env).toEqual({})
  })

  it('an organization secret overrides a same-key agent VARIABLE, upgrading the classification', () => {
    const resolved = resolveEffectiveEnvironment(
      { API_KEY: 'plain-agent-value' },
      {},
      organizationValues({ secrets: { API_KEY: 'org-value' } })
    )
    // The key moves INTO the write-only map — a tightening, so it is allowed.
    expect(resolved.secrets).toEqual({ API_KEY: 'org-value' })
    expect(resolved.env).toEqual({})
  })

  // ── the ONE forbidden combination ──

  it('an organization VARIABLE never declassifies a same-key agent secret — the key is tombstoned', () => {
    const resolved = resolveEffectiveEnvironment(
      {},
      { API_KEY: 'agent-secret' },
      organizationValues({ variables: { API_KEY: 'org-plain' } })
    )
    // Neither map carries it: not `env` (that would be the declassification) and
    // not `secrets` (falling back to the agent value would defeat the assignment).
    expect(resolved.env).toEqual({})
    expect(resolved.secrets).toEqual({})
    expect(resolved.tombstoned).toEqual(['API_KEY'])
  })

  it('reports the conflicting keys for a write-time refusal, from either direction', () => {
    expect(crossKindConflicts(['API_KEY', 'OTHER'], [{ key: 'API_KEY', kind: 'variable' }])).toEqual(['API_KEY'])
    // Same-kind and upgrade combinations are NOT conflicts.
    expect(crossKindConflicts(['API_KEY'], [{ key: 'API_KEY', kind: 'secret' }])).toEqual([])
    expect(crossKindConflicts([], [{ key: 'API_KEY', kind: 'variable' }])).toEqual([])
  })

  // ── missing material (§9) ──

  it('an organization secret with no stored material suppresses, not reactivates, the agent fallback', () => {
    const resolved = resolveEffectiveEnvironment(
      {},
      { API_KEY: 'stale-agent-secret' },
      organizationValues({ invalid: ['API_KEY'] })
    )
    expect(resolved.secrets).toEqual({})
    expect(resolved.env).toEqual({})
    expect(resolved.tombstoned).toEqual(['API_KEY'])
  })

  it('keeps unrelated entries resolving normally alongside an invalid one', () => {
    const resolved = resolveEffectiveEnvironment(
      { LOG_LEVEL: 'debug' },
      {},
      organizationValues({ variables: { REGION: 'eu' }, invalid: ['BROKEN'] })
    )
    expect(resolved.env).toEqual({ LOG_LEVEL: 'debug', REGION: 'eu' })
    expect(resolved.tombstoned).toEqual(['BROKEN'])
  })

  // ── fallback restoration ──

  it('restores the retained agent value once the assignment is gone', () => {
    const assigned = resolveEffectiveEnvironment(
      { REGION: 'local' },
      {},
      organizationValues({ variables: { REGION: 'us-east-1' } })
    )
    expect(assigned.env.REGION).toBe('us-east-1')
    // Unassigning is modelled exactly as the CP does it: the agent row was never
    // deleted, so the next resolve emits it again with no re-entry of the value.
    const unassigned = resolveEffectiveEnvironment({ REGION: 'local' }, {}, emptyOrganizationEnvironmentValues())
    expect(unassigned.env.REGION).toBe('local')
  })
})

describe('effective key plan', () => {
  it('marks the shadowed agent row as overridden without dropping it from the plan', () => {
    const plan = planEffectiveKeys(['REGION'], [], [{ key: 'REGION', kind: 'variable' }])
    expect(plan.keys).toEqual([{ key: 'REGION', source: 'organization', kind: 'variable', overridden: true }])
  })

  it('does not mark an organization-only key as overriding anything', () => {
    const plan = planEffectiveKeys([], [], [{ key: 'REGION', kind: 'variable' }])
    expect(plan.keys).toEqual([{ key: 'REGION', source: 'organization', kind: 'variable', overridden: false }])
  })

  it('treats an agent key held as both kinds as the stricter one', () => {
    const plan = planEffectiveKeys(['API_KEY'], ['API_KEY'], [])
    expect(plan.keys).toEqual([{ key: 'API_KEY', source: 'agent', kind: 'secret', overridden: false }])
  })

  it('sorts by key so the projection is stable', () => {
    const plan = planEffectiveKeys(['B', 'A'], ['C'], [])
    expect(plan.keys.map((k) => k.key)).toEqual(['A', 'B', 'C'])
  })
})
