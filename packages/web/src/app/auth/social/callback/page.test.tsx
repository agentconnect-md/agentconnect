// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  LogtoAccountError,
  saveSocialIdentity,
  takeSocialLinkFlow,
  verifySocialVerification,
  writeSocialLinkFlow
} from '@/lib/logto-account'
import {
  createMyGithubRepoAccessAuthorization,
  fetchMySocialAccount,
  linkMyGithubRepoAccess,
  linkMySocialIdentity,
  refreshMySocialIdentities
} from '@/lib/api'
import SocialAccountCallback from './page'

vi.mock('@/lib/api', () => ({
  createMyGithubRepoAccessAuthorization: vi.fn(),
  fetchMySocialAccount: vi.fn(),
  linkMyGithubRepoAccess: vi.fn(),
  linkMySocialIdentity: vi.fn(),
  refreshMySocialIdentities: vi.fn()
}))
vi.mock('@/lib/logto-account', async (original) => ({
  ...(await original<typeof import('@/lib/logto-account')>()),
  saveSocialIdentity: vi.fn(),
  verifySocialVerification: vi.fn()
}))
let root: Root
let container: HTMLDivElement
const returnTo = '/example-org/profile'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  window.history.replaceState({}, '', '/auth/social/callback?state=state&code=code')
  vi.spyOn(window.location, 'assign').mockImplementation(() => undefined)
  vi.spyOn(window.location, 'replace').mockImplementation(() => undefined)
  vi.mocked(linkMySocialIdentity).mockResolvedValue(undefined)
  vi.mocked(refreshMySocialIdentities).mockResolvedValue(undefined)
  vi.mocked(verifySocialVerification).mockResolvedValue('verified')
  vi.mocked(saveSocialIdentity).mockResolvedValue(undefined)
  vi.mocked(fetchMySocialAccount).mockResolvedValue({
    identities: [],
    hasSecurityVerificationMethod: false,
    githubRepoAccessAvailable: true
  })
  vi.mocked(createMyGithubRepoAccessAuthorization).mockResolvedValue({
    state: 'second-state',
    authorizationUri: 'https://github.com/login/oauth/authorize?state=second-state'
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

async function render(mode: 'direct' | 'verified' | 'repo-access' = 'direct', target = 'github') {
  writeSocialLinkFlow(
    mode === 'repo-access'
      ? { purpose: 'repo-access', state: 'state', providerName: 'GitHub', returnTo, createdAt: Date.now() }
      : {
          purpose: 'link',
          target,
          state: 'state',
          providerName: target,
          connectorId: 'connector',
          mode,
          verificationRecordId: 'verification',
          redirectUri: 'https://console.example.test/auth/social/callback',
          returnTo,
          createdAt: Date.now()
        }
  )
  await act(async () => root.render(<SocialAccountCallback />))
}

it('keeps a successful normal link on its existing path', async () => {
  await render()
  expect(linkMySocialIdentity).toHaveBeenCalledWith('connector', { state: 'state', code: 'code' })
  expect(refreshMySocialIdentities).toHaveBeenCalledOnce()
  expect(window.location.replace).toHaveBeenCalledWith(returnTo)
  expect(fetchMySocialAccount).not.toHaveBeenCalled()
  expect(createMyGithubRepoAccessAuthorization).not.toHaveBeenCalled()
})

it.each(['direct', 'verified'] as const)(
  'offers an explicit continuation only after a %s GitHub identity conflict',
  async (mode) => {
    const error = new LogtoAccountError('already in use', mode === 'direct' ? 409 : 422, 'user.identity_already_in_use')
    if (mode === 'direct') vi.mocked(linkMySocialIdentity).mockRejectedValueOnce(error)
    else vi.mocked(saveSocialIdentity).mockRejectedValueOnce(error)
    await render(mode)
    const button = [...container.querySelectorAll('button')].find(
      (item) => item.textContent === 'Continue for repository access'
    )!
    expect(button).toBeDefined()
    expect(window.location.assign).not.toHaveBeenCalled()
    expect(container.textContent).toContain('GitHub sign-in will still open the original account.')
    await act(async () => button.click())
    expect(createMyGithubRepoAccessAuthorization).toHaveBeenCalledOnce()
    expect(takeSocialLinkFlow()).toEqual({
      purpose: 'repo-access',
      providerName: 'GitHub',
      state: 'second-state',
      returnTo,
      createdAt: expect.any(Number)
    })
    expect(window.location.assign).toHaveBeenCalledOnce()
  }
)

it.each([
  ['github', 'unrelated_error', true],
  ['google', 'user.identity_already_in_use', true],
  ['github', 'user.identity_already_in_use', false]
])('does not offer repository authorization for %s / %s / configured=%s', async (target, code, configured) => {
  vi.mocked(linkMySocialIdentity).mockRejectedValueOnce(new LogtoAccountError('already in use', 409, String(code)))
  vi.mocked(fetchMySocialAccount).mockResolvedValue({
    identities: [],
    hasSecurityVerificationMethod: false,
    githubRepoAccessAvailable: Boolean(configured)
  })
  await render('direct', String(target))
  expect(container.textContent).not.toContain('Continue for repository access')
  expect(window.location.assign).not.toHaveBeenCalled()
})

it('completes repository access directly and never loops after a failure', async () => {
  vi.mocked(linkMyGithubRepoAccess).mockRejectedValueOnce(new Error('authorization failed'))
  await render('repo-access')
  expect(linkMyGithubRepoAccess).toHaveBeenCalledWith('code', 'state')
  expect(container.textContent).toContain('GitHub repository access could not be connected.')
  expect(fetchMySocialAccount).not.toHaveBeenCalled()
  expect(linkMySocialIdentity).not.toHaveBeenCalled()
  expect(createMyGithubRepoAccessAuthorization).not.toHaveBeenCalled()
})
