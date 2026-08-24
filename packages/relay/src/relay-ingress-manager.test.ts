import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type {
  RdAck,
  RdMsg,
  RdMsgPlatformAction,
  RdMsgIm,
  RcBotChannels,
  RcThreadAssign,
  RcThreadLookupOk,
  WireFeishuCardActionEvent,
  WireNormalizedMessage
} from '@agentconnect.md/protocol'
import { RD_ACK_NOT_HOLDER, MAX_AGENT_CALL_HOPS } from '@agentconnect.md/protocol'
import { FakeClock } from '@agentconnect.md/connection'
import { RelayIngressManager, type RelayIngressManagerDeps } from './relay-ingress-manager.js'
// The dedup-id minters belong to their platform plugins (§8: the plugin mints
// the identity, core owns the table). This suite was the last importer of the
// core re-export shim that outlived the #571 route migration (audit F7).
import {
  forwardSessionAction,
  forwardSessionShortcut,
  forwardSessionStop,
  httpSlackActionMsgId,
  httpSlackShortcutMsgId,
  httpSlackStopMsgId
} from './platforms/slack/ingress-plugin.js'
import { forwardFeishuCardAction, httpFeishuActionMsgId } from './platforms/feishu/ingress-plugin.js'
import { DemuxIndex, relayIngressPlugins } from './platforms/registry.js'
import type { RelayBotIngress, RelayPlatformIngressPlugin } from './platforms/contract.js'
import { BotArbitrationRouter, mapAgentDirectory, type BotAssignment } from './bot-arbitration.js'
import type {
  HttpSlackSessionAction,
  HttpSlackSessionShortcut,
  HttpSlackSessionStop
} from './platforms/slack/http-ingest.js'
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
const deps = (over: Partial<RelayIngressManagerDeps> = {}): RelayIngressManagerDeps => ({
  getDaemon: () => undefined,
  setChannelAgent: vi.fn(),
  reportBotChannels: vi.fn(() => true),
  reportBotConversation: vi.fn(() => true),
  reportNoticePosted: vi.fn(() => true),
  reportBotRevoked: vi.fn(async () => true),
  selfRelayId: () => SELF_RELAY,
  reportThreadAssign: vi.fn(() => true),
  reportThreadParticipant: vi.fn(() => true),
  lookupThread: vi.fn(
    async () => ({ botId: BOT_ID, sessionKey: '', target: null, participants: [] }) as RcThreadLookupOk
  ),
  isAgentBotApp: vi.fn(() => false),
  admitsAgentCall: vi.fn(() => true),
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

const action = (over: Partial<HttpSlackSessionAction> = {}): HttpSlackSessionAction =>
  ({
    target: { v: 1, agentId: AGENT_ID, integrationId: INTEGRATION_ID, sessionKey: SESSION_KEY },
    interactionId: JSON.stringify(['ac_set_model', '1720000000.000200']),
    kind: 'set-model',
    model: 'opus-4.8',
    ...over
  }) as HttpSlackSessionAction

/** One platform's ingest pool, as the reach-in view exposes it. `set` is
 *  deliberately permissive: these tests plant purpose-built stand-ins that
 *  implement only the facets the path under test touches. */
interface PoolView {
  set(botId: string, ingest: object): void
  get(botId: string): Record<string, unknown> | undefined
}

interface ManagerInternals {
  router: BotArbitrationRouter
  slackPool: PoolView
  feishuPool: PoolView
  slackDemux: DemuxIndex
  /** Any registered platform's entry — the same lookup every lifecycle edge in
   *  the manager now performs. */
  entryFor(platformId: string): { pool: PoolView; demux: DemuxIndex }
  reportChannels(snapshot: RcBotChannels): void
  reportRevoked(m: { botId: string; reason: 'app_uninstalled' | 'tokens_revoked'; credentialRevision?: number }): void
  selectThreadAgent(botId: string, channelId: string, threadTs: string, agentId: string): void
  ingressHost: import('./platforms/contract.js').RelayIngressHost
  forward(botId: string, msg: WireNormalizedMessage): Promise<void>
}

/**
 * Reach-in view of the manager's privates.
 *
 * `slackPool` / `feishuPool` / `slackDemux` are the plugin REGISTRY's entries
 * for those ids, not fields: the manager's hand-named twin pools went away with
 * audit F2/F4/F6, which is what made teardown registry-driven. The tests now
 * read exactly the structure the manager does.
 */
const internalsOf = (manager: RelayIngressManager): ManagerInternals => {
  const priv = manager as unknown as {
    ingressPlugins: Map<string, { pool: PoolView; demux: DemuxIndex }>
  } & Omit<ManagerInternals, 'slackPool' | 'feishuPool' | 'slackDemux'>
  const entry = (platformId: string) => {
    const found = priv.ingressPlugins.get(platformId)
    if (!found) throw new Error(`no relay ingress plugin registered for '${platformId}'`)
    return found
  }
  return {
    router: priv.router,
    slackPool: entry('slack').pool,
    feishuPool: entry('feishu').pool,
    slackDemux: entry('slack').demux,
    entryFor: entry,
    reportChannels: (snapshot) => priv.reportChannels(snapshot),
    reportRevoked: (m) => priv.reportRevoked(m),
    selectThreadAgent: (botId, channelId, threadTs, agentId) =>
      priv.selectThreadAgent(botId, channelId, threadTs, agentId),
    get ingressHost() {
      return priv.ingressHost
    },
    forward: (botId, msg) => priv.forward(botId, msg)
  }
}

describe('RelayIngressManager HTTP Slack session actions', () => {
  it('rebinds the current thread immediately when the inline selector changes agent', () => {
    const setChannelAgent = vi.fn()
    const reportThreadAssign = vi.fn(() => true)
    const manager = new RelayIngressManager(deps({ setChannelAgent, reportThreadAssign }))
    const internals = internalsOf(manager)
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
    const sendMsg = vi.fn(async (msg: RdMsgPlatformAction): Promise<RdAck> => ({ msgId: msg.msgId, accepted: true }))
    const daemon = { sendMsg } as unknown as RelayDaemonConnection
    const manager = new RelayIngressManager(
      deps({ getDaemon: (daemonId) => (daemonId === DAEMON_ID ? daemon : undefined) })
    )
    const internals = internalsOf(manager)
    internals.router.upsert(assignment())

    const delivered = action()
    forwardSessionAction(internals.ingressHost, BOT_ID, delivered)
    forwardSessionAction(internals.ingressHost, BOT_ID, delivered) // Socket Mode redelivery

    expect(sendMsg).toHaveBeenCalledTimes(2)
    const first = sendMsg.mock.calls[0]![0]
    const second = sendMsg.mock.calls[1]![0]
    expect(first).toEqual({
      source: 'platform_action',
      platformId: 'slack',
      agentId: AGENT_ID,
      integrationId: INTEGRATION_ID,
      sessionKey: SESSION_KEY,
      msgId: httpSlackActionMsgId(BOT_ID, delivered),
      botId: BOT_ID,
      payload: { kind: 'set-model', model: 'opus-4.8' }
    })
    expect(second.msgId).toBe(first.msgId)
    expect(first.msgId).toMatch(/^slack-action:[a-f0-9]{64}$/)
  })

  it('forwards a message shortcut through the current thread affinity', () => {
    const sendMsg = vi.fn(async (msg: RdMsgPlatformAction): Promise<RdAck> => ({ msgId: msg.msgId, accepted: true }))
    const daemon = { sendMsg } as unknown as RelayDaemonConnection
    const manager = new RelayIngressManager(
      deps({ getDaemon: (daemonId) => (daemonId === DAEMON_ID ? daemon : undefined) })
    )
    const internals = internalsOf(manager)
    internals.router.upsert(assignment())
    internals.router.setAffinity(BOT_ID, 'C123/T1', {
      agentId: AGENT_ID,
      daemonId: DAEMON_ID,
      integrationId: INTEGRATION_ID
    })
    const shortcut: HttpSlackSessionShortcut = {
      triggerId: 'trigger-shortcut',
      channelId: 'C123',
      threadTs: 'T1',
      interactionId: 'trigger-shortcut',
      userId: 'U-ALICE'
    }

    expect(forwardSessionShortcut(internals.ingressHost, BOT_ID, shortcut)).toBe(true)
    expect(sendMsg).toHaveBeenCalledWith({
      source: 'platform_action',
      platformId: 'slack',
      agentId: AGENT_ID,
      integrationId: INTEGRATION_ID,
      sessionKey: 'C123/T1',
      msgId: httpSlackShortcutMsgId(BOT_ID, shortcut),
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

  // The native Stop travels the shortcut's seam: it names no session, so ownership picks the
  // daemon and the daemon resolves the session — exactly what Socket Mode does with the event.
  it('forwards the agent-session stop through the current thread affinity, with attribution', () => {
    const sendMsg = vi.fn(async (msg: RdMsgPlatformAction): Promise<RdAck> => ({ msgId: msg.msgId, accepted: true }))
    const daemon = { sendMsg } as unknown as RelayDaemonConnection
    const manager = new RelayIngressManager(
      deps({ getDaemon: (daemonId) => (daemonId === DAEMON_ID ? daemon : undefined) })
    )
    const internals = internalsOf(manager)
    internals.router.upsert(assignment())
    internals.router.setAffinity(BOT_ID, 'C123/T1', {
      agentId: AGENT_ID,
      daemonId: DAEMON_ID,
      integrationId: INTEGRATION_ID
    })
    const stop: HttpSlackSessionStop = {
      channelId: 'C123',
      threadTs: 'T1',
      interactionId: 'Ev123',
      userId: 'U-ALICE'
    }

    forwardSessionStop(internals.ingressHost, BOT_ID, stop)
    forwardSessionStop(internals.ingressHost, BOT_ID, stop) // Slack redelivery

    expect(sendMsg).toHaveBeenCalledTimes(2)
    const first = sendMsg.mock.calls[0]![0]
    expect(first).toEqual({
      source: 'platform_action',
      platformId: 'slack',
      agentId: AGENT_ID,
      integrationId: INTEGRATION_ID,
      sessionKey: 'C123/T1',
      msgId: httpSlackStopMsgId(BOT_ID, stop),
      botId: BOT_ID,
      userId: 'U-ALICE',
      payload: { kind: 'agent-session-stopped', channelId: 'C123', threadTs: 'T1' }
    })
    // A redelivery carries the same event id, so the daemon dedups it.
    expect(sendMsg.mock.calls[1]![0].msgId).toBe(first.msgId)
    // …and a stop the shortcut seam would have hashed identically stays distinct.
    expect(first.msgId).not.toBe(
      httpSlackShortcutMsgId(BOT_ID, { channelId: 'C123', threadTs: 'T1', triggerId: 't', interactionId: 'Ev123' })
    )
  })

  it('forwards no stop for a conversation this bot owns nowhere', () => {
    const sendMsg = vi.fn()
    const warn = vi.fn()
    const manager = new RelayIngressManager(
      deps({ getDaemon: () => ({ sendMsg }) as unknown as RelayDaemonConnection, log: { ...silentLog, warn } })
    )
    const internals = internalsOf(manager)

    forwardSessionStop(internals.ingressHost, BOT_ID, { channelId: 'C123', threadTs: 'T1', interactionId: 'Ev123' })

    expect(sendMsg).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no owner for the agent-session stop'))
  })

  it('forwards the tapping user, and omits it entirely when the interaction named none', () => {
    const sendMsg = vi.fn(async (msg: RdMsgPlatformAction): Promise<RdAck> => ({ msgId: msg.msgId, accepted: true }))
    const daemon = { sendMsg } as unknown as RelayDaemonConnection
    const manager = new RelayIngressManager(
      deps({ getDaemon: (daemonId) => (daemonId === DAEMON_ID ? daemon : undefined) })
    )
    const internals = internalsOf(manager)
    internals.router.upsert(assignment())

    const attributed = action({ userId: 'U-ALICE' })
    forwardSessionAction(internals.ingressHost, BOT_ID, attributed)
    forwardSessionAction(internals.ingressHost, BOT_ID, action())

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
    expect(httpSlackActionMsgId(BOT_ID, action({ model: 'opus-4.8' }))).not.toBe(
      httpSlackActionMsgId(BOT_ID, action({ model: 'sonnet-5' }))
    )
  })

  it('uses distinct ids for two real clicks with different Slack action timestamps', () => {
    expect(
      httpSlackActionMsgId(BOT_ID, action({ interactionId: JSON.stringify(['ac_set_model', '1720000000.000200']) }))
    ).not.toBe(
      httpSlackActionMsgId(BOT_ID, action({ interactionId: JSON.stringify(['ac_set_model', '1720000000.000201']) }))
    )
  })

  it('rejects a tampered/stale target instead of falling back to the channel owner', () => {
    const sendMsg = vi.fn()
    const warn = vi.fn()
    const manager = new RelayIngressManager(
      deps({ getDaemon: () => ({ sendMsg }) as unknown as RelayDaemonConnection, log: { ...silentLog, warn } })
    )
    const internals = internalsOf(manager)
    internals.router.upsert(assignment())

    forwardSessionAction(
      internals.ingressHost,
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

describe('RelayIngressManager HTTP Lark / Feishu card actions', () => {
  it('forwards to the rendered integration and returns the daemon callback response', async () => {
    const response = { toast: { type: 'info' as const, content: 'Cancellation requested.' } }
    const sendMsg = vi.fn(async (msg: RdMsgPlatformAction): Promise<RdAck> => ({
      msgId: msg.msgId,
      accepted: true,
      // A fleet daemon answers a platform_action with the generic opaque slot.
      response
    }))
    const daemon = { sendMsg } as unknown as RelayDaemonConnection
    const manager = new RelayIngressManager(
      deps({ getDaemon: (daemonId) => (daemonId === DAEMON_ID ? daemon : undefined) })
    )
    const internals = internalsOf(manager)
    internals.router.upsert({
      botId: BOT_ID,
      platform: 'feishu',
      secrets: { verificationToken: 'verify-token' },
      apiAppId: 'cli_http_app',
      members: [
        { daemonId: DAEMON_ID, agentIds: [AGENT_ID] },
        { daemonId: OTHER_DAEMON_ID, agentIds: [OTHER_AGENT_ID] }
      ],
      agents: [
        {
          agentId: AGENT_ID,
          name: 'Agent',
          daemonId: DAEMON_ID,
          integrationId: INTEGRATION_ID
        },
        {
          agentId: OTHER_AGENT_ID,
          name: 'Review Agent',
          daemonId: OTHER_DAEMON_ID,
          integrationId: OTHER_INTEGRATION_ID
        }
      ],
      routes: []
    })
    const action: WireFeishuCardActionEvent = {
      context: { open_message_id: 'om_card', open_chat_id: 'oc_chat' },
      operator: { open_id: 'ou_human' },
      action: {
        tag: 'overflow',
        option: 'cancel',
        value: {
          action: 'agentconnect_reply',
          target: { v: 1, agentId: AGENT_ID, integrationId: INTEGRATION_ID }
        }
      }
    }

    await expect(forwardFeishuCardAction(internals.ingressHost, BOT_ID, action, 'evt-action')).resolves.toEqual(
      response
    )
    expect(sendMsg).toHaveBeenCalledWith({
      source: 'platform_action',
      platformId: 'feishu',
      agentId: AGENT_ID,
      integrationId: INTEGRATION_ID,
      sessionKey: 'feishu-action:om_card',
      msgId: httpFeishuActionMsgId(BOT_ID, 'evt-action', action),
      botId: BOT_ID,
      payload: action
    })
  })

  it('ignores the RETIRED Feishu-named ack slot — the generic response is the one answer', async () => {
    // S1b cleanup: the named slot left RdAck one release after every fleet daemon
    // began filling `response` (#521). An ack carrying only the stale key (which
    // the schema now strips) yields no callback body rather than resurrecting it.
    const response = { toast: { type: 'info' as const, content: 'Cancellation requested.' } }
    const sendMsg = vi.fn(
      async (msg: RdMsgPlatformAction): Promise<RdAck> =>
        ({ msgId: msg.msgId, accepted: true, feishuCardAction: response }) as RdAck
    )
    const daemon = { sendMsg } as unknown as RelayDaemonConnection
    const manager = new RelayIngressManager(
      deps({ getDaemon: (daemonId) => (daemonId === DAEMON_ID ? daemon : undefined) })
    )
    const internals = internalsOf(manager)
    internals.router.upsert({
      botId: BOT_ID,
      platform: 'feishu',
      secrets: { verificationToken: 'verify-token' },
      apiAppId: 'cli_http_app',
      members: [{ daemonId: DAEMON_ID, agentIds: [AGENT_ID] }],
      agents: [{ agentId: AGENT_ID, name: 'Agent', daemonId: DAEMON_ID, integrationId: INTEGRATION_ID }],
      routes: []
    })
    const action: WireFeishuCardActionEvent = {
      context: { open_message_id: 'om_card', open_chat_id: 'oc_chat' },
      operator: { open_id: 'ou_human' },
      action: { tag: 'overflow', option: 'cancel' }
    }
    await expect(forwardFeishuCardAction(internals.ingressHost, BOT_ID, action, 'evt-action')).resolves.toBeUndefined()
  })
})

describe('RelayIngressManager thread affinity (report + pull-on-miss)', () => {
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
    const manager = new RelayIngressManager(deps({ getDaemon: () => daemon, reportThreadAssign }))
    const internals = internalsOf(manager)
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

  it('persists an `auto` target as a participant without creating owner affinity', async () => {
    const reportThreadAssign = vi.fn(() => true)
    const reportThreadParticipant = vi.fn(() => true)
    const { daemon, sendMsg } = online()
    const manager = new RelayIngressManager(
      deps({ getDaemon: () => daemon, reportThreadAssign, reportThreadParticipant })
    )
    const internals = internalsOf(manager)
    internals.router.upsert(channelAutoOwned())

    await internals.forward(BOT_ID, followUp({ msgId: 'slack:C123:1720000000.000100' }))
    await internals.forward(BOT_ID, followUp())

    expect(sendMsg).toHaveBeenCalledTimes(2) // both delivered via the auto rung
    expect(reportThreadAssign).not.toHaveBeenCalled()
    expect(reportThreadParticipant).toHaveBeenCalledTimes(1) // join once, not per message
    expect(reportThreadParticipant).toHaveBeenCalledWith({
      botId: BOT_ID,
      sessionKey: 'C123/1720000000.000100',
      agentId: AGENT_ID,
      daemonId: DAEMON_ID
    })
  })

  it('derives explicit join and implicit participant causes per relay target', async () => {
    const first = vi.fn(async (m: RdMsgIm): Promise<RdAck> => ({ msgId: m.msgId, accepted: true }))
    const second = vi.fn(async (m: RdMsgIm): Promise<RdAck> => ({ msgId: m.msgId, accepted: true }))
    const daemon = (sendMsg: typeof first) => ({ sendMsg, supports: () => true }) as unknown as RelayDaemonConnection
    const manager = new RelayIngressManager(
      deps({
        getDaemon: (id) =>
          id === DAEMON_ID ? daemon(first) : id === OTHER_DAEMON_ID ? daemon(second as typeof first) : undefined
      })
    )
    const internals = internalsOf(manager)
    // The named primary is selected by an AUTO owner, not a mention rule. A human
    // still addressed this bot explicitly, so that target must get mention semantics.
    const shared = channelAutoOwned()
    shared.members.push({ daemonId: OTHER_DAEMON_ID, agentIds: [OTHER_AGENT_ID] })
    shared.agents.push({
      agentId: OTHER_AGENT_ID,
      name: 'Other',
      daemonId: OTHER_DAEMON_ID,
      integrationId: OTHER_INTEGRATION_ID
    })
    shared.routes.push({
      agentId: OTHER_AGENT_ID,
      daemonId: OTHER_DAEMON_ID,
      integrationId: OTHER_INTEGRATION_ID,
      scope: { channel: 'C123' },
      match: { kind: 'auto' }
    })
    internals.router.upsert(shared)

    await internals.forward(
      BOT_ID,
      followUp({ msgId: 'slack:C123:per-target', text: '<@UBOT> join', mentionedBots: ['UBOT'] })
    )
    expect(first.mock.calls[0]![0]).toMatchObject({ agentId: AGENT_ID, trustedRouteVia: 'mention' })
    expect(second.mock.calls[0]![0]).toMatchObject({ agentId: OTHER_AGENT_ID, trustedRouteVia: 'implicit' })
  })

  it('keeps an UNVERIFIED agent bot off routing but forwards an explicitly mentioning third-party bot', async () => {
    // send-message-routing-rework.md §4 fails closed: an AgentConnect app whose message
    // carries no provable authorship claim (here: no `agentAuthorship` metadata at all)
    // is not routable, even though it explicitly mentions the bot. A third-party bot
    // keeps its existing explicit-mention behavior.
    const { daemon, sendMsg } = online()
    const reportThreadAssign = vi.fn(() => true)
    const isAgentBotApp = vi.fn((_agentId: string, _platform: string, _channel: string, appId: string) => {
      return appId === 'AMANAGED'
    })
    const manager = new RelayIngressManager(deps({ getDaemon: () => daemon, reportThreadAssign, isAgentBotApp }))
    const internals = internalsOf(manager)
    const shared = channelAutoOwned()
    shared.members[0]!.agentIds.push(OTHER_AGENT_ID)
    shared.agents.push({ agentId: OTHER_AGENT_ID, name: 'Other' })
    shared.routes.push({
      agentId: OTHER_AGENT_ID,
      daemonId: DAEMON_ID,
      integrationId: OTHER_INTEGRATION_ID,
      scope: { channel: 'C123' },
      match: { kind: 'auto' }
    })
    internals.router.upsert(shared)

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

    // The third-party bot remains strict mention-only: it reaches the one arbitration
    // primary, not every auto/participant route on this AgentConnect-managed bot.
    expect(sendMsg).toHaveBeenCalledTimes(1)
    expect(sendMsg.mock.calls[0]![0]).toMatchObject({ msgId: 'slack:C123:external', agentId: AGENT_ID })
    expect(reportThreadAssign).not.toHaveBeenCalled()
  })

  // ── send-message-routing-rework.md §4 / §4.1 / §6 — verified agent authors ──
  describe('verified agent-authored routing', () => {
    const AUTHOR_ID = '99999999-9999-4999-8999-999999999999'
    const isOurApp = (appId: string) => appId === 'AMANAGED'

    /** A finalized agent response addressing AGENT_ID, from an app we back. */
    const agentFinal = (
      claim: Partial<NonNullable<WireNormalizedMessage['agentAuthorship']>> = {},
      over: { text?: string; mentionedBots?: string[] } = {}
    ) =>
      followUp({
        msgId: 'slack:C123:agentpost',
        sender: { id: 'UMANAGED', isBot: true, appId: 'AMANAGED' },
        text: over.text ?? '<@UBOT> please verify the rollout',
        mentionedBots: over.mentionedBots ?? ['UBOT'],
        agentAuthorship: {
          authorAgentId: AUTHOR_ID,
          responseId: 'r-1',
          deliveryState: 'final',
          hopCount: 3,
          mentionedAgentIds: [AGENT_ID],
          ...claim
        }
      })

    const managerWith = (
      over: Partial<RelayIngressManagerDeps> = {},
      sendMsg = vi.fn(async (m: RdMsg): Promise<RdAck> => ({ msgId: m.msgId, accepted: true })),
      // A current-build daemon advertises every rd/* capability. `supports` is what the
      // implicit path is gated on, so a test can pass `() => false` to model an older one.
      supports: (c: string) => boolean = () => true
    ) => {
      const daemon = { sendMsg, supports } as unknown as RelayDaemonConnection
      const manager = new RelayIngressManager(
        deps({
          getDaemon: () => daemon,
          isAgentBotApp: vi.fn((_a: string, _p: string, _c: string, appId: string) => isOurApp(appId)),
          ...over
        })
      )
      const internals = internalsOf(manager)
      internals.router.upsert(channelAutoOwned())
      return { internals, sendMsg }
    }

    it('routes a finalized mention to its recipient and mints the trusted claim', async () => {
      const { internals, sendMsg } = managerWith()
      await internals.forward(BOT_ID, agentFinal())

      expect(sendMsg).toHaveBeenCalledTimes(1)
      const frame = sendMsg.mock.calls[0]![0] as Record<string, unknown>
      expect(frame).toMatchObject({
        agentId: AGENT_ID,
        trustedFromAgentId: AUTHOR_ID,
        trustedResponseId: 'r-1',
        trustedRecipientAgentIds: [AGENT_ID],
        // §4.1 step 4: the relay adds exactly one, ONCE. The target installs this value
        // without incrementing again — doing so would halve the shared hop budget.
        trustedDeliveryHopCount: 4
      })
    })

    it('does not route a streaming post', async () => {
      // §5.4: an intermediate post may hold a prefix of the answer.
      const { internals, sendMsg } = managerWith()
      await internals.forward(BOT_ID, agentFinal({ deliveryState: 'streaming' }))
      expect(sendMsg).not.toHaveBeenCalled()
    })

    it('continues the conversation implicitly when the message addresses nobody', async () => {
      // §2.3: an agent message that names nobody takes the SAME ladder a human message
      // would — here the channel's `auto` rung. This is what lets agents converse without
      // having to name each other in every line.
      const { internals, sendMsg } = managerWith()
      await internals.forward(
        BOT_ID,
        agentFinal({ mentionedAgentIds: [] }, { text: 'that matches what I saw', mentionedBots: [] })
      )
      expect(sendMsg).toHaveBeenCalledTimes(1)
      expect(sendMsg.mock.calls[0]![0]).toMatchObject({ agentId: AGENT_ID, trustedFromAgentId: AUTHOR_ID })
    })

    it('never selects the author as the target, on either path', async () => {
      // The one absolute in §2.3. Self-activation is not a loop that the hop cap slows
      // down — it is unconditional, since the agent's own reply always matches its own
      // rule. Holds for an explicit self-mention AND for the implicit fallback.
      // A response naming ONLY its author has still addressed the conversation, so it
      // activates nobody rather than continuing to whoever the `auto` rung would pick.
      // Judging emptiness after the author filter would make these two indistinguishable.
      const explicit = managerWith()
      await explicit.internals.forward(BOT_ID, agentFinal({ mentionedAgentIds: [AUTHOR_ID] }))
      for (const call of explicit.sendMsg.mock.calls) {
        expect((call[0] as { agentId: string }).agentId).not.toBe(AUTHOR_ID)
      }

      // With the author as the channel's ONLY route, the implicit rung has nobody left to
      // pick — and must resolve to nothing rather than back to the author.
      const alone = managerWith()
      const selfOnly = channelAutoOwned()
      selfOnly.routes = selfOnly.routes.map((r) => ({ ...r, agentId: AUTHOR_ID }))
      selfOnly.defaultAgentId = AUTHOR_ID
      alone.internals.router.upsert(selfOnly)
      await alone.internals.forward(
        BOT_ID,
        agentFinal({ mentionedAgentIds: [] }, { text: 'that matches what I saw', mentionedBots: [] })
      )
      expect(alone.sendMsg).not.toHaveBeenCalled()
    })

    it('refuses a claimed author the sending app does not back', async () => {
      // §4 condition 3. A shared app backs several agents, so "the app is ours" alone
      // would let one tenant author messages as any of its co-tenants.
      const { internals, sendMsg } = managerWith({
        isAgentBotApp: vi.fn((agentId: string) => agentId === AGENT_ID)
      })
      await internals.forward(BOT_ID, agentFinal())
      expect(sendMsg).not.toHaveBeenCalled()
    })

    it('does not route into a channel the operator switched Off', async () => {
      // product-conventions "Per-channel trigger": Off means the agent does not respond
      // there at all — "not to an @-mention". The verified-agent path bypasses the
      // arbitration ladder that normally enforces this, so it must apply the fence itself
      // or an agent mention becomes the one way into a silenced channel.
      const { internals, sendMsg } = managerWith()
      const muted = channelAutoOwned()
      muted.mutedChannels = ['C123']
      internals.router.upsert(muted)
      await internals.forward(BOT_ID, agentFinal())
      expect(sendMsg).not.toHaveBeenCalled()
    })

    it('re-checks call policy per edge', async () => {
      const { internals, sendMsg } = managerWith({ admitsAgentCall: vi.fn(() => false) })
      await internals.forward(BOT_ID, agentFinal())
      expect(sendMsg).not.toHaveBeenCalled()
    })

    it('refuses to forward an implicit continuation to a daemon that predates the field', async () => {
      // §8.4 fail-closed. An older daemon ignores `trustedRouteVia` and reads every
      // agent-authored delivery as an explicit mention, which CLEARS a `!stop` mute — so
      // during a mixed-version rollout the human's stop control would silently stop
      // working. Refusing degrades to the pre-change behavior instead.
      const older = managerWith({}, undefined, () => false)
      await older.internals.forward(
        BOT_ID,
        agentFinal({ mentionedAgentIds: [] }, { text: 'that matches what I saw', mentionedBots: [] })
      )
      expect(older.sendMsg).not.toHaveBeenCalled()

      // A body that names a peer is no different — delivery is arbitration-selected either
      // way, so an older daemon must not receive that either.
      const explicit = managerWith({}, undefined, () => false)
      await explicit.internals.forward(BOT_ID, agentFinal())
      expect(explicit.sendMsg).not.toHaveBeenCalled()
    })

    it('routes a PAIRED delivery to the exact agent `sendMessage` named', async () => {
      // The one target that is structured rather than parsed. Arbitration could pick the
      // channel default or thread owner instead, which would record the visible
      // observation against an agent the internal wake never names — the rendezvous would
      // then never reconcile and the delivery would expire transcript-only.
      const { internals, sendMsg } = managerWith()
      await internals.forward(
        BOT_ID,
        agentFinal(
          { mentionedAgentIds: [AGENT_ID], agentCallDeliveryId: 'd-7' },
          { text: 'take a look', mentionedBots: [] }
        )
      )
      expect(sendMsg).toHaveBeenCalledTimes(1)
      expect(sendMsg.mock.calls[0]![0]).toMatchObject({
        agentId: AGENT_ID,
        trustedAgentCallDeliveryId: 'd-7',
        trustedRouteVia: 'mention'
      })
    })

    it('forwards a PAIRED self observation before ordinary author exclusion', async () => {
      const { internals, sendMsg } = managerWith({ admitsAgentCall: vi.fn(() => false) })
      const selfOwned = channelAutoOwned()
      selfOwned.routes[selfOwned.routes.length - 1]!.agentId = AUTHOR_ID
      internals.router.upsert(selfOwned)

      await internals.forward(
        BOT_ID,
        agentFinal(
          { mentionedAgentIds: [AUTHOR_ID], agentCallDeliveryId: 'd-self' },
          { text: 'continue here', mentionedBots: [] }
        )
      )

      expect(sendMsg).toHaveBeenCalledTimes(1)
      expect(sendMsg.mock.calls[0]![0]).toMatchObject({
        agentId: AUTHOR_ID,
        trustedFromAgentId: AUTHOR_ID,
        trustedRecipientAgentIds: [AUTHOR_ID],
        trustedAgentCallDeliveryId: 'd-self'
      })
    })

    it('always reports the delivery as implicitly selected', async () => {
      // Every agent-authored forward is arbitration-selected now, mention in the body or
      // not — the target needs that fact to apply its `!stop` gate correctly.
      const mention = managerWith()
      await mention.internals.forward(BOT_ID, agentFinal())
      expect(mention.sendMsg.mock.calls[0]![0]).toMatchObject({ trustedRouteVia: 'implicit' })

      const implicit = managerWith()
      await implicit.internals.forward(
        BOT_ID,
        agentFinal({ mentionedAgentIds: [] }, { text: 'that matches what I saw', mentionedBots: [] })
      )
      expect(implicit.sendMsg.mock.calls[0]![0]).toMatchObject({ trustedRouteVia: 'implicit' })
    })

    it('fans a shared-bot conversation across daemons after the primary becomes ambiguous', async () => {
      const firstDaemonSend = vi.fn(async (m: RdMsgIm): Promise<RdAck> => ({ msgId: m.msgId, accepted: true }))
      const secondDaemonSend = vi.fn(async (m: RdMsgIm): Promise<RdAck> => ({ msgId: m.msgId, accepted: true }))
      const currentDaemon = (sendMsg: typeof firstDaemonSend) =>
        ({ sendMsg, supports: () => true }) as unknown as RelayDaemonConnection
      const manager = new RelayIngressManager(
        deps({
          getDaemon: (daemonId) =>
            daemonId === DAEMON_ID
              ? currentDaemon(firstDaemonSend)
              : daemonId === OTHER_DAEMON_ID
                ? currentDaemon(secondDaemonSend as typeof firstDaemonSend)
                : undefined,
          isAgentBotApp: vi.fn(() => true)
        })
      )
      const internals = internalsOf(manager)
      const shared = assignment()
      shared.botUserId = 'UBOT'
      shared.members.push({ daemonId: OTHER_DAEMON_ID, agentIds: [OTHER_AGENT_ID] })
      shared.agents = [
        { agentId: AGENT_ID, name: 'Agent', daemonId: DAEMON_ID, integrationId: INTEGRATION_ID },
        {
          agentId: OTHER_AGENT_ID,
          name: 'Other',
          daemonId: OTHER_DAEMON_ID,
          integrationId: OTHER_INTEGRATION_ID
        }
      ]
      shared.routes = [
        {
          agentId: AGENT_ID,
          daemonId: DAEMON_ID,
          integrationId: INTEGRATION_ID,
          scope: { channel: 'C123' },
          match: { kind: 'mention' }
        },
        {
          agentId: OTHER_AGENT_ID,
          daemonId: OTHER_DAEMON_ID,
          integrationId: OTHER_INTEGRATION_ID,
          scope: { channel: 'C123' },
          match: { kind: 'mention' }
        }
      ]
      internals.router.upsert(shared)

      // One human mention joins BOTH matching routes, with an independent explicit cause.
      await internals.forward(
        BOT_ID,
        followUp({ msgId: 'slack:C123:join', text: '<@UBOT> both of you', mentionedBots: ['UBOT'] })
      )
      expect(firstDaemonSend).toHaveBeenCalledTimes(1)
      expect(secondDaemonSend).toHaveBeenCalledTimes(1)
      expect(firstDaemonSend.mock.calls[0]![0]).toMatchObject({
        agentId: AGENT_ID,
        trustedRouteVia: 'mention'
      })
      expect(secondDaemonSend.mock.calls[0]![0]).toMatchObject({
        agentId: OTHER_AGENT_ID,
        trustedRouteVia: 'mention'
      })

      firstDaemonSend.mockClear()
      secondDaemonSend.mockClear()
      // The remembered single affinity points at the author and is therefore unusable;
      // both mention-only routes also match no rung. Participant state is the only path
      // that can carry this unmentioned reply to the peer on the other daemon.
      await internals.forward(
        BOT_ID,
        agentFinal(
          { authorAgentId: AGENT_ID, mentionedAgentIds: [], hopCount: 4 },
          { text: 'continuing without a mention', mentionedBots: [] }
        )
      )
      expect(firstDaemonSend).not.toHaveBeenCalled()
      expect(secondDaemonSend).toHaveBeenCalledTimes(1)
      expect(secondDaemonSend.mock.calls[0]![0]).toMatchObject({
        agentId: OTHER_AGENT_ID,
        trustedFromAgentId: AGENT_ID,
        trustedRouteVia: 'implicit',
        trustedDeliveryHopCount: 5
      })
    })

    it('joins a resolved peer on the production scoped-owner plus unscoped-slug route shape', async () => {
      const first = vi.fn(async (m: RdMsgIm): Promise<RdAck> => ({ msgId: m.msgId, accepted: true }))
      const second = vi.fn(async (m: RdMsgIm): Promise<RdAck> => ({ msgId: m.msgId, accepted: true }))
      const daemon = (sendMsg: typeof first) => ({ sendMsg, supports: () => true }) as unknown as RelayDaemonConnection
      const manager = new RelayIngressManager(
        deps({
          getDaemon: (id) =>
            id === DAEMON_ID ? daemon(first) : id === OTHER_DAEMON_ID ? daemon(second as typeof first) : undefined,
          isAgentBotApp: vi.fn(() => true)
        })
      )
      const internals = internalsOf(manager)
      const shared = assignment()
      shared.members.push({ daemonId: OTHER_DAEMON_ID, agentIds: [OTHER_AGENT_ID] })
      shared.agents.push({
        agentId: OTHER_AGENT_ID,
        name: 'Other',
        daemonId: OTHER_DAEMON_ID,
        integrationId: OTHER_INTEGRATION_ID
      })
      shared.routes = [
        {
          agentId: AGENT_ID,
          daemonId: DAEMON_ID,
          integrationId: INTEGRATION_ID,
          scope: { channel: 'C123' },
          match: { kind: 'auto' }
        },
        {
          agentId: OTHER_AGENT_ID,
          daemonId: OTHER_DAEMON_ID,
          integrationId: OTHER_INTEGRATION_ID,
          match: { kind: 'keyword', value: 'other' }
        }
      ]
      internals.router.upsert(shared)

      await internals.forward(
        BOT_ID,
        agentFinal(
          { mentionedAgentIds: [OTHER_AGENT_ID] },
          { text: '<@opaque-other> please join', mentionedBots: ['UBOT'] }
        )
      )

      expect(first).toHaveBeenCalledTimes(1)
      expect(second).toHaveBeenCalledTimes(1)
      expect(second.mock.calls[0]![0]).toMatchObject({
        agentId: OTHER_AGENT_ID,
        trustedRouteVia: 'implicit',
        trustedFromAgentId: AUTHOR_ID
      })
    })

    it('does not remember or persist a policy-denied join for a later human follow-up', async () => {
      const first = vi.fn(async (m: RdMsgIm): Promise<RdAck> => ({ msgId: m.msgId, accepted: true }))
      const second = vi.fn(async (m: RdMsgIm): Promise<RdAck> => ({ msgId: m.msgId, accepted: true }))
      const daemon = (sendMsg: typeof first) => ({ sendMsg, supports: () => true }) as unknown as RelayDaemonConnection
      const reportThreadParticipant = vi.fn(() => true)
      const manager = new RelayIngressManager(
        deps({
          getDaemon: (id) =>
            id === DAEMON_ID ? daemon(first) : id === OTHER_DAEMON_ID ? daemon(second as typeof first) : undefined,
          isAgentBotApp: vi.fn(() => true),
          admitsAgentCall: vi.fn((_author, target) => target !== OTHER_AGENT_ID),
          reportThreadParticipant
        })
      )
      const internals = internalsOf(manager)
      const shared = assignment()
      shared.members.push({ daemonId: OTHER_DAEMON_ID, agentIds: [OTHER_AGENT_ID] })
      shared.agents.push({
        agentId: OTHER_AGENT_ID,
        name: 'Other',
        daemonId: OTHER_DAEMON_ID,
        integrationId: OTHER_INTEGRATION_ID
      })
      shared.routes = [
        {
          agentId: AGENT_ID,
          daemonId: DAEMON_ID,
          integrationId: INTEGRATION_ID,
          scope: { channel: 'C123' },
          match: { kind: 'auto' }
        },
        {
          agentId: OTHER_AGENT_ID,
          daemonId: OTHER_DAEMON_ID,
          integrationId: OTHER_INTEGRATION_ID,
          match: { kind: 'keyword', value: 'other' }
        }
      ]
      internals.router.upsert(shared)

      await internals.forward(
        BOT_ID,
        agentFinal(
          { mentionedAgentIds: [OTHER_AGENT_ID] },
          { text: '<@opaque-other> please join', mentionedBots: ['UBOT'] }
        )
      )

      expect(second).not.toHaveBeenCalled()
      expect(reportThreadParticipant).not.toHaveBeenCalledWith(expect.objectContaining({ agentId: OTHER_AGENT_ID }))

      first.mockClear()
      await internals.forward(BOT_ID, followUp({ msgId: 'slack:C123:human-after-denied-join' }))
      expect(first).toHaveBeenCalledTimes(1)
      expect(second).not.toHaveBeenCalled()
    })

    it('admits a delivery below the cap and rejects one that reaches the cap', async () => {
      // §10 case 15 — the boundary the whole hop transition exists to hold. Derived from
      // MAX_AGENT_CALL_HOPS so retuning the budget cannot leave this transport behind.
      const admitted = managerWith()
      await admitted.internals.forward(BOT_ID, agentFinal({ hopCount: MAX_AGENT_CALL_HOPS - 2 }))
      expect(admitted.sendMsg.mock.calls[0]![0]).toMatchObject({
        trustedDeliveryHopCount: MAX_AGENT_CALL_HOPS - 1
      })

      const rejected = managerWith()
      await rejected.internals.forward(BOT_ID, agentFinal({ hopCount: MAX_AGENT_CALL_HOPS - 1 }))
      expect(rejected.sendMsg).not.toHaveBeenCalled()
    })

    it('rejects an unusable source depth instead of resetting it to zero', async () => {
      // §4.1 rule 1. Coercing to 0 would hand a runaway chain a fresh budget every hop.
      for (const hopCount of [-1, 1.5]) {
        const { internals, sendMsg } = managerWith()
        await internals.forward(BOT_ID, agentFinal({ hopCount }))
        expect(sendMsg).not.toHaveBeenCalled()
      }
    })
  })

  it('retries a report dropped while the CP link was down, on reconnect', async () => {
    let ready = false
    const reportThreadAssign = vi.fn(() => ready) // false ⇒ "link not READY, dropped"
    const { daemon } = online()
    const manager = new RelayIngressManager(deps({ getDaemon: () => daemon, reportThreadAssign }))
    const internals = internalsOf(manager)
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
    const manager = new RelayIngressManager(deps({ reportBotChannels }))
    const internals = internalsOf(manager)
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
  it('retries an unacknowledged revocation on a READY link — no reconnect needed', async () => {
    vi.useFakeTimers()
    try {
      let committed = false
      const reportBotRevoked = vi.fn(async () => committed)
      const manager = new RelayIngressManager(deps({ reportBotRevoked }))
      const internals = internalsOf(manager)
      const report = { botId: BOT_ID, reason: 'app_uninstalled' as const, credentialRevision: 3 }

      // The CP answers a retryable error (transient DB failure) but the socket
      // stays READY — onReady never fires, so the manager's own timer must drive it.
      internals.reportRevoked(report)
      await vi.advanceTimersByTimeAsync(0)
      expect(reportBotRevoked).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(5_000) // first backoff step
      expect(reportBotRevoked).toHaveBeenCalledTimes(2)

      committed = true
      await vi.advanceTimersByTimeAsync(10_000) // second step — acked now
      expect(reportBotRevoked).toHaveBeenCalledTimes(3)
      expect(reportBotRevoked).toHaveBeenLastCalledWith(report)

      await vi.advanceTimersByTimeAsync(120_000) // queue drained ⇒ timer disarmed
      expect(reportBotRevoked).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a delayed OLDER revoke cannot supersede the newer queued report', async () => {
    vi.useFakeTimers()
    try {
      const calls: Array<{ credentialRevision?: number }> = []
      let commitNext = false
      const reportBotRevoked = vi.fn(async (m: { credentialRevision?: number }) => {
        calls.push(m)
        return commitNext
      })
      const manager = new RelayIngressManager(deps({ reportBotRevoked }))
      const internals = internalsOf(manager)
      const current = { botId: BOT_ID, reason: 'app_uninstalled' as const, credentialRevision: 2 }
      const delayed = { botId: BOT_ID, reason: 'app_uninstalled' as const, credentialRevision: 1 }

      // The CURRENT generation's report fails transiently — it stays queued.
      internals.reportRevoked(current)
      await vi.advanceTimersByTimeAsync(0)
      expect(reportBotRevoked).toHaveBeenCalledTimes(1)

      // Slack delivers the PRE-reinstall event late. It must neither replace the
      // queued report (its terminal applied:false ack would clear the queue and
      // lose the live revocation) nor be sent on its own (the newer subsumes it).
      internals.reportRevoked(delayed)
      await vi.advanceTimersByTimeAsync(0)
      expect(reportBotRevoked).toHaveBeenCalledTimes(1)

      // The retry timer re-drives the CURRENT report, which now commits.
      commitNext = true
      await vi.advanceTimersByTimeAsync(5_000)
      expect(reportBotRevoked).toHaveBeenCalledTimes(2)
      expect(calls[1]).toEqual(current)

      await vi.advanceTimersByTimeAsync(120_000) // drained — nothing left to retry
      expect(reportBotRevoked).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a queued no-timestamp probe report outranks a same-generation timestamped event', async () => {
    vi.useFakeTimers()
    try {
      let commitNext = false
      const reportBotRevoked = vi.fn(async () => commitNext)
      const manager = new RelayIngressManager(deps({ reportBotRevoked }))
      const internals = internalsOf(manager)
      // The auth.test dead-credential backstop: exact current revision, NO
      // eventAtMs — "dead NOW", unconditional on the CP's time arm.
      const probe = { botId: BOT_ID, reason: 'tokens_revoked' as const, credentialRevision: 2 }
      // A delayed lifecycle event of the SAME generation whose timestamp may
      // predate the credential — the CP's time arm can refuse it terminally.
      const delayed = { botId: BOT_ID, reason: 'app_uninstalled' as const, credentialRevision: 2, eventAtMs: 1_000 }

      internals.reportRevoked(probe) // transient failure ⇒ stays queued
      await vi.advanceTimersByTimeAsync(0)
      expect(reportBotRevoked).toHaveBeenCalledTimes(1)

      // The weaker, refusable report must not displace the probe.
      internals.reportRevoked(delayed)
      await vi.advanceTimersByTimeAsync(0)
      expect(reportBotRevoked).toHaveBeenCalledTimes(1)

      // The retry re-drives the PROBE report, which commits.
      commitNext = true
      await vi.advanceTimersByTimeAsync(5_000)
      expect(reportBotRevoked).toHaveBeenCalledTimes(2)
      expect(reportBotRevoked).toHaveBeenLastCalledWith(probe)

      // …while an incoming NO-timestamp report may replace a queued timestamped
      // one (it is at least as strong).
      internals.reportRevoked(delayed)
      internals.reportRevoked(probe)
      await vi.advanceTimersByTimeAsync(0)
      expect(reportBotRevoked).toHaveBeenLastCalledWith(probe)
    } finally {
      vi.useRealTimers()
    }
  })

  it('same-generation ordering falls back to the event timestamp', async () => {
    vi.useFakeTimers()
    try {
      const reportBotRevoked = vi.fn(async () => false) // keep everything queued
      const manager = new RelayIngressManager(deps({ reportBotRevoked }))
      const internals = internalsOf(manager)
      const newer = { botId: BOT_ID, reason: 'tokens_revoked' as const, credentialRevision: 2, eventAtMs: 2_000 }
      const older = { botId: BOT_ID, reason: 'app_uninstalled' as const, credentialRevision: 2, eventAtMs: 1_000 }

      internals.reportRevoked(newer)
      internals.reportRevoked(older) // same generation, earlier occurrence — dropped
      await vi.advanceTimersByTimeAsync(0)
      expect(reportBotRevoked).toHaveBeenCalledTimes(1)

      // The retry still drives the newer one.
      await vi.advanceTimersByTimeAsync(5_000)
      expect(reportBotRevoked).toHaveBeenCalledTimes(2)
      expect(reportBotRevoked).toHaveBeenLastCalledWith(newer)
    } finally {
      vi.useRealTimers()
    }
  })

  it('an old in-flight ack cannot erase the NEWER queued report for the same bot', async () => {
    vi.useFakeTimers()
    try {
      const resolvers: Array<(v: boolean) => void> = []
      const reportBotRevoked = vi.fn(() => new Promise<boolean>((resolve) => resolvers.push(resolve)))
      const manager = new RelayIngressManager(deps({ reportBotRevoked }))
      const internals = internalsOf(manager)
      const first = { botId: BOT_ID, reason: 'app_uninstalled' as const, credentialRevision: 1 }
      // A reinstall bumped the generation and a SECOND revoke observed it — this
      // replaces the queue entry while the first report is still in flight.
      const second = { botId: BOT_ID, reason: 'tokens_revoked' as const, credentialRevision: 2 }

      internals.reportRevoked(first)
      internals.reportRevoked(second)
      expect(reportBotRevoked).toHaveBeenCalledTimes(2)

      // The FIRST report's terminal ack lands late. Deleting by botId alone here
      // would erase `second` — the only signal its dead credential ever produced.
      resolvers[0]!(true)
      await vi.advanceTimersByTimeAsync(0)

      // Still queued, and the retry timer re-drives it.
      await vi.advanceTimersByTimeAsync(5_000)
      expect(reportBotRevoked).toHaveBeenCalledTimes(3)
      expect(reportBotRevoked).toHaveBeenLastCalledWith(second)

      // Its own ack (any of the in-flight copies) clears it for good.
      resolvers[1]!(true)
      resolvers[2]!(true)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(reportBotRevoked).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('pulls the persisted owner from the CP on an un-mentioned thread follow-up and forwards it', async () => {
    const { daemon, sendMsg } = online()
    const lookupThread = vi.fn(async (): Promise<RcThreadLookupOk> => ({
      botId: BOT_ID,
      sessionKey: 'C123/1720000000.000100',
      target: { agentId: AGENT_ID, daemonId: DAEMON_ID },
      participants: [{ agentId: AGENT_ID, daemonId: DAEMON_ID }]
    }))
    const reportThreadAssign = vi.fn(() => true)
    const manager = new RelayIngressManager(deps({ getDaemon: () => daemon, lookupThread, reportThreadAssign }))
    const internals = internalsOf(manager)
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

  it('restores every durable participant from CP lookup after a relay restart', async () => {
    const first = vi.fn(async (m: RdMsgIm): Promise<RdAck> => ({ msgId: m.msgId, accepted: true }))
    const second = vi.fn(async (m: RdMsgIm): Promise<RdAck> => ({ msgId: m.msgId, accepted: true }))
    const daemon = (sendMsg: typeof first) => ({ sendMsg, supports: () => true }) as unknown as RelayDaemonConnection
    const lookupThread = vi.fn(async (): Promise<RcThreadLookupOk> => ({
      botId: BOT_ID,
      sessionKey: 'C123/1720000000.000100',
      target: null,
      participants: [
        { agentId: AGENT_ID, daemonId: DAEMON_ID },
        { agentId: OTHER_AGENT_ID, daemonId: OTHER_DAEMON_ID }
      ]
    }))
    const manager = new RelayIngressManager(
      deps({
        lookupThread,
        getDaemon: (id) =>
          id === DAEMON_ID ? daemon(first) : id === OTHER_DAEMON_ID ? daemon(second as typeof first) : undefined
      })
    )
    const internals = internalsOf(manager)
    const shared = assignment()
    shared.members.push({ daemonId: OTHER_DAEMON_ID, agentIds: [OTHER_AGENT_ID] })
    shared.agents.push({
      agentId: OTHER_AGENT_ID,
      name: 'Other',
      daemonId: OTHER_DAEMON_ID,
      integrationId: OTHER_INTEGRATION_ID
    })
    shared.routes = [
      {
        agentId: AGENT_ID,
        daemonId: DAEMON_ID,
        integrationId: INTEGRATION_ID,
        match: { kind: 'mention' }
      },
      {
        agentId: OTHER_AGENT_ID,
        daemonId: OTHER_DAEMON_ID,
        integrationId: OTHER_INTEGRATION_ID,
        match: { kind: 'mention' }
      }
    ]
    internals.router.upsert(shared)

    await internals.forward(BOT_ID, followUp())

    expect(lookupThread).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(first.mock.calls[0]![0]).toMatchObject({ agentId: AGENT_ID, trustedRouteVia: 'implicit' })
    expect(second.mock.calls[0]![0]).toMatchObject({ agentId: OTHER_AGENT_ID, trustedRouteVia: 'implicit' })
  })

  it('remembers a CP miss and does not re-hit the CP for the same un-owned thread', async () => {
    const lookupThread = vi.fn(async (): Promise<RcThreadLookupOk> => ({
      botId: BOT_ID,
      sessionKey: 'C123/1720000000.000100',
      target: null,
      participants: []
    }))
    const { daemon, sendMsg } = online()
    const manager = new RelayIngressManager(deps({ getDaemon: () => daemon, lookupThread }))
    const internals = internalsOf(manager)
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

describe('RelayIngressManager conversation gating (resource-visibility §14.3)', () => {
  const fakeIngest = () => {
    const lookupUserName = vi.fn(async (_userId: string) => '@Alice')
    const postText = vi.fn(async (_channelId: string, _text: string, _threadTs?: string) => {})
    // Mirrors SlackHttpIngest: the contract egress facet delegates to the
    // platform client methods (the manager only ever sees the facet).
    return { lookupUserName, postText, egress: { notice: postText, lookupUserName } }
  }
  const gatedAssignment = (): BotAssignment => ({
    botId: BOT_ID,
    platform: 'slack',
    secrets: { botToken: 'xoxb', signingSecret: 'ssecret' },
    botUserId: 'UBOT',
    members: [{ daemonId: DAEMON_ID, agentIds: [AGENT_ID] }],
    agents: [{ agentId: AGENT_ID, name: 'Agent', daemonId: DAEMON_ID, integrationId: INTEGRATION_ID }],
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
    const manager = new RelayIngressManager(deps({ reportBotConversation }))
    const internals = internalsOf(manager)
    internals.router.upsert(gatedAssignment())
    const ingest = fakeIngest()
    internals.slackPool.set(BOT_ID, ingest)

    await internals.forward(BOT_ID, dm())
    // `dmUserId` rides the report (§14.8): a 1:1 DM's whole human membership, and the
    // only thing that lets the CP match it against a private agent's own audience.
    expect(reportBotConversation).toHaveBeenCalledWith({
      botId: BOT_ID,
      conversation: { id: 'D42', name: '@Alice', dmUserId: 'U1', kind: 'im' }
    })
    expect(ingest.postText).toHaveBeenCalledTimes(1)
    expect(ingest.postText.mock.calls[0]![0]).toBe('D42')

    // Second DM: report is latched per conversation (CP row exists), notice too.
    await internals.forward(BOT_ID, dm({ msgId: 'slack:D42:1720000000.000200' }))
    expect(reportBotConversation).toHaveBeenCalledTimes(1)
    expect(ingest.postText).toHaveBeenCalledTimes(1)
  })

  it('a first gated DM on a NON-authority pod still posts (single event copy, receiving pod owns it)', async () => {
    const manager = new RelayIngressManager(deps({ selfRelayId: () => PEER_RELAY }))
    const internals = internalsOf(manager)
    internals.router.upsert(gatedAssignment()) // noticeAuthority = SELF_RELAY, not this pod
    const ingest = fakeIngest()
    internals.slackPool.set(BOT_ID, ingest)

    await internals.forward(BOT_ID, dm())
    expect(ingest.postText).toHaveBeenCalledTimes(1)
  })

  it('a DM whose notice was already DELIVERED (noticedDmConversations) is latched on EVERY pod', async () => {
    const manager = new RelayIngressManager(deps())
    const internals = internalsOf(manager)
    const a = gatedAssignment()
    a.noticedDmConversations = ['D42'] // delivery reported + re-stamped by the CP
    internals.router.upsert(a)
    const ingest = fakeIngest()
    internals.slackPool.set(BOT_ID, ingest)

    await internals.forward(BOT_ID, dm())
    expect(ingest.postText).not.toHaveBeenCalled()
  })

  it('a DM discovered while a public default routed it STILL gets its notice once unroutable', async () => {
    const reportNoticePosted = vi.fn(() => true)
    const daemon = { sendMsg: vi.fn(async (m: { msgId: string }) => ({ msgId: m.msgId, accepted: true })) }
    const manager = new RelayIngressManager(
      deps({ reportNoticePosted, getDaemon: () => daemon as unknown as RelayDaemonConnection })
    )
    const internals = internalsOf(manager)
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
    internals.slackPool.set(BOT_ID, ingest)

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
    const manager = new RelayIngressManager(deps({ reportBotConversation }))
    const internals = internalsOf(manager)
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
    internals.slackPool.set(BOT_ID, ingest)

    await internals.forward(BOT_ID, dm())
    // The DM routed to the public default — the gated install still needs its
    // pending Off row, but nothing was unrouted so there is NO notice.
    expect(reportBotConversation).toHaveBeenCalledWith({
      botId: BOT_ID,
      conversation: { id: 'D42', name: '@Alice', dmUserId: 'U1', kind: 'im' }
    })
    expect(ingest.postText).not.toHaveBeenCalled()
  })

  it('resets the DM-report latch when the install set changes (new install needs its row)', async () => {
    const reportBotConversation = vi.fn(() => true)
    const manager = new RelayIngressManager(deps({ reportBotConversation }))
    const internals = internalsOf(manager)
    const a = gatedAssignment()
    internals.router.upsert(a)
    internals.slackPool.set(BOT_ID, fakeIngest())

    await internals.forward(BOT_ID, dm())
    expect(reportBotConversation).toHaveBeenCalledTimes(1) // latched for this assignment

    const changedAgents = [
      ...a.agents,
      {
        agentId: OTHER_AGENT_ID,
        name: 'Public',
        daemonId: OTHER_DAEMON_ID,
        integrationId: OTHER_INTEGRATION_ID
      }
    ]
    // A routes update with a changed install set invalidates the latch so the next
    // DM fans out the new install's row, regardless of visibility.
    manager.updateRoutes(BOT_ID, {
      members: a.members,
      agents: changedAgents,
      routes: a.routes,
      gatedAgentIds: [AGENT_ID]
    })
    await internals.forward(BOT_ID, dm({ msgId: 'slack:D42:1720000000.000200' }))
    expect(reportBotConversation).toHaveBeenCalledTimes(2)

    // An unchanged install set keeps the latch.
    manager.updateRoutes(BOT_ID, {
      members: a.members,
      agents: changedAgents,
      routes: a.routes,
      gatedAgentIds: []
    })
    await internals.forward(BOT_ID, dm({ msgId: 'slack:D42:1720000000.000300' }))
    expect(reportBotConversation).toHaveBeenCalledTimes(2)
  })

  it('retries the DM report on the next DM when the CP link was down', async () => {
    let ready = false
    const reportBotConversation = vi.fn(() => ready)
    const manager = new RelayIngressManager(deps({ reportBotConversation }))
    const internals = internalsOf(manager)
    internals.router.upsert(gatedAssignment())
    internals.slackPool.set(BOT_ID, fakeIngest())

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
    const manager = new RelayIngressManager(deps({ reportBotConversation }))
    const internals = internalsOf(manager)
    internals.router.upsert(gatedAssignment())
    const ingest = fakeIngest()
    internals.slackPool.set(BOT_ID, ingest)

    await internals.forward(
      BOT_ID,
      dm({ channel: 'C9', isDm: false, thread: '123.456', text: '<@UBOT> hello', mentionedBots: ['UBOT'] })
    )
    expect(reportBotConversation).not.toHaveBeenCalled()
    expect(ingest.postText).toHaveBeenCalledTimes(1)
    expect(ingest.postText.mock.calls[0]![2]).toBe('123.456') // threaded, no channel spam
  })

  it('hands an unrouted gated Feishu mention to its daemon for discovery and notice egress', async () => {
    const sendMsg = vi.fn(async (m: { msgId: string }): Promise<RdAck> => ({ msgId: m.msgId, accepted: true }))
    const manager = new RelayIngressManager(
      deps({ getDaemon: () => ({ sendMsg }) as unknown as RelayDaemonConnection })
    )
    const internals = internalsOf(manager)
    const assigned: BotAssignment = {
      botId: BOT_ID,
      platform: 'feishu',
      secrets: { verificationToken: 'verify-token' },
      apiAppId: 'cli_http_app',
      botUserId: 'ou_bot',
      members: [{ daemonId: DAEMON_ID, agentIds: [AGENT_ID] }],
      agents: [
        {
          agentId: AGENT_ID,
          name: 'Agent',
          daemonId: DAEMON_ID,
          integrationId: INTEGRATION_ID
        }
      ],
      routes: [],
      gatedAgentIds: [AGENT_ID]
    }
    internals.router.upsert(assigned)

    // A notice-posted or channel update arrives as `rc/routes` and fully replaces
    // the directory. Keep the daemon/integration coordinates needed by the
    // receive-only Feishu fallback after that hot update.
    manager.updateRoutes(BOT_ID, {
      members: assigned.members,
      agents: mapAgentDirectory([
        {
          agentId: AGENT_ID,
          name: 'Agent',
          daemonId: DAEMON_ID,
          integrationId: INTEGRATION_ID
        }
      ]),
      routes: [],
      gatedAgentIds: [AGENT_ID],
      noticedDmConversations: ['oc_previous']
    })

    const payload = dm({
      msgId: 'feishu:oc_1:om_1',
      platform: 'feishu',
      channel: 'oc_1',
      isDm: false,
      thread: 'om_1',
      text: '@Agent hello',
      mentionedBots: ['ou_bot']
    })
    await internals.forward(BOT_ID, payload)

    expect(sendMsg).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'im',
        agentId: AGENT_ID,
        integrationId: INTEGRATION_ID,
        payload
      })
    )
  })

  /** Two manager instances = two relay pods; only the authority pod may post. */
  const pod = (authority: boolean) => {
    const manager = new RelayIngressManager(deps({ selfRelayId: () => (authority ? SELF_RELAY : PEER_RELAY) }))
    const internals = internalsOf(manager)
    const ingest = fakeIngest()
    internals.router.upsert(gatedAssignment()) // noticeAuthority = SELF_RELAY
    internals.slackPool.set(BOT_ID, ingest)
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

  // Every Off channel is muted for ROUTING; only the reason differs for the NOTICE.
  // On a mixed bot a gated member makes every unrouted mention a notice candidate, so
  // without the split an operator's Off would be answered with "ask an admin to enable
  // it" — a broken Off and the opposite of what happened.
  it('an OPERATOR-muted channel stays silent, even for an explicit @bot', async () => {
    const auth = pod(true)
    const a = auth.internals.router.get(BOT_ID)!
    a.mutedChannels = ['C9'] // switched Off in the console; NOT in gatedOffChannels
    await auth.internals.forward(BOT_ID, mention(M1, '1.1'))
    await auth.internals.forward(BOT_ID, mention(M2, '2.2'))
    expect(auth.ingest.postText).not.toHaveBeenCalled()
  })

  // The reviewer's end-to-end case: a gated owner's Off channel on a bot that also has
  // an ungated default. It must neither activate the public agent nor go silently
  // indistinguishable from an operator mute — it is unroutable AND says so, once.
  it('a GATED-Off channel is unroutable but still notices once', async () => {
    const sendMsg = vi.fn(async (msg: RdMsgIm): Promise<RdAck> => ({ msgId: msg.msgId, accepted: true }))
    const daemon = { sendMsg } as unknown as RelayDaemonConnection
    const manager = new RelayIngressManager(deps({ getDaemon: () => daemon, selfRelayId: () => SELF_RELAY }))
    const internals = internalsOf(manager)
    const ingest = fakeIngest()
    internals.slackPool.set(BOT_ID, ingest)
    internals.router.upsert({
      ...gatedAssignment(),
      agents: [
        { agentId: AGENT_ID, name: 'agent', daemonId: DAEMON_ID, integrationId: INTEGRATION_ID },
        { agentId: OTHER_AGENT_ID, name: 'public', daemonId: DAEMON_ID, integrationId: OTHER_INTEGRATION_ID }
      ],
      members: [{ daemonId: DAEMON_ID, agentIds: [AGENT_ID, OTHER_AGENT_ID] }],
      // The ungated sibling's unscoped rungs — exactly what a missing route cannot suppress.
      routes: [
        {
          agentId: OTHER_AGENT_ID,
          daemonId: DAEMON_ID,
          integrationId: OTHER_INTEGRATION_ID,
          match: { kind: 'keyword', value: 'public' }
        }
      ],
      defaultAgentId: OTHER_AGENT_ID,
      defaultDaemonId: DAEMON_ID,
      mutedChannels: ['C9'],
      gatedOffChannels: ['C9']
    })

    await internals.forward(BOT_ID, mention(M1, '1.1'))

    expect(sendMsg).not.toHaveBeenCalled() // the public agent was NOT activated
    expect(ingest.postText).toHaveBeenCalledTimes(1) // …and the gate explained itself
    expect(ingest.postText.mock.calls[0]![0]).toBe('C9')
    await internals.forward(BOT_ID, mention(M2, '2.2')) // still once per conversation
    expect(ingest.postText).toHaveBeenCalledTimes(1)
  })

  it('mutes only the named channel — another gated conversation still gets its notice', async () => {
    const auth = pod(true)
    auth.internals.router.get(BOT_ID)!.mutedChannels = ['C7']
    await auth.internals.forward(BOT_ID, mention(M1, '1.1')) // C9, not muted
    expect(auth.ingest.postText).toHaveBeenCalledTimes(1)
    expect(auth.ingest.postText.mock.calls[0]![0]).toBe('C9')
  })

  it('no authority stamped (old CP / empty roster): no pod posts; DM discovery still reports', async () => {
    const reportBotConversation = vi.fn(() => true)
    const manager = new RelayIngressManager(deps({ reportBotConversation, selfRelayId: () => SELF_RELAY }))
    const internals = internalsOf(manager)
    const a = gatedAssignment()
    delete a.noticeAuthority
    internals.router.upsert(a)
    const ingest = fakeIngest()
    internals.slackPool.set(BOT_ID, ingest)

    await internals.forward(BOT_ID, mention(M1, '1.1'))
    expect(ingest.postText).not.toHaveBeenCalled()
    // An authority-less (or non-authority) pod still reports direct rows.
    await internals.forward(BOT_ID, dm())
    expect(reportBotConversation).toHaveBeenCalledTimes(1)
  })

  it('reports a public DM even when the bot has no gated members, without a notice', async () => {
    const reportBotConversation = vi.fn(() => true)
    const manager = new RelayIngressManager(deps({ reportBotConversation }))
    const internals = internalsOf(manager)
    const a = gatedAssignment()
    a.gatedAgentIds = []
    internals.router.upsert(a)
    const ingest = fakeIngest()
    internals.slackPool.set(BOT_ID, ingest)

    await internals.forward(BOT_ID, dm())
    expect(reportBotConversation).toHaveBeenCalledWith({
      botId: BOT_ID,
      conversation: { id: 'D42', name: '@Alice', dmUserId: 'U1', kind: 'im' }
    })
    expect(ingest.postText).not.toHaveBeenCalled()
  })
})

// ── resolveVerified — the (api_app_id, team_id) composite demux ─────────────
//
// Every install of a DISTRIBUTED (platform-published) app shares one app id AND
// one signing secret, so the HMAC can authenticate but cannot discriminate —
// only the composite key may route, and the verify-scan must never hand one
// workspace's events to a sibling install (a cross-tenant leak, not a miss).
describe('RelayIngressManager.resolveVerified composite demux', () => {
  const BOT_T1 = 'aaaaaaaa-1111-4111-8111-111111111111'
  const BOT_T2 = 'aaaaaaaa-2222-4222-8222-222222222222'
  const BOT_LEGACY = 'aaaaaaaa-3333-4333-8333-333333333333'
  const PLATFORM_APP = 'APLATFORM'
  const SHARED_SECRET = 'shared-platform-signing-secret'
  const NOW = 1_720_000_000_000
  const ts = String(Math.floor(NOW / 1000))
  // Hints ride the ENVELOPE now (extractDemuxHints); each resolve() builds a
  // body carrying them. No event_id ⇒ the dedup table never interferes.
  const envelopeFor = (over: { apiAppId?: string; teamId?: string }) => ({
    type: 'event_callback',
    ...(over.apiAppId ? { api_app_id: over.apiAppId } : {}),
    ...(over.teamId ? { team_id: over.teamId } : {})
  })
  const sigFor = (secret: string, raw: Buffer) =>
    `v0=${createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')}`

  /** Register a bot the way `assign()` would, minus the network-touching ingest
   *  start: router assignment + a secret-bearing ingest stand-in + (for a
   *  team-scoped bot) the assign-derived composite index entries. */
  const addBot = (
    manager: RelayIngressManager,
    botId: string,
    signingSecret: string,
    opts: { apiAppId?: string; teamId?: string; workspaceId?: string; indexed?: boolean } = {}
  ) => {
    const internals = internalsOf(manager)
    internals.slackPool.set(botId, {
      signingSecret,
      stop: async () => {},
      handleEvent: async () => {
        handledBy.push(botId)
      }
    })
    internals.router.upsert({
      ...assignment(),
      botId,
      secrets: { botToken: 'xoxb', signingSecret },
      ...(opts.apiAppId ? { apiAppId: opts.apiAppId } : {}),
      ...(opts.teamId ? { teamId: opts.teamId } : {}),
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {})
    })
    if (opts.apiAppId && opts.teamId && opts.indexed !== false) {
      internals.slackDemux.indexAssign(botId, { appId: opts.apiAppId, tenantId: opts.teamId })
    }
    if (opts.apiAppId && !opts.teamId) internals.slackDemux.indexAssign(botId, { appId: opts.apiAppId })
  }

  /** Drive the §8 seam end to end and report WHICH bot's ingest handled the
   *  delivery (undefined = 401). The envelope parses as an event with no
   *  event_id, so dedup never interferes with the demux assertions. */
  const resolve = async (
    manager: RelayIngressManager,
    over: { apiAppId?: string; teamId?: string; secret?: string }
  ): Promise<string | undefined> => {
    handledBy.length = 0
    const envelope = envelopeFor(over)
    const raw = Buffer.from(JSON.stringify(envelope))
    const handled = await manager.handleInbound('slack', raw, envelope, {
      'x-slack-request-timestamp': ts,
      'x-slack-signature': sigFor(over.secret ?? SHARED_SECRET, raw)
    })
    if (!handled) return undefined
    // handleEvent fires async inside the plugin; give the microtask a beat.
    await new Promise((r) => setTimeout(r, 0))
    return handledBy[0]
  }
  const handledBy: string[] = []

  it('demuxes sibling installs of one distributed app by (api_app_id, team_id)', async () => {
    const manager = new RelayIngressManager(deps({ clock: new FakeClock(NOW) }))
    addBot(manager, BOT_T1, SHARED_SECRET, { apiAppId: PLATFORM_APP, teamId: 'T1' })
    addBot(manager, BOT_T2, SHARED_SECRET, { apiAppId: PLATFORM_APP, teamId: 'T2' })

    const internals = internalsOf(manager)
    await expect(resolve(manager, { apiAppId: PLATFORM_APP, teamId: 'T1' })).resolves.toBe(BOT_T1)
    await expect(resolve(manager, { apiAppId: PLATFORM_APP, teamId: 'T2' })).resolves.toBe(BOT_T2)
  })

  it('never serves a team-scoped bot to another workspace via the signature scan', async () => {
    const manager = new RelayIngressManager(deps({ clock: new FakeClock(NOW) }))
    // Composite index deliberately EMPTY (indexed:false) — only the router knows
    // the team ids, so resolution falls through to the verify-scan, where the
    // same-secret sibling MUST be skipped on the team-id guard.
    addBot(manager, BOT_T1, SHARED_SECRET, { apiAppId: PLATFORM_APP, teamId: 'T1', indexed: false })
    addBot(manager, BOT_T2, SHARED_SECRET, { apiAppId: PLATFORM_APP, teamId: 'T2', indexed: false })

    const internals = internalsOf(manager)
    await expect(resolve(manager, { apiAppId: PLATFORM_APP, teamId: 'T2' })).resolves.toBe(BOT_T2)
    // The scan hit must not poison the app-only learned map for a team-scoped bot.
    expect(internals.slackDemux.indexes.byApp.has(PLATFORM_APP)).toBe(false)
  })

  it('fails closed when a distributed-app envelope carries no team id', async () => {
    const manager = new RelayIngressManager(deps({ clock: new FakeClock(NOW) }))
    addBot(manager, BOT_T1, SHARED_SECRET, { apiAppId: PLATFORM_APP, teamId: 'T1' })
    addBot(manager, BOT_T2, SHARED_SECRET, { apiAppId: PLATFORM_APP, teamId: 'T2' })

    // Both siblings verify the HMAC; without a team id there is no safe pick.
    await expect(resolve(manager, { apiAppId: PLATFORM_APP })).resolves.toBeUndefined()
  })

  it('keeps the legacy app-only fast path and scan learning for team-less bots', async () => {
    const manager = new RelayIngressManager(deps({ clock: new FakeClock(NOW) }))
    addBot(manager, BOT_LEGACY, 'legacy-secret', {}) // no app id stamped — scan learns it

    const internals = internalsOf(manager)
    await expect(resolve(manager, { apiAppId: 'ALEGACY', secret: 'legacy-secret' })).resolves.toBe(BOT_LEGACY)
    expect(internals.slackDemux.indexes.byApp.get('ALEGACY')).toBe(BOT_LEGACY)
    // A team-scoped envelope still resolves the legacy bot (guard only skips
    // bots whose ASSIGNMENT carries a different team id).
    await expect(resolve(manager, { apiAppId: 'ALEGACY', teamId: 'T9', secret: 'legacy-secret' })).resolves.toBe(
      BOT_LEGACY
    )
  })

  // A revocation decides, commits, then broadcasts — and a re-install can land in
  // that gap, commit N+1, and broadcast its assign FIRST. Applying the stale
  // release would tear down the ingest of a credential it never described.
  it('unassign carrying an OLDER generation than the held assignment is ignored', async () => {
    const manager = new RelayIngressManager(deps({ clock: new FakeClock(NOW) }))
    const internals = internalsOf(manager)
    internals.slackPool.set(BOT_T1, { signingSecret: SHARED_SECRET, stop: async () => {} })
    internals.router.upsert({
      ...assignment(),
      botId: BOT_T1,
      secrets: { botToken: 'xoxb', signingSecret: SHARED_SECRET },
      apiAppId: PLATFORM_APP,
      teamId: 'T1',
      credentialRevision: 2 // the re-install's assign already landed here
    })
    internals.slackDemux.indexAssign(BOT_T1, { appId: PLATFORM_APP, tenantId: 'T1' })

    await manager.unassign(BOT_T1, 1) // the revoke of the REPLACED credential

    // Still serving: routing table, ingest, and demux index all intact.
    expect(internals.router.get(BOT_T1)).toBeDefined()
    expect(internals.slackPool.get(BOT_T1)).toBeDefined()
    expect(internals.slackDemux.indexes.byAppTenant.size).toBe(1)

    // The matching generation still releases it.
    await manager.unassign(BOT_T1, 2)
    expect(internals.router.get(BOT_T1)).toBeUndefined()
    expect(internals.slackPool.get(BOT_T1)).toBeUndefined()
  })

  it('unassign drops the composite index entries', async () => {
    const manager = new RelayIngressManager(deps({ clock: new FakeClock(NOW) }))
    addBot(manager, BOT_T1, SHARED_SECRET, { apiAppId: PLATFORM_APP, teamId: 'T1' })

    await manager.unassign(BOT_T1)
    const internals = internalsOf(manager)
    expect(internals.slackDemux.indexes.byAppTenant.size).toBe(0)
    // The reverse map is DemuxIndex-internal now; an empty composite index IS the proof.
    await expect(resolve(manager, { apiAppId: PLATFORM_APP, teamId: 'T1' })).resolves.toBeUndefined()
  })

  // ── The ingress tenant fence (ingress-tenant-fence.md §3) ──────────────────
  //
  // Two NON-distributed bots (quick-install shape: no teamId, so the old scan
  // guard never applied) that share one app id AND one signing secret — the
  // same custom app's credentials living in two organizations. `workspaceId`
  // is the only thing telling their workspaces apart.
  const BOT_W1 = 'bbbbbbbb-1111-4111-8111-111111111111'
  const BOT_W2 = 'bbbbbbbb-2222-4222-8222-222222222222'
  const CUSTOM_APP = 'ACUSTOM'
  const CUSTOM_SECRET = 'shared-custom-app-secret'

  it('scan never attributes a delivery across workspaces once the assignment knows its tenant', async () => {
    const manager = new RelayIngressManager(deps({ clock: new FakeClock(NOW) }))
    // Pool order is the adversary: W1 sits first and verifies W2's deliveries.
    addBot(manager, BOT_W1, CUSTOM_SECRET, { workspaceId: 'T1' })
    addBot(manager, BOT_W2, CUSTOM_SECRET, { workspaceId: 'T2' })

    await expect(resolve(manager, { teamId: 'T2', secret: CUSTOM_SECRET })).resolves.toBe(BOT_W2)
    await expect(resolve(manager, { teamId: 'T1', secret: CUSTOM_SECRET })).resolves.toBe(BOT_W1)
  })

  it('a learned app-only mapping cannot serve a cross-tenant delivery', async () => {
    const manager = new RelayIngressManager(deps({ clock: new FakeClock(NOW) }))
    addBot(manager, BOT_W1, CUSTOM_SECRET, { workspaceId: 'T1' })
    addBot(manager, BOT_W2, CUSTOM_SECRET, { workspaceId: 'T2' })

    // First delivery teaches the app-only map that ACUSTOM → W1…
    await expect(resolve(manager, { apiAppId: CUSTOM_APP, teamId: 'T1', secret: CUSTOM_SECRET })).resolves.toBe(BOT_W1)
    const internals = internalsOf(manager)
    expect(internals.slackDemux.indexes.byApp.get(CUSTOM_APP)).toBe(BOT_W1)
    // …and the learned fast path MUST NOT hand W2's traffic to W1: the fence
    // rejects the learned candidate and the scan finds the right owner.
    await expect(resolve(manager, { apiAppId: CUSTOM_APP, teamId: 'T2', secret: CUSTOM_SECRET })).resolves.toBe(BOT_W2)
  })

  it('an assignment with no captured tenant keeps today’s behaviour until backfill converges', async () => {
    const manager = new RelayIngressManager(deps({ clock: new FakeClock(NOW) }))
    // Identity capture failed at install: neither teamId nor workspaceId.
    addBot(manager, BOT_W1, CUSTOM_SECRET, {})

    // Unfenced — attributable to any tenant's delivery, exactly as today.
    await expect(resolve(manager, { teamId: 'T2', secret: CUSTOM_SECRET })).resolves.toBe(BOT_W1)

    // The reconciler backfills, the CP re-broadcasts, and the fence engages.
    addBot(manager, BOT_W1, CUSTOM_SECRET, { workspaceId: 'T1' })
    await expect(resolve(manager, { teamId: 'T2', secret: CUSTOM_SECRET })).resolves.toBeUndefined()
    await expect(resolve(manager, { teamId: 'T1', secret: CUSTOM_SECRET })).resolves.toBe(BOT_W1)
  })

  it('a delivery naming no tenant keeps today’s behaviour for workspace-fenced bots', async () => {
    const manager = new RelayIngressManager(deps({ clock: new FakeClock(NOW) }))
    addBot(manager, BOT_W1, CUSTOM_SECRET, { workspaceId: 'T1' })

    // Unlike a distributed sibling set (strict teamId arm, covered above), a
    // workspace-fenced bot still accepts a tenant-less delivery: refusing it
    // would break payload shapes that carry no team id at all.
    await expect(resolve(manager, { secret: CUSTOM_SECRET })).resolves.toBe(BOT_W1)
  })
})

/**
 * A THIRD platform, registered only here.
 *
 * The lifecycle findings (audit F2/F3/F4) were all hand lists of `slack` +
 * `feishu` — and for exactly those two ids a hand list is COMPLETE, so a suite
 * built from the real platforms passes against the broken code and proves
 * nothing. Only an id the hand list does not name can tell the two versions
 * apart. This fixture is that id: it implements the §8 contract and nothing
 * else, with no credentials, no HTTP, and no I/O.
 */
const SYNTHETIC = 'synthetic'

interface SyntheticIngest extends RelayBotIngress {
  /** Bumped by `stop()`. Teardown must reach it, and reach it exactly once. */
  stops: number
}

/** @param built Every ingest this plugin has been asked to build, in order. */
const syntheticPlugin = (built: SyntheticIngest[]): RelayPlatformIngressPlugin => ({
  platformId: SYNTHETIC,
  installRoutes: () => {},
  buildIngest: () => {
    const ingest: SyntheticIngest = {
      stops: 0,
      stop: () => {
        ingest.stops += 1
      }
    }
    built.push(ingest)
    return ingest
  },
  extractDemuxHints: () => ({}),
  verify: () => undefined,
  handle: async () => ({})
})

/** An assignment for the synthetic platform, carrying a tenant-scoped identity
 *  so the COMPOSITE index entry — the one whose survival is the cross-tenant
 *  delivery hazard `DemuxIndex` exists to prevent — actually gets written. */
const syntheticAssignment = (over: Partial<BotAssignment> = {}): BotAssignment => ({
  ...assignment(),
  platform: SYNTHETIC,
  secrets: { verificationToken: 'synthetic-token' },
  apiAppId: 'SYNTH_APP',
  teamId: 'SYNTH_TENANT',
  ...over
})

describe('RelayIngressManager lifecycle is registry-driven (a third platform)', () => {
  const build = () => {
    const built: SyntheticIngest[] = []
    const manager = new RelayIngressManager(deps(), [...relayIngressPlugins, syntheticPlugin(built)])
    return { built, manager, internals: internalsOf(manager) }
  }

  it('registers beside the real platforms rather than replacing them', () => {
    const { internals } = build()
    expect(internals.entryFor('slack')).toBeDefined()
    expect(internals.entryFor('feishu')).toBeDefined()
    expect(internals.entryFor(SYNTHETIC)).toBeDefined()
  })

  it('unassign stops the ingest, drops the pool entry, and forgets the demux entries', async () => {
    const { built, manager, internals } = build()
    await manager.assign(syntheticAssignment())

    const entry = internals.entryFor(SYNTHETIC)
    expect(entry.pool.get(BOT_ID)).toBeDefined()
    expect(entry.demux.indexes.byAppTenant.size).toBe(1)

    await manager.unassign(BOT_ID)

    // Named-pool teardown reached none of these: the ingest kept running, its
    // pool entry leaked, and the composite entry outlived the assignment that
    // derived it.
    expect(built[0]?.stops).toBe(1)
    expect(entry.pool.get(BOT_ID)).toBeUndefined()
    expect(entry.demux.indexes.byAppTenant.size).toBe(0)
    expect(entry.demux.indexes.byApp.size).toBe(0)
  })

  it('re-assign stops the previous ingest instead of rebuilding beside it', async () => {
    const { built, manager, internals } = build()
    await manager.assign(syntheticAssignment())
    await manager.assign(syntheticAssignment({ credentialRevision: 2 }))

    expect(built).toHaveLength(2)
    expect(built[0]?.stops).toBe(1)
    expect(built[1]?.stops).toBe(0)
    // Exactly one live instance, and it is the rebuild.
    expect(internals.entryFor(SYNTHETIC).pool.get(BOT_ID)).toBe(built[1])
  })

  it('re-assign forgets the previous identity before indexing the new one', async () => {
    const { manager, internals } = build()
    await manager.assign(syntheticAssignment())
    // This install lost its tenant scope AND moved app id. Both old entries
    // must go, or a stale one keeps resolving deliveries onto this bot.
    await manager.assign(syntheticAssignment({ apiAppId: 'SYNTH_APP_2', teamId: undefined }))

    const { demux } = internals.entryFor(SYNTHETIC)
    expect(demux.indexes.byAppTenant.size).toBe(0)
    expect(demux.resolve({ appId: 'SYNTH_APP' })).toBeUndefined()
    expect(demux.resolve({ appId: 'SYNTH_APP_2' })).toBe(BOT_ID)
  })

  it('stopAll closes a third platform’s ingests', async () => {
    const { built, manager, internals } = build()
    await manager.assign(syntheticAssignment())

    await manager.stopAll()

    expect(built[0]?.stops).toBe(1)
    expect(internals.entryFor(SYNTHETIC).pool.get(BOT_ID)).toBeUndefined()
  })

  it('leaves a real platform’s teardown unchanged', async () => {
    const { manager, internals } = build()
    // Feishu rides the same registry-driven teardown. Its ingest is a pure
    // decoder, so "nothing to stop, only to drop" is now its own `stop()`'s
    // business rather than a per-platform comment in core.
    await manager.assign({
      ...assignment(),
      platform: 'feishu',
      secrets: { verificationToken: 'verify-token' },
      apiAppId: 'cli_example'
    })
    expect(internals.feishuPool.get(BOT_ID)).toBeDefined()
    expect(internals.entryFor('feishu').demux.indexes.byApp.size).toBe(1)

    await manager.unassign(BOT_ID)
    expect(internals.feishuPool.get(BOT_ID)).toBeUndefined()
    expect(internals.entryFor('feishu').demux.indexes.byApp.size).toBe(0)
  })
})

describe('RelayIngressManager — activation rendezvous', () => {
  const HOLDER_ID = '99999999-9999-4999-8999-999999999999'
  const rd = { source: 'im', agentId: AGENT_ID, msgId: 'm-1', sessionKey: SESSION_KEY } as unknown as RdMsg

  /** The private send helper both IM paths route through. */
  const sendVia = (manager: RelayIngressManager, daemon: RelayDaemonConnection) =>
    (
      manager as unknown as {
        sendWithRendezvous(d: RelayDaemonConnection, m: RdMsg, bot: string, ctx: string): Promise<RdAck | undefined>
      }
    ).sendWithRendezvous(daemon, rd, BOT_ID, 'test')

  /** The manager's per-bot drop counter — an unroutable trigger must land here. */
  const dropCount = (manager: RelayIngressManager): number =>
    (manager as unknown as { dropped: Map<string, number> }).dropped.get(BOT_ID) ?? 0

  const conn = (sendMsg: ReturnType<typeof vi.fn>) => ({ sendMsg }) as unknown as RelayDaemonConnection

  it('re-sends the SAME msgId to the named holder and returns its verdict', async () => {
    const first = vi.fn(async () => ({
      msgId: 'm-1',
      accepted: false,
      reason: RD_ACK_NOT_HOLDER,
      holderDaemonId: HOLDER_ID
    }))
    const holderSend = vi.fn(async (_m: RdMsg) => ({ msgId: 'm-1', accepted: true, turnId: undefined }))
    const holder = conn(holderSend)
    const manager = new RelayIngressManager(deps({ getDaemon: (id) => (id === HOLDER_ID ? holder : undefined) }))

    const ack = await sendVia(manager, conn(first))
    expect(ack?.accepted).toBe(true)
    expect(holderSend).toHaveBeenCalledTimes(1)
    // The msgId must survive the hop, or the holder's own dedup cannot protect it.
    expect(holderSend.mock.calls[0]![0]).toBe(rd)
  })

  it('stops after one hop — a second not_holder is returned, never chased', async () => {
    const first = vi.fn(async () => ({
      msgId: 'm-1',
      accepted: false,
      reason: RD_ACK_NOT_HOLDER,
      holderDaemonId: HOLDER_ID
    }))
    const holderSend = vi.fn(async () => ({
      msgId: 'm-1',
      accepted: false,
      reason: RD_ACK_NOT_HOLDER,
      holderDaemonId: DAEMON_ID
    }))
    const manager = new RelayIngressManager(
      deps({ getDaemon: (id) => (id === HOLDER_ID ? conn(holderSend) : undefined) })
    )

    const ack = await sendVia(manager, conn(first))
    expect(ack?.reason).toBe(RD_ACK_NOT_HOLDER)
    expect(holderSend).toHaveBeenCalledTimes(1)
  })

  it('a not_holder naming nobody is left to the next retry', async () => {
    const first = vi.fn(async () => ({ msgId: 'm-1', accepted: false, reason: RD_ACK_NOT_HOLDER }))
    const manager = new RelayIngressManager(deps({ getDaemon: () => undefined }))

    const ack = await sendVia(manager, conn(first))
    expect(ack?.accepted).toBe(false)
    expect(first).toHaveBeenCalledTimes(1)
  })

  it('a holder that is not connected here does not double-send', async () => {
    const first = vi.fn(async () => ({
      msgId: 'm-1',
      accepted: false,
      reason: RD_ACK_NOT_HOLDER,
      holderDaemonId: HOLDER_ID
    }))
    const manager = new RelayIngressManager(deps({ getDaemon: () => undefined }))

    const ack = await sendVia(manager, conn(first))
    expect(ack?.reason).toBe(RD_ACK_NOT_HOLDER)
  })

  it('every other refusal is returned untouched — only not_holder re-routes', async () => {
    const holderSend = vi.fn()
    const first = vi.fn(async () => ({ msgId: 'm-1', accepted: false, reason: 'paused' }))
    const manager = new RelayIngressManager(deps({ getDaemon: () => conn(holderSend) }))

    const ack = await sendVia(manager, conn(first))
    expect(ack?.reason).toBe('paused')
    expect(holderSend).not.toHaveBeenCalled()
  })

  it('counts an unroutable trigger as a drop rather than claiming a retry', async () => {
    const first = vi.fn(async () => ({ msgId: 'm-1', accepted: false, reason: RD_ACK_NOT_HOLDER }))
    const manager = new RelayIngressManager(deps({ getDaemon: () => undefined }))

    await sendVia(manager, conn(first))
    expect(dropCount(manager)).toBe(1)
  })

  it('a redirect target refusing in turn is also counted as a drop', async () => {
    const first = vi.fn(async () => ({
      msgId: 'm-1',
      accepted: false,
      reason: RD_ACK_NOT_HOLDER,
      holderDaemonId: HOLDER_ID
    }))
    const holderSend = vi.fn(async () => ({
      msgId: 'm-1',
      accepted: false,
      reason: RD_ACK_NOT_HOLDER,
      holderDaemonId: DAEMON_ID
    }))
    const manager = new RelayIngressManager(
      deps({ getDaemon: (id) => (id === HOLDER_ID ? conn(holderSend) : undefined) })
    )

    await sendVia(manager, conn(first))
    expect(dropCount(manager)).toBe(1)
  })

  it('an ordinary refusal is NOT counted as an unrouted drop', async () => {
    const first = vi.fn(async () => ({ msgId: 'm-1', accepted: false, reason: 'paused' }))
    const manager = new RelayIngressManager(deps({ getDaemon: () => undefined }))

    await sendVia(manager, conn(first))
    expect(dropCount(manager)).toBe(0)
  })

  it('an accepted send never consults the router', async () => {
    const holderSend = vi.fn()
    const first = vi.fn(async () => ({ msgId: 'm-1', accepted: true }))
    const manager = new RelayIngressManager(deps({ getDaemon: () => conn(holderSend) }))

    const ack = await sendVia(manager, conn(first))
    expect(ack?.accepted).toBe(true)
    expect(holderSend).not.toHaveBeenCalled()
  })

  it('a button clicked after the duty moved re-routes and answers with the holder’s verdict', async () => {
    // The recorded member is still connected — it just handed the duty on between the
    // projection that addressed the button and the click.
    const staleSend = vi.fn(async (m: RdMsgPlatformAction): Promise<RdAck> => ({
      msgId: m.msgId,
      accepted: false,
      reason: RD_ACK_NOT_HOLDER,
      holderDaemonId: HOLDER_ID
    }))
    const response = { toast: { type: 'info' as const, content: 'Cancellation requested.' } }
    const holderSend = vi.fn(async (m: RdMsgPlatformAction): Promise<RdAck> => ({
      msgId: m.msgId,
      accepted: true,
      response
    }))
    const manager = new RelayIngressManager(
      deps({
        getDaemon: (id) =>
          ({ [DAEMON_ID]: { sendMsg: staleSend }, [HOLDER_ID]: { sendMsg: holderSend } })[id] as unknown as
            RelayDaemonConnection | undefined
      })
    )
    const rd: RdMsgPlatformAction = {
      source: 'platform_action',
      platformId: 'slack',
      agentId: AGENT_ID,
      integrationId: INTEGRATION_ID,
      sessionKey: SESSION_KEY,
      msgId: 'slack-action:cancel',
      botId: BOT_ID,
      payload: { kind: 'cancel' }
    }
    const ack = await internalsOf(manager).ingressHost.forwardAction(rd, {
      agentId: AGENT_ID,
      daemonId: DAEMON_ID,
      integrationId: INTEGRATION_ID
    })

    // The SAME frame, msgId included — the holder's own dedup is what protects a
    // double-clicked button once the interaction lands twice.
    expect(holderSend).toHaveBeenCalledTimes(1)
    expect(holderSend).toHaveBeenCalledWith(rd)
    // The plugin's synchronous answer (a Feishu toast, a Slack modal) is the true
    // holder's, not the refusal that used to reach it.
    expect(ack).toEqual({ msgId: rd.msgId, accepted: true, response })
    expect(dropCount(manager)).toBe(0)
  })
})
