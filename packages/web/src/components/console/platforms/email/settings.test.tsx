// @vitest-environment happy-dom

// An email address's settings on the agent page (email-integration.md §4.1): the card's status line, and the dialog its gear opens.

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

import { EmailSettingsButton, EmailSettingsStatus } from './settings'

const integration = {
  id: 'int-email',
  agentId: 'agent-a',
  platform: 'email',
  channels: []
} as unknown as IntegrationRow

let host: HTMLDivElement
let root: Root

const status = () => [...host.children].find((el) => el.tagName === 'P')?.textContent
const gear = () => document.querySelector<HTMLButtonElement>('button[aria-label="Email settings"]')
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const radio = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === label)
const button = (label: string) =>
  [...dialog()!.querySelectorAll<HTMLButtonElement>('.modalfoot button')].find((b) => b.textContent === label)!
const memberPicker = () => document.querySelector<HTMLButtonElement>('button[aria-label="Member"]')
const option = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((b) =>
    b.textContent?.includes(label)
  )

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
        <EmailSettingsButton integration={integration} />
        <EmailSettingsStatus integration={integration} padX={14} />
      </SWRConfig>
    )
  )
  await settle()
}

async function click(target: HTMLElement | null | undefined): Promise<void> {
  await act(async () => target!.click())
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
      input.outsideSessions.kind === 'member'
        ? { kind: 'member', userId: input.outsideSessions.userId, active: true }
        : { kind: input.outsideSessions.kind }
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

describe('an email address’s status line', () => {
  it('says the address takes mail from members', async () => {
    await render(MEMBERS_ONLY)
    expect(status()).toBe('Accepts mail from organization members')
  })

  it('names the one member who sees mail from outside', async () => {
    await render({ ...MEMBERS_ONLY, whoMayWrite: 'anyone' })
    expect(status()).toBe('Accepts mail from anyone · External mail: visible only to Ann')
  })

  it('says everyone in the organization sees mail from outside', async () => {
    await render({ whoMayWrite: 'anyone', outsideSessions: { kind: 'org' } })
    expect(status()).toBe('Accepts mail from anyone · External mail: visible to everyone in the organization')
  })

  it('says the people who can edit the agent see mail from outside', async () => {
    await render({ whoMayWrite: 'anyone', outsideSessions: { kind: 'editors' } })
    expect(status()).toBe('Accepts mail from anyone · External mail: people who can edit this agent')
  })

  it('says outside mail is refused while the picked member is gone', async () => {
    await render({ whoMayWrite: 'anyone', outsideSessions: { kind: 'member', userId: 'user-left', active: false } })
    expect(status()).toBe('Accepts mail from anyone · External mail: nobody can view it, so it’s refused')
  })
})

describe('an email address’s settings dialog', () => {
  it('offers the gear to an editor of the agent alone', async () => {
    mocks.canEdit = false
    await render(MEMBERS_ONLY)
    expect(status()).toBe('Accepts mail from organization members')
    expect(gear()).toBeNull()
  })

  it('shows who sees outside mail only under Anyone, and saves both at once', async () => {
    await render(MEMBERS_ONLY)
    await click(gear())
    expect(dialog()?.getAttribute('aria-labelledby')).toBeTruthy()
    expect(dialog()?.textContent).toContain('Email settings')
    expect(radio('Members of your organization')?.getAttribute('aria-checked')).toBe('true')
    expect(radio('A specific member')).toBeUndefined()

    await click(radio('Anyone'))
    expect(radio('A specific member')?.getAttribute('aria-checked')).toBe('true')
    expect(memberPicker()?.textContent).toContain('Ann')
    expect(mocks.saveSettings).not.toHaveBeenCalled()

    await click(button('Save'))
    expect(mocks.saveSettings).toHaveBeenCalledTimes(1)
    expect(mocks.saveSettings).toHaveBeenCalledWith('org-a', 'int-email', {
      whoMayWrite: 'anyone',
      outsideSessions: { kind: 'member', userId: 'user-ann' }
    })
    expect(dialog()).toBeNull()
    expect(status()).toBe('Accepts mail from anyone · External mail: visible only to Ann')
  })

  it('gives outside mail to the organization or to another member', async () => {
    await render({ ...MEMBERS_ONLY, whoMayWrite: 'anyone' })
    await click(gear())
    await click(radio('Everyone in the organization'))
    await click(button('Save'))
    expect(mocks.saveSettings).toHaveBeenLastCalledWith('org-a', 'int-email', {
      whoMayWrite: 'anyone',
      outsideSessions: { kind: 'org' }
    })

    await click(gear())
    expect(radio('A specific member')?.getAttribute('aria-checked')).toBe('false')
    expect(memberPicker()?.textContent).toContain('Choose a member')
    await click(memberPicker())
    await click(option('Me'))
    expect(radio('A specific member')?.getAttribute('aria-checked')).toBe('true')
    await click(button('Save'))
    expect(mocks.saveSettings).toHaveBeenLastCalledWith('org-a', 'int-email', {
      whoMayWrite: 'anyone',
      outsideSessions: { kind: 'member', userId: 'user-me' }
    })
    expect(status()).toBe('Accepts mail from anyone · External mail: visible only to Me')
  })

  it('lists the agent’s editors first, marked as the default, then the organization, then a specific member', async () => {
    await render({ whoMayWrite: 'anyone', outsideSessions: { kind: 'org' } })
    await click(gear())
    const outside = [...document.querySelectorAll('[role="radiogroup"]')][1]!
    expect([...outside.querySelectorAll('[role="radio"]')].map((r) => r.textContent)).toEqual([
      'People who can edit this agentDefault',
      'Everyone in the organization',
      'A specific member'
    ])
  })

  it('keeps the editors default when a fresh address is switched to Anyone and saved', async () => {
    await render({ whoMayWrite: 'members', outsideSessions: { kind: 'editors' } })
    await click(gear())
    await click(radio('Anyone'))
    expect(radio('People who can edit this agentDefault')?.getAttribute('aria-checked')).toBe('true')
    expect(radio('A specific member')?.getAttribute('aria-checked')).toBe('false')
    await click(button('Save'))
    expect(mocks.saveSettings).toHaveBeenLastCalledWith('org-a', 'int-email', {
      whoMayWrite: 'anyone',
      outsideSessions: { kind: 'editors' }
    })
    expect(status()).toBe('Accepts mail from anyone · External mail: people who can edit this agent')

    await click(gear())
    await click(radio('Everyone in the organization'))
    await click(radio('People who can edit this agentDefault'))
    await click(button('Save'))
    // Back on what was saved, Save writes nothing.
    expect(mocks.saveSettings).toHaveBeenCalledTimes(1)
  })

  it('keeps a stored outside choice when only "Accept mail from" changes', async () => {
    await render({ whoMayWrite: 'anyone', outsideSessions: { kind: 'editors' } })
    await click(gear())
    await click(radio('Members of your organization'))
    await click(button('Save'))
    expect(mocks.saveSettings).toHaveBeenLastCalledWith('org-a', 'int-email', {
      whoMayWrite: 'members',
      outsideSessions: { kind: 'editors' }
    })
    await click(gear())
    await click(radio('Anyone'))
    await click(button('Save'))
    expect(mocks.saveSettings).toHaveBeenLastCalledWith('org-a', 'int-email', {
      whoMayWrite: 'anyone',
      outsideSessions: { kind: 'editors' }
    })
    expect(mocks.saveSettings).toHaveBeenCalledTimes(2)
  })

  it('waits for a member to be picked when none is saved', async () => {
    await render({ whoMayWrite: 'members', outsideSessions: { kind: 'member', userId: 'user-left', active: false } })
    await click(gear())
    await click(radio('Anyone'))
    expect(button('Save').disabled).toBe(true)
    await click(memberPicker())
    await click(option('Me'))
    await click(button('Save'))
    expect(mocks.saveSettings).toHaveBeenLastCalledWith('org-a', 'int-email', {
      whoMayWrite: 'anyone',
      outsideSessions: { kind: 'member', userId: 'user-me' }
    })
  })

  it('names nobody in the picker while the picked member is gone', async () => {
    await render({ whoMayWrite: 'anyone', outsideSessions: { kind: 'member', userId: 'user-left', active: false } })
    await click(gear())
    expect(memberPicker()?.textContent).toContain('Nobody')
  })

  it('discards the draft on Cancel', async () => {
    await render(MEMBERS_ONLY)
    await click(gear())
    await click(radio('Anyone'))
    await click(button('Cancel'))
    expect(dialog()).toBeNull()
    expect(mocks.saveSettings).not.toHaveBeenCalled()
    expect(status()).toBe('Accepts mail from organization members')
  })

  it('says so inside the dialog when the change could not be saved', async () => {
    mocks.saveSettings.mockRejectedValueOnce(new Error('unavailable'))
    await render(MEMBERS_ONLY)
    await click(gear())
    await click(radio('Anyone'))
    await click(button('Save'))
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain('Couldn’t save settings')
    expect(radio('Anyone')?.getAttribute('aria-checked')).toBe('true')
    expect(status()).toBe('Accepts mail from organization members')
  })
})
