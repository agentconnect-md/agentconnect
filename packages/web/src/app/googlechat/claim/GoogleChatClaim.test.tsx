// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  class FakeApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code?: string
    ) {
      super(message)
    }
  }
  return {
    FakeApiError,
    authConfigured: true,
    user: { sub: 'logto-subject' } as unknown,
    orgs: [] as unknown[],
    fetchOrgs: vi.fn(),
    claim: vi.fn(),
    login: vi.fn()
  }
})

vi.mock('@/lib/auth', () => ({
  isAuthConfigured: () => mocks.authConfigured,
  getUser: () => Promise.resolve(mocks.user),
  login: mocks.login
}))
vi.mock('@/lib/api', () => ({
  ApiError: mocks.FakeApiError,
  fetchOrgs: mocks.fetchOrgs,
  claimGoogleChatCustomer: mocks.claim
}))

import GoogleChatClaim from './GoogleChatClaim'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const REDIRECT = 'https://chat.google.com/api/config_complete_redirect?token=synthetic'
const STATE = Buffer.from(
  JSON.stringify({
    v: 1,
    app: '123456789012',
    space: 'spaces/AAAAexample',
    user: 'users/100000000000000000009',
    kind: 'space',
    tenant: 'customers/C0000000000',
    redirect: REDIRECT,
    iat: 1_790_000_000
  })
).toString('base64url')

const org = (id: string, role: 'owner' | 'collaborator' | 'viewer', name: string) => ({ id, slug: id, name, role })

let root: Root
let host: HTMLElement

beforeEach(() => {
  vi.clearAllMocks()
  mocks.authConfigured = true
  mocks.user = { sub: 'logto-subject' }
  mocks.orgs = [org('org-viewer', 'viewer', 'Read Only'), org('org-edit', 'collaborator', 'Example Org')]
  mocks.fetchOrgs.mockImplementation(async () => mocks.orgs)
  sessionStorage.clear()
  window.history.replaceState({}, '', `/googlechat/claim?state=${STATE}`)
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

async function render() {
  await act(async () => root.render(<GoogleChatClaim />))
}

const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label)!

describe('GoogleChatClaim', () => {
  it('shows the Chat account, the app, and the conversation, and offers only editable organizations', async () => {
    await render()

    expect(host.textContent).toContain('Connect Google Chat')
    expect(host.textContent).toContain('users/100000000000000000009')
    expect(host.textContent).toContain('123456789012')
    expect(host.textContent).toContain('Space spaces/AAAAexample')
    const options = [...host.querySelectorAll('option')].map((o) => o.textContent)
    expect(options).toEqual(['Example Org'])
  })

  it('posts the state for the chosen organization and returns the browser to Chat', async () => {
    mocks.claim.mockResolvedValue({ redirect: REDIRECT })
    await render()

    await act(async () => button('Connect').click())
    expect(mocks.claim).toHaveBeenCalledWith('org-edit', STATE)
    expect(window.location.assign).toHaveBeenCalledWith(REDIRECT)
  })

  it('maps a refusal to a plain sentence', async () => {
    mocks.claim.mockRejectedValue(new mocks.FakeApiError('taken', 409, 'GOOGLE_CHAT_CLAIM_TAKEN'))
    await render()

    await act(async () => button('Connect').click())
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'Your Google Workspace is already connected to another organization.'
    )
    expect(window.location.assign).not.toHaveBeenCalled()
  })

  it('never follows a redirect off Chat’s origin', async () => {
    mocks.claim.mockResolvedValue({ redirect: 'https://console.example.test/elsewhere' })
    await render()

    await act(async () => button('Connect').click())
    expect(window.location.assign).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Google Chat could not be connected.')
  })

  it('leads a person with no editable organization to create one', async () => {
    mocks.orgs = [org('org-viewer', 'viewer', 'Read Only')]
    await render()

    const create = host.querySelector('a[href="/welcome?new=1"]')
    expect(create?.textContent).toBe('Create an organization')
    expect(button('Connect').disabled).toBe(true)
    mocks.orgs = [org('org-new', 'owner', 'New Org')]
    await act(async () => button('Refresh').click())
    expect([...host.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['New Org'])
  })

  it('signs a signed-out visitor in with Google and comes back here', async () => {
    mocks.user = null
    await render()

    expect(mocks.login).toHaveBeenCalledWith('google')
    expect(sessionStorage.getItem('ac.returnTo')).toBe(`/googlechat/claim?state=${STATE}`)
    expect(mocks.fetchOrgs).not.toHaveBeenCalled()
  })

  it('refuses a link without a valid state', async () => {
    window.history.replaceState({}, '', '/googlechat/claim?state=broken')
    await render()

    expect(host.textContent).toContain('Link unavailable')
    expect(mocks.fetchOrgs).not.toHaveBeenCalled()
  })
})
