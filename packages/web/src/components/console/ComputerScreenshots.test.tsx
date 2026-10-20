// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('@/lib/api', () => ({ fetchComputerScreenshot: mocks.fetch }))
vi.mock('@/components/marks', () => ({ Spinner: () => <span data-testid="spinner" /> }))

import { ComputerScreenshots } from './ComputerScreenshots'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  mocks.fetch.mockReset()
  vi.useRealTimers()
})

describe('ComputerScreenshots', () => {
  it('shows each stored screenshot through its signed URL, and says when one is not available', async () => {
    vi.useFakeTimers()
    mocks.fetch.mockImplementation(async (_sessionId: string, sha256: string) => {
      if (sha256 === B) throw new Error('404')
      return { sha256, url: 'https://store.example.test/shot.png?sig=1', takenAt: '2026-10-21T10:00:00.000Z' }
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root?.render(<ComputerScreenshots sessionId="sess-1" refs={[A, B]} />))
    expect(mocks.fetch).toHaveBeenCalledWith('sess-1', A)
    // A miss is retried while the upload may still be in flight, then reported.
    expect(container.textContent).not.toContain('Screenshot not available')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000)
    })
    expect(mocks.fetch.mock.calls.filter(([, sha]) => sha === B)).toHaveLength(5)
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('https://store.example.test/shot.png?sig=1')
    expect(container.querySelector('a')?.getAttribute('target')).toBe('_blank')
    expect(container.textContent).toContain('Screenshot not available')
    vi.useRealTimers()
  })

  it('shows a screenshot whose upload is confirmed after the first read', async () => {
    vi.useFakeTimers()
    let confirmed = false
    mocks.fetch.mockImplementation(async (_sessionId: string, sha256: string) => {
      if (!confirmed) throw new Error('404')
      return { sha256, url: 'https://store.example.test/late.png', takenAt: '2026-10-21T10:00:00.000Z' }
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root?.render(<ComputerScreenshots sessionId="sess-1" refs={[A]} />))
    expect(container.querySelector('img')).toBeNull()
    confirmed = true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://store.example.test/late.png')
    vi.useRealTimers()
  })

  it('renders nothing without references', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root?.render(<ComputerScreenshots sessionId="sess-1" refs={[]} />))
    expect(container.innerHTML).toBe('')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
})
