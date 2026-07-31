import { describe, expect, it } from 'vitest'
import { toggleWorkPanel, workCounts, workPanelOpen, workSummary } from './session-work'

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
  it('defaults to open only while a turn has no answer text', () => {
    expect(workPanelOpen(undefined, true)).toBe(true)
    expect(workPanelOpen(undefined, false)).toBe(false)
  })

  it('lets the user collapse a work-only turn, whose default is open', () => {
    const after = toggleWorkPanel(new Map(), 0, true)
    expect(workPanelOpen(after.get(0), true)).toBe(false)
  })

  it('keeps a hidden panel hidden when the answer text lands and flips the default', () => {
    // Work-only turn (autoOpen = true) that the user hides mid-stream...
    const after = toggleWorkPanel(new Map(), 0, true)
    // ...then its answer arrives, so the default becomes closed. The stored choice must
    // not read as "flipped from the default" here, or the panel would re-open itself.
    expect(workPanelOpen(after.get(0), false)).toBe(false)
  })

  it('re-expands on a second click, and only for the toggled turn', () => {
    const hidden = toggleWorkPanel(new Map(), 3, true)
    const shown = toggleWorkPanel(hidden, 3, true)
    expect(workPanelOpen(shown.get(3), true)).toBe(true)
    expect(workPanelOpen(shown.get(4), false)).toBe(false)
  })
})
