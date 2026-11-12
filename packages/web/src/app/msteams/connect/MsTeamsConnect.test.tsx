// @vitest-environment happy-dom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  class FakeApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code?: string,
      readonly details?: Record<string, unknown>
    ) {
      super(message)
    }
  }
  return {
    FakeApiError,
    finish: vi.fn(),
    install: vi.fn(),
    proceed: vi.fn(),
    agentBot: vi.fn(),
    start: vi.fn(),
    checkRequest: vi.fn(),
    fetchOrgs: vi.fn(),
    login: vi.fn(),
    startRecovery: vi.fn()
  }
})

vi.mock('@/lib/auth', () => ({
  isAuthConfigured: () => true,
  getUser: () => Promise.resolve({ sub: 'logto-subject' }),
  login: mocks.login
}))
vi.mock('@/lib/api', () => ({
  ApiError: mocks.FakeApiError,
  fetchOrgs: mocks.fetchOrgs,
  finishMsTeamsConnect: mocks.finish,
  installMsTeamsTeams: mocks.install,
  continueMsTeamsConnect: mocks.proceed,
  createMsTeamsAgentBot: mocks.agentBot,
  startMsTeamsConnect: mocks.start,
  checkMsTeamsAgentBotRequest: mocks.checkRequest,
  startMsTeamsRecovery: mocks.startRecovery
}))

import MsTeamsConnect, { msTeamsConnectOrgId } from './MsTeamsConnect'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const STATE = `${Buffer.from(JSON.stringify({ orgId: 'org-a', agentId: 'agent-a', userId: 'u', e: 1, n: 'x' })).toString('base64url')}.sig`

let root: Root
let host: HTMLElement

