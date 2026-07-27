import { describe, expect, it } from 'vitest'
import type { SessionMessageDto } from './api'
import type { SessionStep } from './data'
import { mergeSessionMessages, reconcilePersistedLiveSteps } from './session-transcript'

function message(seq: number, ts: string, text: string): SessionMessageDto {
  return { seq, ts, text, sender: 'agent', kind: 'reasoning' }
}

describe('mergeSessionMessages', () => {
  it('upserts stable rows and restores chronological Slack order after a backfill', () => {
    const current = [message(1, '1784098843.000000', 'trigger'), message(2, '1784098844000', 'running')]
    const merged = mergeSessionMessages(
      current,
      [message(2, '1784098844000', 'complete'), message(3, '1784098711.000000', 'backfilled')],
      'slack'
    )

    expect(merged.map(({ seq, text }) => [seq, text])).toEqual([
      [3, 'backfilled'],
      [1, 'trigger'],
      [2, 'complete']
    ])
  })
})

describe('reconcilePersistedLiveSteps', () => {
  const agentId = 'agent'

  function prompt(text: string, observedAtMs: number): SessionStep {
    return { kind: 'msg', who: '@you', text, observedAtMs }
  }

  function persistedPrompt(seq: number, text: string, ts: number): SessionMessageDto {
    return { seq, ts: String(ts), text, sender: '@you', kind: 'text' }
  }

  it('preserves an unpersisted failed turn when a tail refresh is empty', () => {
    const live = [
      prompt('ship it', 1_785_000_000_000),
      { kind: 'done', text: '⚠️ Could not reach the agent.', observedAtMs: 1_785_000_000_100 }
    ] satisfies SessionStep[]

    expect(reconcilePersistedLiveSteps(live, [], agentId)).toBe(live)
  })

  it('removes only the duplicate prompt closest to the persisted retry', () => {
    const failedAt = 1_785_000_000_000
    const retriedAt = failedAt + 30_000
    const live = [
      prompt('ship it', failedAt),
      { kind: 'done', text: '⚠️ Could not reach the agent.', observedAtMs: failedAt + 100 },
      prompt('ship it', retriedAt),
      { kind: 'done', text: 'deployed', observedAtMs: retriedAt + 1_000 }
    ] satisfies SessionStep[]

    expect(reconcilePersistedLiveSteps(live, [persistedPrompt(1, 'ship it', retriedAt + 50)], agentId)).toEqual(
      live.slice(0, 2)
    )
  })
})
