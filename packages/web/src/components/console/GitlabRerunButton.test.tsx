// @vitest-environment happy-dom
/**
 * The "Run again" action (gitlab-com-integration.md §16.1). Four claims worth
 * pinning: it is ABSENT — not disabled — for anything that is not a GitLab hook
 * session on a merge-request or issue thread, it sends the SUBJECT only (the
 * revision is the Control Plane's to read), a refusal is translated rather than
 * swallowed or shown raw, and its state belongs to ONE subject — the session
 * detail view stays mounted across `/sessions/a` → `/sessions/b`, so neither the
 * pending state nor a late reply may paint the next session.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  rerunGitlabHook: vi.fn(async () => ({
    accepted: true,
    deliveryKey: 'rerun_1',
    event: 'merge_request:rerun',
    headSha: 'abc'
  }))
}))

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  rerunGitlabHook: mocks.rerunGitlabHook
}))

const { GitlabRerunButton } = await import('./GitlabRerunButton')

let root: Root | undefined
let host: HTMLDivElement | undefined

interface Props {
  hookKind?: string | null
  hookId?: string | null
  thread?: string | null
}

function element(props: Props) {
  return (
    <GitlabRerunButton
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

const button = () => document.querySelector<HTMLButtonElement>('[data-gitlab-rerun]')
const errorText = () => document.querySelector('[data-gitlab-rerun-error]')?.textContent ?? null
const startedText = () => document.querySelector('[data-gitlab-rerun-started]')?.textContent ?? null

afterEach(async () => {
  await unmount()
  mocks.rerunGitlabHook.mockClear()
  mocks.rerunGitlabHook.mockResolvedValue({
    accepted: true,
    deliveryKey: 'rerun_1',
    event: 'merge_request:rerun',
    headSha: 'abc'
  })
})

describe('GitlabRerunButton', () => {
  const gitlabSession = { hookKind: 'gitlab', hookId: 'hook-1', thread: 'gitlab:4455667:merge_request:42' }

  it('renders for a GitLab merge-request hook session', async () => {
    await render(gitlabSession)
    expect(button()?.textContent).toContain('Run again')
  })

  it('is absent off a GitLab hook, and on a push or webchat thread', async () => {
    for (const props of [
      { ...gitlabSession, hookKind: 'github' },
      { ...gitlabSession, hookKind: null },
      { ...gitlabSession, hookId: null },
      { ...gitlabSession, thread: 'gitlab:4455667:push:refs/heads/main' },
      { ...gitlabSession, thread: 'C123:1700000000.1' },
      { ...gitlabSession, thread: null }
    ]) {
      await render(props)
      expect(button()).toBeNull()
      await unmount()
    }
    expect(mocks.rerunGitlabHook).not.toHaveBeenCalled()
  })

  it('sends the thread SUBJECT — never a revision the console guessed', async () => {
    await render({ ...gitlabSession, thread: 'gitlab:4455667:issue:7' })
    await act(async () => {
      button()?.click()
    })
    expect(mocks.rerunGitlabHook).toHaveBeenCalledWith('hook-1', { kind: 'issue', iid: 7 })
    expect(startedText()).toBe('Started')
    expect(errorText()).toBeNull()
  })

  it('translates a refusal code instead of showing the wire category', async () => {
    mocks.rerunGitlabHook.mockRejectedValueOnce(
      new ApiError('this merge request is merged', 409, 'SUBJECT_CLOSED') as never
    )
    await render(gitlabSession)
    await act(async () => {
      button()?.click()
    })
    expect(errorText()).toBe('That merge request or issue is closed on GitLab')
    expect(button()?.disabled).toBe(false)

    // An unmapped code collapses to the generic line — an implementation
    // identifier never reaches this surface.
    mocks.rerunGitlabHook.mockRejectedValueOnce(new ApiError('boom', 500, 'SOME_INTERNAL_CATEGORY') as never)
    await act(async () => {
      button()?.click()
    })
    expect(errorText()).toBe('Could not run this trigger again')
  })

  it('tells the three relay refusals apart, including the spent per-hook budget', async () => {
    await render(gitlabSession)
    for (const [relayCode, copy] of [
      ['replay_pending', 'This trigger is still loading — try again shortly'],
      ['rule_mismatch', 'This trigger changed while the run was starting — try again'],
      ['limiter_exhausted', 'This trigger has run too many times just now — try again later']
    ] as const) {
      mocks.rerunGitlabHook.mockRejectedValueOnce(
        new ApiError('refused', 429, 'RELAY_REJECTED', { relayCode }) as never
      )
      await act(async () => {
        button()?.click()
      })
      expect(errorText()).toBe(copy)
      // The wire category itself never reaches the surface.
      expect(errorText()).not.toContain(relayCode)
    }

    // A RELAY_REJECTED with no category still reads as something a human can act on.
    mocks.rerunGitlabHook.mockRejectedValueOnce(new ApiError('refused', 409, 'RELAY_REJECTED') as never)
    await act(async () => {
      button()?.click()
    })
    expect(errorText()).toBe('The run was not accepted — try again shortly')
  })

  it('renders pristine for the next session and drops the previous one’s late reply', async () => {
    type Reply = Awaited<ReturnType<typeof mocks.rerunGitlabHook>>
    let settleA: ((value: Reply) => void) | undefined
    mocks.rerunGitlabHook.mockImplementationOnce(() => new Promise<Reply>((resolve) => (settleA = resolve)))
    await render(gitlabSession)
    await act(async () => {
      button()?.click()
    })
    // Subject A is in flight.
    expect(button()?.disabled).toBe(true)

    // The reader moves to another GitLab session; the view stays mounted.
    await rerenderWith({ ...gitlabSession, thread: 'gitlab:4455667:merge_request:99' })
    expect(button()?.disabled).toBe(false)
    expect(startedText()).toBeNull()
    expect(errorText()).toBeNull()

    // A's reply lands after the switch — subject B must not report it.
    await act(async () => {
      settleA?.({ accepted: true, deliveryKey: 'rerun_1', event: 'merge_request:rerun', headSha: 'abc' })
    })
    expect(startedText()).toBeNull()
    expect(errorText()).toBeNull()
    expect(button()?.disabled).toBe(false)
  })

  it('keeps an error on its own subject when the reader switches away', async () => {
    mocks.rerunGitlabHook.mockRejectedValueOnce(new ApiError('gone', 409, 'SUBJECT_NOT_FOUND') as never)
    await render(gitlabSession)
    await act(async () => {
      button()?.click()
    })
    expect(errorText()).toBe('That merge request or issue no longer exists')

    await rerenderWith({ ...gitlabSession, thread: 'gitlab:4455667:issue:7' })
    expect(errorText()).toBeNull()
    // …and coming back shows it again: the state was scoped, not discarded.
    await rerenderWith(gitlabSession)
    expect(errorText()).toBe('That merge request or issue no longer exists')
  })
})
