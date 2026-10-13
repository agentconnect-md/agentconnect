// @vitest-environment happy-dom
// A new agent's form preselects the runtime's auto mode, else its full-access one, and an asking mode stays a choice.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

type Catalog = { permissionModes: { value: string }[]; defaultPermissionMode?: string }

const mocks = vi.hoisted(() => ({
  createAgent: vi.fn(async (_input: Record<string, unknown>) => undefined),
  daemon: {
    daemonId: 'd1',
    pool: false,
    memberSetId: null,
    name: 'edge-1',
    status: 'online',
    caps: { platforms: [], runtimes: ['claude'], acp: true, features: [], strategies: { host: { available: true } } },
    runtimeModels: [] as unknown[],
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

/** The daemon reports one runtime, with or without the catalog its probe discovered. */
function runtime(id: string, catalog?: Catalog) {
  mocks.daemon.caps.runtimes = [id]
  mocks.daemon.runtimeModels = [
    {
      runtime: id,
      version: '1.0.0',
      models: ['model-host'],
      ...(catalog
        ? {
            modelCatalog: {
              source: 'acp',
              observedAt: '2026-10-01T00:00:00.000Z',
              models: [{ id: 'model-host', efforts: [], fastMode: false }],
              ...catalog
            }
          }
        : {})
    }
  ]
}

beforeEach(() => runtime('claude'))

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

async function created(): Promise<Record<string, unknown>> {
  const create = [...host!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Create')!
  await act(async () => create.click())
  await vi.waitFor(() => expect(mocks.createAgent).toHaveBeenCalled())
  return mocks.createAgent.mock.calls.at(-1)![0]
}

const approval = () => document.querySelector<HTMLSelectElement>('select[aria-label="Approval"]')

async function openRunSettings() {
  await act(async () => host!.querySelector<HTMLButtonElement>('button[aria-label="Provider and model"]')!.click())
}

it.each([
  ['Claude Code', 'claude', 'auto'],
  ['Codex', 'codex', 'agent']
])('preselects %s’s auto mode before its catalog is known', async (_label, id, mode) => {
  runtime(id)
  await open()
  expect(await created()).toMatchObject({ permissionMode: mode })
})

it.each([
  [
    'its auto mode',
    'codex',
    ['read-only', 'workspace-write', 'agent', 'agent-full-access'],
    'workspace-write',
    'agent'
  ],
  [
    'its full-access mode without an auto one',
    'claude',
    ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
    'default',
    'bypassPermissions'
  ],
  ['the mode it always did with neither', 'claude', ['default', 'plan'], 'default', 'default']
])('preselects %s from the runtime’s catalog', async (_label, id, modes, defaultMode, expected) => {
  runtime(id, { permissionModes: modes.map((value) => ({ value })), defaultPermissionMode: defaultMode })
  await open()
  await openRunSettings()
  expect(approval()?.value).toBe(expected)
  expect(await created()).toMatchObject({ permissionMode: expected })
})

it('creates the agent with an asking mode when one is picked', async () => {
  await open()
  await openRunSettings()
  const select = approval()!
  expect(select.value).toBe('auto')
  expect([...select.options].map((option) => option.textContent)).toContain('Manual')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'default')
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(await created()).toMatchObject({ permissionMode: 'default' })
})
