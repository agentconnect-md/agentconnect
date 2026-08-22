// @vitest-environment happy-dom
/**
 * GitLab is a standing switch, not an experiment: a deployment with no GitLab
 * application must not merely hide the card, it must never mount it — mounting
 * runs the connection probe, and a console that probes a route this deployment
 * does not serve is asking a question it has no business asking. The gate is
 * therefore on the element, not inside the card, and this is its regression test.
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

const setFlags = (value?: string) => {
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV =
    value === undefined ? {} : { FEATURE_FLAGS: value }
}

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
  setFlags()
  mocks.gitlabCard.mockClear()
})

describe('IntegrationsView, GitLab flag', () => {
  it('mounts the GitLab card only where the flag is on', async () => {
    setFlags()
    expect(await render()).not.toContain('data-gitlab-card')
    expect(mocks.gitlabCard).not.toHaveBeenCalled()

    setFlags('gitlab')
    expect(await render()).toContain('data-gitlab-card')
    expect(mocks.gitlabCard).toHaveBeenCalled()
  })
})
