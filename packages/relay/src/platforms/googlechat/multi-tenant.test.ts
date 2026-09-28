// Core's demux over the deployment Google Chat app (google-chat-integration.md §10.4): one audience, the anchor the CP's snapshot names, and customer rows known by their tenant keys.
import { describe, expect, it, vi } from 'vitest'
import type { RcDeploymentConfig, RcThreadLookupOk } from '@agentconnect.md/protocol'
import { FakeClock } from '@agentconnect.md/connection'
import { RelayIngressManager, type RelayIngressManagerDeps } from '../../relay-ingress-manager.js'
import {
  GOOGLE_CHAT_ANCHOR_BOT_ID,
  createGoogleChatIngressPlugin,
  type GoogleChatIngressPlugin
} from './ingress-plugin.js'
import { GOOGLE_CHAT_WELCOME_CARD } from './http-ingest.js'
import type { DemuxIndex } from '../registry.js'
import type { BotAssignment } from '../../bot-arbitration.js'
import { NOW, fakeCertificates, token } from '../../../test/fixtures/google-chat-token.js'
import {
  AUDIENCE,
  CUSTOMER,
  DOMAIN,
  cardClicked,
  dmAdded,
  dmMessage,
  spaceAddedByMention,
  spaceMention
} from '../../../test/fixtures/google-chat-events.js'

const ANCHOR = GOOGLE_CHAT_ANCHOR_BOT_ID
const SINGLE = '11111111-1111-4111-8111-111111111111'
const ROW_A = '22222222-2222-4222-8222-222222222222'
const ROW_B = '33333333-3333-4333-8333-333333333333'
const CLAIM_URL = 'https://console.example.test/googlechat/claim'
const OTHER_CUSTOMER = 'customers/C0000000002'
const OTHER_AUDIENCE = '200000000000'
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
  platform: 'googlechat',
  secrets: {},
  apiAppId: AUDIENCE,
  credentialRevision: 1,
  members: [],
  agents: [],
  routes: [],
  ...over
})

/** The snapshot a CP sends on authentication when the deployment app and the console URL are configured. */
const snapshot = (projectNumber = AUDIENCE, claimUrl = CLAIM_URL): RcDeploymentConfig => ({
  revision: 1,
  googleChatAnchor: { projectNumber, claimUrl }
})

/** The manager over the real plugin, whose `handle` is observed: the anchor's runs for real, a customer row's is stubbed. */
function setup() {
  const plugin = createGoogleChatIngressPlugin({ fetch: fakeCertificates().fetchImpl })
  const handledBy: string[] = []
  const observed: GoogleChatIngressPlugin = {
    ...plugin,
    handle: async (ingest, verified, host) => {
      handledBy.push(ingest.botId)
      return ingest.claimUrl ? plugin.handle(ingest, verified, host) : { admission: { disposition: 'admitted' } }
    }
  }
  const d = deps()
  const manager = new RelayIngressManager(d, [observed])
  const demux = (manager as unknown as { ingressPlugins: Map<string, { demux: DemuxIndex }> }).ingressPlugins.get(
    'googlechat'
  )!.demux
  const deliver = async (event: unknown, aud?: string) => {
    const raw = Buffer.from(JSON.stringify(event))
    const body: unknown = JSON.parse(raw.toString('utf8'))
    handledBy.length = 0
    const handled = await manager.handleInbound('googlechat', raw, body, {
      authorization: `Bearer ${await token(aud ? { aud } : {})}`
    })
    return { handled, by: handledBy[0] }
  }
  return { manager, demux, deliver, deps: d }
}

const unknownDomainAdd = { ...dmAdded, user: { ...dmAdded.user, domainId: '0000000009' } }
const otherCustomerMention = { ...spaceMention, space: { ...spaceMention.space, customer: OTHER_CUSTOMER } }
const promptUrl = (handled: unknown) =>
  new URL((handled as { syncResponse: { actionResponse: { url: string } } }).syncResponse.actionResponse.url)

