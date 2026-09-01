// @vitest-environment happy-dom

// The workspace card (§7.4). Two states it has to get right: a live workspace, whose
// reconnect CTA is offered anyway, and a dead grant whose repair is the reconnect
// funnel — bound to that workspace and never to the org-level connect.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotDto } from '@/lib/api'

const mocks = vi.hoisted(() => ({
  reconnectLinearWorkspace: vi.fn(),
  getLinearConnect: vi.fn(),
  refresh: vi.fn()
}))

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  reconnectLinearWorkspace: mocks.reconnectLinearWorkspace,
  getLinearConnect: mocks.getLinearConnect
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({ refresh: mocks.refresh })
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
  mocks.refresh.mockReset()
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

describe('the workspace card, live', () => {
  it('shows the workspace and its connect status', async () => {
    await renderCard(bot())

    expect(text()).toContain('connected')
    expect(text()).toContain('Example Workspace')
  })

  it('offers the reconnect CTA on a healthy workspace too — a silent one keeps a valid token', async () => {
    // §15: enabling agent session events raises a new scope, and until every prior
    // authorization re-consents the workspace receives nothing while looking fine.
    await renderCard(bot())
    expect(text()).toContain('Reconnect to re-consent')
    expect(buttonWithLabel('Reconnect this workspace')).toBeDefined()
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
