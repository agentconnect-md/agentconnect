// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
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
  it('follows the international edition the tile picked and asks for both credentials', async () => {
    await render({ region: 'international' })
    const portal = host.querySelector<HTMLAnchorElement>('a[href="https://open-dev.dingtalk.io/fe/app"]')
    expect(portal?.textContent).toContain('Create DingTalk app')
    // The international edition has no card permission to enable, and its plans differ from the mainland quota.
    expect(host.textContent).not.toContain('Access')
    expect(host.textContent).not.toContain('5,000 API calls')
    expect([...host.querySelectorAll('.fldlbl')].map((el) => el.textContent)).toEqual(['Client ID', 'Client Secret'])
    expect(field('Client Secret').type).toBe('password')
    expect(footer?.enabled).toBe(false)
  })

  it('follows the mainland edition, with its card permission step and quota', async () => {
    await render({ region: 'mainland' })
    expect(host.querySelector('a[href="https://open-dev.dingtalk.com/fe/app"]')).not.toBeNull()
    expect(host.textContent).toContain('Access')
    expect(host.textContent).toContain('5,000 API calls')
  })

  it('connects with the trimmed credentials and the picked edition once the Client ID is well formed', async () => {
    const state = await render({ region: 'international' })
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
      dingtalk: { clientId: 'dingexample0001', clientSecret: 's3cret', edition: 'international' }
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

  it('names the edition to switch to when the app belongs to the other one', async () => {
    const refusal = new ApiError('This app belongs to DingTalk international.', 400, 'DINGTALK_APP_IS_INTERNATIONAL')
    const state = await render({ region: 'mainland', createIntegration: vi.fn(async () => Promise.reject(refusal)) })
    await type(field('Client ID'), 'dingexample0001')
    await type(field('Client Secret'), 's3cret')
    await act(async () => footer?.onSubmit())
    expect(state.setError).toHaveBeenLastCalledWith(
      'This app belongs to the other DingTalk edition. Switch the DingTalk tile to Intl and connect again.'
    )
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

  it('starts on the edition of the console language and reuses only bots of the picked edition', () => {
    const regions = platformRegistry.get('dingtalk')!.wizard.regions!
    expect(regions.initial('zh-CN')).toBe('mainland')
    expect(regions.initial('en')).toBe('international')
    const filter = platformRegistry.get('dingtalk')!.wizard.freeBotFilter
    const ctx = (region: string) => ({ agentId: 'agent-a', region, shared: false })
    expect(filter({ platformConfig: null } as never, ctx('mainland'))).toBe(true)
    expect(filter({ platformConfig: null } as never, ctx('international'))).toBe(false)
    expect(filter({ platformConfig: { edition: 'international' } } as never, ctx('international'))).toBe(true)
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
