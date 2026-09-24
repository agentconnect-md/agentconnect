// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DecisionModelLabel } from './DecisionModelLabel'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root
let container: HTMLDivElement
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

it('names the Decision beside its icon and shows its rules on hover', async () => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <DecisionModelLabel name="PR Model" rules={[{ when: 'large ≥ 60%', then: 'opus' }]} fallback="sonnet" />
    )
  )
  const label = container.querySelector('span')!
  expect(label.textContent).toBe('PR Model')
  expect(label.querySelector('svg.lucide-split')).toBeTruthy()
  await act(async () => label.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  await act(async () => vi.advanceTimersByTime(260))
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
    'ModelBy decisionDecisionPR Model1large ≥ 60%opus—Fallbacksonnet'
  )
})
