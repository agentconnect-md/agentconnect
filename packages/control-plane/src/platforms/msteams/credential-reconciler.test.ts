// The boot pass that takes the deployment app's secret off its rows (teams-integration.md §8.5).
import { describe, expect, it, vi } from 'vitest'
import { BotId, OrgId } from '../../domain/ids.js'
import type { BotRecord, BotSecretMaterial } from '../../persistence/ports.js'
import { MsTeamsCredentialReconciler } from './credential-reconciler.js'
import {
  MSTEAMS_DEPLOYMENT_OWNER,
  MSTEAMS_DEPLOYMENT_SECRET_MARKER,
  MSTEAMS_ROW_OWNER_KEY,
  isMsTeamsDeploymentRow,
  msTeamsRelayApp,
  msTeamsRelayTicketKey
} from './deployment-app.js'

const APP = {
  appId: '00000000-0000-4000-8000-0000000000a1',
  tenantId: '00000000-0000-4000-8000-0000000000ff',
  clientSecret: 'deployment-secret-example'
}
const OTHER_APP = '00000000-0000-4000-8000-0000000000a2'
const ORG = OrgId('org-1')

const row = (id: string, over: Partial<BotRecord> = {}) =>
  ({
    id: BotId(id),
    orgId: ORG,
    externalAppId: APP.appId,
    prebuilt: false,
    platformConfig: null,
    ...over
  }) as unknown as BotRecord
const material = (botToken: string): BotSecretMaterial => ({ botToken, appToken: null, signingSecret: null })

function reconcilerOver(rows: BotRecord[], stored: Map<string, BotSecretMaterial>, app?: typeof APP) {
  const merged = new Map<string, Record<string, string>>()
  const install = vi.fn(async (_org: unknown, botId: string, m: BotSecretMaterial) => {
    stored.set(botId, m)
    return 1
  })
  const resync = vi.fn(async () => {})
  const reconciler = new MsTeamsCredentialReconciler({
    bots: {
      listForPlatform: async () => rows,
      mergeBotIdentity: vi.fn(async (_org, botId, merge) => {
        merged.set(botId, merge({ platformConfig: {}, externalTenantId: null }).platformConfig ?? {})
        return true
      })
    },
    secrets: { get: async (_org, botId) => stored.get(botId) ?? null },
    credentials: { install } as never,
    resync,
    ...(app ? { app } : {}),
    clock: { now: () => 0 } as never
  })
  return { reconciler, merged, install, resync }
}

describe('a deployment app’s row', () => {
  it('is known by what it stores, whatever the deployment is configured with now', () => {
    expect(isMsTeamsDeploymentRow(row('a', { externalAppId: OTHER_APP, prebuilt: true }))).toBe(true)
    expect(isMsTeamsDeploymentRow(row('b', { platformConfig: { tokenTenantId: APP.tenantId } }))).toBe(true)
    expect(
      isMsTeamsDeploymentRow(row('c', { platformConfig: { [MSTEAMS_ROW_OWNER_KEY]: MSTEAMS_DEPLOYMENT_OWNER } }))
    ).toBe(true)
    expect(isMsTeamsDeploymentRow(row('d'), APP)).toBe(true)
    expect(isMsTeamsDeploymentRow(row('e', { externalAppId: OTHER_APP }), APP)).toBe(false)
  })
})

describe('MsTeamsCredentialReconciler', () => {
  it('marks every deployment row, replaces a stored secret with the marker, and re-syncs only those that moved', async () => {
    const stored = new Map<string, BotSecretMaterial>([
      ['stamped', material(APP.clientSecret)],
      ['purged', material(MSTEAMS_DEPLOYMENT_SECRET_MARKER)],
      ['own', material('own-secret-example')]
    ])
    const marked = { platformConfig: { [MSTEAMS_ROW_OWNER_KEY]: MSTEAMS_DEPLOYMENT_OWNER } }
    const { reconciler, merged, resync } = reconcilerOver(
      [
        row('stamped', { prebuilt: true, platformConfig: { tokenTenantId: APP.tenantId } }),
        row('purged', marked),
        row('own', { externalAppId: OTHER_APP })
      ],
      stored,
      APP
    )
    expect(await reconciler.run()).toBe(1)
    expect(stored.get('stamped')).toEqual(material(MSTEAMS_DEPLOYMENT_SECRET_MARKER))
    expect(merged.get('stamped')).toEqual({ [MSTEAMS_ROW_OWNER_KEY]: MSTEAMS_DEPLOYMENT_OWNER })
    expect(stored.get('own')).toEqual(material('own-secret-example'))
    expect(merged.has('own')).toBe(false)
    expect(resync).toHaveBeenCalledTimes(1)
    expect(resync).toHaveBeenCalledWith('stamped')
  })

  it('takes a stored marker as ownership, recording it on a row that records nothing else', async () => {
    for (const app of [undefined, { ...APP, appId: OTHER_APP }]) {
      const stored = new Map([
        ['marker-only', material(MSTEAMS_DEPLOYMENT_SECRET_MARKER)],
        ['own', material('own-secret-example')]
      ])
      const own = '00000000-0000-4000-8000-0000000000a3'
      const { reconciler, merged, install, resync } = reconcilerOver(
        [row('marker-only'), row('own', { externalAppId: own })],
        stored,
        app
      )
      expect(await reconciler.run()).toBe(1)
      expect(merged.get('marker-only')).toEqual({ [MSTEAMS_ROW_OWNER_KEY]: MSTEAMS_DEPLOYMENT_OWNER })
      expect(install).not.toHaveBeenCalled()
      expect(resync).toHaveBeenCalledWith('marker-only')
      expect(merged.has('own')).toBe(false)
    }
  })

  it('purges a historical row with no app configured, or with the app since replaced', async () => {
    for (const app of [undefined, { ...APP, appId: OTHER_APP }]) {
      const stored = new Map([['old', material(APP.clientSecret)]])
      const { reconciler, resync } = reconcilerOver(
        [row('old', { prebuilt: true, platformConfig: { tokenTenantId: APP.tenantId } })],
        stored,
        app
      )
      expect(await reconciler.run()).toBe(1)
      expect(stored.get('old')).toEqual(material(MSTEAMS_DEPLOYMENT_SECRET_MARKER))
      expect(resync).toHaveBeenCalledWith('old')
    }
  })
})

describe('the relay’s deployment app', () => {
  it('carries a ticket key derived from the pepper, stable and distinct per pepper', () => {
    const pepper = 'p'.repeat(32)
    const relayApp = msTeamsRelayApp(APP, pepper)!
    expect(relayApp).toEqual({ ...APP, ticketKey: msTeamsRelayTicketKey(pepper) })
    expect(Buffer.from(relayApp.ticketKey, 'base64url')).toHaveLength(32)
    expect(msTeamsRelayTicketKey('q'.repeat(32))).not.toBe(relayApp.ticketKey)
    expect(msTeamsRelayApp(undefined, pepper)).toBeUndefined()
  })
})
