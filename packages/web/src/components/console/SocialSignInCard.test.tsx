// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig, useSWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requestEmailVerification: vi.fn()
}))

// An explicit mock factory must export every name the module under test imports,
// or the import itself throws before render.
vi.mock('@/lib/api', () => ({
  fetchMySocialAccount: vi.fn(),
  resolveMySocialConnectorId: vi.fn(),
  unlinkMySocialIdentity: vi.fn()
}))

vi.mock('@/lib/auth', () => ({
  getAccountToken: vi.fn(),
  getLogtoPublicConfig: vi.fn(),
  initialsFrom: () => 'PZ'
}))

vi.mock('@/lib/logto-account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logto-account')>()
  return { ...actual, requestEmailVerification: mocks.requestEmailVerification }
})

import SocialSignInCard from './SocialSignInCard'
import { LogtoAccountError } from '@/lib/logto-account'
import { fetchMySocialAccount, resolveMySocialConnectorId } from '@/lib/api'

const ACCOUNT_KEY = 'logto-account-sign-in-methods'
let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function RevalidateAccount() {
  const { mutate } = useSWRConfig()
  return (
    <button type="button" onClick={() => void mutate(ACCOUNT_KEY)}>
      Revalidate account
    </button>
  )
}

async function renderCard({
  autoAuthorize,
  onAutoAuthorizeHandled = vi.fn()
}: {
  autoAuthorize?: { target: 'github'; purpose: 'link' }
  onAutoAuthorizeHandled?: () => void
} = {}) {
  const cache = new Map()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <SWRConfig
        value={{
          provider: () => cache,
          dedupingInterval: 0,
          errorRetryInterval: 1,
          shouldRetryOnError: true
        }}
      >
        <SocialSignInCard
          onNotice={vi.fn()}
          autoAuthorize={autoAuthorize}
          onAutoAuthorizeHandled={onAutoAuthorizeHandled}
        />
        <RevalidateAccount />
      </SWRConfig>
    )
  })
}

async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  throw new Error('Timed out waiting for the component state.')
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(container?.querySelectorAll('button') ?? []).find((candidate) => candidate.textContent === label)
}

