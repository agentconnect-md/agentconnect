import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { findBrowser, launchBrowser, profileOwner, seedProfile } from './launcher.js'
import { BASELINE_FILE } from './profile-merge.js'

const posix = process.platform !== 'win32'
const dirs: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-launcher-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// A stand-in browser that records its arguments and exits.
function fakeBrowser(dir: string): { path: string; calls: () => string[][] } {
  const log = join(dir, 'calls.log')
  const path = join(dir, 'chromium')
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`)
  chmodSync(path, 0o755)
  const calls = (): string[][] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => line.split(' '))
      : []
  return { path, calls }
}

function masterProfile(dir: string): string {
  const master = join(dir, 'master')
  mkdirSync(join(master, 'Default'), { recursive: true })
  cpSync(join(import.meta.dirname, 'fixtures', 'Cookies'), join(master, 'Default', 'Cookies'))
  writeFileSync(join(master, 'Local State'), '{}')
  return master
}

describe('profileOwner', () => {
  it.skipIf(!posix)('names the live process on this host that holds the profile', () => {
    const dir = temp()
    symlinkSync(`${hostname()}-${process.pid}`, join(dir, 'SingletonLock'))
    expect(profileOwner(dir)).toBe(process.pid)
  })

  it.skipIf(!posix)('ignores a lock from another host or a dead process', () => {
    const other = temp()
    symlinkSync(`elsewhere-${process.pid}`, join(other, 'SingletonLock'))
    expect(profileOwner(other)).toBeUndefined()
    const dead = temp()
    symlinkSync(`${hostname()}-2147483646`, join(dead, 'SingletonLock'))
    expect(profileOwner(dead)).toBeUndefined()
    expect(profileOwner(temp())).toBeUndefined()
  })
})

describe('seedProfile', () => {
  it('copies the master without its locks, caches, open tabs or fork baselines, keeping service worker scripts', () => {
    const dir = temp()
    const master = masterProfile(dir)
    for (const path of [
      'Default/Cache/data',
      'Default/Code Cache/js',
      'GPUCache/x',
      'Default/Sessions/s',
      'Default/Service Worker/ScriptCache/index',
      'Default/Prefs'
    ]) {
      mkdirSync(join(master, path, '..'), { recursive: true })
      writeFileSync(join(master, path), 'x')
    }
    writeFileSync(join(master, 'SingletonCookie'), 'x')
    writeFileSync(join(master, BASELINE_FILE), '{}')

    seedProfile(master, join(dir, 'desktop'))

    expect(readdirSync(join(dir, 'desktop')).sort()).toEqual(['Default', 'Local State'])
    expect(readdirSync(join(dir, 'desktop', 'Default')).sort()).toEqual(['Cookies', 'Prefs', 'Service Worker'])
    expect(readdirSync(join(dir, 'desktop', 'Default', 'Service Worker'))).toEqual(['ScriptCache'])
  })
})

describe('findBrowser', () => {
  it.skipIf(!posix)('finds the real browser past the wrappers', () => {
    const dir = temp()
    const wrappers = join(dir, 'wrappers')
    const real = join(dir, 'real')
    for (const at of [wrappers, real]) {
      mkdirSync(at)
      writeFileSync(join(at, 'chromium'), '#!/bin/sh\n')
      chmodSync(join(at, 'chromium'), 0o755)
    }
    expect(findBrowser(`${wrappers}:${real}`, [wrappers])).toBe(join(real, 'chromium'))
    expect(findBrowser(wrappers, [wrappers])).toBeUndefined()
  })
})

describe('launchBrowser', () => {
  it.skipIf(!posix)('creates the profile from the master, merges, then starts the browser on it', async () => {
    const dir = temp()
    const master = masterProfile(dir)
    const db = new DatabaseSync(join(master, 'Default', 'Cookies'))
    db.exec("UPDATE cookies SET value = 'from-master'")
    db.close()
    const browser = fakeBrowser(dir)
    const profile = join(dir, 'desktops', 'agent-1', 'browser')

    const result = await launchBrowser({
      profile,
      master,
      sources: [master],
      browser: browser.path,
      args: ['https://x.example']
    })

    expect(result.handedOff).toBe(false)
    expect(result.reports).toHaveLength(1)
    expect(existsSync(join(profile, BASELINE_FILE))).toBe(true)
    await expect
      .poll(() => browser.calls()[0])
      .toEqual([
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-crash-restore-bubble',
        'https://x.example'
      ])
    expect(existsSync(`${profile}.launch-lock`)).toBe(false)
  })

  it.skipIf(!posix)('hands the request to a running browser without merging into its profile', async () => {
    const dir = temp()
    const master = masterProfile(dir)
    const profile = join(dir, 'desktop')
    mkdirSync(profile)
    symlinkSync(`${hostname()}-${process.pid}`, join(profile, 'SingletonLock'))
    const browser = fakeBrowser(dir)

    const result = await launchBrowser({ profile, master, sources: [master], browser: browser.path })

    expect(result).toEqual({ handedOff: true, reports: [] })
    expect(existsSync(join(profile, BASELINE_FILE))).toBe(false)
    await expect.poll(() => browser.calls()[0]?.[0]).toBe(`--user-data-dir=${profile}`)
  })

  it.skipIf(!posix)(
    'keeps a second launch waiting until the first browser owns the profile, then hands off',
    async () => {
      const dir = temp()
      const master = masterProfile(dir)
      const profile = join(dir, 'desktop')
      const calls = join(dir, 'calls.log')
      // Like Chromium: takes the profile only after a moment, and a request for an owned profile is handed over.
      const path = join(dir, 'slow-chromium')
      writeFileSync(
        path,
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nprofile="\${1#--user-data-dir=}"\n` +
          `[ -L "$profile/SingletonLock" ] && exit 0\nsleep 0.4\nln -s "${hostname()}-$$" "$profile/SingletonLock"\nexec sleep 5\n`
      )
      chmodSync(path, 0o755)

      const [first, second] = await Promise.all([
        launchBrowser({ profile, master, sources: [master], browser: path }),
        launchBrowser({ profile, master, sources: [master], browser: path })
      ])

      expect([first.handedOff, second.handedOff].sort()).toEqual([false, true])
      const pid = (first.handedOff ? second : first).pid!
      expect(profileOwner(profile)).toBe(pid)
      process.kill(pid)
      await expect.poll(() => readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2)
    }
  )
})
