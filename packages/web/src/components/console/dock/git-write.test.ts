// The console's copy for a refused git write. Two rules are pinned here: the daemon's own `detail` always wins (it is hand-written per reason and scrubbed of host paths), and EVERY reason in the wire vocabulary has a sentence — a reason that reached the UI with no copy would render as blank space beside a commit button.

import { describe, expect, it } from 'vitest'
import { gitWriteFailureText, gitWriteRequestFailureText } from './git-write'
import type { WorkspaceGitWriteReason } from '@/lib/api'

// The wire enum, restated so this suite fails when the daemon grows a reason the console has no answer for. The `Record` inside the module makes that a typecheck failure too; this is the runtime half.
const REASONS: WorkspaceGitWriteReason[] = [
  'not-a-repo',
  'nothing-staged',
  'empty-message',
  'no-identity',
  'detached-head',
  'no-upstream',
  'unsafe-origin',
  'unsafe-config',
  'diverged',
  'rejected',
  'failed'
]

describe('gitWriteFailureText', () => {
  it('prefers the daemon’s own detail over the console’s fallback', () => {
    expect(gitWriteFailureText('diverged', 'Rejected — the remote has commits this branch does not.')).toBe(
      'Rejected — the remote has commits this branch does not.'
    )
    // Trimmed, because the wire carries git's own line endings.
    expect(gitWriteFailureText('failed', '  fatal: nope\n')).toBe('fatal: nope')
  })

  it('has an actionable sentence for every reason the wire can send', () => {
    for (const reason of REASONS) {
      const text = gitWriteFailureText(reason, null)
      expect(text.length, reason).toBeGreaterThan(20)
      expect(text.endsWith('.'), reason).toBe(true)
    }
  })

  it('names the next action for the reasons that have one', () => {
    expect(gitWriteFailureText('nothing-staged', null)).toContain('Stage a file first')
    expect(gitWriteFailureText('diverged', null)).toContain('Pull those first')
    expect(gitWriteFailureText('no-identity', null)).toContain('Reconnect the agent’s GitHub App')
    // A session worktree is always detached, so this is the copy an operator meets when pushing one.
    expect(gitWriteFailureText('detached-head', null)).toContain('primary checkout')
  })

  it('still says something when a daemon refuses with neither a detail nor a reason', () => {
    expect(gitWriteFailureText(null, null)).toContain('gave no reason')
    expect(gitWriteFailureText(null, '   ')).toContain('gave no reason')
  })
})

describe('gitWriteRequestFailureText', () => {
  it('tells a busy agent from a daemon too old to write', () => {
    expect(gitWriteRequestFailureText(409, 'WORKSPACE_STALE')).toContain('Try again when it is idle')
    expect(gitWriteRequestFailureText(409, 'DAEMON_FEATURE_MISSING')).toContain('Update the agent')
    // A 409 with neither code is the session-scoped version answer.
    expect(gitWriteRequestFailureText(409, null)).toContain('session checkout')
  })

  it('reads a role denial and a missing worktree as themselves', () => {
    expect(gitWriteRequestFailureText(403, null)).toContain('role in this organization')
    expect(gitWriteRequestFailureText(404, null)).toContain('not available to write to')
  })

  it('folds everything else into the offline story, including a status-less network failure', () => {
    expect(gitWriteRequestFailureText(503, null)).toContain('daemon may be offline')
    expect(gitWriteRequestFailureText(null, null)).toContain('daemon may be offline')
    expect(gitWriteRequestFailureText(500, null)).toContain('daemon may be offline')
  })
})
