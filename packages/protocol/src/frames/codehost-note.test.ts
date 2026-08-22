import { describe, expect, it } from 'vitest'
import { AnyFrame, CodeHostNoteDesired, CodeHostNoteResult, INSTALL_WIDE_FRAME_TYPES, isFrameType } from '../index.js'

const HOOK_ID = '11111111-1111-4111-8111-111111111111'
const AGENT_ID = '22222222-2222-4222-8222-222222222222'
const PROJECTION_ID = '33333333-3333-4333-8333-333333333333'
const DAEMON_ID = '44444444-4444-4444-8444-444444444444'
const WRITE_MARKER = '55555555-5555-4555-8555-555555555555'

const desired = {
  projectionId: PROJECTION_ID,
  provider: 'gitlab',
  hookId: HOOK_ID,
  agentId: AGENT_ID,
  agentName: 'reviewer',
  deliveryKey: 'delivery-1',
  generation: '3',
  projectionEpoch: '1',
  projectionKey: PROJECTION_ID,
  writeMarker: WRITE_MARKER,
  projectId: '4455667',
  projectPath: 'example-group/sub/example-project',
  mergeRequestIid: 42,
  headSha: 'abc123',
  state: 'running' as const,
  queuedAt: '2026-07-07T00:00:00.000Z',
  desiredAt: '2026-07-07T00:00:05.000Z',
  consoleUrl: 'https://console.example.test/acme/sessions/s-1?source=gitlab',
  snapshot: {
    configRevision: '7',
    dispatchRevision: '9',
    dispatchDaemonId: DAEMON_ID,
    reviewPolicy: 'off' as const,
    reportingMode: 'check' as const,
    gateMode: 'informational' as const
  },
  credentialEpoch: '2',
  leaseUntil: '2026-07-07T00:00:35.000Z'
}

const result = {
  projectionId: PROJECTION_ID,
  hookId: HOOK_ID,
  generation: '3',
  writeMarker: WRITE_MARKER,
  outcome: 'written' as const,
  noteId: '987654321',
  observedState: 'running' as const,
  observedAt: '2026-07-07T00:00:06.000Z'
}

describe('codehost note projection frames (gitlab-com-integration.md §17.2)', () => {
  it('round-trips the desired and result payloads', () => {
    expect(CodeHostNoteDesired.parse(desired)).toEqual(desired)
    expect(CodeHostNoteResult.parse(result)).toEqual(result)
  })

  it('registers both frames as org-scoped envelope members', () => {
    expect(isFrameType('codehost/note-desired')).toBe(true)
    expect(isFrameType('codehost/note-result')).toBe(true)
    expect(isFrameType('codehost/note-result/ok')).toBe(true)
    for (const type of ['codehost/note-desired', 'codehost/note-result', 'codehost/note-result/ok'] as const) {
      expect(INSTALL_WIDE_FRAME_TYPES.has(type)).toBe(false)
    }
    const envelope = AnyFrame.safeParse({
      v: 1,
      id: PROJECTION_ID,
      ts: '2026-07-07T00:00:05.000Z',
      type: 'codehost/note-desired',
      orgId: 'org_1',
      payload: desired
    })
    expect(envelope.success).toBe(true)
  })

  it('accepts every fixed §16 state and rejects an unlisted one', () => {
    for (const state of ['queued', 'running', 'completed', 'failed', 'skipped', 'superseded', 'interrupted']) {
      expect(CodeHostNoteDesired.safeParse({ ...desired, state }).success).toBe(true)
    }
    expect(CodeHostNoteDesired.safeParse({ ...desired, state: 'in_progress' }).success).toBe(false)
  })

  it('carries no body: an unknown key is dropped and the reason stays a bounded code', () => {
    const parsed = CodeHostNoteDesired.parse({ ...desired, summary: '# agent reply\n\nlooks good' })
    expect(parsed).not.toHaveProperty('summary')
    expect(CodeHostNoteDesired.safeParse({ ...desired, reason: 'agent_handover' }).success).toBe(true)
    expect(CodeHostNoteDesired.safeParse({ ...desired, reason: 'The agent said: looks good' }).success).toBe(false)
    expect(CodeHostNoteDesired.safeParse({ ...desired, reason: 'x'.repeat(101) }).success).toBe(false)
  })

  it('rejects identifiers that are not the rename-stable numeric form', () => {
    expect(CodeHostNoteDesired.safeParse({ ...desired, projectId: 'example-group/project' }).success).toBe(false)
    expect(CodeHostNoteDesired.safeParse({ ...desired, mergeRequestIid: 0 }).success).toBe(false)
    expect(CodeHostNoteResult.safeParse({ ...result, noteId: 'note-42' }).success).toBe(false)
  })

  it('requires a written result to name the note it wrote and the state it shows', () => {
    expect(CodeHostNoteResult.safeParse({ ...result, noteId: undefined }).success).toBe(false)
    expect(CodeHostNoteResult.safeParse({ ...result, observedState: undefined }).success).toBe(false)
    const ambiguous = { ...result, outcome: 'ambiguous' as const, noteId: undefined, observedState: undefined }
    expect(CodeHostNoteResult.safeParse(ambiguous).success).toBe(true)
  })

  it('requires the complete placement fence, never a partial tuple', () => {
    const { dispatchDaemonId: _omitted, ...partial } = desired.snapshot
    expect(CodeHostNoteDesired.safeParse({ ...desired, snapshot: partial }).success).toBe(false)
  })
})
