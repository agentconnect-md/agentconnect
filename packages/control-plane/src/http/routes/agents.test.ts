/**
 * Workspace REP → HTTP DTO mappers (unit, no I/O) — the null-coalescing fold at
 * the wire/HTTP boundary. Optional wire fields (absent = "not applicable") must
 * come out as explicit `null`s so the zod response schema passes serialization.
 */
import { describe, it, expect } from 'vitest'
import {
  MAX_WORKSPACE_COMMIT_MESSAGE,
  MAX_WORKSPACE_STAGE_PATHS,
  MAX_WORKSPACE_STAGE_PATH_BYTES
} from '@agentconnect.md/protocol'
import { ProtocolError } from '../../domain/errors.js'
import type { AgentRecord, AgentWorkspace } from '../../persistence/ports.js'
import { WorkspaceGitCommitBody, WorkspaceGitStageBody } from '../dto/index.js'
import {
  toWorkspaceFilesDto,
  toWorkspaceFileDto,
  toWorkspaceGitStatusDto,
  toWorkspaceGitDiffDto,
  toWorkspaceGitLogDto,
  toWorkspaceGitPullDto,
  toWorkspaceGitCommitDto,
  toWorkspaceGitPushDto,
  toWorkspaceGitMessageDto,
  toAgentTasksDto,
  workspaceGitConfigOf,
  workspaceErrorCode,
  workspaceFailure,
  taskErrorCode,
  taskFailure,
  toDreamDto,
  toDreamListDto,
  toDreamFilesDto,
  toDreamFileDto
} from './agents.js'

describe('toWorkspaceFilesDto', () => {
  it('null-coalesces optional entry fields and the cursor', () => {
    expect(
      toWorkspaceFilesDto({
        agentId: 'a1',
        path: 'src',
        exists: true,
        entries: [
          { name: 'index.ts', type: 'file', size: 123, mtime: '2026-01-01T00:00:00Z' },
          { name: 'lib', type: 'dir' } // dirs carry no size/mtime on the wire
        ]
        // nextCursor absent ⇒ last page
      })
    ).toEqual({
      path: 'src',
      exists: true,
      entries: [
        { name: 'index.ts', type: 'file', size: 123, mtime: '2026-01-01T00:00:00Z' },
        { name: 'lib', type: 'dir', size: null, mtime: null }
      ],
      nextCursor: null
    })
  })

  it('passes a mid-listing cursor through and keeps exists:false as data', () => {
    const dto = toWorkspaceFilesDto({ agentId: 'a1', path: 'gone', exists: false, entries: [], nextCursor: 'c2' })
    expect(dto).toEqual({ path: 'gone', exists: false, entries: [], nextCursor: 'c2' })
  })
})

describe('toWorkspaceFileDto', () => {
  it('maps a utf8 slice, keeping offset/truncated', () => {
    expect(
      toWorkspaceFileDto({
        agentId: 'a1',
        path: 'README.md',
        exists: true,
        type: 'file',
        size: 100_000,
        mtime: '2026-01-01T00:00:00Z',
        encoding: 'utf8',
        content: 'hello',
        offset: 65536,
        nextOffset: 65541,
        truncated: true
      })
    ).toEqual({
      path: 'README.md',
      exists: true,
      type: 'file',
      size: 100_000,
      mtime: '2026-01-01T00:00:00Z',
      encoding: 'utf8',
      content: 'hello',
      offset: 65536,
      nextOffset: 65541,
      truncated: true
    })
  })

  it('nulls every optional field for a missing file (exists:false is data, not an error)', () => {
    expect(toWorkspaceFileDto({ agentId: 'a1', path: 'gone.txt', exists: false })).toEqual({
      path: 'gone.txt',
      exists: false,
      type: null,
      size: null,
      mtime: null,
      encoding: null,
      content: null,
      offset: null,
      nextOffset: null,
      truncated: null
    })
  })

  it('keeps a directory as data (type:dir, no content) instead of flattening it to an empty file', () => {
    expect(
      toWorkspaceFileDto({
        agentId: 'a1',
        path: 'src',
        exists: true,
        type: 'dir',
        mtime: '2026-01-01T00:00:00Z'
      })
    ).toEqual({
      path: 'src',
      exists: true,
      type: 'dir',
      size: null,
      mtime: '2026-01-01T00:00:00Z',
      encoding: null,
      content: null,
      offset: null,
      nextOffset: null,
      truncated: null
    })
  })
})

