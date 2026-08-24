// @vitest-environment happy-dom

// The dock's Git panel: what it reports to its tab, which side of the index each row opens, and what it draws for every degraded answer the git wire can give — an offline daemon, a from-scratch workspace, a clean tree, a capped status, a daemon too old to list commits, and a branch that tracks nothing. Since M3 it also writes: the per-row toggles, Stage all / Unstage all, and what the panel does with the fresh status a write answers with.
// PREMISE CHANGED IN M3: M2 asserted that NO stage/commit control exists anywhere in this panel. That is no longer true and the assertion was not weakened but re-aimed — the absence is now asserted for `canWrite:false` (a viewer-role reader, whom the CP would 403), and the presence for `canWrite:true`. The rule it was protecting is intact: a control that cannot work is withheld, never drawn disabled.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wire = vi.hoisted(() => ({
  git: null as unknown,
  primary: null as unknown,
  gitFails: false,
  // A status read that fails with a CP code rather than a bare network error — the sleeping-sandbox
  // 503, which the panel must not draw as the offline story it shares a status with.
  gitFailure: null as null | { status: number; code?: string },
  log: null as unknown,
  logFailure: null as null | { status: number; code?: string },
  logCalls: [] as Array<{ limit?: number; sessionId?: string }>,
  statusCalls: 0,
  // The fresh status a stage/unstage answers with, and the write calls the panel actually made.
  writeResult: null as unknown,
  writeFailure: null as null | { status: number; code?: string },
  writeCalls: [] as Array<{ kind: 'stage' | 'unstage'; paths: string[]; sessionId?: string }>,
  // Held open so a test can observe the panel WHILE a write is in flight, then released by hand.
  holdWrite: false,
  releaseWrite: null as null | (() => void)
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
      if (sessionId) {
        wire.statusCalls += 1
        if (wire.gitFailure) {
          return Promise.reject(new ApiError('nope', wire.gitFailure.status, wire.gitFailure.code))
        }
        return wire.gitFails ? Promise.reject(new Error('offline')) : Promise.resolve(wire.git)
      }
      return Promise.resolve(wire.primary)
    }),
    fetchWorkspaceGitLog: vi.fn((_agentId: string, opts: { limit?: number; sessionId?: string } = {}) => {
      wire.logCalls.push(opts)
      if (wire.logFailure) {
        return Promise.reject(new ApiError('nope', wire.logFailure.status, wire.logFailure.code))
      }
      return Promise.resolve(wire.log)
    }),
    stageWorkspacePaths: vi.fn((_agentId: string, opts: { paths: string[]; sessionId?: string }) => {
      wire.writeCalls.push({ kind: 'stage', ...opts })
      return writeAnswer()
    }),
    unstageWorkspacePaths: vi.fn((_agentId: string, opts: { paths: string[]; sessionId?: string }) => {
      wire.writeCalls.push({ kind: 'unstage', ...opts })
      return writeAnswer()
    }),
    // Pressed only through the commit box, which has its own suite; here they exist so the panel's import graph resolves.
    commitWorkspace: vi.fn(() =>
      Promise.resolve({ isRepo: true, ok: true, sha: 'a'.repeat(40), detail: null, reason: null })
    ),
    pushWorkspace: vi.fn(() => Promise.resolve({ isRepo: true, ok: true, detail: null, ahead: 0, reason: null })),
    draftWorkspaceCommitMessage: vi.fn(() => Promise.resolve({ ok: false, message: null, detail: 'no' }))
  }

  function writeAnswer(): Promise<unknown> {
    if (wire.writeFailure) {
      return Promise.reject(new ApiError('nope', wire.writeFailure.status, wire.writeFailure.code))
    }
    if (!wire.holdWrite) return Promise.resolve(wire.writeResult)
    return new Promise((resolve) => {
      wire.releaseWrite = () => resolve(wire.writeResult)
    })
  }
})

