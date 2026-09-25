// @vitest-environment happy-dom
// By decision in Edit workspace: the Repository selector, the checkout on rows and installation grants, and when it is unavailable.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecisionProviderOption } from '@agentconnect.md/protocol/decision-api'
import { ApiError, type AgentInstallationAuthDto, type AgentRepoAuthDto, type GithubInstallationDto } from '@/lib/api'
import type { Agent } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const state = vi.hoisted(() => ({ providers: [] as DecisionProviderOption[] }))
const mocks = vi.hoisted(() => ({
  updateAgent: vi.fn(),
  updateAgentRepo: vi.fn(),
  updateAgentInstallation: vi.fn(),
  createAgentInstallation: vi.fn()
}))

const INSTALLATION: GithubInstallationDto = {
  id: 'inst-example',
  installationId: 23456,
  accountLogin: 'example-org',
  accountType: 'Organization',
  repositorySelection: 'all',
  suspended: false,
  permissionsStatus: 'current',
  pullRequestsPermission: 'write',
  checksPermission: 'write',
  settingsUrl: 'https://github.example.test/settings/installations/23456',
  createdAt: '2026-09-01T00:00:00.000Z'
}

vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (path: string) => path, myRole: 'owner' }) }))
vi.mock('@/lib/data-context', () => ({ useConsoleData: () => ({ orgSetIds: new Set<string>() }) }))
vi.mock('@/lib/decisions/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/decisions/provider')>()),
  useDecisionProviders: () => ({ providers: state.providers, daemonId: null, error: null })
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchGithubInstallations: vi.fn(async () => ({ enabled: true, installations: [INSTALLATION] })),
  fetchGithubInstallUrl: vi.fn(async () => null),
  fetchGithubRepoRoster: vi.fn(async () => ({ repos: [], privateReposHidden: false, failed: false })),
  updateAgent: mocks.updateAgent,
  updateAgentRepo: mocks.updateAgentRepo,
  updateAgentInstallation: mocks.updateAgentInstallation,
  createAgentInstallation: mocks.createAgentInstallation
}))

import EditWorkspaceModal from './EditWorkspaceModal'

const SELECTOR = { providerId: 'typesafe', model: 'jev-latest' }

const agentWith = (over: Partial<Agent> = {}) =>
  ({
    id: 'agent-a',
    name: 'build-agent',
    canEdit: true,
    workspace: { mode: 'scratch' },
    placementKind: 'daemon',
    daemon: 'daemon-1',
    repositorySelector: null,
    ...over
  }) as unknown as Agent

const provider = (over: Partial<DecisionProviderOption> = {}): DecisionProviderOption => ({
  id: 'typesafe',
  daemonId: 'daemon-1',
  memberSetId: null,
  name: 'TypeSafe',
  kind: 'typesafe',
  source: 'byok',
  readiness: { status: 'ready' },
  models: [
    { id: 'jev-latest', label: 'Jev latest', questionTypes: ['boolean', 'choice', 'score'] },
    { id: 'jev-1.13.0', label: 'Jev 1.13', questionTypes: ['boolean', 'choice', 'score'] }
  ],
  ...over
})

const row = (over: Partial<AgentRepoAuthDto> = {}): AgentRepoAuthDto => ({
  id: 'repo-auth-1',
  repoFullName: 'example-org/example-repo',
  access: 'read',
  materialize: 'on-demand',
  createdBy: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  ...over
})

const grant = (over: Partial<AgentInstallationAuthDto> = {}): AgentInstallationAuthDto => ({
  id: 'grant-1',
  provider: 'github',
  installationId: 12345,
  accountLogin: 'acme',
  access: 'read',
  materialize: 'on-demand',
  createdBy: null,
  createdAt: '2026-09-02T00:00:00.000Z',
  ...over
})

let root: Root | undefined
let host: HTMLDivElement | undefined

beforeEach(() => {
  state.providers = [provider()]
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  for (const mock of Object.values(mocks)) mock.mockReset()
})

