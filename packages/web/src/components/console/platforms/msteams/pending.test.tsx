// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requests: vi.fn(), checkRequest: vi.fn() }))
vi.mock('./api', () => ({ msTeamsApi: { requests: mocks.requests, checkRequest: mocks.checkRequest } }))

import { msTeamsAgentPending } from './pending'

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
  mocks.checkRequest.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('the Teams request waiting on the agent page', () => {
  it('reads the agent’s oldest waiting request, or none', async () => {
    mocks.requests.mockResolvedValueOnce([WAITING, { ...WAITING, id: 'req-2' }]).mockResolvedValueOnce([])
    expect(await msTeamsAgentPending.read('org-a', 'agent-a')).toBe(WAITING)
    expect(mocks.requests).toHaveBeenCalledWith('org-a', 'agent-a')
    expect(await msTeamsAgentPending.read('org-a', 'agent-a')).toBeNull()
  })

  it('draws the request as the integration it becomes, opens the Teams pane, and checks again in place', async () => {
    const open = vi.fn()
    const refresh = vi.fn()
    const { Entry } = msTeamsAgentPending
    await act(async () => root.render(<Entry orgId="org-a" pending={WAITING} open={open} refresh={refresh} />))
    expect(host.textContent).toContain('deploy-bot (Example Org)')
    expect(host.textContent).toContain('Pending')
    expect(host.textContent).toContain('Waiting for a Teams administrator to publish the agent’s app')
    await act(async () => host.querySelector<HTMLButtonElement>('button:not([aria-label])')!.click())
    expect(open).toHaveBeenCalledTimes(1)
    // The refresh button reads the package's state now, then has the page read the agent's requests again.
    mocks.checkRequest.mockResolvedValue({ request: WAITING })
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Check again"]')!.click())
    expect(mocks.checkRequest).toHaveBeenCalledWith('org-a', 'req-1')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledTimes(1)
  })
})
