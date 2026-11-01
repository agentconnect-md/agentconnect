// @vitest-environment happy-dom
/** The GitHub card's one Sync re-pulls every App's installations, the built-in App's and each organization App's. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GithubInstallationDto, GithubOrgAppDto } from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const installation = (over: Partial<GithubInstallationDto>): GithubInstallationDto => ({
  id: 'inst-1',
  installationId: 42,
  accountLogin: 'example-org',
  accountType: 'Organization',
  repositorySelection: 'all',
  suspended: false,
  permissionsStatus: 'current',
  pullRequestsPermission: 'write',
  checksPermission: 'write',
  settingsUrl: 'https://github.example.test/settings/installations/42',
  createdAt: '2026-10-01T00:00:00.000Z',
  ...over
})

const orgApp = (id: string, slug: string): GithubOrgAppDto => ({
  id,
  appId: 2001,
  slug,
  botUserId: 9001,
  agentId: null,
  installations: [],
  createdAt: '2026-10-20T00:00:00.000Z'
})

const mocks = vi.hoisted(() => ({
  syncGithubInstallations: vi.fn(),
  syncGithubApp: vi.fn()
}))

// The real hook returns a stable org; a fresh object per render would re-run the card's fetch forever.
const orgs = vi.hoisted(() => ({ activeOrg: { id: 'org-1' } }))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => orgs }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchGithubInstallations: vi.fn(async () => ({ enabled: true, installations: [installation({})] })),
  fetchBuiltinGithubAppSlug: vi.fn(async () => 'example-connect'),
  fetchGithubApps: vi.fn(async () => [orgApp('app-a', 'review-example'), orgApp('app-b', 'triage-example')]),
  syncGithubInstallations: mocks.syncGithubInstallations,
  syncGithubApp: mocks.syncGithubApp
}))

const GithubCard = (await import('./GithubCard')).default

let root: Root | undefined
let host: HTMLDivElement | undefined

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.syncGithubInstallations.mockReset()
  mocks.syncGithubApp.mockReset()
})

async function render() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <GithubCard canWrite isOwner />
      </SWRConfig>
    )
  })
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  return host
}

describe('GithubCard', () => {
  it('syncs the built-in App and every organization App from one Sync, reporting a failure without stopping the rest', async () => {
    mocks.syncGithubInstallations.mockResolvedValue([installation({ id: 'inst-2', accountLogin: 'second-org' })])
    mocks.syncGithubApp.mockImplementation(async (id: string) => {
      if (id === 'app-b') throw new Error('the private key of this App is missing')
    })
    const scope = await render()
    // No column header row: each App row speaks for itself.
    expect(scope.textContent).not.toContain('Installations')

    const sync = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Sync')
    await act(async () => sync!.click())

    expect(mocks.syncGithubInstallations).toHaveBeenCalledTimes(1)
    expect(mocks.syncGithubApp.mock.calls.map(([id]) => id)).toEqual(['app-a', 'app-b'])
    expect(scope.textContent).toContain('second-org')
    expect(scope.textContent).toContain('the private key of this App is missing')
  })
})
