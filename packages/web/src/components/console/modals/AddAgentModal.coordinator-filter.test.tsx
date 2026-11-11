// @vitest-environment happy-dom
// auto-session-mode.md §4.7: a new agent takes its coordinator filter from the providers of the placement chosen.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createAgent: vi.fn(async (_input: Record<string, unknown>) => undefined),
  daemon: {
    daemonId: 'd1',
    pool: false,
    memberSetId: null,
    name: 'edge-1',
    status: 'online',
    caps: {
      platforms: [],
      runtimes: ['claude'],
      acp: true,
      features: ['coordinator-filter-v1'],
      strategies: { host: { available: true } }
    },
    runtimeModels: [{ runtime: 'claude', version: '2.0.0', models: ['model-host'] }],
    mcpServers: []
  }
}))

vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1', defaultAgentVisibility: 'all' }, orgPath: (p: string) => `/example${p}` })
}))
vi.mock('@/lib/decisions/provider', () => ({
  useDecisionProviders: () => ({
    providers: [
      {
        id: 'typesafe',
        daemonId: 'd1',
        name: 'TypeSafe',
        kind: 'typesafe',
        source: 'byok',
        readiness: { status: 'ready' },
        models: [{ id: 'jev-1.13.0', label: 'Jev 1.13', questionTypes: ['boolean', 'choice', 'score'] }]
      }
    ],
    daemonId: 'd1',
    error: null
  }),
  useOptionalDecisionsPrototype: () => undefined
}))
vi.mock('@/lib/use-daemon-detail', () => ({ useDaemonDetail: (row: unknown) => row }))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: { id: 'user-1' } }) }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    createAgent: mocks.createAgent,
    daemons: [mocks.daemon],
    agents: [],
    members: [],
    memberSets: [],
    orgSetIds: new Set<string>()
  })
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
// The form's background lookups stay pending; nothing here depends on them.
vi.stubGlobal(
  'fetch',
  vi.fn(() => new Promise<Response>(() => undefined))
)

const AddAgentModal = (await import('./AddAgentModal')).default

let root: Root | undefined
let host: HTMLDivElement | undefined

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  mocks.createAgent.mockClear()
})

async function open() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<AddAgentModal onClose={() => undefined} />))
  const name = host.querySelector<HTMLInputElement>('input.inp.mn')!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(name, 'example-agent')
    name.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const create = () => [...host!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Create')!
const dialogButtons = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]

it('creates the agent with the filter picked under the Coordinator tab, named Jev', async () => {
  await open()
  await act(async () => host!.querySelector<HTMLButtonElement>('button[aria-label="Provider and model"]')!.click())
  await act(async () =>
    dialogButtons()
      .find((b) => b.textContent === 'Coordinator')!
      .click()
  )
  const jev = dialogButtons().find((b) => b.textContent === 'Jev1')
  expect(jev).toBeDefined()
  await act(async () => jev!.click())
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Jev · Jev 1.13"]')!.click())
  await act(async () => create().click())
  await vi.waitFor(() => expect(mocks.createAgent).toHaveBeenCalled())
  expect(mocks.createAgent.mock.calls[0]![0]).toMatchObject({
    coordinatorFilter: { providerId: 'typesafe', model: 'jev-1.13.0' }
  })
})

it('sends no filter when none is picked', async () => {
  await open()
  await act(async () => create().click())
  await vi.waitFor(() => expect(mocks.createAgent).toHaveBeenCalled())
  expect(mocks.createAgent.mock.calls[0]![0]).not.toHaveProperty('coordinatorFilter')
})
