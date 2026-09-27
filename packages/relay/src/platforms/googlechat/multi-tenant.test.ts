// Core's demux over a multi-tenant Google Chat app (google-chat-integration.md §10.4): one audience, an anchor that
// carries the claim page, and customer rows known by their tenant keys. The plugin's own answers have their suite.
import { describe, expect, it, vi } from 'vitest'
import type { RcThreadLookupOk } from '@agentconnect.md/protocol'
import { FakeClock } from '@agentconnect.md/connection'
import { RelayIngressManager, type RelayIngressManagerDeps } from '../../relay-ingress-manager.js'
import { createGoogleChatIngressPlugin, type GoogleChatIngressPlugin } from './ingress-plugin.js'
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
  spaceMention
} from '../../../test/fixtures/google-chat-events.js'

const ANCHOR = '11111111-1111-4111-8111-111111111111'
const ROW_A = '22222222-2222-4222-8222-222222222222'
const ROW_B = '33333333-3333-4333-8333-333333333333'
const CLAIM_URL = 'https://console.example.test/googlechat/claim'
const OTHER_CUSTOMER = 'customers/C0000000002'
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
  selfRelayId: () => '88888888-8888-4888-8888-888888888881',
  reportThreadAssign: vi.fn(() => true),
  reportThreadParticipant: vi.fn(() => true),
  lookupThread: vi.fn(
    async () => ({ botId: ANCHOR, sessionKey: '', target: null, participants: [] }) as RcThreadLookupOk
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
  const manager = new RelayIngressManager(deps(), [observed])
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
  return { manager, demux, deliver }
}

const unknownDomainAdd = { ...dmAdded, user: { ...dmAdded.user, domainId: '0000000009' } }
const otherCustomerMention = { ...spaceMention, space: { ...spaceMention.space, customer: OTHER_CUSTOMER } }

describe('googlechat multi-tenant demux (§10.4)', () => {
  it('routes each tenant to the customer row that knows it and every other tenant to the anchor', async () => {
    const { manager, demux, deliver } = setup()
    await manager.assign(row(ANCHOR, { claimUrl: CLAIM_URL }))
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
    const added = await deliver(unknownDomainAdd)
    expect(added.by).toBe(ANCHOR)
    expect(added.handled).toEqual({ syncResponse: GOOGLE_CHAT_WELCOME_CARD })
    // A row's key is in that row's composite entries alone; the anchor stays the only app-only entry.
    expect(demux.indexes.byApp.size).toBe(1)
    // Another audience owns none of it.
    expect((await deliver(dmMessage, '200000000000')).handled).toBeUndefined()
  })

  it('releases a tenant to the anchor when its row is unassigned, and re-fences it when re-assigned', async () => {
    const { manager, deliver } = setup()
    await manager.assign(row(ANCHOR, { claimUrl: CLAIM_URL }))
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

  it("a single-tenant deployment's one row keeps serving every tenant, including one naming none", async () => {
    const { manager, deliver } = setup()
    await manager.assign(row(ANCHOR))
    for (const event of [dmMessage, spaceMention, otherCustomerMention, cardClicked, unknownDomainAdd]) {
      expect((await deliver(event)).by).toBe(ANCHOR)
    }
    const personal = { ...dmMessage, user: { ...dmMessage.user, domainId: undefined } }
    expect((await deliver(personal)).by).toBe(ANCHOR)
  })
})
