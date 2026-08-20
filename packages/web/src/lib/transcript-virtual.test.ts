import { describe, expect, it } from 'vitest'
import { estimateTurnSize, shouldVirtualizeTranscript, VIRTUALIZE_THRESHOLD } from './transcript-virtual'

describe('shouldVirtualizeTranscript', () => {
  it('leaves short transcripts on the plain path and virtualizes long ones', () => {
    expect(shouldVirtualizeTranscript(VIRTUALIZE_THRESHOLD)).toBe(false)
    expect(shouldVirtualizeTranscript(VIRTUALIZE_THRESHOLD + 1)).toBe(true)
    expect(shouldVirtualizeTranscript(0)).toBe(false)
  })
})

describe('estimateTurnSize', () => {
  it('gives a positive height for both kinds and grows a bot turn with its steps', () => {
    const user = estimateTurnSize({ kind: 'user', text: 'hi' })
    const oneStep = estimateTurnSize({ kind: 'bot', steps: [{ text: 'ok' }] })
    const manySteps = estimateTurnSize({
      kind: 'bot',
      steps: [{ text: 'plan' }, { text: 'tool' }, { text: 'done' }]
    })
    expect(user).toBeGreaterThan(0)
    expect(oneStep).toBeGreaterThan(0)
    expect(manySteps).toBeGreaterThan(oneStep)
  })

  it('adds height for a long message and for an image', () => {
    const short = estimateTurnSize({ kind: 'user', text: 'x' })
    const long = estimateTurnSize({ kind: 'user', text: 'x'.repeat(500) })
    const withImage = estimateTurnSize({ kind: 'user', text: 'x', image: {} })
    expect(long).toBeGreaterThan(short)
    expect(withImage).toBeGreaterThan(short)
  })

  it('never returns a zero-height bot turn even with no steps', () => {
    expect(estimateTurnSize({ kind: 'bot', steps: [] })).toBeGreaterThan(0)
  })
})
