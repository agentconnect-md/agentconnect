// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WeChatLoginDto } from '@/lib/api'
import type { Agent } from '@/lib/data'
import type { WizardFooterState, WizardHost, WizardIdentityChromeState } from '../contract'

type Poll = {
  id: string
  options: { verifyCode?: string; signal?: AbortSignal }
  resolve(dto: WeChatLoginDto): void
  reject(error: unknown): void
}

const mocks = vi.hoisted(() => ({ startLogin: vi.fn(), getLogin: vi.fn(), polls: [] as Poll[] }))

vi.mock('./api', () => ({ weChatApi: { startLogin: mocks.startLogin, getLogin: mocks.getLogin } }))

import { ApiError } from '@/lib/api'
import { WeChatWizardBody } from './Body'
import { WECHAT_POLL_MIN_INTERVAL_MS } from './login'

const agent = { id: 'agent-a', name: 'deploy-bot' } as unknown as Agent
const QR = 'https://liteapp.weixin.qq.com/q/abc?qrcode=1'

function dto(over: Partial<WeChatLoginDto> = {}): WeChatLoginDto {
  return {
    id: 'login-1',
    status: 'waiting',
    qrUrl: QR,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    failureReason: null,
    integrationId: null,
    botId: null,
    wechatUserTail: null,
    ...over
  }
}

let host: HTMLDivElement
let root: Root
let footer: WizardFooterState | null
let identity: WizardIdentityChromeState | null

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

async function render(over: Partial<WizardHost> = {}): Promise<WizardHost> {
  const state = wizardHost(over)
  await act(async () => root.render(<WeChatWizardBody agent={agent} host={state} />))
  return state
}

const text = () => host.textContent ?? ''
const buttonWith = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label))

async function click(label: string): Promise<void> {
  await act(async () => buttonWith(label)!.click())
}

/** Answer the oldest pending long poll. */
async function answer(next: WeChatLoginDto): Promise<void> {
  const poll = mocks.polls.shift()!
  await act(async () => poll.resolve(next))
}

