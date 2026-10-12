// @vitest-environment happy-dom
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
    caps: { platforms: [], runtimes: ['claude'], acp: true, features: [], strategies: { host: { available: true } } },
    runtimeModels: [{ runtime: 'claude', version: '2.0.0', models: ['model-host'] }],
    mcpServers: []
  }
}))

vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1', defaultAgentVisibility: 'all' }, orgPath: (p: string) => `/example${p}` })
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

const chatActions = () => host!.querySelector<HTMLButtonElement>('button[aria-label="What people can do in chat"]')!
const create = () => [...host!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Create')!

it('lets people in chat also approve tool calls by default', async () => {
  await open()
  expect(chatActions().textContent).toBe('Talk and approve tool calls')
  await act(async () => create().click())
  await vi.waitFor(() => expect(mocks.createAgent).toHaveBeenCalled())
  expect(mocks.createAgent.mock.calls[0]![0]).toMatchObject({ chatActions: 'approve' })
})

it('creates the agent with the level picked', async () => {
  await open()
  await act(async () => chatActions().click())
  const talk = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
    (option) => option.textContent === 'Talk to the agent'
  )!
  await act(async () => talk.click())
  await act(async () => create().click())
  await vi.waitFor(() => expect(mocks.createAgent).toHaveBeenCalled())
  expect(mocks.createAgent.mock.calls[0]![0]).toMatchObject({ chatActions: 'talk' })
})
