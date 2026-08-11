// @vitest-environment happy-dom

// The Git panel's commit box: the wand's pending state and its refusals, what "Commit N files" sends, what commit-and-push reports when the commit lands and the push does not, and every degraded answer the write wire can give — all of it DATA the reader can act on.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wire = vi.hoisted(() => ({
  commit: null as unknown,
  push: null as unknown,
  draft: null as unknown,
  failure: null as null | { status: number; code?: string },
  calls: [] as Array<{ op: 'commit' | 'push' | 'draft'; message?: string; sessionId?: string }>,
  // Held open so the pending state is observable, then released by hand.
  holdDraft: false,
  releaseDraft: null as null | (() => void)
}))

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code?: string
    ) {
      super(message)
      this.name = 'ApiError'
    }
  }
  const fail = () => new ApiError('nope', wire.failure!.status, wire.failure!.code)
  return {
    ApiError,
    commitWorkspace: vi.fn((_agentId: string, opts: { message: string; sessionId?: string }) => {
      wire.calls.push({ op: 'commit', ...opts })
      return wire.failure ? Promise.reject(fail()) : Promise.resolve(wire.commit)
    }),
    pushWorkspace: vi.fn((_agentId: string, opts: { sessionId?: string } = {}) => {
      wire.calls.push({ op: 'push', ...opts })
      return wire.failure ? Promise.reject(fail()) : Promise.resolve(wire.push)
    }),
    draftWorkspaceCommitMessage: vi.fn((_agentId: string, opts: { sessionId?: string } = {}) => {
      wire.calls.push({ op: 'draft', ...opts })
      if (wire.failure) return Promise.reject(fail())
      if (!wire.holdDraft) return Promise.resolve(wire.draft)
      return new Promise((resolve) => {
        wire.releaseDraft = () => resolve(wire.draft)
      })
    })
  }
})

import { CommitBox, resetCommitDrafts } from './CommitBox'
import type { WorkspaceGitCommitResultDto, WorkspaceGitMessageResultDto, WorkspaceGitPushResultDto } from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined
let wrote = 0

const commitOk = (over: Partial<WorkspaceGitCommitResultDto> = {}): WorkspaceGitCommitResultDto => ({
  isRepo: true,
  ok: true,
  sha: 'a'.repeat(40),
  detail: 'Committed aaaaaaa — 2 files.',
  reason: null,
  ...over
})

const pushOk = (over: Partial<WorkspaceGitPushResultDto> = {}): WorkspaceGitPushResultDto => ({
  isRepo: true,
  ok: true,
  detail: 'Pushed 1 commit to main.',
  ahead: 0,
  reason: null,
  ...over
})

const draftOk = (over: Partial<WorkspaceGitMessageResultDto> = {}): WorkspaceGitMessageResultDto => ({
  ok: true,
  message: 'feat(dock): stage from the console',
  detail: null,
  ...over
})

async function render(props: Partial<Parameters<typeof CommitBox>[0]> = {}) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <CommitBox agentId="agent-a" sessionId="session-1" stagedCount={2} onWrote={() => (wrote += 1)} {...props} />
    )
    await Promise.resolve()
  })
}

async function rerender(props: Partial<Parameters<typeof CommitBox>[0]> = {}) {
  await act(async () => {
    root?.render(
      <CommitBox agentId="agent-a" sessionId="session-1" stagedCount={2} onWrote={() => (wrote += 1)} {...props} />
    )
    await Promise.resolve()
  })
}

const text = () => container?.textContent ?? ''
const field = () => container?.querySelector<HTMLTextAreaElement>('[data-commit-message]') ?? undefined
const button = (name: 'draft' | 'submit' | 'push') =>
  container?.querySelector<HTMLButtonElement>(`[data-commit-${name}]`) ?? undefined
const outcome = () => container?.querySelector<HTMLElement>('[data-commit-outcome]') ?? undefined

async function click(element: Element | undefined, what: string) {
  expect(element, what).toBeDefined()
  await act(async () => (element as HTMLElement | undefined)?.click())
}

