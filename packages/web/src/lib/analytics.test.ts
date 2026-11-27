// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the SDK so the dynamic import inside initAnalytics resolves to spies.
const sdk = vi.hoisted(() => ({ init: vi.fn(), capture: vi.fn(), identify: vi.fn(), reset: vi.fn() }))
vi.mock('posthog-js', () => ({ default: sdk }))

beforeEach(() => {
  vi.resetModules() // fresh module state (ph / pending / starting) per test
  sdk.init.mockClear()
  sdk.identify.mockClear()
  sdk.reset.mockClear()
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = {
    POSTHOG_API_KEY: 'phc_test',
    POSTHOG_HOST: 'https://us.i.posthog.com'
  }
})

describe('analytics identity race during lazy init', () => {
  it('reset queued mid-load wins over a queued identify (no stale distinct id)', async () => {
    const a = await import('./analytics')
    const started = a.initAnalytics() // suspends at `await import('posthog-js')`
    // These run before the import microtask resolves ⇒ ph is still undefined ⇒ queued.
    a.identifyUser('user-1', { email: 'a@example.com' })
    a.resetAnalytics()
    await started // import resolves → init() + replay of the queued action

    expect(sdk.init).toHaveBeenCalledTimes(1)
    expect(sdk.reset).toHaveBeenCalledTimes(1)
    expect(sdk.identify).not.toHaveBeenCalled()
  })

  it('identify queued mid-load is replayed once the SDK is ready', async () => {
    const a = await import('./analytics')
    const started = a.initAnalytics()
    a.identifyUser('user-2')
    await started

    expect(sdk.identify).toHaveBeenCalledTimes(1)
    expect(sdk.identify).toHaveBeenCalledWith('user-2', undefined)
    expect(sdk.reset).not.toHaveBeenCalled()
  })

  it('no key ⇒ SDK never loads (analytics off is inert)', async () => {
    ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV = {}
    const a = await import('./analytics')
    await a.initAnalytics()
    a.track('agent_created', { org_id: 'o1' })
    expect(sdk.init).not.toHaveBeenCalled()
  })
})

describe('share-link tokens', () => {
  it('never reach an event: every address in it loses the token', async () => {
    const a = await import('./analytics')
    await a.initAnalytics()
    const { before_send } = sdk.init.mock.calls[0]![1] as { before_send: (event: unknown) => unknown }
    const event = {
      event: '$pageview',
      properties: {
        $current_url: 'https://console.example.test/share/abcDEF0123456789_-xyz?path=%2Fdocs',
        $pathname: '/share/abcDEF0123456789_-xyz',
        $referrer: '$direct',
        count: 2
      },
      $set_once: { $initial_current_url: 'https://console.example.test/share/abcDEF0123456789_-xyz' }
    }
    expect(before_send(event)).toEqual({
      event: '$pageview',
      properties: {
        $current_url: 'https://console.example.test/share/[token]?path=%2Fdocs',
        $pathname: '/share/[token]',
        $referrer: '$direct',
        count: 2
      },
      $set_once: { $initial_current_url: 'https://console.example.test/share/[token]' }
    })
    expect(before_send(null)).toBeNull()
  })
})
