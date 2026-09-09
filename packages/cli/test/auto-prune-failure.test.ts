import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// autoPrune's whole point is that cleanup failure is non-fatal — mock the removal to fail.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  // Only version-directory removal fails; useVersion's own symlink cleanup must still work.
  const rmSync: typeof actual.rmSync = (path, opts) => {
    if (/[\\/]versions[\\/]/.test(String(path))) throw new Error('EBUSY')
    return actual.rmSync(path, opts)
  }
  return { ...actual, rmSync }
})

const { autoPrune, useVersion } = await import('../src/version-ops.js')
const { listInstalled } = await import('../src/version-store.js')

describe('autoPrune failure', () => {
  it('reports the failure and leaves the store untouched', () => {
    const r = mkdtempSync(join(tmpdir(), 'ac-vprune-'))
    for (const v of ['1.0.0', '1.1.0', '1.2.0', '1.3.0']) mkdirSync(join(r, 'versions', v), { recursive: true })
    useVersion(r, '1.3.0')
    const lines: string[] = []
    expect(autoPrune(r, (m) => lines.push(m))).toEqual([])
    expect(lines.join('\n')).toContain('could not prune old versions: EBUSY')
    expect(listInstalled(r)).toEqual(['1.0.0', '1.1.0', '1.2.0', '1.3.0'])
  })
})