describe('toWorkspaceGitStatusDto', () => {
  it('folds in repo/agentDir config and the daemon commit + fetch facts', () => {
    expect(
      toWorkspaceGitStatusDto(
        {
          agentId: 'a1',
          isRepo: true,
          clean: false,
          branch: 'main',
          tracking: 'origin/main',
          ahead: 1,
          behind: 2,
          files: [
            { path: 'a.ts', index: 'M', workingDir: ' ', additions: 128, deletions: 12 },
            { path: 'new.bin', index: '?', workingDir: '?' } // untracked / binary ⇒ no counts on the wire
          ],
          truncated: true,
          lastCommit: {
            sha: 'a3f9c21dead',
            shortSha: 'a3f9c21',
            subject: 'Pin deploy image',
            committedAt: '2026-07-02T07:00:00Z'
          },
          lastFetchAt: '2026-07-02T09:00:00Z'
        },
        { repo: 'https://github.com/acme/infra', agentDir: './services/api' }
      )
    ).toEqual({
      isRepo: true,
      clean: false,
      repo: 'https://github.com/acme/infra',
      agentDir: './services/api',
      branch: 'main',
      tracking: 'origin/main',
      ahead: 1,
      behind: 2,
      files: [
        { path: 'a.ts', index: 'M', workingDir: ' ', additions: 128, deletions: 12 },
        { path: 'new.bin', index: '?', workingDir: '?', additions: null, deletions: null }
      ],
      truncated: true,
      lastCommit: {
        sha: 'a3f9c21dead',
        shortSha: 'a3f9c21',
        subject: 'Pin deploy image',
        committedAt: '2026-07-02T07:00:00Z'
      },
      lastFetchAt: '2026-07-02T09:00:00Z'
    })
  })

  it('nulls repo/agentDir/commit and defaults files/truncated for a non-repo workspace', () => {
    expect(toWorkspaceGitStatusDto({ agentId: 'a1', isRepo: false, clean: true })).toEqual({
      isRepo: false,
      clean: true,
      repo: null,
      agentDir: null,
      branch: null,
      tracking: null,
      ahead: null,
      behind: null,
      files: [],
      truncated: false,
      lastCommit: null,
      lastFetchAt: null
    })
  })
})

describe('toWorkspaceGitDiffDto', () => {
  it('passes the unified diff through with its truncation flag', () => {
    expect(
      toWorkspaceGitDiffDto({
        agentId: 'a1',
        path: 'src/app.ts',
        isRepo: true,
        exists: true,
        diff: '@@ -1,2 +1,3 @@\n a\n+b\n',
        truncated: true
      })
    ).toEqual({
      path: 'src/app.ts',
      isRepo: true,
      exists: true,
      diff: '@@ -1,2 +1,3 @@\n a\n+b\n',
      binary: false,
      truncated: true
    })
  })

  it('keeps a binary change as data (binary:true, no diff text)', () => {
    expect(
      toWorkspaceGitDiffDto({ agentId: 'a1', path: 'logo.png', isRepo: true, exists: true, binary: true })
    ).toEqual({ path: 'logo.png', isRepo: true, exists: true, diff: null, binary: true, truncated: false })
  })

  it('keeps a non-repo workspace and an unchanged path as data, not an error', () => {
    expect(toWorkspaceGitDiffDto({ agentId: 'a1', path: 'notes.md', isRepo: false, exists: false })).toEqual({
      path: 'notes.md',
      isRepo: false,
      exists: false,
      diff: null,
      binary: false,
      truncated: false
    })
    // exists:true with no diff and no binary ⇒ this path has no changes in the scope.
    expect(toWorkspaceGitDiffDto({ agentId: 'a1', path: 'notes.md', isRepo: true, exists: true })).toMatchObject({
      exists: true,
      diff: null,
      binary: false
    })
  })
})

