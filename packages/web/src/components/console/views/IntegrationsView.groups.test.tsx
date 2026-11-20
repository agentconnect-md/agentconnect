// @vitest-environment happy-dom
// The Integrations page splits its bots as the Add-integration picker does: chat apps under Messaging apps, workflow platforms beside the code hosts.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotDto } from '@/lib/api'

const mocks = vi.hoisted(() => ({ bots: [] as BotDto[], params: new URLSearchParams() }))

vi.mock('next/navigation', () => ({ useSearchParams: () => mocks.params }))
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
vi.mock('@/components/console/GithubCard', () => ({ default: () => <div data-card="github" /> }))
vi.mock('@/components/console/GitlabCard', () => ({ default: () => <div data-card="gitlab" /> }))
vi.mock('@/components/console/AzureDevOpsCard', () => ({ default: () => <div data-card="azure-devops" /> }))
vi.mock('@/components/console/GiteaCard', () => ({ default: () => <div data-card="gitea" /> }))

const IntegrationsView = (await import('./IntegrationsView')).default

const bot = (id: string, platform: string, name: string, fields: Partial<BotDto> = {}): BotDto => ({
  id,
  name,
  platform,
  prebuilt: false,
  slackAppId: null,
  discordAppId: null,
  createdBy: null,
  transport: 'http',
  shareable: false,
  inUseByAgentId: null,
  agentIds: [],
  lastUsedAt: null,
  freedFromAgent: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...fields
})

const SLACK = bot('sl-1', 'slack', 'support-bot')
const LINEAR = bot('ln-1', 'linear', 'Example Workspace', { shareable: true })
// An org with an address sees its tab even where the deployment's Email flag is off.
const EMAIL = bot('em-1', 'email', 'helper@mail.example.test', { externalAppId: 'helper@mail.example.test' })

let host: HTMLDivElement
let root: Root

/** The page section under `label`, by its heading. */
const section = (label: string): HTMLElement => {
  const found = [...host.querySelectorAll('section')].find((el) => el.firstElementChild?.textContent === label)
  if (!found) throw new Error(`no ${label} section`)
  return found
}
const tabs = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].map((tab) => tab.textContent?.replace(/\d+$/, ''))
const selectedTab = (el: HTMLElement) =>
  el.querySelector('button[role="tab"][aria-selected="true"]')?.textContent?.replace(/\d+$/, '')
const cards = (el: HTMLElement) => [...el.querySelectorAll('[data-card]')].map((card) => card.getAttribute('data-card'))
// A row is open while its chevron is turned.
const isOpen = (botId: string) => !!host.querySelector(`#integration-bot-${botId} .rotate-90`)

async function render(params = ''): Promise<void> {
  mocks.params = new URLSearchParams(params)
  await act(async () => root.render(<IntegrationsView />))
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.bots = [SLACK, LINEAR, EMAIL]
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('the Integrations page’s groups', () => {
  it('lists chat apps under Messaging apps and Linear and Email with the code hosts under Workflow', async () => {
    await render()
    const messaging = section('Messaging apps')
    const workflow = section('Workflow')

    expect(tabs(messaging)).toContain('Slack')
    expect(tabs(messaging)).not.toContain('Linear')
    expect(tabs(messaging)).not.toContain('Email')
    // The picker's order: Linear ahead of the code hosts, Email after them; one card holds both, ahead of the hosts.
    expect(tabs(workflow)).toEqual(['Linear', 'Email'])
    expect(cards(workflow)).toEqual(['github', 'gitlab', 'azure-devops', 'gitea'])
    expect(cards(messaging)).toEqual([])
    expect(host.textContent).not.toContain('Code hosts')
  })

  it('opens a deep-linked workflow bot in the Workflow card and leaves the Messaging card as it was', async () => {
    await render('bot=em-1')
    const messaging = section('Messaging apps')
    const workflow = section('Workflow')

    expect(selectedTab(workflow)).toBe('Email')
    expect(isOpen('em-1')).toBe(true)
    expect(workflow.textContent).toContain('helper@mail.example.test')
    expect(selectedTab(messaging)).toBe(tabs(messaging)[0])
    expect(isOpen('sl-1')).toBe(false)
  })

  it('promises a roster only for a platform that lists rooms', async () => {
    await render('bot=em-1')
    expect(host.querySelector('#integration-bot-em-1')?.parentElement?.textContent).not.toContain('No conversations')

    await act(async () => root.unmount())
    root = createRoot(host)
    await render('bot=sl-1')
    expect(host.querySelector('#integration-bot-sl-1')?.parentElement?.textContent).toContain('No conversations')
  })

  it('opens a deep-linked chat bot in the Messaging card', async () => {
    await render('bot=sl-1')

    expect(selectedTab(section('Messaging apps'))).toBe('Slack')
    expect(isOpen('sl-1')).toBe(true)
    expect(selectedTab(section('Workflow'))).toBe('Linear')
  })

  it('selects a deep-linked platform’s tab in whichever section holds it', async () => {
    await render('platform=email')
    expect(selectedTab(section('Workflow'))).toBe('Email')
    expect(selectedTab(section('Messaging apps'))).toBe(tabs(section('Messaging apps'))[0])

    await act(async () => root.unmount())
    root = createRoot(host)
    await render('platform=telegram')
    expect(selectedTab(section('Messaging apps'))).toBe('Telegram')
    expect(selectedTab(section('Workflow'))).toBe('Linear')
  })
})
