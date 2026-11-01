// @vitest-environment happy-dom
// A GitHub App switch from Edit workspace reloads the picker with that App's installations, and Sync re-pulls that App.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GithubInstallationDto } from '@/lib/api'
import type { Agent } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const installation = (over: Partial<GithubInstallationDto>): GithubInstallationDto => ({
  id: 'inst-row',
  installationId: 12345,
  accountLogin: 'acme',
  accountType: 'Organization',
  repositorySelection: 'all',
  suspended: false,
  permissionsStatus: 'current',
  pullRequestsPermission: 'write',
  checksPermission: 'write',
  settingsUrl: 'https://github.example.test/settings/installations/12345',
  createdAt: '2026-09-01T00:00:00.000Z',
  ...over
})

const mocks = vi.hoisted(() => ({
  fetchGithubInstallations: vi.fn(),
  syncGithubInstallations: vi.fn(),
  onSwitched: undefined as ((githubAppId: string | null) => void) | undefined
}))

vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (path: string) => path, myRole: 'owner' }) }))
vi.mock('@/lib/data-context', () => ({ useConsoleData: () => ({ orgSetIds: new Set<string>() }) }))
vi.mock('@/components/console/GithubAppDialog', () => ({
  useAgentGithubAppDialog: (_agent: unknown, _initial: unknown, onSwitched: (githubAppId: string | null) => void) => {
    mocks.onSwitched = onSwitched
    return { appSlug: null, openDialog: () => undefined, dialog: null }
  }
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchGithubInstallations: mocks.fetchGithubInstallations,
  syncGithubInstallations: mocks.syncGithubInstallations,
  fetchGithubInstallUrl: vi.fn(async () => null),
  fetchGithubRepoRoster: vi.fn(async () => ({ repos: [], privateReposHidden: false, failed: false }))
}))

import EditWorkspaceModal from './EditWorkspaceModal'

const agent = {
  id: 'agent-a',
  name: 'build-agent',
  canEdit: true,
  githubAppId: null,
  workspace: { mode: 'scratch' }
} as unknown as Agent

let root: Root | undefined
let host: HTMLDivElement | undefined

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.fetchGithubInstallations.mockReset()
  mocks.syncGithubInstallations.mockReset()
})

describe('EditWorkspaceModal after a GitHub App switch', () => {
  it("reloads the new App's installations and syncs that App", async () => {
    mocks.fetchGithubInstallations.mockImplementation(async (_org: unknown, appId: string | null) => ({
      enabled: true,
      installations: appId === 'app-own' ? [] : [installation({ id: 'inst-builtin' })]
    }))
    mocks.syncGithubInstallations.mockResolvedValue([installation({ id: 'inst-own', installationId: 43 })])
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(
        <EditWorkspaceModal
          agent={agent}
          authorized={[]}
          installationGrants={[]}
          onInstallationGrantsChange={() => undefined}
          onClose={() => undefined}
          onChanged={() => undefined}
        />
      )
    })
    expect(mocks.fetchGithubInstallations).toHaveBeenLastCalledWith(undefined, null)

    await act(async () => mocks.onSwitched?.('app-own'))
    expect(mocks.fetchGithubInstallations).toHaveBeenLastCalledWith(undefined, 'app-own')

    // The new App has no installation yet: installing it and syncing re-pulls that App, not the built-in one.
    const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    await act(async () =>
      buttons()
        .find((b) => b.textContent?.trim() === 'GitHub')
        ?.click()
    )
    await act(async () =>
      buttons()
        .find((b) => /sync/i.test(b.textContent ?? ''))
        ?.click()
    )
    expect(mocks.syncGithubInstallations).toHaveBeenCalledWith('app-own')
  })

  it('opens the repository editor on the App the agent switched to', async () => {
    mocks.fetchGithubInstallations.mockResolvedValue({ enabled: true, installations: [installation({})] })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root?.render(
        <EditWorkspaceModal
          agent={agent}
          authorized={[]}
          installationGrants={[]}
          onInstallationGrantsChange={() => undefined}
          onClose={() => undefined}
          onChanged={() => undefined}
        />
      )
    })
    await act(async () => mocks.onSwitched?.('app-own'))
    const ofNewApp = () => mocks.fetchGithubInstallations.mock.calls.filter(([, appId]) => appId === 'app-own').length
    const before = ofNewApp()

    await act(async () =>
      Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find((b) => b.textContent?.includes('Authorize repository'))
        ?.click()
    )

    // The nested editor probes the new App's installations, not the built-in App's.
    expect(ofNewApp()).toBe(before + 1)
    expect(mocks.fetchGithubInstallations).toHaveBeenLastCalledWith(undefined, 'app-own')
  })
})
