// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@/lib/data'

const mocks = vi.hoisted(() => ({ requests: vi.fn() }))
vi.mock('./api', () => ({ msTeamsApi: { requests: mocks.requests } }))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ activeOrg: { id: 'org-a' } }) }))

import { MsTeamsPendingEntry } from './pending'

const agent = { id: 'agent-a', name: 'deploy-bot' } as unknown as Agent
const WAITING = {
  id: 'req-1',
  agentId: 'agent-a',
  tenantId: 'example-tenant',
  status: 'pending',
  reason: null,
  name: 'deploy-bot (Example Org)',
  createdAt: '2026-11-01T00:00:00.000Z',
  adminCenterUrl: 'https://admin.example.test/manage-apps/catalog-1'
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  mocks.requests.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function render(open = vi.fn(), mockMode = false) {
  await act(async () =>
    root.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <MsTeamsPendingEntry agent={agent} mockMode={mockMode} open={open} />
      </SWRConfig>
    )
  )
  return open
}

describe('MsTeamsPendingEntry', () => {
  it('lists a waiting request with the agent’s integrations, and opens the Teams pane on a click', async () => {
    mocks.requests.mockResolvedValue([WAITING])
    const open = await render()
    expect(mocks.requests).toHaveBeenCalledWith('org-a', 'agent-a')
    expect(host.textContent).toContain('deploy-bot (Example Org)')
    expect(host.textContent).toContain('Pending')
    expect(host.textContent).toContain('Waiting for a Teams administrator to publish the agent’s app')
    await act(async () => host.querySelector('button')!.click())
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('draws nothing without a request, and asks nothing in design mode', async () => {
    mocks.requests.mockResolvedValue([])
    await render()
    expect(host.innerHTML).toBe('')
    mocks.requests.mockClear()
    await render(vi.fn(), true)
    expect(mocks.requests).not.toHaveBeenCalled()
    expect(host.innerHTML).toBe('')
  })
})
