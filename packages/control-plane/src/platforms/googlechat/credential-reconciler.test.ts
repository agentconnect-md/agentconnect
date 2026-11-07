// The boot pass that takes the deployment app's key off its rows (google-chat-integration.md §10.10).
import { describe, expect, it, vi } from 'vitest'
import { BotId, OrgId } from '../../domain/ids.js'
import type { BotRecord, BotSecretMaterial } from '../../persistence/ports.js'
import { GoogleChatCredentialReconciler } from './credential-reconciler.js'
import {
  GOOGLE_CHAT_DEPLOYMENT_KEY_MARKER,
  GOOGLE_CHAT_DEPLOYMENT_OWNER,
  GOOGLE_CHAT_ROW_OWNER_KEY,
  googleChatDeploymentSecrets,
  googleChatRelayApp,
  isGoogleChatDeploymentRow,
  usesGoogleChatDeploymentApp
} from './deployment-app.js'

const PROJECT_ID = 'example-project'
const PROJECT_NUMBER = '100000000000'
const OTHER_PROJECT = '200000000000'
const key = (id: string) =>
  JSON.stringify({
    type: 'service_account',
    project_id: PROJECT_ID,
    private_key_id: id,
    private_key: 'synthetic-private-key',
    client_email: `chat-app@${PROJECT_ID}.iam.gserviceaccount.com`
  })
const APP = { projectId: PROJECT_ID, projectNumber: PROJECT_NUMBER, serviceAccountKey: key('deployment') }
const secret = (botToken: string): BotSecretMaterial => ({ botToken, appToken: null, signingSecret: null })

const row = (id: string, over: Partial<BotRecord> = {}): BotRecord =>
  ({
    id: BotId(id),
    orgId: OrgId('11111111-1111-4111-8111-111111111111'),
    platform: 'googlechat',
    externalAppId: PROJECT_NUMBER,
    externalTenantId: 'customers/C0000000001',
    prebuilt: true,
    platformConfig: { projectId: PROJECT_ID, customerId: 'C0000000001' },
    ...over
  }) as BotRecord

