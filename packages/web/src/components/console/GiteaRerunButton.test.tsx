// @vitest-environment happy-dom
/**
 * The "Run again" action for a Gitea trigger session. The same four claims the
 * GitLab button pins: it is ABSENT — not disabled — for anything that is not a
 * Gitea hook session on a pull-request or issue thread, it sends the SUBJECT only
 * (the revision is the Control Plane's to read), a refusal is translated rather
 * than swallowed or shown raw, and its state belongs to ONE subject — the session
 * detail view stays mounted across `/sessions/a` → `/sessions/b`, so neither the
 * pending state nor a late reply may paint the next session.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const REPLY = { accepted: true, deliveryKey: 'rerun_1', event: 'merge_request:rerun', headSha: 'abc' }

const mocks = vi.hoisted(() => ({
  rerunGiteaHook: vi.fn(async () => ({
    accepted: true,
    deliveryKey: 'rerun_1',
    event: 'merge_request:rerun',
    headSha: 'abc'
  }))
}))

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  rerunGiteaHook: mocks.rerunGiteaHook
}))

const { GiteaRerunButton } = await import('./GiteaRerunButton')

let root: Root | undefined
let host: HTMLDivElement | undefined

interface Props {
  hookKind?: string | null
  hookId?: string | null
  thread?: string | null
}

function element(props: Props) {
  return (
    <GiteaRerunButton
      hookKind={(props.hookKind ?? null) as never}
      hookId={props.hookId ?? null}
      thread={props.thread ?? null}
    />
  )
}

async function render(props: Props) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(element(props))
  })
}

/** Re-render the SAME mounted component with another session's props. */
async function rerenderWith(props: Props) {
  await act(async () => {
    root?.render(element(props))
  })
}

async function unmount() {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
}

const button = () => document.querySelector<HTMLButtonElement>('[data-gitea-rerun]')
const errorText = () => document.querySelector('[data-gitea-rerun-error]')?.textContent ?? null
const startedText = () => document.querySelector('[data-gitea-rerun-started]')?.textContent ?? null

afterEach(async () => {
  await unmount()
  mocks.rerunGiteaHook.mockClear()
  mocks.rerunGiteaHook.mockResolvedValue(REPLY)
})

describe('GiteaRerunButton', () => {
  const giteaSession = { hookKind: 'gitea', hookId: 'hook-1', thread: 'gitea:7711:pull:42' }

  it('renders for a Gitea pull-request hook session', async () => {
    await render(giteaSession)
    expect(button()?.textContent).toContain('Run again')
  })

  it('is absent off a Gitea hook, and on a push or chat thread', async () => {
    for (const props of [
      { ...giteaSession, hookKind: 'gitlab' },
      { ...giteaSession, hookKind: null },
      { ...giteaSession, hookId: null },
      { ...giteaSession, thread: 'gitea:7711:push:refs/heads/main' },
      { ...giteaSession, thread: 'C123:1700000000.1' },
      { ...giteaSession, thread: null }
    ]) {
      await render(props)
      expect(button()).toBeNull()
      await unmount()
    }
    expect(mocks.rerunGiteaHook).not.toHaveBeenCalled()
  })

  it('sends the thread SUBJECT — never a revision the console guessed', async () => {
    await render({ ...giteaSession, thread: 'gitea:7711:issue:7' })
    await act(async () => {
      button()?.click()
    })
    // Gitea's own thread vocabulary; the binding translates it onto the shared rerun route.
    expect(mocks.rerunGiteaHook).toHaveBeenCalledWith('hook-1', { kind: 'issue', index: 7 })
    expect(startedText()).toBe('Started')
    expect(errorText()).toBeNull()
  })

  it('translates a refusal code instead of showing the wire category', async () => {
    mocks.rerunGiteaHook.mockRejectedValueOnce(
      new ApiError('this pull request is merged', 409, 'SUBJECT_CLOSED') as never
    )
    await render(giteaSession)
    await act(async () => {
      button()?.click()
    })
    expect(errorText()).toBe('That pull request or issue is closed on Gitea')
    expect(button()?.disabled).toBe(false)

    // An unmapped code collapses to the generic line — an implementation identifier never
    // reaches this surface.
    mocks.rerunGiteaHook.mockRejectedValueOnce(new ApiError('boom', 500, 'SOME_INTERNAL_CATEGORY') as never)
    await act(async () => {
      button()?.click()
    })
    expect(errorText()).toBe('Could not run this trigger again')
  })

  it('tells the three relay refusals apart, including the spent per-hook budget', async () => {
    await render(giteaSession)
    for (const [relayCode, copy] of [
      ['replay_pending', 'This trigger is still loading — try again shortly'],
      ['rule_mismatch', 'This trigger changed while the run was starting — try again'],
      ['limiter_exhausted', 'This trigger has run too many times just now — try again later']
    ] as const) {
      mocks.rerunGiteaHook.mockRejectedValueOnce(new ApiError('refused', 429, 'RELAY_REJECTED', { relayCode }) as never)
      await act(async () => {
        button()?.click()
      })
      expect(errorText()).toBe(copy)
      // The wire category itself never reaches the surface.
      expect(errorText()).not.toContain(relayCode)
    }

    // A RELAY_REJECTED with no category still reads as something a human can act on.
    mocks.rerunGiteaHook.mockRejectedValueOnce(new ApiError('refused', 409, 'RELAY_REJECTED') as never)
    await act(async () => {
      button()?.click()
    })
    expect(errorText()).toBe('The run was not accepted — try again shortly')
  })

  it('renders pristine for the next session and drops the previous one’s late reply', async () => {
    type Reply = Awaited<ReturnType<typeof mocks.rerunGiteaHook>>
    let settleA: ((value: Reply) => void) | undefined
    mocks.rerunGiteaHook.mockImplementationOnce(() => new Promise<Reply>((resolve) => (settleA = resolve)))
    await render(giteaSession)
    await act(async () => {
      button()?.click()
    })
    // Subject A is in flight.
    expect(button()?.disabled).toBe(true)

    // The reader moves to another Gitea session; the view stays mounted.
    await rerenderWith({ ...giteaSession, thread: 'gitea:7711:pull:99' })
    expect(button()?.disabled).toBe(false)
    expect(startedText()).toBeNull()
    expect(errorText()).toBeNull()

    // A's reply lands after the switch — subject B must not report it.
    await act(async () => {
      settleA?.(REPLY)
    })
    expect(startedText()).toBeNull()
    expect(errorText()).toBeNull()
    expect(button()?.disabled).toBe(false)
  })

  it('keeps an error on its own subject when the reader switches away', async () => {
    mocks.rerunGiteaHook.mockRejectedValueOnce(new ApiError('gone', 409, 'SUBJECT_NOT_FOUND') as never)
    await render(giteaSession)
    await act(async () => {
      button()?.click()
    })
    expect(errorText()).toBe('That pull request or issue no longer exists')

    await rerenderWith({ ...giteaSession, thread: 'gitea:7711:issue:7' })
    expect(errorText()).toBeNull()
    // …and coming back shows it again: the state was scoped, not discarded.
    await rerenderWith(giteaSession)
    expect(errorText()).toBe('That pull request or issue no longer exists')
  })
})
