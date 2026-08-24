import { describe, it, expect } from 'vitest'
import {
  WireFeishuCardActionEvent,
  RdMsg,
  RdMsgWebchat,
  RdAck,
  RD_ACK_NOT_HOLDER,
  RdChat,
  RdAgentMsg,
  RdAgentMsgAck,
  RdAgentMsgFwd,
  RD_AGENTMSG_NOT_READY,
  isRetryableAgentMsgAck,
  RdSlackAction,
  MAX_AGENT_CALL_HOPS,
  hasReachedAgentCallHopLimit,
  RD_HEADLESS_AGENT_DELIVERY_V1,
  RelayWebchatOp,
  WEBCHAT_IMAGE_MAX_BYTES,
  RELAY_DAEMON_FRAME_TYPES,
  buildRelayDaemonFrame,
  decodeRelayDaemonFrame,
  isRelayDaemonFrameType,
  decodeEnvelope,
  encode
} from '../index.js'

const ID = '11111111-1111-4111-8111-111111111111'
const RELAY_ID = '55555555-5555-4555-8555-555555555555'
const DAEMON_ID = '22222222-2222-4222-8222-222222222222'
const AGENT_ID = '33333333-3333-4333-8333-333333333333'
const CONV_ID = '66666666-6666-4666-8666-666666666666'
const TURN_ID = '77777777-7777-4777-8777-777777777777'
const AUTHORITY_ID = '99999999-9999-4999-8999-999999999999'
const ORG_ID = 'org_default00000000000000000'
const TS = '2026-07-07T00:00:00.000Z'

function envelope(type: string, payload: unknown, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ v: 1, id: ID, ts: TS, type, payload, ...extra })
}

/** A valid webchat turn rd/msg payload (the milestone-A slice). */
const turnMsg = {
  source: 'webchat' as const,
  agentId: AGENT_ID,
  sessionKey: CONV_ID,
  msgId: 'm-1',
  chatId: CONV_ID,
  payload: { op: 'turn' as const, text: 'hello', user: 'user@example.com' }
}

const HOOK_ID = '88888888-8888-4888-8888-888888888888'

/** A valid headless hook fire rd/msg payload (the milestone-B-github slice). */
const hookMsg = {
  source: 'hook' as const,
  agentId: AGENT_ID,
  sessionKey: `${HOOK_ID}:dk-1`,
  msgId: `${HOOK_ID}:dk-1`,
  hookId: HOOK_ID,
  deliveryKey: 'dk-1',
  firedAt: TS,
  context: { source: 'webhook' as const, body: '{"status":"red"}', truncated: true }
}

