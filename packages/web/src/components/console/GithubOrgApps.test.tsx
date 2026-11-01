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
  deleteGithubApp: vi.fn(async () => undefined),
  uninstallGithubInstallation: vi.fn(async () => undefined)
}))

const orgs = vi.hoisted(() => ({ activeOrg: { id: 'org-1' }, orgPath: (path: string) => `/acme${path}` }))
const agents = vi.hoisted(() => ({
  getAgent: (id: string) =>
    id === 'agent-1' ? { id, name: 'reviewer', displayName: 'Reviewer', icon: null, runtime: 'codex' } : undefined
}))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => orgs }))
vi.mock('@/lib/data-context', () => ({ useConsoleData: () => agents }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchGithubApps: vi.fn(async () => mocks.apps),
  deleteGithubApp: mocks.deleteGithubApp,
  uninstallGithubInstallation: mocks.uninstallGithubInstallation
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
        <GithubOrgApps canWrite={props.canWrite ?? true} isOwner={props.isOwner ?? true} />
      </SWRConfig>
    )
  })
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  return host
}

const row = (slug: string) => document.querySelector<HTMLElement>(`[data-org-app="${slug}"]`)
const expand = (slug: string) =>
  act(async () => row(slug)!.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click())
const labelled = (slug: string, label: string) =>
  row(slug)!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.deleteGithubApp.mockClear()
  mocks.uninstallGithubInstallation.mockClear()
})

describe('GithubOrgApps', () => {
  it('renders nothing while the organization has no App of its own', async () => {
    mocks.apps = []
    const scope = await render()
    expect(scope.textContent).toBe('')
  })

  it('names the agent using an App, links it, and lists its installations once expanded', async () => {
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
    // The agent using the App leads its row and names it, both linking to the agent.
    expect(used.querySelector('a[title="Open Reviewer"]')?.getAttribute('href')).toBe('/acme/agents/agent-1')
    expect(used.querySelector('a.badge')?.textContent).toBe('Reviewer')
    expect(used.querySelector('a.mono')?.getAttribute('href')).toBe('https://github.com/apps/review-private')
    // Installations are the second level: collapsed until the App row is expanded.
    expect(used.textContent).not.toContain('example-org')
    await expand('review-private')
    expect(used.textContent).toContain('example-org')
    expect(used.textContent).toContain('all repositories')
    // Row actions are icons; an App an agent uses can't be deleted.
    expect(labelled('review-private', 'Install on GitHub')).not.toBeNull()
    expect(labelled('review-private', 'Delete App…')).toBeNull()

    const free = row('triage-example')!
    expect(free.textContent).toContain('free')
    await expand('triage-example')
    expect(free.textContent).toContain('Not installed on any account yet.')
  })

  it('deletes a free App from its trash button after confirming', async () => {
    mocks.apps = [app({ id: 'app-free', slug: 'triage-example' })]
    await render()

    await act(async () => labelled('triage-example', 'Delete App…')!.click())
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'Delete'
    )
    await act(async () => confirm!.click())
    expect(mocks.deleteGithubApp).toHaveBeenCalledWith('app-free')
  })

  it('lets an owner uninstall an organization App from one account after confirming', async () => {
    mocks.apps = [
      app({
        id: 'app-used',
        slug: 'review-private',
        agentId: 'agent-1',
        installations: [
          {
            id: 'row-43',
            installationId: 43,
            accountLogin: 'example-org',
            accountType: 'Organization',
            repositorySelection: 'all',
            suspended: false
          }
        ]
      })
    ]
    await render()
    await expand('review-private')

    await act(async () => labelled('review-private', 'Uninstall')!.click())
    expect(document.body.textContent).toContain('example-org')
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('.modal button')].find(
      (b) => b.textContent?.trim() === 'Uninstall'
    )
    await act(async () => confirm!.click())
    expect(mocks.uninstallGithubInstallation).toHaveBeenCalledWith('row-43')
  })

  it('keeps a suspended installation in the list, marked suspended', async () => {
    mocks.apps = [
      app({
        id: 'app-paused',
        slug: 'paused-example',
        installations: [
          {
            id: 'i2',
            installationId: 44,
            accountLogin: 'example-org',
            accountType: 'Organization',
            repositorySelection: 'all',
            suspended: true
          }
        ]
      })
    ]
    await render()
    await expand('paused-example')

    const paused = row('paused-example')!
    expect(paused.textContent).toContain('example-org')
    expect(paused.textContent).toContain('suspended')
    expect(paused.textContent).not.toContain('not installed')
  })

  it('lets a viewer expand an App but offers no install or delete', async () => {
    mocks.apps = [app({ id: 'app-free', slug: 'triage-example' })]
    await render({ canWrite: false, isOwner: false })
    expect(labelled('triage-example', 'Install on GitHub')).toBeNull()
    expect(labelled('triage-example', 'Delete App…')).toBeNull()
    expect(labelled('triage-example', 'Uninstall')).toBeNull()
    expect(row('triage-example')!.querySelector('button[aria-expanded]')).not.toBeNull()
  })
})
