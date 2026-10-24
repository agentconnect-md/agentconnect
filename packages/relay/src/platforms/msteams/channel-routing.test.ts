// A Teams channel message through the real plugin and arbitration: the assignment's `28:` identity is what makes a mention address the bot (teams-integration.md §4.1).
import { describe, expect, it, vi } from 'vitest'
import type { RcBotAssign, RcThreadLookupOk, RdAck, RdMsg } from '@agentconnect.md/protocol'
import { FakeClock } from '@agentconnect.md/connection'
import { RelayIngressManager, type RelayIngressManagerDeps } from '../../relay-ingress-manager.js'
import type { RelayDaemonConnection } from '../../relay-daemon-connection.js'
import { toBotAssignment } from '../../bot-arbitration.js'
import { createMsTeamsIngressPlugin } from './ingress-plugin.js'
import { NOW, bearer, fakeBotFramework } from '../../../test/fixtures/msteams-token.js'
import {
  APP_ID,
  BOT_ID,
  CHANNEL,
  ROOT,
  TENANT,
  channelMention,
  channelReply,
  edit
} from '../../../test/fixtures/msteams-activities.js'

const ROW = '22222222-2222-4222-8222-222222222222'
const AGENT_ID = '44444444-4444-4444-8444-444444444444'
const DAEMON_ID = '33333333-3333-4333-8333-333333333333'
const INTEGRATION_ID = '66666666-6666-4666-8666-666666666666'
const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/** The frame the CP sends for a Teams bot with one bound agent: an ungated default, or a gated agent with no enabled place; `off` marks the channel undecided or operator Off. */
function frame(gated: boolean, off?: 'undecided' | 'operator'): RcBotAssign {
  return {
    botId: ROW,
    platform: 'msteams',
    credentialRevision: 1,
    secrets: {},
    ingress: { apiAppId: APP_ID, botUserId: BOT_ID, teamId: TENANT },
    members: [{ daemonId: DAEMON_ID, agentIds: [AGENT_ID] }],
    agents: [{ agentId: AGENT_ID, name: 'Agent', daemonId: DAEMON_ID, integrationId: INTEGRATION_ID }],
    routes: gated
      ? []
      : [
          {
            agentId: AGENT_ID,
            daemonId: DAEMON_ID,
            integrationId: INTEGRATION_ID,
            match: { kind: 'keyword', value: 'agent' }
          }
        ],
    ...(gated ? {} : { defaultAgentId: AGENT_ID, defaultDaemonId: DAEMON_ID }),
    gatedAgentIds: gated ? [AGENT_ID] : [],
    mutedChannels: off ? [CHANNEL] : [],
    gatedOffChannels: off === 'undecided' ? [CHANNEL] : [],
    noticedDmConversations: [],
    conversationDefaults: [],
    ownerAsDefault: false,
    routedConversations: []
  } as RcBotAssign
}

async function setup(gated: boolean, off?: 'undecided' | 'operator') {
  const sendMsg = vi.fn(async (m: RdMsg): Promise<RdAck> => ({ msgId: m.msgId, accepted: true }))
  const daemon = { sendMsg, supports: () => true } as unknown as RelayDaemonConnection
  const deps: RelayIngressManagerDeps = {
    getDaemon: (id) => (id === DAEMON_ID ? daemon : undefined),
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
      async () => ({ botId: ROW, sessionKey: '', target: null, participants: [] }) as RcThreadLookupOk
    ),
    isAgentBotApp: vi.fn(() => false),
    admitsAgentCall: vi.fn(() => true),
    clock: new FakeClock(NOW),
    log: silent
  }
  const manager = new RelayIngressManager(deps, [createMsTeamsIngressPlugin({ fetch: fakeBotFramework().fetchImpl })])
  await manager.assign(toBotAssignment(frame(gated, off))!)
  const deliver = async (activity: unknown) => {
    const raw = Buffer.from(JSON.stringify(activity))
    sendMsg.mockClear()
    await manager.handleInbound('msteams', raw, JSON.parse(raw.toString('utf8')), { authorization: await bearer() })
    return sendMsg.mock.calls.map(([m]) => m as RdMsg & { agentId?: string; payload?: { channel?: string } })
  }
  return { deliver }
}

const mentionedReply = edit(channelMention, (a) => (a.id = '1767225630000'))
const upperCased = edit(channelMention, (a) => {
  a.id = '1767225640000'
  a.recipient.id = BOT_ID.toUpperCase()
  a.entities[0].mentioned.id = BOT_ID.toUpperCase()
})

describe('msteams channel routing', () => {
  it('forwards a mention in a new channel, as a post or a thread reply, to the default agent', async () => {
    const { deliver } = await setup(false)
    for (const activity of [channelMention, mentionedReply, upperCased]) {
      const sent = await deliver(activity)
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({ agentId: AGENT_ID, payload: { channel: CHANNEL, thread: ROOT } })
    }
  })

  it('hands a mention in a place nobody enabled to the sole gated agent', async () => {
    const { deliver } = await setup(true)
    expect((await deliver(channelMention)).map((m) => m.agentId)).toEqual([AGENT_ID])
  })

  it('hands a mention in an undecided Off channel to the ungated agent, whose daemon posts the notice', async () => {
    const { deliver } = await setup(false, 'undecided')
    expect((await deliver(channelMention)).map((m) => m.agentId)).toEqual([AGENT_ID])
    expect(await deliver(channelReply)).toEqual([])
  })

  it('forwards nothing in a channel an operator turned Off', async () => {
    const { deliver } = await setup(false, 'operator')
    expect(await deliver(channelMention)).toEqual([])
  })

  it('forwards no unmentioned message in a channel with no row', async () => {
    const { deliver } = await setup(false)
    expect(await deliver(channelReply)).toEqual([])
    expect(await deliver(edit(channelMention, (a) => (a.entities = [{ type: 'clientInfo' }])))).toEqual([])
  })
})
