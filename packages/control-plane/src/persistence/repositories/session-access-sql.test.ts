import { describe, expect, it } from 'vitest'
import type { SessionFilterQuery } from '../ports.js'
import { sessionViewerSql } from './session-access-sql.js'

type Viewer = NonNullable<SessionFilterQuery['viewer']>

function viewer(scopeCount: number, providers: string[] = ['github']): Viewer {
  return {
    role: 'collaborator',
    identitySet: ['user:u1'],
    externalAccess: {
      policies: providers.map((provider) => ({ provider, readFenceRev: null })),
      allowedScopes: Array.from({ length: scopeCount }, (_, i) => ({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        aclRevision: BigInt(i + 1)
      })),
      decisionAt: new Date(0)
    }
  }
}

/** Correlated subqueries are what this predicate pays per row — and the
 *  conversation page pays them again per probed row. */
function existsCount(sql: string): number {
  return sql.match(/EXISTS\s*\(/g)?.length ?? 0
}

describe('sessionViewerSql', () => {
  it('is absent for an internal unfiltered read', () => {
    expect(sessionViewerSql(undefined)).toBeNull()
  })

  it('asks nothing of the provider tables without an external-access snapshot', () => {
    const arm = sessionViewerSql({ role: 'collaborator', identitySet: ['user:u1'] })
    expect(arm).not.toBeNull()
    expect(arm!.sql).not.toContain('session_external_access_policy')
    expect(arm!.sql).not.toContain('external_scope')
    expect(existsCount(arm!.sql)).toBe(0)
  })

  /**
   * The regression this file exists for. Written as one OR arm per granted
   * scope, an ordinary org reached nineteen arms carrying ~28 correlated
   * subqueries, and the session page query measured in seconds rather than
   * milliseconds. The predicate's cost must not scale with how much the
   * viewer is allowed to see.
   */
  it('does not grow a subquery per granted scope', () => {
    const one = sessionViewerSql(viewer(1))!.sql
    const many = sessionViewerSql(viewer(50))!.sql

    expect(existsCount(many)).toBe(existsCount(one))
    // policy-with-fence, policy-presence, and the scope lookup — nothing per scope
    expect(existsCount(many)).toBe(3)
  })

  it('does not grow a subquery per provider policy', () => {
    const one = sessionViewerSql(viewer(2, ['github']))!.sql
    const three = sessionViewerSql(viewer(2, ['github', 'slack', 'feishu']))!.sql

    expect(existsCount(three)).toBe(existsCount(one))
  })

  it('still binds each granted scope to the revision it was granted at', () => {
    const arm = sessionViewerSql(viewer(2))!
    // the pair check is what keeps a scope from riding another scope's revision
    expect(arm.sql).toContain('"aclRevision"')
    expect(arm.sql).toContain('revokedAt')
    expect(arm.values).toContain(1n)
    expect(arm.values).toContain(2n)
  })

  it('keeps reading the live policy and scope tables, not the caller snapshot', () => {
    const arm = sessionViewerSql(viewer(3))!
    expect(arm.sql).toContain('session_external_access_policy')
    expect(arm.sql).toContain('external_scope')
  })

  it('carries identities and scope ids as parameters', () => {
    const arm = sessionViewerSql(viewer(2))!
    expect(arm.values).toContainEqual(['user:u1'])
    expect(arm.values).toContainEqual(['00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000001'])
  })
})
