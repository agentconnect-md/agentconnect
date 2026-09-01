// @vitest-environment happy-dom
/**
 * The wizard's "Shared bot" opt-in, per platform. It is a decision on Slack and a
 * non-decision on Linear: a Bot row there IS one connected workspace and the provider
 * stamps `shareable` itself (linear-integration.md §4.3), so the reuse path must admit
 * members WITHOUT the console offering a flag it has no business moving.
 *
 * Rendered here rather than asserted on the predicate alone, because "supports sharing"
 * and "offers a control for it" are the two facts that used to be one value.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BotDto } from '@/lib/api'
import type { Agent, DaemonRow } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({ bots: [] as BotDto[] }))

vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: null }) }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, orgPath: (path: string) => path })
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    get bots() {
      return mocks.bots
    },
    daemons: [
      {
        daemonId: 'd1',
        pool: false,
        memberSetId: null,
        name: 'edge-1',
        status: 'online',
        caps: { platforms: ['slack', 'linear'], runtimes: ['claude'], acp: true, features: [] },
        runtimeModels: [],
        mcpServers: []
      } as unknown as DaemonRow
    ],
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
  fetchSlackConfig: vi.fn(async () => ({
    configured: false,
    durable: false,
    funnelEnabled: false,
    autoAvailable: false,
    accessExpiresAt: null,
    relayAvailable: true,
    relayPublicUrl: 'https://relay.example.test',
    platformInstallAvailable: false,
    updatedAt: null
  })),
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
  daemon: 'd1',
  placementKind: 'daemon',
  setId: null,
  canEdit: true,
  workspace: { mode: 'scratch', files: [] }
} as unknown as Agent

/** A free, http, already-shared bot — what both platforms' reuse lists offer. */
function bot(over: Partial<BotDto>): BotDto {
  return {
    id: 'b1',
    name: 'workspace',
    platform: 'slack',
    prebuilt: false,
    slackAppId: null,
    discordAppId: null,
    createdBy: null,
    transport: 'http',
    shareable: true,
    inUseByAgentId: null,
    agentIds: [],
    lastUsedAt: null,
    freedFromAgent: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over
  }
}

let root: Root | undefined
let host: HTMLDivElement | undefined

const clickByText = async (selector: string, text: string) => {
  const found = [...document.querySelectorAll<HTMLElement>(selector)].find((el) => el.textContent?.includes(text))
  if (!found) throw new Error(`no ${selector} containing "${text}"`)
  await act(async () => found.click())
}

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** Open the wizard on `tile` and switch it to the reuse path. */
async function reusePane(tile: string): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<AddIntegrationModal agent={agent} onClose={() => undefined} />)
  })
  await settle()
  await clickByText('.ptile', tile)
  await clickByText('.ptile', 'Use an existing bot')
  await settle()
}

const shareOptIn = () =>
  [...document.querySelectorAll<HTMLLabelElement>('label')].find((l) => l.textContent?.includes('Shared bot'))

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.bots = []
})

describe('the wizard’s Shared bot opt-in', () => {
  it('is not offered for a Linear workspace, which is shared structurally', async () => {
    mocks.bots = [bot({ id: 'ws-1', platform: 'linear', name: 'Example Workspace' })]
    await reusePane('Linear')

    // The workspace is still offered for reuse — membership is the whole point.
    expect(document.body.textContent).toContain('Example Workspace')
    expect(shareOptIn()).toBeUndefined()
  })

  it('is still offered for Slack, unchanged', async () => {
    mocks.bots = [bot({ id: 'sl-1', platform: 'slack' })]
    await reusePane('Slack')

    const optIn = shareOptIn()
    expect(optIn).toBeDefined()
    expect(optIn?.textContent).toContain('This bot is already shared.')
  })
})
