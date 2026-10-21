// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@/lib/data'
import type { WizardFooterState, WizardHost } from '../contract'
import { channelListSemantics, platformRegistry } from '../registry'
import { DingTalkWizardBody } from './Body'

const agent = { id: 'agent-a', name: 'deploy-bot' } as unknown as Agent

let host: HTMLDivElement
let root: Root
let footer: WizardFooterState | null

function wizardHost(over: Partial<WizardHost> = {}): WizardHost {
  return {
    createIntegration: vi.fn(async () => undefined),
    relayCapability: { available: false, publicUrl: null },
    mode: 'create',
    selectedBot: null,
    transport: 'socket',
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
  await act(async () => root.render(<DingTalkWizardBody agent={agent} host={state} />))
  return state
}

/** The input under the field label that reads `label`. */
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

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  footer = null
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('DingTalkWizardBody', () => {
  it('links the developer console, states the edition limit, and asks for both credentials', async () => {
    await render()
    const portal = host.querySelector<HTMLAnchorElement>('a[href="https://open-dev.dingtalk.com/fe/app"]')
    expect(portal?.textContent).toContain('Create DingTalk app')
    expect(host.textContent).toContain('5,000 API calls')
    expect([...host.querySelectorAll('.fldlbl')].map((el) => el.textContent)).toEqual(['Client ID', 'Client Secret'])
    expect(field('Client Secret').type).toBe('password')
    expect(footer?.enabled).toBe(false)
  })

  it('connects with the trimmed credentials once the Client ID is well formed', async () => {
    const state = await render()
    await type(field('Client ID'), 'ding app')
    await type(field('Client Secret'), ' s3cret ')
    expect(field('Client ID').className).toContain('border-(--status-error)')
    expect(footer?.enabled).toBe(false)

    await type(field('Client ID'), ' dingexample0001 ')
    expect(field('Client ID').className).not.toContain('border-(--status-error)')
    expect(footer?.enabled).toBe(true)
    await act(async () => footer?.onSubmit())
    expect(state.createIntegration).toHaveBeenCalledWith({
      platform: 'dingtalk',
      agentId: 'agent-a',
      dingtalk: { clientId: 'dingexample0001', clientSecret: 's3cret' }
    })
    expect(state.close).toHaveBeenCalled()
  })

  it('shows the Control Plane’s message when the check fails', async () => {
    const message = 'DingTalk rejected the Client ID or Client Secret.'
    const state = await render({ createIntegration: vi.fn(async () => Promise.reject(new Error(message))) })
    await type(field('Client ID'), 'dingexample0001')
    await type(field('Client Secret'), 'wrong')
    await act(async () => footer?.onSubmit())
    expect(state.setError).toHaveBeenLastCalledWith(message)
    expect(state.close).not.toHaveBeenCalled()
    expect(footer?.enabled).toBe(true)
  })

  it('renders nothing when reusing an existing bot', async () => {
    await render({ mode: 'existing' })
    expect(host.textContent).toBe('')
  })
})

describe('the DingTalk module', () => {
  it('offers group rows only off and mention, with its own mention sentence', () => {
    const semantics = channelListSemantics('dingtalk')
    expect(semantics.triggers).toEqual(['off', 'mention'])
    expect(semantics.mentionHint).toEqual({ key: 'dingtalkMentionHint' })
    expect(semantics.sessionModes).toBeUndefined()
    expect(semantics.dmSessionModes).toBeUndefined()
  })

  it('is offered without a feature flag and reuses a bot without a transport', () => {
    const module = platformRegistry.get('dingtalk')!
    expect(module.requires).toBeUndefined()
    expect(module.wizard.buildReuseInput({ id: 'bot-1' } as never, { agentId: 'agent-a', shared: false })).toEqual({
      platform: 'dingtalk',
      agentId: 'agent-a',
      botId: 'bot-1'
    })
  })
})
