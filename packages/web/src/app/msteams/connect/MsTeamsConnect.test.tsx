// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  class FakeApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code?: string
    ) {
      super(message)
    }
  }
  return { FakeApiError, finish: vi.fn(), install: vi.fn(), fetchOrgs: vi.fn(), login: vi.fn() }
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
  installMsTeamsTeams: mocks.install
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
  await act(async () => root.render(<MsTeamsConnect />))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label)!

describe('MsTeamsConnect', () => {
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
        { id: 'team-1', name: 'Engineering' },
        { id: 'team-2', name: 'Support' }
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

  it('names a refusal, and a sign-in Microsoft sent back without a code', async () => {
    mocks.finish.mockRejectedValue(new mocks.FakeApiError('taken', 409, 'MSTEAMS_TENANT_TAKEN'))
    await land(`code=c&state=${STATE}`)
    expect(host.textContent).toContain('already connected to another organization')
    await act(async () => root.unmount())
    root = createRoot(host)
    await land('error=access_denied&state=x')
    expect(host.textContent).toContain('needs an administrator')
    expect(mocks.finish).toHaveBeenCalledTimes(1)
  })
})
