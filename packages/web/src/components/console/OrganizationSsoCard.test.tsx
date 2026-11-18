// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrgSsoConnectionDto, OrgSsoDomainDto, OrgSsoStateDto } from '@/lib/api'

const mocks = vi.hoisted(() => ({
  fetchOrgSso: vi.fn(),
  verifyOrgSsoDomain: vi.fn(),
  releaseOrgSsoDomain: vi.fn(),
  prepareOrgSsoConnection: vi.fn(),
  saveOrgSsoConnection: vi.fn(),
  startOrgSsoTest: vi.fn(),
  activateOrgSsoConnection: vi.fn(),
  removeOrgSsoConnection: vi.fn(),
  loginWithSso: vi.fn()
}))

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchOrgSso: mocks.fetchOrgSso,
  verifyOrgSsoDomain: mocks.verifyOrgSsoDomain,
  releaseOrgSsoDomain: mocks.releaseOrgSsoDomain,
  prepareOrgSsoConnection: mocks.prepareOrgSsoConnection,
  saveOrgSsoConnection: mocks.saveOrgSsoConnection,
  startOrgSsoTest: mocks.startOrgSsoTest,
  activateOrgSsoConnection: mocks.activateOrgSsoConnection,
  removeOrgSsoConnection: mocks.removeOrgSsoConnection
}))
vi.mock('@/lib/auth', () => ({
  currentUser: () => ({ name: 'Dana', email: 'dana@acme.example', initials: 'D' }),
  loginWithSso: mocks.loginWithSso
}))
vi.mock('next/navigation', () => ({ usePathname: () => '/acme/settings' }))

import { OrganizationSsoCard } from './OrganizationSsoCard'

const domain = (name: string, patch: Partial<OrgSsoDomainDto> = {}): OrgSsoDomainDto => ({
  id: `id-${name}`,
  domain: name,
  status: 'verified',
  record: { type: 'TXT', name: `_agentconnect-challenge.${name}`, value: 'ac-verify=example' },
  challengeExpiresAt: null,
  verifiedAt: '2026-01-01T00:00:00Z',
  lastCheckedAt: null,
  lastCheckOk: null,
  ...patch
})

const connection = (patch: Partial<OrgSsoConnectionDto> = {}): OrgSsoConnectionDto => ({
  id: 'conn',
  protocol: 'oidc',
  name: 'Example IdP',
  status: 'draft',
  tested: false,
  testedAt: null,
  activatedAt: null,
  configChangedAt: '2026-01-01T00:00:00Z',
  needsConfiguration: false,
  settings: { issuer: 'https://idp.example.test', clientId: 'client', scope: 'openid email', hasClientSecret: true },
  serviceProvider: { redirectUri: 'https://auth.example.test/callback/abc' },
  ...patch
})

let host: HTMLDivElement
let root: Root

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function render(state: OrgSsoStateDto, isOwner = true) {
  mocks.fetchOrgSso.mockResolvedValue(state)
  // A fresh mount per state: a second render would answer from the first one's cache.
  await act(async () => root.unmount())
  root = createRoot(host)
  await act(async () => {
    root.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <OrganizationSsoCard orgId="org-test" isOwner={isOwner} />
      </SWRConfig>
    )
  })
  await settle()
}

const buttons = (scope: ParentNode = document.body) =>
  [...scope.querySelectorAll('button')].map((button) => button.getAttribute('aria-label') ?? button.textContent)

const button = (label: string, scope: ParentNode = document.body) => {
  const found = [...scope.querySelectorAll('button')].find(
    (candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent) === label
  )
  if (!found) throw new Error(`no button "${label}" among ${buttons(scope).join(', ')}`)
  return found
}

