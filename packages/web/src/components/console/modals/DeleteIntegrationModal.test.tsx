// @vitest-environment happy-dom
/** The confirm says what happens to the bot identity: kept freed for reuse, or deleted where its platform releases it. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BotDto } from '@/lib/api'
import type { IntegrationRow } from '@/lib/data'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const data = vi.hoisted(() => ({ bots: [] as Partial<BotDto>[], deleteIntegration: vi.fn(async () => undefined) }))
vi.mock('@/lib/data-context', () => ({ useConsoleData: () => data }))

const DeleteIntegrationModal = (await import('./DeleteIntegrationModal')).default

const integration = { id: 'int-1', agentId: 'agent-a', botId: 'bot-1', name: 'Google Chat' } as IntegrationRow

let root: Root | undefined
let host: HTMLDivElement | undefined

async function render(bot: Partial<BotDto> | null): Promise<string> {
  data.bots = bot ? [{ id: 'bot-1', agentIds: ['agent-a'], ...bot }] : []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<DeleteIntegrationModal integration={integration} onClose={() => {}} />)
  })
  return host.textContent ?? ''
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

describe('DeleteIntegrationModal', () => {
  it('keeps the bot identity freed for reuse by default', async () => {
    for (const bot of [null, {}, { releasedWhenFreed: false }]) {
      const text = await render(bot)
      expect(text).toContain('freed for reuse')
      await act(async () => root!.unmount())
      host?.remove()
      root = undefined
    }
  })

  it('says the identity is deleted when its platform releases a freed bot and this is its last install', async () => {
    const text = await render({ releasedWhenFreed: true })
    expect(text).toContain('The bot identity is deleted with it')
    expect(text).not.toContain('Settings → Bots')
  })

  it('keeps the default while another agent still holds the bot', async () => {
    const text = await render({ releasedWhenFreed: true, agentIds: ['agent-a', 'agent-b'] })
    expect(text).toContain('freed for reuse')
  })
})
