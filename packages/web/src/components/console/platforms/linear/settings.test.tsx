// @vitest-environment happy-dom

// The workspace card (§7.4). Three states it has to get right: a live workspace with
// its members and their default, a dead grant whose repair is the reconnect funnel,
// and the ONE removal the console must refuse — dropping the default member, which
// would leave every bare delegation with nowhere to go.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotDto } from '@/lib/api'

const mocks = vi.hoisted(() => ({
  reconnectLinearWorkspace: vi.fn(),
  getLinearConnect: vi.fn(),
  setBotPreferredAgent: vi.fn(),
  deleteIntegration: vi.fn(),
  refresh: vi.fn(),
  integrations: [] as { id?: string; botId?: string; agentId?: string }[],
  // Per-agent placement/visibility, which is what the default derivation reads.
  agents: {} as Record<string, { visibility?: string; placementKind?: string; setId?: string | null; daemon?: string }>
}))

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  reconnectLinearWorkspace: mocks.reconnectLinearWorkspace,
  getLinearConnect: mocks.getLinearConnect,
  setBotPreferredAgent: mocks.setBotPreferredAgent
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    refresh: mocks.refresh,
    deleteIntegration: mocks.deleteIntegration,
    integrations: mocks.integrations,
    // A glyph icon keeps the member rows from reaching for a runtime brand image.
    getAgent: (id: string) => ({
      id,
      name: id,
      runtime: 'claude',
      icon: { kind: 'glyph', glyph: 'bot', color: '#333' },
      visibility: 'org',
      placementKind: 'daemon',
      setId: null,
      daemon: 'daemon-1',
      ...mocks.agents[id]
    })
  })
}))

