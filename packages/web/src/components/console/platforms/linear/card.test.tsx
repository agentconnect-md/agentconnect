// @vitest-environment happy-dom

// The AGENT page's Linear card: the connected workspace as chrome — name, grant status,
// Reconnect, unlink — over the generic conversation list of its TEAM rows (§4.3, §9.5).
// What must NOT be there matters as much: no Disconnect (that ends the workspace for every
// agent, so it is the org view's), no "any message" trigger (the platform emits no
// unaddressed traffic) and no way to leave or drop a team (the roster is the workspace's).

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotDto } from '@/lib/api'
import type { Agent, IntegrationChannelRow, IntegrationRow } from '@/lib/data'

const mocks = vi.hoisted(() => ({
  bots: [] as BotDto[],
  agents: [] as Agent[],
  integrations: [] as IntegrationRow[],
  setChannelAgent: vi.fn(),
  setChannelTrigger: vi.fn(),
  forgetChannel: vi.fn(),
  leaveConversation: vi.fn(),
  deleteIntegration: vi.fn(),
  refresh: vi.fn(),
  reconnectLinearWorkspace: vi.fn(),
  getLinearConnect: vi.fn()
}))

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  reconnectLinearWorkspace: mocks.reconnectLinearWorkspace,
  getLinearConnect: mocks.getLinearConnect
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    get bots() {
      return mocks.bots
    },
    get agents() {
      return mocks.agents
    },
    get integrations() {
      return mocks.integrations
    },
    getAgent: (id: string) => mocks.agents.find((a) => a.id === id),
    setChannelAgent: mocks.setChannelAgent,
    setChannelTrigger: mocks.setChannelTrigger,
    forgetChannel: mocks.forgetChannel,
    leaveConversation: mocks.leaveConversation,
    deleteIntegration: mocks.deleteIntegration,
    refresh: mocks.refresh
  })
}))

import { LinearWorkspaceRows } from './card'

function bot(over: Partial<BotDto> = {}): BotDto {
  return {
    id: 'bot-9',
    name: 'Example Workspace',
    platform: 'linear',
    prebuilt: false,
    slackAppId: null,
    discordAppId: null,
    createdBy: null,
    transport: 'http',
    shareable: true,
    inUseByAgentId: null,
    agentIds: ['agent-a', 'agent-b', 'agent-c'],
    lastUsedAt: null,
    freedFromAgent: null,
    workspaceName: 'Example Workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over
  }
}

/** The workspace's team rows — one `IntegrationChannel` per Linear team, as the CP upserts them. */
const TEAMS: IntegrationChannelRow[] = [
  { channelId: 'team-eng', name: 'ENG · Engineering', kind: 'channel', trigger: 'mention', agentId: 'agent-b' },
  { channelId: 'team-des', name: 'DES · Design', kind: 'channel', trigger: 'off', agentId: 'agent-c' }
]

function integration(over: Partial<IntegrationRow> = {}): IntegrationRow {
  return {
    id: 'int-a',
    agentId: 'agent-a',
    botId: 'bot-9',
    shareable: true,
    name: 'Example Workspace',
    platform: 'linear',
    kind: 'Workspace',
    workspace: 'Example Workspace',
    daemon: 'edge-1',
    status: 'online',
    agentCount: '3',
    channels: TEAMS,
    ...over
  }
}

let host: HTMLDivElement
let root: Root

const text = () => document.body.textContent ?? ''
// The dispatch and trigger menus are portaled, so their options live outside the mount host.
const buttons = () => [...document.querySelectorAll('button')]
const buttonWithLabel = (label: string) =>
  buttons().find((b) => b.getAttribute('aria-label')?.includes(label)) as HTMLButtonElement | undefined
const buttonWithText = (label: string) =>
  buttons().find((b) => b.textContent?.includes(label)) as HTMLButtonElement | undefined

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function render(row: IntegrationRow = integration()): Promise<void> {
  await act(async () => root.render(<LinearWorkspaceRows integration={row} padX={14} />))
}

/** The rows' dispatch pickers, in row order — the picker names its OWNER, not its row. */
const dispatchPickers = () => buttons().filter((b) => b.getAttribute('aria-label')?.startsWith('Default dispatch'))