describe('toWorkspaceGitLogDto', () => {
  it('passes commits through and keeps the tracking ref pushed was computed against, plus the excluded base', () => {
    expect(
      toWorkspaceGitLogDto({
        agentId: 'a1',
        isRepo: true,
        commits: [
          {
            sha: 'a3f9c21deadbeef',
            shortSha: 'a3f9c21',
            subject: 'Pin deploy image',
            author: 'Ada',
            committedAt: '2026-07-02T07:00:00Z',
            pushed: false
          }
        ],
        truncated: true,
        tracking: 'origin/main',
        base: 'origin/main'
      })
    ).toEqual({
      isRepo: true,
      commits: [
        {
          sha: 'a3f9c21deadbeef',
          shortSha: 'a3f9c21',
          subject: 'Pin deploy image',
          author: 'Ada',
          committedAt: '2026-07-02T07:00:00Z',
          pushed: false
        }
      ],
      truncated: true,
      tracking: 'origin/main',
      base: 'origin/main'
    })
  })

  it('nulls tracking and base for a branch that tracks nothing on its own base, keeping an empty repo as data', () => {
    expect(toWorkspaceGitLogDto({ agentId: 'a1', isRepo: true, commits: [], truncated: false })).toEqual({
      isRepo: true,
      commits: [],
      truncated: false,
      tracking: null,
      base: null
    })
  })
})

describe('workspaceErrorCode / workspaceFailure', () => {
  const badPayload = (reason?: string): ProtocolError =>
    new ProtocolError('BAD_PAYLOAD', 'workspace/read failed: path escapes the workspace root', {
      ...(reason ? { details: { reason } } : {})
    })

  it('screaming-snakes the daemon reason and ignores a vocabulary it does not know', () => {
    expect(workspaceErrorCode(badPayload('path-escape'))).toBe('WORKSPACE_PATH_ESCAPE')
    expect(workspaceErrorCode(badPayload('not-a-file'))).toBe('WORKSPACE_NOT_A_FILE')
    expect(workspaceErrorCode(badPayload('made-up-reason'))).toBeNull()
    expect(workspaceErrorCode(badPayload())).toBeNull()
  })

  it('answers a named bad request with 400 + code instead of the 503 that reads as an outage', () => {
    expect(workspaceFailure(badPayload('path-escape'))).toEqual({
      status: 400,
      error: 'Bad Request',
      message: 'workspace/read failed: path escapes the workspace root',
      code: 'WORKSPACE_PATH_ESCAPE'
    })
  })

  it('answers a worktree the daemon does not have with the same 404 the CP pre-empts with', () => {
    expect(workspaceFailure(badPayload('unknown-agent'))).toEqual({
      status: 404,
      error: 'Not Found',
      message: 'workspace not found',
      code: 'WORKSPACE_UNKNOWN_AGENT'
    })
  })

  it('answers a stale fence with 409 + code', () => {
    const stale = new ProtocolError('CONFLICT', 'the workspace file changed; reload and retry', {
      details: { reason: 'stale' }
    })
    expect(workspaceFailure(stale)).toEqual({
      status: 409,
      error: 'Conflict',
      message: 'the workspace file changed; reload and retry',
      code: 'WORKSPACE_STALE'
    })
  })

  it('answers a sleeping sandbox 503 WITH its code, not the 400 every other reason gets', () => {
    // The one reason that is transient rather than a bad request. A 400 would tell the console to
    // stop retrying a workspace that comes back on the agent's next turn, and the bare 503 the
    // reasonless case gets would leave it indistinguishable from a daemon that may never return.
    expect(workspaceFailure(badPayload('sandbox-unavailable'))).toEqual({
      status: 503,
      error: 'Service Unavailable',
      message: 'workspace/read failed: path escapes the workspace root',
      code: 'WORKSPACE_SANDBOX_UNAVAILABLE'
    })
  })

  it('keeps the 503 for a reasonless rejection (an older daemon says nothing to branch on)', () => {
    expect(workspaceFailure(badPayload())).toEqual({
      status: 503,
      error: 'Service Unavailable',
      message: 'daemon rejected the request: workspace/read failed: path escapes the workspace root'
    })
  })

  it('keeps the 503 for an offline daemon and rethrows a CP bug', () => {
    expect(workspaceFailure(new Error('connection closed'))).toEqual({
      status: 503,
      error: 'Service Unavailable',
      message: 'owning daemon is offline'
    })
    expect(workspaceFailure(new TypeError('cfg.repo is not a function'))).toBeNull()
  })
})

