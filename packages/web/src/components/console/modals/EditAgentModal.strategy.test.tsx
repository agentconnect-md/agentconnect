// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, expect, it, vi } from 'vitest'
import type { Agent, DaemonRow } from '@/lib/data'
import { fetchProviderKeys } from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const DECISION = '33333333-3333-4333-8333-333333333333'
const mocks = vi.hoisted(() => ({
  dto: {} as Record<string, unknown>,
  daemon: {} as unknown,
  agent: {} as unknown,
  providers: [] as string[],
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
  fetchProviderKeys: vi.fn(async () => mocks.providers.map((provider) => ({ provider, configured: true }))),
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
const daemon = mocks.daemon as DaemonRow

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
  mocks.providers = []
  mocks.daemon = daemon
})

async function openEditor(dto: Record<string, unknown>) {
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
      <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
        <EditAgentModal agent={agent} onClose={vi.fn()} />
      </SWRConfig>
    )
  )
  await vi.waitFor(() => expect(host!.querySelector('[aria-label="Execution strategy"]')).not.toBeNull())
}

// Open the form on an agent saved in host, switch it to the VM, and press Save.
async function switchToVm(dto: Record<string, unknown>): Promise<HTMLButtonElement> {
  await openEditor(dto)
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

const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
const saveButton = () => [...host!.querySelectorAll<HTMLButtonElement>('.modalfoot button')].at(-1)!

async function chooseCredentials(saved: boolean) {
  await act(async () => button('Credentials').click())
  const options = [...host!.querySelectorAll<HTMLButtonElement>('[role="option"]')]
  expect(options.map((option) => option.textContent)).toEqual(['Daemon credentials', 'Use saved credential (Beta)'])
  await act(async () => options[saved ? 1 : 0]!.click())
}

it('offers two credential sources, filters models by saved keys and restores daemon choices', async () => {
  mocks.providers = ['anthropic', 'typesafe']
  mocks.daemon = {
    ...daemon,
    runtimeModels: [
      { runtime: 'claude', models: ['model-host'], authRequired: true },
      { runtime: 'codex', models: ['gpt-5'] },
      { runtime: 'opencode', models: ['anthropic/claude-sonnet-4', 'openai/gpt-5', 'openrouter/other'] }
    ]
  }
  await openEditor({ model: 'model-host' })
  expect(button('Credentials').textContent).toBe('Daemon credentials')
  await chooseCredentials(true)
  await vi.waitFor(() => expect(saveButton().disabled).toBe(false))
  await act(async () => button('Provider and model').click())
  const dialog = document.querySelector('[role="dialog"][aria-label="Provider and model"]')!
  expect(dialog.textContent).not.toContain('Codex')
  expect(dialog.querySelector('[title="Login required"]')).toBeNull()
  const opencode = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((entry) =>
    entry.textContent?.startsWith('opencode')
  )!
  await act(async () => opencode.click())
  expect(button('opencode · anthropic/claude-sonnet-4')).not.toBeNull()
  expect(button('opencode · openai/gpt-5')).toBeNull()
  expect(button('opencode · openrouter/other')).toBeNull()
  await act(async () => button('opencode · anthropic/claude-sonnet-4').click())
  await act(async () => button('Provider and model').click())
  await act(async () => saveButton().click())
  expect(mocks.updateAgent).toHaveBeenLastCalledWith(
    'agent-1',
    expect.objectContaining({ modelProvider: 'auto', runtime: 'opencode', model: 'anthropic/claude-sonnet-4' })
  )
  await chooseCredentials(false)
  expect(button('Provider and model').getAttribute('aria-expanded')).toBe('false')
  await act(async () => button('Provider and model').click())
  expect(button('Provider and model').getAttribute('aria-expanded')).toBe('true')
  expect(document.querySelector('[role="dialog"][aria-label="Provider and model"]')!.textContent).toContain('Codex')
})

it('refuses to save with no matching saved key, including an existing unsupported model', async () => {
  await openEditor({ model: 'model-host' })
  await chooseCredentials(true)
  expect(saveButton().disabled).toBe(true)
  expect(host!.textContent).toContain('Choose a model with a key configured in Providers.')
  expect(mocks.updateAgent).not.toHaveBeenCalled()
  await chooseCredentials(false)
  expect(saveButton().disabled).toBe(false)
})

it.each([false, true])('waits for saved credentials without a false model error (Decision: %s)', async (decision) => {
  let resolve!: (value: Awaited<ReturnType<typeof fetchProviderKeys>>) => void
  const pending = new Promise<Awaited<ReturnType<typeof fetchProviderKeys>>>((done) => {
    resolve = done
  })
  vi.mocked(fetchProviderKeys).mockReturnValueOnce(pending)
  await openEditor({
    model: 'model-host',
    ...(decision
      ? {
          modelSelection: {
            decisionId: DECISION,
            rules: [{ when: { type: 'score', min: 0, max: 2 }, runtime: 'claude', model: 'model-host' }]
          }
        }
      : {})
  })
  await chooseCredentials(true)
  expect(button('Credentials').textContent).toBe('Use saved credential (Beta)')
  expect(host!.querySelector('[role="status"]')?.textContent).toBe('Loading saved credentials…')
  expect(host!.querySelector('[role="alert"]')).toBeNull()
  expect(host!.textContent).toContain('model-host')
  expect(saveButton().disabled).toBe(true)
  await act(async () =>
    resolve([
      {
        provider: 'anthropic',
        name: 'Anthropic',
        defaultEndpoint: null,
        endpointRequired: false,
        endpoint: null,
        headerNames: [],
        configured: true,
        updatedAt: null
      }
    ])
  )
  await vi.waitFor(() => expect(saveButton().disabled).toBe(false))
  expect(host!.querySelector('[role="status"]')).toBeNull()
  expect(host!.querySelector('[role="alert"]')).toBeNull()
  await act(async () => saveButton().click())
  expect(mocks.updateAgent).toHaveBeenLastCalledWith('agent-1', { modelProvider: 'auto' })
})

it('keeps saved credentials selected after a lookup failure and retries before allowing Save', async () => {
  vi.mocked(fetchProviderKeys).mockRejectedValueOnce(new Error('unavailable'))
  await openEditor({ model: 'model-host' })
  await chooseCredentials(true)
  await vi.waitFor(() => expect(host!.textContent).toContain('Could not load saved credentials.'))
  expect(host!.textContent).not.toContain('Choose a model with a key configured in Providers.')
  expect(button('Credentials').textContent).toBe('Use saved credential (Beta)')
  expect(saveButton().disabled).toBe(true)
  mocks.providers = ['anthropic']
  await act(async () => [...host!.querySelectorAll('button')].find((entry) => entry.textContent === 'Retry')!.click())
  await vi.waitFor(() => expect(saveButton().disabled).toBe(false))
  expect(host!.querySelector('[role="alert"]')).toBeNull()
  expect(button('Credentials').textContent).toBe('Use saved credential (Beta)')
})

it('shows the saved level of what people can do in chat and saves a new one', async () => {
  await openEditor({ model: 'model-host', chatActions: 'settings' })
  const field = button('What people can do in chat')
  expect(field.textContent).toBe('Talk, approve and change settings')
  await act(async () => field.click())
  const approve = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
    (option) => option.textContent === 'Talk and approve tool calls'
  )!
  await act(async () => approve.click())
  await act(async () => saveButton().click())
  await vi.waitFor(() => expect(mocks.updateAgent).toHaveBeenCalled())
  expect(mocks.updateAgent.mock.calls[0]![1]).toMatchObject({ chatActions: 'approve' })
})

