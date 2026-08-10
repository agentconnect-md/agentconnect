// @vitest-environment happy-dom

// The dock's Git panel: what it reports to its tab, which side of the index each row opens, and what it draws for every degraded answer the git wire can give — an offline daemon, a from-scratch workspace, a clean tree, a capped status, a daemon too old to list commits, and a branch that tracks nothing.
// It is a REVIEW surface in M2, so the absence of stage toggles and of a commit box is asserted here: a control that cannot work must not be drawn disabled either.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wire = vi.hoisted(() => ({
  git: null as unknown,
  primary: null as unknown,
  gitFails: false,
  log: null as unknown,
  logFailure: null as null | { status: number; code?: string },
  logCalls: [] as Array<{ limit?: number; sessionId?: string }>
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
  return {
    ApiError,
    fetchWorkspaceGitStatus: vi.fn((_agentId: string, sessionId?: string) => {
      if (sessionId) return wire.gitFails ? Promise.reject(new Error('offline')) : Promise.resolve(wire.git)
      return Promise.resolve(wire.primary)
    }),
    fetchWorkspaceGitLog: vi.fn((_agentId: string, opts: { limit?: number; sessionId?: string } = {}) => {
      wire.logCalls.push(opts)
      if (wire.logFailure) {
        return Promise.reject(new ApiError('nope', wire.logFailure.status, wire.logFailure.code))
      }
      return Promise.resolve(wire.log)
    })
  }
})

import { GitPanel, gitTabStatus, splitGitSections, type GitPanelVerdict } from './GitPanel'
import { fetchWorkspaceGitLog } from '@/lib/api'
import type { WorkspaceGitFileDto, WorkspaceGitLogDto, WorkspaceGitStatusDto } from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined
let opened: Array<{ path: string; staged: boolean; untracked: boolean }> = []
let verdicts: GitPanelVerdict[] = []

function gitStatus(overrides: Partial<WorkspaceGitStatusDto> = {}): WorkspaceGitStatusDto {
  return {
    isRepo: true,
    clean: true,
    repo: null,
    agentDir: null,
    branch: 'main',
    tracking: null,
    ahead: null,
    behind: null,
    files: [],
    truncated: false,
    lastCommit: null,
    lastFetchAt: null,
    ...overrides
  }
}

function gitLog(overrides: Partial<WorkspaceGitLogDto> = {}): WorkspaceGitLogDto {
  return { isRepo: true, commits: [], truncated: false, tracking: null, ...overrides }
}

function file(
  path: string,
  index: string,
  workingDir: string,
  counts: { additions?: number | null; deletions?: number | null } = {}
): WorkspaceGitFileDto {
  return {
    path,
    index,
    workingDir,
    additions: counts.additions ?? null,
    deletions: counts.deletions ?? null
  }
}

const commit = (over: Partial<WorkspaceGitLogDto['commits'][number]> = {}) => ({
  sha: 'a'.repeat(40),
  shortSha: 'aaaaaaa',
  subject: 'first commit',
  author: 'Agent',
  committedAt: '2026-08-10T10:00:00.000Z',
  pushed: true,
  ...over
})

type PanelProps = Parameters<typeof GitPanel>[0]

