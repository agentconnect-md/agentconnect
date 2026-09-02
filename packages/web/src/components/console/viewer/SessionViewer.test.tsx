// @vitest-environment happy-dom

// The left-pane file viewer: what it draws for every answer `workspace/read` can give, and the two things a sliced read must never get wrong — trusting its own byte arithmetic over the daemon's, or splicing two revisions of one file together. Since M3 it also stages: which direction the open scope names, when the action is withheld, and how the diff on screen stays in step with a write made anywhere.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Slice = {
  exists?: boolean
  type?: 'file' | 'dir' | null
  size?: number | null
  mtime?: string | null
  encoding?: 'utf8' | 'none' | null
  content?: string | null
  offset?: number | null
  nextOffset?: number | null
  truncated?: boolean | null
}

// Keyed by the byte offset asked for, so a case can give slice 0 and slice 64 different bytes — and a different mtime.
const wire = vi.hoisted(() => ({
  slices: {} as Record<number, Slice>,
  failure: null as number | 'network' | null,
  calls: [] as Array<{ path: string; offset?: number; sessionId?: string }>,
  /** Resolve the next read by hand, for the cases about which answer wins a race. */
  hold: null as null | Array<(value?: unknown) => void>,
  /** One diff answer per scope, plus the reads that asked for them. */
  diffs: {} as Record<
    string,
    Partial<{ isRepo: boolean; exists: boolean; diff: string | null; binary: boolean; truncated: boolean }>
  >,
  diffFailure: null as null | { status: number; code?: string },
  diffCalls: [] as Array<{ path: string; scope?: string; sessionId?: string }>,
  /** Index writes: the calls the pane made, and the answer it gets. */
  stageCalls: [] as Array<{ kind: 'stage' | 'unstage'; paths: string[]; sessionId?: string }>,
  stageFailure: null as null | { status: number; code?: string }
}))

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message = `HTTP ${status}`,
      readonly code?: string
    ) {
      super(message)
    }
  }
  return {
    ApiError,
    fetchWorkspaceGitDiff: vi.fn(
      async (_agentId: string, opts: { path: string; scope?: string; sessionId?: string }) => {
        wire.diffCalls.push(opts)
        if (wire.diffFailure) throw new ApiError(wire.diffFailure.status, 'nope', wire.diffFailure.code)
        const answer = wire.diffs[opts.scope ?? 'unstaged'] ?? {}
        return {
          path: opts.path,
          isRepo: answer.isRepo ?? true,
          exists: answer.exists ?? true,
          diff: answer.diff ?? null,
          binary: answer.binary ?? false,
          truncated: answer.truncated ?? false
        }
      }
    ),
    stageWorkspacePaths: vi.fn(async (_agentId: string, opts: { paths: string[]; sessionId?: string }) => {
      wire.stageCalls.push({ kind: 'stage', ...opts })
      if (wire.stageFailure) throw new ApiError(wire.stageFailure.status, 'nope', wire.stageFailure.code)
      return { isRepo: true }
    }),
    unstageWorkspacePaths: vi.fn(async (_agentId: string, opts: { paths: string[]; sessionId?: string }) => {
      wire.stageCalls.push({ kind: 'unstage', ...opts })
      if (wire.stageFailure) throw new ApiError(wire.stageFailure.status, 'nope', wire.stageFailure.code)
      return { isRepo: true }
    }),
    fetchWorkspaceFile: vi.fn(async (_agentId: string, opts: { path: string; offset?: number; sessionId?: string }) => {
      wire.calls.push(opts)
      if (wire.hold) await new Promise((resolve) => wire.hold?.push(resolve))
      if (wire.failure !== null) {
        throw wire.failure === 'network' ? new Error('fetch failed') : new ApiError(wire.failure)
      }
      const slice = wire.slices[opts.offset ?? 0] ?? {}
      return {
        path: opts.path,
        exists: slice.exists ?? true,
        type: slice.type ?? 'file',
        size: slice.size ?? slice.content?.length ?? 0,
        mtime: slice.mtime ?? '2026-08-10T10:00:00.000Z',
        encoding: slice.encoding ?? 'utf8',
        content: slice.content ?? '',
        offset: slice.offset ?? opts.offset ?? 0,
        nextOffset: slice.nextOffset ?? null,
        truncated: slice.truncated ?? false
      }
    })
  }
})