describe('relay↔daemon wire — skeleton frame codec (shared-bot-relay.md §7.2)', () => {
  it('round-trips rd/hello → rd/hello/ok', () => {
    const hello = buildRelayDaemonFrame('rd/hello', { apiKey: 'k'.repeat(49), daemonId: DAEMON_ID })
    const decoded = decodeRelayDaemonFrame(JSON.stringify(hello))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error('expected ok')
    if (decoded.frame.type !== 'rd/hello') throw new Error('narrow')
    expect(decoded.frame.payload.daemonId).toBe(DAEMON_ID)

    const ok = buildRelayDaemonFrame('rd/hello/ok', { relayId: RELAY_ID }, { corr: hello.id })
    const decodedOk = decodeRelayDaemonFrame(JSON.stringify(ok))
    expect(decodedOk.ok).toBe(true)
    if (!decodedOk.ok) throw new Error('expected ok')
    expect(decodedOk.frame.corr).toBe(hello.id)
  })

  it('decodes an rd/msg webchat turn and answers it with rd/ack', () => {
    const r = decodeRelayDaemonFrame(envelope('rd/msg', turnMsg))
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('expected ok')
    if (r.frame.type !== 'rd/msg') throw new Error('narrow')
    if (r.frame.payload.source !== 'webchat') throw new Error('narrow source')
    if (r.frame.payload.payload.op !== 'turn') throw new Error('narrow op')
    expect(r.frame.payload.payload.text).toBe('hello')

    const ack = buildRelayDaemonFrame(
      'rd/ack',
      { msgId: turnMsg.msgId, accepted: true, turnId: TURN_ID },
      { corr: r.frame.id }
    )
    const decodedAck = decodeRelayDaemonFrame(JSON.stringify(ack))
    expect(decodedAck.ok).toBe(true)
  })

  it('round-trips rd/msg webchat deliveries with and without remote-MCP entitlement', () => {
    const legacy = decodeRelayDaemonFrame(envelope('rd/msg', turnMsg))
    expect(legacy.ok).toBe(true)
    if (!legacy.ok || legacy.frame.type !== 'rd/msg' || legacy.frame.payload.source !== 'webchat') {
      throw new Error('expected legacy webchat delivery')
    }
    expect(legacy.frame.payload.remoteMcp).toBeUndefined()

    const remoteMcp = { authorityId: AUTHORITY_ID, authorityGeneration: 2, expiresAt: TS }
    const current = buildRelayDaemonFrame('rd/msg', { ...turnMsg, remoteMcp })
    const decoded = decodeRelayDaemonFrame(JSON.stringify(current))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok || decoded.frame.type !== 'rd/msg' || decoded.frame.payload.source !== 'webchat') {
      throw new Error('expected remote-MCP webchat delivery')
    }
    expect(decoded.frame.payload.remoteMcp).toEqual(remoteMcp)
  })

  it('rejects malformed remote-MCP rd/msg webchat entitlements', () => {
    expect(
      decodeRelayDaemonFrame(
        envelope('rd/msg', {
          ...turnMsg,
          remoteMcp: { authorityId: AUTHORITY_ID, authorityGeneration: 0, expiresAt: TS }
        })
      ).ok
    ).toBe(false)
    expect(
      decodeRelayDaemonFrame(
        envelope('rd/msg', {
          ...turnMsg,
          remoteMcp: { authorityId: 'not-a-uuid', authorityGeneration: 1, expiresAt: TS }
        })
      ).ok
    ).toBe(false)
  })

  it('strips a browser-forged entitlement and preserves the trusted outer entitlement', () => {
    const attackerEntitlement = {
      authorityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      authorityGeneration: 99,
      expiresAt: '2027-07-07T00:00:00.000Z'
    }
    const trustedEntitlement = {
      authorityId: AUTHORITY_ID,
      authorityGeneration: 2,
      expiresAt: TS
    }

    const browserOp = RelayWebchatOp.parse({
      op: 'turn',
      text: 'hello',
      remoteMcp: attackerEntitlement
    })
    expect(browserOp).toEqual({ op: 'turn', text: 'hello' })
    expect(browserOp).not.toHaveProperty('remoteMcp')

    const delivery = RdMsgWebchat.parse({
      ...turnMsg,
      remoteMcp: trustedEntitlement,
      payload: browserOp
    })
    expect(delivery.remoteMcp).toEqual(trustedEntitlement)
    expect(delivery.payload).not.toHaveProperty('remoteMcp')
  })

  it('rd/ack carries a rejection verdict (reason, no turn stream)', () => {
    expect(RdAck.safeParse({ msgId: 'm-1', accepted: false, reason: 'no_agent' }).success).toBe(true)
    expect(RdAck.safeParse({ msgId: 'm-1', accepted: true }).success).toBe(true)
    // The retired Feishu-named slot from a pre-flip daemon strips cleanly.
    const dual = RdAck.safeParse({
      msgId: 'm-1',
      accepted: true,
      feishuCardAction: { toast: { type: 'info', content: 'Cancellation requested.' } },
      response: { toast: { type: 'info', content: 'Cancellation requested.' } }
    })
    expect(dual.success).toBe(true)
    if (dual.success) expect('feishuCardAction' in dual.data).toBe(false)
    expect(RdAck.safeParse({ msgId: 'm-1' }).success).toBe(false) // verdict is required
  })

  it('carries every webchat control op and rejects unknown ops', () => {
    const ops = [
      {
        op: 'turn',
        text: 'hello',
        turnId: TURN_ID,
        worktree: false,
        runtime: { model: 'gpt-5.6-sol', effort: 'xhigh', permissionMode: 'full-access', fastMode: true }
      },
      { op: 'resume', turnId: TURN_ID, generation: 2, afterIndex: 3 },
      { op: 'set_model', model: 'opus-4.8' },
      { op: 'set_effort', effort: 'high' },
      { op: 'set_permission_mode', permissionMode: 'plan' },
      { op: 'set_fast', fastMode: true },
      { op: 'cancel' },
      { op: 'close' }
    ]
    for (const payload of ops) {
      expect(RelayWebchatOp.safeParse(payload).success).toBe(true)
      const r = decodeRelayDaemonFrame(envelope('rd/msg', { ...turnMsg, payload }))
      expect(r.ok).toBe(true)
    }
    expect(RelayWebchatOp.safeParse({ op: 'set_theme', theme: 'dark' }).success).toBe(false)
    expect(RelayWebchatOp.safeParse({ op: 'turn' }).success).toBe(false) // text required
    expect(RelayWebchatOp.safeParse({ op: 'turn', text: 'hi', runtime: { fastMode: 'yes' } }).success).toBe(false)
    expect(RelayWebchatOp.safeParse({ op: 'turn', text: 'hi', worktree: 'yes' }).success).toBe(false)
    expect(RelayWebchatOp.safeParse({ op: 'resume', turnId: TURN_ID, generation: 1, afterIndex: -2 }).success).toBe(
      false
    )
    expect(RelayWebchatOp.safeParse({ op: 'resume', turnId: 'not-a-uuid', generation: 1, afterIndex: 0 }).success).toBe(
      false
    )
    expect(RelayWebchatOp.safeParse({ op: 'resume', turnId: TURN_ID, generation: 0, afterIndex: 0 }).success).toBe(
      false
    )
  })

  it('carries one bounded inline image on a webchat turn', () => {
    const image = {
      name: 'screenshot.webp',
      mimeType: 'image/webp' as const,
      data: Buffer.from('small image').toString('base64')
    }
    expect(RelayWebchatOp.safeParse({ op: 'turn', text: '', attachments: [image] }).success).toBe(true)
    expect(
      decodeRelayDaemonFrame(
        envelope('rd/msg', { ...turnMsg, payload: { op: 'turn', text: '', attachments: [image] } })
      ).ok
    ).toBe(true)
    expect(
      RelayWebchatOp.safeParse({
        op: 'turn',
        text: 'look',
        attachments: [{ ...image, mimeType: 'image/svg+xml' }]
      }).success
    ).toBe(false)
    expect(RelayWebchatOp.safeParse({ op: 'turn', text: 'look', attachments: [image, image] }).success).toBe(false)
    expect(
      RelayWebchatOp.safeParse({
        op: 'turn',
        text: 'look',
        attachments: [{ ...image, data: 'not base64' }]
      }).success
    ).toBe(false)
    expect(
      RelayWebchatOp.safeParse({
        op: 'turn',
        text: 'look',
        attachments: [{ ...image, data: Buffer.alloc(WEBCHAT_IMAGE_MAX_BYTES + 1).toString('base64') }]
      }).success
    ).toBe(false)
  })

  it('decodes an rd/msg im (shared bot) inbound, pre-addressed to an agent', () => {
    const im = {
      source: 'im' as const,
      agentId: AGENT_ID,
      sessionKey: 'C123/1720000000.000100',
      msgId: 'Ev0PV52K21',
      botId: DAEMON_ID,
      integrationId: CONV_ID,
      chatId: 'C123',
      payload: {
        msgId: 'Ev0PV52K21',
        traceId: 't-1',
        source: 'user',
        platform: 'slack',
        channel: 'C123',
        thread: '1720000000.000100',
        sender: { id: 'U1', isBot: false },
        text: '@bot deploy please',
        mentionedBots: ['UBOT'],
        isDm: false,
        trigger: 'mention'
      }
    }
    expect(RdMsg.safeParse(im).success).toBe(true)
    const r = decodeRelayDaemonFrame(envelope('rd/msg', im))
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('expected ok')
    if (r.frame.type !== 'rd/msg') throw new Error('narrow')
    if (r.frame.payload.source !== 'im') throw new Error('narrow source')
    expect(r.frame.payload.payload.text).toBe('@bot deploy please')
    expect(r.frame.payload.integrationId).toBe(CONV_ID)
  })

  it('separates the untrusted provider authorship claim from the relay-minted trusted mint', () => {
    // send-message-routing-rework.md §8.1/§8.2: the provider's own claim rides INSIDE
    // `payload` (any workspace app could have written that metadata); what the relay
    // VERIFIED rides outside it. A target that conflated the two would treat a forged
    // metadata block as a policy identity, so the wire keeps them structurally apart.
    const im = {
      source: 'im' as const,
      agentId: AGENT_ID,
      sessionKey: 'C123/1720000000.000100',
      msgId: 'Ev0PV52K21',
      botId: DAEMON_ID,
      integrationId: CONV_ID,
      chatId: 'C123',
      payload: {
        msgId: 'Ev0PV52K21',
        traceId: 't-1',
        source: 'user',
        platform: 'slack',
        channel: 'C123',
        thread: '1720000000.000100',
        sender: { id: 'UBOT', isBot: true, appId: 'A123' },
        text: '<@U_REVIEWER> please verify the rollout',
        mentionedBots: ['U_REVIEWER'],
        isDm: false,
        agentAuthorship: {
          authorAgentId: AGENT_ID,
          responseId: 'r-1',
          deliveryState: 'final',
          hopCount: 7,
          mentionedAgentIds: [AUTHORITY_ID]
        }
      },
      trustedFromAgentId: AGENT_ID,
      trustedResponseId: 'r-1',
      trustedRecipientAgentIds: [AUTHORITY_ID],
      trustedDeliveryHopCount: 8
    }
    const r = decodeRelayDaemonFrame(envelope('rd/msg', im))
    if (!r.ok) throw new Error('expected ok')
    if (r.frame.type !== 'rd/msg') throw new Error('narrow')
    if (r.frame.payload.source !== 'im') throw new Error('narrow source')
    const frame = r.frame.payload
    // The claim states the SOURCE turn's depth; the relay's mint is that depth already
    // advanced by one and cap-checked. The target installs the mint WITHOUT adding again.
    expect(frame.payload.agentAuthorship?.hopCount).toBe(7)
    expect(frame.trustedDeliveryHopCount).toBe(8)
    expect(frame.trustedFromAgentId).toBe(AGENT_ID)

    // An unverified message carries the provider claim alone — parsing must accept that,
    // because "claimed but not promoted" is the ordinary outcome for a foreign bot.
    const claimOnly = { ...im, payload: { ...im.payload } } as Record<string, unknown>
    delete claimOnly.trustedFromAgentId
    delete claimOnly.trustedResponseId
    delete claimOnly.trustedRecipientAgentIds
    delete claimOnly.trustedDeliveryHopCount
    expect(RdMsg.safeParse(claimOnly).success).toBe(true)

    // A negative source depth is not "depth 0" — it is unverifiable, and §4.1 makes such
    // an edge transcript-only. Reject it at the wire so no consumer can coerce it.
    expect(
      RdMsg.safeParse({
        ...im,
        payload: { ...im.payload, agentAuthorship: { ...im.payload.agentAuthorship, hopCount: -1 } }
      }).success
    ).toBe(false)
    // `streaming` and `final` are the only lifecycle positions; only `final` routes.
    expect(
      RdMsg.safeParse({
        ...im,
        payload: { ...im.payload, agentAuthorship: { ...im.payload.agentAuthorship, deliveryState: 'partial' } }
      }).success
    ).toBe(false)
  })

  it('publishes ONE agent-call hop cap for every component that can admit an edge', () => {
    // send-message-routing-rework.md §4.1 requires one budget across transports: the same
    // cap "whether it is a same-daemon internal call, a relayed internal call, a
    // direct-daemon platform mention, or a relayed platform mention". It lives in the
    // shared protocol package precisely so the daemon and the relay's two enforcement
    // points cannot drift — a relay allowing one more hop than the daemon would let a
    // relayed chain outlive the budget an internal chain gets, and no single package's
    // tests would catch that.
    expect(MAX_AGENT_CALL_HOPS).toBe(20)
    expect(Number.isInteger(MAX_AGENT_CALL_HOPS)).toBe(true)
    expect(hasReachedAgentCallHopLimit(MAX_AGENT_CALL_HOPS - 1)).toBe(false)
    expect(hasReachedAgentCallHopLimit(MAX_AGENT_CALL_HOPS)).toBe(true)
  })

  it('rd/hello advertises optional daemon capabilities, and an older daemon advertises none', () => {
    // §8.4: the relay must be able to tell "understands session replies" from "never
    // said", because the second one has to REFUSE the delivery rather than let the target
    // key it by coordinates and mint the wrong session.
    const withCaps = buildRelayDaemonFrame('rd/hello', {
      apiKey: 'k'.repeat(49),
      daemonId: DAEMON_ID,
      capabilities: [RD_HEADLESS_AGENT_DELIVERY_V1]
    })
    const r = decodeRelayDaemonFrame(JSON.stringify(withCaps))
    if (!r.ok) throw new Error('expected ok')
    if (r.frame.type !== 'rd/hello') throw new Error('narrow')
    expect(r.frame.payload.capabilities).toEqual([RD_HEADLESS_AGENT_DELIVERY_V1])

    const older = decodeRelayDaemonFrame(envelope('rd/hello', { apiKey: 'k'.repeat(49), daemonId: DAEMON_ID }))
    if (!older.ok) throw new Error('expected ok')
    if (older.frame.type !== 'rd/hello') throw new Error('narrow')
    expect(older.frame.payload.capabilities).toBeUndefined()
  })

  it('carries the session-reply delivery kind across both A2A wire legs', () => {
    // §8.3: a parent-session reply is a distinct delivery KIND, not a flavor of wake — the
    // target dispatches it into the session named by `lineageReplyTo`.
    const base = {
      claimedFromAgentId: AGENT_ID,
      toAgentId: AUTHORITY_ID,
      text: 'subtask finished',
      coords: { platform: 'slack' as const, channel: 'C123' },
      hopCount: 1,
      deliveryId: 'd-1'
    }
    const sent = RdAgentMsg.safeParse({ ...base, deliveryKind: 'session-reply' })
    expect(sent.success && sent.data.deliveryKind).toBe('session-reply')
    const fwd = RdAgentMsgFwd.safeParse({
      trustedFromAgentId: AGENT_ID,
      orgId: ORG_ID,
      toAgentId: AUTHORITY_ID,
      text: 'subtask finished',
      coords: { platform: 'slack' as const, channel: 'C123' },
      hopCount: 2,
      deliveryId: 'd-1',
      deliveryKind: 'session-reply'
    })
    expect(fwd.success && fwd.data.deliveryKind).toBe('session-reply')

    // Absent ⇒ `wake`, which is exactly what every older daemon means by omitting it.
    expect(RdAgentMsg.safeParse(base).success).toBe(true)
    expect(RdAgentMsg.safeParse({ ...base, deliveryKind: 'reply' }).success).toBe(false)

    // The §8.4 refusal is its own verdict: the target is reachable but too old, which a
    // caller must be able to distinguish from `offline`.
    expect(RdAgentMsgAck.safeParse({ deliveryId: 'd-1', delivered: false, reason: 'unsupported' }).success).toBe(true)
  })

  it('decodes every shared Slack session action inside a platform_action rd/msg; RdSlackAction rejects malformed controls', () => {
    const base = {
      source: 'platform_action' as const,
      platformId: 'slack',
      agentId: AGENT_ID,
      sessionKey: 'slack:C123:1720000000.000100:agent',
      msgId: 'slack-action:abc123',
      botId: DAEMON_ID,
      integrationId: CONV_ID
    }
    const actions = [
      { kind: 'open-config', triggerId: 'trigger-1' },
      {
        kind: 'open-config-for-thread',
        triggerId: 'trigger-2',
        channelId: 'C123',
        threadTs: '1720000000.000100'
      },
      { kind: 'agent-session-stopped', channelId: 'C123', threadTs: '1720000000.000100' },
      { kind: 'set-model', model: 'opus-4.8' },
      { kind: 'set-effort', effort: 'high' },
      { kind: 'set-permission-mode', permissionMode: 'plan' },
      { kind: 'set-fast', fastMode: true },
      { kind: 'set-output', outputMode: 'medium' },
      { kind: 'cancel' },
      { kind: 'permission-choice', requestId: 'perm-1', optionId: 'allow_once' },
      { kind: 'elicitation-choice', requestId: 'elicit-1', value: 'TypeScript' },
      { kind: 'elicitation-choice', requestId: 'elicit-2', value: null }
    ]
    for (const payload of actions) {
      expect(RdSlackAction.safeParse(payload).success).toBe(true)
      expect(decodeRelayDaemonFrame(envelope('rd/msg', { ...base, payload })).ok).toBe(true)
    }
    // The envelope's payload is opaque — malformed CONTROLS are the per-platform
    // decoder's verdict (NAK unsupported_action), enforced by RdSlackAction.
    expect(RdSlackAction.safeParse({ kind: 'set-output', outputMode: 'verbose' }).success).toBe(false)
    expect(RdSlackAction.safeParse({ kind: 'open-config', triggerId: '' }).success).toBe(false)
    expect(
      RdSlackAction.safeParse({
        kind: 'open-config-for-thread',
        triggerId: 'trigger-2',
        channelId: 'C123',
        threadTs: ''
      }).success
    ).toBe(false)
    expect(RdSlackAction.safeParse({ kind: 'agent-session-stopped', channelId: 'C123' }).success).toBe(false)
    // Envelope-level identity stays schema-enforced.
    expect(RdMsg.safeParse({ ...base, integrationId: 'not-a-uuid', payload: { kind: 'cancel' } }).success).toBe(false)
  })

  it('REJECTS the retired platform-named interaction members (nothing emits them)', () => {
    // S1b cleanup: `slack_action` / `feishu_action` retired one release after the
    // relay's §6.6 emission flip. A frame from an older relay fails the decode and
    // is dropped with a log — the discriminated union no longer carries the members.
    const legacy = {
      source: 'slack_action',
      agentId: AGENT_ID,
      sessionKey: 'slack:C123:1720000000.000100:agent',
      msgId: 'slack-action:abc123',
      botId: DAEMON_ID,
      integrationId: CONV_ID,
      payload: { kind: 'cancel' }
    }
    expect(decodeRelayDaemonFrame(envelope('rd/msg', legacy)).ok).toBe(false)
    expect(RdMsg.safeParse({ ...legacy, source: 'feishu_action' }).success).toBe(false)
  })

  it('decodes a Lark / Feishu HTTP card action inside a platform_action rd/msg', () => {
    const action = {
      source: 'platform_action',
      platformId: 'feishu',
      agentId: AGENT_ID,
      sessionKey: 'feishu-action:om_card',
      msgId: 'feishu-action:abc123',
      botId: DAEMON_ID,
      integrationId: CONV_ID,
      payload: {
        context: { open_message_id: 'om_card', open_chat_id: 'oc_chat' },
        operator: { open_id: 'ou_human' },
        action: {
          tag: 'overflow',
          option: 'cancel',
          value: {
            action: 'agentconnect_reply',
            target: { v: 1, agentId: AGENT_ID, integrationId: CONV_ID }
          }
        }
      }
    }
    const decoded = decodeRelayDaemonFrame(envelope('rd/msg', action))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok || decoded.frame.type !== 'rd/msg' || decoded.frame.payload.source !== 'platform_action') {
      throw new Error('expected platform action')
    }
    // The envelope payload is opaque at the frame layer; the daemon's feishu
    // decoder validates it against WireFeishuCardActionEvent.
    expect(WireFeishuCardActionEvent.parse(decoded.frame.payload.payload).context?.open_message_id).toBe('om_card')
  })

  it('decodes an rd/msg hook fire (B-github) and enforces its required fields', () => {
    const r = decodeRelayDaemonFrame(envelope('rd/msg', hookMsg))
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('expected ok')
    if (r.frame.type !== 'rd/msg') throw new Error('narrow')
    if (r.frame.payload.source !== 'hook') throw new Error('narrow source')
    expect(r.frame.payload.msgId).toBe(`${HOOK_ID}:dk-1`)
    expect(r.frame.payload.context?.truncated).toBe(true)
    expect(r.frame.payload.target).toBeUndefined() // headless fire

    // webchat's fields don't satisfy the hook member — hookId etc are required
    expect(RdMsg.safeParse({ ...turnMsg, source: 'hook' }).success).toBe(false)
    expect(RdMsg.safeParse({ ...hookMsg, hookId: undefined }).success).toBe(false)
    expect(RdMsg.safeParse({ ...hookMsg, deliveryKey: '' }).success).toBe(false)
  })

  it('rd/msg hook carries an optional anchoring target (P1.5)', () => {
    const anchored = { ...hookMsg, target: { platform: 'slack', channel: 'C123' } }
    const parsed = RdMsg.safeParse(anchored)
    expect(parsed.success).toBe(true)
    if (!parsed.success || parsed.data.source !== 'hook') throw new Error('narrow')
    expect(parsed.data.target?.channel).toBe('C123')
  })

  it('rd/msg hook carries a body-free trusted PR revision and exact dispatch snapshot (R1/R2a)', () => {
    const pr = {
      ...hookMsg,
      sessionKey: 'acme/infra#42',
      event: 'pull_request:synchronize',
      configRevision: '3',
      dispatchRevision: '5',
      dispatchDaemonId: DAEMON_ID,
      reviewPolicy: 'full' as const,
      reportingMode: 'check' as const,
      gateMode: 'informational' as const,
      github: {
        repoId: '987654321',
        repoFullName: 'acme/infra',
        sourceInstallationId: '1234567',
        subjectKind: 'pull_request' as const,
        pullNumber: 42,
        headSha: 'a'.repeat(40),
        baseSha: 'b'.repeat(40),
        reportSha: 'a'.repeat(40)
      },
      context: {
        source: 'github' as const,
        event: 'pull_request',
        action: 'synchronize',
        repo: 'acme/infra',
        number: 42,
        bodyExcerpt: 'untrusted body'
      }
    }
    const parsed = RdMsg.safeParse(pr)
    expect(parsed.success).toBe(true)
    if (!parsed.success || parsed.data.source !== 'hook') throw new Error('narrow')
    expect(parsed.data.github?.repoId).toBe('987654321')
    expect(parsed.data.github?.reportSha).toBe('a'.repeat(40))
    expect(parsed.data.dispatchRevision).toBe('5')

    // Legacy delivery remains decodable, but has no fence with which a daemon
    // could authorize review/reporting.
    expect(RdMsg.safeParse(hookMsg).success).toBe(true)
    expect(RdMsg.safeParse({ ...pr, github: { ...pr.github, pullNumber: undefined } }).success).toBe(false)
  })

  it('rd/agentmsg/fwd accepts the opaque org ids used by the control plane', () => {
    expect(
      RdAgentMsgFwd.safeParse({
        trustedFromAgentId: AGENT_ID,
        orgId: ORG_ID,
        toAgentId: '44444444-4444-4444-8444-444444444444',
        text: 'delegate this',
        coords: { platform: 'slack', channel: 'C123' },
        hopCount: 1,
        deliveryId: 'delivery-1'
      }).success
    ).toBe(true)
  })

  it('rd/agentmsg + rd/agentmsg/fwd carry the tighten-only parentPrivate hint (session-visibility.md §5.1)', () => {
    const msg = {
      claimedFromAgentId: AGENT_ID,
      toAgentId: '44444444-4444-4444-8444-444444444444',
      text: 'delegate this',
      coords: { platform: 'slack' as const, channel: 'C123' },
      hopCount: 0,
      deliveryId: 'delivery-1'
    }
    // an old daemon omits the hint — still decodable (absent must never open capture)
    expect(RdAgentMsg.parse(msg).parentPrivate).toBeUndefined()
    expect(RdAgentMsg.parse({ ...msg, parentPrivate: true }).parentPrivate).toBe(true)

    const fwd = {
      trustedFromAgentId: AGENT_ID,
      orgId: ORG_ID,
      toAgentId: '44444444-4444-4444-8444-444444444444',
      text: 'delegate this',
      coords: { platform: 'slack' as const, channel: 'C123' },
      hopCount: 1,
      deliveryId: 'delivery-1'
    }
    // the relay forwards the hint verbatim — same optional field on the fwd leg
    expect(RdAgentMsgFwd.parse(fwd).parentPrivate).toBeUndefined()
    expect(RdAgentMsgFwd.parse({ ...fwd, parentPrivate: true }).parentPrivate).toBe(true)
  })

  it('carries an immutable Slack source through both A2A wire legs', () => {
    const externalOrigin = {
      provider: 'slack' as const,
      realmKey: 'T123',
      resourceKind: 'conversation' as const,
      resourceKey: 'C123'
    }
    const msg = {
      claimedFromAgentId: AGENT_ID,
      toAgentId: '44444444-4444-4444-8444-444444444444',
      text: 'delegate this',
      coords: { platform: 'slack' as const, channel: 'C123' },
      hopCount: 0,
      deliveryId: 'delivery-1',
      externalOrigin
    }
    expect(RdAgentMsg.parse(msg).externalOrigin).toEqual(externalOrigin)

    const fwd = {
      trustedFromAgentId: AGENT_ID,
      orgId: ORG_ID,
      toAgentId: msg.toAgentId,
      text: msg.text,
      coords: msg.coords,
      hopCount: 1,
      deliveryId: msg.deliveryId,
      externalOrigin
    }
    expect(RdAgentMsgFwd.parse(fwd).externalOrigin).toEqual(externalOrigin)
  })

  it('carries only the immutable GitHub repository audience through A2A wire legs', () => {
    const externalOrigin = {
      provider: 'github' as const,
      realmKey: 'github.com' as const,
      resourceKind: 'repository' as const,
      resourceKey: '123456789'
    }
    const msg = {
      claimedFromAgentId: AGENT_ID,
      toAgentId: '44444444-4444-4444-8444-444444444444',
      text: 'delegate this',
      // Headless hook callers use the relay's existing Slack-shaped A2A
      // coordinate; the inherited audience remains GitHub repository-scoped.
      coords: { platform: 'slack' as const, channel: 'repo-session' },
      hopCount: 0,
      deliveryId: 'delivery-1',
      externalOrigin
    }
    expect(RdAgentMsg.parse(msg).externalOrigin).toEqual(externalOrigin)
    expect(
      RdAgentMsgFwd.parse({
        trustedFromAgentId: AGENT_ID,
        orgId: ORG_ID,
        toAgentId: msg.toAgentId,
        text: msg.text,
        coords: msg.coords,
        hopCount: 1,
        deliveryId: msg.deliveryId,
        externalOrigin
      }).externalOrigin
    ).toEqual(externalOrigin)
  })

  it('rd/chat streams webchat output and done events verbatim', () => {
    const output = {
      chatId: CONV_ID,
      seq: 0,
      event: {
        kind: 'output',
        output: { conversationId: CONV_ID, turnId: TURN_ID, index: 0, event: { kind: 'message', text: 'hi' } }
      }
    }
    expect(RdChat.safeParse(output).success).toBe(true)

    const statusOnly = {
      chatId: CONV_ID,
      seq: 1,
      event: {
        kind: 'output',
        output: { conversationId: CONV_ID, turnId: TURN_ID, index: 1, status: { model: 'opus-4.8' } }
      }
    }
    expect(RdChat.safeParse(statusOnly).success).toBe(true)

    const done = {
      chatId: CONV_ID,
      seq: 2,
      event: {
        kind: 'done',
        done: { conversationId: CONV_ID, turnId: TURN_ID, lastIndex: 1, stopReason: 'end_turn' }
      }
    }
    expect(RdChat.safeParse(done).success).toBe(true)

    // the inner WebchatOutput refine still applies: event and/or status required
    const empty = {
      chatId: CONV_ID,
      seq: 3,
      event: { kind: 'output', output: { conversationId: CONV_ID, turnId: TURN_ID, index: 3 } }
    }
    expect(RdChat.safeParse(empty).success).toBe(false)
  })
})

