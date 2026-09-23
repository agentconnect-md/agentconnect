// @vitest-environment happy-dom

// The agent page's Slack card: a revoked app's repair in the header — reinstall or a new token — and its progress under it.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotDto } from '@/lib/api'
import type { IntegrationRow } from '@/lib/data'

const mocks = vi.hoisted(() => ({
  startSlackPlatformInstall: vi.fn(),
  getSlackPlatformInstall: vi.fn(),
  refresh: vi.fn(),
  bots: [] as unknown[],
  role: 'owner'
}))

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  startSlackPlatformInstall: mocks.startSlackPlatformInstall,
  getSlackPlatformInstall: mocks.getSlackPlatformInstall
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({ bots: mocks.bots, refresh: mocks.refresh })
}))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ myRole: mocks.role }) }))

import { platformAgentCard } from '../registry'

const card = platformAgentCard('slack')!
const { CardProvider, HeaderActions, Notice } = card as Required<typeof card>

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

function integration(revoked = true): IntegrationRow {
  return {
    id: 'int-1',
    agentId: 'agent-1',
    botId: 'bot-1',
    shareable: false,
    name: 'Example Workspace',
    platform: 'slack',
    kind: 'Built-in app',
    workspace: '—',
    daemon: 'd1',
    status: revoked ? 'offline' : 'online',
    revoked,
    channels: []
  }
}

let host: HTMLDivElement
let root: Root

const buttons = () => [...document.body.querySelectorAll('button')]
const byLabel = (label: string) =>
  buttons().find((b) => b.getAttribute('aria-label') === label) as HTMLButtonElement | undefined

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function renderCard(row = integration()): Promise<void> {
  await act(async () =>
    root.render(
      <CardProvider integration={row}>
        <div data-header>
          <HeaderActions integration={row} />
        </div>
        <Notice integration={row} padX={16} />
      </CardProvider>
    )
  )
}

const header = () => host.querySelector('[data-header]') as HTMLElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.startSlackPlatformInstall.mockReset()
  mocks.getSlackPlatformInstall.mockReset()
  mocks.refresh.mockReset()
  mocks.startSlackPlatformInstall.mockResolvedValue({ id: 'install-1', installUrl: 'https://slack.example.test/oauth' })
  mocks.bots = [bot()]
  mocks.role = 'owner'
  vi.spyOn(window, 'open').mockReturnValue(null)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('the agent page’s Slack card', () => {
  it('keeps the generic rows: no Body of its own', () => {
    expect(card.Body).toBeUndefined()
  })

  it('offers a revoked built-in app a haloed reinstall, and reports it in flight under the header', async () => {
    mocks.getSlackPlatformInstall.mockResolvedValue({
      id: 'install-1',
      status: 'pending',
      failureReason: null,
      missingScopes: [],
      botId: null
    })
    await renderCard()

    const reinstall = byLabel('Reinstall the Slack app')!
    expect(reinstall.title).toBe('Reinstall the Slack app')
    expect(reinstall.className).toContain('border-(--status-error)')
    expect(reinstall.className).toContain('text-(--status-error)')
    expect(byLabel('Replace bot token')).toBeUndefined()
    expect(host.querySelector('[role="status"]')).toBeNull()

    await act(async () => reinstall.click())
    await settle()

    expect(mocks.startSlackPlatformInstall).toHaveBeenCalledWith({ botId: 'bot-1' })
    expect(reinstall.title).toBe('Reinstalling…')
    expect(reinstall.querySelector('svg')?.getAttribute('class')).toContain('animate-spin')
    const notice = header().nextElementSibling as HTMLElement
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.textContent).toBe('Reinstalling…')
    expect(notice.style.padding).toBe('10px 16px')

    // A closed popup cannot report itself, so the pending reinstall stays clickable and restarts.
    expect(reinstall.disabled).toBe(false)
    mocks.startSlackPlatformInstall.mockResolvedValue({
      id: 'install-2',
      installUrl: 'https://slack.example.test/oauth-2'
    })
    await act(async () => reinstall.click())
    await settle()
    expect(mocks.startSlackPlatformInstall).toHaveBeenCalledTimes(2)
    expect(mocks.getSlackPlatformInstall).toHaveBeenLastCalledWith('install-2')
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Reinstalling…')
  })

  it('reads the console again once the reinstall lands', async () => {
    mocks.getSlackPlatformInstall.mockResolvedValue({
      id: 'install-1',
      status: 'completed',
      failureReason: null,
      missingScopes: [],
      botId: 'bot-1'
    })
    await renderCard()
    await act(async () => byLabel('Reinstall the Slack app')!.click())
    await settle()

    expect(mocks.refresh).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[role="status"], [role="alert"]')).toBeNull()
  })

  it('shows a failed reinstall as the settings card words it, and clears it on the next try', async () => {
    mocks.getSlackPlatformInstall.mockResolvedValue({
      id: 'install-1',
      status: 'failed',
      failureReason: 'denied',
      missingScopes: [],
      botId: null
    })
    await renderCard()
    await act(async () => byLabel('Reinstall the Slack app')!.click())
    await settle()

    const alert = header().nextElementSibling as HTMLElement
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toBe('The reinstall was cancelled in Slack.')
    expect(mocks.refresh).not.toHaveBeenCalled()

    mocks.getSlackPlatformInstall.mockResolvedValue({
      id: 'install-2',
      status: 'pending',
      failureReason: null,
      missingScopes: [],
      botId: null
    })
    await act(async () => byLabel('Reinstall the Slack app')!.click())
    await settle()
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Reinstalling…')
  })

  it('offers a revoked custom app a new bot token, marked as needing attention', async () => {
    mocks.bots = [bot({ prebuilt: false })]
    await renderCard()

    const replace = byLabel('Replace bot token')!
    expect(replace.title).toBe('Reconnect with a new bot token')
    expect(replace.className).toContain('border-(--amber-500)')
    expect(byLabel('Reinstall the Slack app')).toBeUndefined()

    await act(async () => replace.click())
    expect(document.body.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Replace bot token')
  })

  it('offers nothing while the integration is live', async () => {
    mocks.bots = [bot({ revokedAt: null })]
    await renderCard(integration(false))
    expect(buttons()).toHaveLength(0)

    mocks.bots = [bot({ prebuilt: false, revokedAt: null })]
    await renderCard(integration(false))
    expect(buttons()).toHaveLength(0)
  })

  it('offers nothing to a viewer', async () => {
    mocks.role = 'viewer'
    await renderCard()
    expect(buttons()).toHaveLength(0)

    mocks.bots = [bot({ prebuilt: false })]
    await renderCard()
    expect(buttons()).toHaveLength(0)
  })
})
