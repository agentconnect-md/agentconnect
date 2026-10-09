// The Activity routes' mapping of daemon answers to statuses the console acts on.
import { describe, expect, it } from 'vitest'
import { ProtocolError } from '../../domain/errors.js'
import { NoConnection } from '../../orchestrator/outbound.js'
import { assistantActivityFailure, assistantDraftDecisionFailure } from './agent-assistant-activity.js'

describe('assistant Activity failures', () => {
  it('maps the daemon’s reasons, an offline daemon and any other refusal', () => {
    const refused = (reason: string) =>
      assistantActivityFailure(new ProtocolError('BAD_PAYLOAD', 'refused', { details: { reason } }))
    expect(refused('assistant-mode-off')).toMatchObject({ status: 409, code: 'ASSISTANT_MODE_OFF' })
    expect(refused('unknown-agent')).toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(refused('something-new')).toMatchObject({ status: 503, code: 'DAEMON_REJECTED' })
    expect(assistantActivityFailure(new NoConnection('d1'))).toMatchObject({ status: 503, code: 'DAEMON_OFFLINE' })
    expect(assistantActivityFailure(new Error('connection closed'))).toMatchObject({ status: 503 })
    expect(assistantActivityFailure(new Error('a bug'))).toBeNull()
  })

  it('reads a decision lost after it was sent as unconfirmed, and one never sent as an offline daemon', () => {
    const unconfirmed = { status: 503, code: 'DECISION_UNCONFIRMED' }
    expect(assistantDraftDecisionFailure(new ProtocolError('INTERNAL', 'no ack after 1 tries'))).toMatchObject(
      unconfirmed
    )
    expect(assistantDraftDecisionFailure(new Error('connection closed'))).toMatchObject(unconfirmed)
    expect(assistantDraftDecisionFailure(new NoConnection('d1'))).toMatchObject({ code: 'DAEMON_OFFLINE' })
    const off = new ProtocolError('BAD_PAYLOAD', 'refused', { details: { reason: 'assistant-mode-off' } })
    expect(assistantDraftDecisionFailure(off)).toMatchObject({ code: 'ASSISTANT_MODE_OFF' })
    expect(assistantDraftDecisionFailure(new Error('a bug'))).toBeNull()
  })
})