/** Opens the nth team's dispatch menu and claims that row for the page's own agent. */
async function claimRow(index: number): Promise<void> {
  await act(async () => dispatchPickers()[index]!.click())
  await act(async () => buttonWithText('Make')!.click())
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.bots = [bot()]
  mocks.agents = [
    { id: 'agent-a', name: 'deploy-bot', runtime: 'claude', visibility: 'org' },
    { id: 'agent-b', name: 'triage-bot', runtime: 'codex', visibility: 'restricted' },
    { id: 'agent-c', name: 'docs-bot', runtime: 'claude', visibility: 'org' }
  ] as unknown as Agent[]
  mocks.integrations = [integration()]
  for (const fn of [
    mocks.setChannelAgent,
    mocks.setChannelTrigger,
    mocks.forgetChannel,
    mocks.leaveConversation,
    mocks.deleteIntegration,
    mocks.refresh,
    mocks.reconnectLinearWorkspace,
    mocks.getLinearConnect
  ]) {
    fn.mockReset()
  }
  mocks.setChannelAgent.mockResolvedValue(undefined)
  mocks.setChannelTrigger.mockResolvedValue(undefined)
  mocks.deleteIntegration.mockResolvedValue(undefined)
  mocks.getLinearConnect.mockResolvedValue({ id: 'c1', status: 'pending', failureReason: null, botId: null })
  vi.stubGlobal(
    'open',
    vi.fn(() => null)
  )
  vi.stubGlobal(
    'confirm',
    vi.fn(() => true)
  )
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('the workspace chrome', () => {
  it('names the workspace above the team rows', async () => {
    await render()

    expect(text()).toContain('Example Workspace')
    expect(text()).toContain('ENG · Engineering')
    expect(text()).toContain('DES · Design')
  })

  it('says the roster is the workspace’s own, not something the bot was added to', async () => {
    await render()

    expect(text()).toContain('Every team of this workspace is listed here')
    expect(text()).not.toContain('appears here once the bot is added to it')
  })

  it('never offers Disconnect — that removes the workspace for every agent', async () => {
    await render()

    expect(text()).not.toContain('Disconnect')
    expect(buttonWithLabel('Disconnect this workspace')).toBeUndefined()
  })
})

describe('the team rows', () => {
  it('carries a trigger per team, Mention or Off and nothing else', async () => {
    await render()
    await act(async () => buttonWithLabel('Trigger for ENG · Engineering')!.click())

    const menu = [...document.querySelectorAll('[role="menuitemradio"]')].map((o) => o.textContent)
    expect(menu).toEqual(['off', '@-mention'])
    // The platform emits no unaddressed traffic (§6.1), so nothing would match "any message".
    expect(menu).not.toContain('any message')
  })

  it('writes a team’s trigger through the generic per-conversation PATCH', async () => {
    await render()
    await act(async () => buttonWithLabel('Trigger for DES · Design')!.click())
    await act(async () =>
      [...document.querySelectorAll('[role="menuitemradio"]')]
        .at(-1)!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    )
    await settle()

    expect(mocks.setChannelTrigger).toHaveBeenCalledWith('int-a', 'team-des', 'mention')
  })

  it('offers no way out of a team — the roster is upserted, not observed', async () => {
    await render()

    expect(buttonWithLabel('Leave team')).toBeUndefined()
    expect(buttonWithLabel('Remove from this list')).toBeUndefined()
    expect(text()).not.toContain('Remove from this list')
  })

  it('names the room the way Linear does — the trigger copy says team, never channel', async () => {
    await render()

    const markup = document.body.innerHTML
    expect(markup).toContain('this team')
    expect(markup).not.toContain('this channel')
  })
})

describe('the default-dispatch selector', () => {
  it('reads each team’s current owner off its own row', async () => {
    await render()

    expect(dispatchPickers()[0]?.textContent).toContain('triage-bot')
    expect(dispatchPickers()[1]?.textContent).toContain('docs-bot')
  })

  it('moves an unrestricted owner straight away, addressed to the team row', async () => {
    await render()
    await claimRow(1)
    await settle()

    expect(mocks.setChannelAgent).toHaveBeenCalledWith('int-a', 'team-des', 'agent-a')
  })

  it('warns before taking a team off a PRIVATE agent, and writes once confirmed', async () => {
    await render()
    await claimRow(0)

    // §6.2: the default seat IS the gated agent's grant, and a Linear AgentSession has one
    // writer — so its bound sessions are stoppable but never handed to the new default.
    expect(text()).toContain('Move this team’s default?')
    expect(text()).toContain('triage-bot is a private agent')
    expect(text()).toContain('can still be stopped, but it will not answer in them again')
    expect(mocks.setChannelAgent).not.toHaveBeenCalled()

    await act(async () => buttonWithText('Move')!.click())
    await settle()

    expect(mocks.setChannelAgent).toHaveBeenCalledWith('int-a', 'team-eng', 'agent-a')
    expect(text()).not.toContain('Move this team’s default?')
  })

  it('leaves the owner alone when the warning is cancelled', async () => {
    await render()
    await claimRow(0)
    await act(async () => buttonWithText('Cancel')!.click())
    await settle()

    expect(mocks.setChannelAgent).not.toHaveBeenCalled()
    expect(text()).not.toContain('Move this team’s default?')
  })

  it('keeps the warning up when the write is refused', async () => {
    mocks.setChannelAgent.mockRejectedValue(new Error('daemon is offline'))
    await render()
    await claimRow(0)
    await act(async () => buttonWithText('Move')!.click())
    await settle()

    expect(text()).toContain('daemon is offline')
    expect(text()).toContain('Move this team’s default?')
  })
})

describe('the workspace’s repairs', () => {
  it('reconnects THIS workspace and says the tab is open', async () => {
    mocks.reconnectLinearWorkspace.mockResolvedValue({ id: 'c1', connectUrl: 'https://linear.app/oauth/authorize' })
    await render()
    await act(async () => buttonWithLabel('Reconnect this workspace')!.click())
    await settle()

    expect(mocks.reconnectLinearWorkspace).toHaveBeenCalledWith('bot-9')
    expect(text()).toContain('Approve the workspace in the Linear tab')
  })

  it('warns on the row while the grant is dead', async () => {
    mocks.bots = [bot({ revokedAt: '2026-02-01T00:00:00.000Z' })]
    await render()

    expect(text()).toContain('grant expired')
    expect(buttonWithLabel('Reconnect this workspace')?.className).toContain('border-(--status-error)')
  })

  it('surfaces a funnel that cannot start', async () => {
    mocks.reconnectLinearWorkspace.mockRejectedValue(new Error('no relay is connected'))
    await render()
    await act(async () => buttonWithLabel('Reconnect this workspace')!.click())
    await settle()

    expect(text()).toContain('no relay is connected')
  })

  it('unlinks through the generic integration delete, after confirming', async () => {
    await render()
    await act(async () => buttonWithLabel('Remove Example Workspace from this agent')!.click())
    await settle()

    expect(window.confirm).toHaveBeenCalled()
    expect(mocks.deleteIntegration).toHaveBeenCalledWith('int-a')
  })

  it('does nothing when the unlink is not confirmed', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => false)
    )
    await render()
    await act(async () => buttonWithLabel('Remove Example Workspace from this agent')!.click())

    expect(mocks.deleteIntegration).not.toHaveBeenCalled()
  })

  it('shows a refused unlink instead of leaving the row looking gone', async () => {
    mocks.deleteIntegration.mockRejectedValue(new Error('daemon is offline'))
    await render()
    await act(async () => buttonWithLabel('Remove Example Workspace from this agent')!.click())
    await settle()

    expect(text()).toContain('daemon is offline')
  })
})

describe('a private agent’s own card', () => {
  it('says its team rows start off', async () => {
    mocks.agents = [
      { id: 'agent-a', name: 'deploy-bot', runtime: 'claude', visibility: 'restricted' }
    ] as unknown as Agent[]
    await render()

    expect(text()).toContain('This agent is private: conversations start off.')
    expect(text()).toContain('Enable each team below')
    // Linear has no direct messages to promise.
    expect(text()).not.toContain('or direct message')
  })
})
