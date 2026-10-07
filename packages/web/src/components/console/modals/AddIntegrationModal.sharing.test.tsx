// @vitest-environment happy-dom
// Reconnection fixes bot identity; ordinary reuse keeps each platform's sharing behavior.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BotDto } from '@/lib/api'
import type { Agent, DaemonRow } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({ bots: [] as BotDto[], agents: [] as Agent[], createIntegration: vi.fn() }))

vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: null }) }))
vi.mock('@/lib/acp-registry', () => ({ useAcpRegistry: () => ({}), acpRuntime: () => undefined }))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: 'org-1', name: 'Example organization' }, orgPath: (path: string) => path })
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    get bots() {
      return mocks.bots
    },
    get agents() {
      return mocks.agents
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
    createIntegration: mocks.createIntegration,
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
  fetchAgentInstallations: vi.fn(async () => []),
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
const ReconnectIntegrationModal = (await import('./ReconnectIntegrationModal')).default

const agent = {
  id: 'agent-a',
  name: 'pilot',
  runtime: 'claude',
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

/** Open the wizard on `tile`. `existing` switches the HOST chassis to its reuse path —
 *  a step Linear does not have, because its pane replaces that chassis outright. */
async function openPane(tile: string, options: { existing?: boolean } = {}): Promise<void> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<AddIntegrationModal agent={agent} onClose={() => undefined} />)
  })
  await settle()
  await clickByText('.ptile', tile)
  if (options.existing) await clickByText('.ptile', 'Use an existing bot')
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
  mocks.agents = []
  mocks.createIntegration.mockReset()
})

describe('reusing bot identities', () => {
  async function openReconnect() {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root?.render(<ReconnectIntegrationModal botId="target" onClose={() => undefined} />))
    await settle()
  }

  it('reconnects the exact built-in app to the preset without asking for an agent or another authorization', async () => {
    mocks.agents = [agent, { ...agent, id: 'preset', builtin: true, name: 'general' }]
    mocks.bots = [bot({ id: 'other', name: 'Other app' }), bot({ id: 'target', prebuilt: true, shareable: false })]
    await openReconnect()
    expect(document.body.textContent).toContain('Example organization')
    expect(document.body.textContent).toContain('general')
    expect(document.body.textContent).not.toContain('Other app')
    expect(document.body.textContent).not.toContain('Add integration')
    expect(document.body.textContent).not.toContain('Connect & authorize')
    expect(document.querySelector('button[aria-label="Agent"]')).toBeNull()
    await clickByText('button', 'Reconnect')
    expect(mocks.createIntegration).toHaveBeenCalledExactlyOnceWith({
      platform: 'slack',
      agentId: 'preset',
      botId: 'target',
      transport: 'http'
    })
  })

  it('requires an explicit editable agent for a custom app', async () => {
    mocks.agents = [agent, { ...agent, id: 'private', name: 'Private agent', canEdit: false }]
    mocks.bots = [bot({ id: 'target', shareable: false })]
    await openReconnect()
    const submit = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Reconnect'
    )!
    expect(submit.disabled).toBe(true)
    await clickByText('button', 'Choose an agent')
    expect(document.body.textContent).not.toContain('Private agent')
    await clickByText('[role="option"]', 'pilot')
    expect(submit.disabled).toBe(false)
    await clickByText('button', 'Reconnect')
    expect(mocks.createIntegration).toHaveBeenCalledExactlyOnceWith({
      platform: 'slack',
      agentId: agent.id,
      botId: 'target',
      transport: 'http'
    })
  })

  it('does not substitute another bot when the linked app is unavailable', async () => {
    mocks.agents = [{ ...agent, builtin: true }]
    mocks.bots = [bot({ id: 'other' })]
    await openReconnect()
    await clickByText('button', 'Reconnect')
    expect(document.body.textContent).toContain('This app is no longer available to reconnect')
    expect(mocks.createIntegration).not.toHaveBeenCalled()
  })

  it('is not offered for a Linear workspace, which is shared structurally', async () => {
    mocks.bots = [bot({ id: 'ws-1', platform: 'linear', name: 'Example Workspace' })]
    await openPane('Linear')

    // The workspace is still offered — membership is the whole point — but it is the
    // module's own list, reached without a mode card, and it carries no opt-in.
    expect(document.body.textContent).toContain('Example Workspace')
    expect(shareOptIn()).toBeUndefined()
    // The whole identity chassis is replaced, so its mode cards are gone too.
    expect([...document.querySelectorAll('.ptile')].some((t) => t.textContent?.includes('Use an existing bot'))).toBe(
      false
    )
  })

  it('is still offered for Slack, unchanged', async () => {
    mocks.bots = [bot({ id: 'sl-1', platform: 'slack' })]
    await openPane('Slack', { existing: true })

    const optIn = shareOptIn()
    expect(optIn).toBeDefined()
    expect(optIn?.textContent).toContain('This bot is already shared.')
  })
})