async function click(label: string, scope?: ParentNode) {
  await act(async () => button(label, scope).click())
  await settle()
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const dialog = () => document.body.querySelector('[role="dialog"]') as HTMLElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  sessionStorage.clear()
  for (const mock of Object.values(mocks)) mock.mockReset()
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('organization single sign-on card', () => {
  it('starts with one action for an owner and nothing for anyone else', async () => {
    await render({ domains: [], connection: null })
    expect(host.textContent).toContain('No domains')
    expect(buttons(host)).toEqual(['Add domain'])

    await render({ domains: [], connection: null }, false)
    expect(host.innerHTML).toBe('')
  })

  it('shows the DNS record of a pending domain and what a failed verify found', async () => {
    const pending = domain('acme.example', { status: 'pending', verifiedAt: null })
    await render({ domains: [pending], connection: null })
    expect(host.textContent).toContain('_agentconnect-challenge.acme.example')
    // No connection section until a domain is verified.
    expect(host.textContent).not.toContain('Connection')

    mocks.verifyOrgSsoDomain.mockResolvedValue({ domain: pending, check: 'not_found' })
    await click('Verify', host)
    expect(mocks.verifyOrgSsoDomain).toHaveBeenCalledWith(pending.id, 'org-test')
    expect(host.textContent).toContain('Record not found')
  })

  it('offers the next step of the connection and nothing else', async () => {
    const domains = [domain('acme.example')]
    await render({ domains, connection: null })
    expect(buttons(host)).toEqual(['Add domain', 'Remove domain', 'Set up connection'])

    await render({ domains, connection: connection() })
    expect(buttons(host)).toEqual(['Add domain', 'Remove domain', 'Test sign-in', 'Edit'])

    await render({ domains, connection: connection({ status: 'tested', tested: true }) })
    expect(buttons(host)).toEqual(['Add domain', 'Remove domain', 'Activate', 'Edit'])

    await render({ domains, connection: connection({ status: 'active', tested: true }) })
    expect(buttons(host)).toEqual(['Add domain', 'Remove domain', 'Edit', 'Deactivate'])
    // An active connection is named on each domain it binds.
    expect(host.textContent).toContain('VerifiedExample IdP')

    await render({ domains, connection: connection({ status: 'active', needsConfiguration: true, settings: null }) })
    expect(buttons(host)).toEqual(['Add domain', 'Remove domain', 'Reconfigure'])
    expect(host.textContent).toContain('Needs configuration')
  })

  it('shows a member the status without actions or DNS records', async () => {
    await render(
      {
        domains: [domain('acme.example', { lastCheckOk: false })],
        connection: connection({ status: 'active', tested: true, settings: null })
      },
      false
    )
    expect(buttons(host)).toEqual([])
    expect(host.textContent).toContain('Active')
    expect(host.textContent).not.toContain('ac-verify=')
  })

  it('offers Verify and the record again when the daily re-check failed', async () => {
    await render({
      domains: [domain('acme.example', { lastCheckOk: false })],
      connection: connection({ status: 'active', tested: true })
    })
    expect(host.textContent).toContain('DNS record missing')
    expect(host.textContent).toContain('ac-verify=example')
    expect(buttons(host)).toContain('Verify')
  })

  it('asks before verifying a domain that an active connection will bind', async () => {
    const pending = domain('acme.io', { status: 'pending', verifiedAt: null })
    await render({
      domains: [domain('acme.example'), pending],
      connection: connection({ status: 'active', tested: true })
    })
    await click('Verify', host)
    expect(mocks.verifyOrgSsoDomain).not.toHaveBeenCalled()
    expect(dialog().textContent).toContain('Verify acme.io?')

    mocks.verifyOrgSsoDomain.mockResolvedValue({ domain: { ...pending, status: 'verified' }, check: 'ok' })
    await click('Verify', dialog())
    expect(mocks.verifyOrgSsoDomain).toHaveBeenCalledWith(pending.id, 'org-test')
  })

  it('says a verified domain is in use when the connection keeps it', async () => {
    const { ApiError } = await import('@/lib/api')
    await render({ domains: [domain('acme.example')], connection: connection() })
    mocks.releaseOrgSsoDomain.mockRejectedValue(new ApiError('refused', 409, 'SSO_DOMAIN_IN_USE'))
    await click('Remove domain', host)
    expect(host.textContent).toContain('In use by the connection')
  })

  it('keeps the saved client secret on an edit and asks for it again when the issuer changes', async () => {
    await render({ domains: [domain('acme.example')], connection: connection() })
    await click('Edit', host)
    expect(dialog().textContent).toContain('Edit connection')
    expect(dialog().textContent).toContain('https://auth.example.test/callback/abc')
    expect(mocks.prepareOrgSsoConnection).not.toHaveBeenCalled()
    expect(dialog().querySelector('input[type="password"]')).toBeNull()

    mocks.saveOrgSsoConnection.mockResolvedValue(connection())
    await click('Save', dialog())
    expect(mocks.saveOrgSsoConnection).toHaveBeenCalledWith(
      {
        protocol: 'oidc',
        name: 'Example IdP',
        issuer: 'https://idp.example.test',
        clientId: 'client',
        scope: 'openid email'
      },
      'org-test'
    )

    await click('Edit', host)
    const issuer = [...dialog().querySelectorAll('input')].find((input) => input.value === 'https://idp.example.test')!
    await type(issuer, 'https://other.example.test')
    expect(dialog().querySelector('input[type="password"]')).not.toBeNull()
    expect(button('Save', dialog()).disabled).toBe(true)
  })

  it('shows the service-provider values before the first save', async () => {
    mocks.prepareOrgSsoConnection.mockResolvedValue({ redirectUri: 'https://auth.example.test/callback/new' })
    await render({ domains: [domain('acme.example')], connection: null })
    await click('Set up connection', host)
    expect(mocks.prepareOrgSsoConnection).toHaveBeenCalledWith('oidc', 'org-test')
    expect(dialog().textContent).toContain('https://auth.example.test/callback/new')

    mocks.prepareOrgSsoConnection.mockResolvedValue({
      assertionConsumerServiceUrl: 'https://auth.example.test/acs/new',
      entityId: 'https://auth.example.test/entity/new'
    })
    await act(async () => (dialog().querySelector('[role="radio"]:not([aria-checked="true"])') as HTMLElement).click())
    await settle()
    expect(mocks.prepareOrgSsoConnection).toHaveBeenLastCalledWith('saml', 'org-test')
    expect(dialog().textContent).toContain('https://auth.example.test/entity/new')
  })

  it('keeps the protocol of an existing connection', async () => {
    await render({ domains: [domain('acme.example')], connection: connection() })
    await click('Edit', host)
    const radios = [...dialog().querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    expect(radios.map((radio) => radio.disabled)).toEqual([true, true])
  })

  it('keeps a saved SAML subject-ID mapping the dialog has no field for', async () => {
    const saml = connection({
      protocol: 'saml',
      settings: {
        metadataUrl: 'https://idp.example.test/metadata',
        metadata: null,
        attributeMapping: { id: 'employeeId', email: 'mail' }
      },
      serviceProvider: {
        assertionConsumerServiceUrl: 'https://auth.example.test/acs/abc',
        entityId: 'https://auth.example.test/entity/abc'
      }
    })
    await render({ domains: [domain('acme.example')], connection: saml })
    await click('Edit', host)
    mocks.saveOrgSsoConnection.mockResolvedValue(saml)
    await click('Save', dialog())
    expect(mocks.saveOrgSsoConnection).toHaveBeenCalledWith(
      {
        protocol: 'saml',
        name: 'Example IdP',
        metadataUrl: 'https://idp.example.test/metadata',
        attributeMapping: { id: 'employeeId', email: 'mail', name: 'name' }
      },
      'org-test'
    )
  })

  it('stashes the nonce and leaves for the connector on a test sign-in', async () => {
    await render({ domains: [domain('acme.example')], connection: connection() })
    await click('Test sign-in', host)
    expect(dialog().textContent).toContain('dana@acme.example')

    const expiresAt = new Date(Date.now() + 600_000).toISOString()
    mocks.startOrgSsoTest.mockResolvedValue({ nonce: 'nonce-1', connectorId: 'connector-1', expiresAt })
    await click('Test sign-in', dialog())
    expect(mocks.loginWithSso).toHaveBeenCalledWith('connector-1')
    expect(JSON.parse(sessionStorage.getItem('ac.ssoTest')!)).toEqual({
      nonce: 'nonce-1',
      connectionName: 'Example IdP',
      returnTo: '/acme/settings#single-sign-on',
      expiresAt
    })
  })

  it('keeps the activation dialog open with what the Control Plane refused', async () => {
    await render({ domains: [domain('acme.example')], connection: connection({ status: 'tested', tested: true }) })
    await click('Activate', host)
    expect(dialog().textContent).toContain('acme.example')
    mocks.activateOrgSsoConnection.mockRejectedValue(
      new Error('the DNS record could not be confirmed for acme.example')
    )
    await click('Activate', dialog())
    expect(dialog().textContent).toContain('the DNS record could not be confirmed for acme.example')
  })

  it('says at activation when no owner keeps a way in outside the domains, and still activates', async () => {
    const tested = connection({ status: 'tested', tested: true })
    await render({ domains: [domain('acme.example')], connection: tested, ownerOutsideDomains: true })
    await click('Activate', host)
    expect(dialog().textContent).not.toContain('No owner has an address outside these domains')

    await render({ domains: [domain('acme.example')], connection: tested, ownerOutsideDomains: false })
    await click('Activate', host)
    expect(dialog().textContent).toContain(
      'No owner has an address outside these domains. If Example IdP stops working, no owner will be able to open this organization.'
    )
    mocks.activateOrgSsoConnection.mockResolvedValue(undefined)
    await click('Activate', dialog())
    expect(mocks.activateOrgSsoConnection).toHaveBeenCalledWith('org-test')
  })

  it('removes the connection from its edit dialog after a confirmation', async () => {
    mocks.prepareOrgSsoConnection.mockResolvedValue({ redirectUri: 'https://auth.example.test/callback/new' })
    await render({ domains: [domain('acme.example')], connection: null })
    await click('Set up connection', host)
    expect(buttons(dialog())).not.toContain('Remove connection')

    await render({ domains: [domain('acme.example')], connection: connection() })
    await click('Edit', host)
    await click('Remove connection', dialog())
    expect(dialog().textContent).toContain('Remove Example IdP?')
    expect(dialog().textContent).not.toContain('acme.example')
    expect(mocks.removeOrgSsoConnection).not.toHaveBeenCalled()

    mocks.removeOrgSsoConnection.mockResolvedValue(undefined)
    mocks.fetchOrgSso.mockResolvedValue({ domains: [domain('acme.example')], connection: null })
    await click('Remove connection', dialog())
    expect(mocks.removeOrgSsoConnection).toHaveBeenCalledWith('org-test')
    expect(dialog()).toBeNull()
    expect(buttons(host)).toContain('Set up connection')
  })

  it('names the domains that removing an active connection frees', async () => {
    await render({
      domains: [domain('acme.example')],
      connection: connection({ status: 'active', tested: true })
    })
    await click('Edit', host)
    await click('Remove connection', dialog())
    expect(dialog().textContent).toContain('acme.example')
    expect(dialog().textContent).toContain('any method again')
  })
})
