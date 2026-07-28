import { describe, it, expect, vi } from 'vitest'
import type { CollabRoutesSnapshot, RdAgentMsg, RdAgentMsgFwd, RdAgentMsgAck } from '@agentconnect.md/protocol'
import { CollaborationRouter } from './collaboration-router.js'
import { createAgentMsgRouter } from './agent-msg-router.js'
import type { RelayDaemonServer } from './relay-daemon-server.js'

const ORG = '00000000-0000-0000-0000-0000000000a1'
const ORG2 = '00000000-0000-0000-0000-0000000000a2'
const D1 = '00000000-0000-0000-0000-0000000000d1'
const D2 = '00000000-0000-0000-0000-0000000000d2'
const A = '00000000-0000-0000-0000-00000000000a' // caller on D1
const B = '00000000-0000-0000-0000-00000000000b' // target on D2
const INT = '00000000-0000-0000-0000-0000000000f1'

const noopLog = { info() {}, warn() {}, error() {}, debug() {} }

function snap(): CollabRoutesSnapshot {
  return {
    generation: 1,
    channels: [
      {
        orgId: ORG,
        platform: 'slack',
        channelId: 'C1',
        agents: [
          {
            agentId: A,
            daemonId: D1,
            integrationId: INT,
            botAppId: 'AAGENTCONNECT',
            callPolicy: 'all',
            allowedCallerAgentIds: [],
            outboundPolicy: 'all',
            allowedTargetAgentIds: []
          },
          {
            agentId: B,
            daemonId: D2,
            integrationId: INT,
            callPolicy: 'all',
            allowedCallerAgentIds: [],
            outboundPolicy: 'all',
            allowedTargetAgentIds: []
          }
        ]
      }
    ]
  }
}

function baseMsg(over: Partial<RdAgentMsg> = {}): RdAgentMsg {
  return {
    claimedFromAgentId: A,
    toAgentId: B,
    text: 'hi',
    coords: { platform: 'slack', channel: 'C1' },
    hopCount: 0,
    deliveryId: 'd-1',
    ...over
  }
}

/** A fake D2 connection that records forwards + returns a canned ack. */
function fakeDaemons(ack: RdAgentMsgAck, forwards: RdAgentMsgFwd[]): RelayDaemonServer {
  const conn = {
    forwardAgentMsg: vi.fn(async (fwd: RdAgentMsgFwd) => {
      forwards.push(fwd)
      return ack
    })
  }
  return {
    get: (daemonId: string) => (daemonId === D2 ? (conn as never) : undefined)
  } as unknown as RelayDaemonServer
}