/** Answer the oldest pending long poll, then let the paced follow-up poll start. */
async function answerAndFollow(next: WeChatLoginDto): Promise<void> {
  await answer(next)
  await act(async () => new Promise((resolve) => setTimeout(resolve, WECHAT_POLL_MIN_INTERVAL_MS + 20)))
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
  identity = null
  mocks.polls.length = 0
  mocks.startLogin.mockReset().mockResolvedValue(dto())
  mocks.getLogin
    .mockReset()
    .mockImplementation(
      (id: string, options: Poll['options']) =>
        new Promise<WeChatLoginDto>((resolve, reject) => mocks.polls.push({ id, options, resolve, reject }))
    )
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('WeChatWizardBody', () => {
  it('states the one-person binding before any code, with no reuse choice and no footer', async () => {
    await render()
    expect(text()).toContain('Whoever scans this code becomes the bot')
    expect(text()).toContain('experimental')
    expect(text()).toContain('deploy-bot')
    expect(identity).toEqual({ hidden: true })
    expect(footer?.hidden).toBe(true)
    expect(host.querySelector('svg[role="img"]')).toBeNull()
    expect(mocks.startLogin).not.toHaveBeenCalled()
  })

  it('shows the code, polls back-to-back through scanned, and finishes on completed', async () => {
    const state = await render()
    await click('Show QR code')
    expect(mocks.startLogin).toHaveBeenCalledWith({ agentId: 'agent-a' })
    expect(host.querySelector('svg[role="img"]')).not.toBeNull()
    expect(host.querySelector<HTMLAnchorElement>(`a[href="${QR}"]`)?.textContent).toContain('Open in WeChat')
    expect(mocks.polls).toHaveLength(1)
    expect(mocks.polls[0]!.id).toBe('login-1')

    // A refreshed code replaces the old one and the next poll follows.
    await answerAndFollow(dto({ qrUrl: `${QR}&r=2` }))
    expect(host.querySelector(`a[href="${QR}&r=2"]`)).not.toBeNull()
    expect(mocks.polls).toHaveLength(1)

    await answerAndFollow(dto({ status: 'scanned' }))
    expect(text()).toContain('confirm on your phone')
    expect(mocks.polls).toHaveLength(1)

    await answer(dto({ status: 'completed', integrationId: 'int-1', botId: 'bot-1', wechatUserTail: 'a1b2c3' }))
    expect(text()).toContain('Connected to WeChat user …a1b2c3')
    expect(text()).toContain('ClawBot')
    expect(state.invalidate).toHaveBeenCalledTimes(1)
    expect(mocks.polls).toHaveLength(0)
    // The host draws no primary while the identity chrome is hidden, so Done sits in the pane itself.
    expect(footer?.hidden).toBe(true)
    await click('Done')
    expect(state.close).toHaveBeenCalledTimes(1)
  })

  it('waits for the verification number and sends it on the next poll', async () => {
    await render()
    await click('Show QR code')
    await answer(dto({ status: 'verify_code', qrUrl: null }))
    expect(mocks.polls).toHaveLength(0)
    const input = host.querySelector<HTMLInputElement>('input[inputmode="numeric"]')!
    expect(buttonWith('Confirm')?.disabled).toBe(true)
    await type(input, ' 4821 ')
    await click('Confirm')
    expect(mocks.polls).toHaveLength(1)
    expect(mocks.polls[0]!.options.verifyCode).toBe('4821')

    // WeChat asking again means the number did not match.
    await answer(dto({ status: 'verify_code', qrUrl: null }))
    expect(text()).toContain("didn't match")
    await click('Confirm')
    await answerAndFollow(dto({ status: 'scanned' }))
    expect(mocks.polls[0]!.options.verifyCode).toBeUndefined()
  })

  it('names the failure and starts a new login on retry', async () => {
    await render()
    await click('Show QR code')
    await answer(dto({ status: 'failed', qrUrl: null, failureReason: 'setup_failed' }))
    expect(text()).toContain('installing the bot failed')
    expect(mocks.polls).toHaveLength(0)
    mocks.startLogin.mockResolvedValueOnce(dto({ id: 'login-2' }))
    await click('Try again')
    expect(mocks.startLogin).toHaveBeenCalledTimes(2)
    expect(mocks.polls[0]!.id).toBe('login-2')
    expect(host.querySelector('svg[role="img"]')).not.toBeNull()
  })

  it('masks an expired code with a refresh button that fetches a new one', async () => {
    await render()
    await click('Show QR code')
    await answer(dto({ status: 'failed', qrUrl: null, failureReason: 'expired' }))
    expect(text()).toContain('QR code expired')
    expect(host.querySelector('svg[aria-hidden]')).not.toBeNull()
    expect(mocks.polls).toHaveLength(0)
    mocks.startLogin.mockResolvedValueOnce(dto({ id: 'login-2' }))
    await click('Refresh QR code')
    expect(mocks.polls[0]!.id).toBe('login-2')
    expect(host.querySelector('svg[role="img"]')).not.toBeNull()
  })

  it('masks the code at its deadline but still takes the poll already in flight', async () => {
    vi.useFakeTimers()
    try {
      await render()
      await click('Show QR code')
      expect(text()).toContain('expires in 2:00')
      await act(async () => vi.advanceTimersByTime(61_000))
      expect(text()).toContain('expires in 0:59')
      const signal = mocks.polls[0]!.options.signal!
      await act(async () => vi.advanceTimersByTime(60_000))
      expect(text()).toContain('QR code expired')
      expect(signal.aborted).toBe(false)
      expect(buttonWith('Refresh QR code')?.disabled).toBe(true)
      await click('Refresh QR code')
      expect(mocks.startLogin).toHaveBeenCalledTimes(1)
      // A scan that landed at the deadline still shows.
      await answer(dto({ status: 'scanned' }))
      expect(text()).toContain('confirm on your phone')
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops polling once the server reports the code past its deadline', async () => {
    await render()
    await click('Show QR code')
    await answer(dto({ expiresAt: new Date(Date.now() - 1000).toISOString() }))
    expect(text()).toContain('QR code expired')
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1100)))
    expect(mocks.polls).toHaveLength(0)
  })

  it('spaces out polls that come back at once', async () => {
    vi.useFakeTimers()
    try {
      await render()
      await click('Show QR code')
      await answer(dto())
      expect(mocks.polls).toHaveLength(0)
      await act(async () => vi.advanceTimersByTime(1000))
      expect(mocks.polls).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a vanished login as failed and shows the server message when the start is refused', async () => {
    const state = await render()
    await click('Show QR code')
    await act(async () => mocks.polls.shift()!.reject(new ApiError('gone', 404)))
    expect(text()).toContain('no longer available')

    mocks.startLogin.mockRejectedValueOnce(new ApiError('Another member is connecting WeChat to this agent.', 409))
    await click('Try again')
    expect(state.setError).toHaveBeenLastCalledWith('Another member is connecting WeChat to this agent.')
  })

  it('retries a poll that failed in transit instead of ending the login', async () => {
    vi.useFakeTimers()
    try {
      await render()
      await click('Show QR code')
      await act(async () => mocks.polls.shift()!.reject(new TypeError('network down')))
      expect(mocks.polls).toHaveLength(0)
      await act(async () => vi.advanceTimersByTime(2000))
      expect(mocks.polls).toHaveLength(1)
      expect(host.querySelector('svg[role="img"]')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts the in-flight long poll when the wizard closes', async () => {
    await render()
    await click('Show QR code')
    const signal = mocks.polls[0]!.options.signal!
    expect(signal.aborted).toBe(false)
    await act(async () => root.unmount())
    expect(signal.aborted).toBe(true)
    root = createRoot(host)
  })
})
