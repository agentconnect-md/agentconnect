import { describe, expect, it } from 'vitest'
import type { SessionMessageDto } from './api'
import type { SessionStep } from './data'
import { mergeSessionMessages, reconcilePersistedLiveSteps } from './session-transcript'

function message(seq: number, ts: string, text: string): SessionMessageDto {
  return { seq, ts, text, sender: 'agent', kind: 'reasoning' }
}

describe('mergeSessionMessages', () => {
  it('upserts stable rows and restores chronological order after a backfill', () => {
    const current = [message(1, '1784098843.000000', 'trigger'), message(2, '1784098844000', 'running')]
    const merged = mergeSessionMessages(
      current,
      [message(2, '1784098844000', 'complete'), message(3, '1784098711.000000', 'backfilled')],
      'event-time'
    )

    expect(merged.map(({ seq, text }) => [seq, text])).toEqual([
      [3, 'backfilled'],
      [1, 'trigger'],
      [2, 'complete']
    ])
  })

  it('trusts the daemon sequence under the conservative ordering', () => {
    // The arm every platform but Slack takes (§10 `transcriptOrdering`), and
    // the one an unrecognized platform id resolves to. Same upsert, no re-sort.
    const merged = mergeSessionMessages(
      [message(1, '1784098843.000000', 'trigger')],
      [message(3, '1784098711.000000', 'backfilled'), message(2, '1784098844000', 'running')],
      'seq'
    )

    expect(merged.map(({ seq }) => seq)).toEqual([1, 2, 3])
  })
})

