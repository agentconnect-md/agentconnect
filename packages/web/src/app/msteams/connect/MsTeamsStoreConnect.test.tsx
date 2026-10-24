// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  user: {} as unknown,
  login: vi.fn(),
  orgs: vi.fn(),
  agents: vi.fn(),
  start: vi.fn(),
  store: vi.fn()
}))
vi.mock('@/lib/auth', () => ({ isAuthConfigured: () => true, getUser: async () => mocks.user, login: mocks.login }))
vi.mock('@/lib/flow-state', () => ({ writeFlowState: mocks.store }))
vi.mock('@/lib/api', () => ({
  fetchOrgs: mocks.orgs,
  fetchAgents: mocks.agents,
  startMsTeamsConnect: mocks.start
}))
import MsTeamsStoreConnect from './MsTeamsStoreConnect'
import { isMsTeamsStoreStart } from './MsTeamsConnectEntry'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const TENANT = '55555555-5555-4555-8555-555555555555'
let host: HTMLElement
let root: Root

beforeEach(() => {
  vi.resetAllMocks()
  mocks.user = { sub: 'example' }
  mocks.store.mockReturnValue(true)
  mocks.orgs.mockResolvedValue([
    { id: 'org-1', slug: 'example-one', role: 'owner', name: 'First org' },
    { id: 'org-3', slug: 'read-only', role: 'viewer', name: 'Read only' }
  ])
  mocks.agents.mockResolvedValue([
    { id: 'agent-1', name: 'helper', canEdit: true },
    { id: 'agent-hidden', name: 'Read only agent', canEdit: false }
  ])
  mocks.start.mockResolvedValue({ authorizeUrl: 'https://login.example.test/authorize' })
  vi.spyOn(window.location, 'assign').mockImplementation(() => undefined)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

async function land(query: string) {
  window.history.replaceState({}, '', `/msteams/connect?${query}`)
  await act(async () => root.render(<MsTeamsStoreConnect />))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label)!

it('tells a Connect card’s landing apart from Microsoft’s return', () => {
  expect(isMsTeamsStoreStart(`?tenant=${TENANT}`)).toBe(true)
  expect(isMsTeamsStoreStart(`?tenant=${TENANT}&code=c&state=s`)).toBe(false)
  expect(isMsTeamsStoreStart('?code=c&state=s')).toBe(false)
})

it('offers the organizations and agents the person can edit, then sends them to Microsoft pinned to the tenant', async () => {
  await land(`tenant=${TENANT}`)
  expect([...host.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['First org', 'helper'])
  await act(async () => button('Continue with Microsoft').click())
  expect(mocks.start).toHaveBeenCalledWith('org-1', 'agent-1', TENANT)
  expect(window.location.assign).toHaveBeenCalledWith('https://login.example.test/authorize')
})

it('signs in first, keeping the landing to come back to', async () => {
  mocks.user = null
  await land(`tenant=${TENANT}`)
  expect(mocks.store).toHaveBeenCalledWith('returnTo', `/msteams/connect?tenant=${TENANT}`)
  expect(mocks.login).toHaveBeenCalledOnce()
  expect(mocks.orgs).not.toHaveBeenCalled()
})

it('refuses a link without a tenant', async () => {
  await land('tenant=not-a-tenant')
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('This connection link is invalid')
  expect(mocks.start).not.toHaveBeenCalled()
})
