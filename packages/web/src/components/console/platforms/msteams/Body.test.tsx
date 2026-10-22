// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IntegrationDto, SlackConfigDto } from '@/lib/api'
import type { Agent } from '@/lib/data'
import type { WizardFooterState, WizardHost, WizardIdentityChromeState } from '../contract'

const mocks = vi.hoisted(() => ({
  probeConfig: null as SlackConfigDto | null,
  create: vi.fn(),
  appPackage: vi.fn(),
  saveBlob: vi.fn()
}))

vi.mock('../deployment-config', () => ({
  useDeploymentConfig: () => ({ config: mocks.probeConfig, failed: false, apply: vi.fn() })
}))
vi.mock('./api', () => ({ msTeamsApi: { create: mocks.create, appPackage: mocks.appPackage } }))
vi.mock('@/lib/shared-file', () => ({ saveBlob: mocks.saveBlob }))

import { ApiError } from '@/lib/api'
import { MsTeamsWizardBody, msTeamsPane } from './Body'

const agent = { id: 'agent-a', name: 'deploy-bot', status: 'online' } as unknown as Agent
const APP_ID = '00000000-0000-0000-0000-00000000000A'
const TENANT_ID = '00000000-0000-0000-0000-00000000000b'
const CREATED: IntegrationDto = {
  id: 'int-1',
  name: 'Microsoft Teams · 00000000-0000-0000-0000-00000000000a',
  platform: 'msteams',
  agentId: 'agent-a',
  botId: 'bot-1',
  status: 'active',
  createdAt: '2026-10-22T00:00:00.000Z',
  channels: []
}

let host: HTMLDivElement
let root: Root
let footer: WizardFooterState | null
let identity: WizardIdentityChromeState | null

function wizardHost(over: Partial<WizardHost> = {}): WizardHost {
  return {
    createIntegration: vi.fn(async () => undefined),
    relayCapability: { available: true, publicUrl: 'https://relay.example.test/' },
    mode: 'create',
    selectedBot: null,
    transport: 'http',
    setTransport: vi.fn(),
    shared: false,
    mockMode: false,
    setFooter: (state) => {
      footer = state
    },
    setIdentityChrome: (state) => {
      identity = state
    },
    setRegionLocked: vi.fn(),
    setError: vi.fn(),
    close: vi.fn(),
    invalidate: vi.fn(),
    ...over
  }
}

const text = () => host.textContent ?? ''
const buttonWith = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label))

