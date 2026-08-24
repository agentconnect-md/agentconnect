import { describe, it, expect, vi } from 'vitest'
import type {
  CollabAgentPlacement,
  CollabOrgAgent,
  CollabRoutesSnapshot,
  RdAgentMsg,
  RdAgentMsgFwd,
  RdAgentMsgAck
} from '@agentconnect.md/protocol'
import { MAX_AGENT_CALL_HOPS, RD_HEADLESS_AGENT_DELIVERY_V1 } from '@agentconnect.md/protocol'
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

/** An org-scoped directory entry (the flat `agents[]` shape) with policy defaults. */
function orgAgent(over: Partial<CollabOrgAgent> & { agentId: string }): CollabOrgAgent {
  return {
    orgId: ORG,
    callPolicy: 'all',
    allowedCallerAgentIds: [],
    outboundPolicy: 'all',
    allowedTargetAgentIds: [],
    ...over
  }
}

/** One channel-row placement (the `channels[].agents[]` shape) with policy defaults. */
function placement(over: Partial<CollabAgentPlacement> & { agentId: string; daemonId: string }): CollabAgentPlacement {
  return {
    integrationId: INT,
    callPolicy: 'all',
    allowedCallerAgentIds: [],
    outboundPolicy: 'all',
    allowedTargetAgentIds: [],
    ...over
  }
}