async function render(
  props: { agent?: Agent; authorized?: AgentRepoAuthDto[]; grants?: AgentInstallationAuthDto[] } = {}
) {
  const onAgentChange = vi.fn()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <EditWorkspaceModal
        agent={props.agent ?? agentWith()}
        authorized={props.authorized ?? [row()]}
        installationGrants={props.grants ?? []}
        onAgentChange={onAgentChange}
        onClose={() => undefined}
        onChanged={() => undefined}
      />
    )
  })
  return onAgentChange
}

const click = async (node: Element | null | undefined) => {
  await act(async () => (node as HTMLElement | null | undefined)?.click())
}
const button = (text: string, scope: ParentNode = document) =>
  Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === text)
// The add and authorize steps' segmented choice; list rows use a menu instead.
const checkoutOf = (scope: ParentNode) => scope.querySelector('[role="group"][aria-label="Checkout"]')!
const rowCheckout = (name = 'example-org/example-repo') =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="Checkout for ${name}"]`)
const choices = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'))
const openChoice = async (label: string, name?: string) => {
  await click(rowCheckout(name))
  return choices().find((item) => item.textContent === label)
}
const selectorField = () => document.querySelector('[data-repository-selector]')
const selectorPicker = () => document.querySelector<HTMLButtonElement>('button[aria-label="Repository selector"]')

describe('EditWorkspaceModal, By decision', () => {
  it('disables By decision while no provider is ready where the agent runs, naming the missing key', async () => {
    state.providers = [
      provider({ daemonId: 'daemon-2' }),
      provider({ readiness: { status: 'missing_credentials' } }),
      provider({ id: 'other', models: [{ id: 'score-only', label: 'Score only', questionTypes: ['score'] }] })
    ]
    await render({ agent: agentWith({ repositorySelector: SELECTOR }) })

    const byDecision = await openChoice('By decision')
    expect(byDecision?.getAttribute('aria-disabled')).toBe('true')
    expect(byDecision?.title).toBe('Add a Decision provider key in Infra first')
    await click(byDecision)
    expect(mocks.updateAgentRepo).not.toHaveBeenCalled()
  })

  it('keeps the Repository selector out of the way until By decision asks for it', async () => {
    await render()
    expect(selectorField()).toBeNull()

    const byDecision = await openChoice('By decision')
    expect(byDecision?.getAttribute('aria-disabled')).toBe('true')
    expect(byDecision?.title).toBe('Set the Repository selector first')
    await click(byDecision)

    expect(mocks.updateAgentRepo).not.toHaveBeenCalled()
    expect(selectorField()?.textContent).toContain('Repository selector')
    expect(selectorPicker()?.textContent).toContain('Choose a provider and model')
  })

  it('saves a picked selector with an agent PATCH and clears it', async () => {
    mocks.updateAgent.mockImplementation(async (_id: string, patch: { repositorySelector: unknown }) =>
      agentWith({ repositorySelector: patch.repositorySelector as Agent['repositorySelector'] })
    )
    const onAgentChange = await render({ agent: agentWith({ repositorySelector: SELECTOR }) })
    expect(selectorPicker()?.textContent).toContain('TypeSafe · Jev latest')

    await click(selectorPicker())
    await click(button('Jev 1.13'))
    expect(mocks.updateAgent).toHaveBeenLastCalledWith('agent-a', {
      repositorySelector: { providerId: 'typesafe', model: 'jev-1.13.0' }
    })
    expect(selectorPicker()?.textContent).toContain('TypeSafe · Jev 1.13')
    expect(onAgentChange).toHaveBeenCalledOnce()

    await click(document.querySelector('button[aria-label="Clear repository selector"]'))
    expect(mocks.updateAgent).toHaveBeenLastCalledWith('agent-a', { repositorySelector: null })
    expect(document.querySelector('button[aria-label="Clear repository selector"]')).toBeNull()
  })

  it('offers only models that answer Choice questions in the picker', async () => {
    state.providers = [
      provider({
        models: [
          { id: 'jev-latest', label: 'Jev latest', questionTypes: ['choice'] },
          { id: 'jev-preview', label: 'Jev preview', questionTypes: ['score'] }
        ]
      })
    ]
    await render({ agent: agentWith({ repositorySelector: SELECTOR }) })
    await click(selectorPicker())

    expect(button('Jev latest')).toBeDefined()
    expect(button('Jev preview')).toBeUndefined()
  })

  it('moves a row to By decision with a materialize-only PATCH once a selector is set', async () => {
    mocks.updateAgentRepo.mockResolvedValue(row({ materialize: 'decision' }))
    await render({ agent: agentWith({ repositorySelector: SELECTOR }) })
    await click(await openChoice('By decision'))

    expect(mocks.updateAgentRepo).toHaveBeenCalledWith('agent-a', 'repo-auth-1', { materialize: 'decision' })
    expect(rowCheckout()?.textContent).toBe('By decision')
  })

  it('switches a grant between By decision and On demand, never Always', async () => {
    mocks.updateAgentInstallation.mockResolvedValue(grant({ materialize: 'decision' }))
    await render({ agent: agentWith({ repositorySelector: SELECTOR }), authorized: [], grants: [grant()] })

    const byDecision = await openChoice('By decision', 'acme')
    expect(choices().map((item) => item.textContent)).toEqual(['By decision', 'On demand'])
    await click(byDecision)
    expect(mocks.updateAgentInstallation).toHaveBeenCalledWith('agent-a', 'grant-1', { materialize: 'decision' })
    expect(rowCheckout('acme')?.textContent).toBe('By decision')
  })

  it('shows the Repository selector whenever an entry is By decision, and the refusal to clear it', async () => {
    mocks.updateAgent.mockRejectedValue(
      new ApiError(
        'the repository selector is in use; move every repository and installation marked by decision to another checkout first',
        409
      )
    )
    await render({ agent: agentWith({ repositorySelector: SELECTOR }), grants: [grant({ materialize: 'decision' })] })

    expect(selectorField()).not.toBeNull()
    await click(document.querySelector('button[aria-label="Clear repository selector"]'))
    expect(document.body.textContent).toContain('the repository selector is in use')
    expect(selectorPicker()?.textContent).toContain('TypeSafe · Jev latest')
  })

  it('names a refused By decision in the error line', async () => {
    mocks.updateAgentRepo.mockRejectedValue(
      new ApiError(
        'the daemon serving this agent cannot choose repositories by decision yet; upgrade it first',
        409,
        'DAEMON_FEATURE_MISSING'
      )
    )
    await render({ agent: agentWith({ repositorySelector: SELECTOR }) })
    await click(await openChoice('By decision'))

    expect(document.body.textContent).toContain('cannot choose repositories by decision yet')
    expect(rowCheckout()?.textContent).toBe('On demand')
  })

  it('authorizes an installation By decision from its step', async () => {
    mocks.createAgentInstallation.mockResolvedValue(
      grant({ id: 'grant-2', installationId: 23456, accountLogin: 'example-org', materialize: 'decision' })
    )
    await render({ agent: agentWith({ repositorySelector: SELECTOR }), authorized: [] })
    await click(
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('Authorize an installation'))
    )

    const group = checkoutOf(document)
    expect(Array.from(group.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['By decision', 'On demand'])
    await click(button('By decision', group))
    await click(button('Authorize'))
    expect(mocks.createAgentInstallation).toHaveBeenCalledWith('agent-a', {
      installationId: 23456,
      access: 'read',
      materialize: 'decision'
    })
  })

  it('keeps By decision unavailable on the installation step until a selector is set', async () => {
    await render({ authorized: [] })
    await click(
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('Authorize an installation'))
    )

    const byDecision = button('By decision', checkoutOf(document))
    expect(byDecision?.disabled).toBe(true)
    expect(byDecision?.title).toBe('Set the Repository selector first')
  })
})
