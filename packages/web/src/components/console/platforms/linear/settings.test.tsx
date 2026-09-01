// @vitest-environment happy-dom

// The org Bots view's Linear fragments (§7.4). The row carries the two actions that
// belong to the workspace rather than to any one agent: reconnect the grant, and
// disconnect it for the whole organization — the second of which the agent's own card
// deliberately does not offer.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotDto } from '@/lib/api'
import type { IntegrationRow } from '@/lib/data'

const mocks = vi.hoisted(() => ({
  reconnectLinearWorkspace: vi.fn(),
  getLinearConnect: vi.fn(),
  refresh: vi.fn(),
  deleteIntegration: vi.fn(),
  deleteBot: vi.fn(),
  integrations: [] as IntegrationRow[]
}))

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  reconnectLinearWorkspace: mocks.reconnectLinearWorkspace,
  getLinearConnect: mocks.getLinearConnect
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    refresh: mocks.refresh,
    deleteIntegration: mocks.deleteIntegration,
    deleteBot: mocks.deleteBot,
    get integrations() {
      return mocks.integrations
    }
  })
}))

import { linearSettingsFragments } from './settings'

const fragments = linearSettingsFragments.lifecycleActions!
const { CardProvider, RowActions } = fragments
const CardNotice = fragments.CardNotice!

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

let host: HTMLDivElement
let root: Root

const text = () => host.textContent ?? ''
const buttons = () => [...host.querySelectorAll('button')]
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

async function renderCard(row: BotDto, canWrite = true): Promise<void> {
  await act(async () =>
    root.render(
      <CardProvider>
        <RowActions bot={row} canWrite={canWrite} />
        <CardNotice bot={row} />
      </CardProvider>
    )
  )
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.reconnectLinearWorkspace.mockReset()
  mocks.getLinearConnect.mockReset()
  mocks.refresh.mockReset()
  mocks.deleteIntegration.mockReset()
  mocks.deleteBot.mockReset()
  mocks.deleteIntegration.mockResolvedValue(undefined)
  mocks.deleteBot.mockResolvedValue(undefined)
  mocks.integrations = []
  mocks.getLinearConnect.mockResolvedValue({ id: 'c1', status: 'pending', failureReason: null, botId: null })
  vi.stubGlobal(
    'open',
    vi.fn(() => null)
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

describe('the workspace row’s lifecycle actions', () => {
  it('offers reconnect and disconnect, and stays quiet otherwise', async () => {
    await renderCard(bot())

    expect(buttonWithLabel('Reconnect this workspace')).toBeDefined()
    expect(buttonWithLabel('Disconnect this workspace')).toBeDefined()
    // A healthy workspace gets no standing band: the row already carries its state,
    // and a permanent "delegations not arriving?" note reads as a problem report.
    expect(text()).toBe('')
  })

  it('gives a viewer neither write action', async () => {
    await renderCard(bot(), false)

    expect(buttonWithLabel('Reconnect this workspace')?.disabled).toBe(true)
    expect(buttonWithLabel('Disconnect this workspace')).toBeUndefined()
  })

  it('haloes reconnect while the grant is known dead', async () => {
    await renderCard(bot({ revokedAt: '2026-02-01T00:00:00.000Z' }))

    expect(buttonWithLabel('Reconnect this workspace')?.className).toContain('border-(--status-error)')
  })

  it('restarts the funnel against THIS workspace, never the org-level connect', async () => {
    // The nonce is bound to the bot, so a reconnect can only ever re-authorize the
    // workspace it was minted for (§7.4).
    mocks.reconnectLinearWorkspace.mockResolvedValue({ id: 'c1', connectUrl: 'https://linear.app/oauth/authorize' })
    await renderCard(bot({ revokedAt: '2026-02-01T00:00:00.000Z' }))
    await act(async () => buttonWithLabel('Reconnect this workspace')!.click())
    await settle()

    expect(mocks.reconnectLinearWorkspace).toHaveBeenCalledWith('bot-9')
    expect(window.open).toHaveBeenCalled()
    expect(text()).toContain('Approve the workspace in the Linear tab')
  })

  it('reports a funnel that cannot start at all', async () => {
    mocks.reconnectLinearWorkspace.mockRejectedValue(new Error('no relay is connected'))
    await renderCard(bot({ revokedAt: '2026-02-01T00:00:00.000Z' }))
    await act(async () => buttonWithLabel('Reconnect this workspace')!.click())
    await settle()

    expect(text()).toContain('no relay is connected')
  })
})

describe('disconnecting a workspace', () => {
  const openDialog = async (row: BotDto = bot()) => {
    await renderCard(row)
    await act(async () => buttonWithLabel('Disconnect this workspace')!.click())
  }

  it('confirms first, naming the consequence for every member', async () => {
    await openDialog()

    expect(text()).toContain('Disconnect workspace')
    expect(text()).toContain('all 2 agents that use it')
    expect(text()).toContain('forgets its Linear grant')
    expect(mocks.deleteBot).not.toHaveBeenCalled()
  })

  it('lifts every membership before the bot delete the CP would otherwise refuse', async () => {
    // `DELETE /bots/:id` 409s while any agent is installed, so the memberships go
    // first — in the order the dialog's own sentence describes.
    mocks.integrations = [
      { id: 'int-a', botId: 'bot-9' },
      { id: 'int-b', botId: 'bot-9' },
      { id: 'int-other', botId: 'bot-other' }
    ] as unknown as IntegrationRow[]
    await openDialog()
    await act(async () => buttonWithText('Disconnect')!.click())
    await settle()

    expect(mocks.deleteIntegration.mock.calls.map(([id]) => id)).toEqual(['int-a', 'int-b'])
    expect(mocks.deleteBot).toHaveBeenCalledWith('bot-9')
  })

  it('stops on a refused membership rather than firing the delete behind it', async () => {
    mocks.integrations = [{ id: 'int-a', botId: 'bot-9' }] as unknown as IntegrationRow[]
    mocks.deleteIntegration.mockRejectedValue(new Error('daemon is offline'))
    await openDialog()
    await act(async () => buttonWithText('Disconnect')!.click())
    await settle()

    expect(text()).toContain('daemon is offline')
    expect(mocks.deleteBot).not.toHaveBeenCalled()
  })

  it('closes without touching anything on cancel', async () => {
    await openDialog()
    await act(async () => buttonWithText('Cancel')!.click())

    expect(text()).toBe('')
    expect(mocks.deleteIntegration).not.toHaveBeenCalled()
    expect(mocks.deleteBot).not.toHaveBeenCalled()
  })
})
