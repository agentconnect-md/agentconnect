// The `daemon` project runs with `isolate: false`, which shares one module registry per worker. A
// `vi.mock` call is registered per file but rewires the registry, so a file that mocks while sharing
// either misses its own mock or leaks it into a later file — and both fail in ways that read as
// product bugs (`workspace.test.ts` surfaced as "fatal: not a git repository", because real git ran).
//
// vitest.config.ts therefore routes the mocking files to a second, isolated project. This test is
// what keeps that list honest: add `vi.mock` to a file and it fails here, at the seam, instead of
// somewhere unrelated depending on which worker happened to run the two files together.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MOCKING_TESTS } from '../vitest.config.js'

const testRoot = fileURLToPath(new URL('.', import.meta.url))

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return testFiles(full)
    return entry.endsWith('.test.ts') ? [full] : []
  })
}

describe('vi.mock routing', () => {
  it('lists exactly the files that call vi.mock', () => {
    const mocking = testFiles(testRoot)
      .filter((file) => /(?<![\w.])vi\s*\.\s*mock\s*\(/.test(readFileSync(file, 'utf8')))
      .map((file) => `test/${relative(testRoot, file)}`.replaceAll('\\', '/'))
      .sort()

    // Both directions matter: an unlisted mocking file breaks under the shared registry, and a
    // listed file that no longer mocks pays for isolation it does not need.
    expect(mocking).toEqual([...MOCKING_TESTS].sort())
  })
})