describe('toWorkspaceGitPullDto', () => {
  it('maps a successful pull with the change summary', () => {
    expect(
      toWorkspaceGitPullDto({
        agentId: 'a1',
        isRepo: true,
        ok: true,
        detail: 'Fast-forwarded — updated 2 files.',
        changed: 2,
        insertions: 10,
        deletions: 3
      })
    ).toEqual({
      isRepo: true,
      ok: true,
      detail: 'Fast-forwarded — updated 2 files.',
      changed: 2,
      insertions: 10,
      deletions: 3
    })
  })

  it('nulls the summary fields for a failed pull (ok:false is data, not an error)', () => {
    expect(toWorkspaceGitPullDto({ agentId: 'a1', isRepo: true, ok: false, detail: 'pull timed out' })).toEqual({
      isRepo: true,
      ok: false,
      detail: 'pull timed out',
      changed: null,
      insertions: null,
      deletions: null
    })
  })
})

describe('toWorkspaceGitCommitDto', () => {
  it('carries the new commit sha through', () => {
    expect(
      toWorkspaceGitCommitDto({
        agentId: 'a1',
        isRepo: true,
        ok: true,
        sha: 'c0ffee1234567890abcdef1234567890abcdef12',
        detail: 'Committed 3 files.'
      })
    ).toEqual({
      isRepo: true,
      ok: true,
      sha: 'c0ffee1234567890abcdef1234567890abcdef12',
      detail: 'Committed 3 files.',
      reason: null
    })
  })

  it('keeps a refusal as data, preserving the machine reason the console branches on', () => {
    expect(
      toWorkspaceGitCommitDto({
        agentId: 'a1',
        isRepo: true,
        ok: false,
        detail: 'Nothing is staged, so there is nothing to commit.',
        reason: 'nothing-staged'
      })
    ).toEqual({
      isRepo: true,
      ok: false,
      sha: null,
      detail: 'Nothing is staged, so there is nothing to commit.',
      reason: 'nothing-staged'
    })
  })

  it('nulls every optional field for a from-scratch workspace', () => {
    expect(toWorkspaceGitCommitDto({ agentId: 'a1', isRepo: false, ok: false })).toEqual({
      isRepo: false,
      ok: false,
      sha: null,
      detail: null,
      reason: null
    })
  })
})

describe('toWorkspaceGitPushDto', () => {
  it('reports nothing still ahead after a successful push', () => {
    expect(
      toWorkspaceGitPushDto({ agentId: 'a1', isRepo: true, ok: true, detail: 'Pushed 2 commits.', ahead: 0 })
    ).toEqual({ isRepo: true, ok: true, detail: 'Pushed 2 commits.', ahead: 0, reason: null })
  })

  it('keeps the commits that did NOT land beside a rejection reason', () => {
    expect(
      toWorkspaceGitPushDto({
        agentId: 'a1',
        isRepo: true,
        ok: false,
        detail: 'Rejected — the remote has commits this branch does not. Pull, then push.',
        ahead: 3,
        reason: 'diverged'
      })
    ).toEqual({
      isRepo: true,
      ok: false,
      detail: 'Rejected — the remote has commits this branch does not. Pull, then push.',
      ahead: 3,
      reason: 'diverged'
    })
  })

  it('nulls ahead when the daemon could not compute it (detached HEAD)', () => {
    expect(
      toWorkspaceGitPushDto({ agentId: 'a1', isRepo: true, ok: false, detail: 'no branch', reason: 'detached-head' })
    ).toEqual({ isRepo: true, ok: false, detail: 'no branch', ahead: null, reason: 'detached-head' })
  })
})

describe('toWorkspaceGitMessageDto', () => {
  it('passes the drafted message through with no detail', () => {
    expect(
      toWorkspaceGitMessageDto({ agentId: 'a1', ok: true, message: 'feat(dock): stage files from the git panel' })
    ).toEqual({ ok: true, message: 'feat(dock): stage files from the git panel', detail: null })
  })

  it('nulls the message when the runtime declined, keeping the detail to render', () => {
    expect(
      toWorkspaceGitMessageDto({
        agentId: 'a1',
        ok: false,
        detail: 'Nothing is staged, so there is nothing to describe.'
      })
    ).toEqual({ ok: false, message: null, detail: 'Nothing is staged, so there is nothing to describe.' })
  })
})

