import { describe, expect, it, vi } from 'vitest'
import type {
  RdAck,
  RdMsgSlackAction,
  RcBotChannels,
  RcThreadAssign,
  RcThreadLookupOk,
  WireNormalizedMessage
} from '@agentconnect.md/protocol'
import { FakeClock } from '@agentconnect.md/connection'
import { SharedBotManager, type SharedBotManagerDeps, sharedSlackActionMsgId } from './shared-bot-manager.js'
import { SharedBotRouter, type BotAssignment } from './shared-bot-router.js'
import type { SharedSlackSessionAction } from './slack-shared-ingest.js'
import type { RelayDaemonConnection } from './relay-daemon-connection.js'
import type { Logger } from './log.js'

const BOT_ID = '11111111-1111-4111-8111-111111111111'
const DAEMON_ID = '22222222-2222-4222-8222-222222222222'
const AGENT_ID = '33333333-3333-4333-8333-333333333333'
const INTEGRATION_ID = '44444444-4444-4444-8444-444444444444'
const OTHER_DAEMON_ID = '55555555-5555-4555-8555-555555555555'
const OTHER_AGENT_ID = '66666666-6666-4666-8666-666666666666'
const OTHER_INTEGRATION_ID = '77777777-7777-4777-8777-777777777777'
const SESSION_KEY = 'slack:C123:1720000000.000100:agent'
const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/** Manager deps with the required affinity + clock stubs, overridable per test. */
const deps = (over: Partial<SharedBotManagerDeps> = {}): SharedBotManagerDeps => ({
  getDaemon: () => undefined,
  setChannelAgent: vi.fn(),
  reportBotChannels: vi.fn(() => true),
  reportBotConversation: vi.fn(() => true),
  reportThreadAssign: vi.fn(() => true),
  lookupThread: vi.fn(async () => ({ botId: BOT_ID, sessionKey: '', target: null }) as RcThreadLookupOk),
  isAgentBotApp: vi.fn(() => false),
  clock: new FakeClock(),
  log: silentLog,
  ...over
})

const assignment = (): BotAssignment => ({
  botId: BOT_ID,
  platform: 'slack',
  secrets: { botToken: 'xoxb', signingSecret: 'ssecret' },
  members: [{ daemonId: DAEMON_ID, agentIds: [AGENT_ID] }],
  agents: [{ agentId: AGENT_ID, name: 'Agent' }],
  routes: [
    {
      agentId: AGENT_ID,
      daemonId: DAEMON_ID,
      integrationId: INTEGRATION_ID,
      match: { kind: 'keyword', value: 'agent' }
    }
  ]
})

const action = (over: Partial<SharedSlackSessionAction> = {}): SharedSlackSessionAction =>
  ({
    target: { v: 1, agentId: AGENT_ID, integrationId: INTEGRATION_ID, sessionKey: SESSION_KEY },
    interactionId: JSON.stringify(['ac_set_model', '1720000000.000200']),
    kind: 'set-model',
    model: 'opus-4.8',
    ...over
  }) as SharedSlackSessionAction

interface ManagerInternals {
  router: SharedBotRouter
  ingests: Map<
    string,
    {
      lookupUserName(u: string): Promise<string | undefined>
      postText(c: string, t: string, th?: string): Promise<void>
    }
  >
  reportChannels(snapshot: RcBotChannels): void
  selectThreadAgent(botId: string, channelId: string, threadTs: string, agentId: string): void
  forwardSessionAction(botId: string, action: SharedSlackSessionAction): void
  forward(botId: string, msg: WireNormalizedMessage, meta?: { noticeEligible?: boolean }): Promise<void>
}

