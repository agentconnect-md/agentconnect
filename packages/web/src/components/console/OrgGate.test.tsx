// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrgDto } from '@/lib/api'

const mocks = vi.hoisted(() => ({
  activeOrg: null as OrgDto | null,
  loginWithSso: vi.fn(),
  writeFlowState: vi.fn()
}))

vi.mock('@/lib/org-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/org-context')>()),
  useOrgs: () => ({ activeOrg: mocks.activeOrg, loading: false, error: null, refreshOrgs: vi.fn() })
}))
vi.mock('@/lib/auth', () => ({
  currentUser: () => ({ name: 'Dana', email: 'dana@acme.example', initials: 'D' }),
  loginWithSso: mocks.loginWithSso
}))
vi.mock('@/lib/flow-state', () => ({ writeFlowState: mocks.writeFlowState }))

import { OrgGate } from './OrgGate'

const org = (patch: Partial<OrgDto> = {}): OrgDto => ({
  id: 'org-acme',
  name: 'Acme',
  slug: 'acme',
  icon: null,
  iconUrl: null,
  iconUploadEnabled: false,
  role: 'collaborator',
  memberCount: 3,
  createdAt: '2026-01-01T00:00:00Z',
  ...patch
})

let host: HTMLDivElement
let root: Root

async function render() {
  await act(async () => {
    root.render(
      <OrgGate>
        <p>organization pages</p>
      </OrgGate>
    )
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  mocks.loginWithSso.mockReset()
  mocks.writeFlowState.mockReset()
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('organization gate', () => {
  it('shows the organization’s pages when the session may open it', async () => {
    mocks.activeOrg = org({ ssoSignIn: null })
    await render()
    expect(host.textContent).toBe('organization pages')
  })

  it('leads a session the organization does not accept straight to its connection, and returns here', async () => {
    window.history.replaceState(null, '', '/acme/agents?tab=all')
    mocks.activeOrg = org({ ssoSignIn: { connectorId: 'connector-acme' } })
    await render()
    expect(host.textContent).not.toContain('organization pages')
    expect(host.querySelector('h1')?.textContent).toBe('Acme requires single sign-on')

    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Sign in with SSO')!
    await act(async () => button.click())
    expect(mocks.writeFlowState).toHaveBeenCalledWith('returnTo', '/acme/agents?tab=all')
    expect(mocks.loginWithSso).toHaveBeenCalledWith('connector-acme', 'dana@acme.example')
  })
})
