// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://console.example.test/share/tok","settings":{"enableIframePageLoading":true,"navigation":{"disableChildFrameNavigation":true}}}

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SharedArtifactDto } from '@/lib/artifact'

const api = vi.hoisted(() => ({ read: vi.fn() }))
const auth = vi.hoisted(() => ({ configured: true, user: null as { email?: string } | null, reset: vi.fn() }))
const flow = vi.hoisted(() => ({ write: vi.fn() }))
const nav = vi.hoisted(() => ({ replace: vi.fn() }))
const bytes = vi.hoisted(() => ({ fetch: vi.fn() }))

vi.mock(import('@/lib/api'), async (importOriginal) => ({ ...(await importOriginal()), readSharedArtifact: api.read }))
vi.mock('@/lib/auth', () => ({
  isAuthConfigured: () => auth.configured,
  getUser: async () => auth.user,
  resetSession: auth.reset
}))
vi.mock('@/lib/flow-state', () => ({ writeFlowState: flow.write }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: nav.replace, push: vi.fn() }) }))
vi.mock('@/lib/artifact-download', () => ({
  sharedFileUrl: (token: string) => `shared:${token}`,
  fetchArtifactFile: bytes.fetch,
  downloadArtifactFiles: vi.fn()
}))

import { ApiError } from '@/lib/api'
import { SharedArtifactPage } from './SharedArtifactPage'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const ID = '0b6d1d55-5f43-4c8e-9a51-2f0a8f5b1c3d'
const DOMAIN = 'content.example.test'

function shared(entry: string, mediaType: string, audience: 'public' | 'org' = 'public'): SharedArtifactDto {
  const files = [{ path: entry, mediaType, sha256: '0'.repeat(64), bytes: 12 }]
  return {
    artifactId: ID,
    title: 'Launch plan',
    audience,
    organization: { name: 'Example Org' },
    sharedAt: '2026-11-20T10:00:00.000Z',
    revision: {
      number: 4,
      entry,
      entryMediaType: mediaType,
      fileCount: 1,
      totalBytes: 12,
      createdAt: '2026-11-19T10:00:00.000Z',
      manifest: { entry, files }
    }
  }
}

let container: HTMLDivElement
let root: Root

async function settle() {
  for (let i = 0; i < 6; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
}

async function render(token = 'tok') {
  await act(async () => root.render(<SharedArtifactPage token={token} />))
  await settle()
}

const state = () => container.querySelector('[data-share-state]')?.getAttribute('data-share-state')

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.__AC_ENV = { ARTIFACTS_CONTENT_DOMAIN: DOMAIN }
  auth.configured = true
  auth.user = null
  auth.reset.mockReset().mockResolvedValue('cleared')
  api.read.mockReset()
  flow.write.mockReset().mockReturnValue(true)
  nav.replace.mockReset()
  bytes.fetch.mockReset().mockImplementation(async (_url: unknown, file: { mediaType: string }) => {
    return new Blob(['step one\nstep two'], { type: file.mediaType })
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete window.__AC_ENV
})

describe('the share page', () => {
  it('shows a spinner while the link is read', async () => {
    api.read.mockReturnValue(new Promise(() => {}))
    await render()
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(api.read).toHaveBeenCalledWith('tok')
  })

  it('shows the artifact with the user-generated-content banner, read through the link', async () => {
    api.read.mockResolvedValue(shared('plan.txt', 'text/plain'))
    await render()
    expect(state()).toBe('ready')
    const banner = container.querySelector('[data-share-ugc-banner]')!
    expect(banner.textContent).toContain('Shared by Example Org.')
    expect(container.querySelector('h1')!.textContent).toBe('Launch plan')
    expect(container.textContent).toContain('Example Org·Revision 4·Shared Nov 20, 2026')
    expect(container.textContent).toContain('step one')
    expect(bytes.fetch).toHaveBeenCalledWith(
      'shared:tok',
      expect.objectContaining({ path: 'plan.txt' }),
      expect.anything()
    )
    expect(document.title).toBe('Launch plan')
    // Nothing of a session, conversation or workspace.
    expect(container.querySelector('nav')).toBeNull()
    expect(container.textContent).not.toMatch(/session|conversation|workspace/i)
  })

  it('keeps the banner on an organization link too', async () => {
    api.read.mockResolvedValue(shared('plan.txt', 'text/plain', 'org'))
    await render()
    expect(container.querySelector('[data-share-ugc-banner]')!.textContent).toContain('Example Org')
  })

  it('runs an HTML entry on its revision’s content-domain origin', async () => {
    api.read.mockResolvedValue(shared('index.html', 'text/html'))
    await render()
    const frame = container.querySelector('iframe')!
    expect(frame.getAttribute('src')).toBe(`https://a${ID.replaceAll('-', '')}r4.${DOMAIN}/__ac/shim`)
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin')
    expect(bytes.fetch).not.toHaveBeenCalled()
  })

  it.each([
    [new ApiError('gone', 410, 'ARTIFACT_SHARE_REVOKED'), 'revoked', 'This link has been revoked'],
    [new ApiError('no', 404, 'ARTIFACT_SHARE_NOT_FOUND'), 'notFound', 'This link doesn’t work'],
    [new ApiError('boom', 500), 'failed', 'This link couldn’t be opened']
  ])('answers %s with its own state', async (error, expected, title) => {
    api.read.mockRejectedValue(error)
    await render()
    expect(state()).toBe(expected)
    expect(container.querySelector('h1')!.textContent).toBe(title)
    expect(container.querySelector('[data-share-ugc-banner]')).toBeNull()
  })

  it('tells a signed-in non-member that only members can open it, and offers another account', async () => {
    auth.user = { email: 'sam@example.test' }
    api.read.mockRejectedValue(new ApiError('members', 404, 'ARTIFACT_SHARE_MEMBERS_ONLY'))
    await render()
    expect(state()).toBe('membersOnly')
    expect(container.textContent).toContain('sam@example.test isn’t one')
    const other = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Sign in with another account'
    )!
    await act(async () => other.click())
    await settle()
    expect(flow.write).toHaveBeenCalledWith('returnTo', '/share/tok')
    expect(auth.reset).toHaveBeenCalled()
    expect(nav.replace).toHaveBeenCalledWith('/login')
  })

  it('sends a signed-out visitor of an organization link through sign-in and back', async () => {
    api.read.mockRejectedValue(new ApiError('sign in', 401))
    await render()
    expect(state()).toBe('signIn')
    expect(flow.write).toHaveBeenCalledWith('returnTo', '/share/tok')
    expect(nav.replace).toHaveBeenCalledWith('/login')
  })

  it('reads nothing where artifacts are not enabled', async () => {
    delete window.__AC_ENV
    await render()
    expect(state()).toBe('notEnabled')
    expect(api.read).not.toHaveBeenCalled()
  })

  it('reads nothing for a token the server could never have minted', async () => {
    await render('not%2Fa-token')
    expect(state()).toBe('notFound')
    expect(api.read).not.toHaveBeenCalled()
  })
})
