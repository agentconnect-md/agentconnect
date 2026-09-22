// @vitest-environment happy-dom

// A custom Slack app's bot row takes a replacement bot token in place; a revoked row asks for one.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotDto } from '@/lib/api'

const mocks = vi.hoisted(() => ({
  replaceSlackBotToken: vi.fn(),
  refreshSlackBot: vi.fn(),
  refresh: vi.fn()
}))

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  replaceSlackBotToken: mocks.replaceSlackBotToken,
  refreshSlackBot: mocks.refreshSlackBot
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({ refresh: mocks.refresh, setBotJoinPublicChannels: vi.fn() })
}))

import { SlackReplaceTokenModal } from './replace-token'
import { slackSettingsFragments } from './settings'

const { CardProvider, RowActions } = slackSettingsFragments.lifecycleActions!

function bot(over: Partial<BotDto> = {}): BotDto {
  return {
    id: 'bot-1',
    name: 'custom-app',
    platform: 'slack',
    prebuilt: false,
    slackAppId: 'A0CUSTOM01',
    discordAppId: null,
    createdBy: null,
    transport: 'http',
    shareable: false,
    inUseByAgentId: 'agent-1',
    agentIds: ['agent-1'],
    lastUsedAt: null,
    freedFromAgent: null,
    revokedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over
  }
}

let host: HTMLDivElement
let root: Root

const buttons = () => [...document.body.querySelectorAll('button')]
const byLabel = (label: string) =>
  buttons().find((b) => b.getAttribute('aria-label') === label) as HTMLButtonElement | undefined
const byText = (label: string) =>
  buttons().find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined
const tokenInput = () => document.body.querySelector('input') as HTMLInputElement

async function typeInto(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.replaceSlackBotToken.mockReset()
  mocks.refreshSlackBot.mockReset()
  mocks.refresh.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

describe('SlackReplaceTokenModal', () => {
  it('submits only a Bot User OAuth Token, trimmed, then refreshes and closes', async () => {
    const onClose = vi.fn()
    const onReplaced = vi.fn()
    const updated = bot({ revokedAt: null })
    mocks.replaceSlackBotToken.mockResolvedValue(updated)
    await act(async () => root.render(<SlackReplaceTokenModal bot={bot()} onClose={onClose} onReplaced={onReplaced} />))

    expect(byText('Replace')?.disabled).toBe(true)
    await typeInto(tokenInput(), 'xapp-1-A0CUSTOM01-1-abc')
    expect(byText('Replace')?.disabled).toBe(true)
    expect(tokenInput().className).toContain('border-(--status-error)')

    await typeInto(tokenInput(), '  xoxb-new-token  ')
    expect(byText('Replace')?.disabled).toBe(false)
    await act(async () => byText('Replace')!.click())
    await settle()

    expect(mocks.replaceSlackBotToken).toHaveBeenCalledWith('bot-1', 'xoxb-new-token')
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
    expect(onReplaced).toHaveBeenCalledWith(updated)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the dialog open with the refusal when the token is not accepted', async () => {
    const onClose = vi.fn()
    mocks.replaceSlackBotToken.mockRejectedValue(
      new Error('this token belongs to a different Slack app or workspace than this bot')
    )
    await act(async () => root.render(<SlackReplaceTokenModal bot={bot()} onClose={onClose} />))

    await typeInto(tokenInput(), 'xoxb-other-app')
    await act(async () => byText('Replace')!.click())
    await settle()

    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      'this token belongs to a different Slack app or workspace than this bot'
    )
    expect(onClose).not.toHaveBeenCalled()
    expect(mocks.refresh).not.toHaveBeenCalled()
    expect(byText('Replace')?.disabled).toBe(false)
  })
})

describe('the Slack bot row', () => {
  const renderRow = async (row: BotDto, canWrite = true) => {
    await act(async () =>
      root.render(
        <CardProvider>
          <RowActions bot={row} canWrite={canWrite} />
        </CardProvider>
      )
    )
  }

  it('offers token replacement on a custom app and opens the dialog', async () => {
    await renderRow(bot())

    const action = byLabel('Replace bot token')
    expect(action?.title).toBe('Replace bot token')
    expect(action?.className).not.toContain('border-(--amber-500)')
    await act(async () => action!.click())

    expect(document.body.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Replace bot token')
    expect(tokenInput().placeholder).toBe('xoxb-…')
  })

  it('asks for a new token while the app is revoked', async () => {
    await renderRow(bot({ revokedAt: '2026-02-01T00:00:00.000Z' }))

    const action = byLabel('Replace bot token')
    expect(action?.title).toBe('Reconnect with a new bot token')
    expect(action?.className).toContain('border-(--amber-500)')
  })

  it('offers nothing for the built-in app or to a viewer', async () => {
    await renderRow(bot({ prebuilt: true }))
    expect(byLabel('Replace bot token')).toBeUndefined()
    expect(byLabel('Refresh Slack app')).toBeDefined()

    await renderRow(bot(), false)
    expect(buttons()).toHaveLength(0)
  })
})
