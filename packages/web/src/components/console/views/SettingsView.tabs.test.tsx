// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  search: new URLSearchParams(),
  ssoFlag: true,
  role: 'owner' as 'owner' | 'collaborator',
  sso: { domains: [] as { status: string }[], connection: null as unknown, memberSource: 'invite' }
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => state.search,
  usePathname: () => '/acme/settings'
}))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({
    activeOrg: { id: 'org-test', slug: 'acme', name: 'Acme' },
    myRole: state.role,
    orgPath: (path: string) => `/acme${path}`,
    refreshOrgs: vi.fn(),
    updateOrg: vi.fn(),
    leaveOrg: vi.fn(),
    error: null
  })
}))
vi.mock('@/lib/data-context', () => ({ useConsoleData: () => ({ agents: [] }) }))
vi.mock('@/components/console/ModalProvider', () => ({ useModal: () => ({ openModal: vi.fn() }) }))
vi.mock('@/lib/organization-sso', () => ({ organizationSsoEnabled: () => state.ssoFlag }))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchMembers: async () => [],
  fetchOrgInviteLink: async () => null,
  fetchOrgSso: async () => state.sso,
  fetchSessionExternalAccess: async (provider: string) => ({
    provider,
    available: true,
    enabled: false,
    state: 'disabled',
    currentRevision: '1',
    readFenceRevision: null
  })
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  )
}))
vi.mock('@/components/console/AgentIconPicker', () => ({ AgentIconPicker: () => null }))
vi.mock('@/components/console/OrganizationEnvironmentCard', () => ({
  OrganizationEnvironmentCard: () => <div className="card" id="environment" />
}))
vi.mock('@/components/console/ServiceAccountsCard', () => ({
  ServiceAccountsCard: () => <div className="card" id="service-accounts" />
}))
vi.mock('@/components/console/OrganizationSsoCard', () => ({
  OrganizationSsoCard: () => <div className="card" id="single-sign-on" />,
  OrganizationMemberSourceCard: () => <div className="card" id="new-members" />
}))

import SettingsView from './SettingsView'

let host: HTMLDivElement
let root: Root

async function render(query = '') {
  state.search = new URLSearchParams(query)
  await act(async () => {
    root.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <SettingsView />
      </SWRConfig>
    )
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const tabs = () =>
  [...host.querySelectorAll('[role="tab"]')].map((tab) => [
    tab.textContent,
    tab.getAttribute('href'),
    tab.getAttribute('aria-selected')
  ])
const cards = () => [...host.querySelectorAll('.card[id]')].map((card) => card.id)

beforeEach(() => {
  // The organization avatar asks for the runtime registry; nothing here needs it.
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in tests')))
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  state.ssoFlag = true
  state.role = 'owner'
  state.sso = { domains: [], connection: null, memberSource: 'invite' }
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await act(async () => root.unmount())
  host.remove()
})

describe('organization settings tabs', () => {
  it('opens General on the bare path', async () => {
    await render()
    expect(tabs()).toEqual([
      ['General', '/acme/settings', 'true'],
      ['Members', '/acme/settings?tab=members', 'false'],
      ['Single sign-on', '/acme/settings?tab=sso', 'false']
    ])
    expect(cards()).toEqual([
      'organization',
      'agent-visibility',
      'session-access',
      'daemon-auto-upgrade',
      'environment'
    ])
  })

  it('shows each tab its own cards', async () => {
    await render('tab=members')
    expect(cards()).toEqual(['members', 'new-members', 'invite-links', 'service-accounts'])

    await render('tab=sso')
    expect(cards()).toEqual(['single-sign-on'])
  })

  it('has no Single sign-on tab or New members card with the feature off', async () => {
    state.ssoFlag = false
    await render('tab=sso')
    expect(tabs().map(([label]) => label)).toEqual(['General', 'Members'])
    expect(cards()).toContain('organization')

    await render('tab=members')
    expect(cards()).not.toContain('new-members')
  })

  it('shows a non-owner the Single sign-on tab only when there is something to read', async () => {
    state.role = 'collaborator'
    await render('tab=sso')
    expect(tabs().map(([label]) => label)).toEqual(['General', 'Members'])
    expect(cards()).toContain('organization')

    await act(async () => root.unmount())
    root = createRoot(host)
    state.sso = { domains: [{ status: 'verified' }], connection: null, memberSource: 'invite' }
    await render('tab=sso')
    expect(tabs().map(([label]) => label)).toEqual(['General', 'Members', 'Single sign-on'])
    expect(cards()).toEqual(['single-sign-on'])
  })
})
