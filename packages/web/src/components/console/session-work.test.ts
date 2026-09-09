import { describe, expect, it } from 'vitest'
import {
  foldCustomAnswers,
  PLAN_LANE,
  WORK_LANES,
  planEntries,
  planLabel,
  sessionTurnInFlight,
  stripBoldMarks,
  toggleWorkPanel,
  workCounts,
  workPanelOpen,
  workSummary
} from './session-work'

const step = (lane: string, files: string[] = []) => ({ lane, files: files.map((path) => ({ path })) })
const demotedStep = (lane: string) => ({ ...step(lane), demoted: true })

describe('workCounts', () => {
  it('counts edited FILES by path, not EDIT-step count (one EDIT row, two files → 2)', () => {
    expect(workCounts([step('THINK'), step('EDIT', ['a.ts', 'b.ts'])])).toEqual({
      thinkCount: 1,
      toolCount: 0,
      editCount: 2
    })
  })

  it('dedupes repeated paths and counts a metadata-less EDIT row as one file', () => {
    expect(workCounts([step('EDIT', ['a.ts']), step('EDIT', ['a.ts']), step('EDIT', [])])).toEqual({
      thinkCount: 0,
      toolCount: 0,
      editCount: 2 // {a.ts} + one bare edit
    })
  })

  it('counts TOOL as command steps and treats the remainder (THINK/PLAN) as reasoning', () => {
    expect(workCounts([step('THINK'), step('PLAN'), step('TOOL'), step('TOOL')])).toEqual({
      thinkCount: 2,
      toolCount: 2,
      editCount: 0
    })
  })

  it('leaves a superseded answer demoted into the work lane out of the reasoning count', () => {
    // The playground re-tags a superseded turn's streamed `done` blocks as PLAN — message text, not thoughts.
    expect(workCounts([step('THINK'), demotedStep('PLAN'), demotedStep('PLAN')])).toEqual({
      thinkCount: 1,
      toolCount: 0,
      editCount: 0
    })
    // A turn whose only work is the demoted answer reports no work at all.
    const only = workCounts([demotedStep('PLAN')])
    expect(workSummary(only.thinkCount, only.toolCount, only.editCount)).toBe('')
  })

  it('feeds the summary so one EDIT row with two files reads "edited 2 files"', () => {
    const { thinkCount, toolCount, editCount } = workCounts([step('THINK'), step('EDIT', ['a.ts', 'b.ts'])])
    expect(workSummary(thinkCount, toolCount, editCount)).toBe('Thought through 1 step, edited 2 files')
  })
})

describe('workSummary', () => {
  it('counts reasoning, tool commands, and file edits separately', () => {
    // The bug: edits were folded into the "thought through" step count.
    expect(workSummary(1, 0, 2)).toBe('Thought through 1 step, edited 2 files')
    expect(workSummary(1, 2, 3)).toBe('Thought through 1 step, ran 2 commands, edited 3 files')
  })

  it('capitalizes only the first clause and pluralizes each count', () => {
    expect(workSummary(0, 1, 0)).toBe('Ran 1 command')
    expect(workSummary(0, 0, 1)).toBe('Edited 1 file')
    expect(workSummary(2, 0, 0)).toBe('Thought through 2 steps')
  })

  it('is empty when there is no work', () => {
    expect(workSummary(0, 0, 0)).toBe('')
  })
})

describe('work panel visibility', () => {
  it('defaults to collapsed, including a turn with no answer text yet', () => {
    expect(workPanelOpen(undefined)).toBe(false)
  })

  it('opens on click and collapses again on the next one', () => {
    const base = new Map<string, boolean>()
    const shown = toggleWorkPanel(base, 'turn-a', workPanelOpen(base.get('turn-a')))
    expect(workPanelOpen(shown.get('turn-a'))).toBe(true)
    expect(workPanelOpen(toggleWorkPanel(shown, 'turn-a', workPanelOpen(shown.get('turn-a'))).get('turn-a'))).toBe(
      false
    )
  })

  it('toggles only the clicked turn', () => {
    const shown = toggleWorkPanel(new Map(), 'turn-a', false)
    expect(workPanelOpen(shown.get('turn-a'))).toBe(true)
    expect(workPanelOpen(shown.get('turn-b'))).toBe(false)
  })

  it('stays collapsed by default while the turn is streaming', () => {
    // Streaming no longer auto-opens the panel — the collapsed toggle line
    // carries the live progress instead.
    expect(workPanelOpen(undefined)).toBe(false)
  })

  it('detects an active turn from the raw platform state', () => {
    // RAW daemon state is 'prompting'/'cancelling' while a turn runs (toStatusKey
    // buckets these as 'paused' — matching on the bucketed key would be backwards).
    expect(sessionTurnInFlight(false, 'prompting')).toBe(true)
    expect(sessionTurnInFlight(false, 'cancelling')).toBe(true)
    expect(sessionTurnInFlight(false, 'idle')).toBe(false)
    expect(sessionTurnInFlight(false, 'completed')).toBe(false)
    // Live playground/webchat turns ride the provider's busy flag instead.
    expect(sessionTurnInFlight(true, 'idle')).toBe(true)
    // Rows with no state (mock/placeholder label) never count as active.
    expect(sessionTurnInFlight(false, undefined)).toBe(false)
    expect(sessionTurnInFlight(false, '—')).toBe(false)
  })

  it('an explicit open during streaming survives the turn completing', () => {
    const opened = toggleWorkPanel(new Map(), 'turn-a', workPanelOpen(undefined))
    expect(workPanelOpen(opened.get('turn-a'))).toBe(true)
  })
})

