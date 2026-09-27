// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotDto, IntegrationDto, SlackConfigDto } from '@/lib/api'
import type { Agent, IntegrationRow } from '@/lib/data'
import type { WizardFooterState, WizardHost, WizardIdentityChromeState } from '../contract'

const mocks = vi.hoisted(() => ({
  probeConfig: null as SlackConfigDto | null,
  deploymentAvailable: null as boolean | null,
  bots: [] as BotDto[],
  integrations: [] as IntegrationRow[],
  create: vi.fn(),
  installPlatformApp: vi.fn()
}))

vi.mock('../deployment-config', () => ({
  useDeploymentConfig: () => ({ config: mocks.probeConfig, failed: false, apply: vi.fn() })
}))
vi.mock('./availability', () => ({ useGoogleChatPlatformInstall: () => mocks.deploymentAvailable }))
vi.mock('./api', () => ({
  googleChatApi: { create: mocks.create, installPlatformApp: mocks.installPlatformApp }
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    bots: mocks.bots,
    integrations: mocks.integrations,
    getAgent: () => undefined
  })
}))

import { ApiError } from '@/lib/api'
import { GoogleChatWizardBody, googleChatPane } from './Body'

const agent = { id: 'agent-a', name: 'deploy-bot', status: 'online' } as unknown as Agent
const KEY = JSON.stringify({
  type: 'service_account',
  project_id: 'example-project',
  client_email: 'chat-app@example-project.iam.gserviceaccount.com',
  private_key: 'synthetic'
})
const CREATED: IntegrationDto = {
  id: 'int-1',
  name: 'Google Chat · example-project',
  platform: 'googlechat',
  agentId: 'agent-a',
  botId: 'bot-1',
  status: 'active',
  createdAt: '2026-09-27T00:00:00.000Z',
  channels: []
}

let host: HTMLDivElement
let root: Root
let footer: WizardFooterState | null
let identity: WizardIdentityChromeState | null

function wizardHost(over: Partial<WizardHost> = {}): WizardHost {
  return {
    createIntegration: vi.fn(async () => undefined),
    relayCapability: { available: true, publicUrl: 'https://relay.example.test' },
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

const answered = { relayAvailable: true } as SlackConfigDto
const text = () => host.textContent ?? ''
const buttonWith = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label))

