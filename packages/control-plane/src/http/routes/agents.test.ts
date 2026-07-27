/**
 * Workspace REP → HTTP DTO mappers (unit, no I/O) — the null-coalescing fold at
 * the wire/HTTP boundary. Optional wire fields (absent = "not applicable") must
 * come out as explicit `null`s so the zod response schema passes serialization.
 */
import { describe, it, expect } from 'vitest'
import {
  toWorkspaceFilesDto,
  toWorkspaceFileDto,
  toWorkspaceGitStatusDto,
  toWorkspaceGitPullDto,
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
      size: null,
      mtime: null,
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
          files: [{ path: 'a.ts', index: 'M', workingDir: ' ' }],
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
      files: [{ path: 'a.ts', index: 'M', workingDir: ' ' }],
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
