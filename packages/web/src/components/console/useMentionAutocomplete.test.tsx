// @vitest-environment happy-dom
import { act, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { useMentionAutocomplete } from './useMentionAutocomplete'

interface Candidate {
  id: string
  name: string
  dimmed?: boolean
}

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = null
  container = null
})

function mountHarness(onPick: (c: Candidate) => Promise<boolean> | void, candidates: Candidate[] = []) {
  let api!: ReturnType<typeof useMentionAutocomplete<Candidate>>
  let setDraft!: (v: string) => void
  let getValue!: () => string

  function Harness() {
    const [value, setValue] = useState('')
    const ref = useRef<HTMLTextAreaElement>(null)
    api = useMentionAutocomplete<Candidate>({ ref, value, setValue, candidates, onPick })
    setDraft = setValue
    getValue = () => value
    return <textarea ref={ref} value={value} readOnly />
  }

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<Harness />))
  return { api: () => api, setDraft: (v: string) => setDraft(v), getValue: () => getValue() }
}

// A pending join's rollback range is tracked by absolute offset — the
// regression this covers: an EARLIER pending pick's rollback removes text
// and shifts everything after it, and a LATER pick's own tracked range has
// to move with it or its eventual rollback compares against the wrong slice
// and silently leaves a dangling, unresolved "@Name" behind.
describe('useMentionAutocomplete — overlapping failed joins', () => {
  it('shifts a later pending range when an earlier one rolls back first, so both roll back correctly', async () => {
    let resolveA!: (v: boolean) => void
    let resolveB!: (v: boolean) => void
    const pending: Record<string, Promise<boolean>> = {}
    const { api, setDraft, getValue } = mountHarness(
      (c) =>
        new Promise<boolean>((resolve) => {
          if (c.id === 'a') resolveA = resolve
          else resolveB = resolve
        })
    )
    void pending

    act(() => {
      setDraft('@a')
      api().sync('@a', 2)
    })
    act(() => {
      api().pick({ id: 'a', name: 'alice' })
    })
    expect(getValue()).toBe('@alice ')

    act(() => {
      setDraft('@alice @b')
      api().sync('@alice @b', 9)
    })
    act(() => {
      api().pick({ id: 'b', name: 'bob' })
    })
    expect(getValue()).toBe('@alice @bob ')

    // alice's join fails first — rolls back, and bob's tracked range must
    // shift left with it or the next rollback targets stale offsets.
    await act(async () => {
      resolveA(false)
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(getValue()).toBe('@bob ')

    // bob's join ALSO fails — without the shift, this compares against the
    // pre-shift slice, finds no match, and leaves "@bob " behind for good.
    await act(async () => {
      resolveB(false)
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(getValue()).toBe('')
  })

  it('rolls back both even when their joins settle in the same microtask batch', async () => {
    let resolveA!: (v: boolean) => void
    let resolveB!: (v: boolean) => void
    const { api, setDraft, getValue } = mountHarness(
      (c) =>
        new Promise<boolean>((resolve) => {
          if (c.id === 'a') resolveA = resolve
          else resolveB = resolve
        })
    )

    act(() => {
      setDraft('@a')
      api().sync('@a', 2)
    })
    act(() => {
      api().pick({ id: 'a', name: 'alice' })
    })
    act(() => {
      setDraft('@alice @b')
      api().sync('@alice @b', 9)
    })
    act(() => {
      api().pick({ id: 'b', name: 'bob' })
    })
    expect(getValue()).toBe('@alice @bob ')

    // Both settle back-to-back with NO render (and no `valueRef` refresh
    // from one) in between — a rollback that only learns `value` moved on
    // via the next render, instead of writing its own ref synchronously,
    // would have bob's rollback compare against the pre-removal string.
    await act(async () => {
      resolveA(false)
      resolveB(false)
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(getValue()).toBe('')
  })
})

function fakeKeyEvent(key: string): ReactKeyboardEvent<HTMLTextAreaElement> & { defaultPrevented: boolean } {
  const event = {
    key,
    nativeEvent: { isComposing: false },
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true
    }
  }
  return event as unknown as ReactKeyboardEvent<HTMLTextAreaElement> & { defaultPrevented: boolean }
}

// The regression: with every match dimmed, there is nothing `pick()` can
// land on — but handleKeyDown was still swallowing Tab/Enter to try anyway,
// which trapped keyboard focus inside the composer (Tab couldn't leave it)
// while `pick()` silently no-opped.
describe('useMentionAutocomplete — every match dimmed', () => {
  it("lets Tab fall through AND closes the picker — it can't survive focus leaving anyway", () => {
    const { api, setDraft } = mountHarness(() => undefined, [{ id: 'x', name: 'offline-bot', dimmed: true }])
    act(() => {
      setDraft('@off')
      api().sync('@off', 4)
    })
    expect(api().matches).toHaveLength(1)

    const tab = fakeKeyEvent('Tab')
    let consumed!: boolean
    act(() => {
      consumed = api().handleKeyDown(tab)
    })
    expect(consumed).toBe(false)
    expect(tab.defaultPrevented).toBe(false)
    // Left open, it would sit there orphaned next to a textarea that no
    // longer has focus — Tab already moved on, so the menu should too.
    expect(api().open).toBe(false)
  })

  it("lets Enter fall through WITHOUT closing — focus never left, so there's nothing to dismiss", () => {
    const { api, setDraft } = mountHarness(() => undefined, [{ id: 'x', name: 'offline-bot', dimmed: true }])
    act(() => {
      setDraft('@off')
      api().sync('@off', 4)
    })
    expect(api().matches).toHaveLength(1)

    const enter = fakeKeyEvent('Enter')
    let consumed!: boolean
    act(() => {
      consumed = api().handleKeyDown(enter)
    })
    expect(consumed).toBe(false)
    expect(enter.defaultPrevented).toBe(false)
    expect(api().open).toBe(true)
  })
})
