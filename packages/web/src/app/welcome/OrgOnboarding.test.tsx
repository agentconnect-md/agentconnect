// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  class FakeApiError extends Error {
    constructor(readonly status: number) {
      super(`http ${status}`)
    }
  }
  return {
    FakeApiError,
    replace: vi.fn(),
    authConfigured: true,
    user: null as unknown,
    access: {} as Record<string, unknown>,
    createOrg: vi.fn()
  }
})

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }))
vi.mock('@/lib/auth', () => ({
  isAuthConfigured: () => mocks.authConfigured,
  getUser: () => Promise.resolve(mocks.user)
}))
vi.mock('@/lib/api', () => ({
  ApiError: mocks.FakeApiError,
  getMyAccess: () => Promise.resolve(mocks.access),
  createOrg: mocks.createOrg
}))
vi.mock('@/lib/org-context', () => ({ orgUrlPrefix: () => 'console.example.test/' }))

import OrgOnboarding from './OrgOnboarding'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

const render = async () => {
  host = document.createElement('div')
  root = createRoot(host)
  await act(async () => root.render(<OrgOnboarding />))
}

const slugInput = () => host.querySelector<HTMLInputElement>('input.mono')!
const createButton = () => [...host.querySelectorAll('button')].find((b) => /Continue/.test(b.textContent!))!

const type = async (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  mocks.replace.mockReset()
  mocks.createOrg.mockReset()
  mocks.authConfigured = true
  mocks.user = { sub: 'u1' }
  mocks.access = { waitlistMode: false, status: 'active', activated: true, orgCount: 0, email: null }
})

afterEach(async () => {
  await act(async () => root.unmount())
})

describe('org onboarding — who belongs here', () => {
  it('sends a no-auth install back to the console: its seeded org needs no onboarding', async () => {
    mocks.authConfigured = false
    await render()
    expect(mocks.replace).toHaveBeenCalledWith('/')
  })

  it('sends a signed-out visitor to sign in', async () => {
    mocks.user = null
    await render()
    expect(mocks.replace).toHaveBeenCalledWith('/login')
  })

  it('sends a not-yet-admitted user to the waitlist, ahead of any org question', async () => {
    mocks.access = { waitlistMode: true, status: 'none', activated: false, orgCount: 0, email: 'a@b.test' }
    await render()
    expect(mocks.replace).toHaveBeenCalledWith('/waitlist')
  })

  it('sends someone who already belongs to an org back to the console', async () => {
    mocks.access = { waitlistMode: false, status: 'active', activated: true, orgCount: 1, email: null }
    await render()
    expect(mocks.replace).toHaveBeenCalledWith('/')
  })

  it('renders step 1 for an admitted user with no org, and continues into the org wizard', async () => {
    mocks.createOrg.mockResolvedValue({ id: 'org_1', slug: 'acme' })
    await render()
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Step 1 of 2')
    expect(host.textContent).toContain('Create your organization')

    await type(slugInput(), 'acme')
    await act(async () => createButton().click())

    expect(mocks.createOrg).toHaveBeenCalledWith({ slug: 'acme', name: undefined })
    expect(mocks.replace).toHaveBeenCalledWith('/acme/onboarding')
  })

  it('?new=1 lets someone who already has orgs create another instead of bouncing', async () => {
    window.history.replaceState(null, '', '/welcome?new=1')
    mocks.access = { waitlistMode: false, status: 'active', activated: true, orgCount: 2, email: null }
    mocks.createOrg.mockResolvedValue({ id: 'org_2', slug: 'second' })
    await render()
    expect(mocks.replace).not.toHaveBeenCalled()
    // A deliberate extra-org visit gets a way back to the console.
    const back = [...host.querySelectorAll('button')].find((b) => /Back/.test(b.textContent!))!
    expect(back).toBeTruthy()

    await type(slugInput(), 'second')
    await act(async () => createButton().click())
    expect(mocks.replace).toHaveBeenCalledWith('/second/onboarding')
    window.history.replaceState(null, '', '/welcome')
  })

  it('refuses an empty or malformed URL name without calling the CP', async () => {
    await render()
    await act(async () => createButton().click())
    expect(mocks.createOrg).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Enter a URL name.')

    await type(slugInput(), '-nope-')
    await act(async () => createButton().click())
    expect(mocks.createOrg).not.toHaveBeenCalled()
    expect(host.textContent).toContain('lowercase letters, digits, and hyphens')
  })

  it('names the collision when the URL name is taken', async () => {
    mocks.createOrg.mockRejectedValue(new mocks.FakeApiError(409))
    await render()
    await type(slugInput(), 'taken')
    await act(async () => createButton().click())
    expect(host.textContent).toContain('That URL name is already taken.')
    expect(mocks.replace).not.toHaveBeenCalled()
  })
})
