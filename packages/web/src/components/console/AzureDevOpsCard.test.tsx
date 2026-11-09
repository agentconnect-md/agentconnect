// @vitest-environment happy-dom
// The Azure DevOps card (azure-devops-integration.md §3.2, §8): Connect with Microsoft leads, the own application is one click away, and a connection shows its state, its actions and the repositories in use.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type AzureDevOpsConnectionDto, type AzureDevOpsRepositoryBindingDto } from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  fetchConnections: vi.fn(),
  fetchRepositories: vi.fn(),
  connect: vi.fn(),
  replaceSecret: vi.fn(),
  disconnect: vi.fn(),
  start: vi.fn(),
  rotate: vi.fn(),
  assign: vi.fn()
}))

vi.mock('@/lib/org-context', () => {
  const orgs = { activeOrg: { id: 'org-azure' }, myRole: 'owner', orgPath: (path: string) => path }
  return { useOrgs: () => orgs }
})
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchAzureDevOpsConnections: mocks.fetchConnections,
  fetchAzureDevOpsRepositories: mocks.fetchRepositories,
  connectAzureDevOps: mocks.connect,
  replaceAzureDevOpsSecret: mocks.replaceSecret,
  disconnectAzureDevOps: mocks.disconnect,
  startAzureDevOpsConnect: mocks.start,
  rotateAzureDevOpsHookKey: mocks.rotate
}))

const AzureDevOpsCard = (await import('./AzureDevOpsCard')).default

const TENANT = '00000000-0000-4000-8000-000000000001'
const CLIENT = '00000000-0000-4000-8000-000000000002'

const CONNECTION: AzureDevOpsConnectionDto = {
  id: '00000000-0000-4000-8000-000000000010',
  organization: 'example-org',
  organizationInstanceId: '00000000-0000-4000-8000-000000000011',
  tenantId: TENANT,
  identityId: '00000000-0000-4000-8000-000000000012',
  identityName: 'AgentConnect',
  credentialSource: 'deployment',
  clientId: null,
  state: 'connected',
  stateReason: null,
  credentialEpoch: '1',
  boundRepositories: 1,
  connectedBy: 'user-1',
  lastVerifiedAt: '2026-11-01T00:00:00.000Z',
  createdAt: '2026-11-01T00:00:00.000Z'
}

const BINDING: AzureDevOpsRepositoryBindingDto = {
  id: 'binding-1',
  connectionId: CONNECTION.id,
  repoId: '9001',
  repositoryId: '00000000-0000-4000-8000-000000000020',
  projectId: '00000000-0000-4000-8000-000000000021',
  repoPath: 'example-org/Example Project/example-repo',
  cloneUrl: 'https://dev.azure.com/example-org/Example%20Project/_git/example-repo',
  defaultBranch: 'main',
  state: 'ready',
  stateReason: null,
  createdAt: '2026-11-01T00:00:00.000Z'
}

let host: HTMLDivElement
let root: Root

async function render(canWrite = true): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<AzureDevOpsCard canWrite={canWrite} />)
  })
}

function buttonIn(scope: ParentNode, label: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(label))
}

async function click(label: string, scope: ParentNode = host): Promise<void> {
  const target = buttonIn(scope, label)
  if (!target) throw new Error(`button not found: ${label}`)
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function fill(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function listed(connections: AzureDevOpsConnectionDto[], deploymentApplication = true) {
  return { enabled: true, connections, deploymentApplication }
}

beforeEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML = ''
  mocks.fetchRepositories.mockResolvedValue([])
  vi.spyOn(window.location, 'assign').mockImplementation(mocks.assign)
})

