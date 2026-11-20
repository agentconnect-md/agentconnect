import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MICROSANDBOX_IN_USE_ENV, wantsImagePrePull } from '../src/microsandbox/prepull.js'

describe('the upgrade image pre-pull', () => {
  const pulledRoot = () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-prepull-'))
    mkdirSync(join(root, 'microsandbox'))
    writeFileSync(join(root, 'microsandbox', 'pulled-image'), 'registry.example.test/runtime:old')
    return root
  }

  it('follows the running daemon’s agents when it says whether one runs in microsandbox', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'ac-prepull-'))
    expect(wantsImagePrePull(pulledRoot(), { [MICROSANDBOX_IN_USE_ENV]: '0' })).toBe(false)
    expect(wantsImagePrePull(fresh, { [MICROSANDBOX_IN_USE_ENV]: '1' })).toBe(true)
  })

  it('pre-pulls only where an image was pulled before when no daemon says', () => {
    expect(wantsImagePrePull(pulledRoot(), {})).toBe(true)
    expect(wantsImagePrePull(mkdtempSync(join(tmpdir(), 'ac-prepull-')), {})).toBe(false)
  })
})