// The real pipeline either side of the lazy chunk: `highlight`, `escapeHtml`, `linkifyHtml` and `languageLabel` stay real, only the dynamic import is stood in for.
const hl = vi.hoisted(() => ({ fail: false }))
vi.mock('@/lib/highlight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/highlight')>()
  return {
    ...actual,
    loadHljs: () =>
      hl.fail
        ? Promise.reject(new Error('chunk failed'))
        : Promise.resolve({
            getLanguage: () => ({ name: 'TypeScript' }),
            highlight: (code: string) => ({ value: `<b class="hljs-keyword">${code}</b>` })
          })
  }
})

import { SessionViewer, viewerModeFromParam } from './SessionViewer'
import { fetchWorkspaceFile, fetchWorkspaceGitDiff } from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined
let closed = 0
let modeChanges: string[] = []
// How many times the pane told its host the index moved — what makes the Git panel re-read its lists.
let indexChanges = 0

type ViewerProps = Parameters<typeof SessionViewer>[0]

function viewer(props: Partial<ViewerProps> = {}) {
  return (
    <SessionViewer
      agentId="agent-a"
      sessionId="session-1"
      path="src/app/page.tsx"
      onModeChange={(mode) => modeChanges.push(mode)}
      onClose={() => closed++}
      {...props}
    />
  )
}

async function render(props: Partial<ViewerProps> = {}) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(viewer(props))
    await Promise.resolve()
  })
}

async function rerender(props: Partial<ViewerProps> = {}) {
  await act(async () => {
    root?.render(viewer(props))
    await Promise.resolve()
  })
}

async function settle() {
  await act(async () => {
    await Promise.resolve()
  })
}

const text = () => container?.textContent ?? ''
const gutter = () => container?.querySelector('[data-viewer-gutter]')?.textContent ?? ''
const code = () => container?.querySelector('[data-viewer-code] pre:last-of-type')?.textContent ?? ''
const click = async (selector: string) => {
  const target = container?.querySelector<HTMLElement>(selector)
  if (!target) throw new Error(`no ${selector}`)
  await act(async () => {
    target.click()
    await Promise.resolve()
  })
}
const button = (label: string) =>
  Array.from(container?.querySelectorAll('button') ?? []).find((b) => b.textContent?.trim() === label)
const pressButton = async (label: string) => {
  const target = button(label)
  if (!target) throw new Error(`no "${label}" button`)
  await act(async () => {
    target.click()
    await Promise.resolve()
  })
}

beforeEach(() => {
  wire.slices = {}
  wire.failure = null
  wire.calls = []
  wire.hold = null
  wire.diffs = {}
  wire.diffFailure = null
  wire.diffCalls = []
  wire.stageCalls = []
  wire.stageFailure = null
  modeChanges = []
  indexChanges = 0
  hl.fail = false
  closed = 0
  vi.mocked(fetchWorkspaceFile).mockClear()
  vi.mocked(fetchWorkspaceGitDiff).mockClear()
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = undefined
  root = undefined
})

