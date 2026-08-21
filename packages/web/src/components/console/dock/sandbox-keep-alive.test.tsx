// @vitest-environment happy-dom

// The page's half of the sandbox lease: renew while open and on screen, stop otherwise. The stopping
// is the whole release mechanism — there is no call that gives a pod back — so both halves are pinned
// here, along with the rule that a refusal is silent (a daemon that cannot hold is not an error a
// session page should surface).

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls: string[] = []
let answer: unknown = {
  held: true,
  reasons: ['uncommitted-files'],
  ttlMs: 180_000,
  placement: 'sandbox',
  asleep: false
}
let failure: Error | null = null

vi.mock('@/lib/api', () => ({
  keepSessionSandboxAlive: vi.fn((sessionId: string) => {
    calls.push(sessionId)
    return failure ? Promise.reject(failure) : Promise.resolve(answer)
  })
}))

const { KEEP_ALIVE_MS, useSandboxKeepAlive } = await import('./sandbox-keep-alive')

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined
let held: unknown = null

function Probe({ sessionId }: { sessionId: string | null }) {
  held = useSandboxKeepAlive(sessionId)
  return null
}

async function render(sessionId: string | null) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<Probe sessionId={sessionId} />)
  })
}

async function rerender(sessionId: string | null) {
  await act(async () => {
    root!.render(<Probe sessionId={sessionId} />)
  })
}

/** Drive `document.visibilityState`, which happy-dom reports from a getter. */
async function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

beforeEach(() => {
  calls.length = 0
  held = null
  failure = null
  answer = { held: true, reasons: ['uncommitted-files'], ttlMs: 180_000, placement: 'sandbox', asleep: false }
  vi.useFakeTimers()
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  await setVisibility('visible')
  vi.useRealTimers()
})

describe('useSandboxKeepAlive', () => {
  it('renews immediately and then on its cadence, and reports what is held', async () => {
    // Immediately, because a page opened onto a dirty worktree must hold the pod now rather than after
    // a cadence it might not survive.
    await render('session-1')
    expect(calls).toEqual(['session-1'])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS * 2)
    })
    expect(calls).toEqual(['session-1', 'session-1', 'session-1'])
    expect(held).toMatchObject({ held: true, reasons: ['uncommitted-files'] })
  })

  it('stops while the document is in the background, and resumes when it comes back', async () => {
    // The same fence the dock's polling uses: a browser nobody is looking at holds no pod, so a closed
    // laptop releases within one TTL without anything having to say so.
    await render('session-1')
    calls.length = 0
    await setVisibility('hidden')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS * 4)
    })
    expect(calls).toEqual([])

    await setVisibility('visible')
    expect(calls).toEqual(['session-1'])
  })

  it('holds nothing without a session, and never renews the old one after a switch', async () => {
    await render(null)
    expect(calls).toEqual([])

    await rerender('session-1')
    await rerender('session-2')
    calls.length = 0
    await act(async () => {
      await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS)
    })
    expect(calls).toEqual(['session-2'])
  })

  it('keeps renewing through a refusal, and reports nothing held', async () => {
    // A 409 (daemon too old, no sandbox) or 503 (offline) is not an error this page acts on — the
    // sweep's own rules apply — and the next poll may well succeed, so the cadence continues.
    failure = new Error('nope')
    await render('session-1')
    expect(held).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS)
    })
    expect(calls).toHaveLength(2)
    expect(held).toBeNull()
  })
})