function panel(props: Partial<PanelProps> = {}) {
  return (
    <GitPanel
      agentId="agent-a"
      sessionId="session-1"
      onOpenDiff={(path, staged, untracked) => opened.push({ path, staged, untracked })}
      onVerdictChange={(verdict) => verdicts.push(verdict)}
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
const rows = (section: 'staged' | 'changes') =>
  Array.from(container?.querySelectorAll<HTMLElement>(`[data-git-section="${section}"] [data-git-row]`) ?? [])
const rowPaths = (section: 'staged' | 'changes') => rows(section).map((row) => row.dataset.gitRow ?? '')
const commitRows = () => Array.from(container?.querySelectorAll<HTMLElement>('[data-git-commit]') ?? [])

async function click(element: Element | undefined, what: string) {
  expect(element, what).toBeDefined()
  await act(async () => (element as HTMLElement | undefined)?.click())
}

beforeEach(() => {
  wire.git = gitStatus()
  wire.primary = gitStatus()
  wire.gitFails = false
  wire.log = gitLog()
  wire.logFailure = null
  wire.logCalls = []
  opened = []
  verdicts = []
  vi.clearAllMocks()
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = undefined
  root = undefined
})

describe('splitGitSections', () => {
  it('puts a file edited after staging in BOTH sections, as git reports it', () => {
    const both = file('src/a.ts', 'M', 'M')
    const { staged, changes } = splitGitSections([both])
    expect(staged).toEqual([both])
    expect(changes).toEqual([both])
  })

  it('keeps an untracked file out of Staged, whichever column carries the question mark', () => {
    const untracked = file('new.ts', '?', '?')
    expect(splitGitSections([untracked])).toEqual({ staged: [], changes: [untracked] })
    // git's porcelain form for an untracked path is '??'; a normalizer that dropped one half must not promote it.
    expect(splitGitSections([file('new.ts', ' ', '?')])).toEqual({ staged: [], changes: [file('new.ts', ' ', '?')] })
  })

  it('reads a staged-only and an unstaged-only file into one section each', () => {
    const staged = file('s.ts', 'A', ' ')
    const unstaged = file('u.ts', ' ', 'M')
    expect(splitGitSections([staged, unstaged])).toEqual({ staged: [staged], changes: [unstaged] })
  })
})

describe('gitTabStatus', () => {
  it('is loading only until the status has answered, and never empty', () => {
    expect(gitTabStatus(false)).toBe('loading')
    expect(gitTabStatus(true)).toBe('ready')
  })
})

describe('GitPanel', () => {
  it('reports its verdict once the status lands: settled, with the changed-file count for the badge', async () => {
    wire.git = gitStatus({
      clean: false,
      files: [file('a.ts', 'M', ' '), file('b.ts', ' ', 'M'), file('a.ts', 'M', 'M')]
    })
    await render()

    // The last report is the one the tab uses; the count is DISTINCT paths, so a file in both sections is one changed file.
    expect(verdicts.at(-1)).toEqual({ settled: true, changed: 2 })
  })

  it('draws the branch and, only against a real upstream, ahead/behind', async () => {
    wire.primary = gitStatus({ branch: 'work', tracking: 'origin/work', ahead: 3, behind: 1 })
    await render({ sessionId: undefined })
    expect(text()).toContain('work')
    const divergence = container?.querySelector('[data-git-divergence]')
    expect(divergence?.textContent).toBe('31')

    // A branch that tracks nothing has nothing to be ahead OF: `↑0 ↓0` there would read as "in sync with a remote".
    wire.primary = gitStatus({ branch: 'work', tracking: null, ahead: 0, behind: 0 })
    await rerender({ refreshTick: 1, sessionId: undefined })
    expect(container?.querySelector('[data-git-divergence]')).toBeNull()
  })

  it('names the PRIMARY checkout’s branch in session scope, and says the worktree is detached from it', async () => {
    // A session worktree is detached, so its own status carries no branch — the label comes from the unscoped read.
    wire.git = gitStatus({ branch: null })
    wire.primary = gitStatus({ branch: 'main' })
    await render()

    const label = container?.querySelector('[title*="detached"]')
    expect(label?.textContent).toBe('main')
  })

  it('reports an untracked row as untracked, because git prints no diff for one', async () => {
    // `git diff` shows nothing for a path it has never seen, so opening a `??` row in Diff mode
    // says "no unstaged changes" about a file whose entire content is the change.
    wire.git = gitStatus({ clean: false, files: [file('brand-new.ts', '?', '?')] })
    await render()

    expect(rowPaths('changes')).toEqual(['brand-new.ts'])
    await click(rows('changes')[0], 'untracked row')
    expect(opened).toEqual([{ path: 'brand-new.ts', staged: false, untracked: true }])
  })

  it('splits staged from changes, shows each file’s counts, and opens the right side of the index', async () => {
    wire.git = gitStatus({
      clean: false,
      files: [file('src/staged.ts', 'A', ' ', { additions: 128, deletions: 12 }), file('src/edited.ts', ' ', 'M')]
    })
    await render()

    expect(rowPaths('staged')).toEqual(['src/staged.ts'])
    expect(rowPaths('changes')).toEqual(['src/edited.ts'])
    expect(text()).toContain('+128')
    expect(text()).toContain('−12')

    await click(rows('staged')[0], 'staged row')
    await click(rows('changes')[0], 'changes row')
    // The section decides the scope: a staged row must not open the worktree-vs-index diff.
    expect(opened).toEqual([
      { path: 'src/staged.ts', staged: true, untracked: false },
      { path: 'src/edited.ts', staged: false, untracked: false }
    ])
  })

  it('omits counts entirely for an untracked file rather than showing them as zero', async () => {
    wire.git = gitStatus({ clean: false, files: [file('new.ts', '?', '?')] })
    await render()
    expect(rowPaths('changes')).toEqual(['new.ts'])
    expect(text()).not.toContain('+0')
    expect(text()).not.toContain('−0')
  })

  it('marks the row the viewer is holding, on the side it is holding', async () => {
    wire.git = gitStatus({ clean: false, files: [file('src/a.ts', 'M', 'M')] })
    await render({ openPath: 'src/a.ts', openStaged: true })

    const selected = (section: 'staged' | 'changes') =>
      rows(section).filter((row) => row.className.includes('border-r-(--brand)')).length
    expect(selected('staged')).toBe(1)
    // The same path is in both sections; only the scope on screen is marked.
    expect(selected('changes')).toBe(0)
  })

  it('lists commits newest-first and marks the unpushed ones', async () => {
    wire.log = gitLog({
      tracking: 'origin/main',
      commits: [commit({ sha: 'b'.repeat(40), shortSha: 'bbbbbbb', subject: 'wip', pushed: false }), commit()]
    })
    await render()

    expect(commitRows()).toHaveLength(2)
    expect(commitRows()[0]?.textContent).toContain('wip')
    expect(text()).toContain('unpushed')
    // The pushed one carries no marker.
    expect(container?.querySelectorAll('[title^="Not yet on"]')).toHaveLength(1)
    expect(wire.logCalls).toEqual([{ limit: 20, sessionId: 'session-1' }])
  })

  it('draws no unpushed markers for a branch that tracks nothing, and says why', async () => {
    wire.log = gitLog({ tracking: null, commits: [commit({ pushed: false })] })
    await render()

    expect(commitRows()).toHaveLength(1)
    expect(text()).not.toContain('unpushed')
    expect(text()).toContain('tracks no remote branch')
  })

  it('has no stage toggle, no Stage all and no commit box — M2 is a review surface', async () => {
    wire.git = gitStatus({ clean: false, files: [file('a.ts', 'M', 'M')] })
    await render()

    const labels = Array.from(container?.querySelectorAll('button') ?? []).map((b) => b.textContent?.trim() ?? '')
    // Every button in the panel is a file row; nothing offers to stage, unstage or commit — not even disabled.
    expect(labels.some((label) => /stage|commit|push|generate/i.test(label))).toBe(false)
    expect(container?.querySelector('textarea')).toBeNull()
    expect(container?.querySelector('input')).toBeNull()
    expect(text()).toContain('Review only')
  })

  it('draws a from-scratch workspace as data, with no sections and no log', async () => {
    wire.git = gitStatus({ isRepo: false })
    wire.log = gitLog({ isRepo: false })
    await render()

    expect(text()).toContain('not a git checkout')
    expect(rows('staged')).toHaveLength(0)
    expect(container?.querySelector('[data-git-section="commits"]')).toBeNull()
    // Nothing to badge, so the tab gets no count at all rather than a zero.
    expect(verdicts.at(-1)).toEqual({ settled: true, changed: null })
  })

  it('draws an offline daemon as data and still settles its tab', async () => {
    wire.gitFails = true
    await render()

    expect(text()).toContain('daemon may be offline')
    expect(verdicts.at(-1)).toEqual({ settled: true, changed: null })
    expect(container?.querySelector('[data-git-panel]')).not.toBeNull()
  })

  it('draws a clean tree as data', async () => {
    await render()
    expect(text()).toContain('Nothing has changed in this worktree')
  })

  it('says the status list was capped rather than implying the tree is that small', async () => {
    wire.git = gitStatus({ clean: false, truncated: true, files: [file('a.ts', 'M', ' ')] })
    await render()
    expect(text()).toContain('the first 1 are listed')
  })

  it('tells a daemon too old for the log apart from an offline one, keeping the file half', async () => {
    wire.git = gitStatus({ clean: false, files: [file('a.ts', 'M', ' ')] })
    wire.logFailure = { status: 409, code: 'DAEMON_FEATURE_MISSING' }
    await render()

    expect(text()).toContain('cannot list commits')
    expect(text()).not.toContain('may be offline')
    // The status half is unaffected: one read failing does not take the panel down.
    expect(rowPaths('staged')).toEqual(['a.ts'])
  })

  it('falls back to the offline story for a log failure the CP did not name', async () => {
    wire.logFailure = { status: 503 }
    await render()
    expect(text()).toContain('Commits are unavailable')
  })

  it('says no commits yet for a repository with no history', async () => {
    await render()
    expect(text()).toContain('No commits yet')
  })

  it('re-reads both halves on the tab’s refresh action without unmounting the panel', async () => {
    await render()
    expect(fetchWorkspaceGitLog).toHaveBeenCalledTimes(1)
    wire.git = gitStatus({ clean: false, files: [file('late.ts', 'M', ' ')] })
    await rerender({ refreshTick: 1 })

    expect(fetchWorkspaceGitLog).toHaveBeenCalledTimes(2)
    expect(rowPaths('staged')).toEqual(['late.ts'])
    // The tab never un-readies and never loses its badge across a refresh: both are latched per scope.
    expect(verdicts).toEqual([
      { settled: false, changed: null },
      { settled: true, changed: 0 },
      { settled: true, changed: 1 }
    ])
  })
})
