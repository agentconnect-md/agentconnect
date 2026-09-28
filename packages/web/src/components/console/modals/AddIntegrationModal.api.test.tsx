// @vitest-environment happy-dom
// The API tile adds one chat protocol per entry; a protocol already added, or not yet offered, cannot be picked.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  entries: [] as unknown[],
  addAgentApi: vi.fn(async () => ({ protocol: 'ai-sdk-ui', createdBy: null, createdAt: '2026-09-01T00:00:00.000Z' }))
}))

vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: null }) }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, orgPath: (path: string) => path })
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    bots: [],
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
  fetchAgentHooks: vi.fn(async () => []),
  fetchAgentRepos: vi.fn(async () => []),
  fetchAgentInstallations: vi.fn(async () => []),
  fetchGithubInstallations: vi.fn(async () => ({ enabled: false, installations: [] })),
  fetchAgentApiEntries: vi.fn(async () => mocks.entries),
  addAgentApi: mocks.addAgentApi
}))

const AddIntegrationModal = (await import('./AddIntegrationModal')).default

const agent = {
  id: 'agent-a',
  name: 'docs',
  daemon: '—',
  placementKind: 'daemon',
  canEdit: true,
  workspace: { mode: 'scratch', files: [] }
} as unknown as Agent

let root: Root | undefined
let host: HTMLDivElement | undefined
const onClose = vi.fn()

async function render(): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <AddIntegrationModal agent={agent} initialPlatform="api" onClose={onClose} />
      </SWRConfig>
    )
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

const addButton = () => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Add API'))!
const protocol = (label: string) =>
  [...document.querySelectorAll('[role="radio"]')].find((r) => r.textContent?.includes(label))!

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.entries = []
  mocks.addAgentApi.mockClear()
  onClose.mockClear()
})

describe('AddIntegrationModal, API', () => {
  it('lists API in the Workflow group and adds the picked protocol', async () => {
    await render()
    const workflow = document.querySelector('section[aria-label="Workflow"]')
    expect(workflow?.textContent).toContain('API')
    expect(protocol('AI SDK UI').getAttribute('aria-checked')).toBe('true')
    expect(protocol('ACP 2').getAttribute('aria-disabled')).toBe('true')
    await act(async () => {
      addButton().click()
    })
    expect(mocks.addAgentApi).toHaveBeenCalledWith('agent-a', 'ai-sdk-ui')
    expect(onClose).toHaveBeenCalled()
  })

  it('marks a protocol the agent already has and adds nothing', async () => {
    mocks.entries = [{ protocol: 'ai-sdk-ui', createdBy: null, createdAt: '2026-09-01T00:00:00.000Z' }]
    await render()
    expect(protocol('AI SDK UI').textContent).toContain('Added')
    expect(protocol('AI SDK UI').getAttribute('aria-disabled')).toBe('true')
    await act(async () => {
      addButton().click()
    })
    expect(mocks.addAgentApi).not.toHaveBeenCalled()
  })
})
