// @vitest-environment happy-dom

// `useSandboxWake`: the one press per refusal, the poll behind it, and the two ways it ends (#1070).

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wire = vi.hoisted(() => ({
  answers: [] as Array<{ state: 'running' | 'starting' | 'unsupported' } | { status: number }>
}))

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message = `HTTP ${status}`,
      public code?: string
    ) {
      super(message)
    }
  }
  return {
    ApiError,
    wakeAgent: vi.fn(() => {
      const next = wire.answers.shift() ?? { state: 'starting' as const }
      return 'status' in next ? Promise.reject(new ApiError(next.status)) : Promise.resolve(next)
    })
  }
})

import { wakeAgent } from '@/lib/api'
import { SANDBOX_WAKE_BOUND_MS, SANDBOX_WAKE_POLL_MS, useSandboxWake, type SandboxReadState } from './sandbox-wake'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined
let retries = 0
let lastStart: (() => void) | undefined
const retry = () => {
  retries += 1
}

function Harness({
  agentId,
  read,
  sandboxed,
  active
}: {
  agentId: string
  read: SandboxReadState
  sandboxed?: boolean
  active?: boolean
}) {
  const wake = useSandboxWake(agentId, read, retry, { sandboxed, active })
  lastStart = wake.start
  return <span data-phase={wake.phase}>{wake.phase}</span>
}

async function render(props: { agentId?: string; read: SandboxReadState; sandboxed?: boolean; active?: boolean }) {
  if (!container) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  await act(async () => {
    root?.render(
      <Harness
        agentId={props.agentId ?? 'agent-a'}
        read={props.read}
        sandboxed={props.sandboxed}
        active={props.active}
      />
    )
    await Promise.resolve()
  })
}

const phase = () => container?.querySelector('[data-phase]')?.getAttribute('data-phase')
const elapse = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms)
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  wire.answers = []
  retries = 0
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  container = undefined
  root = undefined
  vi.mocked(wakeAgent).mockClear()
  vi.useRealTimers()
})

describe('useSandboxWake', () => {
  it('presses the wake ONCE when the read refuses as asleep, and stays idle otherwise', async () => {
    await render({ read: 'pending' })
    await render({ read: 'failed' })
    expect(vi.mocked(wakeAgent)).not.toHaveBeenCalled()
    expect(phase()).toBe('idle')

    await render({ read: 'asleep' })
    expect(vi.mocked(wakeAgent)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(wakeAgent)).toHaveBeenCalledWith('agent-a')
    expect(phase()).toBe('starting')
    // A re-render with the same refusal is not a second press.
    await render({ read: 'asleep' })
    expect(vi.mocked(wakeAgent)).toHaveBeenCalledTimes(1)
  })

  it('polls the read with backoff after the wake answers, and goes idle once it is ready', async () => {
    await render({ read: 'asleep' })
    expect(retries).toBe(0)
    await elapse(SANDBOX_WAKE_POLL_MS[0] - 1)
    expect(retries).toBe(0)
    await elapse(1)
    expect(retries).toBe(1)
    // The read goes out and refuses again: the next poll waits the next step of the ladder.
    await render({ read: 'pending' })
    await render({ read: 'asleep' })
    await elapse(SANDBOX_WAKE_POLL_MS[1] - 1)
    expect(retries).toBe(1)
    await elapse(1)
    expect(retries).toBe(2)
    // The read answers: nothing more is pressed, and the phase settles.
    await render({ read: 'pending' })
    await render({ read: 'ready' })
    expect(phase()).toBe('idle')
    await elapse(60_000)
    expect(retries).toBe(2)
    expect(vi.mocked(wakeAgent)).toHaveBeenCalledTimes(1)
  })

  it('gives up after the bound, keeps the wake pressable, and does not auto-press again', async () => {
    await render({ read: 'asleep' })
    let last = retries
    // Each poll refuses again; the ladder is walked until the bound passes.
    for (let i = 0; i < 20 && phase() === 'starting'; i += 1) {
      await elapse(SANDBOX_WAKE_POLL_MS[SANDBOX_WAKE_POLL_MS.length - 1]!)
      if (retries !== last) {
        last = retries
        await render({ read: 'pending' })
        await render({ read: 'asleep' })
      }
    }
    expect(phase()).toBe('gave-up')
    expect(Date.now()).toBeGreaterThanOrEqual(SANDBOX_WAKE_BOUND_MS)
    expect(vi.mocked(wakeAgent)).toHaveBeenCalledTimes(1)
    // Start presses again — the only thing that does after a give-up.
    await act(async () => {
      lastStart?.()
      await Promise.resolve()
    })
    expect(vi.mocked(wakeAgent)).toHaveBeenCalledTimes(2)
    expect(phase()).toBe('starting')
  })

  it('a daemon with nothing to wake ends in unsupported without any polling', async () => {
    wire.answers = [{ state: 'unsupported' }]
    await render({ read: 'asleep' })
    expect(phase()).toBe('unsupported')
    await elapse(60_000)
    expect(retries).toBe(0)
  })

  it('a refused press (403) gives up at once; a 503 still lets the read decide', async () => {
    wire.answers = [{ status: 403 }]
    await render({ read: 'asleep' })
    expect(phase()).toBe('gave-up')
    expect(retries).toBe(0)

    wire.answers = [{ status: 503 }]
    await render({ agentId: 'agent-b', read: 'asleep' })
    expect(phase()).toBe('starting')
    await elapse(SANDBOX_WAKE_POLL_MS[0])
    expect(retries).toBe(1)
  })

  it('a sandboxed agent is woken on open, before the read has refused anything', async () => {
    await render({ read: 'pending', sandboxed: true })
    expect(vi.mocked(wakeAgent)).toHaveBeenCalledTimes(1)
    expect(phase()).toBe('starting')
    // ...and a read that simply succeeds settles it with no poll pressed.
    await render({ read: 'ready', sandboxed: true })
    expect(phase()).toBe('idle')
    await elapse(30_000)
    expect(retries).toBe(0)
  })

  it('a hidden surface neither presses nor polls; becoming visible presses once and polls', async () => {
    await render({ read: 'asleep', active: false })
    await elapse(30_000)
    expect(vi.mocked(wakeAgent)).not.toHaveBeenCalled()
    expect(phase()).toBe('idle')

    await render({ read: 'asleep', active: true })
    expect(vi.mocked(wakeAgent)).toHaveBeenCalledTimes(1)
    expect(phase()).toBe('starting')
    await elapse(SANDBOX_WAKE_POLL_MS[0])
    expect(retries).toBe(1)

    // Hidden mid-poll: the timer stops; shown again, it resumes.
    await render({ read: 'asleep', active: false })
    await elapse(60_000)
    expect(retries).toBe(1)
    await render({ read: 'asleep', active: true })
    await elapse(SANDBOX_WAKE_POLL_MS[1])
    expect(retries).toBe(2)
    expect(vi.mocked(wakeAgent)).toHaveBeenCalledTimes(1)
  })
})
