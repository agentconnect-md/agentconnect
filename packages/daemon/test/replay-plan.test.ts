import { describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '../src/store/local-store.js'
import { messageOrderingFor } from '../src/platforms/message-ordering.js'
import { MAX_REPLAY_ENTRIES, planReplay, renderReplayContext } from '../src/session/turn/replay-plan.js'
import { transcriptPromptText } from '../src/store/local-store.js'

const slack = messageOrderingFor('slack')
const CH = 'C1'
const THREAD = '1700000000.000100'

function entry(ts: string, sender: string, text = `msg ${ts}`): TranscriptEntry {
  return { channel: CH, thread: THREAD, ts, sender, kind: 'text', text }
}

// A Slack id for `seconds` past the thread root's epoch second.
function at(seconds: number, micros = 0): string {
  return `${1700000000 + seconds}.${String(micros).padStart(6, '0')}`
}

function plan(over: Partial<Parameters<typeof planReplay>[0]> = {}) {
  return planReplay({
    gap: [],
    agentId: 'bot',
    thread: THREAD,
    triggerTs: at(10),
    markerBefore: null,
    ordering: slack,
    firstPromptAfterOwnRootInitialization: false,
    ...over
  })
}

describe('planReplay — in-order activation', () => {
  it('replays the gap as context and excludes the trigger itself', () => {
    const p = plan({ gap: [entry(at(1), 'u1'), entry(at(2), 'u2'), entry(at(10), 'u3')], triggerTs: at(10) })
    expect(p.shape).toBe('inorder')
    expect(p.context.map((e) => e.ts)).toEqual([at(1), at(2)])
    expect(p.elided).toBe(0)
    expect(p.head).toBe('(thread context you may have missed)')
  })

  it('never replays the agent own rows back to it', () => {
    const p = plan({ gap: [entry(at(1), 'bot'), entry(at(2), 'u1'), entry(at(10), 'u1')] })
    expect(p.context.map((e) => e.sender)).toEqual(['u1'])
  })

  it('never replays a recorded control, and keeps the `!queue` row it strips', () => {
    // Step 1 records commands (message-intake.md §5), so the replay is where they must not
    // reappear: `!stop` acted on the session rather than being said to it.
    const p = plan({
      gap: [entry(at(1), 'u1', '!stop'), entry(at(2), 'u1', '/status'), entry(at(3), 'u1', '!queue do it')]
    })
    expect(p.context.map((e) => e.text)).toEqual(['!queue do it'])
    expect(renderReplayContext(p.context)).toBe('[u1] do it')
  })

  it('sorts a natively ordered gap before deciding, keeping legacy ids first', () => {
    const p = plan({ gap: [entry(at(2), 'u1'), entry('legacy-uuid', 'u1'), entry(at(1), 'u1')] })
    expect(p.context.map((e) => e.ts)).toEqual(['legacy-uuid', at(1), at(2)])
  })
})

describe('planReplay — bounded replay cap', () => {
  it('keeps the newest MAX_REPLAY_ENTRIES and reports the elided count', () => {
    const gap = Array.from({ length: MAX_REPLAY_ENTRIES + 3 }, (_, i) => entry(at(1, i + 1), 'u1'))
    const p = plan({ gap, triggerTs: at(99) })
    expect(p.context).toHaveLength(MAX_REPLAY_ENTRIES)
    expect(p.context[0]!.ts).toBe(at(1, 4))
    expect(p.elided).toBe(3)
    expect(p.head).toBe('(thread context you may have missed — 3 earlier message(s) elided)')
  })

  it('caps the batch shape too, with the unread heading', () => {
    const gap = Array.from({ length: MAX_REPLAY_ENTRIES + 1 }, (_, i) => entry(at(20, i + 1), 'u1'))
    const p = plan({ gap, triggerTs: at(10) })
    expect(p.shape).toBe('batch')
    expect(p.elided).toBe(1)
    expect(p.head).toBe('(unread thread messages, oldest to newest — 1 earlier message(s) elided)')
  })

  it('honours a cap override', () => {
    const gap = [entry(at(1), 'u1'), entry(at(2), 'u1'), entry(at(3), 'u1')]
    const p = plan({ gap, maxReplayEntries: 2 })
    expect(p.context.map((e) => e.ts)).toEqual([at(2), at(3)])
    expect(p.elided).toBe(1)
  })
})

describe('planReplay — deliveredThrough', () => {
  it('advances to the newest ordered row, including the agent own rows', () => {
    const p = plan({ gap: [entry(at(1), 'u1'), entry(at(5), 'bot')], triggerTs: at(3) })
    expect(p.deliveredThrough).toBe(at(5))
  })

  it('falls back to the previous marker when the gap holds no ordered row', () => {
    const p = plan({ gap: [], triggerTs: at(3), markerBefore: at(2) })
    expect(p.deliveredThrough).toBe(at(2))
  })

  it('advances only through the participant gap when the trigger is synthetic', () => {
    const p = plan({
      gap: [entry(at(1), 'u1'), entry(at(5), 'bot')],
      triggerTs: 'cron-uuid',
      markerBefore: at(0)
    })
    expect(p.deliveredThrough).toBe(at(1))
  })

  it('advances to the trigger itself when the platform ids are opaque', () => {
    const p = plan({ gap: [entry('b', 'u1')], ordering: undefined, triggerTs: 'z' })
    expect(p.shape).toBe('inorder')
    expect(p.deliveredThrough).toBe('z')
  })
})

describe('planReplay — own-root initialization', () => {
  it('replays the initializing root once alongside the first real reply', () => {
    const p = plan({
      gap: [entry(THREAD, 'bot', 'root post'), entry(at(10), 'u1')],
      triggerTs: at(10),
      firstPromptAfterOwnRootInitialization: true
    })
    expect(p.context.map((e) => e.text)).toEqual(['root post'])
    expect(p.deliveredThrough).toBe(at(10))
  })

  it('keeps the root outside the bounded suffix so a busy thread cannot evict it', () => {
    const gap = [entry(THREAD, 'bot', 'root post'), ...Array.from({ length: 4 }, (_, i) => entry(at(1, i + 1), 'u1'))]
    const p = plan({ gap, triggerTs: at(99), firstPromptAfterOwnRootInitialization: true, maxReplayEntries: 2 })
    expect(p.context.map((e) => e.ts)).toEqual([THREAD, at(1, 3), at(1, 4)])
    expect(p.elided).toBe(2)
  })

  it('leaves own rows filtered when the session did not initialize from its own root', () => {
    const p = plan({ gap: [entry(THREAD, 'bot', 'root post'), entry(at(10), 'u1')], triggerTs: at(10) })
    expect(p.context).toEqual([])
  })
})

describe('planReplay — batch and skip', () => {
  it('batches when the snapshot holds a message newer than a stale trigger', () => {
    const p = plan({ gap: [entry(at(10), 'u1', 'old'), entry(at(20), 'u2', 'new')], triggerTs: at(10) })
    expect(p.shape).toBe('batch')
    expect(p.context.map((e) => e.text)).toEqual(['old', 'new'])
    expect(p.head).toBe('(unread thread messages, oldest to newest)')
  })

  it('batches when the trigger was already delivered', () => {
    const p = plan({ gap: [entry(at(5), 'u1')], triggerTs: at(3), markerBefore: at(4) })
    expect(p.shape).toBe('batch')
  })

  it('skips when an already-delivered trigger leaves nothing to replay', () => {
    const p = plan({ gap: [entry(at(5), 'bot')], triggerTs: at(3), markerBefore: at(4) })
    expect(p.shape).toBe('skip')
    expect(p.context).toEqual([])
    expect(p.deliveredThrough).toBe(at(5))
    expect(
      plan({ gap: [entry(at(5), 'bot')], triggerTs: at(3), markerBefore: at(4), retryAdmittedTurn: true }).shape
    ).toBe('inorder')
    const retried = plan({
      gap: [entry(at(5), 'person'), entry(at(6), 'bot')],
      triggerTs: at(3),
      markerBefore: at(4),
      retryAdmittedTurn: true
    })
    expect(retried.shape).toBe('inorder')
    expect(retried.context.map((e) => e.ts)).toEqual([at(5)])
  })

  it('never skips a plain in-order activation with an empty gap', () => {
    const p = plan({ gap: [], triggerTs: at(3) })
    expect(p.shape).toBe('inorder')
    expect(p.context).toEqual([])
  })
})

describe('planReplay — runtime session recreated without its history', () => {
  const LOST_HEAD =
    '(your runtime session restarted and could not restore its history — the conversation so far, oldest to newest, with your own replies as [you])'

  it('replays the agent own rows in order, without controls, under the restart heading', () => {
    const gap = [
      entry(at(3), 'bot', 'Zephrix'),
      entry(at(1), 'u1', 'invent a word'),
      entry(at(4), 'u1', '!stop'),
      entry(at(10), 'u1', 'which word?')
    ]
    const p = plan({ gap, historyLost: true })
    expect(p.shape).toBe('inorder')
    expect(p.context.map((e) => e.text)).toEqual(['invent a word', 'Zephrix'])
    expect(p.head).toBe(LOST_HEAD)
    expect(renderReplayContext(p.context, undefined, 'bot')).toBe('[u1] invent a word\n[you] Zephrix')
  })

  it('keeps the agent own rows filtered when the session was not recreated', () => {
    const gap = [entry(at(1), 'u1', 'invent a word'), entry(at(3), 'bot', 'Zephrix'), entry(at(10), 'u1')]
    const p = plan({ gap, historyLost: false })
    expect(p.context.map((e) => e.text)).toEqual(['invent a word'])
    expect(p.head).toBe('(thread context you may have missed)')
  })

  it('bounds own and participant rows by one cap', () => {
    const gap = Array.from({ length: 5 }, (_, i) => entry(at(1, i + 1), i % 2 ? 'bot' : 'u1'))
    const p = plan({ gap, triggerTs: at(99), historyLost: true, maxReplayEntries: 3 })
    expect(p.context.map((e) => e.ts)).toEqual([at(1, 3), at(1, 4), at(1, 5)])
    expect(p.elided).toBe(2)
    expect(p.head).toBe(`${LOST_HEAD.slice(0, -1)}; 2 earlier message(s) elided)`)
  })

  it('interleaves own rows into a batch without letting them decide the shape or cursor', () => {
    const gap = [entry(at(10), 'u1', 'old'), entry(at(15), 'bot', 'mine'), entry(at(20), 'u2', 'new')]
    const p = plan({ gap, triggerTs: at(10), historyLost: true })
    expect(p.shape).toBe('batch')
    expect(p.context.map((e) => e.text)).toEqual(['old', 'mine', 'new'])
    expect(p.head).toBe(LOST_HEAD)
    // A newer own row alone is not a newer message: the shape stays in-order.
    const own = plan({ gap: [entry(at(10), 'u1'), entry(at(15), 'bot', 'mine')], triggerTs: at(10), historyLost: true })
    expect(own.shape).toBe('inorder')
    expect(own.context.map((e) => e.text)).toEqual(['mine'])
    // Only own rows left unread after a delivered trigger still skip.
    const skip = plan({ gap: [entry(at(5), 'bot')], triggerTs: at(3), markerBefore: at(4), historyLost: true })
    expect(skip.shape).toBe('skip')
  })

  it('keeps the initialized root ahead of the suffix alongside the other own rows', () => {
    const gap = [entry(THREAD, 'bot', 'root post'), entry(at(1), 'u1', 'q'), entry(at(2), 'bot', 'a')]
    const p = plan({
      gap,
      triggerTs: at(10),
      firstPromptAfterOwnRootInitialization: true,
      historyLost: true,
      maxReplayEntries: 1
    })
    expect(p.context.map((e) => e.text)).toEqual(['root post', 'a'])
    expect(p.elided).toBe(1)
  })
})

describe('planReplay — snapshot cutoff exclusion', () => {
  it('is confined to the rows the caller admitted through its cutoff', () => {
    const cutoff = at(15)
    const all = [entry(at(10), 'u1', 'inside'), entry(at(20), 'u1', 'after cutoff')]
    const p = plan({ gap: all.filter((e) => slack!.withinCutoff(e.ts, cutoff)), triggerTs: at(10) })
    expect(p.shape).toBe('inorder')
    expect(p.context).toEqual([])
    expect(p.deliveredThrough).toBe(at(10))
  })

  it('the same gap without the cutoff filter batches the newer row instead', () => {
    const p = plan({ gap: [entry(at(10), 'u1', 'inside'), entry(at(20), 'u1', 'after cutoff')], triggerTs: at(10) })
    expect(p.shape).toBe('batch')
    expect(p.context.map((e) => e.text)).toEqual(['inside', 'after cutoff'])
  })
})

describe('renderReplayContext', () => {
  it('renders one [sender] text line per entry', () => {
    expect(renderReplayContext([entry(at(1), 'u1', 'hi'), entry(at(2), 'u2', 'yo')])).toBe('[u1] hi\n[u2] yo')
  })

  it('puts an entry quote line ahead of the entry', () => {
    const rendered = renderReplayContext([entry(at(1), 'u1', 'hi')], (e) => `> quoting ${e.ts}`)
    expect(rendered).toBe(`> quoting ${at(1)}\n[u1] hi`)
  })
})

describe('transcriptPromptText', () => {
  it('reads the persisted prompt behind a text row, and the row text everywhere else', () => {
    const body = JSON.stringify({ prompt: 'PROMPT', linear: { issue: { identifier: 'ENG-1' } } })
    expect(transcriptPromptText({ ...entry(at(1), 'u1', 'DISPLAY'), body })).toBe('PROMPT')
    expect(transcriptPromptText(entry(at(1), 'u1', 'DISPLAY'))).toBe('DISPLAY')
    expect(transcriptPromptText({ ...entry(at(1), 'u1', 'DISPLAY'), body: JSON.stringify({ linear: {} }) })).toBe(
      'DISPLAY'
    )
    // A tool row's body is a ToolBody, never a prompt.
    expect(transcriptPromptText({ ...entry(at(1), 'u1', 'ran ls'), kind: 'tool', body })).toBe('ran ls')
  })

  it('fails closed on a body that is not JSON or whose prompt is not a string', () => {
    expect(transcriptPromptText({ ...entry(at(1), 'u1', 'DISPLAY'), body: '{not json' })).toBe('DISPLAY')
    expect(transcriptPromptText({ ...entry(at(1), 'u1', 'DISPLAY'), body: JSON.stringify({ prompt: 7 }) })).toBe(
      'DISPLAY'
    )
    expect(transcriptPromptText({ ...entry(at(1), 'u1', 'DISPLAY'), body: 'null' })).toBe('DISPLAY')
  })

  it('renders replayed context from the prompt the model read, not the text the console shows', () => {
    const rows = [
      { ...entry(at(1), 'u1', 'Delegated ENG-1'), body: JSON.stringify({ prompt: 'Linear ENG-1 — full prompt' }) },
      entry(at(2), 'u2', 'plain')
    ]
    expect(renderReplayContext(rows)).toBe('[u1] Linear ENG-1 — full prompt\n[u2] plain')
  })
})
