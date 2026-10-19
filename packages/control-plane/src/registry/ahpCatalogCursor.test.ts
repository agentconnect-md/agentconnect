import { describe, expect, it } from 'vitest'
import { AhpSessionList, AhpSessionListResult } from '@agentconnect.md/protocol'
import { AhpCatalogCursor } from './ahpCatalogCursor.js'

const scope = { orgId: 'org', agentId: '550e8400-e29b-41d4-a716-446655440000', userId: 'user' }
describe('AHP catalog cursor', () => {
  it('encrypts the scan boundary and binds it to the current principal, agent, and org', async () => {
    const cursors = new AhpCatalogCursor('test-pepper')
    const token = await cursors.encode(scope, 'hidden-session')
    expect(token).not.toContain('hidden-session')
    expect(await cursors.decode(scope, token)).toBe('hidden-session')
    for (const key of ['orgId', 'agentId', 'userId'] as const)
      expect(await cursors.decode({ ...scope, [key]: 'other' }, token)).toBeNull()
    expect(await cursors.decode(scope, `${token.slice(0, -8)}tampered`)).toBeNull()
    expect(await new AhpCatalogCursor('different-pepper').decode(scope, token)).toBeNull()
  })

  it('expires after ten minutes independently of the current AHP grant', async () => {
    let now = 1_000_000
    const cursors = new AhpCatalogCursor('test-pepper', () => now)
    const token = await cursors.encode(scope, 'outward')
    now += 599_000
    expect(await cursors.decode(scope, token)).toBe('outward')
    now += 1000
    expect(await cursors.decode(scope, token)).toBeNull()
  })

  it.each(['界'.repeat(256), '\u0000'.repeat(256), '😀'.repeat(128)])(
    'fits the public cursor bound for opaque UTF-8 session identifiers',
    async (id) => {
      const cursors = new AhpCatalogCursor('test-pepper')
      const largeScope = { ...scope, orgId: '界'.repeat(64), userId: '界'.repeat(256) }
      const token = await cursors.encode(largeScope, id)
      expect(token.length).toBeLessThanOrEqual(2048)
      expect(await cursors.decode(largeScope, token)).toBe(id)
      expect(AhpSessionList.parse({ orgId: 'org', agentId: scope.agentId, grant: 'g', cursor: token }).cursor).toBe(
        token
      )
      expect(AhpSessionListResult.parse({ ok: true, sessions: [], cursor: token })).toMatchObject({ cursor: token })
    }
  )
})