import { baseBranchOf, GitPanel, gitTabStatus, splitGitSections, type GitPanelVerdict } from './GitPanel'
import { DOCK_POLL_MS } from './auto-refresh'
import { commitWorkspace, draftWorkspaceCommitMessage, fetchWorkspaceGitLog } from '@/lib/api'
import type { WorkspaceGitFileDto, WorkspaceGitLogDto, WorkspaceGitStatusDto } from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined
let opened: Array<{ path: string; staged: boolean; untracked: boolean }> = []
let verdicts: GitPanelVerdict[] = []
// How many times the panel told its caller the checkout changed — what invalidates the Files tree's badges and the open diff.
let wrote = 0

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
  return { isRepo: true, commits: [], truncated: false, tracking: null, base: null, ...overrides }
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
      onWrote={() => (wrote += 1)}
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
const toggles = (section: 'staged' | 'changes') =>
  Array.from(container?.querySelectorAll<HTMLButtonElement>(`[data-git-section="${section}"] [data-git-toggle]`) ?? [])
const stageAll = (section: 'staged' | 'changes') =>
  container?.querySelector<HTMLButtonElement>(`[data-git-stage-all="${section}"]`) ?? undefined
const commitRows = () => Array.from(container?.querySelectorAll<HTMLElement>('[data-git-commit]') ?? [])
const commitsToggle = () => container?.querySelector<HTMLButtonElement>('[data-git-commits-toggle]') ?? undefined
/** The history is closed by default (it sits under the working half), so every case about the list opens it first. */
const openCommits = async () => {
  await click(commitsToggle(), 'commits toggle')
}

async function click(element: Element | undefined, what: string) {
  expect(element, what).toBeDefined()
  await act(async () => (element as HTMLElement | undefined)?.click())
}