import {
  linearSettingsFragments,
  LINEAR_DEFAULT_REMOVE_BLOCKED,
  LINEAR_INELIGIBLE_DEFAULT,
  LINEAR_MAYBE_DEFAULT_REMOVE_BLOCKED
} from './settings'

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
const buttonWithText = (label: string) => buttons().find((b) => b.textContent?.includes(label))
const buttonWithLabel = (label: string) =>
  buttons().find((b) => b.getAttribute('aria-label')?.includes(label)) as HTMLButtonElement | undefined

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function renderCard(row: BotDto): Promise<void> {
  await act(async () =>
    root.render(
      <CardProvider>
        <RowActions bot={row} canWrite />
        <CardNotice bot={row} />
      </CardProvider>
    )
  )
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.reconnectLinearWorkspace.mockReset()
  mocks.getLinearConnect.mockReset()
  mocks.setBotPreferredAgent.mockReset()
  mocks.deleteIntegration.mockReset()
  mocks.refresh.mockReset()
  mocks.agents = {}
  mocks.getLinearConnect.mockResolvedValue({ id: 'c1', status: 'pending', failureReason: null, botId: null })
  mocks.integrations = [
    { id: 'int-a', botId: 'bot-9', agentId: 'agent-a' },
    { id: 'int-b', botId: 'bot-9', agentId: 'agent-b' }
  ]
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

describe('the workspace card, live', () => {
  it('shows the workspace, its connect status and its members with the default marked', async () => {
    await renderCard(bot({ preferredAgentId: 'agent-b' }))

    expect(text()).toContain('connected')
    expect(text()).toContain('Example Workspace')
    expect(text()).toContain('agent-a')
    expect(text()).toContain('agent-b')
    // One default, and it is the persisted one — the other member offers the move.
    expect(host.querySelectorAll('.badge')).toHaveLength(2) // status pill + default badge
    expect(buttonWithText('Make default')).toBeDefined()
  })

  it('offers the reconnect CTA on a healthy workspace too — a silent one keeps a valid token', async () => {
    // §15: enabling agent session events raises a new scope, and until every prior
    // authorization re-consents the workspace receives nothing while looking fine.
    await renderCard(bot())
    expect(text()).toContain('Reconnect to re-consent')
    expect(buttonWithLabel('Reconnect this workspace')).toBeDefined()
  })

  it('moves the default through the bot patch', async () => {
    mocks.setBotPreferredAgent.mockResolvedValue(bot({ preferredAgentId: 'agent-b' }))
    await renderCard(bot({ preferredAgentId: 'agent-a' }))
    await act(async () => buttonWithText('Make default')!.click())
    await settle()

    expect(mocks.setBotPreferredAgent).toHaveBeenCalledWith('bot-9', 'agent-b')
    expect(mocks.refresh).toHaveBeenCalled()
  })

  it('surfaces the CP’s refusal instead of pretending the move landed', async () => {
    mocks.setBotPreferredAgent.mockRejectedValue(new Error('default agent must be an agent that uses this bot'))
    await renderCard(bot({ preferredAgentId: 'agent-a' }))
    await act(async () => buttonWithText('Make default')!.click())
    await settle()

    expect(text()).toContain('default agent must be an agent that uses this bot')
  })
})

describe('the workspace card, dead grant', () => {
  it('says the grant expired and points at the reconnect', async () => {
    await renderCard(bot({ revokedAt: '2026-02-01T00:00:00.000Z' }))

    expect(text()).toContain('grant expired')
    expect(text()).toContain('reconnect to restore delivery')
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

describe('removing a member', () => {
  it('blocks the default member and says what to do first', async () => {
    await renderCard(bot({ preferredAgentId: 'agent-a' }))
    const remove = buttonWithLabel('Remove agent-a')!

    expect(remove.disabled).toBe(true)
    expect(remove.getAttribute('title')).toBe(LINEAR_DEFAULT_REMOVE_BLOCKED)
    await act(async () => remove.click())
    expect(mocks.deleteIntegration).not.toHaveBeenCalled()
  })

  it('removes a non-default member through its own integration', async () => {
    mocks.deleteIntegration.mockResolvedValue(undefined)
    await renderCard(bot({ preferredAgentId: 'agent-a' }))
    await act(async () => buttonWithLabel('Remove agent-b')!.click())
    await settle()

    expect(mocks.deleteIntegration).toHaveBeenCalledWith('int-b')
  })

  it('blocks whichever member is the EFFECTIVE default, pointer or not', async () => {
    // With no persisted pointer the earliest ELIGIBLE member catches bare delegations,
    // so it is the one that must not be removable.
    await renderCard(bot({ preferredAgentId: null }))
    expect(buttonWithLabel('Remove agent-a')!.disabled).toBe(true)
    expect(buttonWithLabel('Remove agent-b')!.disabled).toBe(false)
  })

  it('follows the compiler past a member it would skip, and protects the real default', async () => {
    // The regression: a membership-order read marks the restricted first member and
    // leaves the routable one removable — deleting the workspace's actual default.
    mocks.agents = { 'agent-a': { visibility: 'restricted' } }
    await renderCard(bot({ preferredAgentId: 'agent-a' }))

    expect(buttonWithLabel('Remove agent-a')!.disabled).toBe(false)
    const realDefault = buttonWithLabel('Remove agent-b')!
    expect(realDefault.disabled).toBe(true)
    expect(realDefault.getAttribute('title')).toBe(LINEAR_DEFAULT_REMOVE_BLOCKED)
  })

  it('protects every member that could be the default while a duty hold is unknowable', async () => {
    // A set placement is routable only while some member holds the duty, which the
    // console cannot see — so both A and the member behind it stay protected.
    mocks.agents = { 'agent-a': { placementKind: 'set', setId: 'set-1', daemon: 'pool' } }
    await renderCard(bot({ preferredAgentId: null }))

    expect(buttonWithLabel('Remove agent-a')!.disabled).toBe(true)
    const behind = buttonWithLabel('Remove agent-b')!
    expect(behind.disabled).toBe(true)
    expect(behind.getAttribute('title')).toBe(LINEAR_MAYBE_DEFAULT_REMOVE_BLOCKED)
  })
})

describe('naming a default', () => {
  it('refuses a member the compile would ignore anyway', async () => {
    // Persisting a pointer at a restricted agent writes a preference nothing honors.
    mocks.agents = { 'agent-b': { visibility: 'restricted' } }
    await renderCard(bot({ preferredAgentId: 'agent-a' }))
    const make = buttonWithText('Make default') as HTMLButtonElement

    expect(make.disabled).toBe(true)
    expect(make.getAttribute('title')).toBe(LINEAR_INELIGIBLE_DEFAULT)
    await act(async () => make.click())
    expect(mocks.setBotPreferredAgent).not.toHaveBeenCalled()
  })
})