describe('SessionViewer header', () => {
  it('names the file, its language, its line count and its size', async () => {
    wire.slices[0] = { content: 'const a = 1\nconst b = 2\n', size: 24 }
    await render()
    expect(text()).toContain('src/app/')
    expect(text()).toContain('page.tsx')
    // Two lines, not three: the trailing newline ends the second line rather than beginning an empty third.
    expect(text()).toContain('TypeScript · 2 lines · 24 B')
  })

  it('closes back to the conversation rather than naming a mode', async () => {
    wire.slices[0] = { content: 'x' }
    await render()
    const close = container?.querySelector<HTMLElement>('[data-viewer-close]')
    expect(close?.getAttribute('aria-label')).toBe('Back to the conversation')
    await click('[data-viewer-close]')
    expect(closed).toBe(1)
  })

  it('names no language for an extension nothing maps', async () => {
    wire.slices[0] = { content: 'blob\n', size: 5 }
    await render({ path: 'notes.wat' })
    expect(text()).toContain('1 line · 5 B')
    expect(text()).not.toContain('TypeScript')
  })

  it('says the line count describes only the slice on screen while more is unread', async () => {
    wire.slices[0] = { content: 'a\nb\nc\n', size: 200_000, truncated: true, nextOffset: 65_536 }
    await render()
    expect(text()).toContain('first 3 lines')
    expect(text()).not.toContain('TypeScript · 3 lines')
  })
})

describe('SessionViewer body', () => {
  it('numbers every line it renders, and only the lines it renders', async () => {
    wire.slices[0] = { content: 'one\ntwo\nthree' }
    await render()
    expect(gutter()).toBe('1\n2\n3')
    expect(code()).toBe('one\ntwo\nthree')
  })

  it('sends the highlighted markup through, and the escaped text when the highlighter never arrives', async () => {
    wire.slices[0] = { content: 'const x = 1' }
    await render()
    expect(container?.querySelector('[data-viewer-code] b.hljs-keyword')?.textContent).toBe('const x = 1')

    hl.fail = true
    await rerender({ path: 'src/other.tsx' })
    await settle()
    expect(container?.querySelector('[data-viewer-code] b.hljs-keyword')).toBeNull()
    expect(code()).toBe('const x = 1')
  })

  it('escapes rather than injects content that looks like markup', async () => {
    hl.fail = true
    wire.slices[0] = { content: '<script>alert(1)</script>' }
    await render()
    expect(container?.querySelector('[data-viewer-code] script')).toBeNull()
    expect(code()).toBe('<script>alert(1)</script>')
  })

  it('says an empty file is empty instead of drawing an empty gutter', async () => {
    wire.slices[0] = { content: '', size: 0 }
    await render()
    expect(text()).toContain('This file is empty.')
    expect(container?.querySelector('[data-viewer-gutter]')).toBeNull()
  })

  it('draws a path this checkout does not have as a not-found state, not a failure', async () => {
    wire.slices[0] = { exists: false, content: null, size: null }
    await render({ path: 'src/gone.ts' })
    expect(text()).toContain('this checkout has no file at that path')
    expect(text()).not.toContain('daemon may be offline')
    expect(container?.querySelector('[data-viewer-gutter]')).toBeNull()
  })

  it('withholds a binary file by name and size, as the daemon withheld its bytes', async () => {
    wire.slices[0] = { encoding: 'none', content: null, size: 2048 }
    await render({ path: 'assets/logo.png' })
    expect(text()).toContain('Binary file — not displayed (2.0 KB)')
    expect(container?.querySelector('[data-viewer-gutter]')).toBeNull()
  })
})

describe('SessionViewer degraded reads', () => {
  it('reads a rejected read as an offline daemon', async () => {
    wire.failure = 'network'
    await render()
    expect(text()).toContain('the owning daemon may be offline')
    expect(text()).not.toContain('cannot read a session checkout')
    expect(text()).not.toContain('not available to read')
  })

  it('tells a daemon too old for session-scoped reads apart from an offline one', async () => {
    wire.failure = 409
    await render()
    expect(text()).toContain('cannot read a session checkout')
    expect(text()).not.toContain('may be offline')
  })

  it('says whose checkout is missing when the scope itself is refused', async () => {
    wire.failure = 404
    await render()
    expect(text()).toContain("This session's checkout is not available to read")

    await act(() => root?.unmount())
    container?.remove()
    await render({ sessionId: undefined })
    expect(text()).toContain('This workspace is not available to read.')
    expect(text()).not.toContain("session's worktree")
  })
})

