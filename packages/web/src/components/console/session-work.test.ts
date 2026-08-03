import { describe, expect, it } from 'vitest'
import { sessionTurnInFlight, toggleWorkPanel, workCounts, workPanelOpen, workSummary } from './session-work'

const step = (lane: string, files: string[] = []) => ({ lane, files: files.map((path) => ({ path })) })

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
    const base = new Map<number, boolean>()
    const shown = toggleWorkPanel(base, 0, workPanelOpen(base.get(0)))
    expect(workPanelOpen(shown.get(0))).toBe(true)
    expect(workPanelOpen(toggleWorkPanel(shown, 0, workPanelOpen(shown.get(0))).get(0))).toBe(false)
  })

  it('toggles only the clicked turn', () => {
    const shown = toggleWorkPanel(new Map(), 3, false)
    expect(workPanelOpen(shown.get(3))).toBe(true)
    expect(workPanelOpen(shown.get(4))).toBe(false)
  })

  it('defaults OPEN while the turn is streaming, and collapses on its own when it ends', () => {
    expect(workPanelOpen(undefined, true)).toBe(true) // live: work visible as it runs
    expect(workPanelOpen(undefined, false)).toBe(false) // turn done: back to collapsed
  })

  it('follows the raw platform state through the active → idle transition', () => {
    // Active turn: RAW daemon state is 'prompting' (toStatusKey buckets this as
    // 'paused' — matching on the bucketed key would keep the panel closed here).
    expect(workPanelOpen(undefined, sessionTurnInFlight(false, 'prompting'))).toBe(true)
    expect(workPanelOpen(undefined, sessionTurnInFlight(false, 'cancelling'))).toBe(true)
    // Turn done: raw state flips to idle/completed (bucketed as 'online' — matching
    // on the bucket would OPEN the panel only after completion, exactly backwards).
    expect(workPanelOpen(undefined, sessionTurnInFlight(false, 'idle'))).toBe(false)
    expect(workPanelOpen(undefined, sessionTurnInFlight(false, 'completed'))).toBe(false)
    // Live playground/webchat turns ride the provider's busy flag instead.
    expect(sessionTurnInFlight(true, 'idle')).toBe(true)
    // Rows with no state (mock/placeholder label) never auto-open.
    expect(sessionTurnInFlight(false, undefined)).toBe(false)
    expect(sessionTurnInFlight(false, '—')).toBe(false)
  })

  it('a user toggle beats the streaming default in both directions', () => {
    // Streaming panel shows open; the first click must CLOSE it (record the
    // opposite of the effective state, not of the collapsed base default).
    const closed = toggleWorkPanel(new Map(), 0, workPanelOpen(undefined, true))
    expect(workPanelOpen(closed.get(0), true)).toBe(false)
    // …and the override keeps holding after the turn completes.
    expect(workPanelOpen(closed.get(0), false)).toBe(false)
    // An explicit open during streaming survives the turn's end, too.
    const reopened = toggleWorkPanel(closed, 0, false)
    expect(workPanelOpen(reopened.get(0), false)).toBe(true)
  })
})
