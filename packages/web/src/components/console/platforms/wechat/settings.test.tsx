// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotDto } from '@/lib/api'

const mocks = vi.hoisted(() => ({ startLogin: vi.fn(), getLogin: vi.fn(), refresh: vi.fn() }))

vi.mock('./api', () => ({ weChatApi: { startLogin: mocks.startLogin, getLogin: mocks.getLogin } }))
vi.mock('@/lib/data-context', () => ({ useConsoleData: () => ({ refresh: mocks.refresh }) }))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ user: null, me: null }) }))

import { weChatIdTail, weChatSettingsFragments } from './settings'

function bot(over: Partial<BotDto> = {}): BotDto {
  return {
    id: 'bot-1',
    name: 'WeChat · …a1b2c3',
    platform: 'wechat',
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
    platformConfig: { wechatUserId: 'o9cq80000000a1b2c3@im.wechat', wechatBotId: 'ff00aa@im.bot' },
    createdAt: '2026-11-10T00:00:00.000Z',
    ...over
  }
}

const RowSettings = weChatSettingsFragments.botCard!.RowSettings!
const { CardProvider, RowActions } = weChatSettingsFragments.lifecycleActions!
const CardNotice = weChatSettingsFragments.lifecycleActions!.CardNotice!

let host: HTMLDivElement
let root: Root

async function render(row: BotDto, canWrite = true): Promise<void> {
  await act(async () =>
    root.render(
      <CardProvider>
        <RowSettings bot={row} canWrite={canWrite} />
        <RowActions bot={row} canWrite={canWrite} />
        <CardNotice bot={row} />
      </CardProvider>
    )
  )
}

const buttonWith = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label))

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.startLogin.mockReset().mockResolvedValue({
    id: 'login-1',
    status: 'waiting',
    qrUrl: 'https://liteapp.weixin.qq.com/q/abc',
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    failureReason: null,
    integrationId: null,
    botId: null,
    wechatUserTail: null
  })
  mocks.getLogin.mockReset().mockReturnValue(new Promise(() => {}))
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('WeChat bot settings', () => {
  it('shows only the tail of the bound WeChat user', async () => {
    await render(bot())
    expect(host.textContent).toContain('…a1b2c3')
    expect(host.textContent).not.toContain('o9cq80000000a1b2c3')
    expect(weChatIdTail('o9cq80000000a1b2c3@im.wechat')).toBe('a1b2c3')
    expect(weChatIdTail(undefined)).toBeNull()
  })

  it('reconnects by re-scanning for the bot’s own agent', async () => {
    await render(bot())
    await act(async () => buttonWith('Reconnect')!.click())
    expect(host.textContent).toContain('same WeChat')
    await act(async () => buttonWith('Show QR code')!.click())
    expect(mocks.startLogin).toHaveBeenCalledWith({ agentId: 'agent-a', botId: 'bot-1' })
    expect(host.querySelector('svg[role="img"]')).not.toBeNull()
  })

  it('offers no reconnect to a reader or for a bot no agent holds', async () => {
    await render(bot(), false)
    expect(buttonWith('Reconnect')).toBeUndefined()
    await render(bot({ inUseByAgentId: null, agentIds: [] }))
    expect(buttonWith('Reconnect')).toBeUndefined()
  })
})
