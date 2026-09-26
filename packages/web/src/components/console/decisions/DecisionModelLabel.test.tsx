// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ activeOrg: { id: 'example-org' } }) }))
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

it('links the Decision and opens Recent evaluations from an interactive card', async () => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <DecisionModelLabel
        name="PR Model"
        decisionHref="/decisions/d1"
        evaluations={{ agentId: 'a1', agentName: 'Reviewer', live: false }}
      />
    )
  )
  const label = container.querySelector('span')!
  await act(async () => label.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  await act(async () => vi.advanceTimersByTime(260))
  const card = document.querySelector<HTMLElement>('[role="tooltip"]')!
  expect(card.className).not.toContain('pointer-events-none')
  expect(card.querySelector('a')?.getAttribute('href')).toBe('/decisions/d1')
  // Leaving the trigger for the card keeps it open past the grace period.
  await act(async () => label.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: card })))
  await act(async () => card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  await act(async () => vi.advanceTimersByTime(200))
  const link = [...card.querySelectorAll('button')].find((button) => button.textContent === 'Recent evaluations')!
  await act(async () => link.click())
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
  const drawer = document.querySelector('[data-testid="model-selection-evaluations-drawer"]')!
  expect(drawer.textContent).toContain('Reviewer')
  expect(drawer.textContent).toContain('No evaluations yet.')
})
