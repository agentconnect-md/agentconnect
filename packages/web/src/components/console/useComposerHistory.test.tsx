// @vitest-environment happy-dom
import { act, useState, type KeyboardEvent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { composerHistoryFromRows, useComposerHistory, type ComposerHistoryEntry } from './useComposerHistory'

const entry = (key: string, text = key): ComposerHistoryEntry => ({ key, text })
const HISTORY = [entry('first'), entry('second'), entry('third')]

let root: Root | null = null
let container: HTMLDivElement | null = null

beforeAll(() => Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true))

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
})

interface Paging {
  hasEarlier: boolean
  loadEarlier: () => Promise<void>
  loadedRows: number
}

function mountHarness(history: readonly ComposerHistoryEntry[] = HISTORY, paging?: Paging) {
  let api!: ReturnType<typeof useComposerHistory>
  let setDraft!: (v: string) => void
  let getValue!: () => string
  let setProps!: (next: { history?: readonly ComposerHistoryEntry[]; paging?: Paging }) => void

  function Harness() {
    const [value, setValue] = useState('')
    const [props, set] = useState({ history, paging })
    api = useComposerHistory({ history: props.history, value, setValue, ...props.paging })
    setDraft = setValue
    getValue = () => value
    setProps = (next) => set((prev) => ({ ...prev, ...next }))
    return <textarea value={value} readOnly />
  }

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<Harness />))
  return {
    label: () => api.label,
    value: () => getValue(),
    /** Types like the composer's onChange: the draft moves without going through the hook. */
    type: (text: string) => act(() => setDraft(text)),
    /** A transcript page landing: the pool and row count move together, as the view derives them. */
    update: (next: { history?: readonly ComposerHistoryEntry[]; paging?: Paging }) => act(() => setProps(next)),
    press: (key: string, composing = false) => {
      let consumed = false
      let prevented = false
      const event = {
        key,
        nativeEvent: { isComposing: composing },
        preventDefault: () => {
          prevented = true
        }
      } as unknown as KeyboardEvent<HTMLTextAreaElement>
      act(() => {
        consumed = api.handleKeyDown(event)
      })
      return { consumed, prevented }
    }
  }
}

/** Flush the microtasks a settled `loadEarlier` schedules. */
const settle = () => act(async () => {})

