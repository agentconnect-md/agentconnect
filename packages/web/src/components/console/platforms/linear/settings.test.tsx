// @vitest-environment happy-dom

// The org Bots view's Linear fragments (§7.4). The row carries the two actions that
// belong to the workspace rather than to any one agent: reconnect the grant, and
// disconnect it for the whole organization — the second of which the agent's own card
// deliberately does not offer.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotDto } from '@/lib/api'

const mocks = vi.hoisted(() => ({
  reconnectLinearWorkspace: vi.fn(),
  getLinearConnect: vi.fn(),
  disconnectLinearWorkspace: vi.fn(),
  refresh: vi.fn(),
  deleteIntegration: vi.fn(),
  deleteBot: vi.fn()
}))

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  reconnectLinearWorkspace: mocks.reconnectLinearWorkspace,
  getLinearConnect: mocks.getLinearConnect,
  disconnectLinearWorkspace: mocks.disconnectLinearWorkspace
}))
// The piecewise teardown members stay on the mock so a test can catch the console
// reaching for them: enumerating memberships client-side is exactly the bug this
// dialog was rewritten to remove.
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    refresh: mocks.refresh,
    deleteIntegration: mocks.deleteIntegration,
    deleteBot: mocks.deleteBot
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
  mocks.disconnectLinearWorkspace.mockReset()
  mocks.disconnectLinearWorkspace.mockResolvedValue(undefined)
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

  it('confirms first, naming the consequence for every member — the invisible ones too', async () => {
    await openDialog()

    expect(text()).toContain('Disconnect workspace')
    expect(text()).toContain('all 2 agents that use it')
    expect(text()).toContain('forgets its Linear grant')
    expect(text()).toContain('Agents you cannot see are removed too')
    expect(mocks.disconnectLinearWorkspace).not.toHaveBeenCalled()
  })

  it('tears the workspace down in ONE server call, never a client loop', async () => {
    // `GET /integrations` is visibility-filtered, so a membership on an agent outside
    // the caller's audience is not in the list a loop would walk — it would lift what
    // it can see, the bot delete behind it would refuse on the hidden one, and the
    // operator would be told a full disconnect happened. Only the server holds the
    // authoritative member set, so only the server may spend it.
    await openDialog()
    await act(async () => buttonWithText('Disconnect')!.click())
    await settle()

    expect(mocks.disconnectLinearWorkspace).toHaveBeenCalledWith('bot-9')
    expect(mocks.deleteIntegration).not.toHaveBeenCalled()
    expect(mocks.deleteBot).not.toHaveBeenCalled()
    expect(mocks.refresh).toHaveBeenCalled()
  })

  it('renders a partial teardown as the refusal it is, keeping the dialog open', async () => {
    mocks.disconnectLinearWorkspace.mockRejectedValue(
      new Error('disconnect stopped partway: 1 of 2 agents are still linked to this workspace — retry the disconnect')
    )
    await openDialog()
    await act(async () => buttonWithText('Disconnect')!.click())
    await settle()

    expect(text()).toContain('1 of 2 agents are still linked')
    expect(text()).toContain('Disconnect workspace')
  })

  it('closes without touching anything on cancel', async () => {
    await openDialog()
    await act(async () => buttonWithText('Cancel')!.click())

    expect(text()).toBe('')
    expect(mocks.disconnectLinearWorkspace).not.toHaveBeenCalled()
  })
})
