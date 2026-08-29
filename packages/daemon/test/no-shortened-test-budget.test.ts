// A per-test budget can only shorten `testTimeout`, never extend it, so one written at or under the
// configured default is dead weight — and it expires first on the slowest platform, which is how a
// Windows-only flake reads as a hang in a file nobody changed. Budgets ABOVE it are deliberate.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE_TEST_TIMEOUT } from '../vitest.config.js'

const testRoot = fileURLToPath(new URL('.', import.meta.url))
const budget = /^\s*\}, ([0-9_]+)\)$/gm

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return testFiles(path)
    return entry.name.endsWith('.test.ts') ? [path] : []
  })
}

describe('per-test timeout budgets', () => {
  it('never restate what the configured default already grants', () => {
    const shortened = testFiles(testRoot).flatMap((path) =>
      [...readFileSync(path, 'utf8').matchAll(budget)]
        .map((match) => ({ written: match[1] ?? '', ms: Number((match[1] ?? '').replaceAll('_', '')) }))
        // A zero is a `setTimeout` closing on its own line, not a budget.
        .filter(({ ms }) => ms > 0 && ms <= BASE_TEST_TIMEOUT)
        .map(({ written }) => `${path.slice(testRoot.length)}: ${written}`)
    )
    expect(shortened).toEqual([])
  })
})