describe('relay↔daemon wire — union separation (§8 standalone frame union)', () => {
  it('rejects daemon↔CP webchat frames as UNKNOWN_FRAME', () => {
    const r = decodeRelayDaemonFrame(
      envelope('webchat/message', { conversationId: CONV_ID, agentId: AGENT_ID, text: 'hi' })
    )
    expect(r).toEqual({ ok: false, id: ID, msg: 'UNKNOWN_FRAME' })
  })

  it('rejects rc/* frames as UNKNOWN_FRAME', () => {
    const r = decodeRelayDaemonFrame(envelope('rc/heartbeat', {}))
    expect(r).toEqual({ ok: false, id: ID, msg: 'UNKNOWN_FRAME' })
  })

  it('the daemon↔CP wire rejects rd/* frames as UNKNOWN_FRAME', () => {
    const frame = buildRelayDaemonFrame('rd/chat', {
      chatId: CONV_ID,
      seq: 0,
      event: { kind: 'done', done: { conversationId: CONV_ID, turnId: TURN_ID } }
    })
    const r = decodeEnvelope(encode(frame as never))
    expect(r).toEqual({ ok: false, id: frame.id, msg: 'UNKNOWN_FRAME' })
  })

  it('tolerates a stray fencing block (relay wires carry no fencing; ext is surfaced, never rejected)', () => {
    const r = decodeRelayDaemonFrame(envelope('rd/msg', turnMsg, { epoch: 7, agentId: AGENT_ID }))
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('expected ok')
    // the shared decode core surfaces it; rd dispatch ignores it (dedup is (sessionKey, msgId))
    expect(r.ext).toEqual({ epoch: 7, agentId: AGENT_ID })
  })

  it('isRelayDaemonFrameType guards exactly the rd union', () => {
    for (const t of RELAY_DAEMON_FRAME_TYPES) expect(isRelayDaemonFrameType(t)).toBe(true)
    expect(isRelayDaemonFrameType('webchat/output')).toBe(false)
    expect(isRelayDaemonFrameType('rc/verify')).toBe(false)
  })
})

