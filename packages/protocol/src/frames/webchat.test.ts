import { describe, it, expect } from 'vitest'
import { WebchatOutput, WebchatStatus } from '../index.js'

const CONV = '11111111-1111-4111-8111-111111111111'
const TURN = '22222222-2222-4222-8222-222222222222'

describe('WebchatOutput — event / status framing', () => {
  it('accepts a reply-chunk frame (event only)', () => {
    const r = WebchatOutput.safeParse({
      conversationId: CONV,
      turnId: TURN,
      index: 0,
      event: { kind: 'message', text: 'hi' }
    })
    expect(r.success).toBe(true)
  })

  it('accepts a plan snapshot, priority and all', () => {
    const r = WebchatOutput.safeParse({
      conversationId: CONV,
      turnId: TURN,
      index: 2,
      event: {
        kind: 'plan',
        entries: [
          { content: 'read the file', status: 'completed' },
          { content: 'fix the bug', status: 'in_progress', priority: 'high' }
        ]
      }
    })
    expect(r.success).toBe(true)
    if (r.success && r.data.event?.kind === 'plan') expect(r.data.event.entries).toHaveLength(2)
  })

  it('accepts a status-only frame (no event)', () => {
    const r = WebchatOutput.safeParse({
      conversationId: CONV,
      turnId: TURN,
      index: 1,
      status: { model: 'opus-4.8', contextUsed: 120_000, contextSize: 200_000, totalTokens: 45_200 }
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.status?.model).toBe('opus-4.8')
  })

  it('accepts a combined event + status frame', () => {
    const r = WebchatOutput.safeParse({
      conversationId: CONV,
      turnId: TURN,
      index: 2,
      event: { kind: 'message', text: 'done' },
      status: { costAmount: 0.18, costCurrency: 'USD' }
    })
    expect(r.success).toBe(true)
  })

  it('rejects an empty frame carrying neither event nor status', () => {
    const r = WebchatOutput.safeParse({ conversationId: CONV, turnId: TURN, index: 3 })
    expect(r.success).toBe(false)
  })

  it('WebchatStatus tolerates a fully partial snapshot and carries models + permission modes + sessionId', () => {
    expect(WebchatStatus.safeParse({}).success).toBe(true)
    expect(WebchatStatus.safeParse({ contextUsed: 10 }).success).toBe(true)
    const r = WebchatStatus.safeParse({
      model: 'a',
      models: ['a', 'b'],
      permissionMode: 'plan',
      permissionModes: ['default', 'plan'],
      sessionId: 'acp-1'
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.models).toEqual(['a', 'b'])
    if (r.success) expect(r.data.permissionModes).toEqual(['default', 'plan'])
  })
})
