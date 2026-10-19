import { describe, expect, it } from 'vitest'
import {
  AhpFeatureConfig,
  AhpSessionReserve,
  AhpSessionUri,
  AHP_MAX_MESSAGE_BYTES,
  RdAhpMessage,
  RdAhpOpen
} from './ahp.js'
import { buildRelayDaemonFrame, decodeRelayDaemonFrame } from './frames/relay-daemon.js'
import { RcVerify } from './frames/relay-cp.js'
import { buildEnvelope, decodeEnvelope } from './codec.js'

const id = '11111111-1111-4111-8111-111111111111'
const authorization = {
  orgId: 'cmorg123456789',
  agentId: id,
  userId: 'user',
  user: 'User',
  callerRole: 'owner',
  callerApproves: true,
  grant: { token: 'signed-grant', expiresAtMs: 123456789 }
}

describe('AHP rollout and carrier boundaries', () => {
  it('defaults to legacy and rejects AHP selection while off or shadow', () => {
    expect(AhpFeatureConfig.parse({})).toEqual({ ahp: { mode: 'off' }, webchat: { protocol: 'legacy' } })
    for (const mode of ['off', 'shadow']) {
      expect(AhpFeatureConfig.safeParse({ ahp: { mode }, webchat: { protocol: 'ahp' } }).success).toBe(false)
    }
    expect(AhpFeatureConfig.parse({ ahp: { mode: 'on' } }).webchat.protocol).toBe('legacy')
    expect(AhpFeatureConfig.parse({ ahp: { mode: 'on' }, webchat: { protocol: 'ahp' } }).webchat.protocol).toBe('ahp')
  })

  it('preserves opaque protocol messages over the data-plane carrier', () => {
    const message = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { custom: 'λ' } })
    const frame = buildRelayDaemonFrame('rd/ahp/message', { attachmentId: id, message })
    const decoded = decodeRelayDaemonFrame(JSON.stringify(frame))
    expect(decoded.ok).toBe(true)
    if (decoded.ok) expect(decoded.frame.payload).toEqual({ attachmentId: id, message })
  })

  it('bounds bytes as well as characters and escaping overhead', () => {
    expect(RdAhpMessage.safeParse({ attachmentId: id, message: 'a'.repeat(AHP_MAX_MESSAGE_BYTES) }).success).toBe(true)
    expect(RdAhpMessage.safeParse({ attachmentId: id, message: 'λ'.repeat(AHP_MAX_MESSAGE_BYTES) }).success).toBe(false)
    expect(RdAhpMessage.safeParse({ attachmentId: id, message: '\u0000'.repeat(AHP_MAX_MESSAGE_BYTES) }).success).toBe(
      false
    )
    expect(RdAhpMessage.safeParse({ attachmentId: id, message: 'hello', orgId: id }).success).toBe(false)
  })

  it('requires a scoped principal and expiring CP grant on attachment', () => {
    expect(RdAhpOpen.safeParse({ attachmentId: id, authorization }).success).toBe(true)
    expect(
      RdAhpOpen.safeParse({ attachmentId: id, authorization: { ...authorization, grant: undefined } }).success
    ).toBe(false)
    expect(
      RdAhpOpen.safeParse({ attachmentId: id, authorization: { ...authorization, credential: 'raw-key' } }).success
    ).toBe(false)
    expect(RcVerify.parse({ kind: 'ahp-client-key', credential: 'key', agentId: id }).kind).toBe('ahp-client-key')
    expect(RcVerify.safeParse({ kind: 'ahp-client-key', credential: 'key' }).success).toBe(false)
  })
})

describe('AHP registry control metadata', () => {
  it('accepts canonical client-chosen URIs and rejects aliases', () => {
    expect(AhpSessionUri.parse(`ahp-session:/${id}`)).toBe(`ahp-session:/${id}`)
    for (const uri of [
      'ahp-session://host/a',
      'ahp-session:/a/../b',
      'ahp-session:/%61',
      'ahp-session:/a?x=1',
      'ahp-session:/a#b',
      'AHP-SESSION:/a',
      'ahp-session:/a//b'
    ]) {
      expect(AhpSessionUri.safeParse(uri).success, uri).toBe(false)
    }
  })

  it('preserves a duty term beyond the JavaScript integer range', () => {
    const input = {
      orgId: 'org',
      agentId: id,
      grant: 'signed',
      sessionUri: `ahp-session:/${id}`,
      operationId: id,
      duty: { groupId: id, term: '9007199254740993' }
    }
    expect(AhpSessionReserve.parse(input).duty?.term).toBe('9007199254740993')
    expect(AhpSessionReserve.safeParse({ ...input, duty: { groupId: id, term: 1 } }).success).toBe(false)
  })

  it('decodes a metadata-only reservation request on the CP wire', () => {
    const payload = {
      orgId: 'cmorg123456789',
      agentId: id,
      grant: 'signed',
      sessionUri: `ahp-session:/${id}`,
      operationId: id
    }
    const frame = buildEnvelope('ahp/session/reserve', payload)
    const decoded = decodeEnvelope(JSON.stringify(frame))
    expect(decoded.ok).toBe(true)
    if (decoded.ok) expect(decoded.frame.payload).toEqual(payload)
    const contentFrame = { ...frame, payload: { ...payload, prompt: 'must stay on data plane' } }
    expect(decodeEnvelope(JSON.stringify(contentFrame)).ok).toBe(false)
  })
})
