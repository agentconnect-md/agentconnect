// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number
    ) {
      super(message)
    }
  }
  return {
    ApiError,
    user: {} as unknown,
    login: vi.fn(),
    orgs: vi.fn(),
    agents: vi.fn(),
    install: vi.fn(),
    connect: vi.fn(),
    store: vi.fn()
  }
})
vi.mock('@/lib/auth', () => ({ isAuthConfigured: () => true, getUser: async () => mocks.user, login: mocks.login }))
vi.mock('@/lib/flow-state', () => ({ writeFlowState: mocks.store }))
vi.mock('@/lib/api', () => ({
  ApiError: mocks.ApiError,
  fetchOrgs: mocks.orgs,
  fetchAgents: mocks.agents,
  fetchSlackWorkspaceInstall: mocks.install,
  connectSlackWorkspace: mocks.connect
}))
import SlackConnect from './SlackConnect'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const ID = '11111111-1111-4111-8111-111111111111'
let host: HTMLElement
let root: Root
beforeEach(() => {
  vi.resetAllMocks()
  mocks.user = { sub: 'example' }
  mocks.store.mockReturnValue(true)
  mocks.install.mockResolvedValue({
    workspaceName: 'Example workspace',
    slackUrl: 'https://slack.com/app_redirect?app=AEXAMPLE&team=TEXAMPLE'
  })
  mocks.orgs.mockResolvedValue([
    { id: 'org-1', slug: 'example-one', role: 'owner', name: 'First org' },
    { id: 'org-2', slug: 'example-two', role: 'collaborator', name: 'Second org' },
    { id: 'org-3', role: 'viewer', name: 'Read only' }
  ])
  mocks.agents.mockResolvedValue([
    { id: 'agent-1', name: 'agentconnect', canEdit: true },
    { id: 'agent-hidden', name: 'Read only agent', canEdit: false }
  ])
  window.history.replaceState({}, '', `/slack/connect?installation=${ID}`)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})
const render = () => act(async () => root.render(<SlackConnect />))
const button = (label: string) => [...host.querySelectorAll('button')].find((item) => item.textContent === label)!

it('offers editable organizations and agents, connects once, and links back to Slack and the agent configuration', async () => {
  await render()
  expect([...host.querySelectorAll('option')].map((item) => item.textContent)).toEqual([
    'First org',
    'Second org',
    'agentconnect'
  ])
  await act(async () => button('Connect workspace').click())
  expect(mocks.connect).toHaveBeenCalledWith('org-1', ID, 'agent-1')
  expect(host.textContent).toContain('Slack is connected')
  expect(host.querySelector('a.dsbtn-primary')?.getAttribute('href')).toContain('https://slack.com/app_redirect?')
  expect(host.querySelector('a.dsbtn-secondary')?.getAttribute('href')).toBe('/example-one/agents/agent-1?tab=config')
})

it('disables connection during organization changes and ignores a late agent-list response', async () => {
  let finishSecond!: (agents: unknown[]) => void
  mocks.agents.mockImplementation((orgId) =>
    orgId === 'org-2'
      ? new Promise((resolve) => {
          finishSecond = resolve
        })
      : Promise.resolve([{ id: 'agent-1', name: 'First agent', canEdit: true }])
  )
  await render()
  const select = host.querySelector('select')!
  await act(async () => {
    select.value = 'org-2'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(button('Connect workspace').disabled).toBe(true)
  await act(async () => {
    select.value = 'org-1'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => finishSecond([{ id: 'agent-2', name: 'Second agent', canEdit: true }]))
  await act(async () => button('Connect workspace').click())
  expect(mocks.connect).toHaveBeenCalledWith('org-1', ID, 'agent-1')
})

it('preserves the connection link across Slack sign-in and refuses sign-in if browser storage fails', async () => {
  mocks.user = null
  mocks.store.mockReturnValue(false)
  await render()
  expect(mocks.login).not.toHaveBeenCalled()
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('store browser data')
  mocks.store.mockReturnValue(true)
  await act(async () => button('Refresh').click())
  expect(mocks.login).toHaveBeenCalledWith('slack')
  expect(mocks.store).toHaveBeenLastCalledWith('returnTo', `/slack/connect?installation=${ID}`)
  expect(mocks.install).not.toHaveBeenCalled()
})

it('guides a different Slack identity to profile linking and a new user to organization creation', async () => {
  mocks.install.mockRejectedValueOnce(new mocks.ApiError('forbidden', 403))
  await render()
  expect(host.textContent).toContain('Slack account that installed this app')
  expect(host.querySelector('a[href="/profile"]')).not.toBeNull()
  mocks.orgs.mockResolvedValue([])
  await act(async () => button('Refresh').click())
  expect(host.querySelector('a[href="/welcome?new=1"]')).not.toBeNull()
  expect(button('Connect workspace').disabled).toBe(true)
})
