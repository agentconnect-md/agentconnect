// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, beforeEach, expect, it } from 'vitest'
import messages from '../../../messages/en.json'
import { mapTicks, NewDivider, TranscriptMap, type MapTurn } from './TranscriptNav'
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

it('draws every tick short and the turn in view long, and jumps to a turn from its tick', () => {
  draw(<TranscriptMap turns={turns} />)
  const ticks = () => [...container.querySelectorAll<HTMLButtonElement>('[data-transcript-map] button')]
  expect(ticks().map((tick) => tick.getAttribute('aria-label'))).toEqual(turns.map((turn) => turn.tip))
  // One tick marks the turn in view; it alone is the long one.
  expect(ticks().filter((tick) => tick.getAttribute('aria-current') === 'true')).toHaveLength(1)
  expect(ticks().filter((tick) => tick.className.includes('w-[22px]'))).toHaveLength(1)
  expect(ticks().filter((tick) => tick.className.includes('w-3'))).toHaveLength(turns.length - 1)
  const scroller = container.querySelector<HTMLElement>('[data-transcript-scroll]')!
  const target = container.querySelector<HTMLElement>('[data-turn-anchor="u2"]')!
  scroller.getBoundingClientRect = () => ({ top: 100 }) as DOMRect
  target.getBoundingClientRect = () => ({ top: 400 }) as DOMRect
  act(() => ticks()[2]!.click())
  // An instant jump (no smooth scroll the bottom-follow could pull back), and the clicked tick is marked at once.
  expect(scroller.scrollTop).toBe(284)
  expect(ticks()[2]!.getAttribute('aria-current')).toBe('true')
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
