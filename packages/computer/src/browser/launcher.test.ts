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
  utimesSync,
  writeFileSync
} from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  browserNames,
  findBrowser,
  imageFlags,
  launchBrowser,
  lockProfile,
  mainProfile,
  moveProfile,
  profileOwner,
  seedProfile
} from './launcher.js'
import { BASELINE_FILE, forkMerge } from './profile-merge.js'

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

const IMAGE = { AGENTCONNECT_COMPUTER_IMAGE: '1' }

// A stand-in browser that records its arguments, and CHROME_EXTRA_FLAGS when it has one, and exits.
function fakeBrowser(dir: string): { path: string; calls: () => string[][] } {
  const log = join(dir, 'calls.log')
  const path = join(dir, 'chromium')
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$*\${CHROME_EXTRA_FLAGS:+ extra=$CHROME_EXTRA_FLAGS}" >> '${log}'\n`)
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

// The master's one cookie, live until far ahead, and what a profile holds of it.
function setSession(profile: string, value: string): void {
  const db = new DatabaseSync(join(profile, 'Default', 'Cookies'))
  db.prepare('UPDATE cookies SET value = ?, expires_utc = 13600000000000000').run(value)
  db.close()
}
function sessions(profile: string): string[] {
  const db = new DatabaseSync(join(profile, 'Default', 'Cookies'))
  const rows = db.prepare('SELECT value FROM cookies').all() as { value: string }[]
  db.close()
  return rows.map((row) => row.value)
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
  it('copies the master without its locks, caches, port file, open tabs or fork baselines, and marks its first run', () => {
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
    writeFileSync(join(master, 'DevToolsActivePort'), '9222\n/devtools/browser/x')
    writeFileSync(join(master, BASELINE_FILE), '{}')

    seedProfile(master, join(dir, 'desktop'))

    expect(readdirSync(join(dir, 'desktop')).sort()).toEqual(['Default', 'First Run', 'Local State'])
    expect(readFileSync(join(dir, 'desktop', 'First Run'), 'utf8')).toBe('')
    expect(readdirSync(join(dir, 'desktop', 'Default')).sort()).toEqual(['Cookies', 'Prefs', 'Service Worker'])
    expect(readdirSync(join(dir, 'desktop', 'Default', 'Service Worker'))).toEqual(['ScriptCache'])
  })
})

