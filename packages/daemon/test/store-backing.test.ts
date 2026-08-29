// The Windows suite backs a path-opened store with memory (see `vitest.config.ts`), which is worth
// ~26% of that job. Nothing else fails when the wiring stops reaching the workers — the suite just
// quietly goes back to files — so this asserts the wiring itself.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalStore } from '../src/store/local-store.js'

describe('test store backing', () => {
  it('is memory on Windows and a file everywhere else', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-backing-')), 'local.sqlite')
    const store = await LocalStore.open(path)
    expect(existsSync(path)).toBe(process.platform !== 'win32')
    await store.close()
  })
})
