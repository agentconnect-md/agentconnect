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
  verifyGoogleChatRecovery: mocks.verify,
  confirmGoogleChatRecovery: mocks.confirm
}))

import GoogleChatRecovery from './GoogleChatRecovery'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CLAIM = Buffer.from(
  JSON.stringify({
    v: 1,
    app: '123456789012',
    space: 'spaces/AAAAexample',
    kind: 'space',
    iat: 1_790_000_000
  })
).toString('base64url')
let root: Root
let host: HTMLElement

beforeEach(() => {
  vi.resetAllMocks()
  mocks.orgs.mockResolvedValue([{ id: 'example-org', name: 'Example Org', role: 'collaborator' }])
  mocks.verify.mockResolvedValue({ ticket: 'encrypted-ticket' })
  mocks.confirm.mockResolvedValue({})
  sessionStorage.clear()
  sessionStorage.setItem(
    'ac.googleChatRecovery',
    JSON.stringify({ orgId: 'example-org', claim: CLAIM, state: 'signed-state' })
  )
  window.history.replaceState({}, '', '/googlechat/recover?state=signed-state&code=one-use-code')
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
        <GoogleChatRecovery />
      </StrictMode>
    )
  )
const button = (label: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === label)!

describe('Google Chat recovery confirmation', () => {
  it('exchanges the code once and waits for explicit confirmation with the destination shown', async () => {
    mocks.orgs.mockImplementation(async () => {
      expect(window.location.search).toBe('')
      return [{ id: 'example-org', name: 'Example Org', role: 'collaborator' }]
    })
    await render()
    expect(mocks.verify).toHaveBeenCalledExactlyOnceWith('example-org', 'signed-state', 'one-use-code')
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Connect this Workspace to Example Org?')
    expect(host.textContent).toContain(
      'Session history stays in the original organization; connection settings are not transferred.'
    )
    expect(window.location.search).toBe('')
    expect(sessionStorage.getItem('ac.googleChatRecovery')).toBeNull()
    await act(async () => button('Recover connection').click())
    expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith('example-org', 'encrypted-ticket')
    expect(host.textContent).toContain('Google Chat is connected')
  })

  it('cancels without releasing the old connection', async () => {
    await render()
    await act(async () => button('Cancel').click())
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(window.location.assign).toHaveBeenCalledWith(`/googlechat/claim?state=${CLAIM}`)
  })

  it('rejects a mismatched OAuth return before any code exchange or confirmation', async () => {
    window.history.replaceState({}, '', '/googlechat/recover?state=other-state&code=one-use-code')
    await render()
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    expect(mocks.verify).not.toHaveBeenCalled()
    expect(mocks.confirm).not.toHaveBeenCalled()
  })
})
