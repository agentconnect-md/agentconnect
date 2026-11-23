import { describe, expect, it } from 'vitest'
import {
  INSTALL_WIDE_FRAME_TYPES,
  SESSION_ADMIT_FEATURE,
  SESSION_ADMIT_REFUSAL_FEATURE,
  SESSION_LIMIT_REACHED,
  SessionAdmitRequest,
  SessionAdmitResult,
  buildEnvelope,
  decodeEnvelope,
  encode,
  isFrame,
  isFrameType
} from '../index.js'

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const CORR_ID = '22222222-2222-4222-8222-222222222222'

describe('session/admit frames (org-session-policy.md, Admission)', () => {
  it('names one agent and one outward session id', () => {
    expect(SessionAdmitRequest.parse({ agentId: AGENT_ID, sessionId: 's-1' })).toEqual({
      agentId: AGENT_ID,
      sessionId: 's-1'
    })
    expect(SessionAdmitRequest.safeParse({ agentId: 'not-a-uuid', sessionId: 's-1' }).success).toBe(false)
    expect(SessionAdmitRequest.safeParse({ agentId: AGENT_ID, sessionId: '' }).success).toBe(false)
    expect(SessionAdmitRequest.safeParse({ agentId: AGENT_ID }).success).toBe(false)
  })

  it('carries an optional maintenance purpose from a closed set', () => {
    const dream = { agentId: AGENT_ID, sessionId: 's-1', purpose: 'memory-dream' }
    expect(SessionAdmitRequest.parse(dream)).toEqual(dream)
    expect(SessionAdmitRequest.safeParse({ ...dream, purpose: 'chat' }).success).toBe(false)
    expect(SessionAdmitRequest.safeParse({ ...dream, purpose: null }).success).toBe(false)
  })

  it('reads a purpose an older schema does not know as a plain admission', () => {
    const older = SessionAdmitRequest.omit({ purpose: true })
    expect(older.parse({ agentId: AGENT_ID, sessionId: 's-1', purpose: 'memory-dream' })).toEqual({
      agentId: AGENT_ID,
      sessionId: 's-1'
    })
  })

  it('answers an admission with whether it counted, and whether the organization enforces', () => {
    expect(SessionAdmitResult.parse({ admitted: true, counted: true })).toEqual({ admitted: true, counted: true })
    expect(SessionAdmitResult.parse({ admitted: true, counted: false, enforcing: true })).toEqual({
      admitted: true,
      counted: false,
      enforcing: true
    })
    expect(SessionAdmitResult.safeParse({ admitted: true }).success).toBe(false)
    expect(SessionAdmitResult.safeParse({ admitted: false, counted: false }).success).toBe(false)
  })

  it('refuses at the limit with the count, the limit and the next reset', () => {
    const refusal = {
      admitted: false,
      reason: SESSION_LIMIT_REACHED,
      limit: 10,
      used: 10,
      resetsAt: '2026-12-01T00:00:00.000Z',
      enforcing: true
    }
    expect(SessionAdmitResult.parse(refusal)).toEqual(refusal)
    expect(SessionAdmitResult.safeParse({ ...refusal, reason: 'other' }).success).toBe(false)
    expect(SessionAdmitResult.safeParse({ ...refusal, resetsAt: 'soon' }).success).toBe(false)
    const { enforcing: _enforcing, ...withoutEnforcing } = refusal
    expect(SessionAdmitResult.safeParse(withoutEnforcing).success).toBe(false)
  })

  it('strips a key a newer peer adds instead of refusing the frame', () => {
    expect(SessionAdmitResult.parse({ admitted: true, counted: true, extra: 1 })).toEqual({
      admitted: true,
      counted: true
    })
  })

  it('round-trips the request and its correlated reply through the envelope', () => {
    const payload = { agentId: AGENT_ID, sessionId: 's-1' }
    const request = decodeEnvelope(encode(buildEnvelope('session/admit', payload)))
    if (!request.ok || !isFrame('session/admit')(request.frame)) throw new Error('expected a request')
    expect(request.frame.payload).toEqual(payload)
    const result = { admitted: true as const, counted: false }
    const reply = decodeEnvelope(encode(buildEnvelope('session/admit/result', result, { corr: CORR_ID })))
    if (!reply.ok || !isFrame('session/admit/result')(reply.frame)) throw new Error('expected a reply')
    expect(reply.frame.payload).toEqual(result)
    expect(reply.frame.corr).toBe(CORR_ID)
  })

  it('registers both frames as org-scoped members behind their own feature', () => {
    expect(SESSION_ADMIT_FEATURE).toBe('session-admit-v1')
    expect(SESSION_ADMIT_REFUSAL_FEATURE).toBe('session-admit-refusal-v1')
    for (const type of ['session/admit', 'session/admit/result']) {
      expect(isFrameType(type)).toBe(true)
      expect(INSTALL_WIDE_FRAME_TYPES.has(type as never)).toBe(false)
    }
  })
})
