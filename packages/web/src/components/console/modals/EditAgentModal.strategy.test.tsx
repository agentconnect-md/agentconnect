// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, expect, it, vi } from 'vitest'
import type { Agent, DaemonRow } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const DECISION = '33333333-3333-4333-8333-333333333333'
const mocks = vi.hoisted(() => ({
  dto: {} as Record<string, unknown>,
  daemon: {} as unknown,
  agent: {} as unknown,
  updateAgent: vi.fn(async (_id: string, _patch: Record<string, unknown>) => undefined)
}))

vi.mock('@/lib/decisions/provider', () => ({
  useOptionalDecisionsPrototype: () => ({
    api: { mode: 'mock' },
    orgId: 'example-org',
    loading: false,
    error: null,
    decisions: [
      {
        id: '33333333-3333-4333-8333-333333333333',
        name: 'Complexity',
        question: { type: 'score', instructions: 'Rate complexity.', criteria: ['Simple', 'Moderate', 'Complex'] }
      }
    ]
  })
}))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1' }, myRole: 'owner', orgPath: (path: string) => path })
}))
vi.mock('@/components/console/ModalProvider', () => ({ useModal: () => ({ openModal: vi.fn() }) }))
vi.mock('@/lib/acp-registry', () => ({ useAcpRegistry: () => ({}), acpRuntime: () => undefined }))
vi.mock('@/lib/use-daemon-detail', () => ({ useDaemonDetail: (row: unknown) => row }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    updateAgent: mocks.updateAgent,
    moveAgent: vi.fn(),
    saveSharing: vi.fn(),
    saveAgentCallPolicy: vi.fn(),
    daemons: [mocks.daemon],
    agents: [mocks.agent],
    members: [],
    memberSets: [],
    memberSetsLoading: false,
    orgSetIds: new Set()
  })
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchAgentDto: vi.fn(async () => mocks.dto)
}))

const STRATEGIES = { host: { available: true }, microsandbox: { available: true } }

/** One daemon whose host install and image advertise different models for one runtime. */
mocks.daemon = {
  daemonId: 'd1',
  pool: false,
  memberSetId: null,
  name: 'edge-1',
  status: 'online',
  caps: { platforms: [], runtimes: ['claude'], acp: true, features: ['agent-move-v1'], strategies: STRATEGIES },
  runtimeModels: [
    {
      runtime: 'claude',
      version: '2.0.0',
      models: ['model-host'],
      strategies: {
        host: { available: true, models: ['model-host'], modelsSource: 'probed' },
        microsandbox: { available: true, models: ['model-image'], modelsSource: 'cached' }
      }
    }
  ],
  mcpServers: []
} as unknown as DaemonRow

const agent = {
  id: 'agent-1',
  name: 'pilot',
  model: 'model-host',
  runtime: 'claude',
  daemon: 'd1',
  placementKind: 'daemon',
  execution: 'host',
  strategies: STRATEGIES,
  outputMode: '—',
  showFooter: true,
  showStatusBar: false,
  fastMode: false,
  permissionMode: '',
  workspace: { mode: 'scratch', files: [] },
  integrations: [],
  visibility: 'org',
  sharedWith: [],
  callableBy: 'all',
  allowedCallerAgentIds: [],
  canCall: 'all',
  allowedTargetAgentIds: [],
  env: [],
  secretKeys: [],
  organizationVariables: [],
  organizationSecretKeys: [],
  hookKinds: []
} as unknown as Agent
mocks.agent = agent

const EditAgentModal = (await import('./EditAgentModal')).default

let root: Root | undefined
let host: HTMLDivElement | undefined

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  mocks.updateAgent.mockClear()
})

/** Open the form on an agent saved in `host`, switch it to the VM, and press Save. */
async function switchToVm(dto: Record<string, unknown>): Promise<HTMLButtonElement> {
  mocks.dto = {
    name: 'pilot',
    runtime: 'claude',
    daemonId: 'd1',
    execution: 'host',
    strategies: STRATEGIES,
    visibility: 'org',
    sharedWith: [],
    ...dto
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () =>
    root!.render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <EditAgentModal agent={agent} onClose={vi.fn()} />
      </SWRConfig>
    )
  )
  await vi.waitFor(() => expect(host!.querySelector('[aria-label="Execution strategy"]')).not.toBeNull())
  await act(async () => host!.querySelector<HTMLButtonElement>('[aria-label="Execution strategy"]')!.click())
  const vm = [...host!.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((row) => row.textContent === 'VM')!
  await act(async () => vm.click())
  const save = [...host!.querySelectorAll<HTMLButtonElement>('.modalfoot button')].at(-1)!
  await act(async () => save.click())
  return save
}

it('saves the model the VM’s catalog shows in place of a stored host model', async () => {
  await switchToVm({ model: 'model-host' })
  await vi.waitFor(() => expect(mocks.updateAgent).toHaveBeenCalled())
  expect(mocks.updateAgent.mock.calls[0]![1]).toMatchObject({ execution: 'microsandbox', model: 'model-image' })
})

it('holds Save while a Decision rule names a model the VM does not offer', async () => {
  const save = await switchToVm({
    model: 'model-host',
    modelSelection: {
      decisionId: DECISION,
      rules: [{ when: { type: 'score', min: 0, max: 2 }, runtime: 'claude', model: 'model-host' }]
    }
  })
  expect(save.disabled).toBe(true)
  expect(mocks.updateAgent).not.toHaveBeenCalled()
})