describe('workspaceGitConfigOf', () => {
  // Only `agent.workspace` is read, so the cast keeps the fixture to the field under test.
  const withWorkspace = (workspace: AgentWorkspace): AgentRecord => ({ workspace }) as AgentRecord

  it('folds a git workspace’s repo and subdir into the status body', () => {
    expect(
      workspaceGitConfigOf(withWorkspace({ mode: 'git', gitRepo: 'https://github.com/acme/infra', agentDir: 'api' }))
    ).toEqual({ repo: 'https://github.com/acme/infra', agentDir: 'api' })
  })

  it('omits an absent subdir rather than sending an empty one', () => {
    expect(workspaceGitConfigOf(withWorkspace({ mode: 'git', gitRepo: 'https://github.com/acme/infra' }))).toEqual({
      repo: 'https://github.com/acme/infra'
    })
  })

  it('reports no config at all for a from-scratch workspace', () => {
    expect(workspaceGitConfigOf(withWorkspace({ mode: 'scratch' }))).toEqual({})
  })
})

describe('WorkspaceGitStageBody', () => {
  const paths = (count: number, length = 8): string[] =>
    Array.from({ length: count }, (_, i) => String(i).padStart(length, 'p'))

  it('accepts an empty selection — staging nothing is data, not a bad request', () => {
    expect(WorkspaceGitStageBody.safeParse({ paths: [] }).success).toBe(true)
  })

  it('accepts a full status page and refuses one path past the wire cap', () => {
    expect(WorkspaceGitStageBody.safeParse({ paths: paths(MAX_WORKSPACE_STAGE_PATHS) }).success).toBe(true)
    expect(WorkspaceGitStageBody.safeParse({ paths: paths(MAX_WORKSPACE_STAGE_PATHS + 1) }).success).toBe(false)
  })

  it('refuses a selection that is inside the count cap but over the wire byte total', () => {
    // 16 × 4096-char paths = 64 KiB, twice the byte ceiling, at 3% of the count cap.
    const wide = Array.from({ length: 16 }, (_, i) => String(i).padStart(4096, 'q'))
    expect(wide.length).toBeLessThan(MAX_WORKSPACE_STAGE_PATHS)
    const refused = WorkspaceGitStageBody.safeParse({ paths: wide })
    expect(refused.success).toBe(false)
    expect(refused.error?.issues[0]?.message).toContain(`${MAX_WORKSPACE_STAGE_PATH_BYTES} bytes`)
  })

  it('counts ENCODED bytes, not characters, so multi-byte paths cannot slip past the cap', () => {
    // Each ✓ is 3 UTF-8 bytes: 12k characters is under the cap, 36k bytes is not.
    const multibyte = Array.from({ length: 3 }, () => '✓'.repeat(4000))
    expect(multibyte.join('').length).toBeLessThan(MAX_WORKSPACE_STAGE_PATH_BYTES)
    expect(WorkspaceGitStageBody.safeParse({ paths: multibyte }).success).toBe(false)
  })

  it('refuses an unknown field, so a stray option is never silently dropped', () => {
    expect(WorkspaceGitStageBody.safeParse({ paths: ['a.ts'], force: true }).success).toBe(false)
  })
})

describe('WorkspaceGitCommitBody', () => {
  it('requires a message and bounds it at the wire cap', () => {
    expect(WorkspaceGitCommitBody.safeParse({ message: 'fix: typo' }).success).toBe(true)
    expect(WorkspaceGitCommitBody.safeParse({ message: '' }).success).toBe(false)
    expect(WorkspaceGitCommitBody.safeParse({ message: 'x'.repeat(MAX_WORKSPACE_COMMIT_MESSAGE) }).success).toBe(true)
    expect(WorkspaceGitCommitBody.safeParse({ message: 'x'.repeat(MAX_WORKSPACE_COMMIT_MESSAGE + 1) }).success).toBe(
      false
    )
  })

  it('leaves a whitespace-only message to the daemon, which answers empty-message as data', () => {
    expect(WorkspaceGitCommitBody.safeParse({ message: '   \n ' }).success).toBe(true)
  })
})

