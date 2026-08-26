import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { currentVersion, isInstalled, listInstalled, readMeta, writeMeta } from '../src/version-store.js'

const root = () => mkdtempSync(join(tmpdir(), 'ac-vstore-'))

describe('readMeta / writeMeta', () => {
  it('defaults to stable channel + no previous when absent', () => {
    expect(readMeta(root())).toEqual({ channel: 'stable', previous: null })
  })
  it('round-trips channel + previous', () => {
    const r = root()
    writeMeta(r, { channel: 'rc', previous: '1.2.0' })
    expect(readMeta(r)).toEqual({ channel: 'rc', previous: '1.2.0' })
    expect(readFileSync(join(r, 'versions.json'), 'utf8')).toContain('"channel": "rc"')
  })
  it('falls back to defaults on a corrupt file', () => {
    const r = root()
    writeFileSync(join(r, 'versions.json'), '{ not json')
    expect(readMeta(r)).toEqual({ channel: 'stable', previous: null })
  })
  it('coerces an unknown channel to stable', () => {
    const r = root()
    writeFileSync(join(r, 'versions.json'), JSON.stringify({ channel: 'weird', previous: 42 }))
    expect(readMeta(r)).toEqual({ channel: 'stable', previous: null })
  })
})

describe('listInstalled', () => {
  it('lists version dirs, ignoring .tmp and files', () => {
    const r = root()
    mkdirSync(join(r, 'versions', '1.0.0'), { recursive: true })
    mkdirSync(join(r, 'versions', '1.2.0'), { recursive: true })
    mkdirSync(join(r, 'versions', '1.3.0.tmp'), { recursive: true })
    writeFileSync(join(r, 'versions', 'stray.txt'), 'x')
    expect(listInstalled(r)).toEqual(['1.0.0', '1.2.0'])
  })
  it('is empty when versions/ is absent', () => {
    expect(listInstalled(root())).toEqual([])
  })
})

describe('currentVersion', () => {
  it('reads the basename of the current symlink target', () => {
    const r = root()
    mkdirSync(join(r, 'versions', '1.5.0'), { recursive: true })
    if (process.platform === 'win32') symlinkSync(join(r, 'versions', '1.5.0'), join(r, 'current'), 'junction')
    else symlinkSync('versions/1.5.0', join(r, 'current'))
    expect(currentVersion(r)).toBe('1.5.0')
  })
  it('is null when no current symlink exists', () => {
    expect(currentVersion(root())).toBeNull()
  })
})

describe('isInstalled', () => {
  it('reflects the presence of a version dir', () => {
    const r = root()
    mkdirSync(join(r, 'versions', '2.0.0'), { recursive: true })
    expect(isInstalled(r, '2.0.0')).toBe(true)
    expect(isInstalled(r, '9.9.9')).toBe(false)
  })
})
