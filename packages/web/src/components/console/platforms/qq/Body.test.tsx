// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@/lib/data'
import type { WizardFooterState, WizardHost } from '../contract'
import { QQWizardBody } from './Body'

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
  await act(async () => root.render(<QQWizardBody agent={agent} host={state} />))
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

describe('QQWizardBody', () => {
  it('lays out the two-step credential pane with the portal button and the IP allowlist warning', async () => {
    await render()
    const portal = host.querySelector<HTMLAnchorElement>('a[href="https://q.qq.com/"]')
    expect(portal?.textContent).toContain('Create QQ bot')
    expect(host.textContent).toContain('IP allowlist')
    expect([...host.querySelectorAll('.fldlbl')].map((el) => el.textContent)).toEqual(['AppID', 'AppSecret'])
    expect(field('AppSecret').type).toBe('password')
    expect(footer?.enabled).toBe(false)
  })

  it('connects with the trimmed credentials once the AppID is numeric and a secret is present', async () => {
    const state = await render()
    await type(field('AppID'), 'bot-1')
    await type(field('AppSecret'), ' s3cret ')
    expect(field('AppID').className).toContain('border-(--status-error)')
    expect(footer?.enabled).toBe(false)

    await type(field('AppID'), ' 123456789 ')
    expect(field('AppID').className).not.toContain('border-(--status-error)')
    expect(footer?.enabled).toBe(true)
    await act(async () => footer?.onSubmit())
    expect(state.createIntegration).toHaveBeenCalledWith({
      platform: 'qq',
      agentId: 'agent-a',
      qq: { appId: '123456789', appSecret: 's3cret' }
    })
  })

  it('renders nothing when reusing an existing bot', async () => {
    await render({ mode: 'existing' })
    expect(host.textContent).toBe('')
  })
})
