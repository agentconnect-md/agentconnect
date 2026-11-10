// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { renderWithIntl } from '@/i18n/test-utils'
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

const work = (running: boolean, over: Partial<TurnWork> = {}): TurnWork => {
  const start = Date.parse('2026-11-04T08:00:00Z')
  // A live stream stamps every step with the turn's start, so the span alone gives no finished duration.
  return {
    summary: 'Ran 2 commands',
    failed: 0,
    open: false,
    onToggle: () => {},
    running,
    span: { startMs: start, endMs: start },
    ...over
  }
}

const show = (w?: TurnWork) =>
  act(() => root.render(renderWithIntl(<AgentTurnHeader name="test" {...(w ? { work: w } : {})} />)))
const fold = () => container.querySelector<HTMLButtonElement>('[data-turn-fold]')!

it('keeps the time a live turn ticked to once it finishes', () => {
  show(work(true))
  act(() => vi.advanceTimersByTime(26_000))
  expect(fold().textContent).toBe('26s')
  expect(fold().querySelector('[data-turn-running]')).not.toBeNull()
  expect(fold().title).toBe('Working for 26s · ran 2 commands')
  show(work(false))
  expect(fold().textContent).toBe('26s')
  expect(fold().querySelector('[data-turn-running]')).toBeNull()
  expect(fold().title).toBe('Worked for 26s · ran 2 commands')
})

it('shows no duration for a finished turn it never saw run, keeping the counts in its tooltip', () => {
  show(work(false))
  expect(fold().textContent).toBe('')
  expect(fold().title).toBe('ran 2 commands')
})

it('says how many commands failed after the duration, in the error colour', () => {
  show(work(true))
  act(() => vi.advanceTimersByTime(18_000))
  show(work(false, { failed: 1 }))
  expect(fold().textContent).toBe('18s· 1 failed')
  expect(fold().querySelector('.text-\\(--status-error\\)')?.textContent).toBe('1 failed')
  expect(fold().title).toBe('Worked for 18s · ran 2 commands · 1 failed')
})

it('leads a stopped turn with Stopped', () => {
  show(work(true))
  act(() => vi.advanceTimersByTime(3_000))
  show(work(false, { stopped: true }))
  expect(fold().textContent).toBe('Stopped · 3s')
})

it('does not extend a finished turn that briefly seems to run again', () => {
  show(work(true))
  act(() => vi.advanceTimersByTime(27_000))
  show(work(false))
  act(() => vi.advanceTimersByTime(11_000))
  // A new prompt is busy before it is listed, so the previous turn reads as running for a render.
  show(work(true))
  act(() => vi.advanceTimersByTime(2_000))
  show(work(false))
  expect(fold().textContent).toBe('27s')
})

it('keeps its time when a regenerated answer drops the turn work for a render', () => {
  show(work(true))
  act(() => vi.advanceTimersByTime(10_000))
  show()
  show(work(false))
  expect(fold().textContent).toBe('10s')
})

it('links the agent’s name to its page where the agent is known, as its icon does', () => {
  act(() => root.render(renderWithIntl(<AgentTurnHeader name="Mobile Developer" href="/acme/agents/agent-1" />)))
  const name = container.querySelector('a')
  expect(name?.textContent).toBe('Mobile Developer')
  expect(name?.getAttribute('href')).toBe('/acme/agents/agent-1')
  act(() => root.render(renderWithIntl(<AgentTurnHeader name="Mobile Developer" />)))
  expect(container.querySelector('a')).toBeNull()
})
