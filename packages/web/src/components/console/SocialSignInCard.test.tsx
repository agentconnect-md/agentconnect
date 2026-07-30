// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig, useSWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetchAccountProfile: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  createMySocialIdentityAuthorization: vi.fn(),
  unlinkMySocialIdentity: vi.fn()
}))

vi.mock('@/lib/auth', () => ({
  getAccountToken: vi.fn(),
  getLogtoPublicConfig: vi.fn(),
  initialsFrom: () => 'PZ'
}))

vi.mock('@/lib/logto-account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logto-account')>()
  return { ...actual, fetchAccountProfile: mocks.fetchAccountProfile }
})

import SocialSignInCard from './SocialSignInCard'
import { LogtoAccountError } from '@/lib/logto-account'

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

async function renderCard() {
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
        <SocialSignInCard onNotice={vi.fn()} />
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
  mocks.fetchAccountProfile.mockReset()
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

describe('SocialSignInCard account state', () => {
  it('keeps a failed request idle and marks an explicit Retry as busy', async () => {
    mocks.fetchAccountProfile
      .mockRejectedValueOnce(new LogtoAccountError('Unavailable', 500))
      .mockImplementationOnce(() => new Promise(() => {}))

    await renderCard()
    await waitUntil(() => container?.textContent?.includes('temporarily unavailable') === true)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25))
    })

    expect(mocks.fetchAccountProfile).toHaveBeenCalledTimes(1)

    await act(async () => button('Retry')?.click())
    await waitUntil(() => mocks.fetchAccountProfile.mock.calls.length === 2)
    expect(container?.querySelector('[aria-busy]')?.getAttribute('aria-busy')).toBe('true')
  })

  it('keeps static providers but hides cached identity details and actions after a refresh fails', async () => {
    mocks.fetchAccountProfile
      .mockResolvedValueOnce({
        identities: {
          github: {
            userId: 'github-user',
            details: { name: 'Phil Z', email: 'zfy0701@gmail.com' }
          }
        }
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
})
