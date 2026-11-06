// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Session } from '@/lib/data'
import { TaskRuntimePicker } from './TaskRuntimePicker'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const wire = vi.hoisted(() => ({
  session: undefined as Partial<Session> | undefined,
  detail: null as Record<string, unknown> | null,
  calls: [] as string[]
}))

vi.mock(import('@/lib/api'), async (importOriginal) => ({
  ...(await importOriginal()),
  fetchSessionDetail: vi.fn(() =>
    wire.detail ? Promise.resolve(wire.detail as never) : Promise.reject(new Error('none'))
  )
}))

vi.mock('@/components/console/PlaygroundProvider', () => ({
  usePlayground: () => ({
    getPgSession: () => wire.session,
    markSessionTarget: (id: string) => wire.calls.push(`target:${id}`),
    pgSetModel: vi.fn(),
    pgSetEffort: vi.fn(),
    pgSetPermissionPreset: vi.fn(),
    pgSetFast: vi.fn()
  })
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  wire.session = undefined
  wire.detail = null
  wire.calls = []
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const draw = async (editable = true) => {
  await act(async () =>
    root.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <TaskRuntimePicker
          sessionId="ses_task"
          agentId="agent_1"
          owner={undefined}
          owningDaemon={undefined}
          agentRuntime="claude"
          editable={editable}
        />
      </SWRConfig>
    )
  )
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

it('offers nothing while neither the task’s live session nor its record says what it runs', async () => {
  await draw()
  expect(container.querySelector('[data-task-runtime]')).toBeNull()
})

it('names the task’s recorded model before its live session reports, as on a transport that never does', async () => {
  wire.detail = { runtime: 'claude', model: 'sonnet', effort: null, fastMode: null, permissionMode: null }
  await draw()
  expect(container.querySelector('[data-task-runtime]')?.textContent).toContain('sonnet')
})

it('names the task’s model once its session reports its choices', async () => {
  wire.session = {
    runtime: 'claude',
    model: 'opus',
    availableModels: ['opus', 'sonnet'],
    availableEfforts: ['high'],
    effort: 'high'
  }
  await draw()
  const picker = container.querySelector('[data-task-runtime]')
  expect(picker).not.toBeNull()
  expect(picker?.textContent).toContain('opus')
})
