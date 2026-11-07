// The boot pass that takes the deployment app's secret off its rows (teams-integration.md §8.5).
import { describe, expect, it, vi } from 'vitest'
import { BotId, OrgId } from '../../domain/ids.js'
import type { BotRecord, BotSecretMaterial } from '../../persistence/ports.js'
import { MsTeamsCredentialReconciler } from './credential-reconciler.js'
import { MSTEAMS_DEPLOYMENT_SECRET_MARKER, msTeamsRelayApp, msTeamsRelayTicketKey } from './deployment-app.js'

const APP = {
  appId: '00000000-0000-4000-8000-0000000000a1',
  tenantId: '00000000-0000-4000-8000-0000000000ff',
  clientSecret: 'deployment-secret-example'
}
const ORG = OrgId('org-1')

const row = (id: string, externalAppId: string) =>
  ({ id: BotId(id), orgId: ORG, externalAppId, platformConfig: null }) as unknown as BotRecord
const material = (botToken: string): BotSecretMaterial => ({ botToken, appToken: null, signingSecret: null })

describe('MsTeamsCredentialReconciler', () => {
  it('replaces a stored deployment secret with the marker and re-syncs only those rows', async () => {
    const stored = new Map<string, BotSecretMaterial>([
      ['stamped', material(APP.clientSecret)],
      ['purged', material(MSTEAMS_DEPLOYMENT_SECRET_MARKER)],
      ['own', material('own-secret-example')]
    ])
    const install = vi.fn(async (_org: unknown, botId: string, m: BotSecretMaterial) => {
      stored.set(botId, m)
      return 1
    })
    const resync = vi.fn(async () => {})
    const reconciler = new MsTeamsCredentialReconciler({
      bots: {
        listForPlatform: async () => [
          row('stamped', APP.appId),
          row('purged', APP.appId),
          row('own', '00000000-0000-4000-8000-0000000000a2')
        ]
      },
      secrets: { get: async (_org, botId) => stored.get(botId) ?? null },
      credentials: { install } as never,
      resync,
      app: APP,
      clock: { now: () => 0 } as never
    })
    expect(await reconciler.run()).toBe(1)
    expect(stored.get('stamped')).toEqual(material(MSTEAMS_DEPLOYMENT_SECRET_MARKER))
    expect(stored.get('own')).toEqual(material('own-secret-example'))
    expect(resync).toHaveBeenCalledTimes(1)
    expect(resync).toHaveBeenCalledWith('stamped')
    // A second boot finds nothing to move.
    expect(await reconciler.run()).toBe(0)
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
