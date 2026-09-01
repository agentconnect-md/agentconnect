// @vitest-environment happy-dom
/**
 * The Sharable cell, per platform. Slack's multi-agent mode is an operator opt-in and
 * keeps its toggle; Linear's is structural — the provider stamps `shareable: true` on
 * every connected workspace (linear-integration.md §4.3) — so the cell must STATE it
 * rather than offer a control.
 *
 * A disabled toggle would not do: the CP accepts a `shareable: false` PATCH on a
 * one-member bot, so the only thing standing between a workspace and a state its
 * provider contract does not have is that no switch is rendered at all.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotDto } from '@/lib/api'

const mocks = vi.hoisted(() => ({ bots: [] as BotDto[] }))

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
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('the Sharable cell', () => {
  it('renders no switch at all for a Linear workspace', async () => {
    mocks.bots = [
      bot({ id: 'ws-1', platform: 'linear', name: 'Example Workspace', workspaceName: 'Example Workspace' })
    ]
    const row = await botRow('Linear', 'ws-1')

    expect(row.querySelector('[role="switch"]')).toBeNull()
    expect(row.textContent).toContain('Always')
  })

  it('keeps Slack’s toggle exactly as it was', async () => {
    mocks.bots = [bot({ id: 'sl-1', platform: 'slack' })]
    const row = await botRow('Slack', 'sl-1')

    const toggle = row.querySelector('[role="switch"]')
    expect(toggle).not.toBeNull()
    expect(toggle?.getAttribute('aria-checked')).toBe('true')
    expect((toggle as HTMLButtonElement).disabled).toBe(false)
  })
})
