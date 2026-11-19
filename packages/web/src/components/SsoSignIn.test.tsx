// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ lookupSignIn: vi.fn(), loginWithSso: vi.fn() }))

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  lookupSignIn: mocks.lookupSignIn
}))
vi.mock('@/lib/auth', () => ({ isAuthConfigured: () => true, login: vi.fn(), loginWithSso: mocks.loginWithSso }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/i18n/actions', () => ({ setLocale: vi.fn() }))

import SsoSignIn from './SsoSignIn'
import { ApiError } from '@/lib/api'
import { commitPendingSignIn, readLastSignIn } from '@/lib/organization-sso'

let host: HTMLDivElement
let root: Root

const field = () => host.querySelector('input[type="email"]') as HTMLInputElement

async function render() {
  await act(async () => root.render(<SsoSignIn />))
}

async function submit(email: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), email)
    field().dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  localStorage.clear()
  sessionStorage.clear()
  for (const mock of Object.values(mocks)) mock.mockReset()
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('the SSO page', () => {
  it('asks for a work email and links back to the other options', async () => {
    await render()
    expect(host.querySelector('h1')!.textContent).toBe('Sign in with SSO')
    expect(host.querySelector('form label')!.textContent).toBe('Work email')
    expect(field().value).toBe('')
    const back = host.querySelector('a')!
    expect(back.textContent).toBe('Other sign-in options')
    expect(back.getAttribute('href')).toBe('/login')
  })

  it('prefills the address used last', async () => {
    localStorage.setItem('ac.lastSignIn', JSON.stringify({ method: 'email', email: 'dana@acme.example' }))
    await render()
    expect(field().value).toBe('dana@acme.example')
  })

  it('leaves for the connector the address signs in through and remembers the address', async () => {
    mocks.lookupSignIn.mockResolvedValue({ connectorId: 'connector-1' })
    await render()
    await submit(' dana@acme.example ')
    expect(mocks.lookupSignIn).toHaveBeenCalledWith('dana@acme.example', expect.anything())
    expect(mocks.loginWithSso).toHaveBeenCalledWith('connector-1', 'dana@acme.example')
    // The page is leaving: the field stays busy instead of offering another try.
    expect(field().readOnly).toBe(true)
    commitPendingSignIn()
    expect(readLastSignIn()).toEqual({ method: 'email', email: 'dana@acme.example' })
  })

  it('says when no single sign-on is set up for the address', async () => {
    mocks.lookupSignIn.mockResolvedValue(null)
    await render()
    await submit('dana@mail.example')
    expect(mocks.loginWithSso).not.toHaveBeenCalled()
    expect(host.querySelector('[role="status"]')?.textContent).toBe('No single sign-on is set up for this email.')
    expect(field().readOnly).toBe(false)
  })

  it('tells a rate limit from a failed lookup', async () => {
    mocks.lookupSignIn.mockRejectedValueOnce(new ApiError('slow down', 429))
    await render()
    await submit('dana@acme.example')
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Too many attempts. Try again in a minute.')

    mocks.lookupSignIn.mockRejectedValueOnce(new Error('offline'))
    await submit('dana@acme.example')
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Couldn't check this email. Try again.")
  })

  it('does not look up something that is not an address', async () => {
    await render()
    await submit('dana')
    expect(mocks.lookupSignIn).not.toHaveBeenCalled()
  })
})
