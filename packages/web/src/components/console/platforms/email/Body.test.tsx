// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type EmailAddressCheckDto } from '@/lib/api'
import type { Agent } from '@/lib/data'
import type { WizardFooterState, WizardHost } from '../contract'
import { EMAIL_NAME_CHECK_DELAY_MS, EmailWizardBody } from './Body'

const mocks = vi.hoisted(() => ({
  check: vi.fn<(orgId: string, name: string | undefined, mockMode: boolean) => Promise<EmailAddressCheckDto>>()
}))

vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ activeOrg: { id: 'org-a' } }) }))
vi.mock('./api', () => ({ emailApi: { check: mocks.check, offered: vi.fn() } }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({ members: [{ userId: 'member-2', name: 'Ada', email: 'ada@example.test' }] })
}))

const agent = { id: 'agent-a', name: 'helper' } as unknown as Agent
const DOMAIN = 'mail.example.test'

let host: HTMLDivElement
let root: Root
let footer: WizardFooterState | null

/** The route's answer for one name, as the Control Plane words it. */
function answer(name: string | undefined): EmailAddressCheckDto {
  if (name === undefined) return { mailDomain: DOMAIN, address: null, available: false, reason: null }
  if (name.length < 3) return { mailDomain: DOMAIN, address: null, available: false, reason: 'length' }
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(name))
    return { mailDomain: DOMAIN, address: null, available: false, reason: 'characters' }
  if (name === 'postmaster') return { mailDomain: DOMAIN, address: null, available: false, reason: 'reserved' }
  const address = `${name}@${DOMAIN}`
  return name === 'taken'
    ? { mailDomain: DOMAIN, address, available: false, reason: 'taken' }
    : { mailDomain: DOMAIN, address, available: true, reason: null }
}

function wizardHost(over: Partial<WizardHost> = {}): WizardHost {
  return {
    createIntegration: vi.fn(async () => undefined),
    relayCapability: { available: true, publicUrl: null },
    mode: 'create',
    selectedBot: null,
    transport: 'http',
    setTransport: vi.fn(),
    shared: false,
    mockMode: false,
    setFooter: (state) => {
      footer = state
    },
    setIdentityChrome: vi.fn(),
    setRegionLocked: vi.fn(),
    setError: vi.fn(),
    close: vi.fn(),
    invalidate: vi.fn(),
    ...over
  }
}

async function render(over: Partial<WizardHost> = {}): Promise<WizardHost> {
  const state = wizardHost(over)
  await act(async () =>
    root.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <EmailWizardBody agent={agent} host={state} />
      </SWRConfig>
    )
  )
  return state
}

function input(): HTMLInputElement {
  return host.querySelector('input')!
}

/** Types `value` and waits out the check's pause. */
async function type(value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => new Promise((resolve) => setTimeout(resolve, EMAIL_NAME_CHECK_DELAY_MS + 50)))
}

/** The pane's own commit button by its label. */
function primary(label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === label)
}