describe('AzureDevOpsCard', () => {
  it('states the absence on a control plane without Azure DevOps', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: false, connections: [], deploymentApplication: false })
    await render()
    expect(host.textContent).toContain('Not enabled on this deployment')
    expect(mocks.fetchRepositories).not.toHaveBeenCalled()
    expect(host.querySelectorAll('button')).toHaveLength(0)
  })

  it('leads with Connect with Microsoft, sends the browser to Microsoft, and keeps the own application one click away', async () => {
    mocks.fetchConnections.mockResolvedValue(listed([]))
    mocks.start.mockResolvedValue({ authorizeUrl: 'https://login.example.test/authorize?state=s' })
    await render()

    expect(host.textContent).toContain('Not connected')
    expect(buttonIn(host, 'Use your own application instead')).toBeTruthy()
    expect(host.querySelector('[data-azure-devops-attention]')?.textContent).toContain(
      'Grant it only the projects agents need.'
    )
    const docs = host.querySelector<HTMLAnchorElement>('[data-azure-devops-attention] a')!
    expect(docs.href).toMatch(/\/connect-automate\/triggers-automation\/azure-devops$/)

    await click('Connect with Microsoft')
    expect(mocks.start).toHaveBeenCalledWith(undefined)
    expect(mocks.assign).toHaveBeenCalledWith('https://login.example.test/authorize?state=s')
  })

  it('connects with an own application and never echoes the secret', async () => {
    mocks.fetchConnections.mockResolvedValue(listed([]))
    mocks.connect.mockResolvedValue({ ...CONNECTION, credentialSource: 'own', clientId: CLIENT })
    await render()
    await click('Use your own application instead')

    const form = host.querySelector('[data-azure-devops-own-app]')!
    const [organization, tenant, client, secret] = [...form.querySelectorAll<HTMLInputElement>('input')]
    expect(secret!.type).toBe('password')
    expect(buttonIn(form, 'Connect')!.disabled).toBe(true)
    await fill(organization!, ' example-org ')
    await fill(tenant!, TENANT)
    await fill(client!, CLIENT)
    await fill(secret!, 'own-client-secret')
    await click('Connect', form)

    expect(mocks.connect).toHaveBeenCalledWith({
      organization: 'example-org',
      tenantId: TENANT,
      clientId: CLIENT,
      clientSecret: 'own-client-secret'
    })
    expect(host.querySelector('[data-azure-devops-connection]')).not.toBeNull()
    expect(host.innerHTML).not.toContain('own-client-secret')
    // An own application replaces its secret here; it has no Manage project access.
    expect(buttonIn(host, 'Replace secret')).toBeTruthy()
    expect(buttonIn(host, 'Manage project access')).toBeUndefined()
  })

  it('makes the own application the only path when the deployment has no Microsoft application', async () => {
    mocks.fetchConnections.mockResolvedValue(listed([], false))
    await render()
    expect(buttonIn(host, 'Connect with Microsoft')).toBeUndefined()
    expect(buttonIn(host, 'Use your own application instead')).toBeUndefined()
    expect(host.textContent).toContain('This deployment has no Microsoft application.')
    await click('Connect')
    expect(host.querySelector('[data-azure-devops-own-app]')).not.toBeNull()
  })

  it('shows a deployment connection with Manage project access and the repositories in use', async () => {
    mocks.fetchConnections.mockResolvedValue(listed([CONNECTION]))
    mocks.fetchRepositories.mockResolvedValue([BINDING])
    mocks.start.mockResolvedValue({ authorizeUrl: 'https://login.example.test/authorize?state=m' })
    await render()

    const row = host.querySelector(`[data-azure-devops-connection="${CONNECTION.id}"]`)!
    expect(row.textContent).toContain('example-org')
    expect(row.textContent).toContain('Connected')
    expect(buttonIn(host, 'Replace secret')).toBeUndefined()
    const repository = host.querySelector('[data-azure-devops-repository="binding-1"] a') as HTMLAnchorElement
    expect(repository.textContent).toBe('example-org/Example Project/example-repo')
    expect(repository.getAttribute('href')).toBe(BINDING.cloneUrl)

    await click('Manage project access')
    expect(mocks.start).toHaveBeenCalledWith(CONNECTION.id)
    expect(mocks.assign).toHaveBeenCalledWith('https://login.example.test/authorize?state=m')
  })

  it('names the reason a connection is degraded, and who fixes it', async () => {
    mocks.fetchConnections.mockResolvedValue(
      listed([{ ...CONNECTION, state: 'degraded', stateReason: 'secret_rejected' }])
    )
    mocks.fetchRepositories.mockResolvedValue([
      { ...BINDING, state: 'runtime_degraded', stateReason: 'repository_unavailable' }
    ])
    await render()
    expect(host.textContent).toContain('Needs attention')
    expect(host.querySelector('[role="status"]')?.textContent).toContain('rotate it in Setup')
    expect(host.querySelector('[data-azure-devops-repository="binding-1"]')?.textContent).toContain(
      'can no longer see this repository'
    )
  })

  it('replaces an own application secret and re-reads the repositories it degraded', async () => {
    const own = { ...CONNECTION, credentialSource: 'own' as const, clientId: CLIENT }
    mocks.fetchConnections.mockResolvedValue(listed([{ ...own, state: 'degraded', stateReason: 'secret_rejected' }]))
    mocks.replaceSecret.mockResolvedValue(own)
    await render()
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Replace it to reconnect')

    await click('Replace secret')
    const panel = host.querySelector('[data-azure-devops-secret]')!
    await fill(panel.querySelector('input')!, 'rotated-secret')
    await click('Replace secret', panel)

    expect(mocks.replaceSecret).toHaveBeenCalledWith(CONNECTION.id, 'rotated-secret')
    expect(mocks.fetchRepositories).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('Secret replaced.')
    expect(host.innerHTML).not.toContain('rotated-secret')
  })

  it('disconnects after confirmation, and shows the refusal when a workspace still uses a repository', async () => {
    mocks.fetchConnections.mockResolvedValue(listed([CONNECTION]))
    mocks.disconnect.mockRejectedValueOnce(
      new ApiError('example-org is still used by the workspace of agent builder', 409, 'repository_in_use')
    )
    await render()
    await click('Disconnect')
    await click('Disconnect', host.querySelector('.modal')!)
    expect(mocks.disconnect).toHaveBeenCalledWith(CONNECTION.id)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('workspace of agent builder')

    mocks.disconnect.mockResolvedValueOnce(undefined)
    await click('Disconnect')
    await click('Disconnect', host.querySelector('.modal')!)
    expect(host.querySelector('[data-azure-devops-connection]')).toBeNull()
    expect(host.textContent).toContain('Not connected')
  })

  it('offers no write action to a viewer', async () => {
    mocks.fetchConnections.mockResolvedValue(listed([CONNECTION]))
    await render(false)
    for (const label of ['Manage project access', 'Disconnect', 'Connect with Microsoft']) {
      expect(buttonIn(host, label)).toBeUndefined()
    }
  })
})