describe('reconcilePersistedLiveSteps', () => {
  const agentId = 'agent'

  function prompt(text: string, observedAtMs: number): SessionStep {
    return { kind: 'msg', who: '@you', turnId: `u:${observedAtMs}`, text, observedAtMs }
  }

  function persistedPrompt(seq: number, text: string, ts: number): SessionMessageDto {
    return { seq, ts: String(ts), text, sender: '@you', kind: 'text' }
  }

  it('preserves an unpersisted failed turn when a tail refresh is empty', () => {
    const live = [
      prompt('ship it', 1_785_000_000_000),
      { kind: 'done', turnId: 'warn-1', text: '⚠️ Could not reach the agent.', observedAtMs: 1_785_000_000_100 }
    ] satisfies SessionStep[]

    expect(reconcilePersistedLiveSteps(live, [], agentId)).toBe(live)
  })

  it('hides only the duplicate prompt closest to the persisted retry while its answer is pending', () => {
    const failedAt = 1_785_000_000_000
    const retriedAt = failedAt + 30_000
    const live = [
      prompt('ship it', failedAt),
      { kind: 'done', turnId: 'warn-1', text: '⚠️ Could not reach the agent.', observedAtMs: failedAt + 100 },
      prompt('ship it', retriedAt),
      { kind: 'done', turnId: 'ok-1', text: 'deployed', observedAtMs: retriedAt + 1_000 }
    ] satisfies SessionStep[]

    expect(reconcilePersistedLiveSteps(live, [persistedPrompt(1, 'ship it', retriedAt + 50)], agentId)).toEqual([
      ...live.slice(0, 2),
      { ...live[2], hidden: true },
      live[3]
    ])
  })

  it('does not confirm a failed prompt from a matching peer-agent row', () => {
    const at = 1_785_000_000_000
    const live = [
      prompt('yes', at),
      { kind: 'done', turnId: 'warn-2', text: '⚠️ Could not reach the agent.', observedAtMs: at + 100 }
    ] satisfies SessionStep[]
    const peerRows = [
      { seq: 1, ts: String(at + 50), text: 'yes', sender: 'bot-b', kind: 'text' }
    ] satisfies SessionMessageDto[]

    expect(reconcilePersistedLiveSteps(live, peerRows, agentId, [])).toEqual(live)
  })

  function persistedReply(seq: number, sender: string, text: string, ts: number, postId: string): SessionMessageDto {
    return { seq, ts: String(ts), text, sender, kind: 'text', postId }
  }

  it('keeps streamed reply blocks until every canonical post is available', () => {
    const at = 1_785_000_000_000
    const live = [
      prompt('build', at),
      { kind: 'done', turnId: 'reply', text: 'First', postId: 'post-1', observedAtMs: at + 100 },
      { kind: 'plan', turnId: 'reply', text: 'working', observedAtMs: at + 200 },
      { kind: 'done', turnId: 'reply', text: 'Second', postId: 'post-2', observedAtMs: at + 300 }
    ] satisfies SessionStep[]
    const promptRow = persistedPrompt(1, 'build', at + 10)
    const partial = [promptRow, persistedReply(2, 'agent', 'First', at + 400, 'post-1')]

    const waiting = reconcilePersistedLiveSteps(live, [promptRow], agentId)
    expect(waiting).toEqual([{ ...live[0], hidden: true }, ...live.slice(1)])
    const afterFirst = reconcilePersistedLiveSteps(live, partial, agentId)
    expect(afterFirst).toEqual([{ ...live[0], hidden: true }, { ...live[1], hidden: true }, ...live.slice(2)])
    expect(reconcilePersistedLiveSteps(waiting, partial.slice(1), agentId)).toEqual(afterFirst)
    expect(
      reconcilePersistedLiveSteps(
        afterFirst,
        [...partial, persistedReply(3, 'agent', 'Second', at + 500, 'post-2')],
        agentId
      )
    ).toEqual([])
    expect(
      reconcilePersistedLiveSteps(afterFirst, [persistedReply(3, 'agent', 'Second', at + 500, 'post-2')], agentId)
    ).toEqual([])
  })

  // #753: an agent-initiated post has no optimistic `msg` prompt to anchor a turn —
  // it renders as a standalone step, identified only by its canonical postId.
  it('drops a standalone agent-post step once ITS postId lands in a persisted row (adopted-conversation refresh)', () => {
    const live = [
      {
        kind: 'done',
        turnId: 'post-1',
        text: 'Sent "hello" to bot-b',
        agentId: 'bot-a',
        postId: 'post-1',
        observedAtMs: 1
      }
    ] satisfies SessionStep[]

    expect(
      reconcilePersistedLiveSteps(live, [persistedReply(1, 'bot-a', 'Sent "hello" to bot-b', 1, 'post-1')], agentId)
    ).toEqual([])
  })

  it('keeps a standalone agent-post step whose postId has not been persisted yet', () => {
    const live = [
      {
        kind: 'done',
        turnId: 'post-1',
        text: 'Sent "hello" to bot-b',
        agentId: 'bot-a',
        postId: 'post-1',
        observedAtMs: 1
      }
    ] satisfies SessionStep[]

    expect(
      reconcilePersistedLiveSteps(live, [persistedReply(1, 'bot-a', 'unrelated', 1, 'post-other')], agentId)
    ).toEqual(live)
  })

  // The reconciling view's OWN agent is "agent" here, but the confirming row belongs to
  // a PEER participant's session (a merged multi-agent conversation, #753) — postId
  // matching must not be gated by sender the way the prompt heuristic is.
  it('drops a peer participant’s post confirmed by a row from that peer’s OWN session', () => {
    const live = [
      { kind: 'done', turnId: 'post-2', text: 'hi from bot-b', agentId: 'bot-b', postId: 'post-2', observedAtMs: 1 }
    ] satisfies SessionStep[]

    expect(
      reconcilePersistedLiveSteps(live, [persistedReply(1, 'bot-b', 'hi from bot-b', 1, 'post-2')], agentId)
    ).toEqual([])
  })

  it('reconciles a standalone post step and a prompt-anchored turn independently in the same refresh', () => {
    const at = 1_785_000_000_000
    const live = [
      { kind: 'done', turnId: 'post-3', text: 'stale post', agentId: 'bot-a', postId: 'post-3', observedAtMs: at },
      prompt('ship it', at + 1_000),
      { kind: 'done', turnId: 'ok-2', text: 'deployed', observedAtMs: at + 2_000 }
    ] satisfies SessionStep[]

    const persisted = [
      persistedReply(1, 'bot-a', 'stale post', at, 'post-3'),
      persistedPrompt(2, 'ship it', at + 1_050)
    ]
    expect(reconcilePersistedLiveSteps(live, persisted, agentId)).toEqual([{ ...live[1], hidden: true }, live[2]])
  })
})