function field(label: string): HTMLInputElement {
  const fld = [...host.querySelectorAll('.fld')].find((el) =>
    el.querySelector('.fldlbl')?.textContent?.startsWith(label)
  )
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
  await act(async () => root.render(<GoogleChatWizardBody agent={agent} host={state} />))
  return state
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  footer = null
  identity = null
  mocks.probeConfig = answered
  mocks.deploymentAvailable = false
  mocks.bots = []
  mocks.integrations = []
  mocks.create.mockReset()
  mocks.installPlatformApp.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('googleChatPane', () => {
  const facts = {
    relayAvailable: true as boolean | null,
    deploymentAvailable: true as boolean | null,
    deploymentOffered: true,
    source: 'deployment' as const,
    created: false
  }

  it('waits for both reads, then needs a relay, then leads with the deployment app', () => {
    expect(googleChatPane({ ...facts, relayAvailable: null })).toBe('checking')
    expect(googleChatPane({ ...facts, deploymentAvailable: null })).toBe('checking')
    expect(googleChatPane({ ...facts, relayAvailable: false })).toBe('relay_required')
    expect(googleChatPane(facts)).toBe('deployment')
    expect(googleChatPane({ ...facts, source: 'own' })).toBe('own')
    expect(googleChatPane({ ...facts, deploymentOffered: false })).toBe('own')
    expect(googleChatPane({ ...facts, relayAvailable: null, created: true })).toBe('test')
  })
})

describe('GoogleChatWizardBody', () => {
  it('shows nothing to fill in while the deployment is being read', async () => {
    mocks.deploymentAvailable = null
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

  it('lays out the prerequisites, the values to copy, and the credential form for an own app', async () => {
    await render()
    expect(identity?.hidden).toBe(false)
    expect(identity?.headerAction).toBeUndefined()
    expect(text()).toContain('Browser role')
    expect(text()).toContain('Cloud Resource Manager API')
    expect(text()).toContain('https://relay.example.test/googlechat/events')
    expect(text()).toContain('Project Number')
    expect(text()).toContain('Receive 1:1 messages')
    expect(text()).toContain('Join spaces and group conversations')
    expect(field('Service account key').type).toBe('password')
    expect(footer).toMatchObject({ label: 'Connect', enabled: false, hidden: false })
  })

  it('connects with the googlechat block, then clears the key and shows the test step', async () => {
    mocks.create.mockResolvedValue(CREATED)
    const state = await render()
    await type(field('Service account key'), KEY)
    // The key names its project, so the project ID fills itself in.
    expect(field('Project ID').value).toBe('example-project')
    expect(footer?.enabled).toBe(true)

    await act(async () => footer?.onSubmit())
    expect(mocks.create).toHaveBeenCalledWith({
      platform: 'googlechat',
      agentId: 'agent-a',
      transport: 'http',
      googlechat: { projectId: 'example-project', serviceAccountKey: KEY }
    })
    expect(state.invalidate).toHaveBeenCalled()
    expect(host.querySelector('input[type="password"]')).toBeNull()
    expect(text()).toContain('Test it in Google Chat')
    expect([...host.querySelectorAll('li[data-done="true"]')].map((li) => li.textContent)).toEqual([
      'SavedGoogle accepted the key.',
      'ConnectedThe callback endpoint is live and the agent is online.'
    ])
    expect(text()).toContain('send it a direct message or mention it in a space')
    expect(text()).toContain('no one can open them in this console')
    expect(identity?.hidden).toBe(true)
    expect(footer?.hidden).toBe(true)
    await act(async () => buttonWith('Done')?.click())
    expect(state.close).toHaveBeenCalled()
  })

  it('marks the app tested only once a conversation reached it', async () => {
    mocks.create.mockResolvedValue(CREATED)
    mocks.integrations = [
      {
        id: 'int-1',
        revoked: false,
        rejected: false,
        channels: [{ channelId: 'spaces/AAA' }]
      } as unknown as IntegrationRow
    ]
    await render()
    await type(field('Service account key'), KEY)
    await act(async () => footer?.onSubmit())
    expect(host.querySelectorAll('li[data-done="true"]')).toHaveLength(3)
  })

  it('sends the entered number and maps a refusal to its fix, clearing the key either way', async () => {
    mocks.create.mockRejectedValue(new ApiError('raw', 400, 'GOOGLE_CHAT_CRM_FORBIDDEN'))
    const state = await render()
    await type(field('Project number'), 'abc')
    expect(field('Project number').className).toContain('border-(--status-error)')
    await type(field('Project number'), '123456789012')
    await type(field('Service account key'), KEY)
    await act(async () => footer?.onSubmit())

    expect(mocks.create.mock.calls[0]![0].googlechat.projectNumber).toBe('123456789012')
    expect(state.setError).toHaveBeenLastCalledWith(
      'Grant the service account the Browser role on the Chat app’s project, then connect again.'
    )
    expect(field('Service account key').value).toBe('')
    expect(text()).not.toContain('Test it in Google Chat')
  })

  it('offers the deployment app first and installs it for this agent', async () => {
    mocks.deploymentAvailable = true
    mocks.installPlatformApp.mockResolvedValue(CREATED)
    const state = await render()
    expect(identity?.hidden).toBe(true)
    expect(footer?.hidden).toBe(true)
    expect(host.querySelector('input')).toBeNull()

    await act(async () => buttonWith('Use the deployment app')?.click())
    expect(mocks.installPlatformApp).toHaveBeenCalledWith({ agentId: 'agent-a' })
    expect(state.invalidate).toHaveBeenCalled()
    expect(text()).toContain('Test it in Google Chat')
  })

  it('switches to an own app and back through the host header', async () => {
    mocks.deploymentAvailable = true
    await render()
    await act(async () => buttonWith('Use your own Chat app')?.click())
    expect(identity?.hidden).toBe(false)
    expect(identity?.headerAction?.label).toBe('Use the deployment app')
    expect(field('Project ID')).toBeDefined()

    await act(async () => identity?.headerAction?.onSelect())
    expect(identity?.hidden).toBe(true)
    expect(buttonWith('Use the deployment app')).toBeDefined()
  })

  it('does not offer the deployment app another agent already holds', async () => {
    mocks.deploymentAvailable = true
    mocks.bots = [{ platform: 'googlechat', prebuilt: true, agentIds: ['agent-b'] } as BotDto]
    await render()
    expect(buttonWith('Use the deployment app')).toBeUndefined()
    expect(identity?.headerAction).toBeUndefined()
    expect(field('Project ID')).toBeDefined()
  })

  it('maps a deployment install refusal under its button', async () => {
    mocks.deploymentAvailable = true
    mocks.installPlatformApp.mockRejectedValue(new ApiError('raw', 400, 'GOOGLE_CHAT_CRM_DISABLED'))
    await render()
    await act(async () => buttonWith('Use the deployment app')?.click())
    expect(text()).toContain('Enable the Cloud Resource Manager API in the Chat app’s project')
  })

  it('renders nothing of its own when reusing a freed app', async () => {
    await render({ mode: 'existing' })
    expect(text()).toBe('')
  })
})
