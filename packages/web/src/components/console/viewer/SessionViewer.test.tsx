// @vitest-environment happy-dom

// The left-pane file viewer: what it draws for every answer `workspace/read` can give, and the two things a sliced read must never get wrong — trusting its own byte arithmetic over the daemon's, or splicing two revisions of one file together.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Slice = {
  exists?: boolean
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
  hold: null as null | Array<(value?: unknown) => void>
}))

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message = `HTTP ${status}`
    ) {
      super(message)
    }
  }
  return {
    ApiError,
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

import { SessionViewer } from './SessionViewer'
import { fetchWorkspaceFile } from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined
let closed = 0

type ViewerProps = Parameters<typeof SessionViewer>[0]

function viewer(props: Partial<ViewerProps> = {}) {
  return (
    <SessionViewer
      agentId="agent-a"
      sessionId="session-1"
      path="src/app/page.tsx"
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
  hl.fail = false
  closed = 0
  vi.mocked(fetchWorkspaceFile).mockClear()
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
    expect(text()).not.toContain('cannot read a session worktree')
    expect(text()).not.toContain('not available to read')
  })

  it('tells a daemon too old for worktree reads apart from an offline one', async () => {
    wire.failure = 409
    await render()
    expect(text()).toContain('cannot read a session worktree')
    expect(text()).not.toContain('may be offline')
  })

  it('says whose worktree is missing when the scope itself is refused', async () => {
    wire.failure = 404
    await render()
    expect(text()).toContain("This session's worktree is not available to read")

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