describe('moveProfile', () => {
  // The image's first start with Chrome (computer-use.md §3.8): Chromium's master moves to browser/main with its tabs.
  function chromiumMaster(dir: string): string {
    const master = masterProfile(dir)
    for (const path of ['Default/Sessions/s', 'Default/Session Storage/x', 'Default/Cache/data', 'GPUCache/x']) {
      mkdirSync(join(master, path, '..'), { recursive: true })
      writeFileSync(join(master, path), 'x')
    }
    writeFileSync(join(master, 'DevToolsActivePort'), '9222\n/devtools/browser/x')
    if (posix) symlinkSync(`${hostname()}-1`, join(master, 'SingletonLock'))
    return master
  }

  it('copies the profile with its open tabs, without locks, caches or the port file, and marks its first run', async () => {
    const dir = temp()
    const master = chromiumMaster(dir)
    const target = join(dir, 'data', 'browser', 'main')

    expect(await moveProfile(master, target)).toBe(true)

    expect(readdirSync(target).sort()).toEqual(['Default', 'First Run', 'Local State'])
    expect(readdirSync(join(target, 'Default')).sort()).toEqual(['Cookies', 'Session Storage', 'Sessions'])
    expect(existsSync(master)).toBe(true)
    expect(existsSync(`${target}.moving`)).toBe(false)
  })

  it('leaves an existing profile alone, and does nothing without a source', async () => {
    const dir = temp()
    const master = chromiumMaster(dir)
    const target = join(dir, 'main')
    mkdirSync(target)
    writeFileSync(join(target, 'Local State'), '{"kept":true}')

    expect(await moveProfile(master, target)).toBe(false)
    expect(readdirSync(target)).toEqual(['Local State'])
    expect(await moveProfile(join(dir, 'missing'), join(dir, 'other'))).toBe(false)
    expect(existsSync(join(dir, 'other'))).toBe(false)
  })

  it('starts an interrupted copy over instead of taking it for the profile', async () => {
    const dir = temp()
    const master = chromiumMaster(dir)
    const target = join(dir, 'main')
    mkdirSync(join(`${target}.moving`, 'Default'), { recursive: true })
    writeFileSync(join(`${target}.moving`, 'Default', 'half-copied'), 'x')

    expect(await moveProfile(master, target)).toBe(true)
    expect(existsSync(join(target, 'Default', 'half-copied'))).toBe(false)
    expect(existsSync(join(target, 'Default', 'Cookies'))).toBe(true)
    expect(await moveProfile(master, target)).toBe(false)
  })

  it('carries forked profiles over to the new master, so a cookie one deleted before the move stays deleted', async () => {
    const dir = temp()
    const master = chromiumMaster(dir)
    setSession(master, 'user')
    const [named, unnamed] = ['d1', 'd2'].map((id) => join(dir, 'desktops', id, 'browser'))
    for (const agent of [named!, unnamed!]) {
      seedProfile(master, agent)
      await forkMerge(agent, [master])
      // The agent logged out on its own desktop.
      const db = new DatabaseSync(join(agent, 'Default', 'Cookies'))
      db.exec('DELETE FROM cookies')
      db.close()
    }
    const target = join(dir, 'data', 'browser', 'main')

    expect(await moveProfile(master, target, [named!])).toBe(true)

    const [report] = await forkMerge(named!, [target])
    expect(report!.firstFork).toBe(false)
    expect(sessions(named!)).toEqual([])
    expect(existsSync(`${named}.launch-lock`)).toBe(false)
    // A profile the move was not told about forks the new master from scratch and takes the cookie back.
    expect((await forkMerge(unnamed!, [target]))[0]!.firstFork).toBe(true)
    expect(sessions(unnamed!)).toEqual(['user'])
  })
})

describe('lockProfile', () => {
  const timings = { staleMs: 300, refreshMs: 50, waitMs: 1_000 }

  it('keeps a held lock fresh, so a launch that runs longer than the stale age is never taken over', async () => {
    const profile = join(temp(), 'browser', 'main')
    const release = await lockProfile(profile, timings)

    // Waits more than three stale ages while the first holds the lock, then gives up rather than removing it.
    await expect(lockProfile(profile, timings)).rejects.toThrow('still running')
    release()
    expect(existsSync(`${profile}.launch-lock`)).toBe(false)
    ;(await lockProfile(profile, timings))()
  })

  it("takes over a crashed launcher's lock that nobody refreshes", async () => {
    const profile = join(temp(), 'main')
    writeFileSync(`${profile}.launch-lock`, '')
    utimesSync(`${profile}.launch-lock`, 0, 0)

    const release = await lockProfile(profile, timings)
    release()
    expect(existsSync(`${profile}.launch-lock`)).toBe(false)
  })
})