describe('SharedBotManager shared Slack session actions', () => {
  it('rebinds the current thread immediately when the inline selector changes agent', () => {
    const setChannelAgent = vi.fn()
    const reportThreadAssign = vi.fn(() => true)
    const manager = new SharedBotManager(deps({ setChannelAgent, reportThreadAssign }))
    const internals = manager as unknown as ManagerInternals
    const assigned = assignment()
    assigned.members.push({ daemonId: OTHER_DAEMON_ID, agentIds: [OTHER_AGENT_ID] })
    assigned.agents.push({ agentId: OTHER_AGENT_ID, name: 'Review Agent' })
    assigned.routes.push({
      agentId: OTHER_AGENT_ID,
      daemonId: OTHER_DAEMON_ID,
      integrationId: OTHER_INTEGRATION_ID,
      match: { kind: 'keyword', value: 'review' }
    })
    assigned.routes.push({
      agentId: AGENT_ID,
      daemonId: DAEMON_ID,
      integrationId: INTEGRATION_ID,
      scope: { channel: 'C123' },
      match: { kind: 'auto' }
    })
    internals.router.upsert(assigned)
    internals.router.setAffinity(BOT_ID, 'C123/T1', {
      agentId: AGENT_ID,
      daemonId: DAEMON_ID,
      integrationId: INTEGRATION_ID
    })

    internals.selectThreadAgent(BOT_ID, 'C123', 'T1', OTHER_AGENT_ID)

    const followUp: WireNormalizedMessage = {
      msgId: 'm-2',
      traceId: 't-2',
      source: 'user',
      platform: 'slack',
      channel: 'C123',
      thread: 'T1',
      sender: { id: 'U1', isBot: false },
      text: 'who are you now?',
      mentionedBots: [],
      isDm: false
    }
    expect(internals.router.route(BOT_ID, followUp)?.agentId).toBe(OTHER_AGENT_ID)
    expect(internals.router.channelOwner(BOT_ID, 'C123')).toBe(OTHER_AGENT_ID)
    expect(setChannelAgent).toHaveBeenCalledWith(BOT_ID, 'C123', OTHER_AGENT_ID)
    // The explicit Switch-agent is reported to the CP (report leg of the affinity dance).
    expect(reportThreadAssign).toHaveBeenCalledWith(
      expect.objectContaining({ botId: BOT_ID, sessionKey: 'C123/T1', agentId: OTHER_AGENT_ID })
    )
  })

  it('forwards to the exact current agent+integration with a stable redelivery msgId', () => {
    const sendMsg = vi.fn(async (msg: RdMsgSlackAction): Promise<RdAck> => ({ msgId: msg.msgId, accepted: true }))
    const daemon = { sendMsg } as unknown as RelayDaemonConnection
    const manager = new SharedBotManager(
      deps({ getDaemon: (daemonId) => (daemonId === DAEMON_ID ? daemon : undefined) })
    )
    const internals = manager as unknown as ManagerInternals
    internals.router.upsert(assignment())

    const delivered = action()
    internals.forwardSessionAction(BOT_ID, delivered)
    internals.forwardSessionAction(BOT_ID, delivered) // Socket Mode redelivery

    expect(sendMsg).toHaveBeenCalledTimes(2)
    const first = sendMsg.mock.calls[0]![0]
    const second = sendMsg.mock.calls[1]![0]
    expect(first).toEqual({
      source: 'slack_action',
      agentId: AGENT_ID,
      integrationId: INTEGRATION_ID,
      sessionKey: SESSION_KEY,
      msgId: sharedSlackActionMsgId(BOT_ID, delivered),
      botId: BOT_ID,
      payload: { kind: 'set-model', model: 'opus-4.8' }
    })
    expect(second.msgId).toBe(first.msgId)
    expect(first.msgId).toMatch(/^slack-action:[a-f0-9]{64}$/)
  })

  it('forwards the tapping user, and omits it entirely when the interaction named none', () => {
    const sendMsg = vi.fn(async (msg: RdMsgSlackAction): Promise<RdAck> => ({ msgId: msg.msgId, accepted: true }))
    const daemon = { sendMsg } as unknown as RelayDaemonConnection
    const manager = new SharedBotManager(
      deps({ getDaemon: (daemonId) => (daemonId === DAEMON_ID ? daemon : undefined) })
    )
    const internals = manager as unknown as ManagerInternals
    internals.router.upsert(assignment())

    const attributed = action({ userId: 'U-ALICE' })
    internals.forwardSessionAction(BOT_ID, attributed)
    internals.forwardSessionAction(BOT_ID, action())

    const [withUser, withoutUser] = sendMsg.mock.calls.map((c) => c[0])
    expect(withUser!.userId).toBe('U-ALICE')
    // The frame must carry no key at all rather than an empty/guessed actor.
    expect(withoutUser).not.toHaveProperty('userId')
    // The actor is not part of the interaction's identity, so dedup is unchanged.
    expect(withUser!.msgId).toBe(withoutUser!.msgId)
    // …and it never leaks into the verb payload.
    expect(withUser!.payload).toEqual({ kind: 'set-model', model: 'opus-4.8' })
  })

  it('uses distinct ids for distinct selected values even if receipt metadata is reused', () => {
    expect(sharedSlackActionMsgId(BOT_ID, action({ model: 'opus-4.8' }))).not.toBe(
      sharedSlackActionMsgId(BOT_ID, action({ model: 'sonnet-5' }))
    )
  })

  it('uses distinct ids for two real clicks with different Slack action timestamps', () => {
    expect(
      sharedSlackActionMsgId(BOT_ID, action({ interactionId: JSON.stringify(['ac_set_model', '1720000000.000200']) }))
    ).not.toBe(
      sharedSlackActionMsgId(BOT_ID, action({ interactionId: JSON.stringify(['ac_set_model', '1720000000.000201']) }))
    )
  })

  it('rejects a tampered/stale target instead of falling back to the channel owner', () => {
    const sendMsg = vi.fn()
    const warn = vi.fn()
    const manager = new SharedBotManager(
      deps({ getDaemon: () => ({ sendMsg }) as unknown as RelayDaemonConnection, log: { ...silentLog, warn } })
    )
    const internals = manager as unknown as ManagerInternals
    internals.router.upsert(assignment())

    internals.forwardSessionAction(
      BOT_ID,
      action({
        target: {
          v: 1,
          agentId: AGENT_ID,
          integrationId: '55555555-5555-4555-8555-555555555555',
          sessionKey: SESSION_KEY
        }
      })
    )

    expect(sendMsg).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignored stale session action'))
  })
})