// Through the PROTOTYPE setter: React 19 overrides the node's own `value` setter to track it, so assigning directly makes React believe nothing changed and no onChange fires.
async function type(element: Element | undefined, value: string) {
  expect(element, 'field').toBeDefined()
  await act(async () => {
    const field = element as HTMLTextAreaElement
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  wire.git = gitStatus()
  wire.primary = gitStatus()
  wire.gitFails = false
  wire.log = gitLog()
  wire.gitFailure = null
  wire.logFailure = null
  wire.logCalls = []
  wire.statusCalls = 0
  wire.writeResult = gitStatus()
  wire.writeFailure = null
  wire.writeCalls = []
  wire.holdWrite = false
  wire.releaseWrite = null
  opened = []
  verdicts = []
  wrote = 0
  vi.clearAllMocks()
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = undefined
  root = undefined
  // The polling cases install fake timers; leaving them installed would starve the next test's reads.
  vi.useRealTimers()
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

describe('baseBranchOf', () => {
  it('reduces the log ref to the branch a pull request can target, and answers nothing for no base', () => {
    expect(baseBranchOf('origin/release')).toBe('release')
    // A configured branch that is itself path-shaped keeps every segment but the remote.
    expect(baseBranchOf('origin/release/2026.08')).toBe('release/2026.08')
    expect(baseBranchOf(null)).toBeNull()
    expect(baseBranchOf(undefined)).toBeNull()
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
    expect(verdicts.at(-1)).toEqual({ settled: true, changed: 2, branch: 'main', tracking: null, base: null })
  })

  it('reports the log’s base as the branch it names, so the PR tab targets the CONFIGURED base and not the repository default', async () => {
    wire.git = gitStatus({ branch: 'dev/jane-doe/candid-lynx', tracking: null })
    wire.log = gitLog({ base: 'origin/release', commits: [commit()] })
    await render()

    expect(verdicts.at(-1)).toEqual({
      settled: true,
      changed: 0,
      branch: 'dev/jane-doe/candid-lynx',
      tracking: null,
      base: 'release'
    })
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

    // The marker lives on the row WRAPPER since M3 split the row into an open-diff target and a stage toggle; the assertion is unchanged, only where the class hangs.
    const selected = (section: 'staged' | 'changes') =>
      rows(section).filter((row) => row.parentElement?.className.includes('border-r-(--brand)')).length
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
    await openCommits()

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
    await openCommits()

    expect(commitRows()).toHaveLength(1)
    expect(text()).not.toContain('unpushed')
    expect(text()).toContain('tracks no remote branch')
  })

  it('withholds every write control from a reader whose role cannot write, and says why', async () => {
    wire.git = gitStatus({ clean: false, files: [file('a.ts', 'M', 'M')] })
    await render({ canWrite: false })

    // Withheld, not disabled: the CP would 403 each of these, and a control that cannot work is worse than a surface that does not claim one.
    expect(toggles('staged')).toHaveLength(0)
    expect(toggles('changes')).toHaveLength(0)
    expect(stageAll('staged')).toBeUndefined()
    expect(stageAll('changes')).toBeUndefined()
    expect(container?.querySelector('[data-commit-box]')).toBeNull()
    expect(container?.querySelector('textarea')).toBeNull()
    expect(text()).toContain('Review only')
    expect(text()).toContain('cannot change this checkout')
  })

  it('draws a from-scratch workspace as data, with no sections and no log', async () => {
    wire.git = gitStatus({ isRepo: false })
    wire.log = gitLog({ isRepo: false })
    await render()

    expect(text()).toContain('not a git checkout')
    expect(rows('staged')).toHaveLength(0)
    expect(container?.querySelector('[data-git-section="commits"]')).toBeNull()
    // Nothing to badge, so the tab gets no count at all rather than a zero — and a non-checkout has no branch facts to report either.
    expect(verdicts.at(-1)).toEqual({ settled: true, changed: null, branch: null, tracking: null, base: null })
  })

  it('draws an offline daemon as data and still settles its tab', async () => {
    wire.gitFails = true
    await render()

    expect(text()).toContain('daemon may be offline')
    expect(verdicts.at(-1)).toEqual({ settled: true, changed: null, branch: null, tracking: null, base: null })
    expect(container?.querySelector('[data-git-panel]')).not.toBeNull()
  })

  it('draws a sleeping sandbox as its own answer, not as an outage and not as "no checkout"', async () => {
    // Both wrong answers this replaces were reachable: the daemon used to report `isRepo:false` for a
    // suspended pod (drawn "Not a git checkout"), and the 503 it now sends is the same status an
    // offline daemon sends. Only the code separates them, so the code is what this asserts on.
    wire.gitFailure = { status: 503, code: 'WORKSPACE_SANDBOX_UNAVAILABLE' }
    await render()

    expect(text()).toContain('its pod is not running')
    expect(text()).toContain('Sandbox not running')
    expect(text()).not.toContain('daemon may be offline')
    expect(text()).not.toContain('Not a git checkout')
    // Still data: the tab settles and the panel stays mounted, like every other degraded answer.
    expect(verdicts.at(-1)).toEqual({ settled: true, changed: null, branch: null, tracking: null, base: null })
    expect(container?.querySelector('[data-git-panel]')).not.toBeNull()
  })

  it('keeps a reasonless 503 on the offline story, which is what it is', async () => {
    wire.gitFailure = { status: 503 }
    await render()
    expect(text()).toContain('daemon may be offline')
    expect(text()).not.toContain('its pod is not running')
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
    await openCommits()

    expect(text()).toContain('cannot list commits')
    expect(text()).not.toContain('may be offline')
    // The status half is unaffected: one read failing does not take the panel down.
    expect(rowPaths('staged')).toEqual(['a.ts'])
  })

  it('falls back to the offline story for a log failure the CP did not name', async () => {
    wire.logFailure = { status: 503 }
    await render()
    await openCommits()
    expect(text()).toContain('Commits are unavailable')
  })

  it('says no commits yet for a repository with no history', async () => {
    await render()
    await openCommits()
    expect(text()).toContain('No commits yet')
  })

  it('keeps the history CLOSED until asked, under the changed files and the commit box', async () => {
    wire.git = gitStatus({ clean: false, files: [file('a.ts', ' ', 'M')] })
    wire.log = gitLog({ commits: [commit({ subject: 'earlier work' })] })
    await render({ canWrite: true })

    // Closed: the list is absent from the DOM, not merely scrolled away — and the count is still on the row.
    expect(commitRows()).toHaveLength(0)
    expect(text()).not.toContain('earlier work')
    expect(commitsToggle()?.dataset.gitCommitsToggle).toBe('closed')
    expect(commitsToggle()?.textContent).toContain('1')
    // The working half comes first in document order: changed files, the commit box, then the history.
    const order = Array.from(
      container?.querySelectorAll('[data-git-section="changes"], [data-commit-box], [data-git-section="commits"]') ?? []
    ).map((node) => (node as HTMLElement).dataset.gitSection ?? 'commit-box')
    expect(order).toEqual(['changes', 'commit-box', 'commits'])

    await openCommits()
    expect(commitsToggle()?.dataset.gitCommitsToggle).toBe('open')
    expect(commitRows()).toHaveLength(1)
  })

  it('names the base a session branch is measured against, and counts only what the branch adds', async () => {
    wire.git = gitStatus({ branch: 'dev/jane-doe/candid-lynx', tracking: null })
    wire.log = gitLog({
      base: 'origin/main',
      truncated: true,
      commits: [commit({ subject: 'feat: the session’s work' })]
    })
    await render()

    // The header says which range this is: a count with no base would read as the repository's whole history.
    expect(commitsToggle()?.textContent).toContain('Commits ahead')
    expect(commitsToggle()?.textContent).toContain('vs origin/main')
    // A truncated page makes the count a FLOOR, so it is drawn as one.
    expect(commitsToggle()?.textContent).toContain('1+')
  })

  it('says an empty ahead-range holds nothing, naming the base rather than claiming no history', async () => {
    wire.log = gitLog({ base: 'origin/main', commits: [] })
    await render()
    await openCommits()
    expect(text()).toContain('Nothing committed on this branch yet')
    expect(text()).toContain('origin/main')
    expect(text()).not.toContain('No commits yet')
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
      { settled: false, changed: null, branch: null, tracking: null, base: null },
      { settled: true, changed: 0, branch: 'main', tracking: null, base: null },
      { settled: true, changed: 1, branch: 'main', tracking: null, base: null }
    ])
  })
})

// M3's write half. Every case here is DATA: a write the daemon accepted answers with the fresh status, and one it refused answers with a status code the panel turns into copy.
describe('GitPanel — staging', () => {
  const dirty = () =>
    gitStatus({ clean: false, files: [file('src/staged.ts', 'A', ' '), file('src/edited.ts', ' ', 'M')] })

  it('stages one path from its row and draws the reply instead of re-reading', async () => {
    wire.git = dirty()
    // The daemon's answer: the edited file is now staged too.
    wire.writeResult = gitStatus({
      clean: false,
      files: [file('src/staged.ts', 'A', ' '), file('src/edited.ts', 'M', ' ')]
    })
    await render({ canWrite: true })
    const statusReads = wire.statusCalls

    await click(toggles('changes')[0], 'stage toggle')

    expect(wire.writeCalls).toEqual([{ kind: 'stage', paths: ['src/edited.ts'], sessionId: 'session-1' }])
    // The reply IS the fresh status, so nothing was re-read — that is the whole point of the REP shape (§6).
    expect(wire.statusCalls).toBe(statusReads)
    expect(fetchWorkspaceGitLog).toHaveBeenCalledTimes(1)
    expect(rowPaths('staged')).toEqual(['src/staged.ts', 'src/edited.ts'])
    expect(rowPaths('changes')).toEqual([])
    // The badge follows the applied status, and the caller is told so it can re-read what it owns.
    expect(verdicts.at(-1)).toEqual({ settled: true, changed: 2, branch: 'main', tracking: null, base: null })
    expect(wrote).toBe(1)
  })

  it('unstages from the staged section, naming the other direction', async () => {
    wire.git = dirty()
    wire.writeResult = gitStatus({ clean: false, files: [file('src/staged.ts', ' ', 'A')] })
    await render({ canWrite: true })

    await click(toggles('staged')[0], 'unstage toggle')

    expect(wire.writeCalls).toEqual([{ kind: 'unstage', paths: ['src/staged.ts'], sessionId: 'session-1' }])
    expect(rowPaths('staged')).toEqual([])
  })

  it('sends the whole section in one request for Stage all and Unstage all', async () => {
    wire.git = gitStatus({
      clean: false,
      files: [file('a.ts', 'A', ' '), file('b.ts', ' ', 'M'), file('c.ts', '?', '?')]
    })
    // The reply repeats the same tree, so both sections stay on screen and the second press has a control to press.
    wire.writeResult = wire.git
    await render({ canWrite: true })

    await click(stageAll('changes'), 'Stage all')
    // Untracked files are in Changes and are stageable, so they ride the same request.
    expect(wire.writeCalls.at(-1)).toEqual({ kind: 'stage', paths: ['b.ts', 'c.ts'], sessionId: 'session-1' })

    await click(stageAll('staged'), 'Unstage all')
    expect(wire.writeCalls.at(-1)).toEqual({ kind: 'unstage', paths: ['a.ts'], sessionId: 'session-1' })
  })

  it('omits sessionId for the agent’s primary checkout', async () => {
    wire.primary = dirty()
    await render({ canWrite: true, sessionId: undefined })

    await click(toggles('changes')[0], 'stage toggle')
    expect(wire.writeCalls).toEqual([{ kind: 'stage', paths: ['src/edited.ts'] }])
  })

  it('spins only the pressed control and refuses a second press while one is in flight', async () => {
    wire.git = dirty()
    wire.writeResult = dirty()
    wire.holdWrite = true
    await render({ canWrite: true })

    await click(toggles('changes')[0], 'stage toggle')
    expect(wire.writeCalls).toHaveLength(1)
    expect(toggles('changes')[0]?.disabled).toBe(true)
    expect(toggles('staged')[0]?.disabled).toBe(true)
    expect(stageAll('changes')?.disabled).toBe(true)
    // Only the pressed row shows the spinner; the other row still shows its glyph.
    expect(toggles('changes')[0]?.querySelector('[aria-label="Loading"]')).not.toBeNull()
    expect(toggles('staged')[0]?.querySelector('[aria-label="Loading"]')).toBeNull()

    await click(toggles('staged')[0], 'unstage toggle')
    expect(wire.writeCalls).toHaveLength(1)

    await act(async () => {
      wire.releaseWrite?.()
      await Promise.resolve()
    })
    expect(toggles('changes')[0]?.disabled).toBe(false)
  })

  it('sends ONE write for a double-click, before any re-render can disable the toggle', async () => {
    wire.git = dirty()
    wire.writeResult = dirty()
    wire.holdWrite = true
    await render({ canWrite: true })
    const toggle = toggles('changes')[0]

    // Both presses land in the SAME task, so neither sees the other's state update and the toggle is still enabled for both.
    await act(async () => {
      toggle?.click()
      toggle?.click()
    })
    expect(wire.writeCalls).toHaveLength(1)
  })

  it('tells a busy agent apart from a daemon too old to write, and from an offline one', async () => {
    wire.git = dirty()
    wire.writeFailure = { status: 409, code: 'WORKSPACE_STALE' }
    await render({ canWrite: true })

    await click(toggles('changes')[0], 'stage toggle')
    expect(text()).toContain('working in this workspace right now')
    // The lists are untouched: nothing moved, so nothing is redrawn as if it had.
    expect(rowPaths('changes')).toEqual(['src/edited.ts'])
    expect(wrote).toBe(0)

    wire.writeFailure = { status: 409, code: 'DAEMON_FEATURE_MISSING' }
    await click(toggles('changes')[0], 'stage toggle')
    expect(text()).toContain('cannot stage or commit from the console')

    wire.writeFailure = { status: 503 }
    await click(toggles('changes')[0], 'stage toggle')
    expect(text()).toContain('daemon may be offline')
  })

  it('ignores a write reply whose read has since been replaced by a refresh', async () => {
    wire.git = dirty()
    wire.holdWrite = true
    wire.writeResult = gitStatus({ clean: false, files: [file('stale.ts', 'A', ' ')] })
    await render({ canWrite: true })

    await click(toggles('changes')[0], 'stage toggle')
    // The tab's refresh lands first and answers with a different tree.
    wire.git = gitStatus({ clean: false, files: [file('fresh.ts', 'A', ' ')] })
    await rerender({ canWrite: true, refreshTick: 1 })
    await act(async () => {
      wire.releaseWrite?.()
      await Promise.resolve()
    })

    // The in-flight reply describes the tree BEFORE that refresh, so it is dropped rather than painted over a newer read.
    expect(rowPaths('staged')).toEqual(['fresh.ts'])
  })

  it('shows a refusal to the box that is mounted when it lands, not to the one that asked', async () => {
    // The dangerous shape: the spinner is shared so it clears, but a refusal held in component state
    // reaches an unmounted instance — so the live box says nothing, and the reader retries a paid pass
    // without knowing the first one already declined.
    wire.git = gitStatus({ clean: false, files: [file('src/a.ts', 'M', ' ')] })
    let release: (() => void) | undefined
    vi.mocked(draftWorkspaceCommitMessage).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: false, message: null, detail: 'The runtime ran out of budget.' })
        }) as ReturnType<typeof draftWorkspaceCommitMessage>
    )
    await render({ canWrite: true })
    await click(container?.querySelector<HTMLElement>('[data-commit-draft]') ?? undefined, 'wand')
    await rerender({ canWrite: true, agentId: 'agent-b' })
    await rerender({ canWrite: true, agentId: 'agent-a' })
    await act(async () => {
      release?.()
      await Promise.resolve()
    })

    expect(container?.querySelector('[data-commit-outcome]')?.textContent ?? '').toContain('ran out of budget')
    // And the wand is pressable again, so the reader can retry KNOWING the first pass failed.
    expect(container?.querySelector<HTMLButtonElement>('[data-commit-draft]')?.disabled).toBe(false)
  })

  it('comes back BUSY after a remount, so a second click cannot bill a second model pass', async () => {
    // `busy` used to be component state, so the box the panel remounts for the same checkout started
    // idle while the previous instance's pass was still running — with the wand enabled.
    wire.git = gitStatus({ clean: false, files: [file('src/a.ts', 'M', ' ')] })
    let release: (() => void) | undefined
    vi.mocked(draftWorkspaceCommitMessage).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, message: 'fix: only once', detail: null })
        }) as ReturnType<typeof draftWorkspaceCommitMessage>
    )
    await render({ canWrite: true })
    const wand = () => container?.querySelector<HTMLButtonElement>('[data-commit-draft]') ?? undefined
    await click(wand(), 'wand')
    await rerender({ canWrite: true, agentId: 'agent-b' })
    await rerender({ canWrite: true, agentId: 'agent-a' })

    // Still running, so the control must refuse — pressed here BEFORE the release.
    expect(wand()?.disabled).toBe(true)
    await act(async () => wand()?.click())
    expect(vi.mocked(draftWorkspaceCommitMessage)).toHaveBeenCalledTimes(1)

    await act(async () => {
      release?.()
      await Promise.resolve()
    })
    expect(vi.mocked(draftWorkspaceCommitMessage)).toHaveBeenCalledTimes(1)
    expect(container?.querySelector<HTMLTextAreaElement>('[data-commit-message]')?.value).toBe('fix: only once')
  })

  it('keeps a drafted message the reader paid for, even if they switched checkout while it ran', async () => {
    // The pass costs a model call. If the reader looks at a sibling agent while it is running, the box
    // is unmounted before the answer arrives, so writing only to component state drops it — and the
    // reader has paid for nothing. Held promise, switched through the FULL panel, then resolved.
    let release: (() => void) | undefined
    vi.mocked(draftWorkspaceCommitMessage).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, message: 'fix: the paid answer', detail: null })
        }) as ReturnType<typeof draftWorkspaceCommitMessage>
    )
    wire.git = gitStatus({ clean: false, files: [file('src/a.ts', 'M', ' ')] })
    await render({ canWrite: true })
    await click(container?.querySelector<HTMLElement>('[data-commit-draft]') ?? undefined, 'wand')
    await rerender({ canWrite: true, agentId: 'agent-b' })
    // BACK to A before the answer lands: the remounted box has already read the store, so a
    // completion that only writes the map and calls the old instance's setter never reaches it.
    await rerender({ canWrite: true, agentId: 'agent-a' })
    await act(async () => {
      release?.()
      await Promise.resolve()
    })

    expect(container?.querySelector<HTMLTextAreaElement>('[data-commit-message]')?.value).toBe('fix: the paid answer')
  })

  it('does not hand back a message that has already become a commit', async () => {
    // The inverse: a commit in flight while the reader switches away. The unmount parks the OLD text,
    // and the successful clear lands on an unmounted component — so returning would offer to commit
    // the very message that is already in the history.
    let release: (() => void) | undefined
    vi.mocked(commitWorkspace).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ isRepo: true, ok: true, sha: 'abc1234', detail: null, reason: null })
        }) as ReturnType<typeof commitWorkspace>
    )
    wire.git = gitStatus({ clean: false, files: [file('src/a.ts', 'M', ' ')] })
    await render({ canWrite: true })
    const box = () => container?.querySelector<HTMLTextAreaElement>('[data-commit-message]')
    await act(async () => {
      const node = box()!
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(node, 'feat: already landed')
      node.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(container?.querySelector<HTMLElement>('[data-commit-submit]') ?? undefined, 'commit')
    await rerender({ canWrite: true, agentId: 'agent-b' })
    // BACK to A before the commit lands, so the live box is the one that has to stop offering a
    // message which is by then already in the history.
    await rerender({ canWrite: true, agentId: 'agent-a' })
    await act(async () => {
      release?.()
      await Promise.resolve()
    })

    expect(box()?.value ?? '').toBe('')
  })

  it('keeps a commit draft across a checkout switch, through the panel that unmounts the box', async () => {
    // Driven through the FULL panel on purpose: the panel returns null while a newly selected
    // scope's status settles, so a draft store living inside CommitBox is rebuilt empty on the way
    // back — losing the draft during the exact switch it exists to survive. Rerendering CommitBox
    // directly cannot see that, which is why the first version of this fix passed a test and failed
    // in the app.
    await render({ canWrite: true })
    const box = () => container?.querySelector<HTMLTextAreaElement>('[data-commit-message]')
    expect(box(), 'commit box on the first checkout').toBeDefined()
    await act(async () => {
      const node = box()!
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(node, 'fix: keep me')
      node.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(box()?.value).toBe('fix: keep me')

    // A different agent: the box must NOT carry the draft there.
    await rerender({ canWrite: true, agentId: 'agent-b' })
    expect(box()?.value ?? '').toBe('')

    // Back again — the draft is still the reader's.
    await rerender({ canWrite: true, agentId: 'agent-a' })
    expect(box()?.value).toBe('fix: keep me')
  })

  it('re-reads status and log after the commit box reports a commit', async () => {
    wire.git = dirty()
    await render({ canWrite: true })
    expect(fetchWorkspaceGitLog).toHaveBeenCalledTimes(1)
    const statusReads = wire.statusCalls

    // The commit REP carries no status, so the panel has to ask again — both halves moved.
    wire.git = gitStatus({ clean: false, files: [file('src/edited.ts', ' ', 'M')] })
    wire.log = gitLog({ commits: [commit({ subject: 'feat: staged work' })] })
    await type(container?.querySelector('[data-commit-message]') ?? undefined, 'feat: staged work')
    await click(container?.querySelector('[data-commit-submit]') ?? undefined, 'commit')

    expect(wire.statusCalls).toBeGreaterThan(statusReads)
    expect(fetchWorkspaceGitLog).toHaveBeenCalledTimes(2)
    expect(rowPaths('staged')).toEqual([])
    await openCommits()
    expect(text()).toContain('feat: staged work')
    expect(wrote).toBe(1)
  })

  it('keeps a typed commit message across a refresh, which puts the status read back to pending', async () => {
    wire.git = dirty()
    await render({ canWrite: true })
    await type(container?.querySelector('[data-commit-message]') ?? undefined, 'feat: half-written')

    await rerender({ canWrite: true, refreshTick: 1 })
    // A message the reader typed — or paid a model to write — must not be thrown away by a read the panel started.
    expect(container?.querySelector<HTMLTextAreaElement>('[data-commit-message]')?.value).toBe('feat: half-written')
  })

  it('withholds the push control when the status already says the branch cannot be pushed', async () => {
    // A detached HEAD, which is what every session worktree is: `branch:null` is exactly the daemon's `detached-head` refusal, so pressing would only be told what is already on screen.
    wire.git = gitStatus({ clean: false, branch: null, tracking: null, files: [file('a.ts', 'A', ' ')] })
    await render({ canWrite: true })
    expect(container?.querySelector('[data-commit-push]')).toBeNull()
    expect(text()).toContain('no branch checked out')
    // A commit still works in a detached worktree — only the push has nowhere to go.
    expect(container?.querySelector('[data-commit-submit]')).not.toBeNull()

    // A branch with no upstream: same rule, its own sentence.
    wire.git = gitStatus({ clean: false, branch: 'work', tracking: null, files: [file('a.ts', 'A', ' ')] })
    await rerender({ canWrite: true, refreshTick: 1 })
    expect(container?.querySelector('[data-commit-push]')).toBeNull()
    expect(text()).toContain('tracks no remote branch, so the daemon has no ref')

    wire.git = gitStatus({ clean: false, branch: 'work', tracking: 'origin/work', files: [file('a.ts', 'A', ' ')] })
    await rerender({ canWrite: true, refreshTick: 2 })
    expect(container?.querySelector('[data-commit-push]')).not.toBeNull()
  })

  it('draws no commit box over a workspace that is not a checkout', async () => {
    wire.git = gitStatus({ isRepo: false })
    await render({ canWrite: true })

    expect(container?.querySelector('[data-commit-box]')).toBeNull()
    expect(text()).toContain('not a git checkout')
  })
})