// Through the PROTOTYPE setter: React 19 overrides the node's own `value` setter to track it, so assigning directly makes React believe nothing changed and no onChange fires.
async function type(value: string) {
  const node = field()
  expect(node, 'message field').toBeDefined()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(node, value)
    node?.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  resetCommitDrafts()
  wire.commit = commitOk()
  wire.push = pushOk()
  wire.draft = draftOk()
  wire.failure = null
  wire.calls = []
  wire.holdDraft = false
  wire.releaseDraft = null
  wrote = 0
  vi.clearAllMocks()
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = undefined
  root = undefined
})

describe('CommitBox', () => {
  it('says nothing is staged before the round trip, and offers no commit', async () => {
    await render({ stagedCount: 0 })

    expect(button('submit')?.disabled).toBe(true)
    expect(button('push')?.disabled).toBe(true)
    // The wand writes from the staged diff, so with nothing staged there is nothing for it to read either.
    expect(button('draft')?.disabled).toBe(true)
    expect(button('submit')?.textContent).toContain('Commit')
    expect(field()?.placeholder).toContain('Stage a file')
    // A message alone does not make a commit: with an empty index there is nothing for it to describe, so the button stays shut.
    await type('feat: work')
    expect(button('submit')?.disabled).toBe(true)
    expect(button('push')?.disabled).toBe(true)
    expect(wire.calls).toEqual([])
  })

  it('refuses a commit with no message, then accepts one, and names the file count', async () => {
    await render()

    expect(button('submit')?.textContent).toContain('Commit 2 files')
    expect(button('submit')?.disabled).toBe(true)
    // Whitespace is not a message: the daemon would answer `empty-message`, so the box does not spend the round trip.
    await type('   ')
    expect(button('submit')?.disabled).toBe(true)

    await type('feat: work')
    expect(button('submit')?.disabled).toBe(false)
    await click(button('submit'), 'commit')

    expect(wire.calls).toEqual([{ op: 'commit', message: 'feat: work', sessionId: 'session-1' }])
    expect(outcome()?.dataset.commitOutcome).toBe('ok')
    expect(text()).toContain('Committed aaaaaaa — 2 files.')
    // The draft is spent, and the caller is told to re-read what it owns.
    expect(field()?.value).toBe('')
    expect(wrote).toBe(1)
  })

  it('commits exactly one file with singular copy', async () => {
    await render({ stagedCount: 1 })
    expect(button('submit')?.textContent).toContain('Commit 1 file')
  })

  it('omits sessionId for the agent’s primary checkout', async () => {
    await render({ sessionId: undefined })
    await type('feat: work')
    await click(button('submit'), 'commit')
    expect(wire.calls).toEqual([{ op: 'commit', message: 'feat: work' }])
  })

  it('reports the commit AND the rejected push, because the commit landed', async () => {
    wire.push = pushOk({
      ok: false,
      ahead: 3,
      reason: 'diverged',
      detail: 'Rejected — the remote has commits this branch does not. Pull, then push.'
    })
    await render()
    await type('feat: work')
    await click(button('push'), 'commit and push')

    expect(wire.calls).toEqual([
      { op: 'commit', message: 'feat: work', sessionId: 'session-1' },
      { op: 'push', sessionId: 'session-1' }
    ])
    expect(outcome()?.dataset.commitOutcome).toBe('bad')
    expect(text()).toContain('Committed aaaaaaa — 2 files.')
    expect(text()).toContain('Pull, then push')
    // The commit is real work that must not be re-read away: the panel is told even though the push failed.
    expect(wrote).toBe(1)
  })

  it('does not push when the commit itself was refused', async () => {
    wire.commit = commitOk({ ok: false, sha: null, reason: 'no-identity', detail: null })
    await render()
    await type('feat: work')
    await click(button('push'), 'commit and push')

    expect(wire.calls.map((call) => call.op)).toEqual(['commit'])
    // No `detail` from the daemon, so the reason's own copy carries the next action.
    expect(text()).toContain('registered no commit identity')
    expect(field()?.value).toBe('feat: work')
    expect(wrote).toBe(0)
  })

  it('keeps the message when a commit is refused, so nothing typed is lost', async () => {
    wire.commit = commitOk({ ok: false, sha: null, reason: 'nothing-staged', detail: 'Nothing is staged.' })
    await render()
    await type('feat: work')
    await click(button('submit'), 'commit')

    expect(text()).toContain('Nothing is staged.')
    expect(field()?.value).toBe('feat: work')
  })

  it('draws the pending state while the wand runs, then fills the box with the draft', async () => {
    wire.holdDraft = true
    await render()

    await click(button('draft'), 'wand')
    expect(container?.querySelector('[data-commit-drafting]')).not.toBeNull()
    expect(text()).toContain('Generating from staged diff…')
    expect(button('draft')?.querySelector('[aria-label="Loading"]')).not.toBeNull()
    // Not twice: a second press would bill a second model pass on the agent's runtime.
    expect(button('draft')?.disabled).toBe(true)
    await click(button('draft'), 'wand again')
    expect(wire.calls.filter((call) => call.op === 'draft')).toHaveLength(1)

    await act(async () => {
      wire.releaseDraft?.()
      await Promise.resolve()
    })
    expect(field()?.value).toBe('feat(dock): stage from the console')
    expect(container?.querySelector('[data-commit-drafting]')).toBeNull()
    // A draft writes nothing, so nobody's reads are stale.
    expect(wrote).toBe(0)
  })

  it('bills ONE model pass for a double-click, before any re-render can disable the wand', async () => {
    wire.holdDraft = true
    await render()
    const wand = button('draft')
    expect(wand, 'wand').toBeDefined()

    // Both presses land in the SAME task, so neither sees the other's state update and the button is still enabled for both — the `disabled` attribute cannot be the barrier here.
    await act(async () => {
      wand?.click()
      wand?.click()
    })
    expect(wire.calls.filter((call) => call.op === 'draft')).toHaveLength(1)
  })

  it('sends ONE commit for a double-click on Commit', async () => {
    await render()
    await type('feat: work')
    const submit = button('submit')
    await act(async () => {
      submit?.click()
      submit?.click()
    })
    expect(wire.calls.filter((call) => call.op === 'commit')).toHaveLength(1)
  })

  it('shows the runtime’s own detail when it declines to draft a message', async () => {
    wire.draft = draftOk({ ok: false, message: null, detail: 'The runtime declined to draft a commit message.' })
    await render()

    await click(button('draft'), 'wand')
    expect(text()).toContain('The runtime declined to draft a commit message.')
    expect(field()?.value).toBe('')
  })

  it('reads a wand 503 as an unreachable daemon, not as a refusal to write a message', async () => {
    wire.failure = { status: 503 }
    await render()

    await click(button('draft'), 'wand')
    expect(text()).toContain('daemon may be offline')
  })

  it('reads a busy agent’s 409 as "try again when it is idle"', async () => {
    wire.failure = { status: 409, code: 'WORKSPACE_STALE' }
    await render()
    await type('feat: work')
    await click(button('submit'), 'commit')

    expect(text()).toContain('working in this workspace right now')
    expect(field()?.value).toBe('feat: work')
  })
  it('parks a draft per checkout and gives it back, instead of spending a model pass twice', async () => {
    // A draft belongs to ONE checkout, so it must never follow the reader into another agent's
    // workspace — but losing it outright means a glance at a sibling agent silently throws away a
    // message the reader paid for.
    await render()
    await type('fix: guard the parser')
    expect(field()?.value).toBe('fix: guard the parser')

    await rerender({ agentId: 'agent-b' })
    // Not carried across: committing agent A's message into B's checkout would be the worse bug.
    expect(field()?.value).toBe('')
    await type('chore: bump b')

    await rerender({ agentId: 'agent-a' })
    expect(field()?.value).toBe('fix: guard the parser')
    await rerender({ agentId: 'agent-b' })
    expect(field()?.value).toBe('chore: bump b')
  })
})