describe('SharedBotManager thread affinity (report + pull-on-miss)', () => {
  const online = (
    sendMsg = vi.fn(async (m: { msgId: string }): Promise<RdAck> => ({ msgId: m.msgId, accepted: true }))
  ) => ({
    daemon: { sendMsg } as unknown as RelayDaemonConnection,
    sendMsg
  })

  /** A channel-scoped `mention` route: an @-mention in C123 routes to AGENT_ID/DAEMON_ID;
   *  un-mentioned follow-ups fall through to thread affinity (so the binding is worth
   *  reporting — unlike an `auto` channel, which re-resolves every message locally). */
  const channelOwned = (): BotAssignment => {
    const a = assignment()
    a.botUserId = 'UBOT'
    a.routes.push({
      agentId: AGENT_ID,
      daemonId: DAEMON_ID,
      integrationId: INTEGRATION_ID,
      scope: { channel: 'C123' },
      match: { kind: 'mention' }
    })
    return a
  }

  /** A channel-scoped `auto` route: EVERY C123 message routes to AGENT_ID/DAEMON_ID. */
  const channelAutoOwned = (): BotAssignment => {
    const a = channelOwned()
    a.routes[a.routes.length - 1]!.match = { kind: 'auto' }
    return a
  }

  const followUp = (over: Partial<WireNormalizedMessage> = {}): WireNormalizedMessage => ({
    msgId: 'slack:C123:1720000000.000200',
    traceId: 't',
    source: 'user',
    platform: 'slack',
    channel: 'C123',
    thread: '1720000000.000100',
    sender: { id: 'U1', isBot: false },
    text: 'still here?',
    mentionedBots: [],
    isDm: false,
    ...over
  })

  it('reports the first route of a thread once, not on every message', async () => {
    const reportThreadAssign = vi.fn(() => true)
    const { daemon, sendMsg } = online()
    const manager = new SharedBotManager(deps({ getDaemon: () => daemon, reportThreadAssign }))
    const internals = manager as unknown as ManagerInternals
    internals.router.upsert(channelOwned())

    // Root message is an @-mention (channel-owner rung) → reports + seeds affinity.
    await internals.forward(BOT_ID, followUp({ msgId: 'slack:C123:1720000000.000100', mentionedBots: ['UBOT'] }))
    // Un-mentioned follow-up in the same thread resolves via affinity → no re-report.
    await internals.forward(BOT_ID, followUp())

    expect(sendMsg).toHaveBeenCalledTimes(2)
    expect(reportThreadAssign).toHaveBeenCalledTimes(1)
    expect(reportThreadAssign).toHaveBeenCalledWith({
      botId: BOT_ID,
      sessionKey: 'C123/1720000000.000100',
      agentId: AGENT_ID,
      daemonId: DAEMON_ID
    } satisfies RcThreadAssign)
  })

  it('does NOT report for an `auto`-owned channel (every message re-resolves locally)', async () => {
    const reportThreadAssign = vi.fn(() => true)
    const { daemon, sendMsg } = online()
    const manager = new SharedBotManager(deps({ getDaemon: () => daemon, reportThreadAssign }))
    const internals = manager as unknown as ManagerInternals
    internals.router.upsert(channelAutoOwned())

    await internals.forward(BOT_ID, followUp({ msgId: 'slack:C123:1720000000.000100' }))
    await internals.forward(BOT_ID, followUp())

    expect(sendMsg).toHaveBeenCalledTimes(2) // both delivered via the auto rung
    expect(reportThreadAssign).not.toHaveBeenCalled() // ...but no write amplification
  })

  it('drops a managed agent bot before routing but forwards an explicitly mentioning third-party bot', async () => {
    const { daemon, sendMsg } = online()
    const reportThreadAssign = vi.fn(() => true)
    const isAgentBotApp = vi.fn((_agentId: string, _platform: string, _channel: string, appId: string) => {
      return appId === 'AMANAGED'
    })
    const manager = new SharedBotManager(deps({ getDaemon: () => daemon, reportThreadAssign, isAgentBotApp }))
    const internals = manager as unknown as ManagerInternals
    internals.router.upsert(channelAutoOwned())

    await internals.forward(
      BOT_ID,
      followUp({
        msgId: 'slack:C123:managed',
        sender: { id: 'UMANAGED', isBot: true, appId: 'AMANAGED' },
        text: '<@UBOT> wake up',
        mentionedBots: ['UBOT']
      })
    )
    await internals.forward(
      BOT_ID,
      followUp({
        msgId: 'slack:C123:external',
        sender: { id: 'UEXTERNAL', isBot: true, appId: 'AEXTERNAL' },
        text: '<@UBOT> wake up',
        mentionedBots: ['UBOT']
      })
    )

    expect(sendMsg).toHaveBeenCalledTimes(1)
    expect(sendMsg.mock.calls[0]![0]).toMatchObject({ msgId: 'slack:C123:external', agentId: AGENT_ID })
    expect(reportThreadAssign).not.toHaveBeenCalled()
  })

  it('retries a report dropped while the CP link was down, on reconnect', async () => {
    let ready = false
    const reportThreadAssign = vi.fn(() => ready) // false ⇒ "link not READY, dropped"
    const { daemon } = online()
    const manager = new SharedBotManager(deps({ getDaemon: () => daemon, reportThreadAssign }))
    const internals = manager as unknown as ManagerInternals
    internals.router.upsert(channelOwned())

    // Link down: the root mention routes+delivers, but the report is dropped + stashed.
    await internals.forward(BOT_ID, followUp({ msgId: 'slack:C123:1720000000.000100', mentionedBots: ['UBOT'] }))
    expect(reportThreadAssign).toHaveBeenCalledTimes(1)

    // Link recovers → flush re-emits the stashed report exactly once.
    ready = true
    manager.flushPendingReports()
    expect(reportThreadAssign).toHaveBeenCalledTimes(2)
    manager.flushPendingReports() // nothing left to retry
    expect(reportThreadAssign).toHaveBeenCalledTimes(2)
  })

  it('retries the latest channel snapshot dropped while the CP link was down', () => {
    let ready = false
    const reportBotChannels = vi.fn(() => ready)
    const manager = new SharedBotManager(deps({ reportBotChannels }))
    const internals = manager as unknown as ManagerInternals
    const first = { botId: BOT_ID, channels: [{ id: 'C123', name: 'first' }] } satisfies RcBotChannels
    const latest = { botId: BOT_ID, channels: [{ id: 'C456', name: 'latest' }] } satisfies RcBotChannels

    internals.reportChannels(first)
    internals.reportChannels(latest)
    expect(reportBotChannels).toHaveBeenCalledTimes(2)

    ready = true
    manager.flushPendingReports()
    expect(reportBotChannels).toHaveBeenCalledTimes(3)
    expect(reportBotChannels).toHaveBeenLastCalledWith(latest)
    manager.flushPendingReports()
    expect(reportBotChannels).toHaveBeenCalledTimes(3)
  })

  it('pulls the persisted owner from the CP on an un-mentioned thread follow-up and forwards it', async () => {
    const { daemon, sendMsg } = online()
    const lookupThread = vi.fn(async (): Promise<RcThreadLookupOk> => ({
      botId: BOT_ID,
      sessionKey: 'C123/1720000000.000100',
      target: { agentId: AGENT_ID, daemonId: DAEMON_ID }
    }))
    const reportThreadAssign = vi.fn(() => true)
    const manager = new SharedBotManager(deps({ getDaemon: () => daemon, lookupThread, reportThreadAssign }))
    const internals = manager as unknown as ManagerInternals
    internals.router.upsert(channelOwned())
    // Remove the channel-owner rule so an un-mentioned follow-up misses local arbitration.
    internals.router.updateRoutes(BOT_ID, {
      members: [{ daemonId: DAEMON_ID, agentIds: [AGENT_ID] }],
      agents: [{ agentId: AGENT_ID, name: 'Agent' }],
      routes: [
        {
          agentId: AGENT_ID,
          daemonId: DAEMON_ID,
          integrationId: INTEGRATION_ID,
          match: { kind: 'keyword', value: 'agent' }
        }
      ]
    })

    await internals.forward(BOT_ID, followUp())

    expect(lookupThread).toHaveBeenCalledWith({ botId: BOT_ID, sessionKey: 'C123/1720000000.000100' })
    expect(sendMsg).toHaveBeenCalledTimes(1)
    // A CP-seeded route is NOT reported back to the CP.
    expect(reportThreadAssign).not.toHaveBeenCalled()
  })

  it('remembers a CP miss and does not re-hit the CP for the same un-owned thread', async () => {
    const lookupThread = vi.fn(async (): Promise<RcThreadLookupOk> => ({
      botId: BOT_ID,
      sessionKey: 'C123/1720000000.000100',
      target: null
    }))
    const { daemon, sendMsg } = online()
    const manager = new SharedBotManager(deps({ getDaemon: () => daemon, lookupThread }))
    const internals = manager as unknown as ManagerInternals
    internals.router.upsert(channelOwned())
    internals.router.updateRoutes(BOT_ID, {
      members: [{ daemonId: DAEMON_ID, agentIds: [AGENT_ID] }],
      agents: [{ agentId: AGENT_ID, name: 'Agent' }],
      routes: [
        {
          agentId: AGENT_ID,
          daemonId: DAEMON_ID,
          integrationId: INTEGRATION_ID,
          match: { kind: 'keyword', value: 'agent' }
        }
      ]
    })

    await internals.forward(BOT_ID, followUp())
    await internals.forward(BOT_ID, followUp({ msgId: 'slack:C123:1720000000.000300' }))

    expect(lookupThread).toHaveBeenCalledTimes(1)
    expect(sendMsg).not.toHaveBeenCalled()
  })
})

