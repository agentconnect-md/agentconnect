// The console's projection of an agent's Variables/Secrets across both sources
// (organization-secrets-and-variables.md §8.2). Presentation precedence must match
// the Control Plane's resolution, or a card would show a value that is not in effect.

import { describe, it, expect } from 'vitest'
import type { Agent } from '@/lib/data'
import { effectiveSecretRows, effectiveVariableRows, overriddenLocalKeys } from './OrganizationEnvironmentRows'

function agentWith(input: {
  env?: { k: string; v: string }[]
  secretKeys?: string[]
  organizationVariables?: { k: string; v: string }[]
  organizationSecretKeys?: string[]
}): Agent {
  return {
    env: input.env ?? [],
    secretKeys: input.secretKeys ?? [],
    organizationVariables: input.organizationVariables ?? [],
    organizationSecretKeys: input.organizationSecretKeys ?? []
    // Only these four fields are read; the rest of Agent is irrelevant here.
  } as Agent
}

describe('effectiveVariableRows', () => {
  it('shows the agent’s own variables untouched when nothing is assigned', () => {
    expect(effectiveVariableRows(agentWith({ env: [{ k: 'REGION', v: 'eu' }] }))).toEqual([
      { k: 'REGION', v: 'eu', fromOrganization: false }
    ])
  })

  it('drops a local row shadowed by an assigned organization variable and badges the winner', () => {
    const rows = effectiveVariableRows(
      agentWith({
        env: [{ k: 'REGION', v: 'local' }],
        organizationVariables: [{ k: 'REGION', v: 'eu' }]
      })
    )
    // One row, the organization value — never both, which would imply the local
    // value is also in effect.
    expect(rows).toEqual([{ k: 'REGION', v: 'eu', fromOrganization: true }])
  })

  it('drops a local variable shadowed by an organization SECRET — the key is write-only now', () => {
    const rows = effectiveVariableRows(
      agentWith({ env: [{ k: 'API_KEY', v: 'plain' }], organizationSecretKeys: ['API_KEY'] })
    )
    // It moved to the Secrets card; leaving it here would display a value the
    // agent no longer receives, in plaintext.
    expect(rows).toEqual([])
  })

  it('keeps unrelated local rows alongside inherited ones', () => {
    const rows = effectiveVariableRows(
      agentWith({
        env: [{ k: 'LOCAL_ONLY', v: '1' }],
        organizationVariables: [{ k: 'SHARED', v: '2' }]
      })
    )
    expect(rows).toEqual([
      { k: 'LOCAL_ONLY', v: '1', fromOrganization: false },
      { k: 'SHARED', v: '2', fromOrganization: true }
    ])
  })
})

describe('effectiveSecretRows', () => {
  it('combines both sources and marks only the inherited names', () => {
    expect(effectiveSecretRows(agentWith({ secretKeys: ['OWN'], organizationSecretKeys: ['SHARED'] }))).toEqual([
      { k: 'OWN', fromOrganization: false },
      { k: 'SHARED', fromOrganization: true }
    ])
  })

  it('lists a collided key once, as the organization row', () => {
    expect(effectiveSecretRows(agentWith({ secretKeys: ['API_KEY'], organizationSecretKeys: ['API_KEY'] }))).toEqual([
      { k: 'API_KEY', fromOrganization: true }
    ])
  })
})

describe('overriddenLocalKeys', () => {
  it('names the retained local rows the editor marks "Overridden by Organization"', () => {
    const overridden = overriddenLocalKeys(
      agentWith({
        env: [
          { k: 'REGION', v: 'local' },
          { k: 'UNTOUCHED', v: 'x' }
        ],
        secretKeys: ['API_KEY'],
        organizationVariables: [{ k: 'REGION', v: 'eu' }],
        organizationSecretKeys: ['API_KEY']
      })
    )
    expect([...overridden].sort()).toEqual(['API_KEY', 'REGION'])
  })

  it('is empty when no assignment collides', () => {
    expect(overriddenLocalKeys(agentWith({ env: [{ k: 'REGION', v: 'eu' }] })).size).toBe(0)
  })
})
