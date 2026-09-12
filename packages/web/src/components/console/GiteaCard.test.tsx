// @vitest-environment happy-dom
/**
 * The Gitea card is the console's Gitea MANAGEMENT surface: an unconnected
 * organization gets one entry point and the requirements its bot token must
 * satisfy, a connected one gets the connection lifecycle and the repositories
 * the bot administers. The CONNECTION is the only identity here — one bot user
 * serves every agent (gitea-integration.md §4.1) — so the rows under it are
 * repositories, and they are added from this card because binding one needs the
 * bot to hold Admin on it.
 *
 * The write actions are asserted against the endpoint they call: a repair that
 * silently posted to the wrong binding would still look right. And the token is
 * asserted never to be echoed back into the DOM.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type GiteaConnectionDto, type GiteaRepositoryBindingDto, type GiteaRepositoryDto } from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  fetchConnections: vi.fn(),
  fetchRepositories: vi.fn(),
  fetchCandidates: vi.fn(),
  connect: vi.fn(),
  replaceToken: vi.fn(),
  disconnect: vi.fn(),
  createRepository: vi.fn(),
  repairRepository: vi.fn(),
  rotateSecret: vi.fn(),
  deleteRepository: vi.fn()
}))

// One stable org object: the card keys its fetch effect on `activeOrg`, so a fresh literal per
// render would re-run it forever.
vi.mock('@/lib/org-context', () => {
  const orgs = { activeOrg: { id: 'org-gitea' }, myRole: 'owner', orgPath: (path: string) => path }
  return { useOrgs: () => orgs }
})
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchGiteaConnections: mocks.fetchConnections,
  fetchGiteaRepositories: mocks.fetchRepositories,
  fetchGiteaConnectionRepositories: mocks.fetchCandidates,
  connectGitea: mocks.connect,
  replaceGiteaToken: mocks.replaceToken,
  disconnectGiteaConnection: mocks.disconnect,
  createGiteaRepository: mocks.createRepository,
  repairGiteaRepository: mocks.repairRepository,
  rotateGiteaWebhookSecret: mocks.rotateSecret,
  deleteGiteaRepository: mocks.deleteRepository
}))

const GiteaCard = (await import('./GiteaCard')).default

const CONNECTION: GiteaConnectionDto = {
  id: 'conn-1',
  botUserId: '41',
  botUsername: 'agentconnect-bot',
  botDisplayName: 'AgentConnect bot',
  state: 'connected',
  connectedBy: 'user-1',
  credentialEpoch: '1',
  boundRepositories: 1,
  instanceUrl: 'https://gitea.example.test',
  instanceVersion: '1.24.0',
  instanceVersionSupported: true,
  instanceVersionFloor: '1.23',
  requiredScopes: ['read:user', 'write:repository', 'write:issue', 'read:organization'],
  lastVerifiedAt: '2026-09-01T00:00:00.000Z',
  createdAt: '2026-09-01T00:00:00.000Z'
}

const BINDING: GiteaRepositoryBindingDto = {
  id: 'binding-1',
  connectionId: 'conn-1',
  repoId: '7711',
  repoPath: 'example-org/example-repo',
  cloneUrl: 'https://gitea.example.test/example-org/example-repo.git',
  defaultBranch: 'main',
  state: 'ready',
  stateReason: null,
  webhookState: 'installed',
  lastVerifiedDeliveryAt: '2026-09-01T00:00:00.000Z',
  createdAt: '2026-09-01T00:00:00.000Z'
}

const CANDIDATE: GiteaRepositoryDto = {
  repoId: '7712',
  path: 'example-org/example-second',
  cloneUrl: 'https://gitea.example.test/example-org/example-second.git',
  defaultBranch: 'trunk',
  private: true
}

let host: HTMLDivElement
let root: Root

async function render(canWrite = true): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<GiteaCard canWrite={canWrite} />)
  })
}

function buttonIn(scope: ParentNode, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(label))
  if (!found) throw new Error(`button not found: ${label}`)
  return found
}

/** The compact controls carry their meaning in the tooltip, like the messaging rows. */
function iconButtonIn(scope: ParentNode, title: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((candidate) =>
    candidate.getAttribute('title')?.includes(title)
  )
  if (!found) throw new Error(`icon button not found: ${title}`)
  return found
}

