import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { autoPrune, pruneVersions, useVersion } from '../src/version-ops.js'
import { currentVersion, listInstalled, readMeta } from '../src/version-store.js'

const root = () => mkdtempSync(join(tmpdir(), 'ac-vops-'))
const install = (r: string, v: string) => mkdirSync(join(r, 'versions', v), { recursive: true })
// A pid that has certainly exited: a child we already reaped.
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid ?? 0x7ffffff

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
  it('never removes current or previous, keeps the newest N in total', () => {
    const r = root()
    for (const v of ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0']) install(r, v)
    useVersion(r, '1.0.0')
    useVersion(r, '1.4.0') // current=1.4.0, previous=1.0.0
    const removed = pruneVersions(r, 3)
    // current + previous take 2 of the 3 slots; of 1.1/1.2/1.3 only the newest survives
    expect(removed.length).toBe(2)
    expect(existsSync(join(r, 'versions', '1.4.0'))).toBe(true)
    expect(existsSync(join(r, 'versions', '1.0.0'))).toBe(true)
    for (const v of removed) expect(existsSync(join(r, 'versions', v))).toBe(false)
  })
  it('defaults to keeping three versions in total', () => {
    const r = root()
    for (const v of ['1.0.0', '1.1.0', '1.2.0', '1.3.0']) install(r, v)
    useVersion(r, '1.3.0') // current only — previous unset, so 3 slots for 1.3.0 + 2 others
    const removed = pruneVersions(r)
    expect(removed).toEqual(['1.0.0'])
    expect(listInstalled(r)).toEqual(['1.1.0', '1.2.0', '1.3.0'])
  })
  it('keeps current and previous even when keep is smaller than the protected set', () => {
    const r = root()
    for (const v of ['1.0.0', '1.1.0', '1.2.0']) install(r, v)
    useVersion(r, '1.0.0')
    useVersion(r, '1.2.0') // current=1.2.0, previous=1.0.0
    expect(pruneVersions(r, 1)).toEqual(['1.1.0'])
    expect(listInstalled(r)).toEqual(['1.0.0', '1.2.0'])
  })
  it('ignores a previous that is no longer installed when counting slots', () => {
    const r = root()
    for (const v of ['1.0.0', '1.1.0', '1.2.0']) install(r, v)
    useVersion(r, '1.0.0')
    useVersion(r, '1.2.0')
    rmSync(join(r, 'versions', '1.0.0'), { recursive: true })
    expect(pruneVersions(r, 2)).toEqual([]) // current=1.2.0 + 1.1.0 fill the two slots
  })
  it('never removes a version named in `protect`, even with no slot left', () => {
    const r = root()
    for (const v of ['1.0.0', '1.1.0', '3.0.0']) install(r, v)
    useVersion(r, '1.0.0')
    useVersion(r, '1.1.0') // current=1.1.0, previous=1.0.0 — both slots of `keep: 2` taken
    expect(pruneVersions(r, 2, ['3.0.0'])).toEqual([])
    expect(listInstalled(r)).toEqual(['1.0.0', '1.1.0', '3.0.0'])
  })
  it('removes nothing when everything is protected or within keep', () => {
    const r = root()
    install(r, '1.0.0')
    useVersion(r, '1.0.0')
    expect(pruneVersions(r, 3)).toEqual([])
  })
})

describe('autoPrune', () => {
  it('defers while a live daemon may still be running an older bundle', () => {
    const r = root()
    for (const v of ['1.0.0', '1.1.0', '1.2.0', '1.3.0']) install(r, v)
    useVersion(r, '1.3.0')
    writeFileSync(join(r, 'daemon.lock'), `${process.pid}\n`)
    const lines: string[] = []
    expect(autoPrune(r, (m) => lines.push(m))).toEqual([])
    expect(listInstalled(r)).toEqual(['1.0.0', '1.1.0', '1.2.0', '1.3.0'])
    expect(lines.join('\n')).toContain(`daemon pid ${process.pid} is still running`)
    // …but a caller that just restarted the daemon onto `current` knows better.
    expect(autoPrune(r, (m) => lines.push(m), { assumeIdle: true })).toEqual(['1.0.0'])
  })
  it('prunes when the recorded daemon pid is gone', () => {
    const r = root()
    for (const v of ['1.0.0', '1.1.0', '1.2.0', '1.3.0']) install(r, v)
    useVersion(r, '1.3.0')
    writeFileSync(join(r, 'daemon.lock'), `${deadPid()}\n`)
    expect(autoPrune(r, () => {})).toEqual(['1.0.0'])
  })
  it('does nothing at keep 0', () => {
    const r = root()
    for (const v of ['1.0.0', '1.1.0', '1.2.0', '1.3.0']) install(r, v)
    useVersion(r, '1.3.0')
    expect(autoPrune(r, () => {}, { keep: 0 })).toEqual([])
    expect(listInstalled(r)).toEqual(['1.0.0', '1.1.0', '1.2.0', '1.3.0'])
  })
  it('reports what it removed', () => {
    const r = root()
    for (const v of ['1.0.0', '1.1.0', '1.2.0', '1.3.0']) install(r, v)
    useVersion(r, '1.3.0')
    const lines: string[] = []
    expect(autoPrune(r, (m) => lines.push(m))).toEqual(['1.0.0'])
    expect(lines.join('\n')).toContain('pruned 1 old version(s): 1.0.0')
  })
  it('stays quiet when there is nothing to remove', () => {
    const r = root()
    install(r, '1.0.0')
    useVersion(r, '1.0.0')
    const lines: string[] = []
    expect(autoPrune(r, (m) => lines.push(m))).toEqual([])
    expect(lines).toEqual([])
  })
})
