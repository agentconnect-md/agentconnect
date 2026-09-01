// @vitest-environment happy-dom

// The AGENT page's Linear card: one row per linked workspace, with its owner, a reconnect
// and a way out. What must NOT be there matters as much: no trigger, no issue list, and no
// Disconnect — that one ends the workspace for every agent, so it is the org view's.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotDto } from '@/lib/api'
import type { Agent, IntegrationRow } from '@/lib/data'

const mocks = vi.hoisted(() => ({
  bots: [] as BotDto[],
  agents: [] as Agent[],
  setChannelAgent: vi.fn(),
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
    getAgent: (id: string) => mocks.agents.find((a) => a.id === id),
    setChannelAgent: mocks.setChannelAgent,
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
    agentIds: ['agent-a', 'agent-b'],
    lastUsedAt: null,
    freedFromAgent: null,
    workspaceName: 'Example Workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over
  }
}

/** The workspace's conversation row — the seeded `IntegrationChannel` the PATCH addresses. */
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
    agentCount: '2',
    channels: [{ channelId: 'ws-1', name: 'Example Workspace', trigger: 'any', agentId: 'agent-b' }],
    ...over
  }
}

let host: HTMLDivElement
let root: Root

const text = () => host.textContent ?? ''
const buttons = () => [...host.querySelectorAll('button')]
const buttonWithLabel = (label: string) =>
  buttons().find((b) => b.getAttribute('aria-label')?.includes(label)) as HTMLButtonElement | undefined
const buttonWithTitle = (title: string) =>
  buttons().find((b) => b.getAttribute('title')?.includes(title)) as HTMLButtonElement | undefined

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

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.bots = [bot()]
  mocks.agents = [
    { id: 'agent-a', name: 'deploy-bot', runtime: 'claude' },
    { id: 'agent-b', name: 'triage-bot', runtime: 'codex' }
  ] as unknown as Agent[]
  mocks.setChannelAgent.mockReset()
  mocks.deleteIntegration.mockReset()
  mocks.refresh.mockReset()
  mocks.reconnectLinearWorkspace.mockReset()
  mocks.getLinearConnect.mockReset()
  mocks.setChannelAgent.mockResolvedValue(undefined)
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

describe('the workspace row', () => {
  it('names the workspace and says where sessions come from — no issue list, no trigger', async () => {
    await render()

    expect(text()).toContain('Example Workspace')
    expect(text()).toContain('Sessions start when someone delegates or mentions the app on an issue in this workspace.')
    // Linking is the consent act and unlinking is the mute, so no trigger belongs here.
    expect(text()).not.toContain('@-mention')
    expect(buttonWithLabel('Trigger for')).toBeUndefined()
  })

  it('never offers Disconnect — that removes the workspace for every agent', async () => {
    await render()

    expect(text()).not.toContain('Disconnect')
    expect(buttonWithLabel('Disconnect this workspace')).toBeUndefined()
  })
})

describe('the default-dispatch selector', () => {
  it('reads the workspace’s current owner off the ordinary conversation row', async () => {
    await render()

    // The owner the CP stamped, not this agent just because it is the page's.
    expect(buttonWithTitle('Default dispatch')?.textContent).toContain('triage-bot')
  })

  it('drives the existing conversation-owner PATCH, addressed to the workspace row', async () => {
    await render()
    await act(async () => buttonWithTitle('Default dispatch')!.click())
    const option = buttons().find((b) => b.textContent?.includes('deploy-bot'))!
    await act(async () => option.click())
    await settle()

    expect(mocks.setChannelAgent).toHaveBeenCalledWith('int-a', 'ws-1', 'agent-a')
  })

  it('offers every member of the workspace as a candidate owner', async () => {
    await render()
    await act(async () => buttonWithTitle('Default dispatch')!.click())

    expect(buttons().filter((b) => b.textContent?.includes('deploy-bot')).length).toBeGreaterThan(0)
    expect(buttons().filter((b) => b.textContent?.includes('triage-bot')).length).toBeGreaterThan(0)
  })

  it('falls back to the earliest member, inert, until the conversation row is seeded', async () => {
    // An install reporting no seeded row has no address to PATCH, so the selector is inert.
    await render(integration({ channels: [] }))

    expect(text()).toContain('Example Workspace')
    const picker = buttonWithTitle('Default dispatch')!
    expect(picker.textContent).toContain('deploy-bot')
    await act(async () => picker.click())
    expect(buttons().filter((b) => b.textContent?.includes('triage-bot'))).toHaveLength(0)
  })
})

describe('the row’s repairs', () => {
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
