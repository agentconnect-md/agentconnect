// @vitest-environment happy-dom
/**
 * The "Run again" action (gitlab-com-integration.md §16.1). Three claims worth
 * pinning: it is ABSENT — not disabled — for anything that is not a GitLab hook
 * session on a merge-request or issue thread, it sends the SUBJECT only (the
 * revision is the Control Plane's to read), and a refusal is shown rather than
 * swallowed.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

const setFlags = (value?: string) => {
  ;(window as unknown as { __AC_ENV?: Record<string, string> }).__AC_ENV =
    value === undefined ? {} : { FEATURE_FLAGS: value }
}

let root: Root | undefined
let host: HTMLDivElement | undefined

async function render(props: { hookKind?: string | null; hookId?: string | null; thread?: string | null }) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <GitlabRerunButton
        hookKind={(props.hookKind ?? null) as never}
        hookId={props.hookId ?? null}
        thread={props.thread ?? null}
      />
    )
  })
}

const button = () => document.querySelector<HTMLButtonElement>('[data-gitlab-rerun]')

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  setFlags(undefined)
  mocks.rerunGitlabHook.mockClear()
})

describe('GitlabRerunButton', () => {
  const gitlabSession = { hookKind: 'gitlab', hookId: 'hook-1', thread: 'gitlab:4455667:merge_request:42' }

  it('renders for a GitLab merge-request hook session under the flag', async () => {
    setFlags('gitlab')
    await render(gitlabSession)
    expect(button()?.textContent).toContain('Run again')
  })

  it('is absent without the flag, off a GitLab hook, and on a push or webchat thread', async () => {
    setFlags(undefined)
    await render(gitlabSession)
    expect(button()).toBeNull()
    await act(async () => root?.unmount())
    host?.remove()

    setFlags('gitlab')
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
      await act(async () => root?.unmount())
      host?.remove()
    }
    expect(mocks.rerunGitlabHook).not.toHaveBeenCalled()
  })

  it('sends the thread SUBJECT — never a revision the console guessed', async () => {
    setFlags('gitlab')
    await render({ ...gitlabSession, thread: 'gitlab:4455667:issue:7' })
    await act(async () => {
      button()?.click()
    })
    expect(mocks.rerunGitlabHook).toHaveBeenCalledWith('hook-1', { kind: 'issue', iid: 7 })
    expect(document.querySelector('[data-gitlab-rerun-started]')?.textContent).toBe('Started')
    expect(document.querySelector('[data-gitlab-rerun-error]')).toBeNull()
  })

  it('surfaces a refusal instead of failing silently', async () => {
    setFlags('gitlab')
    mocks.rerunGitlabHook.mockRejectedValueOnce(new Error('this merge request is merged'))
    await render(gitlabSession)
    await act(async () => {
      button()?.click()
    })
    expect(document.querySelector('[data-gitlab-rerun-error]')?.textContent).toBe('this merge request is merged')
    expect(button()?.disabled).toBe(false)
  })
})
