import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initiatorLabel, isSessionBranch, sessionBranchName } from '../src/workspace/session-branch.js'

/** The user segment of `dev/<user>/<adjective>-<animal>`. */
const userOf = (branch: string) => branch.split('/')[1]!

describe('sessionBranchName', () => {
  it('names the session worktree dev/<user>/<two words>', () => {
    const branch = sessionBranchName('yulong')
    expect(branch).toMatch(/^dev\/yulong\/[a-zA-Z]+-[a-zA-Z]+$/)
  })

  it('draws a different word pair per call', () => {
    const drawn = new Set(Array.from({ length: 20 }, () => sessionBranchName('yulong')))
    // 1202x355 combinations: 20 identical draws would mean the generator is not drawing at all.
    expect(drawn.size).toBeGreaterThan(1)
  })

  it('appends random bytes only when asked for a unique name', () => {
    expect(sessionBranchName('yulong', true)).toMatch(/^dev\/yulong\/[a-zA-Z]+-[a-zA-Z]+-[0-9a-f]{6}$/)
  })

  it('turns a display name into one ref path component', () => {
    expect(userOf(sessionBranchName('Yu Long'))).toBe('yu-long')
    expect(userOf(sessionBranchName('  .Ada  '))).toBe('ada')
    expect(userOf(sessionBranchName('a..b'))).toBe('a-b')
  })

  it('keeps a CJK display name rather than flattening every such user to one branch', () => {
    expect(userOf(sessionBranchName('张伟'))).toBe('张伟')
  })

  it('falls back to `agent` when the label sanitizes away to nothing', () => {
    expect(userOf(sessionBranchName(undefined))).toBe('agent')
    expect(userOf(sessionBranchName(''))).toBe('agent')
    expect(userOf(sessionBranchName('!!!'))).toBe('agent')
  })

  it('bounds the user segment, and never ends it on the separator', () => {
    const user = userOf(sessionBranchName('a'.repeat(80)))
    expect(user).toHaveLength(24)
    const trimmed = userOf(sessionBranchName(`${'b'.repeat(23)} tail`))
    expect(trimmed.endsWith('-')).toBe(false)
  })

  it('produces a name git itself accepts, from labels built to break ref syntax', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-branch-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    for (const label of ['yulong', '张伟', 'a b', '..', '-lead-', 'name.lock', 'x~^:?*[\\y', '@{', '/././', '!!!']) {
      const branch = sessionBranchName(label)
      // check-ref-format is the authority the daemon's push path also consults.
      expect(() => execFileSync('git', ['check-ref-format', '--branch', branch], { cwd: dir })).not.toThrow()
    }
  })
})

describe('the worktree branch git actually creates', () => {
  /** A clone with an `origin/main` to start a worktree from, as an agent workspace has. */
  function clone() {
    const root = mkdtempSync(join(tmpdir(), 'ac-branch-repo-'))
    const origin = join(root, 'origin')
    const dir = join(root, 'clone')
    execFileSync('git', ['init', '-q', '--bare', origin])
    execFileSync('git', ['clone', '-q', origin, dir], { stdio: 'ignore' })
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir })
    execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: dir })
    execFileSync('git', ['fetch', '-q', 'origin'], { cwd: dir })
    return { root, dir }
  }
  const upstreamOf = (cwd: string) => {
    try {
      return execFileSync('git', ['rev-parse', '--abbrev-ref', '@{u}'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim()
    } catch {
      return null
    }
  }

  it('starts with NO upstream — git would otherwise adopt the remote-tracking start point', () => {
    const { root, dir } = clone()
    const branch = sessionBranchName('yulong')
    const wt = join(root, 'wt')

    // The exact command shape workspace-manager issues.
    execFileSync('git', ['worktree', 'add', '-b', branch, '--no-track', wt, 'refs/remotes/origin/main'], {
      cwd: dir,
      stdio: 'ignore'
    })

    expect(execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: wt }).toString().trim()).toBe(branch)
    // With `branch.autoSetupMerge` at its default this would be `origin/main`, which the console's
    // push authorizes against and a plain `push.default=simple` push then refuses by name mismatch.
    expect(upstreamOf(wt)).toBeNull()
  })
})

describe('isSessionBranch (the retention GC delete guard)', () => {
  it('accepts a generated session branch', () => {
    expect(isSessionBranch(sessionBranchName('yulong'))).toBe(true)
    expect(isSessionBranch(sessionBranchName('张伟', true))).toBe(true)
  })

  it('refuses anything outside the three-component dev namespace', () => {
    for (const branch of ['main', 'dev', 'dev/yulong', 'dev/yulong/a/b', 'devel/yulong/x', 'feature/dev/x/y', '']) {
      expect(isSessionBranch(branch)).toBe(false)
    }
    expect(isSessionBranch(undefined)).toBe(false)
  })

  it('refuses a human branch that merely shares the namespace', () => {
    // Deleting one of these — an agent left the worktree on a teammate's branch — is the failure this guard exists to prevent.
    for (const branch of [
      'dev/yulong/gurnard',
      'dev/yulong/fix-parser',
      'dev/yulong/brave-otter-x',
      'dev/yulong/brave-otter-12345',
      'dev/yulong/otter-brave',
      'dev/yulong/brave'
    ]) {
      expect(isSessionBranch(branch)).toBe(false)
    }
  })
})

describe('initiatorLabel', () => {
  it('prefers the cached display name of the session initiator', () => {
    expect(initiatorLabel('U07', 'Yu Long', { id: 'U07', name: 'stale' })).toBe('Yu Long')
  })

  it('names the initiator even when only this turn`s sender carries the name', () => {
    expect(initiatorLabel('U07', undefined, { id: 'U07', name: 'Yu Long' })).toBe('Yu Long')
  })

  it('stands this turn`s sender in for an initiator id that names no human', () => {
    // A hook session is keyed by the hook, so the GitHub actor who fired it is the person to name.
    expect(initiatorLabel('hook:2f0c-uuid', undefined, { id: 'spacedragon' })).toBe('spacedragon')
    expect(initiatorLabel('hook:2f0c-uuid', undefined, { id: 'gh', name: 'Yu Long' })).toBe('Yu Long')
  })

  it('falls back to the platform id, and to the initiator when there is no sender at all', () => {
    expect(initiatorLabel('U07', undefined, { id: 'U07' })).toBe('U07')
    expect(initiatorLabel('U07', undefined, undefined)).toBe('U07')
    expect(initiatorLabel('U07', undefined, {})).toBe('U07')
  })
})