describe('stripBoldMarks', () => {
  it('drops paired bold markers and keeps everything else', () => {
    expect(stripBoldMarks('**Planning peer polling**\n\n**Testing retrieval**')).toBe(
      'Planning peer polling\n\nTesting retrieval'
    )
    expect(stripBoldMarks('keep `code` and _italics_ and __under__')).toBe('keep `code` and _italics_ and under')
  })

  it('never pairs markers across lines — a stray ** cannot swallow a paragraph', () => {
    expect(stripBoldMarks('a stray ** here\nand ** another line')).toBe('a stray ** here\nand ** another line')
  })
})

describe('planEntries', () => {
  it('reads the entries a plan row carries', () => {
    const body = JSON.stringify({
      entries: [
        { content: 'read the file', status: 'completed' },
        { content: 'fix the bug', status: 'in_progress', priority: 'high' }
      ]
    })
    expect(planEntries(body)).toEqual([
      { content: 'read the file', status: 'completed' },
      { content: 'fix the bug', status: 'in_progress', priority: 'high' }
    ])
  })

  // Each of these reaches the console as a row whose `Plan · n/m` text still stands —
  // the checklist is what is missing, not the fact that the agent planned.
  it('yields nothing for a body that is absent, malformed, or entry-less', () => {
    expect(planEntries(undefined)).toEqual([])
    expect(planEntries('')).toEqual([])
    expect(planEntries('{"entries":')).toEqual([])
    expect(planEntries('{}')).toEqual([])
  })

  it('drops an entry with no text of its own rather than rendering a blank line', () => {
    const body = JSON.stringify({
      entries: [{ status: 'pending' }, { content: '   ', status: 'pending' }, { content: 'real', status: 'pending' }]
    })
    expect(planEntries(body)).toEqual([{ content: 'real', status: 'pending' }])
  })
})

describe('planLabel', () => {
  // Computed from the entries on BOTH surfaces — a live block and the same block re-read
  // from history must never disagree about the count.
  it('counts the completed entries', () => {
    expect(
      planLabel([
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'pending' }
      ])
    ).toBe('Plan · 1/3')
  })

  it('reads n/n once every entry is done', () => {
    expect(planLabel([{ content: 'a', status: 'completed' }])).toBe('Plan · 1/1')
  })
})

describe('PLAN_LANE', () => {
  // The plan renders as its own block above the answer. Were it a work lane it would be
  // counted as a reasoning step and hidden behind the "Thought through…" toggle — which is
  // the state it was in when the console did not record plans at all.
  it('is not a work lane, and does not collide with the playground live PLAN lane', () => {
    expect(WORK_LANES.has(PLAN_LANE)).toBe(false)
    expect(PLAN_LANE).not.toBe('PLAN')
  })
})

describe('foldCustomAnswers', () => {
  // The shape a bridge that marks NOTHING sends: the pair named by convention alone, plus an
  // "Other" CHOICE on the enum whose only meaning is "type below".
  const q = (propName: string, kind: 'enum' | 'multi-enum', labels: string[]) => ({
    propName,
    label: propName,
    kind,
    options: labels.map((label) => ({ value: label, label }))
  })
  const box = (propName: string) => ({ propName, label: 'Other', kind: 'text' as const, options: [] })

  it('folds a box named for its question, and drops the choice that duplicates it', () => {
    const folded = foldCustomAnswers([q('question_0', 'enum', ['Installed', 'Other']), box('question_0_custom')])
    expect(folded.map((f) => f.customAnswerFor)).toEqual([undefined, 'question_0'])
    expect(folded[0]?.options.map((o) => o.label)).toEqual(['Installed'])
  })

  it('reads a doubled separator, a hyphen, and a multi-select the same way', () => {
    for (const name of ['need_type__other', 'need_type-custom', 'need_type_other']) {
      expect(foldCustomAnswers([q('need_type', 'enum', ['a']), box(name)])[1]?.customAnswerFor).toBe('need_type')
    }
    const multi = foldCustomAnswers([q('formats', 'multi-enum', ['brief', 'Other']), box('formats_custom')])
    expect(multi[1]?.customAnswerFor).toBe('formats')
    expect(multi[0]?.options.map((o) => o.label)).toEqual(['brief'])
  })

  it('leaves alone what it cannot claim', () => {
    // A name matching no question on the card is a question of its own, as it always was.
    expect(foldCustomAnswers([q('pick', 'enum', ['a']), box('note_custom')])[1]?.customAnswerFor).toBeUndefined()
    // A box named for a question that offers NO choices is not an alternative to anything.
    const typedOwner = [{ propName: 'name', label: 'Name', kind: 'text' as const, options: [] }, box('name_custom')]
    expect(foldCustomAnswers(typedOwner).every((f) => f.customAnswerFor === undefined)).toBe(true)
    // And a binding the daemon already made passes through untouched.
    const bound = [q('a', 'enum', ['x']), { ...box('a_custom'), customAnswerFor: 'a' }]
    expect(foldCustomAnswers(bound)[1]?.customAnswerFor).toBe('a')
  })

  it('never empties a question, and drops a default its options no longer offer', () => {
    // "Other" as the ONLY choice is a real answer: dropping it would leave nothing to pick.
    const only = foldCustomAnswers([q('q', 'enum', ['Other']), box('q_custom')])
    expect(only[0]?.options.map((o) => o.label)).toEqual(['Other'])
    const seeded = foldCustomAnswers([{ ...q('q', 'enum', ['keep', 'Other']), defaultValue: 'Other' }, box('q_custom')])
    expect(seeded[0]?.defaultValue).toBeUndefined()
  })
})