describe('the image', () => {
  it('moves the master to browser/main only on the image', () => {
    expect(mainProfile('/data', IMAGE)).toBe(join('/data', 'browser', 'main'))
    expect(mainProfile('/data', {})).toMatch(/\.config[/\\]chromium$/)
  })

  it('looks for Google Chrome first only on the image', () => {
    expect(browserNames(IMAGE).slice(0, 2)).toEqual(['google-chrome-stable', 'google-chrome'])
    expect(browserNames({})[0]).toBe('chromium')
  })

  it("passes the container's flags, and a managed pod's egress, only on the image", () => {
    expect(imageFlags({})).toEqual([])
    expect(imageFlags({ AGENTCONNECT_EGRESS_PORT: '7691' })).toEqual([])
    expect(imageFlags(IMAGE)).toEqual(['--no-sandbox', '--password-store=basic'])
    expect(imageFlags({ ...IMAGE, AGENTCONNECT_EGRESS_PORT: '7691', FORM_FILL_PORT: '7682' })).toEqual([
      '--no-sandbox',
      '--password-store=basic',
      '--proxy-server=http://127.0.0.1:7691',
      '--proxy-bypass-list=<-loopback>;127.0.0.1:7682',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'
    ])
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

  it.skipIf(!posix)("skips another desktop's wrapper, and takes the image's order", () => {
    const dir = temp()
    const main = join(dir, 'main-bin')
    const real = join(dir, 'real')
    mkdirSync(main)
    mkdirSync(real)
    const files: [string, string][] = [
      [join(main, 'google-chrome'), '#!/bin/sh\nexec node daemon.mjs browser --desktop \'main\' -- "$@"\n'],
      [join(real, 'chromium'), '#!/bin/sh\n'],
      [join(real, 'google-chrome'), '\x7fELF']
    ]
    for (const [path, content] of files) {
      writeFileSync(path, content)
      chmodSync(path, 0o755)
    }
    expect(findBrowser(`${main}:${real}`, [], browserNames(IMAGE))).toBe(join(real, 'google-chrome'))
    expect(findBrowser(`${main}:${real}`, [], browserNames({}))).toBe(join(real, 'chromium'))
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

  it.skipIf(!posix)(
    "starts the image's browser with its flags, a first-run mark and no CHROME_EXTRA_FLAGS",
    async () => {
      const dir = temp()
      const browser = fakeBrowser(dir)
      const profile = join(dir, 'browser', 'main')

      await launchBrowser({
        profile,
        sources: [],
        browser: browser.path,
        env: { ...process.env, ...IMAGE, CHROME_EXTRA_FLAGS: `--user-data-dir=${join(dir, 'elsewhere')}` }
      })

      expect(readFileSync(join(profile, 'First Run'), 'utf8')).toBe('')
      await expect
        .poll(() => browser.calls()[0])
        .toEqual([
          `--user-data-dir=${profile}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--hide-crash-restore-bubble',
          '--no-sandbox',
          '--password-store=basic'
        ])
    }
  )

  it.skipIf(!posix)("leaves a profile's port file and chrome://inspect setting alone off the image", async () => {
    const dir = temp()
    const browser = fakeBrowser(dir)
    const profile = join(dir, 'profile')
    mkdirSync(profile, { recursive: true })
    const localState = JSON.stringify({ devtools: { remote_debugging: { 'user-enabled': true }, other: 1 }, x: 2 })
    writeFileSync(join(profile, 'Local State'), localState)
    writeFileSync(join(profile, 'DevToolsActivePort'), '9222\n/devtools/browser/a')

    await launchBrowser({ profile, sources: [], browser: browser.path })

    await expect.poll(() => browser.calls()[0]?.[0]).toBe(`--user-data-dir=${profile}`)
    expect(readFileSync(join(profile, 'Local State'), 'utf8')).toBe(localState)
    expect(existsSync(join(profile, 'DevToolsActivePort'))).toBe(true)
  })

  it.skipIf(!posix)('moves the profile it replaces in before its first start', async () => {
    const dir = temp()
    const old = masterProfile(dir)
    mkdirSync(join(old, 'Default', 'Sessions'))
    writeFileSync(join(old, 'Default', 'Sessions', 'Tabs_1'), 'x')
    const browser = fakeBrowser(dir)
    const profile = join(dir, 'browser', 'main')

    await launchBrowser({ profile, movedFrom: old, sources: [], browser: browser.path, env: IMAGE })

    expect(existsSync(join(profile, 'Default', 'Sessions', 'Tabs_1'))).toBe(true)
    expect(existsSync(join(profile, 'First Run'))).toBe(true)
    await expect.poll(() => browser.calls()[0]?.[0]).toBe(`--user-data-dir=${profile}`)
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