describe('toDreamDto', () => {
  it('null-coalesces optional job metadata fields', () => {
    expect(
      toDreamDto({
        dreamId: 'drm-1',
        agentId: 'a1',
        status: 'pending',
        trigger: 'manual',
        sessionIds: ['s1', 's2'],
        snapshotDigest: 'sha256:abc',
        createdAt: '2026-07-24T00:00:00Z'
        // instructions / skills / usage / error / endedAt absent
      })
    ).toEqual({
      dreamId: 'drm-1',
      agentId: 'a1',
      status: 'pending',
      trigger: 'manual',
      sessionIds: ['s1', 's2'],
      snapshotDigest: 'sha256:abc',
      executionSessionId: null,
      runtime: null,
      model: null,
      stopReason: null,
      instructions: null,
      skills: null,
      usage: null,
      error: null,
      createdAt: '2026-07-24T00:00:00Z',
      endedAt: null
    })
  })

  it('passes populated metadata through', () => {
    const dto = toDreamDto({
      dreamId: 'drm-2',
      agentId: 'a1',
      status: 'completed',
      trigger: 'schedule',
      sessionIds: [],
      snapshotDigest: 'sha256:def',
      executionSessionId: 'dream-session-2',
      runtime: 'codex',
      model: 'gpt-5.6',
      stopReason: 'end_turn',
      instructions: 'focus on prefs',
      usage: {
        inputBytes: 100,
        outputBytes: 40,
        totalTokens: 21,
        inputTokens: 16,
        outputTokens: 5,
        costAmount: 0.004,
        costCurrency: 'USD'
      },
      createdAt: '2026-07-24T00:00:00Z',
      endedAt: '2026-07-24T00:05:00Z'
    })
    expect(dto).toMatchObject({
      status: 'completed',
      executionSessionId: 'dream-session-2',
      runtime: 'codex',
      model: 'gpt-5.6',
      stopReason: 'end_turn',
      instructions: 'focus on prefs',
      usage: {
        inputBytes: 100,
        outputBytes: 40,
        totalTokens: 21,
        inputTokens: 16,
        outputTokens: 5,
        costAmount: 0.004,
        costCurrency: 'USD'
      },
      endedAt: '2026-07-24T00:05:00Z',
      skills: null,
      error: null
    })
  })
})

describe('toDreamListDto / toDreamFilesDto / toDreamFileDto', () => {
  it('maps a dream list', () => {
    const dto = toDreamListDto({
      agentId: 'a1',
      dreams: [
        {
          dreamId: 'drm-1',
          agentId: 'a1',
          status: 'adopted',
          trigger: 'manual',
          sessionIds: [],
          snapshotDigest: 'sha256:x',
          createdAt: '2026-07-24T00:00:00Z'
        }
      ]
    })
    expect(dto.dreams).toHaveLength(1)
    expect(dto.dreams[0]).toMatchObject({ dreamId: 'drm-1', status: 'adopted', endedAt: null })
  })

  it('keeps a staged-files listing (exists:false is data)', () => {
    expect(toDreamFilesDto({ agentId: 'a1', dreamId: 'd', exists: false, entries: [] })).toEqual({
      exists: false,
      files: []
    })
    expect(
      toDreamFilesDto({
        agentId: 'a1',
        dreamId: 'd',
        exists: true,
        entries: [{ name: 'MEMORY.md', size: 12, mtime: '2026-07-24T00:00:00Z' }]
      })
    ).toEqual({ exists: true, files: [{ name: 'MEMORY.md', size: 12, mtime: '2026-07-24T00:00:00Z' }] })
  })

  it('null-coalesces a staged file slice; exists:false stays data', () => {
    expect(toDreamFileDto({ agentId: 'a1', dreamId: 'd', path: 'prefs.md', exists: false })).toEqual({
      path: 'prefs.md',
      exists: false,
      size: null,
      mtime: null,
      content: null,
      offset: null,
      nextOffset: null,
      truncated: null
    })
    expect(
      toDreamFileDto({
        agentId: 'a1',
        dreamId: 'd',
        path: 'prefs.md',
        exists: true,
        size: 20,
        mtime: '2026-07-24T00:00:00Z',
        content: '- uses tabs',
        offset: 0,
        nextOffset: 11,
        truncated: true
      })
    ).toMatchObject({ exists: true, content: '- uses tabs', nextOffset: 11, truncated: true })
  })
})