function status(): string {
  return host.querySelector('[role="status"]')?.textContent ?? ''
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  footer = null
  mocks.check.mockReset()
  mocks.check.mockImplementation(async (_orgId, name) => answer(name))
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('EmailWizardBody', () => {
  it('asks for the name alone, beside the mail domain, with the identity chooser hidden', async () => {
    const state = await render()
    expect(host.querySelectorAll('input')).toHaveLength(1)
    expect(host.textContent).toContain(`@${DOMAIN}`)
    expect(mocks.check).toHaveBeenCalledWith('org-a', undefined, false)
    expect(state.setIdentityChrome).toHaveBeenCalledWith({ hidden: true })
    expect(footer?.hidden).toBe(true)
    expect(primary('Create')?.disabled).toBe(true)
  })

  it.each([
    ['ab', 'Address names must be 3 to 40 characters long.'],
    ['-help', 'Use lowercase letters, numbers, dots, and hyphens, starting and ending with a letter or number.'],
    ['postmaster', 'This name is reserved. Choose another one.'],
    [
      'taken',
      'This address is already taken or was previously used. Addresses can’t be reused, so choose another name.'
    ]
  ])('refuses %s with the reason the check gives', async (name, message) => {
    await render()
    await type(name)
    expect(status()).toBe(message)
    expect(input().getAttribute('aria-invalid')).toBe('true')
    expect(primary('Create')?.disabled).toBe(true)
  })

  it('checks the lower-cased name once typing pauses, not on every keystroke', async () => {
    await render()
    await act(async () => {
      for (const value of ['H', 'He', 'Hel', 'Help']) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input(), value)
        input().dispatchEvent(new Event('input', { bubbles: true }))
      }
    })
    expect(status()).toBe('Checking…')
    await type('Help')
    expect(mocks.check.mock.calls.map(([, name]) => name)).toEqual([undefined, 'help'])
    expect(status()).toBe(`help@${DOMAIN} is available.`)
    expect(primary('Create')?.disabled).toBe(false)
  })

  it('creates the address over http, then shows it with a copy button and closes on Done', async () => {
    const state = await render()
    await type(' help ')
    await act(async () => primary('Create')?.click())
    expect(state.createIntegration).toHaveBeenCalledWith({
      platform: 'email',
      agentId: 'agent-a',
      transport: 'http',
      email: { name: 'help' }
    })
    expect(state.close).not.toHaveBeenCalled()
    expect(host.querySelector('input')).toBeNull()
    expect(host.textContent).toContain(`help@${DOMAIN}`)
    expect(host.querySelector('button[aria-label="Copy address"]')).not.toBeNull()
    await act(async () => primary('Done')?.click())
    expect(state.close).toHaveBeenCalled()
  })

  it('offers who may write before the create, and sends Anyone with who sees outside mail', async () => {
    const state = await render()
    const radio = (label: string) =>
      [...host.querySelectorAll('[role="radio"]')].find((el) => el.textContent?.startsWith(label)) as HTMLElement
    expect(radio('Members of your organization').getAttribute('aria-checked')).toBe('true')
    expect(host.textContent).not.toContain('Who sees mail from outside the organization')
    await type('help')
    await act(async () => radio('Anyone').click())
    await act(async () => radio('Everyone in the organization').click())
    await act(async () => primary('Create')?.click())
    expect(state.createIntegration).toHaveBeenCalledWith({
      platform: 'email',
      agentId: 'agent-a',
      transport: 'http',
      email: { name: 'help', whoMayWrite: 'anyone', outsideSessions: { kind: 'org' } }
    })
    expect(status()).toBe('Emails sent to this address from anyone will reach this agent.')
  })

  it('holds the create while a specific member is still to be picked', async () => {
    await render()
    const radio = (label: string) =>
      [...host.querySelectorAll('[role="radio"]')].find((el) => el.textContent?.startsWith(label)) as HTMLElement
    await type('help')
    await act(async () => radio('Anyone').click())
    await act(async () => radio('A specific member').click())
    expect(primary('Create')?.disabled).toBe(true)
  })

  it('words a create refusal by its code and keeps the name to change', async () => {
    const state = await render({
      createIntegration: vi.fn(async () => {
        throw new ApiError('raced', 409, 'EMAIL_ADDRESS_TAKEN')
      })
    })
    await type('help')
    await act(async () => primary('Create')?.click())
    expect(state.setError).toHaveBeenLastCalledWith(
      'This address is already taken or was previously used. Addresses can’t be reused, so choose another name.'
    )
    expect(input().value).toBe('help')
    expect(primary('Create')?.disabled).toBe(false)
  })

  it('says so when the name cannot be checked', async () => {
    mocks.check.mockImplementation(async (_orgId, name) => {
      if (name === undefined) return answer(name)
      throw new ApiError('down', 503)
    })
    await render()
    await type('help')
    expect(status()).toBe('Couldn’t check this name. Try again in a moment.')
    expect(primary('Create')?.disabled).toBe(true)
  })
})
