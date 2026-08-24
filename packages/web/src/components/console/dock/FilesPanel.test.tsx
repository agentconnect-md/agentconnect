// @vitest-environment happy-dom

// The dock's Files panel: what it reports to its tab, what it draws for every degraded answer the workspace wire can give, and the two things it must never do — search a server that has no search, or vanish when a read fails.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Entry = { name: string; type: 'dir' | 'file' | 'symlink' | 'other'; size: number | null; mtime: string | null }
type Listing = { entries: Entry[]; exists?: boolean; nextCursor?: string | null }

// Keyed by listing request: a directory path, or `${path}@${cursor}` for a later page. A failure is an HTTP status or 'network' (a rejection with no status, as a dropped connection arrives).
const wire = vi.hoisted(() => ({
  listings: {} as Record<string, Listing>,
  // A status, `'network'`, or a status WITH the CP's machine code — the sleeping-sandbox 503 is only
  // distinguishable from an offline daemon by that code.
  failures: {} as Record<string, number | 'network' | { status: number; code: string }>,
  git: null as unknown,
  primary: null as unknown,
  gitFails: false,
  primaryFails: false,
  // What the wake answers; the panel presses it once when the root read refuses as a sleeping sandbox.
  wake: 'starting' as 'running' | 'starting' | 'unsupported'
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
  const reject = (failure: number | 'network' | { status: number; code: string }) => {
    if (failure === 'network') return Promise.reject(new Error('fetch failed'))
    if (typeof failure === 'number') return Promise.reject(new ApiError(failure))
    return Promise.reject(new ApiError(failure.status, `HTTP ${failure.status}`, failure.code))
  }
  return {
    ApiError,
    fetchWorkspaceFiles: vi.fn((_agentId: string, opts: { path: string; cursor?: string; sessionId?: string }) => {
      const key = opts.cursor ? `${opts.path}@${opts.cursor}` : opts.path
      const failure = wire.failures[key]
      if (failure !== undefined) return reject(failure)
      const listing = wire.listings[key] ?? { entries: [] }
      return Promise.resolve({
        path: opts.path,
        exists: listing.exists ?? true,
        entries: listing.entries,
        nextCursor: listing.nextCursor ?? null
      })
    }),
    fetchWorkspaceGitStatus: vi.fn((_agentId: string, sessionId?: string) => {
      if (sessionId) return wire.gitFails ? Promise.reject(new Error('offline')) : Promise.resolve(wire.git)
      return wire.primaryFails ? Promise.reject(new Error('offline')) : Promise.resolve(wire.primary)
    }),
    wakeAgent: vi.fn(() => Promise.resolve({ state: wire.wake }))
  }
})

import { FilesPanel, filesTabStatus } from './FilesPanel'
import { DOCK_POLL_MS } from './auto-refresh'
import { SessionDock, type DockTab } from './SessionDock'
import { fetchWorkspaceFiles, fetchWorkspaceGitStatus, wakeAgent } from '@/lib/api'
import type { WorkspaceGitFileDto, WorkspaceGitStatusDto } from '@/lib/api'

vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ orgPath: (path: string) => path, activeOrg: { id: 'org-1' } })
}))

// The dock reads the shell's mobile action slot; mounting the real Shell would pull the whole console — and every platform module's api — behind the mocked `@/lib/api`.
vi.mock('@/components/console/Shell', () => ({
  useMobileActionSlot: () => ({ action: null, register: () => {} })
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined
let opened: string[] = []
let settledReports: boolean[] = []

function gitStatus(overrides: Partial<WorkspaceGitStatusDto> = {}): WorkspaceGitStatusDto {
  return {
    isRepo: true,
    clean: true,
    repo: null,
    agentDir: null,
    branch: 'main',
    tracking: null,
    ahead: 0,
    behind: 0,
    files: [],
    truncated: false,
    lastCommit: null,
    lastFetchAt: null,
    ...overrides
  }
}

const changed = (path: string, index: string, workingDir: string): WorkspaceGitFileDto => ({
  path,
  index,
  workingDir,
  additions: null,
  deletions: null
})

const dir = (name: string): Entry => ({ name, type: 'dir', size: null, mtime: null })
const textFile = (name: string): Entry => ({ name, type: 'file', size: 120, mtime: '2026-08-10T11:00:00.000Z' })

type PanelProps = Parameters<typeof FilesPanel>[0]

function panel(props: Partial<PanelProps> = {}) {
  return (
    <FilesPanel
      agentId="agent-a"
      sessionId="session-1"
      workdir="/ws/agent-a"
      onOpenFile={(path) => opened.push(path)}
      onRootSettledChange={(settled) => settledReports.push(settled)}
      {...props}
    />
  )
}

async function render(props: Partial<PanelProps> = {}) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(panel(props))
    await Promise.resolve()
  })
}

