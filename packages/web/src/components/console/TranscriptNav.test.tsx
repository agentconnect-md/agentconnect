// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, beforeEach, expect, it } from 'vitest'
import messages from '../../../messages/en.json'
import { mapTicks, NewDivider, TranscriptMap, type MapTurn } from './TranscriptNav'
import { lastSpokenSentence } from './TurnViews'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const turns: MapTurn[] = [
  { key: 'u1', tip: 'Sam: ship it' },
  { key: 'a1', tip: 'Ops bot · 2:14 PM' },
  { key: 'u2', tip: 'Sam: and the notes' },
  { key: 'a2', tip: 'Ops bot · 2:16 PM' }
]

function draw(children: React.ReactNode) {
  act(() =>
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <div>
          {children}
          <div data-transcript-scroll="">
            {turns.map((turn) => (
              <div key={turn.key} data-turn-anchor={turn.key} />
            ))}
          </div>
        </div>
      </NextIntlClientProvider>
    )
  )
}

it('samples a long transcript evenly and always keeps its newest turn', () => {
  const many = Array.from({ length: 100 }, (_, i) => i)
  const ticks = mapTicks(many, 10)
  expect(ticks).toHaveLength(10)
  expect(ticks[0]).toBe(0)
  expect(ticks.at(-1)).toBe(99)
  expect(mapTicks([1, 2, 3], 10)).toEqual([1, 2, 3])
})

it('draws every tick short and the turn in view long, and scrolls smoothly to a turn from its tick', () => {
  let released = 0
  draw(<TranscriptMap turns={turns} onJump={() => released++} />)
  const ticks = () => [...container.querySelectorAll<HTMLButtonElement>('[data-transcript-map] button')]
  const bar = (tick: HTMLButtonElement) => tick.querySelector('span')!.className
  expect(ticks().map((tick) => tick.getAttribute('aria-label'))).toEqual(turns.map((turn) => turn.tip))
  // One tick marks the turn in view; it alone is the long one.
  expect(ticks().filter((tick) => tick.getAttribute('aria-current') === 'true')).toHaveLength(1)
  expect(ticks().filter((tick) => bar(tick).includes('w-[18px]'))).toHaveLength(1)
  expect(ticks().filter((tick) => bar(tick).includes('w-3'))).toHaveLength(turns.length - 1)
  const scroller = container.querySelector<HTMLElement>('[data-transcript-scroll]')!
  const target = container.querySelector<HTMLElement>('[data-turn-anchor="u2"]')!
  scroller.getBoundingClientRect = () => ({ top: 100 }) as DOMRect
  target.getBoundingClientRect = () => ({ top: 400 }) as DOMRect
  const calls: ScrollToOptions[] = []
  scroller.scrollTo = ((options: ScrollToOptions) => calls.push(options)) as never
  act(() => ticks()[2]!.click())
  // A smooth scroll the bottom-follow has let go of first, and the clicked tick is marked at once.
  expect(released).toBe(1)
  expect(calls).toEqual([{ top: 284, behavior: 'smooth' }])
  expect(ticks()[2]!.getAttribute('aria-current')).toBe('true')
})

it('names the nearest tick while the pointer is anywhere over the map, even between two ticks', () => {
  draw(<TranscriptMap turns={turns} />)
  const map = container.querySelector<HTMLElement>('[data-transcript-map]')!
  const rows = [...map.querySelectorAll<HTMLButtonElement>('button')]
  rows.forEach((row, i) => {
    row.getBoundingClientRect = () => ({ top: 100 + i * 7, height: 7 }) as DOMRect
  })
  const move = (clientY: number) =>
    act(() => {
      map.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY }))
    })
  move(110)
  expect(container.querySelector('[data-transcript-map-tip]')?.textContent).toBe('Ops bot · 2:14 PM')
  // Right between the second and third rows: still one of them, never none.
  move(114)
  expect(container.querySelector('[data-transcript-map-tip]')?.textContent).toMatch(
    /Ops bot · 2:14 PM|Sam: and the notes/
  )
  move(200)
  expect(container.querySelector('[data-transcript-map-tip]')?.textContent).toBe('Ops bot · 2:16 PM')
  act(() => {
    map.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
  })
  expect(container.querySelector('[data-transcript-map-tip]')).toBeNull()
})

it('draws no map for a transcript too short to need one, and names the NEW line', () => {
  draw(
    <>
      <TranscriptMap turns={turns.slice(0, 2)} />
      <NewDivider />
    </>
  )
  expect(container.querySelector('[data-transcript-map]')).toBeNull()
  expect(container.querySelector('[data-new-divider]')?.textContent).toBe('New')
})

it('names an agent turn by the last sentence it said, in Latin or CJK punctuation, without markdown', () => {
  const step = (text: string, lane = 'msg') => ({ text, lane }) as never
  expect(lastSpokenSentence([step('Ran the tests. **All 12 passed.** Want me to merge?')])).toBe('Want me to merge?')
  expect(lastSpokenSentence([step('明天以晴为主。数据来自 Open-Meteo。要查别的城市，告诉我城市名就行。')])).toBe(
    '要查别的城市，告诉我城市名就行。'
  )
  expect(lastSpokenSentence([step('See [the PR](https://example.test/pr/1)\n\n```\ncode\n```')])).toBe('See the PR')
  expect(lastSpokenSentence([])).toBe('')
})

it('marks the turn at the top of the pane, where a jump lands it, and the last turn once the pane is at its end', () => {
  draw(<TranscriptMap turns={turns} />)
  const scroller = container.querySelector<HTMLElement>('[data-transcript-scroll]')!
  const tops: Record<string, number> = { u1: 16, a1: 120, u2: 600, a2: 1200 }
  for (const el of container.querySelectorAll<HTMLElement>('[data-turn-anchor]'))
    el.getBoundingClientRect = () => ({ top: tops[el.dataset.turnAnchor!] }) as DOMRect
  scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
  const metrics = { scrollTop: 0, scrollHeight: 2000, clientHeight: 400 }
  for (const key of Object.keys(metrics) as (keyof typeof metrics)[])
    Object.defineProperty(scroller, key, { configurable: true, get: () => metrics[key] })
  const marked = () =>
    container.querySelector('[data-transcript-map] button[aria-current="true"]')?.getAttribute('aria-label')
  const scrollNow = () =>
    act(async () => {
      scroller.dispatchEvent(new Event('scroll'))
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })
  return (async () => {
    await scrollNow()
    // The short first turn sits at the top; the next one is in view too, but it is not where the pane starts.
    expect(marked()).toBe('Sam: ship it')
    metrics.scrollTop = 1600
    await scrollNow()
    expect(marked()).toBe('Ops bot · 2:16 PM')
  })()
})
