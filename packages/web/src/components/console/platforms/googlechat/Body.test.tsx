// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IntegrationDto, SlackConfigDto } from '@/lib/api'
import type { Agent, IntegrationRow } from '@/lib/data'
import type { WizardFooterState, WizardHost, WizardIdentityChromeState } from '../contract'

const mocks = vi.hoisted(() => ({
  probeConfig: null as SlackConfigDto | null,
  integrations: [] as IntegrationRow[],
  create: vi.fn()
}))

vi.mock('../deployment-config', () => ({
  useDeploymentConfig: () => ({ config: mocks.probeConfig, failed: false, apply: vi.fn() })
}))
vi.mock('./api', () => ({ googleChatApi: { create: mocks.create } }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({ integrations: mocks.integrations, getAgent: () => undefined })
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
  mocks.integrations = []
  mocks.create.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('googleChatPane', () => {
  it('waits for the relay read, then needs a relay, then shows the own-app steps', () => {
    expect(googleChatPane({ relayAvailable: null, created: false })).toBe('checking')
    expect(googleChatPane({ relayAvailable: false, created: false })).toBe('relay_required')
    expect(googleChatPane({ relayAvailable: true, created: false })).toBe('own')
    expect(googleChatPane({ relayAvailable: null, created: true })).toBe('test')
  })
})

describe('GoogleChatWizardBody', () => {
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

  it('lays out the prerequisites, the values to copy, and the credential form for an own app, and nothing else', async () => {
    await render()
    expect(identity?.hidden).toBe(false)
    expect(identity?.headerAction).toBeUndefined()
    expect(text()).not.toContain('deployment app')
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
    expect(text()).toContain('Send it a direct message or mention it in a space')
    expect(text()).toContain('after signing in to this console with the same Google account')
    expect(identity?.hidden).toBe(true)
    expect(footer?.hidden).toBe(true)
    await act(async () => buttonWith('Done')?.click())
    expect(state.close).toHaveBeenCalled()
  })

  it('marks the app added once a conversation row exists, and still tells the user to message it', async () => {
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
    expect(text()).toContain('The app is in a space or a direct conversation.')
    expect(text()).toContain('Send it a direct message or mention it in a space')
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

  it('points a key of the deployment’s own app at Google Chat', async () => {
    mocks.create.mockRejectedValue(new ApiError('raw', 409, 'GOOGLE_CHAT_DEPLOYMENT_APP'))
    const state = await render()
    await type(field('Service account key'), KEY)
    await act(async () => footer?.onSubmit())

    expect(state.setError).toHaveBeenLastCalledWith(
      'This Chat app belongs to this deployment; connect it by sending the app a message in Google Chat.'
    )
    expect(field('Service account key').value).toBe('')
  })

  it('renders nothing of its own when reusing a freed app', async () => {
    await render({ mode: 'existing' })
    expect(text()).toBe('')
  })
})
