// @vitest-environment happy-dom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ verify: vi.fn(), confirm: vi.fn(), orgs: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  isAuthConfigured: () => true,
  getUser: async () => ({ sub: 'example-user' }),
  login: vi.fn()
}))
vi.mock('@/lib/api', () => ({
  ApiError: class extends Error {},
  fetchOrgs: mocks.orgs,
  verifyMsTeamsRecovery: mocks.verify,
  confirmMsTeamsRecovery: mocks.confirm
}))

import MsTeamsRecovery from './MsTeamsRecovery'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

beforeEach(() => {
  vi.resetAllMocks()
  mocks.orgs.mockResolvedValue([{ id: 'example-org', name: 'Example Org', slug: 'example', role: 'collaborator' }])
  mocks.verify.mockResolvedValue({ ticket: 'encrypted-ticket' })
  mocks.confirm.mockResolvedValue({})
  sessionStorage.clear()
  sessionStorage.setItem(
    'ac.msTeamsRecovery',
    JSON.stringify({ orgId: 'example-org', agentId: 'example-agent', state: 'signed-state' })
  )
  window.history.replaceState({}, '', '/msteams/connect?state=signed-state&code=one-use-code')
  vi.spyOn(window.location, 'assign').mockImplementation(() => undefined)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})
const render = () =>
  act(async () =>
    root.render(
      <StrictMode>
        <MsTeamsRecovery />
      </StrictMode>
    )
  )
const button = (label: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === label)!

describe('Teams recovery confirmation', () => {
  it('exchanges the code once and waits for explicit confirmation with the destination shown', async () => {
    mocks.orgs.mockImplementation(async () => {
      expect(window.location.search).toBe('')
      return [{ id: 'example-org', name: 'Example Org', slug: 'example', role: 'collaborator' }]
    })
    await render()
    expect(mocks.verify).toHaveBeenCalledExactlyOnceWith('example-org', 'signed-state', 'one-use-code')
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Connect this Microsoft 365 tenant to Example Org?')
    expect(host.textContent).toContain("Its agents and history stay there; connection settings aren't transferred.")
    expect(window.location.search).toBe('')
    expect(sessionStorage.getItem('ac.msTeamsRecovery')).toBeNull()
    await act(async () => button('Recover connection').click())
    expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith('example-org', 'encrypted-ticket')
    expect(host.textContent).toContain('Connection recovered')
  })

  it('cancels without releasing the old connection', async () => {
    await render()
    await act(async () => button('Cancel').click())
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(window.location.assign).toHaveBeenCalledWith('/example/agents/example-agent')
  })

  it('rejects a mismatched OAuth return before any code exchange or confirmation', async () => {
    window.history.replaceState({}, '', '/msteams/connect?state=other-state&code=one-use-code')
    await render()
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    expect(mocks.verify).not.toHaveBeenCalled()
    expect(mocks.confirm).not.toHaveBeenCalled()
  })
})
