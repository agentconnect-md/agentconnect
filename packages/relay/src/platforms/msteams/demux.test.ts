// Core's demux over Teams bots (teams-integration.md §3): the token's audience and the activity's tenant pick the row, the token decides, and a miss is the route's 401.
import { describe, expect, it, vi } from 'vitest'
import type { RcThreadLookupOk } from '@agentconnect.md/protocol'
import { FakeClock } from '@agentconnect.md/connection'
import { RelayIngressManager, type RelayIngressManagerDeps } from '../../relay-ingress-manager.js'
import { createMsTeamsIngressPlugin, type MsTeamsIngressPlugin } from './ingress-plugin.js'
import type { DemuxIndex } from '../registry.js'
import type { BotAssignment } from '../../bot-arbitration.js'
import { NOW, bearer, fakeBotFramework, type TokenOver } from '../../../test/fixtures/msteams-token.js'
import {
  APP_ID,
  OTHER_APP_ID,
  OTHER_TENANT,
  TENANT,
  cardClick,
  edit,
  personalText
} from '../../../test/fixtures/msteams-activities.js'

const ROW_A = '22222222-2222-4222-8222-222222222222'
const ROW_B = '33333333-3333-4333-8333-333333333333'
const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const deps = (): RelayIngressManagerDeps => ({
  getDaemon: () => undefined,
  setChannelAgent: vi.fn(),
  reportBotChannels: vi.fn(() => true),
  reportBotConversation: vi.fn(() => true),
  reportNoticePosted: vi.fn(() => true),
  reportBotRevoked: vi.fn(async () => true),
  reportBotCredentialCheck: vi.fn(async () => true),
  credentialCheckSupported: () => true,
  reportBotTenant: vi.fn(async () => true),
  tenantReportSupported: () => true,
  selfRelayId: () => '88888888-8888-4888-8888-888888888881',
  reportThreadAssign: vi.fn(() => true),
  reportThreadParticipant: vi.fn(() => true),
  lookupThread: vi.fn(
    async () => ({ botId: ROW_A, sessionKey: '', target: null, participants: [] }) as RcThreadLookupOk
  ),
  isAgentBotApp: vi.fn(() => false),
  admitsAgentCall: vi.fn(() => true),
  clock: new FakeClock(NOW),
  log: silent
})

const row = (botId: string, over: Partial<BotAssignment> = {}): BotAssignment => ({
  botId,
  platform: 'msteams',
  secrets: {},
  apiAppId: APP_ID,
  teamId: TENANT,
  credentialRevision: 1,
  members: [],
  agents: [],
  routes: [],
  ...over
})

/** The manager over the real plugin, whose `handle` is observed and stubbed: this suite is about which row verifies. */
function setup() {
  const plugin = createMsTeamsIngressPlugin({ fetch: fakeBotFramework().fetchImpl })
  const handledBy: string[] = []
  const observed: MsTeamsIngressPlugin = {
    ...plugin,
    handle: async (ingest) => {
      handledBy.push(ingest.botId)
      return { admission: { disposition: 'admitted' } }
    }
  }
  const manager = new RelayIngressManager(deps(), [observed])
  const demux = (manager as unknown as { ingressPlugins: Map<string, { demux: DemuxIndex }> }).ingressPlugins.get(
    'msteams'
  )!.demux
  const deliver = async (activity: unknown, over: TokenOver = {}) => {
    const raw = Buffer.from(JSON.stringify(activity))
    handledBy.length = 0
    const handled = await manager.handleInbound('msteams', raw, JSON.parse(raw.toString('utf8')), {
      authorization: await bearer(over)
    })
    return { handled, by: handledBy[0] }
  }
  return { manager, demux, deliver }
}

const inTenant = (activity: unknown, tenant: string) =>
  edit(activity, (a) => {
    a.channelData.tenant.id = tenant
    a.conversation.tenantId = tenant
  })

describe('msteams demux (§3)', () => {
  it('indexes a row on the composite (app ID, tenant) and routes its messages and clicks to it', async () => {
    const { manager, demux, deliver } = setup()
    await manager.assign(row(ROW_A))
    expect(demux.indexes.byAppTenant.get(`${APP_ID}\0${TENANT}`)).toBe(ROW_A)
    expect(demux.indexes.byApp.size).toBe(0)
    expect(await deliver(personalText)).toEqual({ handled: { admission: { disposition: 'admitted' } }, by: ROW_A })
    expect((await deliver(cardClick)).by).toBe(ROW_A)
  })

  it('routes each of two bots by the audience its token names', async () => {
    const { manager, deliver } = setup()
    await manager.assign(row(ROW_A))
    await manager.assign(row(ROW_B, { apiAppId: OTHER_APP_ID }))
    expect((await deliver(personalText)).by).toBe(ROW_A)
    const toB = edit(personalText, (a) => (a.recipient.id = `28:${OTHER_APP_ID}`))
    expect((await deliver(toB, { aud: OTHER_APP_ID })).by).toBe(ROW_B)
  })

  it('answers nobody (the 401) for an unassigned app, another tenant, a tenant-less activity, or a failed token', async () => {
    const { manager, deliver } = setup()
    await manager.assign(row(ROW_A))
    const unowned = [
      await deliver(personalText, { aud: OTHER_APP_ID }),
      // The same app's token for another tenant: the strict fence refuses the row before its token is even checked.
      await deliver(inTenant(personalText, OTHER_TENANT)),
      await deliver(edit(personalText, (a) => (delete a.channelData, delete a.conversation.tenantId))),
      await deliver(personalText, { iss: `https://sts.windows.net/${TENANT}/` }),
      await deliver(personalText, { serviceurl: 'https://smba.trafficmanager.net/emea/example/' })
    ]
    for (const result of unowned) expect(result).toEqual({ handled: undefined, by: undefined })
  })

  it('stops serving a row once it is unassigned', async () => {
    const { manager, demux, deliver } = setup()
    await manager.assign(row(ROW_A))
    await manager.unassign(ROW_A)
    expect(demux.indexes.byAppTenant.size).toBe(0)
    expect((await deliver(personalText)).handled).toBeUndefined()
  })
})
