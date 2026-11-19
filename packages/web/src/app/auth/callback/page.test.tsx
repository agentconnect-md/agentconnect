// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  completeLogin: vi.fn(),
  currentSubject: vi.fn(),
  fetchOrgs: vi.fn(),
  forgetRememberedOrganization: vi.fn(),
  joinOrganizationsBySso: vi.fn(),
  refreshMySocialIdentities: vi.fn(),
  reportOrgSsoTest: vi.fn(),
  replace: vi.fn()
}))
// The page tells a refusal apart by the error's class and code; the module mock below replaces the real class.
const ApiError = vi.hoisted(
  () =>
    class ApiError extends Error {
      constructor(
        message: string,
        readonly status: number,
        readonly code?: string,
        readonly details?: Record<string, unknown>
      ) {
        super(message)
      }
    }
)

vi.mock('@/lib/auth', () => ({
  completeLogin: mocks.completeLogin,
  currentSubject: mocks.currentSubject,
  forgetRememberedOrganization: mocks.forgetRememberedOrganization,
  getUser: async () => ({ name: 'Dana', email: 'dana@acme.example', initials: 'D' }),
  isAuthConfigured: () => true,
  redirectExpiredSession: vi.fn()
}))
vi.mock('@/lib/api', () => ({
  ApiError,
  fetchOrgs: mocks.fetchOrgs,
  joinOrganizationsBySso: mocks.joinOrganizationsBySso,
  refreshMySocialIdentities: mocks.refreshMySocialIdentities,
  reportOrgSsoTest: mocks.reportOrgSsoTest
}))
vi.mock('@/lib/activation-handshake', () => ({ promoteActivationProof: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }))

let host: HTMLDivElement
let root: Root

// The page lands once per load, so each case loads it afresh.
async function land(search: string) {
  vi.resetModules()
  window.history.replaceState(null, '', `/auth/callback${search}`)
  const { default: AuthCallback } = await import('./page')
  await act(async () => root.render(<AuthCallback />))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const stashTest = () =>
  sessionStorage.setItem(
    'ac.ssoTest',
    JSON.stringify({
      nonce: 'nonce-1',
      returnTo: '/acme/settings#single-sign-on',
      expiresAt: new Date(Date.now() + 600_000).toISOString()
    })
  )

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  sessionStorage.clear()
  localStorage.clear()
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.completeLogin.mockResolvedValue(undefined)
  mocks.refreshMySocialIdentities.mockResolvedValue(undefined)
  mocks.joinOrganizationsBySso.mockResolvedValue([])
  mocks.currentSubject.mockResolvedValue('subject-1')
  mocks.fetchOrgs.mockResolvedValue([{ id: 'org-1', slug: 'acme' }])
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  delete window.__AC_ENV
})

it('joins the organizations a sign-in earns before entering the console', async () => {
  window.__AC_ENV = { ORGANIZATION_SSO: 'true' }
  sessionStorage.setItem('ac.returnTo', '/acme/home')
  await land('?code=abc')
  expect(mocks.joinOrganizationsBySso).toHaveBeenCalledTimes(1)
  expect(mocks.replace).toHaveBeenCalledWith('/acme/home')
})

it('does not ask to join where organizations own no connections', async () => {
  await land('?code=abc')
  expect(mocks.joinOrganizationsBySso).not.toHaveBeenCalled()
  expect(mocks.replace).toHaveBeenCalledWith('/')
})

it('presents the nonce of a test sign-in and shows that it passed', async () => {
  window.__AC_ENV = { ORGANIZATION_SSO: 'true' }
  stashTest()
  mocks.reportOrgSsoTest.mockResolvedValue(true)
  await land('?code=abc')
  expect(mocks.reportOrgSsoTest).toHaveBeenCalledWith('nonce-1', expect.anything())
  expect(mocks.joinOrganizationsBySso).not.toHaveBeenCalled()
  expect(host.textContent).toContain('Sign-in test passed')
  expect(host.textContent).toContain('dana@acme.example')
  expect(sessionStorage.getItem('ac.ssoTest')).toBeNull()

  await act(async () => host.querySelector('button')!.click())
  expect(mocks.replace).toHaveBeenCalledWith('/acme/settings#single-sign-on')
})

