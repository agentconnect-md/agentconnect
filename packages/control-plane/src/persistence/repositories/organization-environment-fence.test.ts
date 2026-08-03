/**
 * The pure half of the design §5 admission fence: the two refusals it makes before
 * anything is persisted. The locking/enrollment half needs a real database and is
 * covered by the integration suite.
 */
import { describe, it, expect } from 'vitest'
import { MAX_FRAME_BYTES } from '@agentconnect.md/protocol'
import {
  checkEnvironmentAdmission,
  MAX_RESOLVED_ENVIRONMENT_BYTES,
  OrganizationEnvironmentAdmissionError,
  assertEnvironmentAdmissible,
  type AgentEnvironmentSnapshot
} from './organization-environment-fence.js'
import type { AssignedOrganizationEntry } from '../../orchestrator/organizationEnvironment.js'

function snapshot(input: {
  agentId?: string
  variables?: Record<string, string>
  secretKeys?: string[]
  organizationEntries?: AssignedOrganizationEntry[]
  organizationValueBytes?: Record<string, number>
  agentSecretBytes?: Record<string, number>
}): AgentEnvironmentSnapshot {
  return {
    agentId: input.agentId ?? 'agent-1',
    variables: input.variables ?? {},
    secretKeys: input.secretKeys ?? [],
    organizationEntries: input.organizationEntries ?? [],
    organizationValueBytes: new Map(Object.entries(input.organizationValueBytes ?? {})),
    agentSecretBytes: new Map(Object.entries(input.agentSecretBytes ?? {}))
  }
}

describe('environment admission (design §5 step 4)', () => {
  it('admits an ordinary resolved configuration', () => {
    expect(
      checkEnvironmentAdmission([
        snapshot({
          variables: { REGION: 'eu' },
          secretKeys: ['TOKEN'],
          organizationEntries: [{ key: 'API_KEY', kind: 'secret' }],
          organizationValueBytes: { API_KEY: 32 },
          agentSecretBytes: { TOKEN: 16 }
        })
      ])
    ).toBeNull()
  })

  it('refuses an organization variable that would declassify an agent secret', () => {
    const failure = checkEnvironmentAdmission([
      snapshot({
        secretKeys: ['API_KEY'],
        organizationEntries: [{ key: 'API_KEY', kind: 'variable' }],
        organizationValueBytes: { API_KEY: 8 }
      })
    ])
    expect(failure).toEqual({ outcome: 'cross_kind_conflict', keys: ['API_KEY'] })
  })

  it('permits an organization SECRET over an agent secret (same-kind override)', () => {
    expect(
      checkEnvironmentAdmission([
        snapshot({
          secretKeys: ['API_KEY'],
          organizationEntries: [{ key: 'API_KEY', kind: 'secret' }],
          organizationValueBytes: { API_KEY: 8 }
        })
      ])
    ).toBeNull()
  })

  it('collects the conflicting keys across a whole batch, once each', () => {
    const failure = checkEnvironmentAdmission([
      snapshot({
        agentId: 'agent-a',
        secretKeys: ['API_KEY'],
        organizationEntries: [{ key: 'API_KEY', kind: 'variable' }]
      }),
      snapshot({
        agentId: 'agent-b',
        secretKeys: ['API_KEY', 'DB_PASSWORD'],
        organizationEntries: [
          { key: 'API_KEY', kind: 'variable' },
          { key: 'DB_PASSWORD', kind: 'variable' }
        ]
      })
    ])
    expect(failure).toEqual({ outcome: 'cross_kind_conflict', keys: ['API_KEY', 'DB_PASSWORD'] })
  })

  it('refuses a resolved environment past the wire admission budget, naming the agents', () => {
    const failure = checkEnvironmentAdmission([
      snapshot({ agentId: 'agent-small', variables: { SMALL: 'x' } }),
      snapshot({
        agentId: 'agent-big',
        organizationEntries: [{ key: 'HUGE', kind: 'secret' }],
        organizationValueBytes: { HUGE: MAX_RESOLVED_ENVIRONMENT_BYTES + 1 }
      })
    ])
    expect(failure).toEqual({ outcome: 'too_large', agentIds: ['agent-big'] })
  })

  it('leaves real headroom under the raw frame ceiling for the rest of the spec', () => {
    expect(MAX_RESOLVED_ENVIRONMENT_BYTES).toBeLessThan(MAX_FRAME_BYTES)
  })

  it('counts only the WINNING side of an overridden key', () => {
    // The agent's own 200 KiB variable is shadowed by a small organization
    // variable, so what actually ships is small — the write must be admitted.
    const budget = MAX_RESOLVED_ENVIRONMENT_BYTES
    expect(
      checkEnvironmentAdmission([
        snapshot({
          variables: { BLOB: 'x'.repeat(budget - 100) },
          organizationEntries: [{ key: 'BLOB', kind: 'variable' }],
          organizationValueBytes: { BLOB: 4 }
        })
      ])
    ).toBeNull()
  })

  it('counts a tombstoned key as contributing nothing at all', () => {
    expect(
      checkEnvironmentAdmission([
        snapshot({
          secretKeys: ['API_KEY'],
          agentSecretBytes: { API_KEY: 64 },
          // Missing material ⇒ invalid ⇒ the key leaves both maps.
          organizationEntries: [{ key: 'API_KEY', kind: 'secret', valid: false }],
          organizationValueBytes: { API_KEY: 0 }
        })
      ])
    ).toBeNull()
  })

  it('assertEnvironmentAdmissible throws a typed error the agent routes map to 409', () => {
    expect(() =>
      assertEnvironmentAdmissible([
        snapshot({
          secretKeys: ['API_KEY'],
          organizationEntries: [{ key: 'API_KEY', kind: 'variable' }]
        })
      ])
    ).toThrow(OrganizationEnvironmentAdmissionError)
    // The message may name KEYS (they are names, not values) and nothing else.
    try {
      assertEnvironmentAdmissible([
        snapshot({ secretKeys: ['API_KEY'], organizationEntries: [{ key: 'API_KEY', kind: 'variable' }] })
      ])
    } catch (err) {
      expect((err as Error).message).toContain('API_KEY')
    }
  })

  it('assertEnvironmentAdmissible is silent for an admissible batch', () => {
    expect(() => assertEnvironmentAdmissible([snapshot({ variables: { REGION: 'eu' } })])).not.toThrow()
  })
})
