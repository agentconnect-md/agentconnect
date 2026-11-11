// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { renderWithIntl } from '@/i18n/test-utils'
import { speaker } from '@/lib/data'
import type { Turn } from './session-turns'

vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (path: string) => `/acme${path}` }) }))

import { UserTurnView } from './TurnViews'
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

const message = (over: Partial<Extract<Turn, { kind: 'user' }>> = {}): Extract<Turn, { kind: 'user' }> => ({
  kind: 'user',
  key: 'u:1',
  sp: speaker('Dana Reyes'),
  agent: null,
  sourceLabel: '',
  time: '',
  text: 'Is the deploy done?',
  isCron: false,
  cronId: null,
  ...over
})

const draw = (turn: Extract<Turn, { kind: 'user' }>) =>
  act(() => root.render(renderWithIntl(<UserTurnView turn={turn} onShare={() => {}} />)))

it('draws a schedule’s avatar on the light chip tile, not the dark agent plate', () => {
  draw(message({ isCron: true, cronId: 'cron-1', sp: speaker('Hourly sweep') }))
  const tile = container.querySelector('[title="Hourly sweep"]')
  expect(tile?.classList.contains('imark')).toBe(true)
  expect(tile?.classList.contains('av')).toBe(false)
})

it('draws only the reader’s own message on the right, and everyone else’s on the left with the avatar first', () => {
  draw(message({ self: true }))
  const row = () => container.firstElementChild as HTMLElement
  expect(row().className).toContain('justify-end')
  // The reader's avatar comes after their column.
  expect(row().lastElementChild?.textContent).not.toContain('Is the deploy done?')
  expect(container.querySelector('[role="toolbar"]')?.className).toContain('left-[8px]')

  draw(message())
  expect(row().className).toContain('justify-start')
  expect(row().firstElementChild?.textContent).not.toContain('Is the deploy done?')
  expect(row().lastElementChild?.textContent).toContain('Is the deploy done?')
  // Its hover menu faces the timeline, on the right of a message on the left.
  expect(container.querySelector('[role="toolbar"]')?.className).toContain('right-[8px]')
})