it('forgets the remembered organization once a test sign-in completes', async () => {
  stashTest()
  mocks.reportOrgSsoTest.mockResolvedValue(true)
  await land('?code=abc')
  expect(mocks.forgetRememberedOrganization).toHaveBeenCalledTimes(1)
  expect(host.textContent).toContain('Back to Settings')
})

it('forgets the remembered organization once an ordinary sign-in completes', async () => {
  await land('?code=abc')
  expect(mocks.forgetRememberedOrganization).toHaveBeenCalledTimes(1)
})

it('keeps the remembered organization when the provider refused the sign-in', async () => {
  stashTest()
  await land('?error=invalid_client')
  expect(mocks.forgetRememberedOrganization).not.toHaveBeenCalled()
})

it('offers the console instead of Settings when the landed account is not a member', async () => {
  stashTest()
  mocks.fetchOrgs.mockResolvedValue([{ id: 'org-2', slug: 'other' }])
  mocks.reportOrgSsoTest.mockResolvedValue(true)
  await land('?code=abc')
  const button = host.querySelector('button')!
  expect(button.textContent).toBe('Open the console')
  await act(async () => button.click())
  expect(mocks.replace).toHaveBeenCalledWith('/')
})

it('shows what the identity provider answered when a test sign-in fails', async () => {
  stashTest()
  await land('?error=invalid_client&error_description=Client%20authentication%20failed')
  expect(mocks.completeLogin).not.toHaveBeenCalled()
  expect(host.textContent).toContain('Sign-in test failed')
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('invalid_client: Client authentication failed')
})

it('fails the test when the sign-in did not come through the connection', async () => {
  stashTest()
  mocks.reportOrgSsoTest.mockResolvedValue(false)
  await land('?code=abc')
  expect(host.textContent).toContain('Sign-in test failed')
  expect(host.textContent).toContain('could not be matched to the test.')
})

it('says the provider returned no usable address when the landed account is refused', async () => {
  stashTest()
  mocks.reportOrgSsoTest.mockRejectedValue(
    new ApiError('no address', 403, 'SSO_ADDRESS_REQUIRED', {
      code: 'SSO_ADDRESS_REQUIRED',
      details: { attributes: ['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn', 'displayName', 7] }
    })
  )
  await land('?code=abc')
  expect(host.textContent).toContain('Sign-in test failed')
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'The identity provider returned no email address in this organization'
  )
  expect(host.textContent).toContain('Attributes the provider sent')
  expect([...host.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn',
    'displayName'
  ])
})

it('puts the attributes carrying an in-domain address first, marked', async () => {
  stashTest()
  const claim = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'
  mocks.reportOrgSsoTest.mockRejectedValue(
    new ApiError('no address', 403, 'SSO_ADDRESS_REQUIRED', {
      code: 'SSO_ADDRESS_REQUIRED',
      details: { attributes: ['email', 'givenname', claim], addressAttributes: [claim] }
    })
  )
  await land('?code=abc')
  const items = [...host.querySelectorAll('li')]
  expect(items.map((li) => li.firstChild?.textContent)).toEqual([claim, 'email', 'givenname'])
  expect(items[0]?.textContent).toContain('Address in your domains')
  expect(host.querySelectorAll('.badge')).toHaveLength(1)
})

it('shows no attribute list for a refusal that is not about the address', async () => {
  stashTest()
  mocks.reportOrgSsoTest.mockRejectedValue(
    new ApiError('this account has no linked sign-in identity', 403, 'SIGN_IN_IDENTITY_REQUIRED')
  )
  await land('?code=abc')
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('this account has no linked sign-in identity')
  expect(host.querySelector('li')).toBeNull()
})

it('keeps reporting a cancelled sign-in', async () => {
  await land('?error=access_denied')
  expect(mocks.completeLogin).not.toHaveBeenCalled()
  expect(host.textContent).toContain('Sign-in was cancelled or could not finish.')
})
