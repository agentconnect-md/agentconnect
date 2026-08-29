// The Windows suite backs a path-opened store with memory (see `vitest.config.ts`). Nothing else
// fails when that wiring stops reaching the workers — the suite quietly goes back to files and
// gives the gain up — which is exactly what happened once, and took a per-file diff to notice.
// So this asserts the backing that resulted, not the variable that was supposed to cause it.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalStore } from '../src/store/local-store.js'

describe('test store backing', () => {
  it('follows the flag the config sets', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-backing-')), 'local.sqlite')
    const store = await LocalStore.open(path)
    expect(existsSync(path)).toBe(process.env.AGENTCONNECT_TEST_STORE_MEMORY !== '1')
    await store.close()
  })
})