beforeEach(() => {
  sessionStorage.clear()
  window.__AC_ENV = {}
  vi.mocked(fetchMySocialAccount).mockReset()
  mocks.requestEmailVerification.mockReset()
  vi.mocked(resolveMySocialConnectorId).mockReset()
  vi.mocked(resolveMySocialConnectorId).mockResolvedValue({ connectorId: 'connector' })
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

describe('SocialSignInCard account state', () => {
  it('offers configured Lark and Feishu identities through the shared link flow', async () => {
    window.__AC_ENV = { SOCIAL_PROVIDERS: 'lark,feishu' }
    vi.mocked(fetchMySocialAccount).mockResolvedValue({ identities: [], hasSecurityVerificationMethod: false })

    await renderCard()
    await waitUntil(() => container?.textContent?.includes('Not linked') === true)

    expect(container?.textContent).toContain('Lark')
    expect(container?.textContent).toContain('Feishu')
    expect(
      Array.from(container?.querySelectorAll('button') ?? []).filter((item) => item.textContent === 'Link')
    ).toHaveLength(2)
  })

  it('offers token renewal for an already linked regional identity', async () => {
    window.__AC_ENV = { SOCIAL_PROVIDERS: 'lark' }
    vi.mocked(fetchMySocialAccount).mockResolvedValue({
      identities: [{ target: 'lark', userId: 'lark-user', name: 'Phil Z' }],
      hasSecurityVerificationMethod: true,
      primaryEmail: 'phil@example.test'
    })

    await renderCard()
    await waitUntil(() => button('Reconnect') !== undefined)
    await act(async () => button('Reconnect')?.click())
    await waitUntil(() => vi.mocked(resolveMySocialConnectorId).mock.calls.length === 1)

    expect(resolveMySocialConnectorId).toHaveBeenCalledWith('lark')
    expect(container?.querySelector('[role="dialog"]')).toBeNull()
  })

  it('keeps a failed request idle and marks an explicit Retry as busy', async () => {
    vi.mocked(fetchMySocialAccount)
      .mockRejectedValueOnce(new LogtoAccountError('Unavailable', 500))
      .mockImplementationOnce(() => new Promise(() => {}))

    await renderCard()
    await waitUntil(() => container?.textContent?.includes('temporarily unavailable') === true)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25))
    })

    expect(vi.mocked(fetchMySocialAccount)).toHaveBeenCalledTimes(1)

    await act(async () => button('Retry')?.click())
    await waitUntil(() => vi.mocked(fetchMySocialAccount).mock.calls.length === 2)
    expect(container?.querySelector('[aria-busy]')?.getAttribute('aria-busy')).toBe('true')
  })

  it('keeps static providers but hides cached identity details and actions after a refresh fails', async () => {
    vi.mocked(fetchMySocialAccount)
      .mockResolvedValueOnce({
        identities: [{ target: 'github', userId: 'github-user', name: 'Phil Z', email: 'zfy0701@gmail.com' }],
        hasSecurityVerificationMethod: false
      })
      .mockRejectedValueOnce(new LogtoAccountError('Unavailable', 500))

    await renderCard()
    await waitUntil(() => container?.textContent?.includes('Phil Z') === true)

    await act(async () => button('Revalidate account')?.click())
    await waitUntil(() => container?.textContent?.includes('temporarily unavailable') === true)

    expect(container?.textContent).toContain('GitHub')
    expect(container?.textContent).toContain('Google')
    expect(container?.textContent).not.toContain('Phil Z')
    expect(container?.textContent).not.toContain('zfy0701@gmail.com')
    expect(container?.textContent).not.toContain('Not linked')
    expect(button('Link')).toBeUndefined()
    expect(button('Unlink')).toBeUndefined()
  })

  // Logto rejects an identity change the caller has not re-proven (403), and the
  // proof has to be collected BEFORE leaving for the provider — on return the
  // identity is saved immediately, with no UI left to ask in.
  it('proves account ownership before leaving for the provider', async () => {
    vi.mocked(fetchMySocialAccount).mockResolvedValue({
      identities: [],
      hasSecurityVerificationMethod: true,
      primaryEmail: 'phil@example.test'
    })
    mocks.requestEmailVerification.mockResolvedValue('current-verification')

    await renderCard()
    await waitUntil(() => container?.textContent?.includes('Not linked') === true)

    await act(async () => button('Link')?.click())

    expect(container?.textContent).toContain('phil@example.test')
    expect(container?.querySelector('[role="dialog"]')).not.toBeNull()
    // The provider round trip must not have started yet.
    expect(resolveMySocialConnectorId).not.toHaveBeenCalled()
  })

  it('goes straight to the provider when the account has nothing to re-prove', async () => {
    vi.mocked(fetchMySocialAccount).mockResolvedValue({ identities: [], hasSecurityVerificationMethod: false })

    await renderCard()
    await waitUntil(() => container?.textContent?.includes('Not linked') === true)

    await act(async () => button('Link')?.click())

    expect(container?.querySelector('[role="dialog"]')).toBeNull()
    expect(resolveMySocialConnectorId).toHaveBeenCalled()
  })

  it('continues a verified install through linking only when GitHub is unlinked', async () => {
    vi.mocked(fetchMySocialAccount).mockResolvedValue({ identities: [], hasSecurityVerificationMethod: false })
    const onAutoAuthorizeHandled = vi.fn()

    await renderCard({ autoAuthorize: { target: 'github', purpose: 'link' }, onAutoAuthorizeHandled })
    await waitUntil(() => vi.mocked(resolveMySocialConnectorId).mock.calls.length === 1)

    expect(onAutoAuthorizeHandled).toHaveBeenCalledOnce()
  })

  it('does not reauthorize GitHub when the installed app user already linked it', async () => {
    vi.mocked(fetchMySocialAccount).mockResolvedValue({
      identities: [{ target: 'github', userId: 'github-user', name: 'Phil Z' }],
      hasSecurityVerificationMethod: false
    })
    const onAutoAuthorizeHandled = vi.fn()

    await renderCard({ autoAuthorize: { target: 'github', purpose: 'link' }, onAutoAuthorizeHandled })
    await waitUntil(() => onAutoAuthorizeHandled.mock.calls.length === 1)

    expect(resolveMySocialConnectorId).not.toHaveBeenCalled()
  })

  it('skips the code dialog for a second link while the ownership proof is fresh', async () => {
    vi.mocked(fetchMySocialAccount).mockResolvedValue({
      identities: [],
      hasSecurityVerificationMethod: true,
      primaryEmail: 'phil@example.test'
    })
    // Standing in for a code entered moments ago on the first link.
    sessionStorage.setItem(
      'ac.social-link.proof',
      JSON.stringify({ recordId: 'proof-1', expiresAt: new Date(Date.now() + 9 * 60_000).toISOString() })
    )

    await renderCard()
    await waitUntil(() => container?.textContent?.includes('Not linked') === true)

    await act(async () => button('Link')?.click())

    expect(container?.querySelector('[role="dialog"]')).toBeNull()
    expect(resolveMySocialConnectorId).toHaveBeenCalled()
  })
})