function snap(): CollabRoutesSnapshot {
  return {
    generation: 1,
    platformKinds: [],
    // The flat directory is the authorization surface; `channels[]` below only carries the
    // delivery/ingress facts (integration, bot app id).
    agents: [orgAgent({ agentId: A, daemonId: D1 }), orgAgent({ agentId: B, daemonId: D2 })],
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

/** A fake D2 connection that records forwards + returns a canned ack. `capabilities` is
 *  what the daemon advertised at `rd/hello`; the default mirrors a current daemon. Pass
 *  an empty list to model an OLDER daemon, which advertises nothing (§8.4). */
function fakeDaemons(
  ack: RdAgentMsgAck,
  forwards: RdAgentMsgFwd[],
  capabilities: readonly string[] = [RD_HEADLESS_AGENT_DELIVERY_V1]
): RelayDaemonServer {
  const conn = {
    supports: (capability: string) => capabilities.includes(capability),
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
    expect(forwards[0]!.trustedFromAgentId).toBe(A)
    expect(forwards[0]!.orgId).toBe(ORG)
    expect(forwards[0]!.hopCount).toBe(1)
    expect(forwards[0]!.integrationId).toBe(INT)
  })

  it('forwards a session reply to a capable daemon', async () => {
    // send-message-routing-rework.md §8.3: the delivery KIND rides through so the target
    // dispatches into the named parent session, exactly as the same-daemon path does.
    const router = new CollaborationRouter()
    router.replace(snap())
    const forwards: RdAgentMsgFwd[] = []
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, forwards),
      log: noopLog
    })

    const ack = await route(D1, baseMsg({ deliveryKind: 'session-reply' }))
    expect(ack.delivered).toBe(true)
    expect(forwards[0]!.deliveryKind).toBe('session-reply')
  })

  it('REFUSES a session reply to a daemon that does not understand the kind', async () => {
    // §8.4 / §10 case 14. The failure mode this prevents is a MISROUTED reply: a target
    // predating the kind ignores `lineageReplyTo` and keys the delivery by coordinates,
    // minting a different session. `unsupported` is deliberately distinct from `offline` —
    // the daemon is reachable, just too old.
    const router = new CollaborationRouter()
    router.replace(snap())
    const forwards: RdAgentMsgFwd[] = []
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, forwards, []),
      log: noopLog
    })

    const ack = await route(D1, baseMsg({ deliveryKind: 'session-reply' }))
    expect(ack).toMatchObject({ delivered: false, reason: 'unsupported' })
    expect(forwards).toHaveLength(0)
  })

  it('still forwards an ordinary wake to a daemon advertising nothing', async () => {
    // Only `session-reply` is gated; a plain postless wake has always been safe against
    // an older target, so the capability must not become a general fence.
    const router = new CollaborationRouter()
    router.replace(snap())
    const forwards: RdAgentMsgFwd[] = []
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, forwards, []),
      log: noopLog
    })

    expect((await route(D1, baseMsg())).delivered).toBe(true)
    expect(forwards).toHaveLength(1)
    expect(forwards[0]!.deliveryKind).toBeUndefined()
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
    expect(forwards[0]!.transcriptTs).toBe('1784297789.871789')
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
    expect(forwards[0]!.needsReply).toBe(true)
    expect(forwards[0]!.originSessionId).toBe('acp-parent-1')
  })

  it('forwards the caller daemon’s external source binding opaquely', async () => {
    const router = new CollaborationRouter()
    router.replace(snap())
    const forwards: RdAgentMsgFwd[] = []
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, forwards),
      log: noopLog
    })
    const externalOrigin = {
      provider: 'slack' as const,
      realmKey: 'T1',
      resourceKind: 'conversation' as const,
      resourceKey: 'C1'
    }

    const ack = await route(D1, baseMsg({ externalOrigin }))

    expect(ack.delivered).toBe(true)
    expect(forwards[0]!.externalOrigin).toEqual(externalOrigin)
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
    expect(forwards[0]!.needsReply).toBeUndefined()
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

  it('coords integrity: caller asserting a KNOWN channel it is NOT in → not_allowed, nothing forwarded', async () => {
    // F1 regression. Channel is no longer an AUTHORIZATION key, but it is still the woken
    // peer's SESSION key, so the assertion still needs integrity: A lives only in C1, while
    // B is in C1 *and* C_EXECS with a live C_EXECS session. Were the coords unchecked, the
    // wake would land on the SAME computed childSessionId as that session and RESUME it —
    // and with needsReply, report its content back into A's session. Policies are all 'all'
    // here on purpose: the policy pair cannot see this, only the coordinate check can.
    const s = snap()
    s.channels.push({
      orgId: ORG,
      platform: 'slack',
      channelId: 'C_EXECS',
      agents: [placement({ agentId: B, daemonId: D2, integrationId: '00000000-0000-0000-0000-0000000000f2' })]
    })
    const router = new CollaborationRouter()
    router.replace(s)
    const forwards: RdAgentMsgFwd[] = []
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, forwards),
      log: noopLog
    })

    const ack = await route(
      D1,
      baseMsg({
        coords: { platform: 'slack', channel: 'C_EXECS', thread: '1784297789.871789' },
        needsReply: true,
        originSessionId: 'acp-parent-1'
      })
    )
    expect(ack).toMatchObject({ delivered: false, reason: 'not_allowed' })
    expect(forwards).toHaveLength(0)
  })

  it('coords integrity: caller IS in the asserted channel → delivered, with that channel’s reply integration', async () => {
    // The gate rejects only the channels the caller cannot reach; a legitimate second
    // channel keeps working end to end.
    const INT2 = '00000000-0000-0000-0000-0000000000f2'
    const s = snap()
    s.channels.push({
      orgId: ORG,
      platform: 'slack',
      channelId: 'C_EXECS',
      agents: [
        placement({ agentId: A, daemonId: D1, integrationId: INT2 }),
        placement({ agentId: B, daemonId: D2, integrationId: INT2 })
      ]
    })
    const router = new CollaborationRouter()
    router.replace(s)
    const forwards: RdAgentMsgFwd[] = []
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, forwards),
      log: noopLog
    })

    const ack = await route(D1, baseMsg({ coords: { platform: 'slack', channel: 'C_EXECS' } }))
    expect(ack.delivered).toBe(true)
    expect(forwards).toHaveLength(1)
    expect(forwards[0]!.integrationId).toBe(INT2)
    expect(forwards[0]!.coords).toEqual({ platform: 'slack', channel: 'C_EXECS' })
  })

  it('coords integrity: switching the coordinate PLATFORM does not dodge the gate', async () => {
    // The bypass a platform-KEYED gate had. The target computes the woken session key with a
    // NARROWED platform (`narrowPlatform` folds feishu — and any unrecognised value — into
    // 'slack'), so looking the coordinate up under the raw wire platform searched a different
    // key space than the key being protected, and the residual "unknown coordinate passes"
    // branch turned the miss into a PASS. `feishu` is a legal value of the coords enum, so
    // this was the same attack as above with one field changed.
    const s = snap()
    s.channels.push({
      orgId: ORG,
      platform: 'slack',
      channelId: 'C_EXECS',
      agents: [placement({ agentId: B, daemonId: D2, integrationId: '00000000-0000-0000-0000-0000000000f2' })]
    })
    const router = new CollaborationRouter()
    router.replace(s)
    const forwards: RdAgentMsgFwd[] = []
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, forwards),
      log: noopLog
    })

    const ack = await route(
      D1,
      baseMsg({ coords: { platform: 'feishu', channel: 'C_EXECS', thread: '1784297789.871789' }, needsReply: true })
    )
    expect(ack).toMatchObject({ delivered: false, reason: 'not_allowed' })
    expect(forwards).toHaveLength(0)

    // The new label worth trying now that channel-free coordinates are admitted: claim the
    // real Slack channel is a `webchat` conversation. The KNOWN-row branch runs FIRST and is
    // platform-free, so the row is still found and membership is still demanded — the
    // channel-free branch is only reachable for a coordinate no row exists for.
    const asWebchat = await route(
      D1,
      baseMsg({
        deliveryId: 'd-webchat',
        coords: { platform: 'webchat', channel: 'C_EXECS', thread: '1784297789.871789' },
        needsReply: true
      })
    )
    expect(asWebchat).toMatchObject({ delivered: false, reason: 'not_allowed' })
    expect(forwards).toHaveLength(0)
  })

  it('coords integrity: holds in a FEISHU org, where honest coords are already narrowed to slack', async () => {
    // The mirror of the same root cause, and the reason a platform-keyed gate was a NO-OP for
    // a whole tenant class: channel rows are keyed by the INTEGRATION platform ('feishu'),
    // while the source daemon narrows its own coords to 'slack' before sending them. So the
    // attack needed no exotic value at all — every honest wake in such an org already carries
    // a platform the gate would fail to find.
    const router = new CollaborationRouter()
    router.replace({
      generation: 1,
      platformKinds: [],
      agents: [orgAgent({ agentId: A, daemonId: D1 }), orgAgent({ agentId: B, daemonId: D2 })],
      channels: [
        {
          orgId: ORG,
          platform: 'feishu',
          channelId: 'oc_pub',
          agents: [placement({ agentId: A, daemonId: D1 }), placement({ agentId: B, daemonId: D2 })]
        },
        { orgId: ORG, platform: 'feishu', channelId: 'oc_execs', agents: [placement({ agentId: B, daemonId: D2 })] }
      ]
    })
    const forwards: RdAgentMsgFwd[] = []
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, forwards),
      log: noopLog
    })

    const ack = await route(D1, baseMsg({ coords: { platform: 'slack', channel: 'oc_execs', thread: '900.1' } }))
    expect(ack).toMatchObject({ delivered: false, reason: 'not_allowed' })
    expect(forwards).toHaveLength(0)
    // The channel they genuinely share still routes, with the same narrowed platform.
    const shared = await route(
      D1,
      baseMsg({ deliveryId: 'd-2', coords: { platform: 'slack', channel: 'oc_pub', thread: '900.1' } })
    )
    expect(shared.delivered).toBe(true)
    expect(forwards).toHaveLength(1)
  })

  it('coords integrity: an UNKNOWN IM coordinate FAILS CLOSED, while a channel-free one still routes', async () => {
    // The review finding, and the assertion this test used to make. "Unknown coordinate
    // passes" was too wide: it admitted not only the intended channel-free coordinates but
    // any Slack channel the snapshot happens not to hold — a DM, a channel the bot left, or
    // one the caller simply guessed. An authenticated-but-compromised source daemon could
    // therefore land on the target's EXISTING session at that platform:channel:thread and use
    // `needsReply` to pull its context back. So the two coordinates below must now split:
    // the IM one is refused, the channel-free one is not (rejecting it would kill the
    // integration-less collaboration the org-scoped directory exists for).
    const router = new CollaborationRouter()
    router.replace(snap()) // knows only slack:C1
    const forwards: RdAgentMsgFwd[] = []
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, forwards),
      log: noopLog
    })

    const webchat = await route(D1, baseMsg({ coords: { platform: 'webchat', channel: 'wc-1' } }))
    expect(webchat.delivered).toBe(true)
    // The relay forwards `coords` VERBATIM — the target daemon is the side that replaces a
    // channel-free coordinate when it mints the session key, so the two cannot disagree.
    expect(forwards[0]!.coords).toEqual({ platform: 'webchat', channel: 'wc-1' })
    // No channel row for the coordinate ⇒ the reply integration falls back to the target's
    // directory entry, which here has none.
    expect(forwards[0]!.integrationId).toBeUndefined()

    // Post-fleet-gate (S1b): a `dream`/`hook` session's cross-daemon wake carries its RAW
    // platform — same channel-free admission as webchat, forwarded verbatim. (The daemon
    // used to clamp these to 'slack' on emission, which landed them in the fail-closed IM
    // branch and rejected the wake.)
    const dream = await route(
      D1,
      baseMsg({ deliveryId: 'd-dream', coords: { platform: 'dream', channel: 'memory', thread: 'dream-1' } })
    )
    expect(dream.delivered).toBe(true)
    expect(forwards[1]!.coords).toEqual({ platform: 'dream', channel: 'memory', thread: 'dream-1' })

    const unknownChannel = await route(
      D1,
      baseMsg({ deliveryId: 'd-2', coords: { platform: 'slack', channel: 'C_NOT_IN_SNAPSHOT' } })
    )
    expect(unknownChannel).toMatchObject({ delivered: false, reason: 'not_allowed' })
    expect(forwards).toHaveLength(2) // nothing forwarded for the IM coordinate

    // …on every chat-shaped platform: the persisted IM four, and (S1a §6.1) any id this
    // build does not know — unknown ids are chat-shaped until the registry says otherwise,
    // so they fail closed instead of slipping into the channel-free synthetic branch.
    for (const [i, platform] of ['telegram', 'discord', 'feishu', 'teams-x'].entries()) {
      const ack = await route(
        D1,
        baseMsg({ deliveryId: `d-im-${i}`, coords: { platform: platform as 'telegram', channel: 'NOT_A_ROW' } })
      )
      expect(ack).toMatchObject({ delivered: false, reason: 'not_allowed' })
    }
    expect(forwards).toHaveLength(2)
  })

  it('wire-carried platformKinds classify ids this relay build does not know (§6.1)', async () => {
    const s = snap()
    s.platformKinds = [
      { platformId: 'teams-x', originKind: 'chat' },
      { platformId: 'sandbox-x', originKind: 'sandbox' }
    ]
    const router = new CollaborationRouter()
    router.replace(s)
    const forwards: RdAgentMsgFwd[] = []
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, forwards),
      log: noopLog
    })
    // Snapshot-classified chat id: unrecorded coordinate fails closed like the IM four.
    const chat = await route(D1, baseMsg({ deliveryId: 'd-k1', coords: { platform: 'teams-x', channel: 'NOT_A_ROW' } }))
    expect(chat).toMatchObject({ delivered: false, reason: 'not_allowed' })
    // Snapshot-classified channel-free kind: admitted, forwarded verbatim.
    const sandbox = await route(
      D1,
      baseMsg({ deliveryId: 'd-k2', coords: { platform: 'sandbox-x', channel: 'box-1' } })
    )
    expect(sandbox.delivered).toBe(true)
    expect(forwards[0]!.coords).toEqual({ platform: 'sandbox-x', channel: 'box-1' })
    // rc/bot-assign learning covers the same classification between snapshots.
    router.learnPlatformKind('notes-x', 'notes')
    const learned = await route(D1, baseMsg({ deliveryId: 'd-k3', coords: { platform: 'notes-x', channel: 'n-1' } }))
    expect(learned.delivered).toBe(true)
  })

  it('lineage replies are exempt from the wake-coordinate membership gate (org + policy still apply)', async () => {
    // Origin channel C_EXECS is KNOWN and its only member is the TARGET (B). The replier (A)
    // is not in it — a wake asserting these coords is refused, but a §5.3 lineage reply never
    // keys or creates a session from `coords`, so the relay forwards it and leaves the exact
    // session capability (possession + ownership) to the target daemon.
    const s = snap()
    s.channels.push({
      orgId: ORG,
      platform: 'slack',
      channelId: 'C_EXECS',
      agents: [
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
    })
    const router = new CollaborationRouter()
    router.replace(s)
    const forwards: RdAgentMsgFwd[] = []
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, forwards),
      log: noopLog
    })

    // Control: the same coordinate as an ordinary WAKE is refused (A is not a member).
    const wake = await route(
      D1,
      baseMsg({ deliveryId: 'd-wake', coords: { platform: 'slack', channel: 'C_EXECS', thread: '900.1' } })
    )
    expect(wake).toMatchObject({ delivered: false, reason: 'not_allowed' })
    expect(forwards).toHaveLength(0)

    const reply = await route(
      D1,
      baseMsg({
        deliveryId: 'd-reply',
        coords: { platform: 'slack', channel: 'C_EXECS', thread: '900.1' },
        lineageReplyTo: 'acp-execs-origin'
      })
    )
    expect(reply.delivered).toBe(true)
    expect(forwards).toHaveLength(1)
    expect(forwards[0]!).toMatchObject({
      lineageReplyTo: 'acp-execs-origin',
      coords: { platform: 'slack', channel: 'C_EXECS', thread: '900.1' }
    })
  })

  it('coords integrity: a DM / group-DM row the caller owns is KNOWN, so DM-origin A2A still routes', async () => {
    // The over-block this fail-closed branch could have caused, and the claim it rests on: a
    // direct conversation is an ORDINARY channel row wherever one exists. `IntegrationChannel
    // .kind` is `channel | im | mpim` and `IntegrationRepo.channelPlacements` selects the
    // channels with NO filter on `kind`, so a recorded DM arrives in this snapshot as a plain
    // row with its owning agent in it — branch 1, not the fail-closed one. Every visibility
    // reports the row after observation; a wake racing ahead of that still takes branch 2.
    const INT_DM = '00000000-0000-0000-0000-0000000000f3'
    const s = snap()
    s.channels.push(
      // Slack "D…" one-to-one DM between the human and A's bot.
      { orgId: ORG, platform: 'slack', channelId: 'D01ALICE', agents: [placement({ agentId: A, daemonId: D1 })] },
      // Slack "G…" mpim (group DM) the same bot sits in.
      {
        orgId: ORG,
        platform: 'slack',
        channelId: 'G01TEAM',
        agents: [placement({ agentId: A, daemonId: D1, integrationId: INT_DM })]
      }
    )
    const router = new CollaborationRouter()
    router.replace(s)
    const forwards: RdAgentMsgFwd[] = []
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, forwards),
      log: noopLog
    })

    const dm = await route(D1, baseMsg({ coords: { platform: 'slack', channel: 'D01ALICE', thread: '900.1' } }))
    expect(dm.delivered).toBe(true)
    expect(forwards[0]!.coords).toEqual({ platform: 'slack', channel: 'D01ALICE', thread: '900.1' })

    const groupDm = await route(
      D1,
      baseMsg({ deliveryId: 'd-2', coords: { platform: 'slack', channel: 'G01TEAM', thread: '900.2' } })
    )
    expect(groupDm.delivered).toBe(true)
    expect(forwards).toHaveLength(2)

    // A DM row the caller does NOT own is still not assertable — the branch is membership,
    // not "any DM goes".
    s.channels.push({
      orgId: ORG,
      platform: 'slack',
      channelId: 'D02BOB',
      agents: [placement({ agentId: B, daemonId: D2 })]
    })
    router.replace({ ...s, generation: 2 })
    const foreignDm = await route(
      D1,
      baseMsg({ deliveryId: 'd-3', coords: { platform: 'slack', channel: 'D02BOB', thread: '900.3' } })
    )
    expect(foreignDm).toMatchObject({ delivered: false, reason: 'not_allowed' })
    expect(forwards).toHaveLength(2)
  })

  it('target callPolicy=selected, caller not allowed → NAK not_allowed at the relay', async () => {
    const s = snap()
    s.agents[1]!.callPolicy = 'selected'
    s.agents[1]!.allowedCallerAgentIds = [] // A not allowed
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
    s.agents[0]!.outboundPolicy = 'selected'
    s.agents[0]!.allowedTargetAgentIds = []
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

  it('target absent from the org directory → NAK not_found', async () => {
    const s = snap()
    s.agents = s.agents.filter((a) => a.agentId !== B) // drop B from the directory
    s.channels[0]!.agents = s.channels[0]!.agents.filter((a) => a.agentId !== B)
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

  // The install window (#987): the CP carries a pool agent whose grant is not confirmed (or whose
  // lapsed lease a live member is about to claim) as a PENDING entry — present, policy intact, no
  // daemon. The verdict is the retryable `not_ready`, and it is NOT cached: the source re-sends the
  // same deliveryId, and once the directory names the member the retransmit is forwarded — once.
  it('PENDING target (directory entry with no daemon) → NAK not_ready, uncached; the retransmit forwards once the member is named', async () => {
    const pending = snap()
    pending.agents = pending.agents.map((a) => (a.agentId === B ? orgAgent({ agentId: B }) : a))
    pending.channels[0]!.agents = pending.channels[0]!.agents.filter((a) => a.agentId !== B)
    const router = new CollaborationRouter()
    router.replace(pending)
    const forwards: RdAgentMsgFwd[] = []
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, forwards),
      log: noopLog
    })
    const first = await route(D1, baseMsg())
    expect(first).toEqual({ deliveryId: 'd-1', delivered: false, reason: 'not_ready' })
    // Still pending: re-evaluated, still not_ready, still nothing forwarded.
    expect(await route(D1, baseMsg())).toEqual(first)
    expect(forwards).toHaveLength(0)

    // The member confirms; the CP re-pushes with B routable at D2. Same deliveryId → forwarded.
    router.replace({ ...snap(), generation: 2 })
    const retry = await route(D1, baseMsg())
    expect(retry.delivered).toBe(true)
    expect(forwards).toHaveLength(1)
    // ...and THAT verdict is cached like any other: a further retransmit replays, no double wake.
    expect(await route(D1, baseMsg())).toEqual(retry)
    expect(forwards).toHaveLength(1)
  })

  it('PENDING target still fails policy terminally — a refusal is not deferred behind not_ready', async () => {
    const pending = snap()
    pending.agents = pending.agents.map((a) =>
      a.agentId === B ? orgAgent({ agentId: B, callPolicy: 'selected', allowedCallerAgentIds: [] }) : a
    )
    const router = new CollaborationRouter()
    router.replace(pending)
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, []),
      log: noopLog
    })
    expect((await route(D1, baseMsg())).reason).toBe('not_allowed')
  })

  it('PENDING caller (no confirmed member to bind the socket to) → NAK not_ready, not forged', async () => {
    const pending = snap()
    pending.agents = pending.agents.map((a) => (a.agentId === A ? orgAgent({ agentId: A }) : a))
    const router = new CollaborationRouter()
    router.replace(pending)
    const forwards: RdAgentMsgFwd[] = []
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, forwards),
      log: noopLog
    })
    expect(await route(D1, baseMsg())).toEqual({ deliveryId: 'd-1', delivered: false, reason: 'not_ready' })
    expect(forwards).toHaveLength(0)
    router.replace({ ...snap(), generation: 2 })
    expect((await route(D1, baseMsg())).delivered).toBe(true)
  })

  it('a target daemon answering not_ready is passed through uncached, so the retransmit is re-forwarded', async () => {
    const router = new CollaborationRouter()
    router.replace(snap())
    const forwards: RdAgentMsgFwd[] = []
    let verdict: RdAgentMsgAck = { deliveryId: 'd-1', delivered: false, reason: 'not_ready' }
    const conn = {
      supports: () => true,
      forwardAgentMsg: vi.fn(async (fwd: RdAgentMsgFwd) => {
        forwards.push(fwd)
        return verdict
      })
    }
    const route = createAgentMsgRouter({
      router,
      daemons: () => ({ get: (id: string) => (id === D2 ? conn : undefined) }) as unknown as RelayDaemonServer,
      log: noopLog
    })
    expect((await route(D1, baseMsg())).reason).toBe('not_ready')
    verdict = { deliveryId: 'd-1', delivered: true }
    expect((await route(D1, baseMsg())).delivered).toBe(true)
    expect(forwards).toHaveLength(2)
    expect((await route(D1, baseMsg())).delivered).toBe(true)
    expect(forwards).toHaveLength(2)
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

  it('cross-org target → rejected even though both sit in the same channel id', async () => {
    // Org scoping is now the ONLY isolation boundary (channel is not consulted), so put
    // B in ORG2 and leave the identical channel id in place: it must still not resolve,
    // and the reason must be indistinguishable from "no such agent" (no cross-org probing).
    const s = snap()
    s.agents[1]!.orgId = ORG2
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
    expect(router.admits(A, B)).toBe(false)
  })

  it('org-scoped resolve: caller and target share NO channel at all → still delivered', async () => {
    // The whole point of the org-scoped directory: an integration-less peer (webchat/hook/
    // dream) appears in no `channels[]` row, so channel membership cannot be the gate.
    const s: CollabRoutesSnapshot = {
      generation: 1,
      platformKinds: [],
      agents: [orgAgent({ agentId: A, daemonId: D1 }), orgAgent({ agentId: B, daemonId: D2 })],
      channels: [] // nobody has an IM integration
    }
    const router = new CollaborationRouter()
    router.replace(s)
    const forwards: RdAgentMsgFwd[] = []
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, forwards),
      log: noopLog
    })

    const ack = await route(D1, baseMsg({ coords: { platform: 'webchat', channel: 'wc-1' } }))
    expect(ack.delivered).toBe(true)
    expect(forwards[0]!.trustedFromAgentId).toBe(A)
    expect(forwards[0]!.orgId).toBe(ORG)
    // No channel placement ⇒ no reply integration, and coords ride through as the delivery
    // coordinate regardless.
    expect(forwards[0]!.integrationId).toBeUndefined()
    expect(forwards[0]!.coords).toEqual({ platform: 'webchat', channel: 'wc-1' })
  })

  it('forged caller is still rejected with no channel in play (placement belongs to another daemon)', async () => {
    const s: CollabRoutesSnapshot = {
      generation: 1,
      platformKinds: [],
      agents: [orgAgent({ agentId: A, daemonId: D1 }), orgAgent({ agentId: B, daemonId: D2 })],
      channels: []
    }
    const router = new CollaborationRouter()
    router.replace(s)
    const forwards: RdAgentMsgFwd[] = []
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, forwards),
      log: noopLog
    })
    // Socket authenticated as D2, but it claims A — whose directory placement is on D1.
    const ack = await route(D2, baseMsg())
    expect(ack).toMatchObject({ delivered: false, reason: 'not_allowed' })
    expect(forwards).toHaveLength(0)
  })

  it('unknown target id (never in the directory) → not_found, and admits() fails closed', async () => {
    const router = new CollaborationRouter()
    router.replace(snap())
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, []),
      log: noopLog
    })
    const ghost = '00000000-0000-0000-0000-0000000000ff'
    const ack = await route(D1, baseMsg({ toAgentId: ghost }))
    expect(ack).toMatchObject({ delivered: false, reason: 'not_found' })
    expect(router.admits(A, ghost)).toBe(false)
    expect(router.admits(ghost, A)).toBe(false)
    // A caller always admits ITSELF, even with a 'selected' outbound policy that omits it.
    expect(router.admits(A, A)).toBe(true)
  })

  it('old CP (no flat agents[]): the directory is derived from the channel rows', async () => {
    // Rolling upgrade: an old CP advertises no `agent-directory-org-scope-v1` and sends no
    // `agents[]` (schema default `[]`), so an integration-backed pair must keep authorizing.
    const s = snap()
    s.agents = []
    const router = new CollaborationRouter()
    router.replace(s)
    expect(router.orgForAgent(A)).toBe(ORG)
    expect(router.admits(A, B)).toBe(true)

    const forwards: RdAgentMsgFwd[] = []
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, forwards),
      log: noopLog
    })
    const ack = await route(D1, baseMsg())
    expect(ack.delivered).toBe(true)
    expect(forwards[0]!.orgId).toBe(ORG)
    expect(forwards[0]!.integrationId).toBe(INT)
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
    s.agents.push(orgAgent({ agentId: A2, daemonId: D2, integrationId: INT }))
    // A2 needs a C1 placement too: both calls below assert coords slack:C1, and the
    // coordinate-integrity gate requires a caller asserting a KNOWN channel to actually
    // be in it (see the F1 regression test above).
    s.channels[0]!.agents.push(placement({ agentId: A2, daemonId: D2 }))
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
      platformKinds: [],
      agents: [orgAgent({ agentId: A, daemonId: D1 }), orgAgent({ agentId: B, daemonId: D2 })],
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
              callPolicy: 'all',
              allowedCallerAgentIds: [],
              outboundPolicy: 'all',
              allowedTargetAgentIds: []
            },
            {
              agentId: B,
              daemonId: D2,
              integrationId: '00000000-0000-0000-0000-0000000000f2', // different bot's integration
              callPolicy: 'all',
              allowedCallerAgentIds: [],
              outboundPolicy: 'all',
              allowedTargetAgentIds: []
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
    expect(forwards[0]!.integrationId).toBe('00000000-0000-0000-0000-0000000000f2')
  })

  it('hop cap: a next delivery at the cap → NAK hop_limit', async () => {
    const router = new CollaborationRouter()
    router.replace(snap())
    const forwards: RdAgentMsgFwd[] = []
    const route = createAgentMsgRouter({
      router,
      daemons: () => fakeDaemons({ deliveryId: 'd-1', delivered: true }, forwards),
      log: noopLog
    })
    const ack = await route(D1, baseMsg({ hopCount: MAX_AGENT_CALL_HOPS - 1, deliveryId: 'd-hop' }))
    expect(ack.delivered).toBe(false)
    expect(ack.reason).toBe('hop_limit')
    expect(forwards).toHaveLength(0)
  })
})
