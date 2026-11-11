// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import type { Agent } from '@/lib/data'
import type { WizardFooterState, WizardHost } from '../contract'
import { channelListSemantics, platformRegistry } from '../registry'
import { WeComWizardBody, WECOM_ADMIN_CONSOLE_URL } from './Body'

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
  await act(async () => root.render(<WeComWizardBody agent={agent} host={state} />))
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

/** Fills both credentials and submits a create whose answer is `refusal`. */
async function submitRefused(refusal: unknown): Promise<WizardHost> {
  const state = await render({ createIntegration: vi.fn(async () => Promise.reject(refusal)) })
  await type(field('BotID'), 'aibot-example')
  await type(field('Secret'), 'secret-placeholder')
  await act(async () => footer?.onSubmit())
  return state
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

describe('WeComWizardBody', () => {
  it('links the admin console, states the long-connection step, and asks for both credentials', async () => {
    await render()
    const portal = host.querySelector<HTMLAnchorElement>(`a[href="${WECOM_ADMIN_CONSOLE_URL}"]`)
    expect(portal?.textContent).toContain('Open WeCom admin console')
    expect(host.textContent).toContain('set its API mode to long connection')
    // No walkthrough of WeCom's admin screens: its menus are not verified.
    expect(host.querySelector('[role="group"], [aria-expanded]')).toBeNull()
    expect([...host.querySelectorAll('.fldlbl')].map((el) => el.textContent)).toEqual(['BotID', 'Secret'])
    expect(field('Secret').type).toBe('password')
    expect(footer?.enabled).toBe(false)
  })

  it('connects with the trimmed credentials once the BotID is well formed', async () => {
    const state = await render()
    await type(field('BotID'), 'aibot example')
    await type(field('Secret'), ' secret-placeholder ')
    expect(field('BotID').className).toContain('border-(--status-error)')
    expect(footer?.enabled).toBe(false)

    await type(field('BotID'), ' aibot-example ')
    expect(field('BotID').className).not.toContain('border-(--status-error)')
    expect(footer?.enabled).toBe(true)
    await act(async () => footer?.onSubmit())
    expect(state.createIntegration).toHaveBeenCalledWith({
      platform: 'wecom',
      agentId: 'agent-a',
      wecom: { botId: 'aibot-example', secret: 'secret-placeholder' }
    })
    expect(state.close).toHaveBeenCalled()
  })

  it.each([
    [
      'WECOM_CREDENTIALS_INVALID',
      400,
      'WeCom rejected this BotID or Secret. Copy both again from the smart bot in WeCom, then connect again.'
    ],
    [
      'WECOM_LONG_CONNECTION_DISABLED',
      400,
      'This smart bot does not use long connection. Set its API mode to long connection in WeCom, then connect again.'
    ],
    [
      'WECOM_CHECK_UNAVAILABLE',
      503,
      'AgentConnect could not reach WeCom to check this bot, so nothing was saved. Try again in a moment.'
    ]
  ])('explains %s in the console’s own words', async (code, status, expected) => {
    const state = await submitRefused(new ApiError('Control Plane wording', status, code))
    expect(state.setError).toHaveBeenLastCalledWith(expected)
    expect(state.close).not.toHaveBeenCalled()
    expect(footer?.enabled).toBe(true)
  })

  it('points an already installed BotID at reusing the existing bot', async () => {
    const coded = await submitRefused(new ApiError('Control Plane wording', 409, 'WECOM_BOT_ALREADY_INSTALLED'))
    expect(coded.setError).toHaveBeenLastCalledWith(expect.stringContaining('Reuse it instead of adding it again'))
    expect(coded.setError).toHaveBeenLastCalledWith(expect.stringContaining('“An unused WeCom bot”'))
  })

  it('reads the duplicate fence of a racing install the same way, by its message', async () => {
    const refusal = new ApiError('This WeCom bot is already installed. Reuse the existing bot.', 409)
    const state = await submitRefused(refusal)
    expect(state.setError).toHaveBeenLastCalledWith(expect.stringContaining('Reuse it instead of adding it again'))
  })

  it('shows any other refusal as the Control Plane words it, a different 409 included', async () => {
    const message = 'agent move is in progress; retry the integration change'
    const state = await submitRefused(new ApiError(message, 409))
    expect(state.setError).toHaveBeenLastCalledWith(message)
  })

  it('renders nothing when reusing an existing bot', async () => {
    await render({ mode: 'existing' })
    expect(host.textContent).toBe('')
  })
})

describe('the WeCom module', () => {
  it('offers group rows only off and mention, with a mention sentence that promises no threads', () => {
    const semantics = channelListSemantics('wecom')
    expect(semantics.roomNoun).toBe('group')
    expect(semantics.leave).toBe('none')
    expect(semantics.triggers).toEqual(['off', 'mention'])
    expect(semantics.mentionHint).toEqual({ key: 'wecomMentionHint' })
    expect(semantics.sessionModes).toBeUndefined()
    expect(semantics.dmSessionModes).toBeUndefined()
  })

  it('sits behind the wecom flag, links its guide, and reuses any freed bot without a transport', () => {
    const module = platformRegistry.get('wecom')!
    expect(module.requires).toBe('wecom')
    expect(module.docsPath).toBe('connect-automate/chat-platforms/wecom')
    expect(module.wizard.freeBotFilter({ platform: 'wecom' } as never, { agentId: 'agent-a', shared: false })).toBe(
      true
    )
    expect(module.wizard.buildReuseInput({ id: 'bot-1' } as never, { agentId: 'agent-a', shared: false })).toEqual({
      platform: 'wecom',
      agentId: 'agent-a',
      botId: 'bot-1'
    })
  })
})
