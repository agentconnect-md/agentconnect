// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotDto } from '@/lib/api'
import type { IntegrationRow } from '@/lib/data'

const mocks = vi.hoisted(() => ({
  replaceSecret: vi.fn(),
  appPackage: vi.fn(),
  saveBlob: vi.fn(),
  refresh: vi.fn(),
  integrations: [] as Partial<IntegrationRow>[]
}))

vi.mock('../deployment-config', () => ({
  useDeploymentConfig: () => ({
    config: { relayPublicUrl: 'https://relay.example.test' },
    failed: false,
    apply: vi.fn()
  })
}))
vi.mock('./api', () => ({ msTeamsApi: { replaceSecret: mocks.replaceSecret, appPackage: mocks.appPackage } }))
vi.mock('@/lib/shared-file', () => ({ saveBlob: mocks.saveBlob }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({ integrations: mocks.integrations, refresh: mocks.refresh })
}))

import { ApiError } from '@/lib/api'
import { MsTeamsBotSettings } from './settings'

const APP_ID = '00000000-0000-0000-0000-00000000000a'
const TENANT_ID = '00000000-0000-0000-0000-00000000000b'

function bot(over: Partial<BotDto> = {}): BotDto {
  return {
    id: 'bot-1',
    name: `Microsoft Teams · ${APP_ID}`,
    platform: 'msteams',
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
    externalAppId: APP_ID,
    platformConfig: { tenantId: TENANT_ID },
    createdAt: '2026-10-22T00:00:00.000Z',
    ...over
  }
}

let host: HTMLDivElement
let root: Root

async function render(b: BotDto, canWrite = true): Promise<void> {
  await act(async () => root.render(<MsTeamsBotSettings bot={b} canWrite={canWrite} />))
}

const text = () => host.textContent ?? ''
const secretInput = () => host.querySelector<HTMLInputElement>('input[type="password"]')
const buttonWith = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label))

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.replaceSecret.mockReset()
  mocks.appPackage.mockReset()
  mocks.saveBlob.mockReset()
  mocks.refresh.mockReset()
  mocks.integrations = [{ id: 'int-1', botId: 'bot-1', platform: 'msteams' }]
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('MsTeamsBotSettings', () => {
  it('shows both IDs and the messaging endpoint', async () => {
    await render(bot())
    expect(text()).toContain(APP_ID)
    expect(text()).toContain(TENANT_ID)
    expect(text()).toContain('https://relay.example.test/msteams/messages')
  })

  it('replaces the client secret, then clears it', async () => {
    mocks.replaceSecret.mockResolvedValue(bot())
    await render(bot())
    await type(secretInput()!, ' n3w ')
    await act(async () => host.querySelector('form')!.requestSubmit())
    expect(mocks.replaceSecret).toHaveBeenCalledWith('bot-1', 'n3w')
    expect(mocks.refresh).toHaveBeenCalled()
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Client secret updated.')
    expect(secretInput()!.value).toBe('')
  })

  it('shows the localized reason for a refused secret', async () => {
    mocks.replaceSecret.mockRejectedValue(new ApiError('Entra said no', 400, 'MSTEAMS_SECRET_INVALID'))
    await render(bot())
    await type(secretInput()!, 'wrong')
    await act(async () => host.querySelector('form')!.requestSubmit())
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Microsoft Entra rejected this client secret')
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('downloads the package of the bot’s integration', async () => {
    const blob = new Blob(['zip'])
    mocks.appPackage.mockResolvedValue(blob)
    await render(bot())
    await act(async () => buttonWith('Download app package')?.click())
    expect(mocks.appPackage).toHaveBeenCalledWith('int-1')
    expect(mocks.saveBlob).toHaveBeenCalledWith(blob, 'agentconnect-teams.zip')
  })

  it('offers no download for a freed bot and no rotation to a viewer', async () => {
    mocks.integrations = []
    await render(bot({ inUseByAgentId: null, agentIds: [] }), false)
    expect(buttonWith('Download app package')).toBeUndefined()
    expect(secretInput()).toBeNull()
  })
})
