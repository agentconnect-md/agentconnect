import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect ${url}`)
  }),
  env: {} as Record<string, string | undefined>
}))

vi.mock('next/navigation', () => ({ redirect: mocks.redirect, useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/lib/public-env', () => ({ resolvePublicEnv: async () => mocks.env }))

import SsoLoginPage from './page'

const configured = { LOGTO_ENDPOINT: 'https://auth.example.test', LOGTO_APP_ID: 'console' }

afterEach(() => {
  mocks.redirect.mockClear()
  vi.unstubAllEnvs()
})

it('sends the visitor to /login when organization SSO is off', async () => {
  mocks.env = { ...configured }
  await expect(SsoLoginPage()).rejects.toThrow('redirect /login')
})

it('sends the visitor to /login when sign-in is not configured', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOGTO_ENDPOINT', '')
  vi.stubEnv('NEXT_PUBLIC_LOGTO_APP_ID', '')
  mocks.env = { ORGANIZATION_SSO: 'true' }
  await expect(SsoLoginPage()).rejects.toThrow('redirect /login')
})

it('renders the SSO page when organizations own their connections', async () => {
  mocks.env = { ...configured, ORGANIZATION_SSO: 'true' }
  await expect(SsoLoginPage()).resolves.toBeTruthy()
  expect(mocks.redirect).not.toHaveBeenCalled()
})
