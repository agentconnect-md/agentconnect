import { createHmac } from 'node:crypto'
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
import {
  SharedBotManager,
  type SharedBotManagerDeps,
  sharedSlackActionMsgId,
  sharedSlackShortcutMsgId
} from './shared-bot-manager.js'
import { SharedBotRouter, type BotAssignment } from './shared-bot-router.js'
import type { SharedSlackSessionAction, SharedSlackSessionShortcut } from './slack-shared-ingest.js'
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
const SELF_RELAY = '88888888-8888-4888-8888-888888888881'
const PEER_RELAY = '88888888-8888-4888-8888-888888888882'
const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/** Manager deps with the required affinity + clock stubs, overridable per test. */
const deps = (over: Partial<SharedBotManagerDeps> = {}): SharedBotManagerDeps => ({
  getDaemon: () => undefined,
  setChannelAgent: vi.fn(),
  reportBotChannels: vi.fn(() => true),
  reportBotConversation: vi.fn(() => true),
  reportNoticePosted: vi.fn(() => true),
  reportBotRevoked: vi.fn(() => true),
  selfRelayId: () => SELF_RELAY,
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
  reportRevoked(m: { botId: string; reason: 'app_uninstalled' | 'tokens_revoked'; credentialRevision?: number }): void
  selectThreadAgent(botId: string, channelId: string, threadTs: string, agentId: string): void
  forwardSessionAction(botId: string, action: SharedSlackSessionAction): void
  forwardSessionShortcut(botId: string, shortcut: SharedSlackSessionShortcut): boolean
  forward(botId: string, msg: WireNormalizedMessage): Promise<void>
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

  it('forwards a message shortcut through the current thread affinity', () => {
    const sendMsg = vi.fn(async (msg: RdMsgSlackAction): Promise<RdAck> => ({ msgId: msg.msgId, accepted: true }))
    const daemon = { sendMsg } as unknown as RelayDaemonConnection
    const manager = new SharedBotManager(
      deps({ getDaemon: (daemonId) => (daemonId === DAEMON_ID ? daemon : undefined) })
    )
    const internals = manager as unknown as ManagerInternals
    internals.router.upsert(assignment())
    internals.router.setAffinity(BOT_ID, 'C123/T1', {
      agentId: AGENT_ID,
      daemonId: DAEMON_ID,
      integrationId: INTEGRATION_ID
    })
    const shortcut: SharedSlackSessionShortcut = {
      triggerId: 'trigger-shortcut',
      channelId: 'C123',
      threadTs: 'T1',
      interactionId: 'trigger-shortcut',
      userId: 'U-ALICE'
    }

    expect(internals.forwardSessionShortcut(BOT_ID, shortcut)).toBe(true)
    expect(sendMsg).toHaveBeenCalledWith({
      source: 'slack_action',
      agentId: AGENT_ID,
      integrationId: INTEGRATION_ID,
      sessionKey: 'C123/T1',
      msgId: sharedSlackShortcutMsgId(BOT_ID, shortcut),
      botId: BOT_ID,
      userId: 'U-ALICE',
      payload: {
        kind: 'open-config-for-thread',
        triggerId: 'trigger-shortcut',
        channelId: 'C123',
        threadTs: 'T1'
      }
    })
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

  // A revocation is NOT droppable like the other best-effort reports: Slack acked
  // the HTTP event before the relay's handler ran and never redelivers it, a dead
  // token gives the CP nothing to probe, and assignment reconciliation would just
  // republish the stale active state — the console would show an uninstalled app
  // as live forever.
  it('retries a revocation report received while the CP link was down', () => {
    let ready = false
    const reportBotRevoked = vi.fn(() => ready)
    const manager = new SharedBotManager(deps({ reportBotRevoked }))
    const internals = manager as unknown as ManagerInternals
    const report = { botId: BOT_ID, reason: 'app_uninstalled' as const, credentialRevision: 3 }

    internals.reportRevoked(report)
    expect(reportBotRevoked).toHaveBeenCalledTimes(1) // attempted, refused by the link

    ready = true
    manager.flushPendingReports()
    // Replayed verbatim — the revision still describes the generation that was
    // live when Slack sent the event, which is what the CP's fence needs.
    expect(reportBotRevoked).toHaveBeenCalledTimes(2)
    expect(reportBotRevoked).toHaveBeenLastCalledWith(report)
    manager.flushPendingReports()
    expect(reportBotRevoked).toHaveBeenCalledTimes(2) // queue drained
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
    gatedAgentIds: [AGENT_ID],
    noticeAuthority: SELF_RELAY
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

  it('a first gated DM on a NON-authority pod still posts (single event copy, receiving pod owns it)', async () => {
    const manager = new SharedBotManager(deps({ selfRelayId: () => PEER_RELAY }))
    const internals = manager as unknown as ManagerInternals
    internals.router.upsert(gatedAssignment()) // noticeAuthority = SELF_RELAY, not this pod
    const ingest = fakeIngest()
    internals.ingests.set(BOT_ID, ingest)

    await internals.forward(BOT_ID, dm())
    expect(ingest.postText).toHaveBeenCalledTimes(1)
  })

  it('a DM whose notice was already DELIVERED (noticedDmConversations) is latched on EVERY pod', async () => {
    const manager = new SharedBotManager(deps())
    const internals = manager as unknown as ManagerInternals
    const a = gatedAssignment()
    a.noticedDmConversations = ['D42'] // delivery reported + re-stamped by the CP
    internals.router.upsert(a)
    const ingest = fakeIngest()
    internals.ingests.set(BOT_ID, ingest)

    await internals.forward(BOT_ID, dm())
    expect(ingest.postText).not.toHaveBeenCalled()
  })

  it('a DM discovered while a public default routed it STILL gets its notice once unroutable', async () => {
    const reportNoticePosted = vi.fn(() => true)
    const daemon = { sendMsg: vi.fn(async (m: { msgId: string }) => ({ msgId: m.msgId, accepted: true })) }
    const manager = new SharedBotManager(
      deps({ reportNoticePosted, getDaemon: () => daemon as unknown as RelayDaemonConnection })
    )
    const internals = manager as unknown as ManagerInternals
    const a = gatedAssignment()
    // Mixed bot: OTHER is org-visible and catches the DM as the group default.
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

    // DM 1 routes to the public default: row discovery happens, NO notice.
    await internals.forward(BOT_ID, dm())
    expect(ingest.postText).not.toHaveBeenCalled()

    // The public default is removed (uninstall/restriction) — DM now unroutable.
    manager.updateRoutes(BOT_ID, {
      members: [{ daemonId: DAEMON_ID, agentIds: [AGENT_ID] }],
      agents: [{ agentId: AGENT_ID, name: 'Agent' }],
      routes: [],
      gatedAgentIds: [AGENT_ID]
      // no noticedDmConversations: discovery alone must never latch the notice
    })
    await internals.forward(BOT_ID, dm({ msgId: 'slack:D42:1720000000.000300' }))
    expect(ingest.postText).toHaveBeenCalledTimes(1)
    expect(reportNoticePosted).toHaveBeenCalledWith({ botId: BOT_ID, channel: 'D42' })
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

  /** Two manager instances = two relay pods; only the authority pod may post. */
  const pod = (authority: boolean) => {
    const manager = new SharedBotManager(deps({ selfRelayId: () => (authority ? SELF_RELAY : PEER_RELAY) }))
    const internals = manager as unknown as ManagerInternals
    const ingest = fakeIngest()
    internals.router.upsert(gatedAssignment()) // noticeAuthority = SELF_RELAY
    internals.ingests.set(BOT_ID, ingest)
    return { internals, ingest }
  }
  const mention = (msgId: string, thread: string) =>
    dm({ msgId, channel: 'C9', isDm: false, thread, text: '<@UBOT> hi', mentionedBots: ['UBOT'] })
  const M1 = 'slack:C9:1720000000.000100'
  const M2 = 'slack:C9:1720000000.000200'

  it('authority pod: sibling copies and repeat mentions collapse to exactly one notice', async () => {
    const auth = pod(true)
    await auth.internals.forward(BOT_ID, mention(M1, '1.1'))
    await auth.internals.forward(BOT_ID, mention(M1, '1.1'))
    await auth.internals.forward(BOT_ID, mention(M2, '2.2'))
    expect(auth.ingest.postText).toHaveBeenCalledTimes(1)
  })

  it('non-authority pod never posts, whatever schedule its copies arrive in', async () => {
    const auth = pod(true)
    const peer = pod(false)
    // Mention 1 split across pods; mention 2 lands entirely on the peer.
    await peer.internals.forward(BOT_ID, mention(M1, '1.1'))
    await auth.internals.forward(BOT_ID, mention(M1, '1.1'))
    await peer.internals.forward(BOT_ID, mention(M2, '2.2'))
    await peer.internals.forward(BOT_ID, mention(M2, '2.2'))
    expect(auth.ingest.postText).toHaveBeenCalledTimes(1)
    expect(peer.ingest.postText).not.toHaveBeenCalled()
  })

  it('a mention missing the authority pod is caught by the next one that reaches it', async () => {
    const auth = pod(true)
    const peer = pod(false)
    await peer.internals.forward(BOT_ID, mention(M1, '1.1')) // both copies miss the authority
    expect(auth.ingest.postText).not.toHaveBeenCalled()
    expect(peer.ingest.postText).not.toHaveBeenCalled()
    await auth.internals.forward(BOT_ID, mention(M2, '2.2')) // caught here — exactly once overall
    expect(auth.ingest.postText).toHaveBeenCalledTimes(1)
    expect(peer.ingest.postText).not.toHaveBeenCalled()
  })

  it('crossed concurrent mentions: only the authority posts, exactly once', async () => {
    const auth = pod(true)
    const peer = pod(false)
    await peer.internals.forward(BOT_ID, mention(M2, '2.2'))
    await auth.internals.forward(BOT_ID, mention(M1, '1.1'))
    await peer.internals.forward(BOT_ID, mention(M1, '1.1'))
    await auth.internals.forward(BOT_ID, mention(M2, '2.2'))
    expect(auth.ingest.postText).toHaveBeenCalledTimes(1)
    expect(peer.ingest.postText).not.toHaveBeenCalled()
  })

  it('no authority stamped (old CP / empty roster): no pod posts; DM discovery still reports', async () => {
    const reportBotConversation = vi.fn(() => true)
    const manager = new SharedBotManager(deps({ reportBotConversation, selfRelayId: () => SELF_RELAY }))
    const internals = manager as unknown as ManagerInternals
    const a = gatedAssignment()
    delete a.noticeAuthority
    internals.router.upsert(a)
    const ingest = fakeIngest()
    internals.ingests.set(BOT_ID, ingest)

    await internals.forward(BOT_ID, mention(M1, '1.1'))
    expect(ingest.postText).not.toHaveBeenCalled()
    // An authority-less (or non-authority) pod still fans out gated-DM rows.
    await internals.forward(BOT_ID, dm())
    expect(reportBotConversation).toHaveBeenCalledTimes(1)
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

// ── resolveVerified — the (api_app_id, team_id) composite demux ─────────────
//
// Every install of a DISTRIBUTED (platform-published) app shares one app id AND
// one signing secret, so the HMAC can authenticate but cannot discriminate —
// only the composite key may route, and the verify-scan must never hand one
// workspace's events to a sibling install (a cross-tenant leak, not a miss).
describe('SharedBotManager.resolveVerified composite demux', () => {
  const BOT_T1 = 'aaaaaaaa-1111-4111-8111-111111111111'
  const BOT_T2 = 'aaaaaaaa-2222-4222-8222-222222222222'
  const BOT_LEGACY = 'aaaaaaaa-3333-4333-8333-333333333333'
  const PLATFORM_APP = 'APLATFORM'
  const SHARED_SECRET = 'shared-platform-signing-secret'
  const NOW = 1_720_000_000_000
  const ts = String(Math.floor(NOW / 1000))
  const body = Buffer.from(JSON.stringify({ type: 'event_callback', event_id: 'Ev1' }))
  const sig = (secret: string) => `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`

  interface DemuxInternals {
    router: SharedBotRouter
    ingests: Map<string, { signingSecret: string; stop(): Promise<void> }>
    demuxByApiApp: Map<string, string>
    demuxByAppTeam: Map<string, string>
    appTeamKeyByBot: Map<string, string>
  }

  /** Register a bot the way `assign()` would, minus the network-touching ingest
   *  start: router assignment + a secret-bearing ingest stand-in + (for a
   *  team-scoped bot) the assign-derived composite index entries. */
  const addBot = (
    manager: SharedBotManager,
    botId: string,
    signingSecret: string,
    opts: { apiAppId?: string; teamId?: string; indexed?: boolean } = {}
  ) => {
    const internals = manager as unknown as DemuxInternals
    internals.ingests.set(botId, { signingSecret, stop: async () => {} })
    internals.router.upsert({
      ...assignment(),
      botId,
      secrets: { botToken: 'xoxb', signingSecret },
      ...(opts.apiAppId ? { apiAppId: opts.apiAppId } : {}),
      ...(opts.teamId ? { teamId: opts.teamId } : {})
    })
    if (opts.apiAppId && opts.teamId && opts.indexed !== false) {
      internals.demuxByAppTeam.set(`${opts.apiAppId}\u0000${opts.teamId}`, botId)
      internals.appTeamKeyByBot.set(botId, `${opts.apiAppId}\u0000${opts.teamId}`)
    }
    if (opts.apiAppId && !opts.teamId) internals.demuxByApiApp.set(opts.apiAppId, botId)
  }

  const resolve = (manager: SharedBotManager, over: { apiAppId?: string; teamId?: string; secret?: string }) =>
    manager.resolveVerified({
      ...(over.apiAppId ? { apiAppId: over.apiAppId } : {}),
      ...(over.teamId ? { teamId: over.teamId } : {}),
      timestamp: ts,
      rawBody: body,
      signature: sig(over.secret ?? SHARED_SECRET)
    })

  it('demuxes sibling installs of one distributed app by (api_app_id, team_id)', () => {
    const manager = new SharedBotManager(deps({ clock: new FakeClock(NOW) }))
    addBot(manager, BOT_T1, SHARED_SECRET, { apiAppId: PLATFORM_APP, teamId: 'T1' })
    addBot(manager, BOT_T2, SHARED_SECRET, { apiAppId: PLATFORM_APP, teamId: 'T2' })

    const internals = manager as unknown as DemuxInternals
    expect(resolve(manager, { apiAppId: PLATFORM_APP, teamId: 'T1' })).toBe(internals.ingests.get(BOT_T1))
    expect(resolve(manager, { apiAppId: PLATFORM_APP, teamId: 'T2' })).toBe(internals.ingests.get(BOT_T2))
  })

  it('never serves a team-scoped bot to another workspace via the signature scan', () => {
    const manager = new SharedBotManager(deps({ clock: new FakeClock(NOW) }))
    // Composite index deliberately EMPTY (indexed:false) — only the router knows
    // the team ids, so resolution falls through to the verify-scan, where the
    // same-secret sibling MUST be skipped on the team-id guard.
    addBot(manager, BOT_T1, SHARED_SECRET, { apiAppId: PLATFORM_APP, teamId: 'T1', indexed: false })
    addBot(manager, BOT_T2, SHARED_SECRET, { apiAppId: PLATFORM_APP, teamId: 'T2', indexed: false })

    const internals = manager as unknown as DemuxInternals
    expect(resolve(manager, { apiAppId: PLATFORM_APP, teamId: 'T2' })).toBe(internals.ingests.get(BOT_T2))
    // The scan hit must not poison the app-only learned map for a team-scoped bot.
    expect(internals.demuxByApiApp.has(PLATFORM_APP)).toBe(false)
  })

  it('fails closed when a distributed-app envelope carries no team id', () => {
    const manager = new SharedBotManager(deps({ clock: new FakeClock(NOW) }))
    addBot(manager, BOT_T1, SHARED_SECRET, { apiAppId: PLATFORM_APP, teamId: 'T1' })
    addBot(manager, BOT_T2, SHARED_SECRET, { apiAppId: PLATFORM_APP, teamId: 'T2' })

    // Both siblings verify the HMAC; without a team id there is no safe pick.
    expect(resolve(manager, { apiAppId: PLATFORM_APP })).toBeUndefined()
  })

  it('keeps the legacy app-only fast path and scan learning for team-less bots', () => {
    const manager = new SharedBotManager(deps({ clock: new FakeClock(NOW) }))
    addBot(manager, BOT_LEGACY, 'legacy-secret', {}) // no app id stamped — scan learns it

    const internals = manager as unknown as DemuxInternals
    expect(resolve(manager, { apiAppId: 'ALEGACY', secret: 'legacy-secret' })).toBe(internals.ingests.get(BOT_LEGACY))
    expect(internals.demuxByApiApp.get('ALEGACY')).toBe(BOT_LEGACY)
    // A team-scoped envelope still resolves the legacy bot (guard only skips
    // bots whose ASSIGNMENT carries a different team id).
    expect(resolve(manager, { apiAppId: 'ALEGACY', teamId: 'T9', secret: 'legacy-secret' })).toBe(
      internals.ingests.get(BOT_LEGACY)
    )
  })

  it('unassign drops the composite index entries', async () => {
    const manager = new SharedBotManager(deps({ clock: new FakeClock(NOW) }))
    addBot(manager, BOT_T1, SHARED_SECRET, { apiAppId: PLATFORM_APP, teamId: 'T1' })

    await manager.unassign(BOT_T1)
    const internals = manager as unknown as DemuxInternals
    expect(internals.demuxByAppTeam.size).toBe(0)
    expect(internals.appTeamKeyByBot.size).toBe(0)
    expect(resolve(manager, { apiAppId: PLATFORM_APP, teamId: 'T1' })).toBeUndefined()
  })
})
