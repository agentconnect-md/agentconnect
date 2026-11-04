// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentTurnHeader, type TurnWork } from './AgentTurnHeader'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-04T08:00:00Z'))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

const work = (running: boolean): TurnWork => {
  const start = Date.parse('2026-11-04T08:00:00Z')
  // A live stream stamps every step with the turn's start, so the span alone gives no finished duration.
  return { summary: 'Ran 2 commands', open: false, onToggle: () => {}, running, span: { startMs: start, endMs: start } }
}

it('keeps the time a live turn ticked to once it finishes', () => {
  act(() => root.render(<AgentTurnHeader name="test" work={work(true)} />))
  act(() => vi.advanceTimersByTime(26_000))
  expect(container.textContent).toContain('Working for 26s')
  act(() => root.render(<AgentTurnHeader name="test" work={work(false)} />))
  expect(container.textContent).toContain('Worked for 26s')
})

it('shows no duration for a finished turn it never saw run', () => {
  act(() => root.render(<AgentTurnHeader name="test" work={work(false)} />))
  expect(container.textContent).not.toMatch(/Work(ed|ing) for/)
})

it('does not extend a finished turn that briefly seems to run again', () => {
  act(() => root.render(<AgentTurnHeader name="test" work={work(true)} />))
  act(() => vi.advanceTimersByTime(27_000))
  act(() => root.render(<AgentTurnHeader name="test" work={work(false)} />))
  act(() => vi.advanceTimersByTime(11_000))
  // A new prompt is busy before it is listed, so the previous turn reads as running for a render.
  act(() => root.render(<AgentTurnHeader name="test" work={work(true)} />))
  act(() => vi.advanceTimersByTime(2_000))
  act(() => root.render(<AgentTurnHeader name="test" work={work(false)} />))
  expect(container.textContent).toContain('Worked for 27s')
})

it('keeps its time when a regenerated answer drops the turn work for a render', () => {
  act(() => root.render(<AgentTurnHeader name="test" work={work(true)} />))
  act(() => vi.advanceTimersByTime(10_000))
  act(() => root.render(<AgentTurnHeader name="test" />))
  act(() => root.render(<AgentTurnHeader name="test" work={work(false)} />))
  expect(container.textContent).toContain('Worked for 10s')
})
