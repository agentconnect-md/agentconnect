import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, readlinkSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneVersions, useVersion } from '../src/version-ops.js'
import { currentVersion, readMeta } from '../src/version-store.js'

const root = () => mkdtempSync(join(tmpdir(), 'ac-vops-'))
const install = (r: string, v: string) => mkdirSync(join(r, 'versions', v), { recursive: true })

describe('useVersion', () => {
  it('points current at an installed version', () => {
    const r = root()
    install(r, '1.0.0')
    useVersion(r, '1.0.0')
    expect(currentVersion(r)).toBe('1.0.0')
  })
  it.skipIf(process.platform !== 'win32')('uses a privilege-free Windows directory junction', () => {
    const r = root()
    install(r, '1.0.0')
    useVersion(r, '1.0.0')
    expect(readlinkSync(join(r, 'current'))).toBe(join(r, 'versions', '1.0.0'))
  })
  it.skipIf(process.platform !== 'win32')('recovers an interrupted swap before preserving the rollback version', () => {
    const r = root()
    install(r, '1.0.0')
    install(r, '2.0.0')
    useVersion(r, '1.0.0')
    renameSync(join(r, 'current'), join(r, 'current.previous'))

    useVersion(r, '2.0.0')

    expect(currentVersion(r)).toBe('2.0.0')
    expect(readMeta(r).previous).toBe('1.0.0')
  })
  it('records the replaced version as previous (rollback target)', () => {
    const r = root()
    install(r, '1.0.0')
    install(r, '1.1.0')
    useVersion(r, '1.0.0')
    useVersion(r, '1.1.0')
    expect(currentVersion(r)).toBe('1.1.0')
    expect(readMeta(r).previous).toBe('1.0.0')
  })
  it('refuses a version that is not installed', () => {
    expect(() => useVersion(root(), '9.9.9')).toThrow(/not installed/)
  })
  it('is a no-op when already current (previous unchanged)', () => {
    const r = root()
    install(r, '1.0.0')
    install(r, '2.0.0')
    useVersion(r, '1.0.0')
    useVersion(r, '2.0.0') // previous = 1.0.0
    useVersion(r, '2.0.0') // no-op
    expect(readMeta(r).previous).toBe('1.0.0')
  })
})

describe('pruneVersions', () => {
  it('never removes current or previous, keeps newest N of the rest', () => {
    const r = root()
    for (const v of ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0']) install(r, v)
    useVersion(r, '1.0.0')
    useVersion(r, '1.4.0') // current=1.4.0, previous=1.0.0
    const removed = pruneVersions(r, 1) // keep 1 prunable (the newest of 1.1/1.2/1.3)
    // current (1.4.0) and previous (1.0.0) protected; of 1.1/1.2/1.3 keep newest 1, remove 2
    expect(removed.length).toBe(2)
    expect(existsSync(join(r, 'versions', '1.4.0'))).toBe(true)
    expect(existsSync(join(r, 'versions', '1.0.0'))).toBe(true)
    for (const v of removed) expect(existsSync(join(r, 'versions', v))).toBe(false)
  })
  it('removes nothing when everything is protected or within keep', () => {
    const r = root()
    install(r, '1.0.0')
    useVersion(r, '1.0.0')
    expect(pruneVersions(r, 2)).toEqual([])
  })
})
