// @vitest-environment happy-dom
// A revoked bot row: the built-in Slack app reinstalls straight from the row, and the agents it served stay listed as revoked.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotDto } from '@/lib/api'
import type { Agent, IntegrationRow } from '@/lib/data'

const mocks = vi.hoisted(() => ({
  bots: [] as BotDto[],
  integrations: [] as IntegrationRow[],
  agents: [] as Agent[],
  role: 'owner',
  refresh: vi.fn(),
  startSlackPlatformInstall: vi.fn(),
  getSlackPlatformInstall: vi.fn(),
  refreshSlackBot: vi.fn()
}))

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: null }) }))
vi.mock('@/components/console/ModalProvider', () => ({ useModal: () => ({ openModal: vi.fn() }) }))
vi.mock('@/lib/org-context', () => {
  // One stable object: the view's effects key on these identities.
  const orgs = {
    activeOrg: { id: 'org-1' },
    get myRole() {
      return mocks.role
    },
    orgPath: (path: string) => path
  }
  return { useOrgs: () => orgs }
})
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    bots: mocks.bots,
    integrations: mocks.integrations,
    agents: mocks.agents,
    loading: false,
    getAgent: (id: string) => mocks.agents.find((a) => a.id === id) ?? null,
    refresh: mocks.refresh,
    deleteIntegration: vi.fn(),
    setBotShareable: vi.fn(),
    setBotJoinPublicChannels: vi.fn(),
    setChannelAgent: vi.fn()
  })
}))
vi.mock('@/components/console/GitlabCard', () => ({ default: () => <div /> }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchGithubInstallations: vi.fn(async () => ({ enabled: false, installations: [] })),
  fetchGithubInstallUrl: vi.fn(async () => null),
  syncGithubInstallations: vi.fn(async () => []),
  startSlackPlatformInstall: mocks.startSlackPlatformInstall,
  getSlackPlatformInstall: mocks.getSlackPlatformInstall,
  refreshSlackBot: mocks.refreshSlackBot
}))

const IntegrationsView = (await import('./IntegrationsView')).default

function bot(over: Partial<BotDto> = {}): BotDto {
  return {
    id: 'bot-1',
    name: 'agentconnect',
    platform: 'slack',
    prebuilt: true,
    slackAppId: 'A0BUILTIN1',
    discordAppId: null,
    createdBy: null,
    transport: 'http',
    shareable: false,
    inUseByAgentId: null,
    agentIds: [],
    lastUsedAt: null,
    freedFromAgent: null,
    revokedAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over
  }
}

function install(agentId: string, revoked: boolean): IntegrationRow {
  return {
    id: `int-${agentId}`,
    agentId,
    botId: 'bot-1',
    shareable: false,
    name: 'Example Workspace',
    platform: 'slack',
    kind: 'Built-in app',
    workspace: '—',
    daemon: 'edge-1',
    status: revoked ? 'offline' : 'online',
    revoked,
    channels: []
  }
}

// A glyph icon, so the avatar renders no runtime image for the test DOM to fetch.
const pilot = {
  id: 'agent-a',
  name: 'pilot',
  runtime: 'claude',
  model: 'sonnet',
  icon: { kind: 'glyph', glyph: 'bot', color: '#5E6AD2' }
} as unknown as Agent

let host: HTMLDivElement
let root: Root

async function botRow(): Promise<HTMLElement> {
  await act(async () => root.render(<IntegrationsView />))
  const row = host.querySelector<HTMLElement>('#integration-bot-bot-1')
  if (!row) throw new Error('no Slack bot row')
  return row
}

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

