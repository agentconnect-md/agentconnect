// @vitest-environment happy-dom

import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TELEGRAM_PRIVACY_RECHECK_MS, useTelegramPrivacyAutoRefresh } from './privacy-auto-refresh'

let container: HTMLDivElement
let root: Root
const refresh = vi.fn()

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function Harness() {
  const [renderTick, setRenderTick] = useState(0)
  const [status, setStatus] = useState<'privacy_enabled' | 'ready'>('privacy_enabled')

  useEffect(() => {
    const timer = window.setInterval(() => setRenderTick((tick) => tick + 1), 25)
    return () => window.clearInterval(timer)
  }, [])
  useTelegramPrivacyAutoRefresh(status === 'privacy_enabled', async () => {
    refresh()
    setStatus('ready')
  })

  return <span data-status={status}>{renderTick}</span>
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  refresh.mockReset()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useTelegramPrivacyAutoRefresh', () => {
  it('keeps polling through unrelated rerenders and stops when privacy mode is ready', async () => {
    await act(async () => root.render(<Harness />))

    await act(async () => vi.advanceTimersByTimeAsync(TELEGRAM_PRIVACY_RECHECK_MS + 250))

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-status]')?.getAttribute('data-status')).toBe('ready')

    await act(async () => vi.advanceTimersByTimeAsync(TELEGRAM_PRIVACY_RECHECK_MS * 2))

    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
