import { describe, expect, it } from 'vitest'
import { attachRawFileDiffs, restPullRequestFile, trimFileDiffs } from '../src/codehost/pull-files.js'

describe('per-file pull request context', () => {
  it('matches renamed paths with spaces and Git-quoted UTF-8 paths without losing unavailable files', () => {
    const files = [
      restPullRequestFile({
        filename: 'src/new b/name.ts',
        previous_filename: 'src/old b/name.ts',
        status: 'renamed',
        additions: 1,
        deletions: 1
      })!,
      restPullRequestFile({ filename: '新.png', status: 'modified', additions: 0, deletions: 0 })!,
      restPullRequestFile({ filename: 'later.ts', status: 'removed', additions: 0, deletions: 5 })!
    ]
    attachRawFileDiffs(files, {
      text:
        'diff --git a/src/old b/name.ts b/src/new b/name.ts\nrename from src/old b/name.ts\nrename to src/new b/name.ts\n@@ -1 +1 @@\n-old\n+new\n' +
        'diff --git "a/\\346\\226\\260.png" "b/\\346\\226\\260.png"\nBinary files differ\n',
      truncated: true
    })
    expect(files[0]).toMatchObject({
      previousPath: 'src/old b/name.ts',
      status: 'renamed',
      additions: 1,
      deletions: 1,
      diffTruncated: false
    })
    expect(files[0]!.diff).toContain('+new')
    expect(files[0]!.diffUnavailable).toBeUndefined()
    expect(files[1]).toMatchObject({ path: '新.png', diffTruncated: true })
    expect(files[1]!.diff).toContain('Binary files differ')
    expect(files[2]).toMatchObject({
      path: 'later.ts',
      status: 'deleted',
      deletions: 5,
      diff: '',
      diffUnavailable: true
    })
  })

  it('keeps short patches and every file identity through repeated UTF-8 budget reductions', () => {
    const files = [
      restPullRequestFile({
        filename: 'large.ts',
        status: 'modified',
        additions: 5000,
        deletions: 1,
        patch: '@@ -1 +1,5000 @@\n-old\n' + '+界\n'.repeat(5000)
      })!,
      restPullRequestFile({
        filename: 'second.ts',
        status: 'added',
        additions: 5000,
        deletions: 0,
        patch: '@@ -0,0 +1,5000 @@\n' + '+🙂\n'.repeat(5000)
      })!,
      restPullRequestFile({
        filename: 'small.ts',
        status: 'added',
        additions: 1,
        deletions: 0,
        patch: '@@ -0,0 +1 @@\n+ok\n'
      })!
    ]
    const small = files[2]!.diff
    for (const budget of [12 * 1024, 4096, 1024]) {
      expect(trimFileDiffs(files, budget)).toBe(true)
      expect(files.reduce((sum, file) => sum + Buffer.byteLength(file.diff), 0)).toBeLessThanOrEqual(budget)
      expect(files.map(({ path }) => path)).toEqual(['large.ts', 'second.ts', 'small.ts'])
      expect(
        files.slice(0, 2).every((file) => file.diff.length > 0 && file.diffTruncated && !file.diff.includes('�'))
      ).toBe(true)
      expect(files[0]!.additions).toBe(5000)
      expect(files[2]).toMatchObject({ diff: small, diffTruncated: false })
    }
    expect(trimFileDiffs(files, 0)).toBe(true)
    expect(files.every((file) => file.diff === '' && file.diffTruncated)).toBe(true)
    expect(trimFileDiffs(files, 0)).toBe(false)
  })

  it('distinguishes provider omissions from a patch that omits some counted changes', () => {
    expect(restPullRequestFile({ filename: 'binary.png', status: 'added', additions: 0, deletions: 0 })).toMatchObject({
      diffUnavailable: true,
      diffTruncated: false
    })
    expect(
      restPullRequestFile({
        filename: 'partial.ts',
        status: 'added',
        additions: 20,
        deletions: 0,
        patch: '@@ -0,0 +1,20 @@\n+first\n'
      })
    ).toMatchObject({ additions: 20, diffTruncated: true })
  })
})