describe('relay rd/agentmsg routing + auth (agent-collaboration P2)', () => {
  it('recognizes a managed Slack app only alongside the target channel placement', () => {
    const router = new CollaborationRouter()
    router.replace(snap())

    expect(router.isAgentBotAppFor(B, 'slack', 'C1', 'AAGENTCONNECT')).toBe(true)
    expect(router.isAgentBotAppFor(B, 'slack', 'C1', 'ATHIRDPARTY')).toBe(false)
    expect(router.isAgentBotAppFor(B, 'slack', 'C2', 'AAGENTCONNECT')).toBe(false)
  })

  it('cross-daemon deliver: valid caller → forwards a trusted claim + delivered:true', async () => {
    const router = new CollaborationRouter()
    router.replace(snap())
    const forwards: RdAgentMsgFwd[] = []
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, forwards),
      log: noopLog
    })

    const ack = await route(D1, baseMsg())
    expect(ack.delivered).toBe(true)
    expect(forwards).toHaveLength(1)
    // The relay minted a TRUSTED claim + incremented the hop.
    expect(forwards[0].trustedFromAgentId).toBe(A)
    expect(forwards[0].orgId).toBe(ORG)
    expect(forwards[0].hopCount).toBe(1)
    expect(forwards[0].integrationId).toBe(INT)
  })

  it('forwards the visible-post transcriptTs opaquely (toAgent+channel wake dedup)', async () => {
    const router = new CollaborationRouter()
    router.replace(snap())
    const forwards: RdAgentMsgFwd[] = []
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, forwards),
      log: noopLog
    })

    const ack = await route(D1, baseMsg({ transcriptTs: '1784297789.871789' }))
    expect(ack.delivered).toBe(true)
    // The post ts rides through so the target can dedup the wake against the visible post.
    expect(forwards[0].transcriptTs).toBe('1784297789.871789')
  })

  it('forwards needsReply opaquely (it is the caller’s instruction about its own lineage)', async () => {
    const router = new CollaborationRouter()
    router.replace(snap())
    const forwards: RdAgentMsgFwd[] = []
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, forwards),
      log: noopLog
    })

    const ack = await route(D1, baseMsg({ originSessionId: 'acp-parent-1', needsReply: true }))
    expect(ack.delivered).toBe(true)
    // The router copies field-by-field, so a new optional field is silently dropped unless it is
    // explicitly forwarded — assert it survives the hop.
    expect(forwards[0].needsReply).toBe(true)
    expect(forwards[0].originSessionId).toBe('acp-parent-1')
  })

  it('leaves needsReply absent for an ordinary wake', async () => {
    const router = new CollaborationRouter()
    router.replace(snap())
    const forwards: RdAgentMsgFwd[] = []
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, forwards),
      log: noopLog
    })

    await route(D1, baseMsg())
    expect(forwards[0].needsReply).toBeUndefined()
  })

  it('forged claimedFromAgentId (not owned by the sending daemon) → rejected, not delivered', async () => {
    const router = new CollaborationRouter()
    router.replace(snap())
    const forwards: RdAgentMsgFwd[] = []
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, forwards),
      log: noopLog
    })
    // A claims to be the caller, but the socket authenticated as D2 (not A's daemon D1).
    const ack = await route(D2, baseMsg())
    expect(ack.delivered).toBe(false)
    expect(ack.reason).toBe('not_allowed')
    expect(forwards).toHaveLength(0)
  })

  it('target callPolicy=selected, caller not allowed → NAK not_allowed at the relay', async () => {
    const s = snap()
    s.channels[0].agents[1].callPolicy = 'selected'
    s.channels[0].agents[1].allowedCallerAgentIds = [] // A not allowed
    const router = new CollaborationRouter()
    router.replace(s)
    const forwards: RdAgentMsgFwd[] = []
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, forwards),
      log: noopLog
    })
    const ack = await route(D1, baseMsg())
    expect(ack.delivered).toBe(false)
    expect(ack.reason).toBe('not_allowed')
    expect(forwards).toHaveLength(0)
  })

  it('caller outboundPolicy=selected, target not allowed → NAK not_allowed at the relay', async () => {
    const s = snap()
    s.channels[0]!.agents[0]!.outboundPolicy = 'selected'
    s.channels[0]!.agents[0]!.allowedTargetAgentIds = []
    const router = new CollaborationRouter()
    router.replace(s)
    const forwards: RdAgentMsgFwd[] = []
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, forwards),
      log: noopLog
    })

    const ack = await route(D1, baseMsg())
    expect(ack).toMatchObject({ delivered: false, reason: 'not_allowed' })
    expect(forwards).toHaveLength(0)
  })

  it('target not in any channel row → NAK not_found', async () => {
    const s = snap()
    s.channels[0].agents = s.channels[0].agents.filter((a) => a.agentId !== B) // drop B
    const router = new CollaborationRouter()
    router.replace(s)
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, []),
      log: noopLog
    })
    const ack = await route(D1, baseMsg())
    expect(ack.delivered).toBe(false)
    expect(ack.reason).toBe('not_found')
  })

  it('target owning daemon offline (no connection) → NAK offline', async () => {
    const router = new CollaborationRouter()
    router.replace(snap())
    const route = createAgentMsgRouter({
      router,
      daemons: () => ({ get: () => undefined }) as unknown as RelayDaemonServer,
      log: noopLog
    })
    const ack = await route(D1, baseMsg())
    expect(ack.delivered).toBe(false)
    expect(ack.reason).toBe('offline')
  })

  it('cross-org target → rejected (caller/target never share a channel row)', async () => {
    // Caller A is in ORG/C1; a same-id channel in ORG2 holds a different target — the
    // caller does not resolve in ORG2, so its org binds to ORG and B-in-ORG2 is unseen.
    const s = snap()
    s.channels.push({
      orgId: ORG2,
      platform: 'slack',
      channelId: 'C1',
      agents: [{ agentId: B, daemonId: D2, integrationId: INT, callPolicy: 'all', allowedCallerAgentIds: [] }]
    })
    // Remove B from ORG so it only exists cross-org.
    s.channels[0].agents = s.channels[0].agents.filter((a) => a.agentId !== B)
    const router = new CollaborationRouter()
    router.replace(s)
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, []),
      log: noopLog
    })
    const ack = await route(D1, baseMsg())
    expect(ack.delivered).toBe(false)
    expect(ack.reason).toBe('not_found') // resolved in caller's org (ORG), where B is absent
  })

  it('per-hop dedup: same deliveryId twice → single forward', async () => {
    const router = new CollaborationRouter()
    router.replace(snap())
    const forwards: RdAgentMsgFwd[] = []
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, forwards),
      log: noopLog
    })
    const a1 = await route(D1, baseMsg())
    const a2 = await route(D1, baseMsg())
    expect(a1.delivered).toBe(true)
    expect(a2).toEqual(a1)
    expect(forwards).toHaveLength(1) // second call replayed, no re-forward
  })

  it('cross-daemon dedup is namespaced by fromDaemonId: same deliveryId from DIFFERENT source daemons → BOTH forwarded (no collision)', async () => {
    // deliveryId = String(Date.now()) is only unique WITHIN one daemon; two independent
    // source daemons routinely mint the same ms. A bare-deliveryId dedup key would drop
    // the second daemon's unrelated call (or hand it the first daemon's cached verdict).
    // Add a second caller A2 that lives on D2 so a call FROM D2 is a valid, distinct call.
    const A2 = '00000000-0000-0000-0000-0000000000a3'
    const s = snap()
    s.channels[0].agents.push({
      agentId: A2,
      daemonId: D2,
      integrationId: INT,
      callPolicy: 'all',
      allowedCallerAgentIds: []
    })
    // Target A is on D1 so the D2-originated call forwards to D1's connection.
    const router = new CollaborationRouter()
    router.replace(s)
    const forwards: RdAgentMsgFwd[] = []
    const conn = {
      forwardAgentMsg: vi.fn(async (fwd: RdAgentMsgFwd) => {
        forwards.push(fwd)
        return { deliveryId: fwd.deliveryId, delivered: true }
      })
    }
    const route = createAgentMsgRouter({
      router,
      daemons: () => ({ get: () => conn as never }) as unknown as RelayDaemonServer,
      log: noopLog
    })

    // Same deliveryId 'dup' but different authenticated source daemons + callers.
    const fromD1 = await route(D1, baseMsg({ deliveryId: 'dup', claimedFromAgentId: A, toAgentId: B }))
    const fromD2 = await route(D2, baseMsg({ deliveryId: 'dup', claimedFromAgentId: A2, toAgentId: A }))

    expect(fromD1.delivered).toBe(true)
    expect(fromD2.delivered).toBe(true)
    expect(forwards).toHaveLength(2) // NOT deduped into one — the collision is fixed
    expect(forwards.map((f) => f.trustedFromAgentId).sort()).toEqual([A, A2].sort())

    // A genuine retransmit (same daemon + same deliveryId) IS still deduped.
    const retransmit = await route(D1, baseMsg({ deliveryId: 'dup', claimedFromAgentId: A, toAgentId: B }))
    expect(retransmit).toEqual(fromD1)
    expect(forwards).toHaveLength(2) // no third forward
  })

  it('snapshot routing: target on a DIFFERENT bot but same channel is still addressable', async () => {
    // A reaches C1 via integration INT; B reaches C1 via a DIFFERENT integration/bot.
    // The bot-agnostic snapshot co-locates them by (org, platform, channel).
    const s: CollabRoutesSnapshot = {
      generation: 1,
      channels: [
        {
          orgId: ORG,
          platform: 'slack',
          channelId: 'C1',
          agents: [
            { agentId: A, daemonId: D1, integrationId: INT, callPolicy: 'all', allowedCallerAgentIds: [] },
            {
              agentId: B,
              daemonId: D2,
              integrationId: '00000000-0000-0000-0000-0000000000f2', // different bot's integration
              callPolicy: 'all',
              allowedCallerAgentIds: []
            }
          ]
        }
      ]
    }
    const router = new CollaborationRouter()
    router.replace(s)
    const forwards: RdAgentMsgFwd[] = []
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, forwards),
      log: noopLog
    })
    const ack = await route(D1, baseMsg())
    expect(ack.delivered).toBe(true)
    expect(forwards[0].integrationId).toBe('00000000-0000-0000-0000-0000000000f2')
  })

  it('hop cap: inbound hopCount at the cap → NAK hop_limit', async () => {
    const router = new CollaborationRouter()
    router.replace(snap())
    const forwards: RdAgentMsgFwd[] = []
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, forwards),
      log: noopLog
    })
    const ack = await route(D1, baseMsg({ hopCount: 8, deliveryId: 'd-hop' }))
    expect(ack.delivered).toBe(false)
    expect(ack.reason).toBe('hop_limit')
    expect(forwards).toHaveLength(0)
  })
})
