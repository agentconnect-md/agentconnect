// @vitest-environment happy-dom
// The Azure DevOps connect landing (azure-devops-integration.md §3.2): finish the sign-in, pick the organization and projects, apply, and name each refusal with its fix.
import { act } from 'react'
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
    organizations: vi.fn(),
    choose: vi.fn(),
    apply: vi.fn(),
    verify: vi.fn(),
    start: vi.fn(),
    fetchOrgs: vi.fn(),
    login: vi.fn(),
    assign: vi.fn()
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
  finishAzureDevOpsSignIn: mocks.finish,
  listAzureDevOpsConnectOrganizations: mocks.organizations,
  chooseAzureDevOpsConnectOrganization: mocks.choose,
  applyAzureDevOpsConnectProjects: mocks.apply,
  verifyAzureDevOpsConnect: mocks.verify,
  startAzureDevOpsConnect: mocks.start
}))

import AzureDevOpsConnect, { azureDevOpsConnectState } from './AzureDevOpsConnect'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CONNECTION_ID = '00000000-0000-4000-8000-000000000010'
const FLOW = '00000000-0000-4000-8000-000000000030'
const PROJECT_A = '00000000-0000-4000-8000-000000000021'
const PROJECT_B = '00000000-0000-4000-8000-000000000022'
const encode = (payload: object) => `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`
const STATE = encode({ o: 'org-a', u: 'user-1', e: 1, n: 'x' })
const MANAGE_STATE = encode({ o: 'org-a', u: 'user-1', c: CONNECTION_ID, e: 1, n: 'y' })
const CHECKLIST = [
  'Add the application to example-org as a service principal in Organization settings → Users: search by its client ID 00000000-0000-4000-8000-000000000002.',
  'Give the service principal the Basic access level; Stakeholder reaches no repository.'
]

const CONNECTION = {
  id: CONNECTION_ID,
  organization: 'example-org',
  organizationInstanceId: '00000000-0000-4000-8000-000000000011',
  tenantId: '00000000-0000-4000-8000-000000000001',
  identityId: '00000000-0000-4000-8000-000000000012',
  identityName: 'AgentConnect',
  credentialSource: 'deployment',
  clientId: null,
  state: 'connected',
  stateReason: null,
  credentialEpoch: '1',
  boundRepositories: 0,
  connectedBy: 'user-1',
  lastVerifiedAt: null,
  createdAt: '2026-11-01T00:00:00.000Z'
}

const started = (overrides: Record<string, unknown> = {}) => ({
  flowId: FLOW,
  ticket: 'ticket-1',
  tenantId: CONNECTION.tenantId,
  connectionId: null,
  organization: null,
  expiresAt: '2026-11-07T01:00:00.000Z',
  ...overrides
})

let root: Root
let host: HTMLElement

beforeEach(() => {
  vi.clearAllMocks()
  mocks.fetchOrgs.mockResolvedValue([{ id: 'org-a', slug: 'example', name: 'Example', role: 'owner' }])
  vi.spyOn(window.location, 'assign').mockImplementation(mocks.assign)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function land(query: string) {
  window.history.replaceState({}, '', `/azure-devops/connect?${query}`)
  await act(async () => root.render(<AzureDevOpsConnect />))
  await settle()
}

const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label))

async function click(label: string) {
  const target = button(label)
  if (!target) throw new Error(`button not found: ${label}`)
  await act(async () => target.click())
  await settle()
}

async function chooseProjects() {
  mocks.organizations.mockResolvedValue([{ id: 'acct-1', name: 'example-org' }])
  mocks.choose.mockResolvedValue({
    ticket: 'ticket-2',
    organization: 'example-org',
    projects: [
      { id: PROJECT_A, name: 'Example Project' },
      { id: PROJECT_B, name: 'Other Project' }
    ]
  })
  mocks.finish.mockResolvedValue(started())
  await land(`code=c&state=${STATE}`)
  await click('Continue')
  const box = host.querySelector<HTMLInputElement>(`[data-azure-devops-project="${PROJECT_A}"] input`)!
  await act(async () => box.click())
  await click('Contributors')
}