async function click(label: string, scope: ParentNode = host): Promise<void> {
  const target = buttonIn(scope, label)
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function clickIcon(title: string, scope: ParentNode = host): Promise<void> {
  const target = iconButtonIn(scope, title)
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function tokenInput(): HTMLInputElement {
  const found = host.querySelector<HTMLInputElement>('input[type="password"]')
  if (!found) throw new Error('no token field is open')
  return found
}

/** React tracks the DOM value it wrote, so a raw assignment is swallowed. */
async function fill(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function typeToken(value: string): Promise<void> {
  await fill(tokenInput(), value)
}

function repositoryRow(bindingId: string): HTMLElement {
  const found = host.querySelector(`[data-gitea-repository="${bindingId}"]`)
  if (!found) throw new Error(`no repository row: ${bindingId}`)
  return found as HTMLElement
}

function modal(): HTMLElement {
  const found = host.querySelector('.modal')
  if (!found) throw new Error('no modal is open')
  return found as HTMLElement
}

/** Open the connect panel, paste a token, and submit it. */
async function connectWith(token: string, label = 'Connect Gitea'): Promise<void> {
  await click(label)
  await typeToken(token)
  await click(label)
}

beforeEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML = ''
  mocks.fetchRepositories.mockResolvedValue([])
  mocks.fetchCandidates.mockResolvedValue([])
})

describe('GiteaCard', () => {
  it('states the absence, and asks for no repositories, on a deployment with no Gitea instance', async () => {
    // The card mounts everywhere and learns availability from the API: an unconfigured control
    // plane 404s the whole surface, which is an absence to state — never a load error, and never
    // a second request.
    mocks.fetchConnections.mockResolvedValue({ enabled: false, connections: [] })
    await render()

    expect(host.textContent).toContain('Not enabled on this deployment')
    expect(mocks.fetchRepositories).not.toHaveBeenCalled()
    expect([...host.querySelectorAll('button')]).toHaveLength(0)
  })

  it('offers a single connect entry point when nothing is connected', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [] })
    await render()

    expect(host.textContent).toContain('Not connected')
    expect(buttonIn(host, 'Connect Gitea')).toBeTruthy()
    expect(host.querySelector('[data-gitea-connect]')).toBeNull()
  })

  it('names the deployment instance before any connection exists', async () => {
    // A self-hosted deployment must not tell the operator to create the bot on gitea.com (§3).
    mocks.fetchConnections.mockResolvedValue({
      enabled: true,
      connections: [],
      instanceUrl: 'https://gitea.example.test'
    })
    await render()

    expect(host.textContent).toContain('gitea.example.test')
    expect(host.textContent).not.toContain('gitea.com')
  })

  it('states every requirement the token must satisfy beside the input', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [] })
    await render()
    await click('Connect Gitea')

    const panel = host.querySelector('[data-gitea-connect]')!
    // The four scopes the connect step verifies (§4.1), from the server's own answer.
    for (const scope of ['read:user', 'write:repository', 'write:issue', 'read:organization']) {
      expect(panel.textContent).toContain(scope)
    }
    // A dedicated bot user, Admin on every bound repository (§4.4) …
    expect(panel.textContent).toContain('Use a dedicated bot user')
    expect(panel.textContent).toContain('Admin')
    // … and §15's trade-off, said rather than implied.
    expect(panel.textContent).toContain('can do anything the bot can')
    // An empty field cannot be submitted.
    expect(buttonIn(panel, 'Connect Gitea').disabled).toBe(true)
  })

  it('connects with the pasted token and never echoes it back', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [] })
    mocks.connect.mockResolvedValue(CONNECTION)
    await render()
    await connectWith('  gta_secret_value  ')

    // Trimmed, because a pasted token carries whitespace more often than not.
    expect(mocks.connect).toHaveBeenCalledWith('gta_secret_value')
    expect(host.querySelector('[data-gitea-connection="conn-1"]')).not.toBeNull()
    expect(host.textContent).toContain('agentconnect-bot')
    expect(host.textContent).not.toContain('gta_secret_value')
    expect(host.querySelector('[data-gitea-connect]')).toBeNull()
  })

  it('words a scope refusal itself and passes an unexpected one through verbatim', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [] })
    mocks.connect.mockRejectedValueOnce(new ApiError('the token lacks the write:issue scope', 400, 'missing_scope'))
    await render()
    await connectWith('gta_missing_scope')

    expect(host.textContent).toContain('That token is missing a required scope')
    // The panel stays open: the fix is a new token in the same field.
    expect(host.querySelector('[data-gitea-connect]')).not.toBeNull()

    // A refusal the card has no better words for is the server's sentence, unchanged.
    mocks.connect.mockRejectedValueOnce(
      new ApiError(
        'https://gitea.example.test reports version 1.22.0; AgentConnect requires Gitea 1.23 or later',
        409,
        'gitea_version_unsupported'
      )
    )
    await typeToken('gta_old_instance')
    await click('Connect Gitea')
    expect(host.textContent).toContain('requires Gitea 1.23 or later')
  })

  it('names the instance and what it runs, once, on the card', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    await render()

    expect(host.querySelector('[data-gitea-instance]')?.getAttribute('title')).toBe(
      'https://gitea.example.test · Gitea 1.24.0'
    )
    // The bot's own page on that instance, composed onto the base.
    expect(host.querySelector<HTMLAnchorElement>('a[href*="agentconnect-bot"]')?.getAttribute('href')).toBe(
      'https://gitea.example.test/agentconnect-bot'
    )
  })

  it('sizes the card and connection marks like the chat-platform marks beside them', async () => {
    // The card header and the connection row render the Gitea mark at the fill a full-bleed
    // square glyph lands on through PlatformMark, which is what the bot tabs' marks render at.
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    await render()

    for (const selector of ['.cardtitle svg', '[data-gitea-connection] svg']) {
      const mark = host.querySelector(selector)
      expect(mark, selector).not.toBeNull()
      expect(mark?.getAttribute('style'), selector).toContain('80%')
    }
  })

  it('says an instance below the floor once, not on every repository', async () => {
    mocks.fetchConnections.mockResolvedValue({
      enabled: true,
      connections: [{ ...CONNECTION, instanceVersion: '1.22.0', instanceVersionSupported: false }]
    })
    mocks.fetchRepositories.mockResolvedValue([BINDING])
    await render()

    expect(host.textContent).toContain('below 1.23')
    expect(host.textContent).toContain('Repositories already set up keep working')
  })

  it('asks for a replacement token when Gitea has rejected the stored one', async () => {
    mocks.fetchConnections.mockResolvedValue({
      enabled: true,
      connections: [{ ...CONNECTION, state: 'token_rejected' }]
    })
    await render()

    expect(host.textContent).toContain('token rejected')
    // Gitea tokens carry no expiry, so the card says what a rejection actually means.
    expect(host.textContent).toContain('do not expire on their own')
  })

  it('replaces the token against the connection and says to revoke the old one', async () => {
    mocks.fetchConnections.mockResolvedValue({
      enabled: true,
      connections: [{ ...CONNECTION, state: 'token_rejected' }]
    })
    mocks.fetchRepositories.mockResolvedValue([
      { ...BINDING, state: 'runtime_degraded', stateReason: 'token_rejected' }
    ])
    mocks.replaceToken.mockResolvedValue(CONNECTION)
    await render()
    await click('Replace token')
    await typeToken('gta_fresh_value')
    await click('Replace token')

    expect(mocks.replaceToken).toHaveBeenCalledWith('conn-1', 'gta_fresh_value')
    expect(host.textContent).toContain('Revoke the old one in Gitea')
    // Replacement re-converges the bindings the rejected token degraded, so they are re-read.
    expect(mocks.fetchRepositories).toHaveBeenCalledTimes(2)
  })

  it('offers only the administered repositories that are not bound yet, and filters them', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchRepositories.mockResolvedValue([BINDING])
    mocks.fetchCandidates.mockResolvedValue([
      { repoId: '7711', path: 'example-org/example-repo', cloneUrl: null, defaultBranch: 'main', private: false },
      CANDIDATE
    ])
    await render()
    await click('Add repository')

    expect(mocks.fetchCandidates).toHaveBeenCalledWith('conn-1')
    // The bound one is already a row on the card; offering it again would bind nothing.
    expect(modal().querySelector('[data-gitea-candidate="7711"]')).toBeNull()
    expect(modal().querySelector('[data-gitea-candidate="7712"]')).not.toBeNull()
    expect(modal().textContent).toContain('default branch trunk')

    await fill(modal().querySelector<HTMLInputElement>('input')!, 'nothing-like-this')
    expect(modal().querySelector('[data-gitea-candidate="7712"]')).toBeNull()
    expect(modal().textContent).toContain('No repositories match')
  })

  it('binds the picked repository by its numeric id and lists the binding the saga answered with', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchCandidates.mockResolvedValue([CANDIDATE])
    mocks.createRepository.mockResolvedValue({
      ...BINDING,
      id: 'binding-2',
      repoId: '7712',
      repoPath: 'example-org/example-second',
      stateReason: 'webhook_unverified'
    })
    await render()
    await click('Add repository')
    await act(async () => {
      modal()
        .querySelector<HTMLButtonElement>('[data-gitea-candidate="7712"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.createRepository).toHaveBeenCalledWith({ repoId: '7712' })
    const row = repositoryRow('binding-2')
    expect(row.textContent).toContain('example-org/example-second')
    // The saga's own outcome, including the warning a blocked relay address earns (§6 step 4).
    expect(row.textContent).toContain('ALLOWED_HOST_LIST')
  })

  it('names each repair category rather than its internal identifier', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchRepositories.mockResolvedValue([
      { ...BINDING, state: 'admin_degraded', stateReason: 'admin_lost' },
      {
        ...BINDING,
        id: 'binding-2',
        repoId: '7712',
        repoPath: 'example-org/example-second',
        state: 'cleanup_pending',
        stateReason: 'cleanup_failed',
        webhookState: 'failed'
      },
      {
        ...BINDING,
        id: 'binding-3',
        repoId: '7713',
        repoPath: 'example-org/example-third',
        stateReason: 'some_category_the_console_does_not_know'
      }
    ])
    await render()

    expect(repositoryRow('binding-1').textContent).toContain('setup incomplete')
    expect(repositoryRow('binding-1').textContent).toContain('no longer has Admin on this repository')
    expect(repositoryRow('binding-2').textContent).toContain('removal incomplete')
    expect(repositoryRow('binding-2').textContent).toContain('webhook failed')
    expect(repositoryRow('binding-2').textContent).toContain('Removal did not finish')
    // An unmapped category is an implementation identifier: the badge stands alone.
    expect(repositoryRow('binding-3').textContent).toContain('ready')
    expect(repositoryRow('binding-3').textContent).not.toContain('some_category')
  })

  it('says nothing about a healthy webhook, and nothing about one no trigger needs', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchRepositories.mockResolvedValue([
      BINDING,
      { ...BINDING, id: 'binding-2', repoId: '7712', webhookState: 'not_needed' }
    ])
    await render()

    expect(repositoryRow('binding-1').textContent).not.toContain('webhook')
    expect(repositoryRow('binding-2').textContent).not.toContain('webhook')
  })

  it('repairs the row it was clicked on', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchRepositories.mockResolvedValue([
      { ...BINDING, state: 'admin_degraded', stateReason: 'admin_lost' },
      { ...BINDING, id: 'binding-2', repoId: '7712', repoPath: 'example-org/example-second' }
    ])
    mocks.repairRepository.mockResolvedValue({ ...BINDING, id: 'binding-2', repoId: '7712', state: 'ready' })
    await render()
    await clickIcon('Repair this repository', repositoryRow('binding-2'))

    expect(mocks.repairRepository).toHaveBeenCalledWith('binding-2')
  })

  it('rotates a webhook secret and says whether the old webhook is already retired', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchRepositories.mockResolvedValue([BINDING])
    mocks.rotateSecret.mockResolvedValueOnce({ rotated: true, promoted: false, reason: null })
    await render()
    await clickIcon('Rotate the webhook signing secret', repositoryRow('binding-1'))

    expect(mocks.rotateSecret).toHaveBeenCalledWith('binding-1')
    expect(host.textContent).toContain('old one is retired once Gitea delivers one event under the new key')

    mocks.rotateSecret.mockResolvedValueOnce({ rotated: false, promoted: false, reason: 'no_managed_webhook' })
    await clickIcon('Rotate the webhook signing secret', repositoryRow('binding-1'))
    expect(host.textContent).toContain('has no managed webhook to rotate')
  })

  it('drops a removed repository and keeps one whose cleanup did not finish', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchRepositories.mockResolvedValue([
      BINDING,
      { ...BINDING, id: 'binding-2', repoId: '7712', repoPath: 'example-org/example-second' }
    ])
    mocks.deleteRepository.mockResolvedValueOnce({ removed: true })
    await render()

    await clickIcon('Remove this repository', repositoryRow('binding-1'))
    expect(modal().textContent).toContain('example-org/example-repo')
    await click('Remove', modal())
    expect(mocks.deleteRepository).toHaveBeenCalledWith('binding-1')
    expect(host.querySelector('[data-gitea-repository="binding-1"]')).toBeNull()

    // An incomplete removal keeps the row in the state the server reported.
    mocks.deleteRepository.mockResolvedValueOnce({
      removed: false,
      state: 'cleanup_pending',
      stateReason: 'token_rejected'
    })
    await clickIcon('Remove this repository', repositoryRow('binding-2'))
    await click('Remove', modal())
    expect(repositoryRow('binding-2').textContent).toContain('removal incomplete')
    expect(repositoryRow('binding-2').textContent).toContain('replace it')
  })

  it('keeps a pending webhook removal visible instead of reporting a clean disconnect', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchRepositories.mockResolvedValue([BINDING])
    mocks.disconnect.mockResolvedValue({
      removed: false,
      pendingRepositories: 1,
      connection: { ...CONNECTION, state: 'disconnecting' }
    })
    await render()
    await click('Disconnect')
    await click('Disconnect', modal())

    expect(mocks.disconnect).toHaveBeenCalledWith('conn-1')
    expect(host.textContent).toContain('1 repository still has a webhook AgentConnect could not remove')
    expect(host.querySelector('[data-gitea-connection="conn-1"]')).not.toBeNull()
  })

  it('gives a viewer the facts and none of the write controls', async () => {
    mocks.fetchConnections.mockResolvedValue({ enabled: true, connections: [CONNECTION] })
    mocks.fetchRepositories.mockResolvedValue([BINDING])
    await render(false)

    expect(host.textContent).toContain('example-org/example-repo')
    expect(() => buttonIn(host, 'Disconnect')).toThrow()
    expect(() => buttonIn(host, 'Replace token')).toThrow()
    expect(() => iconButtonIn(host, 'Repair this repository')).toThrow()
    expect(() => iconButtonIn(host, 'Remove this repository')).toThrow()
  })
})
