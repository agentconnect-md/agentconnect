// @vitest-environment happy-dom
/**
 * The GitLab card sits under Code hosts beside the GitHub one, on every
 * deployment: availability is the card's own answer, read from the authenticated
 * API (gitlab-com-integration.md §18.3), not a console-side gate that would
 * decide before asking. This pins the mount.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ gitlabCard: vi.fn(() => <div data-gitlab-card />) }))

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: null }) }))
vi.mock('@/components/console/ModalProvider', () => ({ useModal: () => ({ openModal: vi.fn() }) }))
vi.mock('@/lib/org-context', () => {
  const orgs = { activeOrg: { id: 'org-1' }, myRole: 'owner', orgPath: (path: string) => path }
  return { useOrgs: () => orgs }
})
vi.mock('@/lib/data-context', () => {
  const data = {
    bots: [],
    integrations: [],
    agents: [],
    loading: false,
    getAgent: () => null,
    setBotShareable: vi.fn(),
    setChannelAgent: vi.fn()
  }
  return { useConsoleData: () => data }
})
vi.mock('@/components/console/GitlabCard', () => ({ default: mocks.gitlabCard }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchGithubInstallations: vi.fn(async () => ({ enabled: false, installations: [] })),
  fetchGithubInstallUrl: vi.fn(async () => null),
  syncGithubInstallations: vi.fn(async () => [])
}))

const IntegrationsView = (await import('./IntegrationsView')).default

async function render(): Promise<string> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  await act(async () => {
    root.render(<IntegrationsView />)
  })
  const html = host.innerHTML
  await act(async () => root.unmount())
  host.remove()
  return html
}

afterEach(() => {
  mocks.gitlabCard.mockClear()
})

describe('IntegrationsView, GitLab card', () => {
  it('mounts the GitLab card on every deployment, GitHub App or not', async () => {
    expect(await render()).toContain('data-gitlab-card')
    expect(mocks.gitlabCard).toHaveBeenCalled()
  })
})