it('removes a live secret only after its removal is confirmed, and sends it as null on save', async () => {
  mocks.dto = {
    name: 'pilot',
    runtime: 'claude',
    daemonId: 'd1',
    execution: 'host',
    strategies: STRATEGIES,
    model: 'model-host',
    visibility: 'org',
    sharedWith: []
  }
  const withLive = {
    ...agent,
    liveSecrets: [
      { name: 'GRAFANA_TOKEN', description: 'Grafana API token' },
      { name: 'KUBE_TOKEN', description: null }
    ]
  } as Agent
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () =>
    root!.render(
      <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
        <EditAgentModal agent={withLive} onClose={vi.fn()} />
      </SWRConfig>
    )
  )
  const remove = () => host!.querySelector<HTMLButtonElement>('[aria-label="Remove live secret GRAFANA_TOKEN"]')!
  await vi.waitFor(() => expect(remove()).not.toBeNull())
  const pick = (text: string) =>
    [...host!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!
  // A first click only asks, and says a process that already loaded it keeps the value until restarted.
  await act(async () => remove().click())
  expect(host!.querySelector('[role="alertdialog"]')!.textContent).toContain('keeps the value until it is restarted')
  await act(async () => pick('Keep it').click())
  expect(host!.querySelector('[role="alertdialog"]')).toBeNull()
  expect(host!.querySelector('[data-live-secrets]')!.textContent).toContain('GRAFANA_TOKEN')
  await act(async () => remove().click())
  await act(async () => pick('Remove').click())
  expect(host!.querySelector('[data-live-secrets]')!.textContent).not.toContain('GRAFANA_TOKEN')
  expect(host!.querySelector('[data-live-secrets]')!.textContent).toContain('KUBE_TOKEN')
  const save = [...host!.querySelectorAll<HTMLButtonElement>('.modalfoot button')].at(-1)!
  await vi.waitFor(() => expect(save.disabled).toBe(false))
  await act(async () => save.click())
  await vi.waitFor(() => expect(mocks.updateAgent).toHaveBeenCalled())
  expect(mocks.updateAgent.mock.calls[0]![1]).toMatchObject({ liveSecrets: { GRAFANA_TOKEN: null } })
  expect(Object.keys((mocks.updateAgent.mock.calls[0]![1] as { liveSecrets: object }).liveSecrets)).toEqual([
    'GRAFANA_TOKEN'
  ])
})