describe('toAgentTasksDto', () => {
  it('keeps the daemon’s order and null-coalesces every optional a running task lacks', () => {
    expect(
      toAgentTasksDto({
        agentId: 'a1',
        sessionId: 'acp-1',
        tracked: true,
        tasks: [
          { id: 't2', state: 'running', subagent: false, startedAt: '2026-08-10T10:00:02Z' },
          {
            id: 't1',
            description: 'run the integration suite',
            state: 'failed',
            subagent: false,
            startedAt: '2026-08-10T10:00:00Z',
            endedAt: '2026-08-10T10:04:00Z',
            detail: 'failed'
          },
          {
            id: 't0',
            state: 'done',
            subagent: true,
            startedAt: '2026-08-10T09:00:00Z',
            endedAt: '2026-08-10T09:01:00Z'
          }
        ],
        truncated: true
      })
    ).toEqual({
      sessionId: 'acp-1',
      tracked: true,
      tasks: [
        {
          id: 't2',
          description: null,
          state: 'running',
          subagent: false,
          startedAt: '2026-08-10T10:00:02Z',
          endedAt: null,
          detail: null
        },
        {
          id: 't1',
          description: 'run the integration suite',
          state: 'failed',
          subagent: false,
          startedAt: '2026-08-10T10:00:00Z',
          endedAt: '2026-08-10T10:04:00Z',
          detail: 'failed'
        },
        {
          id: 't0',
          description: null,
          state: 'done',
          subagent: true,
          startedAt: '2026-08-10T09:00:00Z',
          endedAt: '2026-08-10T09:01:00Z',
          detail: null
        }
      ],
      truncated: true
    })
  })

  it('keeps an untracked session apart from a tracked one holding no tasks', () => {
    const untracked = toAgentTasksDto({
      agentId: 'a1',
      sessionId: 'acp-9',
      tracked: false,
      tasks: [],
      truncated: false
    })
    expect(untracked).toEqual({ sessionId: 'acp-9', tracked: false, tasks: [], truncated: false })
    expect(
      toAgentTasksDto({ agentId: 'a1', sessionId: 'acp-9', tracked: true, tasks: [], truncated: false }).tracked
    ).toBe(true)
  })
})

describe('taskErrorCode / taskFailure', () => {
  const badPayload = (reason?: string): ProtocolError =>
    new ProtocolError('BAD_PAYLOAD', 'task/list failed: unknown agent "a1"', {
      ...(reason ? { details: { reason } } : {})
    })

  it('screaming-snakes the daemon reason under its OWN prefix and ignores a foreign vocabulary', () => {
    expect(taskErrorCode(badPayload('unknown-agent'))).toBe('TASK_UNKNOWN_AGENT')
    // A workspace-only reason is not a task reason: the two enums move independently.
    expect(taskErrorCode(badPayload('path-escape'))).toBeNull()
    expect(taskErrorCode(badPayload())).toBeNull()
  })

  it('answers an agent its daemon does not hold with 404 + code, not the offline 503', () => {
    expect(taskFailure(badPayload('unknown-agent'))).toEqual({
      status: 404,
      error: 'Not Found',
      message: 'agent not found on its daemon',
      code: 'TASK_UNKNOWN_AGENT'
    })
  })

  it('keeps the 503 for a reasonless rejection, an offline daemon, and rethrows a CP bug', () => {
    expect(taskFailure(badPayload())).toEqual({
      status: 503,
      error: 'Service Unavailable',
      message: 'daemon rejected the request: task/list failed: unknown agent "a1"'
    })
    expect(taskFailure(new Error('connection closed'))).toEqual({
      status: 503,
      error: 'Service Unavailable',
      message: 'owning daemon is offline'
    })
    expect(taskFailure(new TypeError('rep.tasks is not iterable'))).toBeNull()
  })

  it('does not invent a 409: the read mutates nothing, so a CONFLICT is not a task answer', () => {
    const conflict = new ProtocolError('CONFLICT', 'the agent is working in this workspace', {
      details: { reason: 'unknown-agent' }
    })
    expect(taskFailure(conflict)).toEqual({
      status: 503,
      error: 'Service Unavailable',
      message: 'daemon rejected the request: the agent is working in this workspace'
    })
  })
})