// The dock's refresh cadence, wired here: this panel's tab carries the changed-file BADGE, so the
// signal that reaches it while hidden is a turn settling — and the poll is spent only where a reader
// is looking. The cadence itself is `auto-refresh.test.tsx`'s subject; these are the wiring facts.
describe('GitPanel auto refresh', () => {
  it('re-reads status and log on a turn’s falling edge, even while its tab is hidden', async () => {
    await render({ active: false })
    expect(wire.statusCalls).toBe(1)
    expect(wire.logCalls).toHaveLength(1)

    await rerender({ active: false, turnActive: true })
    expect(wire.statusCalls).toBe(1)
    await rerender({ active: false, turnActive: false })
    // Both reads, because a turn commits: the index empties and the branch gains a commit.
    expect(wire.statusCalls).toBe(2)
    expect(wire.logCalls).toHaveLength(2)
  })

  it('keeps polling behind another tab — its status is what holds the sandbox', async () => {
    // Not just freshness: this status is one of the two facts the daemon holds a cluster agent's pod
    // for (an uncommitted tree), so it must keep being read while the page is open behind another tab.
    vi.useFakeTimers()
    await render({ active: true })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOCK_POLL_MS)
    })
    expect(wire.statusCalls).toBe(2)

    await rerender({ active: false })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DOCK_POLL_MS * 2)
    })
    // The count, not the exact number of ticks: what matters is that a hidden tab keeps reading.
    expect(wire.statusCalls).toBeGreaterThan(2)
  })

  it('skips an automatic read while one of its OWN writes is in flight', async () => {
    // The write answers with the fresh status; a read racing it would land the pre-write tree over that
    // reply, and the write's own re-read is what covers this case.
    const dirty = gitStatus({ clean: false, files: [file('src/staged.ts', 'A', ' '), file('src/edited.ts', ' ', 'M')] })
    wire.git = dirty
    wire.writeResult = dirty
    wire.holdWrite = true
    await render({ canWrite: true })
    const before = wire.statusCalls
    await click(toggles('changes')[0], 'a row toggle')

    await rerender({ canWrite: true, turnActive: true })
    await rerender({ canWrite: true, turnActive: false })
    expect(wire.statusCalls).toBe(before)

    await act(async () => {
      wire.releaseWrite?.()
      await Promise.resolve()
    })
  })
})
