// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ids: ['selected-decision'],
  update: vi.fn(),
  rows: [
    {
      id: 'selected-decision',
      name: 'Attached Selected Decision',
      providerId: 'typesafe',
      model: 'jev-latest',
      questionType: 'boolean'
    },
    {
      id: 'visible-decision',
      name: 'Available Decision',
      providerId: 'typesafe',
      model: 'jev-latest',
      questionType: 'choice'
    }
  ]
}))
vi.mock('@/lib/api', () => ({
  fetchAgentDto: vi.fn(async () => ({ decisionIds: mocks.ids })),
  fetchAgentDecisions: vi.fn(async () => mocks.rows.filter((row) => mocks.ids.includes(row.id)))
}))
vi.mock('@/lib/data-context', () => ({ useConsoleData: () => ({ updateAgent: mocks.update }) }))
vi.mock('@/lib/decisions/provider', () => ({
  useDecisionsPrototype: () => ({
    api: { mode: 'live' },
    orgId: 'example-org',
    decisions: [mocks.rows[1]],
    loading: false,
    reload: vi.fn(async () => undefined),
    error: null
  })
}))

import { AgentDecisionsCard } from './AgentDecisionsCard'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
let host: HTMLDivElement | undefined
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  mocks.ids = ['selected-decision']
  mocks.update.mockReset()
})
async function render(canEdit = true) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <AgentDecisionsCard agentId="example-agent" canEdit={canEdit} />
      </SWRConfig>
    )
  })
}

describe('Agent Decision attachments', () => {
  it('adds from the visible library, preserves hidden attachments, and retains saved rows after a failed removal', async () => {
    mocks.update.mockImplementation(async (_id: string, patch: { decisionIds: string[] }) => {
      mocks.ids = patch.decisionIds
    })
    await render()
    expect(host!.textContent).toContain('Attached Selected Decision')
    expect(host!.textContent).not.toContain('Available Decision')
    await act(async () => {
      ;[...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Add'))!.click()
    })
    const menu = document.querySelector('[data-anchored-flyout]')!
    expect(menu.textContent).toContain('Available Decision')
    expect(menu.textContent).not.toContain('Attached Selected Decision')
    await act(async () => {
      ;[...menu.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('Available Decision'))!
        .click()
    })
    expect(mocks.update).toHaveBeenCalledWith('example-agent', {
      decisionIds: ['selected-decision', 'visible-decision']
    })
    expect(host!.textContent).toContain('Available Decision')
    mocks.update.mockRejectedValueOnce(new Error('Could not save attachments'))
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('button[title="Remove from agent"]')!.click()
    })
    expect(host!.textContent).toContain('Attached Selected Decision')
    expect(host!.querySelector('[role="alert"]')!.textContent).toContain('Could not save attachments')
  })

  it('keeps attachments visible to a read-only viewer without edit controls', async () => {
    await render(false)
    expect(host!.textContent).toContain('Attached Selected Decision')
    expect(host!.querySelector('button')).toBeNull()
  })
})