describe('SessionViewer scope', () => {
  it('scopes the read to the session worktree it was given', async () => {
    wire.slices[0] = { content: 'x' }
    await render()
    expect(wire.calls[0]).toEqual({ path: 'src/app/page.tsx', sessionId: 'session-1' })
  })

  it('reads the primary checkout when no session scope is given', async () => {
    wire.slices[0] = { content: 'x' }
    await render({ sessionId: undefined })
    expect(wire.calls[0]).toEqual({ path: 'src/app/page.tsx' })
  })

  it('drops an answer that is no longer the file on screen', async () => {
    wire.hold = []
    await render({ path: 'a.ts' })
    await rerender({ path: 'b.ts' })
    wire.slices[0] = { content: 'B' }
    // The second read answers first, then the first read's answer arrives for a path nobody is looking at.
    const [releaseA, releaseB] = wire.hold
    wire.hold = null
    await act(async () => {
      releaseB?.()
      await Promise.resolve()
    })
    wire.slices[0] = { content: 'A' }
    await act(async () => {
      releaseA?.()
      await Promise.resolve()
    })
    expect(code()).toBe('B')
  })
})

describe('SessionViewer sliced reads', () => {
  const truncated = { content: 'a\nb\n', size: 200_000, truncated: true, nextOffset: 65_536, offset: 0 }

  it('asks for the next slice at the offset the daemon named, not at the length of the text it decoded', async () => {
    wire.slices[0] = truncated
    wire.slices[65_536] = { content: 'c\n', size: 200_000, truncated: false, nextOffset: 200_000, offset: 65_536 }
    await render()
    expect(text()).toContain('Showing first 64.0 KB of 195.3 KB')
    await pressButton('Load more')
    expect(wire.calls[1]).toEqual({ path: 'src/app/page.tsx', offset: 65_536, sessionId: 'session-1' })
    expect(code()).toBe('a\nb\nc')
    expect(gutter()).toBe('1\n2\n3')
    expect(text()).not.toContain('Showing first')
  })

  it('keeps the slices it has when the next one fails, and offers the read again', async () => {
    wire.slices[0] = truncated
    await render()
    wire.failure = 'network'
    await pressButton('Load more')
    expect(code()).toBe('a\nb')
    expect(text()).toContain("Couldn't load more — the daemon may be offline.")
    expect(button('Retry')).toBeDefined()
  })

  it('refuses to splice two revisions of one file, and offers to read the current one', async () => {
    wire.slices[0] = truncated
    wire.slices[65_536] = {
      content: 'DIFFERENT\n',
      mtime: '2026-08-10T12:00:00.000Z',
      truncated: true,
      nextOffset: 131_072
    }
    await render()
    await pressButton('Load more')
    expect(code()).toBe('a\nb')
    expect(text()).toContain('changed this file while it was loading')
    expect(button('Load more')).toBeUndefined()

    // Reload starts the read over from byte 0 rather than continuing into the new revision.
    wire.slices[0] = { content: 'fresh\n', size: 6 }
    await pressButton('Reload')
    expect(wire.calls.at(-1)).toEqual({ path: 'src/app/page.tsx', sessionId: 'session-1' })
    expect(code()).toBe('fresh')
  })

  it('says the file is partial without offering a read that cannot advance', async () => {
    wire.slices[0] = { content: 'a\n', size: 200_000, truncated: true, nextOffset: 0, offset: 0 }
    await render()
    expect(text()).toContain('Showing part of 195.3 KB')
    expect(button('Load more')).toBeUndefined()
  })
})

