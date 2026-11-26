import { describe, expect, it } from 'vitest'
import type { SessionMessageDto } from './api'
import type { SessionStep } from './data'
import {
  dropPersistedFailures,
  liveOverlay,
  mergeSessionMessages,
  reconcilePersistedLiveSteps,
  retireLiveOverlay
} from './session-transcript'

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
      {
        kind: 'done',
        turnId: 'warn-1',
        text: '⚠️ Your browser couldn’t connect to the chat server — check your network connection and try again.',
        observedAtMs: 1_785_000_000_100
      }
    ] satisfies SessionStep[]

    expect(reconcilePersistedLiveSteps(live, [], agentId)).toBe(live)
  })

  it('hides only the duplicate prompt closest to the persisted retry while its answer is pending', () => {
    const failedAt = 1_785_000_000_000
    const retriedAt = failedAt + 30_000
    const live = [
      prompt('ship it', failedAt),
      {
        kind: 'done',
        turnId: 'warn-1',
        text: '⚠️ Your browser couldn’t connect to the chat server — check your network connection and try again.',
        observedAtMs: failedAt + 100
      },
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
      {
        kind: 'done',
        turnId: 'warn-2',
        text: '⚠️ Your browser couldn’t connect to the chat server — check your network connection and try again.',
        observedAtMs: at + 100
      }
    ] satisfies SessionStep[]
    const peerRows = [
      { seq: 1, ts: String(at + 50), text: 'yes', sender: 'bot-b', kind: 'text' }
    ] satisfies SessionMessageDto[]

    expect(reconcilePersistedLiveSteps(live, peerRows, agentId, [])).toEqual(live)
  })

  it('retires silent work after the prompt is saved and all lanes finish', () => {
    const at = 1_785_000_000_000
    const live = [
      prompt('inspect', at),
      { kind: 'tool', turnId: `u:${at}`, text: 'Read file', observedAtMs: at + 100 }
    ] satisfies [SessionStep, SessionStep]
    const saved = persistedPrompt(1, 'inspect', at + 10)
    const waiting = reconcilePersistedLiveSteps(live, [saved], agentId)
    expect(waiting).toEqual([{ ...live[0], hidden: true }, live[1]])
    expect(reconcilePersistedLiveSteps([{ ...waiting[0]!, turnComplete: true }, waiting[1]!], [], agentId)).toEqual([])
    expect(reconcilePersistedLiveSteps([{ ...live[0], turnComplete: true }, live[1]], [saved], agentId)).toEqual([])
    const notice = { kind: 'notice', turnId: `u:${at}`, text: 'Approval unavailable', standing: true } as const
    expect(
      reconcilePersistedLiveSteps([{ ...live[0], turnComplete: true }, live[1], notice], [saved], agentId)
    ).toEqual([notice])
  })

  it('retires a prompt with files once its row lands with the daemon’s attached-file note', () => {
    const at = 1_785_000_000_000
    const live = [
      { ...prompt('read this', at), turnComplete: true },
      { kind: 'done', turnId: `u:${at}`, agentId, text: 'PELICAN', observedAtMs: at + 100 }
    ] satisfies [SessionStep, SessionStep]
    const rows = [
      persistedPrompt(1, 'read this\n[attached: secret.txt (text/plain)]', at + 10),
      { seq: 2, ts: String(at + 200), text: 'PELICAN', sender: agentId, kind: 'text' }
    ]
    expect(reconcilePersistedLiveSteps(live, rows, agentId)).toEqual([])
    const fileOnly: SessionStep[] = [{ ...live[0], text: '' }, live[1]]
    expect(
      reconcilePersistedLiveSteps(
        fileOnly,
        [persistedPrompt(1, '[attached: secret.txt (text/plain)]', at + 10), rows[1]!],
        agentId
      )
    ).toEqual([])
  })

  it('retires a turn whose prompt uploaded an image, whose row carries the preview the live step keeps in `images`', () => {
    const at = 1_785_000_000_000
    const preview = { name: 'shot.png', mimeType: 'image/webp' as const, data: 'UklGR' }
    const text = 'look at this\n[attached: shot.png (image/png)]'
    const turn = { turnId: `u:${at}`, agentId, thread: 'root-1' }
    const live: SessionStep[] = [
      { ...prompt(text, at), images: [preview], thread: 'root-1', turnComplete: true },
      { kind: 'tool', ...turn, text: 'check', toolCallId: 'call-1', toolStatus: 'completed', observedAtMs: at + 50 },
      { kind: 'done', ...turn, text: 'PELICAN', postId: 'post-1', observedAtMs: at + 100 }
    ]
    const rows: SessionMessageDto[] = [
      { ...persistedPrompt(1, text, at + 10), attachments: [preview] },
      { seq: 2, ts: String(at + 60), text: 'check', sender: agentId, kind: 'tool', toolCallId: 'call-1' },
      persistedReply(3, agentId, 'PELICAN', at + 200, 'post-1')
    ]
    const main = live.map(({ thread: _thread, ...step }) => step)
    expect(reconcilePersistedLiveSteps(main, rows, agentId)).toEqual([])
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

  it('retires an image-only reply only once the saved post with its postId is present', () => {
    const at = 1_785_000_000_000
    const image = {
      kind: 'done',
      turnId: 'reply',
      text: '[shared: out/a.png (image/png, 9 bytes, sha256:1a2b3c4d5e6f7a8b)]',
      postId: 'post-img',
      segmentId: 'post-img',
      observedAtMs: at + 100,
      sharedImage: {
        attachment: { name: 'a.png', mimeType: 'image/png', data: 'AAAA' },
        original: { kind: 'inline' },
        revision: 0
      }
    } satisfies SessionStep
    const live = [prompt('draw', at), image]
    const promptRow = persistedPrompt(1, 'draw', at + 10)
    // An unrelated agent row after the prompt must not stand in for the image's own post.
    const other = persistedReply(2, 'agent', 'unrelated', at + 200, 'post-other')
    expect(reconcilePersistedLiveSteps(live, [promptRow, other], agentId)).toEqual([
      { ...live[0], hidden: true },
      image
    ])
    expect(
      reconcilePersistedLiveSteps(
        live,
        [promptRow, persistedReply(3, 'agent', image.text, at + 300, 'post-img')],
        agentId
      )
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

describe('the live overlay of a page backed by rows (webchat-transcript-refresh.md)', () => {
  const agentId = 'agent'
  const at = 1_785_000_000_000
  const prompt: SessionStep = { kind: 'msg', who: '@you', turnId: 't', text: 'and the totals?', observedAtMs: at }
  const thinking: SessionStep = { kind: 'plan', agentId, turnId: 't', text: 'Checking.', observedAtMs: at + 5 }
  const call: SessionStep = {
    kind: 'tool',
    agentId,
    turnId: 't',
    text: 'query',
    toolCallId: 'call-t',
    observedAtMs: at + 6
  }
  const preview: SessionStep = {
    kind: 'done',
    agentId,
    turnId: 't',
    text: 'The total is',
    segmentId: 'seg-t',
    postId: 'seg-t',
    observedAtMs: at + 7
  }
  const row = (
    seq: number,
    sender: string,
    text: string,
    over: Partial<SessionMessageDto> = {}
  ): SessionMessageDto => ({
    seq,
    ts: String(at + seq),
    text,
    sender,
    kind: 'text',
    ...over
  })

  it('draws sends, the reply streaming now, cards and notices, and leaves work to the rows', () => {
    const card: SessionStep = { kind: 'elicit', agentId, turnId: 't', text: 'Allow?', observedAtMs: at + 8 }
    const steps = [prompt, thinking, call, { ...thinking, kind: 'planblock' as const }, preview, card]
    expect(liveOverlay(steps)).toEqual([prompt, preview, card])
    const drawn = [prompt, preview]
    expect(liveOverlay(drawn)).toBe(drawn)
  })

  it('retires a sent message by the post the relay named, wherever it was read', () => {
    const named = { ...prompt, postId: 'post-p', thread: 'root-1' }
    expect(retireLiveOverlay([named], [row(1, '@you', 'other words', { postId: 'post-p' })], agentId)).toEqual([])
    // Its row not read yet, it stays, even beside another post's row with the same words.
    expect(
      retireLiveOverlay([named], [row(1, '@you', 'and the totals?', { thread: 'root-1', postId: 'post-q' })], agentId, {
        thread: 'root-1'
      })
    ).toEqual([named])
  })

  // #4443: a mirrored continuation's row is saved under the platform's message id, so no row ever carries the copy's post id.
  it('retires a named message by its words when its row was saved without a post id', () => {
    const named = { ...prompt, postId: 'post-p' }
    const mirrored = (seq: number, text: string) => row(seq, 'user-1', text, { ts: `${(at + 3_000) / 1000}.000100` })
    const reply = row(9, agentId, 'The total is 3')
    expect(retireLiveOverlay([named], [mirrored(1, 'and the totals?'), reply], agentId)).toEqual([])
    const sends = [1, 2, 3].map((n) => ({ ...named, turnId: `t${n}`, postId: `post-${n}`, text: `send ${n}` }))
    expect(
      retireLiveOverlay(
        sends,
        [1, 2, 3].map((n) => mirrored(n, `send ${n}`)),
        agentId
      )
    ).toEqual([])
    // Other words, or a row saved long before the send, leave it.
    expect(retireLiveOverlay([named], [mirrored(1, 'other words')], agentId)).toEqual([named])
    const old = row(1, 'user-1', 'and the totals?', { ts: String(at - 6 * 60_000) })
    expect(retireLiveOverlay([named], [old], agentId)).toEqual([named])
  })

  it('keeps a webchat message to its post id: one row retires one copy, never a second with the same words', () => {
    const first = { ...prompt, postId: 'post-1' }
    const second = { ...prompt, turnId: 't2', postId: 'post-2' }
    const saved = row(1, '@you', 'and the totals?', { postId: 'post-1' })
    expect(retireLiveOverlay([first, second], [saved], agentId)).toEqual([second])
  })

  it('matches a message an older relay named no post for by its words, in the place it was read', () => {
    const rows = [row(3, '@you', 'and the totals?')]
    expect(retireLiveOverlay([prompt], rows, agentId)).toEqual([])
    expect(retireLiveOverlay([prompt], rows, agentId, { thread: 'root-1' })).toEqual([prompt])
  })

  it('retires the reply streaming now by its post once saved, and its unsaved text once a read follows its lane', () => {
    const ended = { ...preview, laneDoneAtMs: at + 100 }
    expect(retireLiveOverlay([preview], [row(9, agentId, 'The total is 3', { postId: 'seg-t' })], agentId)).toEqual([])
    // Text a handed or superseded turn never posted goes with the first read after its lane, not one started before.
    expect(retireLiveOverlay([ended], [], agentId, { readStartedAtMs: at + 99 })).toEqual([ended])
    expect(retireLiveOverlay([ended], [], agentId, { readStartedAtMs: at + 100 })).toEqual([])
    expect(retireLiveOverlay([preview], [], agentId, { readStartedAtMs: at + 500 })).toEqual([preview])
  })

  it('keeps a local warning and a standing notice, and drops a wait notice and work once their lane is read', () => {
    const warning: SessionStep = { kind: 'done', turnId: 'warn', text: '⚠️ Not sent', observedAtMs: at }
    const settled = { laneDoneAtMs: at + 10 }
    const wait: SessionStep = { kind: 'notice', agentId, turnId: 't', text: 'Starting…', ...settled }
    const standing: SessionStep = { ...wait, text: 'Answer in Slack', standing: true }
    const work = [
      { ...thinking, ...settled },
      { ...call, ...settled }
    ]
    expect(retireLiveOverlay([warning, wait, standing, ...work], [], agentId, { readStartedAtMs: at + 20 })).toEqual([
      warning,
      standing
    ])
  })

  it('leaves a thread’s streamed reply to that thread’s read', () => {
    const inThread = { ...preview, thread: 'root-1', laneDoneAtMs: at + 10 }
    expect(retireLiveOverlay([inThread], [], agentId, { readStartedAtMs: at + 20 })).toEqual([inThread])
    expect(retireLiveOverlay([inThread], [], agentId, { thread: 'root-1', readStartedAtMs: at + 20 })).toEqual([])
  })
})

describe('dropPersistedFailures', () => {
  const at = 1_800_000_000_000
  const TAG = '[ERR:out_of_credits] Out of AgentConnect credits'
  const row = (text: string, ts = at + 100, sender = 'agent-1'): SessionMessageDto => ({
    seq: 1,
    ts: String(ts),
    text,
    sender,
    kind: 'text'
  })
  const legacy: SessionStep = { kind: 'done', text: `⚠️ ${TAG}`, turnId: 't1', agentId: 'agent-1', observedAtMs: at }
  const ahp: SessionStep = {
    kind: 'notice',
    text: TAG,
    turnId: 't1',
    agentId: 'agent-1',
    standing: true,
    observedAtMs: at
  }

  it.each([
    ['a legacy failure', legacy],
    ['an AHP error notice', ahp]
  ])('drops %s once its agent saved the same failure', (_name, step) => {
    expect(dropPersistedFailures([step], [row(`⚠️ Agent failed to respond: ${TAG}`)], 'agent-1')).toEqual([])
  })

  it.each([
    ['no row says it yet', []],
    ['only an earlier failure says it', [row(`⚠️ Agent failed to respond: ${TAG}`, at - 60_000)]],
    ['another agent said it', [row(`⚠️ Agent failed to respond: ${TAG}`, at + 100, 'agent-2')]],
    ['the row says something else', [row('⚠️ Agent failed to respond: rate limited')]]
  ])('keeps a live failure while %s', (_name, rows) => {
    const live = [legacy, ahp]
    expect(dropPersistedFailures(live, rows as SessionMessageDto[], 'agent-1')).toBe(live)
  })

  it('leaves streamed text alone, even text that quotes a failure', () => {
    const reply: SessionStep = { kind: 'done', text: `⚠️ ${TAG}`, turnId: 't1', segmentId: 's1', agentId: 'agent-1' }
    expect(dropPersistedFailures([reply], [row(`⚠️ Agent failed to respond: ${TAG}`)], 'agent-1')).toEqual([reply])
  })
})
