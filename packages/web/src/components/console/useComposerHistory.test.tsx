// @vitest-environment happy-dom
import { act, useState, type KeyboardEvent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { composerHistoryFromRows, useComposerHistory } from './useComposerHistory'

const HISTORY = ['first', 'second', 'third']

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
})

function mountHarness(history: readonly string[] = HISTORY) {
  let api!: ReturnType<typeof useComposerHistory>
  let setDraft!: (v: string) => void
  let getValue!: () => string

  function Harness() {
    const [value, setValue] = useState('')
    api = useComposerHistory({ history, value, setValue })
    setDraft = setValue
    getValue = () => value
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
    h.press('ArrowUp') // clamps at the oldest
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
})

describe('composerHistoryFromRows', () => {
  const isSelf = (sender: string) => sender === 'me'

  it('keeps only the viewer’s non-empty prompts in order', () => {
    expect(
      composerHistoryFromRows(
        [
          { sender: 'me', text: 'one' },
          { sender: 'agent', text: 'reply' },
          { sender: 'me', text: '   ' },
          { sender: 'someone-else', text: 'theirs' },
          { sender: 'me', text: 'two' }
        ],
        isSelf
      )
    ).toEqual(['one', 'two'])
  })

  it('drops merged-conversation copies of one post and back-to-back repeats', () => {
    expect(
      composerHistoryFromRows(
        [
          { sender: 'me', text: 'hi', postId: 'p1' },
          { sender: 'me', text: 'hi', postId: 'p1' },
          { sender: 'me', text: 'again' },
          { sender: 'me', text: 'again' },
          { sender: 'me', text: 'hi' }
        ],
        isSelf
      )
    ).toEqual(['hi', 'again', 'hi'])
  })
})
