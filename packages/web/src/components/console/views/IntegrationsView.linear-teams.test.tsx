// @vitest-environment happy-dom
/**
 * The org Bots row for a connected Linear workspace expands to the workspace's TEAM rows,
 * the way a Slack bot's row expands to its channels (linear-integration.md §4.3, §9.5).
 * It used to expand to one "Default dispatch" line for the workspace as a whole; the team
 * is the channel now, so the roster is the generic one and the dispatch selector sits on
 * each row. Moving a team's default off a PRIVATE agent is confirmed first (§6.2).
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotDto } from '@/lib/api'
import type { Agent, IntegrationRow } from '@/lib/data'

const mocks = vi.hoisted(() => ({
  bots: [] as BotDto[],
  integrations: [] as IntegrationRow[],
  agents: [] as Agent[],
  setChannelAgent: vi.fn()
}))

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: null }) }))
vi.mock('@/components/console/ModalProvider', () => ({ useModal: () => ({ openModal: vi.fn() }) }))
vi.mock('@/lib/org-context', () => {
  const orgs = { activeOrg: { id: 'org-1' }, myRole: 'owner', orgPath: (path: string) => path }
  return { useOrgs: () => orgs }
})
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    get bots() {
      return mocks.bots
    },
    get integrations() {
      return mocks.integrations
    },
    get agents() {
      return mocks.agents
    },
    loading: false,
    getAgent: (id: string) => mocks.agents.find((a) => a.id === id) ?? null,
    refresh: vi.fn(),
    deleteIntegration: vi.fn(),
    setBotShareable: vi.fn(),
    setChannelAgent: mocks.setChannelAgent
  })
}))
vi.mock('@/components/console/GitlabCard', () => ({ default: () => <div /> }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchGithubInstallations: vi.fn(async () => ({ enabled: false, installations: [] })),
  fetchGithubInstallUrl: vi.fn(async () => null),
  syncGithubInstallations: vi.fn(async () => [])
}))

const IntegrationsView = (await import('./IntegrationsView')).default

const WORKSPACE: BotDto = {
  id: 'ws-1',
  name: 'Example Workspace',
  platform: 'linear',
  prebuilt: false,
  slackAppId: null,
  discordAppId: null,
  createdBy: null,
  transport: 'http',
  shareable: true,
  inUseByAgentId: null,
  agentIds: ['agent-a', 'agent-b'],
  lastUsedAt: null,
  freedFromAgent: null,
  workspaceName: 'Example Workspace',
  createdAt: '2026-01-01T00:00:00.000Z'
}

const INSTALL: IntegrationRow = {
  id: 'int-a',
  agentId: 'agent-a',
  botId: 'ws-1',
  shareable: true,
  name: 'Example Workspace',
  platform: 'linear',
  kind: 'Workspace',
  workspace: 'Example Workspace',
  daemon: 'edge-1',
  status: 'online',
  channels: [
    { channelId: 'team-des', name: 'DES · Design', kind: 'channel', trigger: 'off', agentId: 'agent-b' },
    { channelId: 'team-eng', name: 'ENG · Engineering', kind: 'channel', trigger: 'mention', agentId: 'agent-a' }
  ]
}

let host: HTMLDivElement
let root: Root

const buttons = () => [...document.querySelectorAll('button')]
const buttonWithText = (label: string) =>
  buttons().find((b) => b.textContent?.includes(label)) as HTMLButtonElement | undefined
// The picker's trigger carries no aria-label of its own — its title names the control.
const pickers = (view: HTMLElement) => [...view.querySelectorAll<HTMLButtonElement>('[title^="Default dispatch"]')]
const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent?.includes(label))

/** Render, switch to the Linear tab, and expand the workspace's row. */
async function expandWorkspace(): Promise<HTMLElement> {
  await act(async () => root.render(<IntegrationsView />))
  const tab = [...host.querySelectorAll('button[role="tab"]')].find((b) => b.textContent?.includes('Linear'))
  if (!tab) throw new Error('no Linear Bots tab')
  await act(async () => (tab as HTMLButtonElement).click())
  const row = host.querySelector<HTMLElement>('#integration-bot-ws-1')
  if (!row) throw new Error('no bot row for the workspace')
  await act(async () => row.click())
  return host
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.bots = [WORKSPACE]
  mocks.integrations = [INSTALL]
  mocks.agents = [
    { id: 'agent-a', name: 'deploy-bot', runtime: 'claude', visibility: 'org' },
    { id: 'agent-b', name: 'triage-bot', runtime: 'codex', visibility: 'restricted' }
  ] as unknown as Agent[]
  mocks.setChannelAgent.mockReset()
  mocks.setChannelAgent.mockResolvedValue(undefined)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('the Linear workspace’s Bots row', () => {
  it('expands to the workspace’s team rows, each with its own dispatch selector', async () => {
    const view = await expandWorkspace()

    // Named as Linear names a team: the name, then its key dimmed behind it.
    expect(view.textContent).toContain('DesignDES')
    expect(view.textContent).toContain('EngineeringENG')
    // Not the retired single line that stood for the whole workspace.
    expect(pickers(view)).toHaveLength(2)
  })

  it('drops the dispatch column when one agent is the only member', async () => {
    // Nothing to pick between: the column would name that agent on every team row.
    mocks.bots = [{ ...WORKSPACE, agentIds: ['agent-a'] }]
    mocks.integrations = [{ ...INSTALL, channels: INSTALL.channels.map((c) => ({ ...c, agentId: 'agent-a' })) }]
    const view = await expandWorkspace()

    expect(view.textContent).toContain('EngineeringENG')
    expect(view.textContent).not.toContain('Default dispatch')
    expect(pickers(view)).toHaveLength(0)
  })

  it('names the room with Linear’s own noun for assistive tech', async () => {
    const view = await expandWorkspace()

    expect(view.textContent).toContain('Team:')
    expect(view.textContent).not.toContain('Channel:')
  })

  it('keeps the workspace-level actions on the row itself', async () => {
    const view = await expandWorkspace()

    expect(view.querySelector('[aria-label="Reconnect this workspace"]')).not.toBeNull()
    expect(view.querySelector('[aria-label="Disconnect this workspace"]')).not.toBeNull()
  })

  it('confirms before a team’s default leaves a private agent, then writes', async () => {
    const view = await expandWorkspace()
    // DES sorts first and is owned by the restricted agent.
    await act(async () => pickers(view)[0]!.click())
    await act(async () => menuItem('deploy-bot')!.click())

    expect(document.body.textContent).toContain('Move this team’s default?')
    expect(mocks.setChannelAgent).not.toHaveBeenCalled()

    await act(async () => buttonWithText('Move')!.click())
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }

    expect(mocks.setChannelAgent).toHaveBeenCalledWith('int-a', 'team-des', 'agent-a')
  })

  it('moves an unrestricted owner without a confirmation', async () => {
    const view = await expandWorkspace()
    await act(async () => pickers(view)[1]!.click())
    await act(async () => menuItem('triage-bot')!.click())

    expect(document.body.textContent).not.toContain('Move this team’s default?')
    expect(mocks.setChannelAgent).toHaveBeenCalledWith('int-a', 'team-eng', 'agent-b')
  })
})