describe('useComposerHistory', () => {
  it('stays inert while the draft has text or the history is empty', () => {
    const h = mountHarness()
    h.type('typing')
    expect(h.press('ArrowUp')).toEqual({ consumed: false, prevented: false })
    expect(h.label()).toBeNull()

    const empty = mountHarness([])
    expect(empty.press('ArrowUp').consumed).toBe(false)
    expect(empty.label()).toBeNull()
  })

  it('enters on the newest entry from an empty draft and walks with Up/Down', () => {
    const h = mountHarness()
    expect(h.press('ArrowUp')).toEqual({ consumed: true, prevented: true })
    expect(h.value()).toBe('third')
    expect(h.label()).toBe('History 3/3')

    h.press('ArrowUp')
    expect(h.value()).toBe('second')
    expect(h.label()).toBe('History 2/3')
    h.press('ArrowUp')
    h.press('ArrowUp') // clamps at the oldest when nothing earlier is loadable
    expect(h.value()).toBe('first')
    expect(h.label()).toBe('History 1/3')

    h.press('ArrowDown')
    expect(h.value()).toBe('second')
    expect(h.label()).toBe('History 2/3')
  })

  it('ArrowDown also enters on the newest entry', () => {
    const h = mountHarness()
    h.press('ArrowDown')
    expect(h.value()).toBe('third')
    expect(h.label()).toBe('History 3/3')
  })

  it('ArrowDown past the newest entry returns to an empty prompt', () => {
    const h = mountHarness()
    h.press('ArrowUp')
    expect(h.press('ArrowDown').consumed).toBe(true)
    expect(h.value()).toBe('')
    expect(h.label()).toBeNull()
    // Back on a plain empty draft, so Up recalls from the newest again.
    h.press('ArrowUp')
    expect(h.value()).toBe('third')
  })

  it('editing the recalled text leaves history mode but keeps the text', () => {
    const h = mountHarness()
    h.press('ArrowUp')
    h.type('third edited')
    expect(h.label()).toBeNull()
    expect(h.value()).toBe('third edited')
    // Not empty any more, so Up no longer recalls.
    expect(h.press('ArrowUp').consumed).toBe(false)
    expect(h.value()).toBe('third edited')
  })

  it('Escape leaves history mode and clears the draft', () => {
    const h = mountHarness()
    h.press('ArrowUp')
    h.press('ArrowUp')
    expect(h.press('Escape')).toEqual({ consumed: true, prevented: true })
    expect(h.value()).toBe('')
    expect(h.label()).toBeNull()
  })

  it('Escape outside history mode is not consumed', () => {
    const h = mountHarness()
    expect(h.press('Escape').consumed).toBe(false)
    h.type('draft')
    expect(h.press('Escape').consumed).toBe(false)
    expect(h.value()).toBe('draft')
  })

  it('leaves history mode when the draft is cleared from outside, as a send does', () => {
    const h = mountHarness()
    h.press('ArrowUp')
    h.type('')
    expect(h.label()).toBeNull()
    h.press('ArrowUp')
    expect(h.value()).toBe('third')
  })

  it('lets an IME composition keep its arrow keys', () => {
    const h = mountHarness()
    expect(h.press('ArrowUp', true).consumed).toBe(false)
    expect(h.label()).toBeNull()
  })

  it('keeps its place when an earlier page prepends entries', () => {
    const h = mountHarness()
    h.press('ArrowUp')
    h.press('ArrowUp')
    expect(h.label()).toBe('History 2/3')
    h.update({ history: [entry('older-a'), entry('older-b'), ...HISTORY] })
    expect(h.value()).toBe('second')
    expect(h.label()).toBe('History 4/5')
    h.press('ArrowUp')
    expect(h.value()).toBe('first')
  })

  describe('paging earlier history', () => {
    it('marks the count open-ended while earlier pages are unloaded', () => {
      const h = mountHarness(HISTORY, { hasEarlier: true, loadEarlier: vi.fn(async () => {}), loadedRows: 10 })
      h.press('ArrowUp')
      expect(h.label()).toBe('History 3/3+')
    })

    it('Up at the oldest loaded entry pages earlier rows in and lands on the newest arrival', async () => {
      let release!: () => void
      const loadEarlier = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          })
      )
      const h = mountHarness([entry('third')], { hasEarlier: true, loadEarlier, loadedRows: 10 })
      h.press('ArrowUp')
      expect(h.label()).toBe('History 1/1+')
      expect(h.press('ArrowUp').consumed).toBe(true)
      expect(loadEarlier).toHaveBeenCalledTimes(1)
      expect(h.label()).toBe('History 1/1+ · loading earlier…')
      expect(h.value()).toBe('third') // the recalled text holds while the page loads

      // The page lands: two of the viewer's prompts among the new rows, one page still earlier.
      h.update({
        history: [entry('first'), entry('second'), entry('third')],
        paging: { hasEarlier: true, loadEarlier, loadedRows: 30 }
      })
      release()
      await settle()
      expect(h.value()).toBe('second')
      expect(h.label()).toBe('History 2/3+')
      expect(loadEarlier).toHaveBeenCalledTimes(1)
    })

    it('keeps paging through pages with none of the viewer’s prompts, and stops at the start', async () => {
      // Each read resolves only after its rows landed, as the transcript machine's does.
      const pages: Array<() => void> = []
      const loadEarlier = vi.fn(() => new Promise<void>((resolve) => pages.push(resolve)))
      const h = mountHarness([entry('only')], { hasEarlier: true, loadEarlier, loadedRows: 10 })
      h.press('ArrowUp')
      h.press('ArrowUp')
      expect(loadEarlier).toHaveBeenCalledTimes(1)
      // A page of agent-only rows: more rows, no new prompts, still more history.
      h.update({ paging: { hasEarlier: true, loadEarlier, loadedRows: 40 } })
      pages[0]!()
      await settle()
      expect(loadEarlier).toHaveBeenCalledTimes(2)
      expect(h.label()).toBe('History 1/1+ · loading earlier…')
      // The last page: still nothing of the viewer's, and the transcript starts here.
      h.update({ paging: { hasEarlier: false, loadEarlier, loadedRows: 55 } })
      pages[1]!()
      await settle()
      expect(loadEarlier).toHaveBeenCalledTimes(2)
      expect(h.label()).toBe('History 1/1')
      expect(h.value()).toBe('only')
    })

    it('gives up on a page that adds no rows instead of looping on a failing read', async () => {
      const loadEarlier = vi.fn(async () => {})
      const h = mountHarness([entry('only')], { hasEarlier: true, loadEarlier, loadedRows: 10 })
      h.press('ArrowUp')
      h.press('ArrowUp')
      await settle() // settled with nothing new
      expect(loadEarlier).toHaveBeenCalledTimes(1)
      expect(h.label()).toBe('History 1/1+')
    })

    it('Escape and Down cancel a pending page walk', async () => {
      const loadEarlier = vi.fn(() => new Promise<void>(() => {}))
      const h = mountHarness([entry('only')], { hasEarlier: true, loadEarlier, loadedRows: 10 })
      h.press('ArrowUp')
      h.press('ArrowUp')
      expect(h.label()).toBe('History 1/1+ · loading earlier…')
      h.press('ArrowDown')
      expect(h.label()).toBe('History 1/1+')
      expect(h.value()).toBe('only')
      h.press('ArrowUp')
      h.press('Escape')
      expect(h.label()).toBeNull()
      expect(h.value()).toBe('')
      // The page that was in flight lands afterwards and must not recall anything.
      h.update({ history: [entry('older'), entry('only')], paging: { hasEarlier: false, loadEarlier, loadedRows: 30 } })
      expect(h.value()).toBe('')
      expect(h.label()).toBeNull()
    })

    it('Up on an empty draft with no loaded prompts pages until one arrives', async () => {
      const loadEarlier = vi.fn(async () => {})
      const h = mountHarness([], { hasEarlier: true, loadEarlier, loadedRows: 10 })
      expect(h.press('ArrowUp').consumed).toBe(true)
      expect(h.label()).toBe('History · loading earlier…')
      expect(loadEarlier).toHaveBeenCalledTimes(1)
      h.update({ history: [entry('found')], paging: { hasEarlier: true, loadEarlier, loadedRows: 30 } })
      await settle()
      expect(h.value()).toBe('found')
      expect(h.label()).toBe('History 1/1+')
    })

    it('typing while a page loads cancels the walk and keeps the typed text', async () => {
      const loadEarlier = vi.fn(async () => {})
      const h = mountHarness([], { hasEarlier: true, loadEarlier, loadedRows: 10 })
      h.press('ArrowUp')
      h.type('mine')
      h.update({ history: [entry('found')], paging: { hasEarlier: false, loadEarlier, loadedRows: 30 } })
      await settle()
      expect(h.value()).toBe('mine')
      expect(h.label()).toBeNull()
    })
  })
})