describe('AzureDevOpsCard triggers (§11.2)', () => {
  const HOOKED: AzureDevOpsRepositoryBindingDto = {
    ...BINDING,
    hookReason: null,
    lastVerifiedDeliveryAt: '2026-11-01T00:00:00.000Z',
    subscriptions: [
      { kind: 'opened', status: 'enabled' },
      { kind: 'revision', status: 'enabled' },
      { kind: 'comment', status: 'onProbation' }
    ]
  }

  it('says nothing about triggers on a repository no trigger needs', async () => {
    mocks.fetchConnections.mockResolvedValue(listed([CONNECTION]))
    mocks.fetchRepositories.mockResolvedValue([{ ...BINDING, hookReason: null, subscriptions: [] }])
    await render()
    const row = host.querySelector('[data-azure-devops-repository="binding-1"]')!
    expect(row.querySelector('[data-azure-devops-last-event]')).toBeNull()
    expect(row.querySelector('[data-azure-devops-hook-reason]')).toBeNull()
    expect(row.querySelector('button')).toBeNull()
  })

  it('shows a working trigger by its last event alone, and a problem by its badge alone', async () => {
    mocks.fetchConnections.mockResolvedValue(listed([CONNECTION]))
    mocks.fetchRepositories.mockResolvedValue([HOOKED])
    await render()
    const line = host.querySelector('[data-azure-devops-last-event]')!
    expect(line.textContent).toContain('last event')
    expect(host.textContent).not.toContain('service hook')
    expect(host.textContent).not.toContain('paused')

    document.body.innerHTML = ''
    mocks.fetchRepositories.mockResolvedValue([{ ...HOOKED, hookReason: 'triggers_not_allowed' as const }])
    await render()
    expect(host.querySelector('[data-azure-devops-hook-reason]')?.textContent).toBe('Triggers not allowed')
    expect(host.querySelector('[data-azure-devops-last-event]')).toBeNull()
  })

  it('tells who allows triggers: Manage project access, or Azure DevOps for an own application', async () => {
    const notAllowed = { ...HOOKED, hookReason: 'triggers_not_allowed' as const }
    mocks.fetchConnections.mockResolvedValue(listed([CONNECTION]))
    mocks.fetchRepositories.mockResolvedValue([notAllowed])
    await render()
    expect(host.querySelector('[data-azure-devops-hook-reason]')?.textContent).toBe('Triggers not allowed')
    expect(host.textContent).toContain('in Manage project access')

    document.body.innerHTML = ''
    mocks.fetchConnections.mockResolvedValue(
      listed([{ ...CONNECTION, credentialSource: 'own', clientId: '00000000-0000-4000-8000-000000000002' }])
    )
    await render()
    expect(host.textContent).toContain('View and Edit subscriptions on this repository’s project in Azure DevOps')
  })

  it('says an own application grants triggers by hand where it is connected', async () => {
    mocks.fetchConnections.mockResolvedValue(listed([]))
    await render()
    await click('Use your own application instead')
    expect(host.querySelector('[data-azure-devops-own-triggers]')?.textContent).toContain('View and Edit subscriptions')
  })

  it('rotates the key and reports the switch', async () => {
    mocks.fetchConnections.mockResolvedValue(listed([CONNECTION]))
    mocks.fetchRepositories.mockResolvedValue([HOOKED])
    mocks.rotate.mockResolvedValueOnce({ rotated: true, switched: 3, total: 3, reason: null })
    await render()
    const rotate = host.querySelector('[data-azure-devops-repository="binding-1"] button[aria-label="Rotate key"]')!
    await act(async () => {
      rotate.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const modal = host.querySelector('[data-azure-devops-rotate="binding-1"]')!
    expect(modal.querySelector('input[type="checkbox"]')).toBeNull()
    await click('Rotate', modal)
    expect(mocks.rotate).toHaveBeenCalledWith('binding-1')
    expect(host.querySelector('[data-azure-devops-rotate]')).toBeNull()
    expect(host.textContent).toContain('Key rotated.')
  })

  it('words a refused rotation', async () => {
    mocks.fetchConnections.mockResolvedValue(listed([CONNECTION]))
    mocks.fetchRepositories.mockResolvedValue([HOOKED])
    mocks.rotate.mockResolvedValueOnce({ rotated: false, switched: 0, total: 3, reason: 'convergence_in_progress' })
    await render()
    const rotate = host.querySelector('button[aria-label="Rotate key"]')!
    await act(async () => {
      rotate.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await click('Rotate', host.querySelector('.modal')!)
    expect(mocks.rotate).toHaveBeenCalledWith('binding-1')
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'The subscriptions are being updated. Try again in a moment.'
    )
  })
})
