// @vitest-environment happy-dom
// An expanded bot row keeps the code channels tasks opened in their own collapsed group, after the channels and DMs.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotDto } from '@/lib/api'
import type { IntegrationRow } from '@/lib/data'

const mocks = vi.hoisted(() => ({ integrations: [] as IntegrationRow[] }))

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }))
vi.mock('@/lib/profile', () => ({ useProfile: () => ({ me: null }) }))
vi.mock('@/components/console/ModalProvider', () => ({ useModal: () => ({ openModal: vi.fn() }) }))
vi.mock('@/lib/org-context', () => {
  const orgs = { activeOrg: { id: 'org-1' }, myRole: 'owner', orgPath: (path: string) => path }
  return { useOrgs: () => orgs }
})
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    bots: [bot],
    get integrations() {
      return mocks.integrations
    },
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

const bot: BotDto = {
  id: 'bot-1',
  name: 'helper',
  platform: 'slack',
  prebuilt: false,
  slackAppId: null,
  discordAppId: null,
  createdBy: null,
  transport: 'http',
  shareable: false,
  inUseByAgentId: null,
  agentIds: ['agent-a'],
  lastUsedAt: null,
  freedFromAgent: null,
  createdAt: '2026-01-01T00:00:00.000Z'
}

const IntegrationsView = (await import('./IntegrationsView')).default

const channel = (channelId: string, name: string, over: object = {}) => ({
  channelId,
  name,
  kind: 'channel',
  trigger: 'mention',
  ...over
})

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.integrations = [
    {
      id: 'int-a',
      agentId: 'agent-a',
      botId: 'bot-1',
      channels: [
        channel('C3', 'build-playground', { isCodeSession: true }),
        channel('C1', 'general'),
        channel('D1', 'Example Person', { kind: 'im' }),
        channel('C2', 'another-task', { isCodeSession: true })
      ]
    } as unknown as IntegrationRow
  ]
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('an expanded bot row', () => {
  it('groups code channels last, collapsed, and opens them on demand', async () => {
    await act(async () => root.render(<IntegrationsView />))
    await act(async () => host.querySelector<HTMLElement>('#integration-bot-bot-1')!.click())

    const toggle = host.querySelector<HTMLButtonElement>('button[aria-expanded]')!
    expect(toggle.textContent).toContain('Code channels')
    expect(toggle.textContent).toContain('2')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(host.textContent).toContain('general')
    expect(host.textContent).not.toContain('build-playground')

    await act(async () => toggle.click())
    const text = host.textContent ?? ''
    expect(text).toContain('build-playground')
    expect(text.indexOf('general')).toBeLessThan(text.indexOf('Direct messages'))
    expect(text.indexOf('Direct messages')).toBeLessThan(text.indexOf('Code channels'))
    expect(text.indexOf('Code channels')).toBeLessThan(text.indexOf('another-task'))
    expect(text.indexOf('another-task')).toBeLessThan(text.indexOf('build-playground'))
  })
})
