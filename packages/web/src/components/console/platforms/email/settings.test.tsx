// @vitest-environment happy-dom

// An email address's two settings on the agent page (email-integration.md §4.1): who may write, and under Anyone who sees an outside sender's session.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EmailSettingsDto, EmailSettingsInput, MemberDto } from '@/lib/api'
import type { Agent, IntegrationRow } from '@/lib/data'

const mocks = vi.hoisted(() => ({
  settings: vi.fn<(orgId: string, integrationId: string) => Promise<EmailSettingsDto>>(),
  saveSettings:
    vi.fn<(orgId: string, integrationId: string, settings: EmailSettingsInput) => Promise<EmailSettingsDto>>(),
  canEdit: true
}))

const MEMBERS = [
  { userId: 'user-ann', name: 'Ann', email: 'ann@corp.example.test', isCurrentUser: false },
  { userId: 'user-me', name: 'Me', email: 'me@corp.example.test', isCurrentUser: true }
] as MemberDto[]

vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ activeOrg: { id: 'org-a' } }) }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    members: MEMBERS,
    getAgent: (id: string) => ({ id, name: 'helper', canEdit: mocks.canEdit }) as unknown as Agent
  })
}))
vi.mock('./api', () => ({ emailApi: { settings: mocks.settings, saveSettings: mocks.saveSettings } }))

import { EmailAddressSettings } from './settings'

const integration = {
  id: 'int-email',
  agentId: 'agent-a',
  platform: 'email',
  channels: []
} as unknown as IntegrationRow

let host: HTMLDivElement
let root: Root

const buttons = () => [...document.querySelectorAll('button')]
const select = (label: string) => buttons().find((b) => b.getAttribute('aria-label') === label) as HTMLButtonElement
const option = (label: string) =>
  [...document.querySelectorAll('[role="menuitemradio"]')].find((b) => b.textContent?.includes(label)) as
    HTMLButtonElement | undefined

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
}

async function render(settings: EmailSettingsDto): Promise<void> {
  mocks.settings.mockResolvedValue(settings)
  await act(async () =>
    root.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <EmailAddressSettings integration={integration} padX={14} />
      </SWRConfig>
    )
  )
  await settle()
}

async function pick(field: string, label: string): Promise<void> {
  await act(async () => select(field).click())
  await act(async () => option(label)!.click())
  await settle()
}

const MEMBERS_ONLY: EmailSettingsDto = {
  whoMayWrite: 'members',
  outsideSessions: { kind: 'member', userId: 'user-ann', active: true }
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.settings.mockReset()
  mocks.saveSettings.mockReset()
  mocks.saveSettings.mockImplementation(async (_org, _id, input) => ({
    whoMayWrite: input.whoMayWrite,
    outsideSessions:
      input.outsideSessions.kind === 'org'
        ? { kind: 'org' }
        : { kind: 'member', userId: input.outsideSessions.userId, active: true }
  }))
  mocks.canEdit = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

describe('an email address’s settings', () => {
  it('shows who may write, and the outside sessions only under Anyone', async () => {
    await render(MEMBERS_ONLY)
    expect(select('Who may write').textContent).toContain('Members')
    expect(select("Outside senders' sessions")).toBeUndefined()

    await pick('Who may write', 'Anyone')
    expect(mocks.saveSettings).toHaveBeenCalledWith('org-a', 'int-email', {
      whoMayWrite: 'anyone',
      outsideSessions: { kind: 'member', userId: 'user-ann' }
    })
    expect(select("Outside senders' sessions").textContent).toContain('Ann')
  })

  it('gives outside sessions to the organization or to another member', async () => {
    await render({ ...MEMBERS_ONLY, whoMayWrite: 'anyone' })
    await pick("Outside senders' sessions", 'Organization')
    expect(mocks.saveSettings).toHaveBeenLastCalledWith('org-a', 'int-email', {
      whoMayWrite: 'anyone',
      outsideSessions: { kind: 'org' }
    })
    await pick("Outside senders' sessions", 'Me')
    expect(mocks.saveSettings).toHaveBeenLastCalledWith('org-a', 'int-email', {
      whoMayWrite: 'anyone',
      outsideSessions: { kind: 'member', userId: 'user-me' }
    })
  })

  it('names nobody while the picked member is gone', async () => {
    await render({ whoMayWrite: 'anyone', outsideSessions: { kind: 'member', userId: 'user-left', active: false } })
    expect(select("Outside senders' sessions").textContent).toContain('Nobody')
  })

  it('makes the editor the pick when opening to Anyone with nobody picked', async () => {
    await render({ whoMayWrite: 'members', outsideSessions: { kind: 'member', userId: null, active: false } })
    await pick('Who may write', 'Anyone')
    expect(mocks.saveSettings).toHaveBeenLastCalledWith('org-a', 'int-email', {
      whoMayWrite: 'anyone',
      outsideSessions: { kind: 'member', userId: 'user-me' }
    })
  })

  it('lets only an editor of the agent change them', async () => {
    mocks.canEdit = false
    await render({ ...MEMBERS_ONLY, whoMayWrite: 'anyone' })
    expect(select('Who may write').disabled).toBe(true)
    expect(select("Outside senders' sessions").disabled).toBe(true)
  })

  it('says so when a change could not be saved', async () => {
    mocks.saveSettings.mockRejectedValueOnce(new Error('unavailable'))
    await render(MEMBERS_ONLY)
    await pick('Who may write', 'Anyone')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('could not be saved')
    expect(select('Who may write').textContent).toContain('Members')
  })
})
