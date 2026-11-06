// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import messages from '../../../messages/en.json'
import { ApiError, type AgentTaskDto, type AgentTasksDto } from '@/lib/api'
import { RunningCommandsDock } from './RunningCommandsDock'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const wire = vi.hoisted(() => ({ tasks: [] as AgentTaskDto[], reads: [] as string[], failStatus: 0 }))

vi.mock(import('@/lib/api'), async (importOriginal) => ({
  ...(await importOriginal()),
  fetchAgentTasks: vi.fn((agentId: string, sessionId: string) => {
    wire.reads.push(`${agentId}/${sessionId}`)
    if (wire.failStatus) return Promise.reject(new ApiError('unavailable', wire.failStatus))
    return Promise.resolve({ sessionId, tracked: true, tasks: wire.tasks, truncated: false } satisfies AgentTasksDto)
  })
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  wire.tasks = []
  wire.reads = []
  wire.failStatus = 0
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const task = (patch: Partial<AgentTaskDto>): AgentTaskDto => ({
  id: 'task-1',
  description: 'kubectl rollout status deploy/api --watch',
  state: 'running',
  subagent: false,
  startedAt: new Date(Date.now() - 65_000).toISOString(),
  endedAt: null,
  detail: null,
  ...patch
})

async function draw(turnActive = false) {
  await act(async () =>
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <RunningCommandsDock agentId="agent-a" sessionId="session-1" turnActive={turnActive} />
      </NextIntlClientProvider>
    )
  )
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

it('draws nothing while the session runs no background command', async () => {
  wire.tasks = [task({ state: 'done', endedAt: new Date().toISOString() }), task({ id: 'sub', subagent: true })]
  await draw()
  expect(wire.reads).toEqual(['agent-a/session-1'])
  expect(container.querySelector('[data-running-commands]')).toBeNull()
})

it('docks each running command with how long it has run, and folds to its count', async () => {
  wire.tasks = [task({}), task({ id: 'task-2', description: null })]
  await draw()
  const dock = container.querySelector('[data-running-commands]')
  expect(dock?.textContent).toContain('2 shell commands')
  const rows = [...container.querySelectorAll('[data-running-command]')].map((row) => row.textContent)
  expect(rows[0]).toContain('kubectl rollout status deploy/api --watch')
  expect(rows[0]).toContain('1m 05s')
  expect(rows[1]).toContain('Unnamed background command')
  await act(async () => container.querySelector<HTMLButtonElement>('[data-running-commands] button')!.click())
  expect(container.querySelector('[data-running-command]')).toBeNull()
  expect(container.querySelector('[data-running-commands]')?.textContent).toContain('2 shell commands')
})

it('re-reads when the turn that may have started a command ends', async () => {
  await draw(true)
  expect(container.querySelector('[data-running-commands]')).toBeNull()
  wire.tasks = [task({})]
  await draw(false)
  expect(wire.reads.length).toBe(2)
  expect(container.querySelector('[data-running-commands]')?.textContent).toContain('1 shell command')
})

it('keeps the commands it last read through a read that may pass, and drops them for a definite answer', async () => {
  wire.tasks = [task({})]
  await draw(true)
  wire.failStatus = 503
  await draw(false)
  expect(wire.reads.length).toBe(2)
  expect(container.querySelector('[data-running-commands]')?.textContent).toContain('1 shell command')
  wire.failStatus = 409
  await draw(true)
  await draw(false)
  expect(container.querySelector('[data-running-commands]')).toBeNull()
})
