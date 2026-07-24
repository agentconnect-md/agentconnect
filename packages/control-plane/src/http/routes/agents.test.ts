/**
 * Workspace REP → HTTP DTO mappers (unit, no I/O) — the null-coalescing fold at
 * the wire/HTTP boundary. Optional wire fields (absent = "not applicable") must
 * come out as explicit `null`s so the zod response schema passes serialization.
 */
import { describe, it, expect } from 'vitest'
import { toWorkspaceFilesDto, toWorkspaceFileDto, toWorkspaceGitStatusDto, toWorkspaceGitPullDto } from './agents.js'

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
