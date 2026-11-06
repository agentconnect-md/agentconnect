// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { StateIcon, sessionState } from './StateIcon'
import { SendButton } from './SendButton'
import { taskTone } from './task-list'
import type { AssistantSubsessionDto } from '@/lib/api'
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

it('names its state for a reader and marks a finished one with a check', () => {
  act(() => root.render(<StateIcon state="done" label="Finished" />))
  const icon = container.querySelector('[data-state-icon]')!
  expect(icon.getAttribute('data-state-icon')).toBe('done')
  expect(icon.getAttribute('role')).toBe('img')
  expect(icon.getAttribute('aria-label')).toBe('Finished')
  expect(icon.querySelector('svg')).not.toBeNull()
})

it('reads a session as running while a turn streams here or its raw status prompts or cancels', () => {
  expect(sessionState('idle', true)).toBe('running')
  expect(sessionState('prompting', false)).toBe('running')
  expect(sessionState('cancelling', false)).toBe('running')
  expect(sessionState('error', false)).toBe('failed')
  expect(sessionState('idle', false)).toBe('idle')
  expect(sessionState('closed', false)).toBe('idle')
})

it('draws a waiting follow-up as waiting, a threaded task between turns as idle, and an ended follow-up as done', () => {
  const row = (patch: Partial<AssistantSubsessionDto>) =>
    ({
      sessionId: 's',
      title: 't',
      state: 'done',
      startedAt: '',
      visible: true,
      canStop: false,
      parent: null,
      ...patch
    }) as AssistantSubsessionDto
  const followUp = (status: 'waiting' | 'checking' | 'paused' | 'done' | 'stopped') => ({ status }) as never
  expect(taskTone(row({ state: 'open' }), followUp('waiting'))).toBe('waiting')
  expect(taskTone(row({ state: 'open' }), followUp('checking'))).toBe('running')
  expect(taskTone(row({ state: 'open' }), followUp('paused'))).toBe('idle')
  expect(taskTone(row({}), followUp('stopped'))).toBe('done')
  expect(taskTone(row({ threaded: true }), null)).toBe('idle')
  expect(taskTone(row({}), null)).toBe('done')
  expect(taskTone(row({ state: 'failed' }), null)).toBe('failed')
})

it('sends with an arrow and stops with a square, each named for a reader', () => {
  act(() => root.render(<SendButton label="Send" disabled />))
  const send = container.querySelector<HTMLButtonElement>('button')!
  expect(send.getAttribute('data-send-button')).toBe('send')
  expect(send.getAttribute('aria-label')).toBe('Send')
  expect(send.disabled).toBe(true)
  act(() => root.render(<SendButton stop label="Stop" />))
  expect(container.querySelector('button')!.getAttribute('data-send-button')).toBe('stop')
})