const reinstallIn = (row: HTMLElement) =>
  row.querySelector<HTMLButtonElement>('button[aria-label="Reinstall the Slack app"]')

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.bots = [bot()]
  mocks.integrations = [install('agent-a', true)]
  mocks.agents = [pilot]
  mocks.role = 'owner'
  mocks.refresh.mockReset()
  mocks.startSlackPlatformInstall.mockReset()
  mocks.getSlackPlatformInstall.mockReset()
  mocks.refreshSlackBot.mockReset()
  mocks.startSlackPlatformInstall.mockResolvedValue({ id: 'install-1', installUrl: 'https://slack.example.test/oauth' })
  vi.spyOn(window, 'open').mockReturnValue(null)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('a revoked built-in Slack app’s row', () => {
  it('reinstalls straight from the row, haloed, with the refresh beside it held for the same round trip', async () => {
    mocks.getSlackPlatformInstall.mockImplementation(async (id: string) => ({
      id,
      status: 'pending',
      failureReason: null,
      missingScopes: [],
      botId: null
    }))
    const row = await botRow()
    const reinstall = reinstallIn(row)!
    expect(reinstall.className).toContain('border-(--status-error)')

    await act(async () => reinstall.click())
    await settle()
    expect(mocks.startSlackPlatformInstall).toHaveBeenCalledWith({ botId: 'bot-1' })
    expect(reinstallIn(row)!.title).toBe('Reinstalling…')
    expect(row.querySelector<HTMLButtonElement>('button[aria-label="Refresh Slack app"]')!.disabled).toBe(true)

    // An abandoned popup cannot report itself, so a pending reinstall restarts with a fresh link.
    expect(reinstallIn(row)!.disabled).toBe(false)
    mocks.startSlackPlatformInstall.mockResolvedValue({
      id: 'install-2',
      installUrl: 'https://slack.example.test/oauth-2'
    })
    await act(async () => reinstallIn(row)!.click())
    await settle()
    expect(mocks.startSlackPlatformInstall).toHaveBeenCalledTimes(2)
    expect(mocks.getSlackPlatformInstall).toHaveBeenLastCalledWith('install-2')
    expect(reinstallIn(row)!.title).toBe('Reinstalling…')
  })

  it('re-reads the app once Slack reauthorizes it', async () => {
    mocks.getSlackPlatformInstall.mockResolvedValue({
      id: 'install-1',
      status: 'completed',
      failureReason: null,
      missingScopes: [],
      botId: 'bot-1'
    })
    mocks.refreshSlackBot.mockReturnValue(new Promise(() => {}))
    const row = await botRow()
    await act(async () => reinstallIn(row)!.click())
    await settle()

    expect(mocks.refreshSlackBot).toHaveBeenCalledWith('bot-1')
  })

  it('reports a failed reinstall under the row in the agent card’s words, not as a refresh failure', async () => {
    mocks.getSlackPlatformInstall.mockResolvedValue({
      id: 'install-1',
      status: 'failed',
      failureReason: 'denied',
      missingScopes: [],
      botId: null
    })
    const row = await botRow()
    await act(async () => reinstallIn(row)!.click())
    await settle()

    expect(host.querySelector('[role="alert"]')?.textContent).toBe('The reinstall was cancelled in Slack.')
    expect(reinstallIn(row)!.disabled).toBe(false)
  })

  it('still frames a refresh that failed as one', async () => {
    mocks.refreshSlackBot.mockRejectedValue(new Error('Slack is unreachable'))
    const row = await botRow()
    await act(async () => row.querySelector<HTMLButtonElement>('button[aria-label="Refresh Slack app"]')!.click())
    await settle()

    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't refresh this Slack app — Slack is unreachable"
    )
  })

  it('lists the agents it served, each marked revoked', async () => {
    const row = await botRow()
    const agent = row.querySelector<HTMLAnchorElement>('a[aria-label="Open pilot configuration"]')!
    expect(agent.title).toBe('pilot — revoked')
    expect(agent.querySelector('[data-revoked-dot]')).not.toBeNull()
  })

  it('offers no reinstall to a viewer, or once the app is live again', async () => {
    mocks.role = 'viewer'
    expect(reinstallIn(await botRow())).toBeNull()

    mocks.role = 'owner'
    mocks.bots = [bot({ revokedAt: null, agentIds: ['agent-a'] })]
    mocks.integrations = [install('agent-a', false)]
    const row = await botRow()
    expect(reinstallIn(row)).toBeNull()
    const agent = row.querySelector<HTMLAnchorElement>('a[aria-label="Open pilot configuration"]')!
    expect(agent.title).toBe('pilot')
    expect(agent.querySelector('[data-revoked-dot]')).toBeNull()
  })

  it('offers a custom app a new token rather than a reinstall', async () => {
    mocks.bots = [bot({ prebuilt: false, slackAppId: 'A0CUSTOM01' })]
    const row = await botRow()
    expect(reinstallIn(row)).toBeNull()
    expect(row.querySelector('button[aria-label="Replace bot token"]')).not.toBeNull()
  })
})
