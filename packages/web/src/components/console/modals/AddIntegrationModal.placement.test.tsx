// @vitest-environment happy-dom
/**
 * The wizard's platform tiles are gated on the adapters the agent's PLACEMENT advertises. A set
 * placement names no member, so resolving `Agent.daemon` as a daemon id found nothing and read as
 * "no daemon yet" — which offered a pool agent every chat platform, including ones its own members
 * cannot serve. Resolved through `agentCapabilitySource`, one serving member answers for the set.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent, DaemonRow } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  daemons: [] as unknown[],
  memberSets: [] as unknown[]
}))

vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: null }) }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, orgPath: (path: string) => path })
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    bots: [],
    daemons: mocks.daemons,
    daemonsLoading: false,
    memberSets: mocks.memberSets,
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
  fetchGithubInstallations: vi.fn(async () => ({ enabled: false, installations: [] })),
  fetchGithubInstallUrl: vi.fn(async () => null),
  fetchGitlabProjects: vi.fn(async () => []),
  fetchGitlabConnections: vi.fn(async () => ({ enabled: false, connections: [] })),
  searchGitlabProjects: vi.fn(async () => ({ projects: [], nextPage: null }))
}))

const AddIntegrationModal = (await import('./AddIntegrationModal')).default

/** A daemon advertising exactly the chat adapters named. */
function daemon(over: Partial<DaemonRow>): DaemonRow {
  return {
    daemonId: 'd1',
    pool: false,
    memberSetId: null,
    name: 'edge-1',
    status: 'online',
    caps: { platforms: ['slack'], runtimes: ['claude'], acp: true, features: [] },
    runtimeModels: [],
    mcpServers: [],
    ...over
  } as unknown as DaemonRow
}

const agent = {
  id: 'agent-a',
  name: 'pilot',
  daemon: 'pool',
  placementKind: 'set',
  setId: null,
  canEdit: true,
  workspace: { mode: 'scratch', files: [] }
} as unknown as Agent

let root: Root | undefined
let host: HTMLDivElement | undefined

/** Every tile by label, with the greyed-out treatment it carries. */
function tileStates(): Record<string, boolean> {
  return Object.fromEntries(
    [...document.querySelectorAll<HTMLDivElement>('.ptile')].map((tile) => [
      (tile.textContent ?? '').trim(),
      tile.getAttribute('aria-disabled') === 'true'
    ])
  )
}

async function render(over: Record<string, unknown> = {}): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<AddIntegrationModal agent={{ ...agent, ...over } as unknown as Agent} onClose={() => undefined} />)
  })
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  mocks.daemons = []
  mocks.memberSets = []
})

describe('AddIntegrationModal, platform tiles by placement', () => {
  it("greys out a platform the POOL's members do not advertise", async () => {
    mocks.daemons = [daemon({ daemonId: 'pod-1', pool: true })]
    await render()
    const tiles = tileStates()
    expect(tiles['Slack']).toBe(false)
    expect(tiles['Telegram']).toBe(true)
    // Relay/CP-backed triggers ride no daemon adapter, so they stay selectable.
    expect(tiles['Webhook']).toBe(false)
    expect(tiles['GitHub']).toBe(false)
  })

  it('reads a GROUP placement through one of its members', async () => {
    mocks.memberSets = [{ setId: 'g1', name: 'lab', memberDaemonIds: ['lab-1'], agentCount: 1 }]
    mocks.daemons = [
      daemon({
        daemonId: 'lab-1',
        memberSetId: 'g1',
        caps: { platforms: ['telegram'], runtimes: [], acp: true, features: [] }
      })
    ]
    await render({ daemon: 'set:g1', setId: 'g1' })
    const tiles = tileStates()
    expect(tiles['Telegram']).toBe(false)
    expect(tiles['Slack']).toBe(true)
  })

  it('keeps every platform selectable for an UNPLACED agent', async () => {
    await render({ daemon: '—', placementKind: 'daemon' })
    expect(Object.values(tileStates()).every((disabled) => !disabled)).toBe(true)
  })

  it('gates a single machine on its own adapters', async () => {
    mocks.daemons = [daemon({})]
    await render({ daemon: 'd1', placementKind: 'daemon' })
    const tiles = tileStates()
    expect(tiles['Slack']).toBe(false)
    expect(tiles['Telegram']).toBe(true)
  })
})