const refusal = () => host.querySelector('[data-azure-devops-refusal]')

describe('AzureDevOpsConnect', () => {
  it('reads the organization and the managed connection out of the signed state, and nothing out of a malformed one', () => {
    expect(azureDevOpsConnectState(STATE)).toEqual({ orgId: 'org-a', connectionId: null })
    expect(azureDevOpsConnectState(MANAGE_STATE)).toEqual({ orgId: 'org-a', connectionId: CONNECTION_ID })
    expect(azureDevOpsConnectState('not-json.sig')).toBeNull()
    expect(azureDevOpsConnectState(null)).toBeNull()
  })

  it('redeems the code, drops it from the address bar, then connects the organization with a group per project', async () => {
    mocks.apply.mockResolvedValue({ connection: CONNECTION, memberships: [] })
    await chooseProjects()

    expect(mocks.finish).toHaveBeenCalledWith('org-a', { state: STATE, code: 'c' })
    expect(window.location.search).toBe('')
    // The ticket travels with each step and is replaced by the one each step answers.
    expect(mocks.organizations).toHaveBeenCalledWith('org-a', FLOW, 'ticket-1')
    expect(mocks.choose).toHaveBeenCalledWith('org-a', FLOW, 'ticket-1', 'example-org')

    await click('Connect')
    expect(mocks.apply).toHaveBeenCalledWith('org-a', FLOW, 'ticket-2', [
      { projectId: PROJECT_A, group: 'contributors' }
    ])
    expect(host.textContent).toContain('Azure DevOps is connected')
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/example/integrations')
    // Never kept anywhere a later page could read it.
    expect(JSON.stringify({ ...window.localStorage })).not.toContain('ticket')
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain('ticket')
  })

  it('skips the organization picker for Manage project access', async () => {
    mocks.finish.mockResolvedValue(started({ connectionId: CONNECTION_ID, organization: 'example-org' }))
    mocks.choose.mockResolvedValue({
      ticket: 'ticket-2',
      organization: 'example-org',
      projects: [{ id: PROJECT_A, name: 'Example Project' }]
    })
    mocks.apply.mockResolvedValue({ connection: CONNECTION, memberships: [] })
    await land(`code=c&state=${MANAGE_STATE}`)
    expect(mocks.organizations).not.toHaveBeenCalled()
    expect(mocks.choose).toHaveBeenCalledWith('org-a', FLOW, 'ticket-1', 'example-org')
    const box = host.querySelector<HTMLInputElement>(`[data-azure-devops-project="${PROJECT_A}"] input`)!
    await act(async () => box.click())
    await click('Apply')
    expect(mocks.apply).toHaveBeenCalledWith('org-a', FLOW, 'ticket-2', [{ projectId: PROJECT_A, group: 'readers' }])
    expect(host.textContent).toContain('Project access updated')
  })

  it('sends missing consent to an Entra administrator with the admin-consent link', async () => {
    mocks.finish.mockRejectedValue(
      new mocks.FakeApiError('consent', 403, 'consent_required', {
        adminConsentUrl: 'https://login.example.test/adminconsent?client_id=x'
      })
    )
    await land(`error=consent_required&error_description=AADSTS65001&state=${STATE}`)
    expect(mocks.finish).toHaveBeenCalledWith('org-a', {
      state: STATE,
      error: 'consent_required',
      error_description: 'AADSTS65001'
    })
    expect(refusal()?.getAttribute('data-azure-devops-refusal')).toBe('consent_required')
    expect(host.textContent).toContain('Ask an Entra administrator to grant consent')
    expect(host.querySelector('a[href="https://login.example.test/adminconsent?client_id=x"]')).not.toBeNull()
  })

  it('signs in again at the tenant that owns the organization', async () => {
    mocks.finish.mockResolvedValue(started())
    mocks.organizations.mockResolvedValue([{ id: 'acct-1', name: 'example-org' }])
    mocks.choose.mockRejectedValue(
      new mocks.FakeApiError('other tenant', 409, 'tenant_mismatch', {
        authorizeUrl: 'https://login.example.test/tenant/authorize'
      })
    )
    await land(`code=c&state=${STATE}`)
    await click('Continue')
    expect(host.textContent).toContain('belongs to another Microsoft Entra tenant')
    await click('Sign in again')
    expect(mocks.assign).toHaveBeenCalledWith('https://login.example.test/tenant/authorize')
  })

  it.each([
    ['project_collection_administrator_required', 'Only a Project Collection Administrator'],
    ['entitlement_refused', 'Azure DevOps refused the access level'],
    ['memberships_incomplete', 'Some project memberships are missing'],
    ['not_in_organization', 'The application is not in the organization yet'],
    ['no_repository_access', 'The application sees no repository']
  ])('shows the checklist for %s and checks again with the ticket it carries', async (code, text) => {
    mocks.apply.mockRejectedValue(
      new mocks.FakeApiError('refused', 403, code, { checklist: CHECKLIST, ticket: 'ticket-resume' })
    )
    mocks.verify.mockResolvedValue({ connection: CONNECTION, memberships: [] })
    await chooseProjects()
    await click('Connect')

    expect(refusal()?.getAttribute('data-azure-devops-refusal')).toBe(code)
    expect(host.textContent).toContain(text)
    expect(host.querySelectorAll('li')).toHaveLength(2)
    expect(host.textContent).toContain('client ID 00000000-0000-4000-8000-000000000002')
    await click('Check again')
    expect(mocks.verify).toHaveBeenCalledWith('org-a', FLOW, 'ticket-resume')
    expect(host.textContent).toContain('Azure DevOps is connected')
  })

  it('starts over after a refusal that ends the flow', async () => {
    mocks.apply.mockRejectedValue(
      new mocks.FakeApiError('no rights', 403, 'insufficient_rights', { checklist: CHECKLIST })
    )
    mocks.start.mockResolvedValue({ authorizeUrl: 'https://login.example.test/authorize?state=new' })
    await chooseProjects()
    await click('Connect')
    expect(host.textContent).toContain('Your account cannot grant this access')
    expect(button('Check again')).toBeUndefined()
    await click('Start over')
    expect(mocks.start).toHaveBeenCalledWith(undefined, 'org-a')
    expect(mocks.assign).toHaveBeenCalledWith('https://login.example.test/authorize?state=new')
  })

  it.each([
    ['personal_account', 'Use a work or school account'],
    ['connect_flow_invalid', 'This sign-in has expired']
  ])('names %s', async (code, text) => {
    mocks.finish.mockRejectedValue(new mocks.FakeApiError('refused', 400, code))
    await land(`code=c&state=${STATE}`)
    expect(host.textContent).toContain(text)
    expect(button('Start over')).toBeTruthy()
  })

  it('offers another organization when the chosen one is taken', async () => {
    mocks.finish.mockResolvedValue(started())
    mocks.organizations.mockResolvedValue([
      { id: 'acct-1', name: 'example-org' },
      { id: 'acct-2', name: 'example-second' }
    ])
    mocks.choose.mockRejectedValue(new mocks.FakeApiError('taken', 409, 'AZURE_DEVOPS_ORGANIZATION_TAKEN'))
    await land(`code=c&state=${STATE}`)
    const radio = host.querySelector<HTMLInputElement>('input[type="radio"]')!
    await act(async () => radio.click())
    await click('Continue')
    expect(host.textContent).toContain('already connected to another organization')
    await click('Choose another organization')
    expect(host.querySelectorAll('input[type="radio"]')).toHaveLength(2)
  })

  it('names a landing without a state as expired and posts nothing', async () => {
    await land('code=c')
    expect(host.textContent).toContain('This sign-in has expired')
    expect(mocks.finish).not.toHaveBeenCalled()
  })
})
