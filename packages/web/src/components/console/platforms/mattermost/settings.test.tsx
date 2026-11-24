// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type BotDto } from '@/lib/api'

const mocks = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }))

vi.mock('./api', () => ({ replaceMattermostBotToken: mocks.replace }))
vi.mock('@/lib/data-context', () => ({ useConsoleData: () => ({ refresh: mocks.refresh }) }))

import { mattermostSettingsFragments } from './settings'

function bot(over: Partial<BotDto> = {}): BotDto {
  return {
    id: 'bot-1',
    name: 'Mattermost · agent-bot',
    platform: 'mattermost',
    prebuilt: false,
    slackAppId: null,
    discordAppId: null,
    createdBy: null,
    transport: 'socket',
    shareable: false,
    inUseByAgentId: 'agent-a',
    agentIds: ['agent-a'],
    lastUsedAt: null,
    freedFromAgent: null,
    externalAppId: 'mm-0123456789abcdef',
    externalTenantId: 'u1234567890123456789012345',
    platformConfig: {
      serverUrl: 'https://mm.example.com',
      botUserId: 'u1234567890123456789012345',
      botUsername: 'agent-bot'
    },
    createdAt: '2026-11-21T00:00:00.000Z',
    ...over
  }
}

const { CardProvider, RowActions } = mattermostSettingsFragments.lifecycleActions!
const CardNotice = mattermostSettingsFragments.lifecycleActions!.CardNotice!

let host: HTMLDivElement
let root: Root

async function render(row: BotDto, canWrite = true): Promise<void> {
  await act(async () =>
    root.render(
      <CardProvider>
        <RowActions bot={row} canWrite={canWrite} />
        <CardNotice bot={row} />
      </CardProvider>
    )
  )
}

const buttonWith = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label))

async function typeToken(value: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.replace.mockReset().mockResolvedValue(undefined)
  mocks.refresh.mockReset().mockResolvedValue(undefined)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('Mattermost bot settings', () => {
  it('offers no token replacement to a member who cannot write', async () => {
    await render(bot(), false)
    expect(buttonWith('Replace token')).toBeUndefined()
  })

  it('explains that the replacement token is verified without disconnecting the running bot', async () => {
    await render(bot())
    await act(async () => buttonWith('Replace token')!.click())
    expect(host.textContent).toContain('verifies the new token against your Mattermost server')
    expect(host.textContent).toContain('without disconnecting the running bot')
    expect(host.querySelector('input')!.type).toBe('password')
  })

  it('saves the trimmed token for this bot, refreshes console data, and confirms the reconnect', async () => {
    await render(bot())
    await act(async () => buttonWith('Replace token')!.click())
    await typeToken(' new-mm-token ')
    await act(async () => buttonWith('Save')!.click())
    expect(mocks.replace).toHaveBeenCalledWith('bot-1', 'new-mm-token')
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Token saved. The bot reconnects with it.')
    expect(host.querySelector('input')!.value).toBe('')
  })

  it('localizes known error codes with role="alert" and skips refresh on failure', async () => {
    mocks.replace.mockRejectedValueOnce(new ApiError('raw CP msg', 400, 'MATTERMOST_CREDENTIALS_INVALID'))
    await render(bot())
    await act(async () => buttonWith('Replace token')!.click())
    await typeToken('bad-token')
    await act(async () => buttonWith('Save')!.click())
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Mattermost rejected this Bot Token.')
    expect(mocks.refresh).not.toHaveBeenCalled()

    mocks.replace.mockRejectedValueOnce(new ApiError('raw CP msg', 400, 'MATTERMOST_SERVER_URL_INVALID'))
    await typeToken('bad-url-tok')
    await act(async () => buttonWith('Save')!.click())
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Enter a valid http:// or https://')

    mocks.replace.mockRejectedValueOnce(new ApiError('raw CP msg', 400, 'MATTERMOST_BOT_MISMATCH'))
    await typeToken('wrong-user-token')
    await act(async () => buttonWith('Save')!.click())
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('different Mattermost account')

    mocks.replace.mockRejectedValueOnce(new Error('Mattermost bot not found.'))
    await typeToken('another-token')
    await act(async () => buttonWith('Save')!.click())
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Mattermost bot not found.')
    expect(mocks.refresh).not.toHaveBeenCalled()
    expect(host.querySelector('input')).not.toBeNull()
  })

  it('surfaces a visible alert and emphasizes token replacement when revoked or rejected', async () => {
    await render(bot({ revokedAt: '2026-11-21T01:00:00.000Z' }))
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Mattermost rejected this bot’s token.')
    expect(buttonWith('Replace token')?.className).toContain('amber-500')

    await render(
      bot({
        revokedAt: null,
        credentialRejectedAt: '2026-11-21T02:00:00.000Z',
        credentialRejectedCode: 'tokens_revoked'
      })
    )
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('tokens_revoked')
  })
})