// Every claim wrote `prebuilt`, so a customer row an older build stamped is known with or without the configured app.
const STAMPED = row('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
// Two organizations' own apps: tenantless, and keyed by the one customer the install probe proved.
const OWN = row('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', {
  externalAppId: OTHER_PROJECT,
  externalTenantId: '-',
  prebuilt: false,
  platformConfig: { projectId: 'own-project' }
})
const OWN_KEYED = row('cccccccc-cccc-4ccc-8ccc-cccccccccccc', {
  externalAppId: OTHER_PROJECT,
  externalTenantId: 'customers/C0000000002',
  prebuilt: false,
  platformConfig: { projectId: 'own-project', customerId: 'C0000000002' }
})

function harness(rows: BotRecord[], stored: Map<string, BotSecretMaterial>, app?: typeof APP) {
  const merged = new Map<string, Record<string, string>>()
  const listForPlatform = vi.fn(async () => rows)
  const install = vi.fn(async (_org: OrgId, id: BotId, material: BotSecretMaterial, _at: Date) => {
    stored.set(id, material)
    return 2
  })
  const resync = vi.fn(async (_id: BotId) => {})
  const log = { info: vi.fn(), error: vi.fn() }
  const reconciler = new GoogleChatCredentialReconciler({
    bots: {
      listForPlatform,
      mergeBotIdentity: vi.fn(async (_org, id, merge) => {
        merged.set(id, merge({ platformConfig: {}, externalTenantId: null }).platformConfig ?? {})
        return true
      })
    },
    secrets: { get: async (_org, id) => stored.get(id) ?? null },
    credentials: { install },
    resync,
    ...(app ? { app } : {}),
    clock: { now: () => Date.parse('2026-09-28T00:00:00Z') } as never,
    log
  })
  return { reconciler, merged, listForPlatform, install, resync, log }
}

describe('a deployment app’s row', () => {
  it('is known by what it stores, whatever the deployment is configured with now', () => {
    expect(isGoogleChatDeploymentRow(row('a', { externalAppId: OTHER_PROJECT, prebuilt: true }))).toBe(true)
    expect(
      isGoogleChatDeploymentRow(
        row('b', { prebuilt: false, platformConfig: { [GOOGLE_CHAT_ROW_OWNER_KEY]: GOOGLE_CHAT_DEPLOYMENT_OWNER } })
      )
    ).toBe(true)
    expect(isGoogleChatDeploymentRow(row('c', { prebuilt: false }), APP)).toBe(true)
    expect(isGoogleChatDeploymentRow(row('c', { prebuilt: false }))).toBe(false)
  })

  it('is not an organization’s own app, however that app is keyed', () => {
    expect(isGoogleChatDeploymentRow(OWN, APP)).toBe(false)
    expect(isGoogleChatDeploymentRow(OWN_KEYED, APP)).toBe(false)
    expect(usesGoogleChatDeploymentApp(OWN_KEYED, APP)).toBe(false)
  })

  it('reaches the relay snapshot as the configured project and key, and nothing without an app', () => {
    expect(googleChatRelayApp(APP)).toEqual({ projectNumber: PROJECT_NUMBER, serviceAccountKey: APP.serviceAccountKey })
    expect(googleChatRelayApp(undefined)).toBeUndefined()
  })
})

describe('GoogleChatCredentialReconciler', () => {
  it('replaces a stored key with the marker, records the owner and re-syncs, with no app configured too', async () => {
    for (const app of [APP, undefined]) {
      const stored = new Map([[STAMPED.id as string, secret(key('deployment'))]])
      const h = harness([STAMPED], stored, app)

      expect(await h.reconciler.run()).toBe(1)
      expect(h.install.mock.calls).toEqual([
        [STAMPED.orgId, STAMPED.id, googleChatDeploymentSecrets(), new Date('2026-09-28T00:00:00Z')]
      ])
      expect(h.merged.get(STAMPED.id)).toEqual({ [GOOGLE_CHAT_ROW_OWNER_KEY]: GOOGLE_CHAT_DEPLOYMENT_OWNER })
      expect(h.resync.mock.calls).toEqual([[STAMPED.id]])
      expect(stored.get(STAMPED.id)).toEqual(secret(GOOGLE_CHAT_DEPLOYMENT_KEY_MARKER))
      // Only the count is logged, never key material.
      expect(h.log.info).toHaveBeenCalledWith({ rows: 1 }, expect.any(String))
      expect(JSON.stringify([...h.log.info.mock.calls, ...h.log.error.mock.calls])).not.toContain(
        'synthetic-private-key'
      )
    }
  })

  it('leaves an organization’s own app and its key alone, keyed by its customer or not', async () => {
    const stored = new Map([
      [OWN.id as string, secret(key('own'))],
      [OWN_KEYED.id as string, secret(key('own-keyed'))]
    ])
    const h = harness([OWN, OWN_KEYED], stored, APP)

    expect(await h.reconciler.run()).toBe(0)
    expect(h.install).not.toHaveBeenCalled()
    expect(h.resync).not.toHaveBeenCalled()
    expect(stored.get(OWN.id)).toEqual(secret(key('own')))
    expect(stored.get(OWN_KEYED.id)).toEqual(secret(key('own-keyed')))
  })

  it('takes the key off a tenantless row of the deployment project too, which serves nothing', async () => {
    const shadow = row('dddddddd-dddd-4ddd-8ddd-dddddddddddd', { externalTenantId: '-', prebuilt: false })
    const stored = new Map([[shadow.id as string, secret(key('deployment'))]])
    const h = harness([shadow], stored, APP)

    expect(await h.reconciler.run()).toBe(1)
    expect(stored.get(shadow.id)).toEqual(secret(GOOGLE_CHAT_DEPLOYMENT_KEY_MARKER))
  })

  it('treats a stored marker as ownership alone, and records the owner on such a row', async () => {
    const marked = row('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', {
      externalAppId: OTHER_PROJECT,
      externalTenantId: '-',
      prebuilt: false,
      platformConfig: { projectId: PROJECT_ID }
    })
    const stored = new Map([[marked.id as string, secret(GOOGLE_CHAT_DEPLOYMENT_KEY_MARKER)]])
    const h = harness([marked], stored)

    expect(await h.reconciler.run()).toBe(1)
    expect(h.install).not.toHaveBeenCalled()
    expect(h.merged.get(marked.id)).toEqual({ [GOOGLE_CHAT_ROW_OWNER_KEY]: GOOGLE_CHAT_DEPLOYMENT_OWNER })
    expect(h.resync.mock.calls).toEqual([[marked.id]])
  })

  it('never stamps the configured key back, and finds nothing to do on the next boot', async () => {
    const done = row('ffffffff-ffff-4fff-8fff-ffffffffffff', {
      platformConfig: {
        projectId: PROJECT_ID,
        customerId: 'C0000000001',
        [GOOGLE_CHAT_ROW_OWNER_KEY]: GOOGLE_CHAT_DEPLOYMENT_OWNER
      }
    })
    const stored = new Map([[done.id as string, secret(GOOGLE_CHAT_DEPLOYMENT_KEY_MARKER)]])
    const h = harness([done], stored, APP)

    expect(await h.reconciler.run()).toBe(0)
    expect(h.install).not.toHaveBeenCalled()
    expect(h.resync).not.toHaveBeenCalled()
    expect(stored.get(done.id)).toEqual(secret(GOOGLE_CHAT_DEPLOYMENT_KEY_MARKER))
  })

  it('keeps going past a row whose write fails', async () => {
    const next = row('99999999-9999-4999-8999-999999999999')
    const stored = new Map([
      [STAMPED.id as string, secret(key('deployment'))],
      [next.id as string, secret(key('deployment'))]
    ])
    const h = harness([STAMPED, next], stored, APP)
    h.install.mockRejectedValueOnce(new Error('database unavailable'))

    expect(await h.reconciler.run()).toBe(1)
    expect(h.log.error).toHaveBeenCalledWith(expect.objectContaining({ botId: STAMPED.id }), expect.any(String))
    expect(h.resync.mock.calls).toEqual([[next.id]])
  })

  it('runs its one pass on the first start only', async () => {
    const h = harness([STAMPED], new Map([[STAMPED.id as string, secret(key('deployment'))]]), APP)
    h.reconciler.start()
    h.reconciler.start()
    await vi.waitFor(() => expect(h.resync).toHaveBeenCalledTimes(1))
    expect(h.listForPlatform).toHaveBeenCalledTimes(1)
    h.reconciler.stop()
  })
})
