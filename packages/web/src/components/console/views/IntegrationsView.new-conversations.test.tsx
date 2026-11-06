// @vitest-environment happy-dom
/** What a bot's new channels start at: the expanded row offers Auto, @-mentions or Off, showing an unset mode as Auto. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotDto } from '@/lib/api'

const mocks = vi.hoisted(() => ({ bots: [] as BotDto[], setBotNewConversationMode: vi.fn(async () => {}) }))

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: null }) }))
vi.mock('@/components/console/ModalProvider', () => ({ useModal: () => ({ openModal: vi.fn() }) }))
vi.mock('@/lib/org-context', () => {
  const orgs = { activeOrg: { id: 'org-1' }, myRole: 'owner', orgPath: (path: string) => path }
  return { useOrgs: () => orgs }
})
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    get bots() {
      return mocks.bots
    },
    integrations: [],
    agents: [],
    loading: false,
    getAgent: () => null,
    refresh: vi.fn(),
    deleteIntegration: vi.fn(),
    setBotShareable: vi.fn(),
    setBotNewConversationMode: mocks.setBotNewConversationMode,
    setChannelAgent: vi.fn()
  })
}))
vi.mock('@/components/console/GitlabCard', () => ({ default: () => <div /> }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchGithubInstallations: vi.fn(async () => ({ enabled: false, installations: [] })),
  fetchGithubInstallUrl: vi.fn(async () => null),
  syncGithubInstallations: vi.fn(async () => [])
}))

const IntegrationsView = (await import('./IntegrationsView')).default

function bot(over: Partial<BotDto>): BotDto {
  return {
    id: 'bot-1',
    name: 'support',
    platform: 'slack',
    prebuilt: false,
    slackAppId: null,
    discordAppId: null,
    createdBy: null,
    transport: 'http',
    shareable: true,
    inUseByAgentId: null,
    agentIds: [],
    lastUsedAt: null,
    freedFromAgent: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over
  }
}

let host: HTMLDivElement
let root: Root

/**
 * Render the view, switch the Bots card to `tabLabel`'s platform, and return that
 * bot's ROW — scoped deliberately, because the card header carries a "Show in use"
 * switch of its own that a document-wide query would find first.
 */
async function botRow(tabLabel: string, botId: string): Promise<HTMLElement> {
  await act(async () => root.render(<IntegrationsView />))
  const tab = [...host.querySelectorAll('button[role="tab"]')].find((b) => b.textContent?.includes(tabLabel))
  if (!tab) throw new Error(`no Bots tab labeled "${tabLabel}"`)
  await act(async () => (tab as HTMLButtonElement).click())
  const row = host.querySelector<HTMLElement>(`#integration-bot-${botId}`)
  if (!row) throw new Error(`no bot row for ${botId} under the ${tabLabel} tab`)
  return row
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.bots = []
  mocks.setBotNewConversationMode.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe("a bot's new-channel default", () => {
  async function openSelect(over: Partial<BotDto>) {
    mocks.bots = [bot({ id: 'sl-1', platform: 'slack', ...over })]
    const row = await botRow('Slack', 'sl-1')
    await act(async () => row.click())
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="New channels start on"]')
    if (!trigger) throw new Error('no new-channel selector in the expanded row')
    return trigger
  }

  it('shows an unset mode as Auto', async () => {
    const trigger = await openSelect({})
    expect(trigger.textContent).toContain('Auto')
  })

  it('saves the mode picked', async () => {
    const trigger = await openSelect({ newConversationMode: 'auto' })
    await act(async () => trigger.click())
    const off = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
      (item) => item.textContent?.trim() === 'Off'
    )
    if (!off) throw new Error('no Off option')
    await act(async () => off.click())
    expect(mocks.setBotNewConversationMode).toHaveBeenCalledWith('sl-1', 'off')
  })

  it('reads the stored mode', async () => {
    const trigger = await openSelect({ newConversationMode: 'mention' })
    expect(trigger.textContent).toContain('@-mentions, per thread')
  })
})
