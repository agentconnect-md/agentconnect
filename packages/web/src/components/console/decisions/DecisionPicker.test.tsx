// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DecisionPicker } from './DecisionPicker'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root
let container: HTMLDivElement
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

const decisions = [
  { id: 'task-type', name: 'Task type', question: { type: 'choice' as const }, providerId: 'typesafe', model: 'jev' },
  {
    id: 'needs-reply',
    name: 'Needs a reply',
    question: { type: 'boolean' as const },
    providerId: 'typesafe',
    model: 'jev'
  }
]

it('lists saved decisions, marks the bound one, picks another and offers Add decision', async () => {
  const onSelect = vi.fn()
  const onCreate = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <DecisionPicker
        decisions={decisions}
        value="task-type"
        onSelect={onSelect}
        create={{ href: '/decisions/new', onClick: onCreate }}
      />
    )
  )
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!
  expect(trigger.textContent).toBe('Task type')
  await act(async () => trigger.click())
  const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
  expect(items.map((item) => [item.textContent, item.getAttribute('aria-checked')])).toEqual([
    ['Task typeChoice · jev', 'true'],
    ['Needs a replyBoolean · jev', 'false']
  ])
  const create = [...document.querySelectorAll('a')].find((link) => link.textContent === 'Add decision')!
  expect(create.getAttribute('href')).toBe('/decisions/new')
  await act(async () => items[1]!.click())
  expect(onSelect).toHaveBeenCalledWith(decisions[1])
  expect(document.querySelector('[role="menuitemradio"]')).toBeNull()
})

it('shows the bound decision in full on hover and prompts when none is bound', async () => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<DecisionPicker decisions={decisions} value="task-type" onSelect={vi.fn()} />))
  const trigger = container.querySelector('button')!
  await act(async () => trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  await act(async () => vi.advanceTimersByTime(260))
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
    'DecisionTask typeQuestion typeChoiceProvidertypesafeModeljev'
  )
  await act(async () => root.render(<DecisionPicker decisions={decisions} value={null} onSelect={vi.fn()} />))
  expect(trigger.textContent).toBe('Select a decision…')
})