function field(label: string): HTMLInputElement {
  const fld = [...host.querySelectorAll('.fld')].find((el) => el.querySelector('.fldlbl')?.textContent === label)
  return fld!.querySelector('input')!
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function render(over: Partial<WizardHost> = {}): Promise<WizardHost> {
  const state = wizardHost(over)
  await act(async () => root.render(<MsTeamsWizardBody agent={agent} host={state} />))
  return state
}

async function fillAndConnect(): Promise<void> {
  await type(field('App (bot) ID'), ` ${APP_ID} `)
  await type(field('Directory (tenant) ID'), TENANT_ID)
  await type(field('Client secret'), ' s3cret ')
  await act(async () => footer?.onSubmit())
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  footer = null
  identity = null
  mocks.probeConfig = { relayAvailable: true } as SlackConfigDto
  mocks.create.mockReset()
  mocks.appPackage.mockReset()
  mocks.saveBlob.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('msTeamsPane', () => {
  it('waits for the relay read, needs a relay, then registers, and installs once created', () => {
    expect(msTeamsPane({ relayAvailable: null, created: false })).toBe('checking')
    expect(msTeamsPane({ relayAvailable: false, created: false })).toBe('relay_required')
    expect(msTeamsPane({ relayAvailable: true, created: false })).toBe('register')
    expect(msTeamsPane({ relayAvailable: null, created: true })).toBe('install')
  })
})

describe('MsTeamsWizardBody', () => {
  it('shows nothing to fill in while the deployment is being read', async () => {
    mocks.probeConfig = null
    await render()
    expect(text()).toContain('Checking this deployment')
    expect(identity?.hidden).toBe(true)
    expect(footer?.hidden).toBe(true)
  })

  it('says a relay is required when this deployment has none', async () => {
    await render({ relayCapability: { available: false, publicUrl: null } })
    expect(text()).toContain('public callback endpoint')
    expect(host.querySelector('input')).toBeNull()
    expect(footer?.hidden).toBe(true)
  })

  it('links the Developer Portal, shows the messaging endpoint, and asks for the three credentials', async () => {
    await render()
    expect(host.querySelector('a[href="https://dev.teams.microsoft.com/tools/bots"]')?.textContent).toContain(
      'Open Teams Developer Portal'
    )
    expect(text()).toContain('https://relay.example.test/msteams/messages')
    expect(text()).toContain('Azure Bot resource')
    expect([...host.querySelectorAll('.fldlbl')].map((el) => el.textContent)).toEqual([
      'Messaging endpoint',
      'App (bot) ID',
      'Directory (tenant) ID',
      'Client secret'
    ])
    expect(field('Client secret').type).toBe('password')
    expect(identity?.hidden).toBe(false)
    expect(footer).toMatchObject({ label: 'Connect', enabled: false, hidden: false })
  })

  it('marks an ID that is not a GUID and keeps Connect off until both are', async () => {
    await render()
    await type(field('App (bot) ID'), 'not-a-guid')
    await type(field('Directory (tenant) ID'), TENANT_ID)
    await type(field('Client secret'), 's3cret')
    expect(field('App (bot) ID').className).toContain('border-(--status-error)')
    expect(field('Directory (tenant) ID').className).not.toContain('border-(--status-error)')
    expect(footer?.enabled).toBe(false)
    await type(field('App (bot) ID'), APP_ID)
    expect(footer?.enabled).toBe(true)
  })

  it('connects over http with the trimmed credentials, then offers the app package', async () => {
    mocks.create.mockResolvedValue(CREATED)
    const blob = new Blob(['zip'])
    mocks.appPackage.mockResolvedValue(blob)
    const state = await render()
    await fillAndConnect()
    expect(mocks.create).toHaveBeenCalledWith({
      platform: 'msteams',
      agentId: 'agent-a',
      transport: 'http',
      msteams: { appId: APP_ID, tenantId: TENANT_ID, clientSecret: 's3cret' }
    })
    expect(state.invalidate).toHaveBeenCalled()
    expect(state.close).not.toHaveBeenCalled()
    expect(text()).toContain('Install the app in Teams')
    expect(text()).toContain('Add to team')
    expect(text()).toContain('a few hours')
    expect(host.querySelector('a[href="https://admin.teams.microsoft.com/policies/manage-apps"]')).not.toBeNull()
    expect(identity?.hidden).toBe(true)
    expect(footer?.hidden).toBe(true)

    await act(async () => buttonWith('Download app package')?.click())
    expect(mocks.appPackage).toHaveBeenCalledWith('int-1')
    expect(mocks.saveBlob).toHaveBeenCalledWith(blob, 'agentconnect-teams.zip')

    await act(async () => buttonWith('Done')?.click())
    expect(state.close).toHaveBeenCalled()
  })

  it('says why the package cannot be built', async () => {
    mocks.create.mockResolvedValue(CREATED)
    mocks.appPackage.mockRejectedValue(new ApiError('no relay', 409, 'MSTEAMS_RELAY_ORIGIN_MISSING'))
    await render()
    await fillAndConnect()
    await act(async () => buttonWith('Download app package')?.click())
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'This deployment has no public callback endpoint, so the app package cannot be built.'
    )
    expect(mocks.saveBlob).not.toHaveBeenCalled()
  })

  it('shows the localized reason for a refused check and clears the secret', async () => {
    mocks.create.mockRejectedValue(new ApiError('Entra said no', 400, 'MSTEAMS_SECRET_INVALID'))
    const state = await render()
    await fillAndConnect()
    expect(state.setError).toHaveBeenLastCalledWith(
      'Microsoft Entra rejected this client secret, or it has expired. Create a new one and paste its value, not its ID.'
    )
    expect(field('Client secret').value).toBe('')
    expect(field('App (bot) ID').value).toBe(` ${APP_ID} `)
    expect(text()).not.toContain('Install the app in Teams')
  })

  it('names a bot that is already connected', async () => {
    mocks.create.mockRejectedValue(new ApiError('taken', 409))
    const state = await render()
    await fillAndConnect()
    expect(state.setError).toHaveBeenLastCalledWith(
      'This bot is already connected to an agent. Register another bot for this agent.'
    )
  })

  it('renders nothing when reusing an existing bot', async () => {
    await render({ mode: 'existing' })
    expect(text()).toBe('')
  })
})
