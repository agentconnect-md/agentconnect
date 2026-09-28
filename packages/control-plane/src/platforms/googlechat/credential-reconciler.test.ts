/** The boot pass that carries a rotated deployment key to the claimed customer rows (google-chat-integration.md §10.3). */
import { describe, expect, it, vi } from 'vitest'
import { BotId, OrgId } from '../../domain/ids.js'
import type { BotRecord, BotSecretMaterial } from '../../persistence/ports.js'
import { GoogleChatCredentialReconciler } from './credential-reconciler.js'

const PROJECT_ID = 'example-project'
const PROJECT_NUMBER = '100000000000'
const key = (id: string) =>
  JSON.stringify({
    type: 'service_account',
    project_id: PROJECT_ID,
    private_key_id: id,
    private_key: 'synthetic-private-key',
    client_email: `chat-app@${PROJECT_ID}.iam.gserviceaccount.com`
  })
// The configured key as the Setup Server stored it, pretty-printed; rows hold its canonical form.
const ROTATED = JSON.stringify(JSON.parse(key('rotated')), null, 2)
const CANONICAL = JSON.stringify(JSON.parse(ROTATED))
const APP = { projectId: PROJECT_ID, projectNumber: PROJECT_NUMBER, serviceAccountKey: ROTATED }
const secret = (botToken: string): BotSecretMaterial => ({ botToken, appToken: null, signingSecret: null })

const row = (id: string, over: Partial<BotRecord> = {}): BotRecord =>
  ({
    id: BotId(id),
    orgId: OrgId('11111111-1111-4111-8111-111111111111'),
    platform: 'googlechat',
    externalAppId: PROJECT_NUMBER,
    externalTenantId: 'customers/C0000000001',
    platformConfig: { projectId: PROJECT_ID, customerId: 'C0000000001' },
    ...over
  }) as BotRecord

const STALE = row('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
const CURRENT = row('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', {
  externalTenantId: 'domains/0000000002',
  platformConfig: { projectId: PROJECT_ID, domainIds: '0000000002' }
})
// A tenantless row of the deployment project and a customer of another app are never touched.
const TENANTLESS = row('cccccccc-cccc-4ccc-8ccc-cccccccccccc', { externalTenantId: '-' })
const OTHER_APP = row('dddddddd-dddd-4ddd-8ddd-dddddddddddd', { externalAppId: '200000000000' })
const NO_SECRET = row('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', { externalTenantId: 'customers/C0000000005' })

function harness(app: typeof APP | null = APP) {
  const stored = new Map<string, BotSecretMaterial>([
    [STALE.id, secret(key('previous'))],
    [CURRENT.id, secret(CANONICAL)],
    [TENANTLESS.id, secret(key('previous'))],
    [OTHER_APP.id, secret(key('previous'))]
  ])
  const listForPlatform = vi.fn(async () => [STALE, CURRENT, TENANTLESS, OTHER_APP, NO_SECRET])
  const install = vi.fn(async (_org: OrgId, id: BotId, material: BotSecretMaterial, _at: Date) => {
    stored.set(id, material)
    return 2
  })
  const resync = vi.fn(async (_id: BotId) => {})
  const log = { info: vi.fn(), error: vi.fn() }
  const reconciler = new GoogleChatCredentialReconciler({
    bots: { listForPlatform },
    secrets: { get: async (_org, id) => stored.get(id) ?? null },
    credentials: { install },
    resync,
    ...(app ? { app } : {}),
    clock: { now: () => Date.parse('2026-09-28T00:00:00Z') } as never,
    log
  })
  return { reconciler, stored, listForPlatform, install, resync, log }
}

describe('GoogleChatCredentialReconciler', () => {
  it('re-stamps only a customer row of the deployment app whose stored key differs, then re-syncs it', async () => {
    const h = harness()

    expect(await h.reconciler.run()).toBe(1)
    expect(h.install.mock.calls).toEqual([[STALE.orgId, STALE.id, secret(CANONICAL), new Date('2026-09-28T00:00:00Z')]])
    expect(h.resync.mock.calls).toEqual([[STALE.id]])
    expect(h.stored.get(TENANTLESS.id)).toEqual(secret(key('previous')))
    // Only the count is logged, never key material.
    expect(h.log.info).toHaveBeenCalledWith({ rows: 1 }, expect.any(String))
    expect(JSON.stringify([...h.log.info.mock.calls, ...h.log.error.mock.calls])).not.toContain('synthetic-private-key')

    // The next boot finds every customer row current.
    expect(await h.reconciler.run()).toBe(0)
    expect(h.install).toHaveBeenCalledTimes(1)
  })

  it('does nothing without a deployment app', async () => {
    const h = harness(null)

    expect(await h.reconciler.run()).toBe(0)
    expect(h.listForPlatform).not.toHaveBeenCalled()
  })

  it('stamps nothing, and logs no key, when the configured key does not parse', async () => {
    const h = harness({ ...APP, serviceAccountKey: '{not json' })

    expect(await h.reconciler.run()).toBe(0)
    expect(h.listForPlatform).not.toHaveBeenCalled()
    expect(h.log.error).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(h.log.error.mock.calls)).not.toContain('not json')
  })

  it('keeps going past a row whose write fails', async () => {
    const h = harness()
    const next = row('ffffffff-ffff-4fff-8fff-ffffffffffff', { externalTenantId: 'customers/C0000000009' })
    h.stored.set(next.id, secret(key('previous')))
    h.listForPlatform.mockResolvedValueOnce([STALE, next])
    h.install.mockRejectedValueOnce(new Error('database unavailable'))

    expect(await h.reconciler.run()).toBe(1)
    expect(h.log.error).toHaveBeenCalledWith(expect.objectContaining({ botId: STALE.id }), expect.any(String))
    expect(h.resync.mock.calls).toEqual([[next.id]])
  })

  it('runs its one pass on the first start only', async () => {
    const h = harness()
    h.reconciler.start()
    h.reconciler.start()
    await vi.waitFor(() => expect(h.resync).toHaveBeenCalledTimes(1))
    expect(h.listForPlatform).toHaveBeenCalledTimes(1)
    h.reconciler.stop()
  })
})
