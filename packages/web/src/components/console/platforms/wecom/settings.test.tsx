// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotDto } from '@/lib/api'

const mocks = vi.hoisted(() => ({ replace: vi.fn() }))

vi.mock('./api', () => ({ replaceWeComBotSecret: mocks.replace }))

import { weComSettingsFragments } from './settings'

function bot(over: Partial<BotDto> = {}): BotDto {
  return {
    id: 'bot-1',
    name: 'WeCom · aibot-example',
    platform: 'wecom',
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
    createdAt: '2026-11-11T00:00:00.000Z',
    ...over
  }
}

const { CardProvider, RowActions } = weComSettingsFragments.lifecycleActions!
const CardNotice = weComSettingsFragments.lifecycleActions!.CardNotice!

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

async function typeSecret(value: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.replace.mockReset().mockResolvedValue(undefined)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('WeCom bot settings', () => {
  it('offers no secret replacement to a member who cannot write', async () => {
    await render(bot(), false)
    expect(buttonWith('Replace secret')).toBeUndefined()
  })

  it('says plainly that the new Secret is not tested and that the bot reconnects with it', async () => {
    await render(bot())
    await act(async () => buttonWith('Replace secret')!.click())
    expect(host.textContent).toContain('AgentConnect does not test the new Secret')
    expect(host.textContent).toContain('testing it would disconnect the running bot')
    expect(host.textContent).toContain('The bot reconnects with the new Secret')
    expect(host.querySelector('input')!.type).toBe('password')
    // Nothing is checked, so the button never claims to be checking.
    expect(buttonWith('Checking')).toBeUndefined()
  })

  it('saves the trimmed Secret for this bot and confirms the reconnect', async () => {
    await render(bot())
    await act(async () => buttonWith('Replace secret')!.click())
    await typeSecret(' secret-placeholder ')
    await act(async () => buttonWith('Save')!.click())
    expect(mocks.replace).toHaveBeenCalledWith('bot-1', 'secret-placeholder')
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Secret saved. The bot reconnects with it.')
    expect(host.querySelector('input')!.value).toBe('')
  })

  it('shows the Control Plane’s refusal and keeps the form open', async () => {
    mocks.replace.mockRejectedValue(new Error('WeCom bot not found.'))
    await render(bot())
    await act(async () => buttonWith('Replace secret')!.click())
    await typeSecret('secret-placeholder')
    await act(async () => buttonWith('Save')!.click())
    expect(host.querySelector('[role="status"]')?.textContent).toBe('WeCom bot not found.')
    expect(host.querySelector('input')).not.toBeNull()
  })
})