beforeEach(() => {
  vi.clearAllMocks()
  mocks.fetchOrgs.mockResolvedValue([{ id: 'org-a', slug: 'example', name: 'Example', role: 'owner' }])
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function land(query: string) {
  window.history.replaceState({}, '', `/msteams/connect?${query}`)
  await act(async () =>
    root.render(
      <StrictMode>
        <MsTeamsConnect />
      </StrictMode>
    )
  )
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label)!

describe('MsTeamsConnect', () => {
  it('offers recovery only for a verified conflict and records the exact browser attempt', async () => {
    mocks.finish.mockRejectedValue(
      new mocks.FakeApiError('taken', 409, 'MSTEAMS_TENANT_TAKEN', {
        recovery: { tenantId: 'example-tenant', agentId: 'agent-a' }
      })
    )
    mocks.startRecovery.mockResolvedValue({
      authorizeUrl: 'https://login.microsoftonline.com/example',
      state: 'signed-recovery-state'
    })
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined)
    try {
      await land(`code=c&state=${STATE}`)
      expect(mocks.finish).toHaveBeenCalledTimes(1)
      await act(async () => button('Verify administrator access').click())
      expect(mocks.startRecovery).toHaveBeenCalledWith('org-a', 'example-tenant', 'agent-a')
      expect(JSON.parse(sessionStorage.getItem('ac.msTeamsRecovery')!)).toEqual({
        orgId: 'org-a',
        agentId: 'agent-a',
        state: 'signed-recovery-state'
      })
      expect(assign).toHaveBeenCalledWith('https://login.microsoftonline.com/example')
    } finally {
      assign.mockRestore()
      sessionStorage.clear()
    }
  })
  it('reads the organization out of the signed state, and nothing out of a malformed one', () => {
    expect(msTeamsConnectOrgId(STATE)).toBe('org-a')
    expect(msTeamsConnectOrgId('not-json.sig')).toBeNull()
    expect(msTeamsConnectOrgId(null)).toBeNull()
  })

  it('redeems the code, drops it from the address bar, and installs into the chosen teams', async () => {
    mocks.finish.mockResolvedValue({
      integrationId: 'int-1',
      agentId: 'agent-a',
      teams: [
        { id: 'team-1', name: 'Engineering', app: 'none' },
        { id: 'team-2', name: 'Support', app: 'none' }
      ],
      ticket: 'sealed'
    })
    mocks.install.mockResolvedValue({ installed: 1 })
    await land(`code=c&state=${STATE}`)
    expect(mocks.finish).toHaveBeenCalledWith('org-a', 'c', STATE)
    expect(window.location.search).toBe('')
    expect(host.textContent).toContain('Engineering')
    await act(async () => button('Add to teams').click())
    expect(mocks.install).toHaveBeenCalledWith('org-a', 'sealed', ['team-1'])
    expect(host.textContent).toContain('Teams is connected')
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/example/agents/agent-a')
  })

  it('shows an update: the teams that had the app are updated, and nothing more is preselected', async () => {
    mocks.finish.mockResolvedValue({
      integrationId: 'int-1',
      agentId: 'agent-a',
      teams: [
        { id: 'team-1', name: 'Engineering', app: 'updated' },
        { id: 'team-2', name: 'Support', app: 'none' }
      ],
      ticket: 'sealed'
    })
    await land(`code=c&state=${STATE}`)
    expect(host.textContent).toContain('Updated the app in 1 team that already had it.')
    const boxes = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(boxes.map((box) => [box.checked, box.disabled])).toEqual([
      [true, true],
      [false, false]
    ])
    await act(async () => button('Done').click())
    expect(mocks.install).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Teams is connected')
  })

  it('names the teams Microsoft did not update and offers no install into them', async () => {
    mocks.finish.mockResolvedValue({
      integrationId: 'int-1',
      agentId: 'agent-a',
      teams: [{ id: 'team-1', name: 'Engineering', app: 'failed' }],
      ticket: 'sealed'
    })
    await land(`code=c&state=${STATE}`)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Microsoft did not update the app in 1 team.')
    expect(host.textContent).toContain('Not updated')
    const box = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect([box.checked, box.disabled]).toEqual([false, true])
    expect(button('Done')).toBeTruthy()
  })

  // teams-integration.md §8.4: a Teams Store install already has the app, so connecting the tenant finishes.
  it('finishes a Teams Store connect without a team step, and names a sign-in of another tenant', async () => {
    mocks.finish.mockResolvedValue({ integrationId: 'int-1', agentId: 'agent-a', teams: [], store: true })
    await land(`code=c&state=${STATE}`)
    expect(host.textContent).toContain('Teams is connected')
    expect(host.textContent).toContain('Message the agent in Teams')
    expect(mocks.install).not.toHaveBeenCalled()
    await act(async () => root.unmount())
    root = createRoot(host)
    mocks.finish.mockRejectedValue(new mocks.FakeApiError('mismatch', 400, 'MSTEAMS_TENANT_MISMATCH'))
    await land(`code=c&state=${STATE}`)
    expect(host.textContent).toContain('added the app in Teams')
  })

  it('goes on to the sign-in when Microsoft returns from the tenant-wide consent, which carries no code', async () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined)
    mocks.proceed.mockResolvedValue({ authorizeUrl: 'https://login.example.test/authorize' })
    await land(`admin_consent=True&tenant=tenant-1&state=${STATE}`)
    expect(mocks.proceed).toHaveBeenCalledWith('org-a', STATE)
    expect(assign).toHaveBeenCalledWith('https://login.example.test/authorize')
    expect(mocks.finish).not.toHaveBeenCalled()
    await act(async () => root.unmount())
    root = createRoot(host)
    // A declined consent names an administrator, and continues nothing.
    await land(`error=access_denied&state=${STATE}`)
    expect(host.textContent).toContain('needs an administrator')
    expect(mocks.proceed).toHaveBeenCalledTimes(1)
    assign.mockRestore()
  })

  it('creates a further agent’s own bot with no team step, and says to mention it in a channel', async () => {
    mocks.finish.mockResolvedValue({ agentId: 'agent-a', agentBot: true, teams: [], ticket: 'provision', store: false })
    let made!: (value: unknown) => void
    mocks.agentBot.mockReturnValue(new Promise((resolve) => (made = resolve)))
    await land(`code=c&state=${STATE}`)
    expect(mocks.agentBot).toHaveBeenCalledWith('org-a', 'provision')
    expect(host.textContent).toContain('Creating the agent’s bot')
    expect(host.textContent).toContain('gets a bot of its own')
    expect(host.textContent).not.toContain('Add to teams')

    await act(async () => made({ integrationId: 'int-2', agentId: 'agent-a', teams: [], store: false }))
    expect(host.textContent).toContain('Teams is connected')
    expect(host.textContent).toContain('Mention the agent in any channel')
    expect(mocks.install).not.toHaveBeenCalled()
  })

  it('shows a request waiting for an administrator when the person may not publish, and checks on demand', async () => {
    const waiting = {
      id: 'req-1',
      agentId: 'agent-a',
      tenantId: 'example-tenant',
      status: 'pending',
      reason: null,
      createdAt: '2026-11-01T00:00:00.000Z',
      adminCenterUrl: 'https://admin.example.test/manage-apps/catalog-1'
    }
    mocks.finish.mockResolvedValue({ agentId: 'agent-a', agentBot: true, teams: [], ticket: 'provision', store: false })
    // The bot step answers a request instead of an integration: Microsoft refused the publish.
    mocks.agentBot.mockResolvedValue({ agentId: 'agent-a', agentBot: true, teams: [], store: false, request: waiting })
    await land(`code=c&state=${STATE}`)
    expect(mocks.agentBot).toHaveBeenCalledWith('org-a', 'provision')
    expect(host.textContent).toContain('Waiting for approval')
    expect(host.querySelector('a[href="https://admin.example.test/manage-apps/catalog-1"]')).not.toBeNull()

    mocks.checkRequest.mockResolvedValueOnce({ request: waiting }).mockResolvedValueOnce({ integrationId: 'int-3' })
    await act(async () => button('Check again').click())
    expect(host.textContent).toContain('Waiting for approval')
    await act(async () => button('Check again').click())
    expect(mocks.checkRequest).toHaveBeenCalledWith('org-a', 'req-1')
    expect(host.textContent).toContain('Teams is connected')
  })

  it('goes to the silent sign-in the server names, and through the consent when that finds no account', async () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined)
    try {
      mocks.finish.mockResolvedValue({
        agentId: 'agent-a',
        teams: [],
        store: false,
        authorizeUrl: 'https://login.microsoftonline.com/example-tenant/oauth2/v2.0/authorize?prompt=none'
      })
      await land(`code=c&state=${STATE}`)
      expect(assign).toHaveBeenCalledWith(
        'https://login.microsoftonline.com/example-tenant/oauth2/v2.0/authorize?prompt=none'
      )
      await act(async () => root.unmount())
      root = createRoot(host)
      // Microsoft answers the silent sign-in with an error: the account is not of that tenant, so this one is connected through its consent.
      const silent = `${btoa(JSON.stringify({ orgId: 'org-a', agentId: 'agent-a', pin: 'example-tenant' }))}.sig`
      mocks.start.mockResolvedValue({
        authorizeUrl: 'https://login.microsoftonline.com/organizations/v2.0/adminconsent'
      })
      await land(`error=login_required&state=${silent}`)
      expect(mocks.start).toHaveBeenCalledWith('org-a', 'agent-a', undefined, true)
      expect(assign).toHaveBeenCalledWith('https://login.microsoftonline.com/organizations/v2.0/adminconsent')
    } finally {
      assign.mockRestore()
    }
  })

  it('shows a request a new sign-in resumed, and names a tenant no administrator connected', async () => {
    mocks.finish.mockResolvedValue({
      agentId: 'agent-a',
      agentBot: true,
      teams: [],
      store: false,
      request: {
        id: 'req-1',
        agentId: 'agent-a',
        tenantId: 'example-tenant',
        status: 'pending',
        reason: null,
        createdAt: '2026-11-01T00:00:00.000Z',
        adminCenterUrl: 'https://admin.example.test/manage-apps'
      }
    })
    await land(`code=c&state=${STATE}`)
    expect(host.textContent).toContain('Waiting for approval')
    await act(async () => root.unmount())
    root = createRoot(host)
    // A sign-in that finished an already approved request has nothing left to wait for.
    mocks.finish.mockResolvedValue({
      integrationId: 'int-9',
      agentId: 'agent-a',
      agentBot: true,
      teams: [],
      store: false
    })
    await land(`code=c&state=${STATE}`)
    expect(host.textContent).toContain('Teams is connected')
    expect(host.textContent).toContain('Mention the agent in any channel')
    await act(async () => root.unmount())
    root = createRoot(host)
    mocks.finish.mockRejectedValue(new mocks.FakeApiError('no', 409, 'MSTEAMS_TENANT_NOT_CONNECTED'))
    await land(`code=c&state=${STATE}`)
    expect(host.textContent).toContain('is not connected here yet')
  })

  it('starts again through the consent page when the tenant signed in to has not recorded it', async () => {
    mocks.finish.mockRejectedValue(new mocks.FakeApiError('consent', 409, 'MSTEAMS_CONSENT_NEEDED'))
    mocks.start.mockResolvedValue({ authorizeUrl: 'https://login.microsoftonline.com/organizations/v2.0/adminconsent' })
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined)
    try {
      await land(`code=c&state=${STATE}`)
      expect(mocks.start).toHaveBeenCalledWith('org-a', 'agent-a', undefined, true)
      expect(assign).toHaveBeenCalledWith('https://login.microsoftonline.com/organizations/v2.0/adminconsent')
    } finally {
      assign.mockRestore()
    }
  })

  it('names why a further agent’s bot was not created', async () => {
    mocks.finish.mockResolvedValue({ agentId: 'agent-a', agentBot: true, teams: [], ticket: 'provision', store: false })
    mocks.agentBot.mockRejectedValue(new mocks.FakeApiError('no', 409, 'MSTEAMS_AGENT_BOTS_UNAVAILABLE'))
    await land(`code=c&state=${STATE}`)
    expect(host.textContent).toContain('did not let this deployment create a bot')
    await act(async () => root.unmount())
    root = createRoot(host)
    mocks.finish.mockRejectedValue(new mocks.FakeApiError('taken', 409, 'MSTEAMS_AGENT_NAME_TAKEN'))
    await land(`code=c&state=${STATE}`)
    expect(host.textContent).toContain('under this name')
  })

  it('names a refusal, and a sign-in Microsoft sent back without a code', async () => {
    mocks.finish.mockRejectedValue(new mocks.FakeApiError('taken', 409, 'MSTEAMS_TENANT_TAKEN'))
    await land(`code=c&state=${STATE}`)
    expect(host.textContent).toContain('already connected elsewhere')
    await act(async () => root.unmount())
    root = createRoot(host)
    await land('error=access_denied&state=x')
    expect(host.textContent).toContain('needs an administrator')
    expect(mocks.finish).toHaveBeenCalledTimes(1)
  })
})