describe('SessionViewer mode', () => {
  const diffRows = () => Array.from(container?.querySelectorAll<HTMLElement>('tr[data-diff-kind]') ?? [])
  const kinds = () => diffRows().map((row) => row.dataset.diffKind ?? '')
  const pill = (which: 'diff' | 'file') => container?.querySelector<HTMLElement>(`[data-viewer-mode="${which}"]`)
  const TWO_LINE_DIFF =
    'diff --git a/src/app/page.tsx b/src/app/page.tsx\n--- a/src/app/page.tsx\n+++ b/src/app/page.tsx\n@@ -1,2 +1,2 @@\n const a = 1\n-const b = 2\n+const b = 3\n'

  it('reads the mode param as a closed vocabulary, and anything else as File mode', () => {
    expect(viewerModeFromParam('diff')).toBe('diff')
    expect(viewerModeFromParam('staged')).toBe('staged')
    // A stale or hand-typed value degrades to the read every workspace can answer, rather than to an error.
    expect(viewerModeFromParam(null)).toBe('file')
    expect(viewerModeFromParam('file')).toBe('file')
    expect(viewerModeFromParam('DIFF')).toBe('file')
    expect(viewerModeFromParam('')).toBe('file')
  })

  it('does not strand the read when the reader leaves diff mode and comes back', async () => {
    // The read is one WS round trip plus a git subprocess, so Diff → File → Diff inside that window
    // is one gesture. Cancelling the in-flight answer on cleanup while still remembering the key as
    // asked left the pane on a spinner with no Retry until the scope or path changed.
    wire.diffs.unstaged = { diff: TWO_LINE_DIFF }
    let release: (() => void) | undefined
    const real = vi.mocked(fetchWorkspaceGitDiff).getMockImplementation()!
    vi.mocked(fetchWorkspaceGitDiff).mockImplementationOnce(
      (...args) =>
        new Promise((resolve) => {
          release = () => resolve(real(...args))
        }) as ReturnType<typeof fetchWorkspaceGitDiff>
    )
    await render({ mode: 'diff' })
    await rerender({ mode: 'file' })
    await rerender({ mode: 'diff' })
    await act(async () => {
      release?.()
      await Promise.resolve()
    })
    await rerender({ mode: 'diff' })

    // The answer landed on its own key, so the diff draws — one read, not a second one.
    expect(vi.mocked(fetchWorkspaceGitDiff)).toHaveBeenCalledTimes(1)
    expect(kinds()).toContain('add')
    expect(container?.querySelector('table')).not.toBeNull()
  })

  it('draws the parsed diff, counts what changed, and reports the pill instead of switching itself', async () => {
    wire.diffs.unstaged = { diff: TWO_LINE_DIFF }
    await render({ mode: 'diff' })

    expect(kinds()).toEqual(['hunk', 'context', 'delete', 'add'])
    // The meta slot carries the +/− of the scope on screen, not the file's language and size.
    expect(text()).toContain('+1')
    expect(text()).toContain('−1')
    expect(text()).not.toContain('TypeScript')
    // A pane whose mode lives in the URL cannot switch itself.
    await click('[data-viewer-mode="file"]')
    expect(modeChanges).toEqual(['file'])
    expect(kinds()).toHaveLength(4)
  })

  it('spends no file read on a link that opens straight into Diff mode', async () => {
    wire.diffs.unstaged = { diff: TWO_LINE_DIFF }
    await render({ mode: 'diff' })

    expect(wire.diffCalls).toEqual([{ path: 'src/app/page.tsx', scope: 'unstaged', sessionId: 'session-1' }])
    expect(wire.calls).toEqual([])
    // Toggling to File is when the bytes are read — and switching back does not re-read the diff.
    wire.slices[0] = { content: 'const a = 1\n' }
    await rerender({ mode: 'file' })
    expect(wire.calls).toHaveLength(1)
    await rerender({ mode: 'diff' })
    expect(wire.diffCalls).toHaveLength(1)
    expect(wire.calls).toHaveLength(1)
  })

  it('reads the staged scope separately and offers to go back to the one it came from', async () => {
    wire.diffs.staged = { diff: TWO_LINE_DIFF }
    await render({ mode: 'staged' })

    expect(wire.diffCalls).toEqual([{ path: 'src/app/page.tsx', scope: 'staged', sessionId: 'session-1' }])
    expect(pill('diff')?.getAttribute('title')).toContain('Staged')
    // A reader who arrived from the Staged section and looked at the file gets the STAGED diff back, not the other side of the index.
    await rerender({ mode: 'file' })
    await click('[data-viewer-mode="diff"]')
    expect(modeChanges).toEqual(['staged'])
  })

  it('draws every answer that has no diff to show as data', async () => {
    wire.diffs.unstaged = { isRepo: false }
    await render({ mode: 'diff' })
    expect(text()).toContain('not a git checkout')
    expect(diffRows()).toHaveLength(0)

    wire.diffs.unstaged = { exists: false }
    await rerender({ mode: 'diff', path: 'gone.ts' })
    expect(text()).toContain('neither changes nor a file at that path')

    wire.diffs.unstaged = { binary: true }
    await rerender({ mode: 'diff', path: 'logo.png' })
    expect(text()).toContain('Binary file')

    wire.diffs.unstaged = { diff: null }
    await rerender({ mode: 'diff', path: 'clean.ts' })
    expect(text()).toContain('No unstaged changes to this file')

    wire.diffs.staged = { diff: null }
    await rerender({ mode: 'staged', path: 'clean.ts' })
    expect(text()).toContain('Nothing staged for this file')
  })

  it('says a diff was cut, whether the wire cut it or the viewer did', async () => {
    wire.diffs.unstaged = { diff: TWO_LINE_DIFF, truncated: true }
    await render({ mode: 'diff' })

    expect(container?.querySelector('[data-viewer-diff-truncated]')?.textContent).toContain('too large to send whole')
    // The header says so too, beside the counts, because the counts describe only what arrived.
    expect(text()).toContain('partial')
  })

  it('tells a daemon too old for diffs apart from an offline one, and offers a retry', async () => {
    wire.diffFailure = { status: 409, code: 'DAEMON_FEATURE_MISSING' }
    await render({ mode: 'diff' })
    expect(text()).toContain('cannot read diffs')

    wire.diffFailure = null
    wire.diffs.unstaged = { diff: TWO_LINE_DIFF }
    await pressButton('Retry')
    expect(kinds()).toEqual(['hunk', 'context', 'delete', 'add'])
  })

  it('reads an offline daemon as the offline story rather than a version problem', async () => {
    wire.diffFailure = { status: 503 }
    await render({ mode: 'diff' })
    expect(text()).toContain('may be offline')
  })

  it('withholds the pill from a host that has nowhere to keep the mode', async () => {
    wire.slices[0] = { content: 'x\n' }
    await render({ onModeChange: undefined })
    expect(container?.querySelector('[data-viewer-modes]')).toBeNull()
  })

  it('reads a directory as a folder, not as an empty file', async () => {
    // The daemon answers a directory read with `type:'dir'` and no bytes; before M2 the CP flattened that into a 503.
    wire.slices[0] = { type: 'dir', encoding: null, content: null, size: null }
    await render()
    expect(text()).toContain('a folder, not a file')
    expect(text()).not.toContain('This file is empty')
  })
})