describe('composerHistoryFromRows', () => {
  const isSelf = (sender: string) => sender === 'me'
  const keyOf = (row: { seq: number }) => `s#${row.seq}`

  it('keeps only the viewer’s non-empty prompts in order, keyed by row', () => {
    expect(
      composerHistoryFromRows(
        [
          { seq: 1, sender: 'me', text: 'one' },
          { seq: 2, sender: 'agent', text: 'reply' },
          { seq: 3, sender: 'me', text: '   ' },
          { seq: 4, sender: 'someone-else', text: 'theirs' },
          { seq: 5, sender: 'me', text: 'two' }
        ],
        isSelf,
        keyOf
      )
    ).toEqual([
      { key: 's#1', text: 'one' },
      { key: 's#5', text: 'two' }
    ])
  })

  it('drops merged-conversation copies of one post and back-to-back repeats', () => {
    expect(
      composerHistoryFromRows(
        [
          { seq: 1, sender: 'me', text: 'hi', postId: 'p1' },
          { seq: 2, sender: 'me', text: 'hi', postId: 'p1' },
          { seq: 3, sender: 'me', text: 'again' },
          { seq: 4, sender: 'me', text: 'again' },
          { seq: 5, sender: 'me', text: 'hi' }
        ],
        isSelf,
        keyOf
      )
    ).toEqual([
      { key: 'p1', text: 'hi' },
      { key: 's#3', text: 'again' },
      { key: 's#5', text: 'hi' }
    ])
  })
})
