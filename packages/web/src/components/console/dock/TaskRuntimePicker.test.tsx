// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Session } from '@/lib/data'
import { TaskRuntimePicker } from './TaskRuntimePicker'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const wire = vi.hoisted(() => ({ session: undefined as Partial<Session> | undefined }))

vi.mock('@/components/console/PlaygroundProvider', () => ({
  usePlayground: () => ({
    getPgSession: () => wire.session,
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
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const draw = (editable = true) =>
  act(() =>
    root.render(
      <TaskRuntimePicker
        sessionId="ses_task"
        agentId="agent_1"
        owner={undefined}
        owningDaemon={undefined}
        agentRuntime="claude"
        editable={editable}
      />
    )
  )

it('offers nothing until the task’s session has reported what it can change to', () => {
  draw()
  expect(container.querySelector('[data-task-runtime]')).toBeNull()
})

it('names the task’s model once its session reports its choices', () => {
  wire.session = {
    runtime: 'claude',
    model: 'opus',
    availableModels: ['opus', 'sonnet'],
    availableEfforts: ['high'],
    effort: 'high'
  }
  draw()
  const picker = container.querySelector('[data-task-runtime]')
  expect(picker).not.toBeNull()
  expect(picker?.textContent).toContain('opus')
})