describe('googlechat multi-tenant demux (§10.4)', () => {
  it('routes each tenant to the customer row that knows it and every other tenant to the snapshot’s anchor', async () => {
    const { manager, demux, deliver } = setup()
    await manager.applyDeploymentSnapshot(snapshot())
    await manager.assign(row(ROW_A, { tenantIds: [CUSTOMER] }))
    await manager.assign(row(ROW_B, { tenantIds: [DOMAIN] }))
    expect(demux.indexes.byApp.get(AUDIENCE)).toBe(ANCHOR)
    expect(demux.indexes.byAppTenant.size).toBe(2)

    expect((await deliver(spaceMention)).by).toBe(ROW_A)
    expect((await deliver(cardClicked)).by).toBe(ROW_A)
    expect((await deliver(dmMessage)).by).toBe(ROW_B)
    // A tenant no row knows reaches the anchor, which answers in the body through the seam.
    const unclaimed = await deliver(otherCustomerMention)
    expect(unclaimed.by).toBe(ANCHOR)
    expect(unclaimed.handled).toMatchObject({ syncResponse: { actionResponse: { type: 'REQUEST_CONFIG' } } })
    expect(unclaimed.handled).not.toHaveProperty('admission')
    expect(promptUrl(unclaimed.handled).origin + promptUrl(unclaimed.handled).pathname).toBe(CLAIM_URL)
    const added = await deliver(unknownDomainAdd)
    expect(added.by).toBe(ANCHOR)
    expect(added.handled).toEqual({ syncResponse: GOOGLE_CHAT_WELCOME_CARD })
    // A row's key is in that row's composite entries alone; the anchor stays the only app-only entry.
    expect(demux.indexes.byApp.size).toBe(1)
    // Another audience owns none of it.
    expect((await deliver(dmMessage, OTHER_AUDIENCE)).handled).toBeUndefined()
  })

  it('applies, replaces, and removes the anchor as each registration’s snapshot says', async () => {
    const { manager, demux, deliver } = setup()
    // No anchor yet: an unclaimed tenant has no owner, and the route answers 401.
    expect((await deliver(otherCustomerMention)).handled).toBeUndefined()

    await manager.applyDeploymentSnapshot(snapshot())
    expect((await deliver(otherCustomerMention)).by).toBe(ANCHOR)

    // A changed console URL is the next registration's prompt.
    const moved = 'https://console-2.example.test/googlechat/claim'
    await manager.applyDeploymentSnapshot(snapshot(AUDIENCE, moved))
    expect(promptUrl((await deliver(otherCustomerMention)).handled).origin).toBe('https://console-2.example.test')

    // A changed app moves the anchor to the new audience and releases the old one.
    await manager.applyDeploymentSnapshot(snapshot(OTHER_AUDIENCE))
    expect(demux.indexes.byApp.get(AUDIENCE)).toBeUndefined()
    expect(demux.indexes.byApp.get(OTHER_AUDIENCE)).toBe(ANCHOR)
    expect((await deliver(otherCustomerMention)).handled).toBeUndefined()
    expect((await deliver(otherCustomerMention, OTHER_AUDIENCE)).by).toBe(ANCHOR)

    // A snapshot without the anchor, or none at all, removes it.
    await manager.applyDeploymentSnapshot({ revision: 2 })
    expect(demux.indexes.byApp.size).toBe(0)
    expect((await deliver(otherCustomerMention, OTHER_AUDIENCE)).handled).toBeUndefined()
    await manager.applyDeploymentSnapshot(snapshot())
    await manager.applyDeploymentSnapshot(undefined)
    expect(demux.indexes.byApp.size).toBe(0)
  })

  it('reports nothing to the CP about the anchor, whatever the unclaimed tenant sends', async () => {
    const { manager, deliver, deps: d } = setup()
    await manager.applyDeploymentSnapshot(snapshot())
    for (const event of [spaceAddedByMention, spaceMention, dmAdded, cardClicked, dmMessage]) {
      expect((await deliver(event)).by).toBe(ANCHOR)
    }
    for (const report of [
      d.reportBotChannels,
      d.reportBotConversation,
      d.reportBotTenant,
      d.reportBotRevoked,
      d.reportBotCredentialCheck,
      d.reportThreadAssign,
      d.reportThreadParticipant,
      d.setChannelAgent
    ])
      expect(report).not.toHaveBeenCalled()
  })

  it('releases a tenant to the anchor when its row is unassigned, and re-fences it when re-assigned', async () => {
    const { manager, deliver } = setup()
    await manager.applyDeploymentSnapshot(snapshot())
    await manager.assign(row(ROW_A, { tenantIds: [CUSTOMER] }))
    expect((await deliver(spaceMention)).by).toBe(ROW_A)
    await manager.unassign(ROW_A)
    const released = await deliver(spaceMention)
    expect(released.by).toBe(ANCHOR)
    expect(released.handled).toMatchObject({ syncResponse: { actionResponse: { type: 'REQUEST_CONFIG' } } })
    // The row comes back knowing both of the customer's keys.
    await manager.assign(row(ROW_A, { tenantIds: [CUSTOMER, DOMAIN] }))
    expect((await deliver(spaceMention)).by).toBe(ROW_A)
    expect((await deliver(dmMessage)).by).toBe(ROW_A)
  })

  it('never serves a customer row to another tenant through the scan, and never learns it app-only', async () => {
    const { manager, demux, deliver } = setup()
    // No anchor, and the composite entries dropped: both rows verify the same tokens, so the fence alone decides.
    await manager.assign(row(ROW_A, { tenantIds: [CUSTOMER] }))
    await manager.assign(row(ROW_B, { tenantIds: [DOMAIN] }))
    demux.forget(ROW_A)
    demux.forget(ROW_B)
    expect((await deliver(dmMessage)).by).toBe(ROW_B)
    expect((await deliver(spaceMention)).by).toBe(ROW_A)
    expect(demux.indexes.byApp.size).toBe(0)
    // A tenant nobody knows, with no anchor to fall to, is nobody's: the route answers 401.
    expect((await deliver(otherCustomerMention)).handled).toBeUndefined()
    // A delivery naming no tenant has no safe owner among tenant-scoped rows either.
    const personal = { ...dmMessage, user: { ...dmMessage.user, domainId: undefined } }
    expect((await deliver(personal)).handled).toBeUndefined()
  })

  it('keeps a single-tenant row with recorded own keys app-only: core routes every tenant to it and the plugin fences', async () => {
    const { manager, demux, deliver } = setup()
    await manager.assign(row(SINGLE, { ownTenantIds: [CUSTOMER, DOMAIN] }))
    expect(demux.indexes.byApp.get(AUDIENCE)).toBe(SINGLE)
    expect(demux.indexes.byAppTenant.size).toBe(0)
    for (const event of [dmMessage, spaceMention, otherCustomerMention, unknownDomainAdd]) {
      expect((await deliver(event)).by).toBe(SINGLE)
    }
  })

  it('an own app’s one row keeps serving every tenant, including one naming none', async () => {
    const { manager, deliver } = setup()
    await manager.assign(row(SINGLE))
    for (const event of [dmMessage, spaceMention, otherCustomerMention, cardClicked, unknownDomainAdd]) {
      expect((await deliver(event)).by).toBe(SINGLE)
    }
    const personal = { ...dmMessage, user: { ...dmMessage.user, domainId: undefined } }
    expect((await deliver(personal)).by).toBe(SINGLE)
  })
})