// M3's Stage file / Unstage file (§4). The pane never learns the file's XY status letters, so the SCOPE on screen is what names the direction — and that is exactly what these pin.
describe('SessionViewer staging', () => {
  const HUNK = '@@ -1,1 +1,1 @@\n-old\n+new\n'
  const stageButton = () => container?.querySelector<HTMLButtonElement>('[data-viewer-stage]') ?? undefined

  it('stages the open path from the unstaged diff and re-reads it', async () => {
    wire.diffs.unstaged = { diff: HUNK }
    await render({ mode: 'diff', onIndexChanged: () => (indexChanges += 1) })
    expect(wire.diffCalls).toHaveLength(1)
    expect(stageButton()?.dataset.viewerStage).toBe('stage')
    expect(text()).toContain('Stage file')

    await click('[data-viewer-stage]')

    expect(wire.stageCalls).toEqual([{ kind: 'stage', paths: ['src/app/page.tsx'], sessionId: 'session-1' }])
    // The diff under the reader changed by definition, so it is re-read rather than left describing the tree before the write.
    expect(wire.diffCalls).toHaveLength(2)
    // The fresh status the reply carries has no home in this pane, so the panel that owns the lists is told.
    expect(indexChanges).toBe(1)
  })

  it('unstages when the staged scope is the one on screen', async () => {
    wire.diffs.staged = { diff: HUNK }
    await render({ mode: 'staged', onIndexChanged: () => (indexChanges += 1) })

    expect(stageButton()?.dataset.viewerStage).toBe('unstage')
    expect(text()).toContain('Unstage file')
    await click('[data-viewer-stage]')
    expect(wire.stageCalls).toEqual([{ kind: 'unstage', paths: ['src/app/page.tsx'], sessionId: 'session-1' }])
  })

  it('omits sessionId for the agent’s primary checkout', async () => {
    wire.diffs.unstaged = { diff: HUNK }
    await render({ mode: 'diff', sessionId: undefined, onIndexChanged: () => (indexChanges += 1) })
    await click('[data-viewer-stage]')
    expect(wire.stageCalls).toEqual([{ kind: 'stage', paths: ['src/app/page.tsx'] }])
  })

  it('offers the action for a binary change, which git reports with no text', async () => {
    wire.diffs.unstaged = { diff: null, binary: true }
    await render({ mode: 'diff', onIndexChanged: () => (indexChanges += 1) })
    expect(stageButton()).toBeDefined()
  })

  it('withholds the action where there is nothing to move, or nobody to tell', async () => {
    // File mode: the pane is not showing a side of the index, so it has no direction to name.
    wire.slices[0] = { content: 'const a = 1\n' }
    await render({ mode: 'file', onIndexChanged: () => (indexChanges += 1) })
    expect(stageButton()).toBeUndefined()

    // A path with no changes in this scope: staging it would be a no-op dressed as a control.
    await rerender({ mode: 'diff', onIndexChanged: () => (indexChanges += 1) })
    await settle()
    expect(stageButton()).toBeUndefined()

    // A path this checkout does not have, even though git printed something for it.
    wire.diffs.staged = { diff: HUNK, exists: false }
    await rerender({ mode: 'staged', onIndexChanged: () => (indexChanges += 1) })
    await settle()
    expect(stageButton()).toBeUndefined()
  })

  it('withholds the action from a host that passed no callback — a reader whose role cannot write', async () => {
    wire.diffs.unstaged = { diff: HUNK }
    await render({ mode: 'diff' })
    expect(text()).toContain('new')
    expect(stageButton()).toBeUndefined()
  })

  it('reports a refused write in place and tells its host nothing', async () => {
    wire.diffs.unstaged = { diff: HUNK }
    wire.stageFailure = { status: 409, code: 'WORKSPACE_STALE' }
    await render({ mode: 'diff', onIndexChanged: () => (indexChanges += 1) })

    await click('[data-viewer-stage]')
    expect(container?.querySelector('[data-viewer-stage-error]')?.textContent).toContain(
      'working in this workspace right now'
    )
    // Nothing moved, so nothing downstream is stale and the diff is not re-read.
    expect(indexChanges).toBe(0)
    expect(wire.diffCalls).toHaveLength(1)
  })

  it('re-reads the open diff when the HOST reports a write made elsewhere', async () => {
    wire.diffs.unstaged = { diff: HUNK }
    await render({ mode: 'diff' })
    expect(wire.diffCalls).toHaveLength(1)

    // The Git panel's own toggle moved this path; M2's follow-up recorded that a refresh did NOT reach the viewer, so the write says so explicitly.
    wire.diffs.unstaged = { diff: null }
    await rerender({ mode: 'diff', diffRefreshTick: 1 })
    await settle()

    expect(wire.diffCalls).toHaveLength(2)
    expect(text()).toContain('No unstaged changes to this file')
  })
})
