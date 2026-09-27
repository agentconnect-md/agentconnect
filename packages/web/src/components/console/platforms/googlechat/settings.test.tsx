// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotDto } from '@/lib/api'

const mocks = vi.hoisted(() => ({ replaceKey: vi.fn(), refresh: vi.fn() }))

vi.mock('../deployment-config', () => ({
  useDeploymentConfig: () => ({
    config: { relayPublicUrl: 'https://relay.example.test' },
    failed: false,
    apply: vi.fn()
  })
}))
vi.mock('./api', () => ({ googleChatApi: { replaceKey: mocks.replaceKey } }))
vi.mock('@/lib/data-context', () => ({ useConsoleData: () => ({ refresh: mocks.refresh }) }))

import { ApiError } from '@/lib/api'
import { GoogleChatBotSettings } from './settings'

const KEY = JSON.stringify({
  client_email: 'chat-app@example-project.iam.gserviceaccount.com',
  private_key: 'synthetic'
})

function bot(over: Partial<BotDto> = {}): BotDto {
  return {
    id: 'bot-1',
    name: 'Google Chat · example-project',
    platform: 'googlechat',
    prebuilt: false,
    slackAppId: null,
    discordAppId: null,
    createdBy: null,
    transport: 'http',
    shareable: false,
    inUseByAgentId: 'agent-a',
    agentIds: ['agent-a'],
    lastUsedAt: null,
    freedFromAgent: null,
    externalAppId: '123456789012',
    platformConfig: { projectId: 'example-project' },
    createdAt: '2026-09-27T00:00:00.000Z',
    ...over
  }
}

let host: HTMLDivElement
let root: Root

async function render(b: BotDto, canWrite = true): Promise<void> {
  await act(async () => root.render(<GoogleChatBotSettings bot={b} canWrite={canWrite} />))
}

const keyInput = () => host.querySelector<HTMLInputElement>('input[type="password"]')

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function submit(): Promise<void> {
  await act(async () =>
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  )
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.replaceKey.mockReset()
  mocks.refresh.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('GoogleChatBotSettings', () => {
  it('shows the app identity, the endpoint to check, the key state and the scope as facts', async () => {
    await render(bot({ credentialRejectedAt: '2026-09-27T00:00:00.000Z', credentialRejectedCode: 'invalid_grant' }))
    const text = host.textContent ?? ''
    expect(text).toContain('example-project')
    expect(text).toContain('123456789012')
    expect(text).toContain('https://relay.example.test/googlechat/events')
    expect(text).toContain('Rejected by Google (invalid_grant)')
    expect(text).toContain('Answers in a space only when mentioned')
    expect(text).toContain('Attachments, cards, and group direct messages are not supported.')
  })

  it('replaces the key, then clears it and refreshes the bot', async () => {
    mocks.replaceKey.mockResolvedValue(bot())
    await render(bot())
    await type(keyInput()!, KEY)
    await submit()
    expect(mocks.replaceKey).toHaveBeenCalledWith('bot-1', KEY)
    expect(keyInput()!.value).toBe('')
    expect(mocks.refresh).toHaveBeenCalled()
    expect(host.textContent).toContain('Key updated.')
  })

  it('maps a refusal to its fix and still clears the key', async () => {
    mocks.replaceKey.mockRejectedValue(new ApiError('raw', 400, 'GOOGLE_CHAT_PROJECT_MISMATCH'))
    await render(bot())
    await type(keyInput()!, KEY)
    await submit()
    expect(host.textContent).toContain('This key belongs to a different project.')
    expect(keyInput()!.value).toBe('')
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('offers no key form for the deployment app or a read-only viewer', async () => {
    await render(bot({ prebuilt: true }))
    expect(keyInput()).toBeNull()
    expect(host.textContent).toContain('Managed in the Setup Server')
    await render(bot(), false)
    expect(keyInput()).toBeNull()
  })
})
