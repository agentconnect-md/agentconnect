// `vitest.config.ts` drops WINDOWS_EXCLUDED from the run when the platform is Windows. An entry that
// no longer names a real file excludes nothing, silently — so the file it was meant to keep out would
// come back and fail the Windows job, or a since-fixed file would stay out of it forever unnoticed.
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WINDOWS_EXCLUDED } from '../vitest.config.js'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

describe('Windows test exclusions', () => {
  it('names files that exist', () => {
    expect(WINDOWS_EXCLUDED.filter((file) => !existsSync(join(packageRoot, file)))).toEqual([])
  })

  it('lists each file once', () => {
    expect([...new Set(WINDOWS_EXCLUDED)]).toEqual(WINDOWS_EXCLUDED)
  })
})
