// @vitest-environment happy-dom
/** The organization's own GitHub Apps on the Integrations page: who uses each, where it is installed, and deleting only a free one. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GithubOrgAppDto } from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  apps: [] as GithubOrgAppDto[],
  syncGithubApp: vi.fn(async () => undefined),
  deleteGithubApp: vi.fn(async () => undefined)
}))

vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ activeOrg: { id: 'org-1' } }) }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchGithubApps: vi.fn(async () => mocks.apps),
  syncGithubApp: mocks.syncGithubApp,
  deleteGithubApp: mocks.deleteGithubApp
}))

const { GithubOrgApps } = await import('./GithubOrgApps')

const app = (over: Partial<GithubOrgAppDto>): GithubOrgAppDto => ({
  id: 'app-1',
  appId: 2001,
  slug: 'review-example',
  botUserId: 9001,
  agentId: null,
  installations: [],
  createdAt: '2026-10-20T00:00:00.000Z',
  ...over
})

let root: Root | undefined
let host: HTMLDivElement | undefined

async function render(props: { isOwner?: boolean; canWrite?: boolean } = {}) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <GithubOrgApps
          canWrite={props.canWrite ?? true}
          isOwner={props.isOwner ?? true}
          agentNameOf={(id) => (id === 'agent-1' ? 'Reviewer' : undefined)}
        />
      </SWRConfig>
    )
  })
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  return host
}

const row = (slug: string) => document.querySelector<HTMLElement>(`[data-org-app="${slug}"]`)

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.syncGithubApp.mockClear()
  mocks.deleteGithubApp.mockClear()
})

describe('GithubOrgApps', () => {
  it('renders nothing while the organization has no App of its own', async () => {
    mocks.apps = []
    const scope = await render()
    expect(scope.textContent).toBe('')
  })

  it('names the agent using an App, links the App, and lists where it is installed', async () => {
    mocks.apps = [
      app({
        id: 'app-used',
        slug: 'review-private',
        agentId: 'agent-1',
        installations: [
          {
            id: 'i1',
            installationId: 43,
            accountLogin: 'example-org',
            accountType: 'Organization',
            repositorySelection: 'all',
            suspended: false
          }
        ]
      }),
      app({ id: 'app-free', slug: 'triage-example', agentId: null })
    ]
    await render()

    const used = row('review-private')!
    expect(used.textContent).toContain('used by Reviewer')
    expect(used.textContent).toContain('example-org')
    expect(used.querySelector('a')?.getAttribute('href')).toBe('https://github.com/apps/review-private')
    // An App an agent uses can't be deleted, so it has no menu.
    expect(used.querySelector('button[aria-label="More"]')).toBeNull()

    const free = row('triage-example')!
    expect(free.textContent).toContain('free')
    expect(free.textContent).toContain('not installed')
    expect(free.querySelector('button[aria-label="More"]')).not.toBeNull()
  })

  it('syncs one App, and deletes a free one after confirming', async () => {
    mocks.apps = [app({ id: 'app-free', slug: 'triage-example' })]
    await render()

    await act(async () => row('triage-example')!.querySelector<HTMLButtonElement>('button[aria-label="Sync"]')!.click())
    expect(mocks.syncGithubApp).toHaveBeenCalledWith('app-free')

    await act(async () => row('triage-example')!.querySelector<HTMLButtonElement>('button[aria-label="More"]')!.click())
    const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) =>
      b.textContent?.includes('Delete App')
    )
    await act(async () => item!.click())
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'Delete'
    )
    await act(async () => confirm!.click())
    expect(mocks.deleteGithubApp).toHaveBeenCalledWith('app-free')
  })

  it('offers no controls to a viewer', async () => {
    mocks.apps = [app({ id: 'app-free', slug: 'triage-example' })]
    await render({ canWrite: false, isOwner: false })
    expect(row('triage-example')!.querySelector('button, a[aria-label]')).toBeNull()
  })
})
