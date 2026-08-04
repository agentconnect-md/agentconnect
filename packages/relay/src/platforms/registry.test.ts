import { describe, it, expect } from 'vitest'
import { DemuxIndex } from './registry.js'

/** The load-bearing invariant is tenant isolation: every install of a
 *  distributed app shares one app id AND one signing secret, so an app-only
 *  entry for a tenant-scoped bot would serve every sibling workspace's events
 *  to this one bot. These pin each rule that upholds it. */
describe('DemuxIndex', () => {
  it('a tenant-scoped assignment enters ONLY the composite index', () => {
    const idx = new DemuxIndex()
    idx.indexAssign('bot-1', { appId: 'A1', tenantId: 'T1' })
    expect(idx.resolve({ appId: 'A1', tenantId: 'T1' })).toBe('bot-1')
    // The app-only path must MISS — a sibling install's events carry the same
    // app id with a different tenant.
    expect(idx.resolve({ appId: 'A1' })).toBeUndefined()
    expect(idx.resolve({ appId: 'A1', tenantId: 'T2' })).toBeUndefined()
  })

  it('an app-only assignment resolves on the app index', () => {
    const idx = new DemuxIndex()
    idx.indexAssign('bot-2', { appId: 'A2' })
    expect(idx.resolve({ appId: 'A2' })).toBe('bot-2')
    // Composite lookups fall through to the app index for legacy bots.
    expect(idx.resolve({ appId: 'A2', tenantId: 'T9' })).toBe('bot-2')
  })

  it('gaining a tenant id evicts the stale app-only entry for the same bot', () => {
    const idx = new DemuxIndex()
    idx.indexAssign('bot-3', { appId: 'A3' })
    idx.indexAssign('bot-3', { appId: 'A3', tenantId: 'T3' })
    // The fast path must not keep serving cross-tenant through the stale entry.
    expect(idx.resolve({ appId: 'A3' })).toBeUndefined()
    expect(idx.resolve({ appId: 'A3', tenantId: 'T3' })).toBe('bot-3')
  })

  it('refuses to LEARN an app-only mapping for a tenant-scoped bot', () => {
    const idx = new DemuxIndex()
    idx.indexAssign('bot-4', { appId: 'A4', tenantId: 'T4' })
    // A learning call site that did not re-check must not be able to break the
    // tenant invariant.
    idx.learn('A4', 'bot-4')
    expect(idx.resolve({ appId: 'A4' })).toBeUndefined()
  })

  it('learns app-only mappings for legacy bots and forgets on unassign', () => {
    const idx = new DemuxIndex()
    idx.learn('A5', 'bot-5')
    expect(idx.resolve({ appId: 'A5' })).toBe('bot-5')
    idx.forget('bot-5')
    expect(idx.resolve({ appId: 'A5' })).toBeUndefined()
  })

  it('forget cleans the composite entry eagerly', () => {
    const idx = new DemuxIndex()
    idx.indexAssign('bot-6', { appId: 'A6', tenantId: 'T6' })
    idx.forget('bot-6')
    expect(idx.resolve({ appId: 'A6', tenantId: 'T6' })).toBeUndefined()
    expect(idx.indexes.byAppTenant.size).toBe(0)
  })
})