describe('SharedBotManager conversation gating (resource-visibility §14.3)', () => {
  const fakeIngest = () => ({
    lookupUserName: vi.fn(async () => '@Alice'),
    postText: vi.fn(async () => {})
  })
  const gatedAssignment = (): BotAssignment => ({
    botId: BOT_ID,
    platform: 'slack',
    secrets: { botToken: 'xoxb', signingSecret: 'ssecret' },
    botUserId: 'UBOT',
    members: [{ daemonId: DAEMON_ID, agentIds: [AGENT_ID] }],
    agents: [{ agentId: AGENT_ID, name: 'Agent' }],
    routes: [], // everything gated ⇒ no keyword rung, no default
    gatedAgentIds: [AGENT_ID]
  })
  const dm = (over: Partial<WireNormalizedMessage> = {}): WireNormalizedMessage => ({
    msgId: 'slack:D42:1720000000.000100',
    traceId: 't',
    source: 'user',
    platform: 'slack',
    channel: 'D42',
    sender: { id: 'U1', isBot: false },
    text: 'hi there',
    mentionedBots: [],
    isDm: true,
    ...over
  })

  it('reports an unrouted gated DM as a kind:im conversation and notices once per conversation', async () => {
    const reportBotConversation = vi.fn(() => true)
    const manager = new SharedBotManager(deps({ reportBotConversation }))
    const internals = manager as unknown as ManagerInternals
    internals.router.upsert(gatedAssignment())
    const ingest = fakeIngest()
    internals.ingests.set(BOT_ID, ingest)

    await internals.forward(BOT_ID, dm())
    expect(reportBotConversation).toHaveBeenCalledWith({
      botId: BOT_ID,
      conversation: { id: 'D42', name: '@Alice', kind: 'im' }
    })
    expect(ingest.postText).toHaveBeenCalledTimes(1)
    expect(ingest.postText.mock.calls[0]![0]).toBe('D42')

    // Second DM: report is latched per conversation (CP row exists), notice too.
    await internals.forward(BOT_ID, dm({ msgId: 'slack:D42:1720000000.000200' }))
    expect(reportBotConversation).toHaveBeenCalledTimes(1)
    expect(ingest.postText).toHaveBeenCalledTimes(1)
  })

  it('reports a gated DM even when a non-gated default agent WINS the routing (mixed bot)', async () => {
    const reportBotConversation = vi.fn(() => true)
    const manager = new SharedBotManager(deps({ reportBotConversation }))
    const internals = manager as unknown as ManagerInternals
    const a = gatedAssignment()
    // OTHER is org-visible and catches every unslugged DM as the group default.
    a.members = [
      { daemonId: DAEMON_ID, agentIds: [AGENT_ID] },
      { daemonId: OTHER_DAEMON_ID, agentIds: [OTHER_AGENT_ID] }
    ]
    a.agents = [
      { agentId: AGENT_ID, name: 'Agent' },
      { agentId: OTHER_AGENT_ID, name: 'Public' }
    ]
    a.routes = [
      {
        agentId: OTHER_AGENT_ID,
        daemonId: OTHER_DAEMON_ID,
        integrationId: OTHER_INTEGRATION_ID,
        match: { kind: 'keyword', value: 'public' }
      }
    ]
    a.defaultAgentId = OTHER_AGENT_ID
    a.defaultDaemonId = OTHER_DAEMON_ID
    internals.router.upsert(a)
    const ingest = fakeIngest()
    internals.ingests.set(BOT_ID, ingest)

    await internals.forward(BOT_ID, dm())
    // The DM routed to the public default — the gated install still needs its
    // pending Off row, but nothing was unrouted so there is NO notice.
    expect(reportBotConversation).toHaveBeenCalledWith({
      botId: BOT_ID,
      conversation: { id: 'D42', name: '@Alice', kind: 'im' }
    })
    expect(ingest.postText).not.toHaveBeenCalled()
  })

  it('resets the DM-report latch when the gated member set changes (new install needs its row)', async () => {
    const reportBotConversation = vi.fn(() => true)
    const manager = new SharedBotManager(deps({ reportBotConversation }))
    const internals = manager as unknown as ManagerInternals
    const a = gatedAssignment()
    internals.router.upsert(a)
    internals.ingests.set(BOT_ID, fakeIngest())

    await internals.forward(BOT_ID, dm())
    expect(reportBotConversation).toHaveBeenCalledTimes(1) // latched for this assignment

    // A routes update with a CHANGED gated set (e.g. a newly restricted install)
    // must invalidate the latch so the next DM fans out the new install's row.
    manager.updateRoutes(BOT_ID, {
      members: a.members,
      agents: a.agents,
      routes: a.routes,
      gatedAgentIds: [AGENT_ID, OTHER_AGENT_ID]
    })
    await internals.forward(BOT_ID, dm({ msgId: 'slack:D42:1720000000.000200' }))
    expect(reportBotConversation).toHaveBeenCalledTimes(2)

    // An unchanged gated set keeps the latch.
    manager.updateRoutes(BOT_ID, {
      members: a.members,
      agents: a.agents,
      routes: a.routes,
      gatedAgentIds: [AGENT_ID, OTHER_AGENT_ID]
    })
    await internals.forward(BOT_ID, dm({ msgId: 'slack:D42:1720000000.000300' }))
    expect(reportBotConversation).toHaveBeenCalledTimes(2)
  })

  it('retries the DM report on the next DM when the CP link was down', async () => {
    let ready = false
    const reportBotConversation = vi.fn(() => ready)
    const manager = new SharedBotManager(deps({ reportBotConversation }))
    const internals = manager as unknown as ManagerInternals
    internals.router.upsert(gatedAssignment())
    internals.ingests.set(BOT_ID, fakeIngest())

    await internals.forward(BOT_ID, dm())
    expect(reportBotConversation).toHaveBeenCalledTimes(1) // dropped — not latched
    ready = true
    await internals.forward(BOT_ID, dm({ msgId: 'slack:D42:1720000000.000200' }))
    expect(reportBotConversation).toHaveBeenCalledTimes(2) // delivered — latched
    await internals.forward(BOT_ID, dm({ msgId: 'slack:D42:1720000000.000300' }))
    expect(reportBotConversation).toHaveBeenCalledTimes(2)
  })

  it('an unrouted @mention in a channel gets the notice but NO conversation report', async () => {
    const reportBotConversation = vi.fn(() => true)
    const manager = new SharedBotManager(deps({ reportBotConversation }))
    const internals = manager as unknown as ManagerInternals
    internals.router.upsert(gatedAssignment())
    const ingest = fakeIngest()
    internals.ingests.set(BOT_ID, ingest)

    await internals.forward(
      BOT_ID,
      dm({ channel: 'C9', isDm: false, thread: '123.456', text: '<@UBOT> hello', mentionedBots: ['UBOT'] })
    )
    expect(reportBotConversation).not.toHaveBeenCalled()
    expect(ingest.postText).toHaveBeenCalledTimes(1)
    expect(ingest.postText.mock.calls[0]![2]).toBe('123.456') // threaded, no channel spam
  })

  it('same pod: the ineligible copy shadow-primes but never suppresses its OWN authoritative sibling', async () => {
    const manager = new SharedBotManager(deps())
    const internals = manager as unknown as ManagerInternals
    internals.router.upsert(gatedAssignment())
    const ingest = fakeIngest()
    internals.ingests.set(BOT_ID, ingest)
    const mention = dm({ channel: 'C9', isDm: false, thread: '1.2', text: '<@UBOT> hi', mentionedBots: ['UBOT'] })

    // message.channels copy first: shadow-primed, no notice…
    await internals.forward(BOT_ID, mention, { noticeEligible: false })
    expect(ingest.postText).not.toHaveBeenCalled()
    // …its app_mention sibling (same msgId) still posts exactly once.
    await internals.forward(BOT_ID, mention, { noticeEligible: true })
    await internals.forward(BOT_ID, mention, { noticeEligible: true })
    expect(ingest.postText).toHaveBeenCalledTimes(1)
  })

  it('two pods: the one-time invariant survives the authoritative copy switching replicas', async () => {
    // Two manager instances = two relay pods with independent in-memory latches.
    const podA = new SharedBotManager(deps())
    const podB = new SharedBotManager(deps())
    const a = podA as unknown as ManagerInternals
    const b = podB as unknown as ManagerInternals
    const ingestA = fakeIngest()
    const ingestB = fakeIngest()
    a.router.upsert(gatedAssignment())
    b.router.upsert(gatedAssignment())
    a.ingests.set(BOT_ID, ingestA)
    b.ingests.set(BOT_ID, ingestB)
    const m1 = dm({
      msgId: 'slack:C9:1720000000.000100',
      channel: 'C9',
      isDm: false,
      thread: '1.1',
      text: '<@UBOT> hi',
      mentionedBots: ['UBOT']
    })
    // Mention 1: message copy → pod A (ineligible), app_mention copy → pod B.
    await a.forward(BOT_ID, m1, { noticeEligible: false })
    await b.forward(BOT_ID, m1, { noticeEligible: true })
    expect(ingestA.postText).not.toHaveBeenCalled()
    expect(ingestB.postText).toHaveBeenCalledTimes(1)

    // Mention 2 with the copies FLIPPED: pod A now holds the authoritative copy,
    // but its shadow-primed latch (different msgId) keeps the conversation silent.
    const m2 = { ...m1, msgId: 'slack:C9:1720000000.000200', thread: '2.2' }
    await a.forward(BOT_ID, m2, { noticeEligible: true })
    await b.forward(BOT_ID, m2, { noticeEligible: false })
    expect(ingestA.postText).not.toHaveBeenCalled()
    expect(ingestB.postText).toHaveBeenCalledTimes(1)
  })

  it('does nothing gated-related for a bot with no gated members', async () => {
    const reportBotConversation = vi.fn(() => true)
    const manager = new SharedBotManager(deps({ reportBotConversation }))
    const internals = manager as unknown as ManagerInternals
    const a = gatedAssignment()
    a.gatedAgentIds = []
    internals.router.upsert(a)
    const ingest = fakeIngest()
    internals.ingests.set(BOT_ID, ingest)

    await internals.forward(BOT_ID, dm())
    expect(reportBotConversation).not.toHaveBeenCalled()
    expect(ingest.postText).not.toHaveBeenCalled()
  })
})