async function rerender(props: Partial<PanelProps> = {}) {
  await act(async () => {
    root?.render(panel(props))
    await Promise.resolve()
  })
}

const text = () => container?.textContent ?? ''

// A row is the one element carrying FileBrowserRow's selected-edge border, which nothing else in the panel has — matching on 'the first mono span inside any div' picks up the scroller.
const ROW = '[class*="border-r-2"]'
const rows = () => Array.from(container?.querySelectorAll<HTMLElement>(ROW) ?? [])
const rowName = (element: Element) => element.querySelector('span.mono')?.textContent ?? ''

/** Every row the tree drew, by the name in its mono cell — the reader's own index into the panel. */
const rowNames = (): string[] => rows().map(rowName).filter(Boolean)

const row = (name: string): HTMLElement | undefined => rows().find((candidate) => rowName(candidate) === name)

async function click(element: Element | undefined, what: string) {
  expect(element, what).toBeDefined()
  await act(async () => (element as HTMLElement | undefined)?.click())
}

async function clickText(label: string) {
  const button = Array.from(container?.querySelectorAll('button') ?? []).find(
    (candidate) => candidate.textContent?.trim() === label
  )
  await click(button, `${label} button`)
}

async function type(value: string) {
  const input = container?.querySelector('input')
  expect(input, 'filter input').toBeDefined()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input?.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** The git tags on the rows, as the letters a reader sees, with the title that names each. */
function badges(): Array<{ ch: string; title: string }> {
  return Array.from(container?.querySelectorAll<HTMLElement>('span[title$="(uncommitted)"]') ?? []).map((badge) => ({
    ch: badge.textContent ?? '',
    title: badge.getAttribute('title') ?? ''
  }))
}

beforeEach(() => {
  wire.listings = { '': { entries: [dir('src'), textFile('README.md')] } }
  wire.failures = {}
  wire.git = gitStatus()
  wire.primary = gitStatus()
  wire.gitFails = false
  wire.primaryFails = false
  wire.wake = 'starting'
  opened = []
  settledReports = []
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  container = undefined
  root = undefined
  vi.mocked(fetchWorkspaceFiles).mockClear()
  vi.mocked(fetchWorkspaceGitStatus).mockClear()
  vi.mocked(wakeAgent).mockClear()
  // The polling case installs fake timers; leaving them installed would starve the next test's reads.
  vi.useRealTimers()
})

describe('filesTabStatus', () => {
  it('is loading only until the first root listing has answered', () => {
    expect(filesTabStatus(false)).toBe('loading')
    expect(filesTabStatus(true)).toBe('ready')
  })

  it('never says empty, whatever the root turned out to be', () => {
    // A workspace with no files still draws a branch line, a filter and the notice explaining the emptiness; `empty` would replace all of it with the dock's "Nothing to show", and — since `vacant` is every tab non-ready — a settled-empty Sessions tab beside it would take the dock's whole chrome away, leaving no way to open Files at all.
    expect([filesTabStatus(false), filesTabStatus(true)]).not.toContain('empty')
  })
})

describe('FilesPanel tab status', () => {
  it('reports the first listing as unsettled and draws nothing until it lands', async () => {
    let land: ((listing: unknown) => void) | undefined
    vi.mocked(fetchWorkspaceFiles).mockImplementationOnce(
      () => new Promise((resolve) => (land = resolve as (listing: unknown) => void))
    )
    await render()

    // The dock owns the wait (its `loading` placeholder), and a panel that drew its own header underneath would double it.
    expect(settledReports).toEqual([false])
    expect(container?.querySelector('input')).toBeNull()
    expect(text()).toBe('')

    await act(async () => {
      land?.({ path: '', exists: true, entries: [textFile('README.md')], nextCursor: null })
      await Promise.resolve()
    })
    expect(settledReports).toEqual([false, true])
    expect(container?.querySelector('input')?.getAttribute('placeholder')).toBe('Find file by path…')
  })

  it('reports ready for a root that failed, because a notice is content', async () => {
    wire.failures = { '': 'network' }
    await render()

    expect(settledReports.at(-1)).toBe(true)
    expect(text()).toContain('the owning daemon may be offline')
  })

  it('stays ready and keeps the reader’s filter across a refresh', async () => {
    wire.listings = { '': { entries: [textFile('README.md'), textFile('notes.txt')] } }
    await render()
    await type('read')
    expect(text()).toContain('Matched 1 of 2 loaded files')

    await rerender({ refreshTick: 1 })

    // The refresh re-reads the tree; the latch means the tab never drops back to `loading`, so the panel — and the query in it — is never torn off screen.
    expect(settledReports).toEqual([false, true])
    expect(container?.querySelector('input')?.value).toBe('read')
    expect(vi.mocked(fetchWorkspaceFiles).mock.calls.filter((call) => call[1].path === '').length).toBe(2)
  })

  it('re-arms for another session, whose tree is a different set of paths', async () => {
    await render()
    expect(settledReports).toEqual([false, true])

    await rerender({ sessionId: 'session-2' })

    // Scope change: unsettled again (the dock shows its spinner), then ready — and the filter does not carry over.
    expect(settledReports).toEqual([false, true, false, true])
    expect(container?.querySelector('input')?.value).toBe('')
  })
})

describe('FilesPanel inside the dock', () => {
  const FILES_TAB: DockTab = {
    key: 'files',
    label: 'Files',
    icon: 'folder-tree',
    actionIcon: 'refresh-cw',
    actionLabel: 'Refresh files'
  }
  const SESSIONS_TAB: DockTab = { key: 'sessions', label: 'Sessions', icon: 'messages-square' }

  it('draws nothing beside the dock placeholder while its own tab is loading', () => {
    // The dock renders the placeholder IN ADDITION to the body (SessionDock.tsx:510-522), so the panel must be the one that stays quiet. Reachable only with another tab ready: with Files alone the dock is `vacant` and withholds even the placeholder.
    const markup = renderToStaticMarkup(
      <SessionDock tabs={[SESSIONS_TAB, { ...FILES_TAB, status: 'loading' }]} activeKey="files" onTabChange={() => {}}>
        {() => panel()}
      </SessionDock>
    )

    expect(markup).toContain('data-dock-loading')
    expect(markup).not.toContain('Find file by path')
    // And the panel changes no dock geometry: the reserved track keeps the width the pre-paint script published.
    expect(markup).toContain('w-[var(--dock-width)]')
    expect(markup).toContain('wide:block')
  })

  it('offers the refresh action on the tab, not inside the panel', async () => {
    // The dock owns the per-tab action; a second refresh control in the body would be two answers to one question.
    const markup = renderToStaticMarkup(
      <SessionDock tabs={[FILES_TAB]} activeKey="files" onTabChange={() => {}}>
        {() => panel()}
      </SessionDock>
    )

    expect(markup).toContain('aria-label="Refresh files"')
    await render()
    expect(text()).not.toContain('Refresh')
  })
})

describe('FilesPanel tree', () => {
  it('lists the root and expands a folder on demand', async () => {
    wire.listings = {
      '': { entries: [dir('src'), textFile('README.md')] },
      src: { entries: [textFile('index.ts')] }
    }
    await render()

    expect(rowNames()).toEqual(['src', 'README.md'])
    // Nothing is fetched for a folder until it is opened — the tree is lazy per directory.
    expect(vi.mocked(fetchWorkspaceFiles).mock.calls.map((call) => call[1].path)).toEqual([''])

    await click(row('src'), 'src folder row')

    expect(rowNames()).toEqual(['src', 'index.ts', 'README.md'])
    expect(vi.mocked(fetchWorkspaceFiles).mock.calls.map((call) => call[1].path)).toEqual(['', 'src'])
    // Depth is drawn as indent, and a child sits one level in.
    expect(row('index.ts')?.getAttribute('style')).toContain('padding-left: 22px')
    expect(row('src')?.getAttribute('style')).toContain('padding-left: 8px')
  })

  it('drops a subtree whose folder is gone, and keeps the ones that are not', async () => {
    // PREMISE CHANGED with the dock's refresh cadence: a refresh no longer collapses the tree — on a
    // timer that would close the reader's folders every few seconds — so what protects against a stale
    // subtree is the root re-read plus a re-read of each OPEN folder, not a reset. A directory that has
    // since been deleted is no longer in the root listing, so it draws nothing either way.
    wire.listings = {
      '': { entries: [dir('src'), dir('gone'), textFile('README.md')] },
      src: { entries: [textFile('index.ts')] },
      gone: { entries: [textFile('old.ts')] }
    }
    await render()
    await click(row('src'), 'src folder row')
    await click(row('gone'), 'gone folder row')
    expect(rowNames()).toEqual(['src', 'index.ts', 'gone', 'old.ts', 'README.md'])

    wire.listings[''] = { entries: [dir('src'), textFile('README.md')] }
    await rerender({ refreshTick: 1 })

    expect(rowNames()).toEqual(['src', 'index.ts', 'README.md'])
  })

  it('keeps its rows on screen while a refresh is in flight, then replaces them', async () => {
    // PREMISE CHANGED with the dock's refresh cadence: M-era refreshes were presses, so emptying the
    // tree for the round trip was defensible. On a 15s timer it is a flicker — and a spinner that
    // replaced the rows every few seconds would be one too — so an in-flight refresh is SILENT: the
    // rows stand until the new listing lands. The tab stays `ready` throughout, as it already did.
    await render()
    let land: ((listing: unknown) => void) | undefined
    vi.mocked(fetchWorkspaceFiles).mockImplementationOnce(
      () => new Promise((resolve) => (land = resolve as (listing: unknown) => void))
    )

    await rerender({ refreshTick: 1 })

    expect(rowNames()).toEqual(['src', 'README.md'])
    expect(container?.querySelector('svg[aria-label="Loading"]')).toBeNull()
    expect(container?.querySelector('input')).not.toBeNull()

    await act(async () => {
      land?.({ path: '', exists: true, entries: [textFile('fresh.ts')], nextCursor: null })
      await Promise.resolve()
    })
    expect(rowNames()).toEqual(['fresh.ts'])
  })

  it('re-reads an OPEN folder on a refresh, without closing it and without serving its old listing', async () => {
    // The cache must not put back a file the agent has since renamed — but the expand set is the
    // reader's own state, and a refresh that closed their folders would be unusable on a timer. So the
    // open folder is re-read in place: one more request, same expansion, fresh rows, no click needed.
    wire.listings = { '': { entries: [dir('src')] }, src: { entries: [textFile('old.ts')] } }
    await render()
    await click(row('src'), 'src folder row')
    expect(rowNames()).toEqual(['src', 'old.ts'])

    wire.listings.src = { entries: [textFile('new.ts')] }
    await rerender({ refreshTick: 1 })

    expect(rowNames()).toEqual(['src', 'new.ts'])
    expect(vi.mocked(fetchWorkspaceFiles).mock.calls.filter((call) => call[1].path === 'src').length).toBe(2)
  })

  it('keeps a collapsed folder’s listing, so re-opening it costs no round trip', async () => {
    wire.listings = { '': { entries: [dir('src')] }, src: { entries: [textFile('index.ts')] } }
    await render()

    await click(row('src'), 'src folder row')
    await click(row('src'), 'src folder row')
    expect(rowNames()).toEqual(['src'])
    await click(row('src'), 'src folder row')

    expect(rowNames()).toEqual(['src', 'index.ts'])
    expect(vi.mocked(fetchWorkspaceFiles).mock.calls.filter((call) => call[1].path === 'src').length).toBe(1)
  })

  it('opens a file by its full path, not its name', async () => {
    wire.listings = { '': { entries: [dir('src')] }, src: { entries: [textFile('index.ts')] } }
    await render()
    await click(row('src'), 'src folder row')

    await click(row('index.ts'), 'index.ts row')

    expect(opened).toEqual(['src/index.ts'])
  })

  it('marks the row the viewer is holding', async () => {
    await render({ openFilePath: 'README.md' })

    expect(row('README.md')?.getAttribute('aria-current')).toBe('page')
    expect(row('README.md')?.className).toContain('bg-(--brand-soft)')
  })

  it('does not offer to open a row that is not a file', async () => {
    wire.listings = { '': { entries: [{ name: 'sock', type: 'other', size: null, mtime: null }] } }
    await render()

    const sock = row('sock')
    expect(sock?.tagName).toBe('DIV')
    await click(sock, 'sock row')
    expect(opened).toEqual([])
  })

  it('pages a long directory with the cursor the daemon handed back', async () => {
    wire.listings = {
      '': { entries: [textFile('a.ts')], nextCursor: '1' },
      '@1': { entries: [textFile('b.ts')], nextCursor: null }
    }
    await render()

    expect(rowNames()).toEqual(['a.ts'])
    await clickText('Load more')

    expect(rowNames()).toEqual(['a.ts', 'b.ts'])
    expect(text()).not.toContain('Load more')
  })

  it('keeps the loaded page when the next one fails', async () => {
    wire.listings = { '': { entries: [textFile('a.ts')], nextCursor: '1' } }
    wire.failures = { '@1': 'network' }
    await render()

    await clickText('Load more')

    // `moreErr` is separate from `err` precisely so an append failure does not take the rows already on screen.
    expect(rowNames()).toEqual(['a.ts'])
    expect(text()).toContain('Retry')
  })

  it('reports a failed subdirectory at its own depth and keeps the rest of the tree', async () => {
    wire.listings = { '': { entries: [dir('src'), textFile('README.md')] } }
    wire.failures = { src: 'network' }
    await render()

    await click(row('src'), 'src folder row')

    expect(text()).toContain("Couldn't load — the daemon may be offline.")
    expect(rowNames()).toEqual(['src', 'README.md'])
  })
})

describe('FilesPanel session scope', () => {
  it('reads the session’s worktree, for the tree and for the status', async () => {
    await render()

    expect(vi.mocked(fetchWorkspaceFiles).mock.calls[0]?.[1]).toMatchObject({ path: '', sessionId: 'session-1' })
    expect(vi.mocked(fetchWorkspaceGitStatus).mock.calls).toEqual([
      // No repo scope: the dock's panel always reads the agent's own workspace.
      ['agent-a', 'session-1', undefined],
      // The second, sessionless read is the branch label: a session worktree sits on its own branch, so its status names that one instead of the base checkout's.
      ['agent-a', undefined, undefined]
    ])
  })

  it('discards a directory reply that belongs to the checkout it has left', async () => {
    // The panel SURVIVES a scope change, so an in-flight subdirectory read is not cancelled by anything. Without a generation fence its entries land in the NEW scope's cache — and because `dirs['src']` is then populated, expanding `src` there skips the fetch that would have corrected it, so the wrong worktree's listing simply stays.
    const reply = (path: string, entries: Entry[]) => ({ path, exists: true, entries, nextCursor: null })
    let releaseStale: (() => void) | undefined
    wire.listings = { '': { entries: [dir('src')] } }
    await render()
    // Hold session-1's `src` open, then leave for session-2 before it answers.
    vi.mocked(fetchWorkspaceFiles).mockImplementationOnce(
      () => new Promise((resolve) => (releaseStale = () => resolve(reply('src', [textFile('from-session-1.ts')]))))
    )
    await click(row('src'), 'src folder row')

    wire.listings = { '': { entries: [dir('src')] }, src: { entries: [textFile('from-session-2.ts')] } }
    await rerender({ sessionId: 'session-2' })
    await act(async () => {
      releaseStale?.()
      await Promise.resolve()
    })

    // session-1's file never appears, and `src` is still unexpanded in session-2 — so opening it fetches session-2's listing rather than reading a poisoned cache.
    expect(text()).not.toContain('from-session-1.ts')
    await click(row('src'), 'src folder row in session-2')
    expect(rowNames()).toEqual(['src', 'from-session-2.ts'])
  })

  it('scopes EVERY listing, not just the root one', async () => {
    // The root read is the easy one. A subdirectory expansion and a cursor page are separate call sites, and either dropping the id would silently read the agent's primary checkout while every other assertion here still passed.
    wire.listings = {
      '': { entries: [dir('src'), textFile('a.ts')], nextCursor: '1' },
      '@1': { entries: [textFile('b.ts')], nextCursor: null },
      src: { entries: [textFile('index.ts')] }
    }
    await render()
    await click(row('src'), 'src folder row')
    await clickText('Load more')

    const calls = vi.mocked(fetchWorkspaceFiles).mock.calls
    // Root, the subdirectory, and the cursor page — all three reached, and all three scoped.
    expect(calls.map((call) => call[1].path)).toEqual(expect.arrayContaining(['', 'src']))
    expect(calls.some((call) => call[1].cursor === '1')).toBe(true)
    expect(calls.map((call) => call[1].sessionId)).toEqual(calls.map(() => 'session-1'))
  })

  it('reads the primary checkout when no session is given', async () => {
    await render({ sessionId: undefined })

    expect(vi.mocked(fetchWorkspaceFiles).mock.calls[0]?.[1]).not.toHaveProperty('sessionId')
    expect(vi.mocked(fetchWorkspaceGitStatus).mock.calls).toEqual([['agent-a', undefined, undefined]])
  })

  it('shows the primary branch beside the workdir, and says whose branch it is', async () => {
    // The worktree's own `branch` is a detached HEAD, so drawing it would name a branch this tree is not on.
    wire.git = gitStatus({ branch: 'HEAD' })
    wire.primary = gitStatus({ branch: 'release/2.1' })
    await render()

    expect(text()).toContain('release/2.1')
    expect(text()).not.toContain('HEAD')
    expect(container?.innerHTML).toContain("this session's worktree is detached from it")
    expect(text()).toContain('/ws/agent-a')
  })

  it('shows the checkout’s own branch outside session scope', async () => {
    wire.primary = gitStatus({ branch: 'main' })
    await render({ sessionId: undefined })

    expect(text()).toContain('main')
    expect(container?.innerHTML).toContain('Current branch of the workspace checkout')
  })
})

describe('FilesPanel git tags', () => {
  it('tags changed files and leaves their folder alone', async () => {
    wire.listings = { '': { entries: [dir('src'), textFile('README.md')] }, src: { entries: [textFile('index.ts')] } }
    wire.git = gitStatus({ clean: false, files: [changed('src/index.ts', ' ', 'M')] })
    await render()
    await click(row('src'), 'src folder row')

    expect(badges()).toEqual([{ ch: 'M', title: 'Modified (uncommitted)' }])
    expect(row('src')?.querySelector('span[title$="(uncommitted)"]')).toBeNull()
  })

  it('tags a staged-then-edited file with its staged letter', async () => {
    // 'AM' is one path in two states; the badge is one letter, and it is the index half.
    wire.listings = { '': { entries: [textFile('added.ts'), textFile('fresh.ts')] } }
    wire.git = gitStatus({
      clean: false,
      files: [changed('added.ts', 'A', 'M'), changed('fresh.ts', '?', '?')]
    })
    await render()

    expect(badges()).toEqual([
      { ch: 'A', title: 'Added (uncommitted)' },
      { ch: 'U', title: 'Untracked (uncommitted)' }
    ])
  })

  it('says how far the tags reach when the status list was capped', async () => {
    wire.git = gitStatus({ clean: false, truncated: true, files: [changed('README.md', 'M', ' ')] })
    await render()

    // The daemon caps its file list at 500, so an uncapped reading of `files.length` would quietly under-tag a big working tree.
    expect(text()).toContain('status tags cover the first 1 changed files')
  })
})

describe('FilesPanel path filter', () => {
  beforeEach(() => {
    wire.listings = {
      '': { entries: [dir('src'), dir('docs'), textFile('README.md')] },
      src: { entries: [textFile('index.ts'), textFile('reader.ts')] },
      docs: { entries: [textFile('guide.md')] }
    }
  })

  it('filters the loaded tree and says that is what it filtered', async () => {
    await render()
    await click(row('src'), 'src folder row')

    await type('reader')

    // Full paths, flat, and a label that does not let the reader believe a repository was searched.
    expect(rowNames()).toEqual(['src/reader.ts'])
    expect(text()).toContain('Matched 1 of 3 loaded files')
    expect(text()).toContain('not the whole repository')
  })

  it('never asks the server, because there is no path-search route', async () => {
    await render()
    const before = vi.mocked(fetchWorkspaceFiles).mock.calls.length

    await type('guide')

    expect(vi.mocked(fetchWorkspaceFiles).mock.calls.length).toBe(before)
    // 'docs' was never opened, so its file is not in the corpus — the honest consequence the label warns about.
    expect(rowNames()).toEqual([])
    expect(text()).toContain('No loaded file path contains “guide”')
    expect(text()).toContain('Open more folders')
  })

  it('opens a filtered row by its full path', async () => {
    await render()
    await click(row('src'), 'src folder row')
    await type('index')

    await click(row('src/index.ts'), 'filtered row')

    expect(opened).toEqual(['src/index.ts'])
  })

  it('carries the git tag onto the filtered row', async () => {
    wire.git = gitStatus({ clean: false, files: [changed('src/index.ts', 'M', ' ')] })
    await render()
    await click(row('src'), 'src folder row')

    await type('index')

    expect(badges()).toEqual([{ ch: 'M', title: 'Modified (uncommitted)' }])
  })

  it('shows the tree again when the filter is cleared', async () => {
    await render()
    await type('read')
    await type('')

    expect(rowNames()).toEqual(['src', 'docs', 'README.md'])
    expect(text()).not.toContain('loaded files')
  })
})

describe('FilesPanel degraded states', () => {
  it('tells a sleeping sandbox apart from an offline daemon, though both are 503', async () => {
    // The wrong answer this replaces was not a notice at all: the daemon listed its OWN empty
    // directory, so the panel drew a workspace with no files in it. Now it is a 503 — the same status
    // an offline daemon sends — and only the code says the files are fine and coming back.
    wire.failures = { '': { status: 503, code: 'WORKSPACE_SANDBOX_UNAVAILABLE' } }
    wire.gitFails = true
    wire.wake = 'unsupported'
    await render()

    // The refusal pressed the wake once; a daemon with nothing to wake leaves the terminal copy, without Start.
    expect(vi.mocked(wakeAgent)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(wakeAgent)).toHaveBeenCalledWith('agent-a')
    expect(text()).toContain('its pod is not running')
    expect(text()).not.toContain('the owning daemon may be offline')
    expect(text()).not.toContain('Start')
    // A notice is content, so the tab still settles rather than spinning forever.
    expect(settledReports.at(-1)).toBe(true)
  })

  it('wakes a sleeping sandbox and says so calmly while the read is polled — never an error', async () => {
    wire.failures = { '': { status: 503, code: 'WORKSPACE_SANDBOX_UNAVAILABLE' } }
    wire.gitFails = true
    wire.wake = 'starting'
    await render()

    expect(vi.mocked(wakeAgent)).toHaveBeenCalledTimes(1)
    expect(text()).toContain('Starting the agent’s sandbox')
    expect(text()).not.toContain('its pod is not running')
    expect(settledReports.at(-1)).toBe(true)
  })

  it('a hidden Files tab never presses the wake; selecting it presses once', async () => {
    // The dock keeps every panel mounted, so opening a session page must not start a pod on its own.
    wire.failures = { '': { status: 503, code: 'WORKSPACE_SANDBOX_UNAVAILABLE' } }
    wire.gitFails = true
    await render({ active: false })
    expect(vi.mocked(wakeAgent)).not.toHaveBeenCalled()
    expect(text()).toContain('its pod is not running')

    await rerender({ active: true })
    expect(vi.mocked(wakeAgent)).toHaveBeenCalledTimes(1)
    expect(text()).toContain('Starting the agent’s sandbox')
    await rerender({ active: false })
    await rerender({ active: true })
    expect(vi.mocked(wakeAgent)).toHaveBeenCalledTimes(1)
  })

  it('does not press the wake for an offline daemon — only the sleeping-sandbox code earns one', async () => {
    wire.failures = { '': 503 }
    await render()

    expect(vi.mocked(wakeAgent)).not.toHaveBeenCalled()
    expect(text()).not.toContain('Start')
  })

  it('explains an offline daemon rather than throwing', async () => {
    wire.failures = { '': 503 }
    await render()

    expect(text()).toContain('the owning daemon may be offline')
    // Still a panel: the header the reader navigates with survives the failure.
    expect(container?.querySelector('input')).not.toBeNull()
  })

  it('explains a daemon too old for session worktrees, and does not blame the network', async () => {
    // The CP's 409 is `workspace-session-read-v1` missing, which the offline copy would misdescribe.
    wire.failures = { '': 409 }
    await render()

    expect(text()).toContain('cannot browse a session worktree')
    expect(text()).not.toContain('may be offline')
  })

  it('explains a worktree the session does not have', async () => {
    wire.failures = { '': 404 }
    await render()

    expect(text()).toContain('may have been cleaned up')
    expect(text()).not.toContain('may be offline')
  })

  it('explains a listing that reports the session worktree missing, without inventing why', async () => {
    wire.listings = { '': { entries: [], exists: false } }
    await render()

    expect(text()).toContain('No checkout for this session')
    expect(text()).toContain('may not have one of its own')
  })

  it('explains a primary workspace that has no files yet', async () => {
    wire.listings = { '': { entries: [], exists: false } }
    await render({ sessionId: undefined })

    expect(text()).toContain('the agent creates them as it works')
  })

  it('says an empty workspace is empty', async () => {
    wire.listings = { '': { entries: [] } }
    await render()

    expect(text()).toContain('This workspace is empty.')
  })

  it('says a scratch workspace has no git checkout', async () => {
    wire.git = gitStatus({ isRepo: false, branch: null })
    wire.primary = gitStatus({ isRepo: false, branch: null })
    await render()

    expect(text()).toContain('Not a git checkout')
    expect(badges()).toEqual([])
    // The tree is unaffected: git status is not what makes a workspace browsable.
    expect(rowNames()).toEqual(['src', 'README.md'])
  })

  it('keeps a failed git status apart from a workspace that has no git', async () => {
    // Both leave the status null, and a reader told "not a git checkout" about a repo would go looking for the wrong problem.
    wire.gitFails = true
    await render()

    expect(text()).toContain('Git status unavailable')
    expect(text()).not.toContain('Not a git checkout')
    expect(rowNames()).toEqual(['src', 'README.md'])
  })
})

describe('FilesPanel footer', () => {
  it('shows when the checkout last fetched', async () => {
    wire.git = gitStatus({ lastFetchAt: new Date(Date.now() - 120_000).toISOString() })
    await render()

    expect(container?.querySelector('[data-files-footer]')?.textContent).toBe('synced 2m ago')
    // Dropped on purpose: a file count and a total size would each need a daemon-side walk of the whole tree.
    expect(text()).not.toContain('files ·')
  })

  it('keeps a non-repo workspace out of the footer whatever its status carried', async () => {
    // Defensive: the daemon computes `lastFetchAt` only on the isRepo branch, and a workspace with no checkout has no remote it could have synced with.
    wire.git = gitStatus({ isRepo: false, branch: null, lastFetchAt: new Date().toISOString() })
    wire.primary = gitStatus({ isRepo: false, branch: null })
    await render()

    expect(container?.querySelector('[data-files-footer]')).toBeNull()
    expect(text()).toContain('Not a git checkout')
  })

  it('drops the clause when there is no fetch time, which is every session worktree', async () => {
    // A linked worktree's `.git` is a FILE, so `.git/FETCH_HEAD` cannot be stat'd and the daemon always answers null here.
    wire.git = gitStatus({ lastFetchAt: null })
    await render()

    expect(text()).not.toContain('synced')
    // Not an empty bordered strip either: the footer is absent, not blank.
    expect(container?.querySelector('[data-files-footer]')).toBeNull()
  })
})

// The dock's refresh cadence, wired here. This tab carries no badge, so a hidden panel OWES itself the
// read a turn earned and spends it on the reveal edge — re-reading a tree nobody is looking at is the
// one thing this cadence must not do. The hook itself is `auto-refresh.test.tsx`'s subject.
describe('FilesPanel auto refresh', () => {
  const rootReads = () => vi.mocked(fetchWorkspaceFiles).mock.calls.filter((call) => call[1].path === '').length

  it('re-reads the tree when a turn settles while the tab is on screen', async () => {
    await render({ active: true })
    expect(rootReads()).toBe(1)

    await rerender({ active: true, turnActive: true })
    expect(rootReads()).toBe(1)
    await rerender({ active: true, turnActive: false })
    expect(rootReads()).toBe(2)
  })

  it('defers a hidden tab’s turn read to the moment the reader opens it', async () => {
    await render({ active: false })
    expect(rootReads()).toBe(1)

    await rerender({ active: false, turnActive: true })
    await rerender({ active: false, turnActive: false })
    expect(rootReads()).toBe(1)

    await rerender({ active: true, turnActive: false })
    expect(rootReads()).toBe(2)
  })

  it('keeps the open folders — and the filter’s corpus — across an automatic re-read', async () => {
    // A refresh that collapsed the tree back to root would, on a timer, also shrink the path filter's
    // corpus to root-level hits every few seconds. A refresh re-reads the root AND each open folder.
    wire.listings = {
      '': { entries: [dir('src'), textFile('README.md')] },
      src: { entries: [textFile('deep.ts')] }
    }
    await render({ active: true })
    await click(row('src'), 'src folder row')
    expect(text()).toContain('deep.ts')
    await type('deep')
    expect(text()).toContain('Matched 1 of 2 loaded files')

    await rerender({ active: true, turnActive: true })
    await rerender({ active: true, turnActive: false })

    // Both reads went out again — the root and the open folder — and neither the expansion nor the
    // filter's reach went with them.
    expect(rootReads()).toBe(2)
    expect(vi.mocked(fetchWorkspaceFiles).mock.calls.filter((call) => call[1].path === 'src').length).toBe(2)
    expect(text()).toContain('deep.ts')
    expect(text()).toContain('Matched 1 of 2 loaded files')
  })

  it('keeps polling behind another tab — the open PAGE is what stays fresh, not one tab', async () => {
    // The workspace read continues whatever tab is selected: the operator left the page open, and the
    // same reads are what tell the daemon whether this session's sandbox is worth holding. Document
    // visibility remains the fence, and `auto-refresh.test.tsx` pins that half.
    vi.useFakeTimers()
    await render({ active: true })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOCK_POLL_MS)
    })
    expect(rootReads()).toBe(2)

    await rerender({ active: false })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOCK_POLL_MS * 2)
    })
    // The count, not the exact number of ticks: what matters is that a hidden tab keeps reading.
    expect(rootReads()).toBeGreaterThan(2)
  })
})
