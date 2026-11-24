// @vitest-environment happy-dom
// Email is offered where its flag is on and the deployment answers a mail domain.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  mailDomain: null as string | null,
  checkEmailAddressName: vi.fn()
}))

vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: null }) }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, orgPath: (path: string) => path })
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    bots: [],
    members: [],
    daemons: [],
    daemonsLoading: false,
    memberSets: [],
    createIntegration: vi.fn(),
    createHook: vi.fn(),
    createGithubHook: vi.fn(),
    createGitlabHook: vi.fn(),
    refresh: vi.fn(),
    updateAgent: vi.fn()
  })
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  checkEmailAddressName: mocks.checkEmailAddressName,
  fetchSlackConfig: vi.fn(async () => ({ relayAvailable: true, relayPublicUrl: null })),
  fetchAgentHooks: vi.fn(async () => []),
  fetchAgentRepos: vi.fn(async () => []),
  fetchAgentInstallations: vi.fn(async () => []),
  fetchGithubInstallations: vi.fn(async () => ({ enabled: false, installations: [] })),
  fetchGithubInstallUrl: vi.fn(async () => null),
  fetchGitlabProjects: vi.fn(async () => []),
  fetchGitlabConnections: vi.fn(async () => ({ enabled: false, connections: [] })),
  searchGitlabProjects: vi.fn(async () => ({ projects: [], nextPage: null }))
}))

const AddIntegrationModal = (await import('./AddIntegrationModal')).default

const agent = {
  id: 'agent-a',
  name: 'pilot',
  daemon: '—',
  placementKind: 'daemon',
  canEdit: true,
  workspace: { mode: 'scratch', files: [] }
} as unknown as Agent

let root: Root | undefined
let host: HTMLDivElement | undefined

function tileLabels(): string[] {
  return [...document.querySelectorAll<HTMLDivElement>('.ptile')].map((tile) => (tile.textContent ?? '').trim())
}

async function render(flags: string, initialPlatform?: string): Promise<void> {
  window.__AC_ENV = { FEATURE_FLAGS: flags }
  mocks.checkEmailAddressName.mockImplementation(async () => ({
    mailDomain: mocks.mailDomain,
    address: null,
    available: false,
    reason: null
  }))
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <AddIntegrationModal agent={agent} initialPlatform={initialPlatform} onClose={() => undefined} />
      </SWRConfig>
    )
  })
  const more = [...document.querySelectorAll<HTMLButtonElement>('button.ptile')].find((b) => b.textContent === 'More')
  if (more) await act(async () => more.click())
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.mailDomain = null
  mocks.checkEmailAddressName.mockReset()
  window.__AC_ENV = undefined
})

describe('AddIntegrationModal, the Email tile', () => {
  it('stays out, without asking the deployment, where the email flag is off', async () => {
    mocks.mailDomain = 'mail.example.test'
    await render('')
    expect(tileLabels()).not.toContain('Email')
    expect(mocks.checkEmailAddressName).not.toHaveBeenCalled()
  })

  it('stays out where the deployment has no mail domain', async () => {
    await render('email')
    expect(mocks.checkEmailAddressName).toHaveBeenCalledWith('org-1')
    expect(tileLabels()).not.toContain('Email')
  })

  it('is selected when the caller asked for it, once its offer has been read', async () => {
    mocks.mailDomain = 'mail.example.test'
    await render('email', 'email')
    expect((document.querySelector('.ptile.on')?.textContent ?? '').trim()).toBe('Email')
  })

  it('is offered where the deployment has a mail domain', async () => {
    mocks.mailDomain = 'mail.example.test'
    await render('email')
    expect(tileLabels()).toContain('Email')
  })
})
