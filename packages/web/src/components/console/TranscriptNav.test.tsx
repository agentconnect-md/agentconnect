// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
  { key: 'u1', human: true, tip: 'Sam: ship it' },
  { key: 'a1', human: false, tip: 'Ops bot · 2:14 PM' },
  { key: 'u2', human: true, tip: 'Sam: and the notes' },
  { key: 'a2', human: false, tip: 'Ops bot · 2:16 PM' }
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

it('draws a short tick for a person and a long one for an agent, and scrolls to a turn from its tick', () => {
  const scrollTo = vi.fn()
  HTMLElement.prototype.scrollTo = scrollTo as never
  draw(<TranscriptMap turns={turns} />)
  const ticks = [...container.querySelectorAll<HTMLButtonElement>('[data-transcript-map] button')]
  expect(ticks.map((tick) => tick.getAttribute('aria-label'))).toEqual(turns.map((turn) => turn.tip))
  expect(ticks[0]!.className).toContain('w-3')
  expect(ticks[1]!.className).toContain('w-[18px]')
  // One tick marks the turn in view.
  expect(ticks.filter((tick) => tick.getAttribute('aria-current') === 'true')).toHaveLength(1)
  act(() => ticks[2]!.click())
  expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }))
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