describe('RdAgentMsgAck — the retryable not_ready verdict', () => {
  it('parses not_ready and classifies only it as retryable', () => {
    const ack = (over: Partial<RdAgentMsgAck>): RdAgentMsgAck =>
      RdAgentMsgAck.parse({ deliveryId: 'd1', delivered: false, ...over })
    expect(isRetryableAgentMsgAck(ack({ reason: RD_AGENTMSG_NOT_READY }))).toBe(true)
    expect(isRetryableAgentMsgAck(ack({ reason: 'not_found' }))).toBe(false)
    expect(isRetryableAgentMsgAck(ack({ reason: 'offline' }))).toBe(false)
    expect(isRetryableAgentMsgAck(ack({ delivered: true }))).toBe(false)
  })
})

describe('RdAck — the not_holder re-route hint', () => {
  it('carries the duty holder alongside the typed reason', () => {
    const ack = RdAck.parse({
      msgId: 'm1',
      accepted: false,
      reason: RD_ACK_NOT_HOLDER,
      holderDaemonId: DAEMON_ID
    })
    expect(ack.reason).toBe('not_holder')
    expect(ack.holderDaemonId).toBe(DAEMON_ID)
  })

  it('stays optional — every existing ack still parses unchanged', () => {
    const ack = RdAck.parse({ msgId: 'm1', accepted: false, reason: 'no_agent' })
    expect(ack.holderDaemonId).toBeUndefined()
  })

  it('rejects a holder that is not a uuid', () => {
    expect(
      RdAck.safeParse({ msgId: 'm1', accepted: false, reason: RD_ACK_NOT_HOLDER, holderDaemonId: 'nope' }).success
    ).toBe(false)
  })
})
