import { describe, it, expect } from 'vitest'
import {
  RdMsg,
  RdMsgWebchat,
  RdAck,
  RdChat,
  RdAgentMsg,
  RdAgentMsgFwd,
  RdSlackAction,
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
const DELEGATION_ID = '99999999-9999-4999-8999-999999999999'
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

  it('round-trips legacy and delegated rd/msg webchat deliveries', () => {
    const legacy = decodeRelayDaemonFrame(envelope('rd/msg', turnMsg))
    expect(legacy.ok).toBe(true)
    if (!legacy.ok || legacy.frame.type !== 'rd/msg' || legacy.frame.payload.source !== 'webchat') {
      throw new Error('expected legacy webchat delivery')
    }
    expect(legacy.frame.payload.delegation).toBeUndefined()

    const delegation = { id: DELEGATION_ID, generation: 2, expiresAt: TS }
    const current = buildRelayDaemonFrame('rd/msg', { ...turnMsg, delegation })
    const decoded = decodeRelayDaemonFrame(JSON.stringify(current))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok || decoded.frame.type !== 'rd/msg' || decoded.frame.payload.source !== 'webchat') {
      throw new Error('expected delegated webchat delivery')
    }
    expect(decoded.frame.payload.delegation).toEqual(delegation)
  })

  it('rejects malformed delegated rd/msg webchat references', () => {
    expect(
      decodeRelayDaemonFrame(
        envelope('rd/msg', {
          ...turnMsg,
          delegation: { id: DELEGATION_ID, generation: 0, expiresAt: TS }
        })
      ).ok
    ).toBe(false)
    expect(
      decodeRelayDaemonFrame(
        envelope('rd/msg', {
          ...turnMsg,
          delegation: { id: 'not-a-uuid', generation: 1, expiresAt: TS }
        })
      ).ok
    ).toBe(false)
  })

  it('strips a browser-forged delegation and preserves the trusted outer reference', () => {
    const attackerDelegation = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      generation: 99,
      expiresAt: '2027-07-07T00:00:00.000Z'
    }
    const trustedDelegation = {
      id: DELEGATION_ID,
      generation: 2,
      expiresAt: TS
    }

    const browserOp = RelayWebchatOp.parse({
      op: 'turn',
      text: 'hello',
      delegation: attackerDelegation
    })
    expect(browserOp).toEqual({ op: 'turn', text: 'hello' })
    expect(browserOp).not.toHaveProperty('delegation')

    const delivery = RdMsgWebchat.parse({
      ...turnMsg,
      delegation: trustedDelegation,
      payload: browserOp
    })
    expect(delivery.delegation).toEqual(trustedDelegation)
    expect(delivery.payload).not.toHaveProperty('delegation')
  })

  it('rd/ack carries a rejection verdict (reason, no turn stream)', () => {
    expect(RdAck.safeParse({ msgId: 'm-1', accepted: false, reason: 'no_agent' }).success).toBe(true)
    expect(RdAck.safeParse({ msgId: 'm-1', accepted: true }).success).toBe(true)
    expect(
      RdAck.safeParse({
        msgId: 'm-1',
        accepted: true,
        feishuCardAction: { toast: { type: 'info', content: 'Cancellation requested.' } }
      }).success
    ).toBe(true)
    expect(RdAck.safeParse({ msgId: 'm-1' }).success).toBe(false) // verdict is required
  })

  it('carries every webchat control op and rejects unknown ops', () => {
    const ops = [
      {
        op: 'turn',
        text: 'hello',
        turnId: TURN_ID,
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

  it('decodes every shared Slack session action inside rd/msg and rejects malformed controls', () => {
    const base = {
      source: 'slack_action' as const,
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
    expect(RdMsg.safeParse({ ...base, payload: { kind: 'set-output', outputMode: 'verbose' } }).success).toBe(false)
    expect(RdMsg.safeParse({ ...base, payload: { kind: 'open-config', triggerId: '' } }).success).toBe(false)
    expect(
      RdMsg.safeParse({
        ...base,
        payload: { kind: 'open-config-for-thread', triggerId: 'trigger-2', channelId: 'C123', threadTs: '' }
      }).success
    ).toBe(false)
    expect(RdMsg.safeParse({ ...base, integrationId: 'not-a-uuid', payload: { kind: 'cancel' } }).success).toBe(false)
  })

  it('decodes a Lark / Feishu HTTP card action inside rd/msg', () => {
    const action = {
      source: 'feishu_action',
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
    if (!decoded.ok || decoded.frame.type !== 'rd/msg' || decoded.frame.payload.source !== 'feishu_action') {
      throw new Error('expected Feishu action')
    }
    expect(decoded.frame.payload.payload.context?.open_message_id).toBe('om_card')
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
