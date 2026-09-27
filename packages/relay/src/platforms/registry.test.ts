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

  // A multi-tenant app (google-chat-integration.md §10.4): customer rows known by several keys beside one anchor.
  it('a bot known by several tenant keys takes one composite entry per key and never the app index', () => {
    const idx = new DemuxIndex()
    idx.indexAssign('bot-7', { appId: 'A7', tenantIds: ['customers/C1', 'domains/D1'] })
    expect(idx.resolve({ appId: 'A7', tenantId: 'customers/C1' })).toBe('bot-7')
    expect(idx.resolve({ appId: 'A7', tenantId: 'domains/D1' })).toBe('bot-7')
    expect(idx.resolve({ appId: 'A7' })).toBeUndefined()
    expect(idx.resolve({ appId: 'A7', tenantId: 'customers/C2' })).toBeUndefined()
    idx.learn('A7', 'bot-7')
    expect(idx.resolve({ appId: 'A7' })).toBeUndefined()
    // The anchor sits in the app index beside the rows, so a tenant no row knows falls to it and a known one does not.
    idx.indexAssign('anchor', { appId: 'A7' })
    expect(idx.resolve({ appId: 'A7', tenantId: 'customers/C2' })).toBe('anchor')
    expect(idx.resolve({ appId: 'A7', tenantId: 'customers/C1' })).toBe('bot-7')
    // Forgetting the row drops every key; its tenants fall to the anchor from then on.
    idx.forget('bot-7')
    expect(idx.resolve({ appId: 'A7', tenantId: 'domains/D1' })).toBe('anchor')
    expect(idx.indexes.byAppTenant.size).toBe(0)
    expect(idx.resolve({ appId: 'A7' })).toBe('anchor')
  })

  it('gaining tenant keys evicts the stale app-only entry, and an empty list is app-only', () => {
    const idx = new DemuxIndex()
    idx.indexAssign('bot-8', { appId: 'A8' })
    idx.indexAssign('bot-8', { appId: 'A8', tenantIds: ['customers/C8'] })
    expect(idx.resolve({ appId: 'A8' })).toBeUndefined()
    expect(idx.resolve({ appId: 'A8', tenantId: 'customers/C8' })).toBe('bot-8')
    idx.indexAssign('bot-9', { appId: 'A9', tenantIds: [] })
    expect(idx.resolve({ appId: 'A9' })).toBe('bot-9')
  })

  it('forget removes only the composite entries the bot still owns', () => {
    // Two rows indexed under one key: the later owner survives the earlier one's forget.
    const idx = new DemuxIndex()
    idx.indexAssign('bot-a', { appId: 'A', tenantIds: ['customers/C'] })
    idx.indexAssign('bot-b', { appId: 'A', tenantIds: ['customers/C'] })
    idx.forget('bot-a')
    expect(idx.resolve({ appId: 'A', tenantId: 'customers/C' })).toBe('bot-b')
    idx.forget('bot-b')
    expect(idx.indexes.byAppTenant.size).toBe(0)
  })
})
