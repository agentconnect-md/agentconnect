// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { NextIntlClientProvider } from 'next-intl'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import messages from '../../../messages/en.json'
import { TaskBrief } from './TaskBrief'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const wire = vi.hoisted(() => ({ row: null as Record<string, unknown> | null }))

vi.mock(import('@/lib/api'), async (importOriginal) => ({
  ...(await importOriginal()),
  fetchAssistantSubsession: vi.fn(() => Promise.resolve(wire.row as never))
}))

vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ activeOrg: { id: 'org_acme' } }) }))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  wire.row = null
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function draw() {
  await act(async () =>
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <TaskBrief agentId="agent-1" sessionId="task-1" />
        </SWRConfig>
      </NextIntlClientProvider>
    )
  )
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

it('folds what the coordinator opened the task with to one line, and opens it on click', async () => {
  wire.row = { visible: true, background: 'Find what blocks api 1.5 and report back.', summary: 'Two left.' }
  await draw()
  const toggle = container.querySelector<HTMLButtonElement>('[data-task-brief] button')!
  expect(toggle.textContent).toBe('Started by the coordinator')
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(container.textContent).not.toContain('Find what blocks')
  await act(async () => toggle.click())
  expect(container.textContent).toContain('Find what blocks api 1.5 and report back.')
})

it('draws nothing for a task the reader may not see or one with no brief', async () => {
  wire.row = { visible: false, background: 'secret' }
  await draw()
  expect(container.querySelector('[data-task-brief]')).toBeNull()
  wire.row = { visible: true }
  await draw()
  expect(container.querySelector('[data-task-brief]')).toBeNull()
})
