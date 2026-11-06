import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Computer, ComputerError } from '../computer.js'
import type { CuaDriver } from '../driver/client.js'
import { FakeDriver, testConfig } from '../testing.js'
import {
  DesktopManager,
  desktopBrowserPlan,
  desktopEnv,
  desktopProfile,
  isBrowserName,
  loadDesktopState,
  memoryGiB
} from './desktops.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('desktops', () => {
  it('knows the names an agent launches a browser by', () => {
    for (const name of ['chromium', 'Chromium', 'google-chrome', 'Google Chrome', 'chrome', 'browser', 'x-www-browser'])
      expect(isBrowserName(name)).toBe(true)
    for (const name of ['firefox', 'xfce4-terminal', 'libreoffice']) expect(isBrowserName(name)).toBe(false)
  })

  it("starts a desktop's browser from the master and every other desktop's profile, skipping their wrappers", () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ac-desktops-'))
    dirs.push(dataDir)
    mkdirSync(join(dataDir, 'desktops'))
    const now = '2026-11-06T00:00:00.000Z'
    writeFileSync(
      join(dataDir, 'desktops', 'state.json'),
      JSON.stringify({
        version: 1,
        next: 3,
        mainBus: 'unix:path=/run/user/1000/bus',
        master: '/home/u/.config/chromium',
        desktops: {
          'agent-a': { id: 'd1', key: 'agent-a', label: 'agent-a', createdAt: now, lastUsedAt: now },
          'client:b': { id: 'd2', key: 'client:b', label: 'b', createdAt: now, lastUsedAt: now }
        }
      })
    )

    expect(desktopBrowserPlan(dataDir, 'd2')).toEqual({
      profile: desktopProfile(dataDir, 'd2'),
      master: '/home/u/.config/chromium',
      sources: ['/home/u/.config/chromium', desktopProfile(dataDir, 'd1')],
      skip: [join(dataDir, 'desktops', 'd1', 'bin'), join(dataDir, 'desktops', 'd2', 'bin')],
      mainBus: 'unix:path=/run/user/1000/bus'
    })
    expect(() => desktopBrowserPlan(dataDir, 'd9')).toThrow('no desktop d9')

    // With login sharing off (§3.9) the profile is its own: never seeded from the master or merged with another.
    const state = JSON.parse(readFileSync(join(dataDir, 'desktops', 'state.json'), 'utf8')) as Record<string, unknown>
    writeFileSync(join(dataDir, 'desktops', 'state.json'), JSON.stringify({ ...state, shareBrowserLogins: false }))
    expect(desktopBrowserPlan(dataDir, 'd2')).toEqual({
      profile: desktopProfile(dataDir, 'd2'),
      sources: [],
      skip: [join(dataDir, 'desktops', 'd1', 'bin'), join(dataDir, 'desktops', 'd2', 'bin')],
      mainBus: 'unix:path=/run/user/1000/bus'
    })
  })

  it("starts an agent desktop as an Xfce X11 session, without the main GNOME or Wayland session's identity", () => {
    const env = desktopEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      HTTPS_PROXY: 'http://proxy:3128',
      WAYLAND_DISPLAY: 'wayland-0',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      XDG_SESSION_TYPE: 'wayland',
      XDG_CURRENT_DESKTOP: 'GNOME',
      DESKTOP_SESSION: 'gnome',
      GDMSESSION: 'gnome',
      XDG_MENU_PREFIX: 'gnome-',
      GNOME_SETUP_DISPLAY: ':1',
      XMODIFIERS: '@im=ibus',
      QT_IM_MODULE: 'ibus',
      SESSION_MANAGER: 'local/x'
    })
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/u',
      HTTPS_PROXY: 'http://proxy:3128',
      GDK_BACKEND: 'x11',
      QT_QPA_PLATFORM: 'xcb',
      XDG_SESSION_TYPE: 'x11',
      XDG_CURRENT_DESKTOP: 'XFCE',
      XDG_SESSION_DESKTOP: 'xfce',
      DESKTOP_SESSION: 'xfce',
      XDG_MENU_PREFIX: 'xfce-'
    })
  })

  it('starts with no desktops and the default Chromium profile as the master', () => {
    const state = loadDesktopState(join(tmpdir(), 'ac-desktops-missing'))
    expect(state).toMatchObject({ version: 1, next: 1, desktops: {} })
    expect(state.master).toMatch(/\.config[/\\]chromium$/)
  })
})

// A stand-in Xvfb that reports display 99 after a delay and stays up, so a desktop starts without X or Xfce.
function fakeXvfb(delaySeconds = 0): string {
  const bin = mkdtempSync(join(tmpdir(), 'ac-xvfb-'))
  dirs.push(bin)
  writeFileSync(join(bin, 'Xvfb'), `#!/bin/sh\nsleep ${delaySeconds}\necho 99 >&3\nexec sleep 60\n`, { mode: 0o755 })
  return bin
}

// A manager whose desktops run the stand-in Xvfb and a fake driver; PATH is restored by the returned cleanup.
function fakeManager(maxDesktops: number, xvfbDelaySeconds = 0) {
  const bin = fakeXvfb(xvfbDelaySeconds)
  const dataDir = mkdtempSync(join(tmpdir(), 'ac-desktops-'))
  dirs.push(dataDir)
  const path = `${bin}:/usr/bin:/bin`
  const original = process.env.PATH
  process.env.PATH = path
  const config = testConfig({ perAgentDesktops: true, maxDesktops, actionScreenshot: false })
  const manager = new DesktopManager({
    dataDir,
    config,
    support: () => ({ supported: true, session: 'xfce', browser: '/usr/bin/chromium' }),
    self: ['node', 'daemon.mjs'],
    build: () => {
      const driver = new FakeDriver()
      return { driver: driver as unknown as CuaDriver, computer: new Computer({ driver, config }) }
    },
    log: () => undefined,
    env: { PATH: path }
  })
  const restore = async (): Promise<void> => {
    process.env.PATH = original
    await manager.stopAll('test over')
  }
  return { manager, config, restore }
}

describe('switching desktops off', () => {
  it.skipIf(process.platform === 'win32')(
    'stops desktops still starting and refuses the callers waiting on them',
    async () => {
      const { manager, config, restore } = fakeManager(4)
      try {
        const starting = manager.forKey('agent-a', 'Agent A').catch((error: unknown) => error)
        const queued = manager.forKey('agent-b', 'Agent B').catch((error: unknown) => error)
        config.perAgentDesktops = false
        await manager.stopAll('per-agent desktops switched off')

        expect(await starting).toMatchObject({ code: 'unavailable' })
        expect(await queued).toMatchObject({ code: 'unavailable' })
        expect(manager.runningDesktops()).toEqual([])
      } finally {
        await restore()
      }
    }
  )
})

describe('switching desktops off mid-start', () => {
  it.skipIf(process.platform === 'win32')('refuses the caller whose desktop was already starting', async () => {
    const { manager, config, restore } = fakeManager(4, 0.3)
    try {
      const starting = manager.forKey('agent-a', 'Agent A').catch((error: unknown) => error)
      // The start is now waiting on Xvfb, past the checks at its beginning.
      await new Promise((resolve) => setTimeout(resolve, 100))
      config.perAgentDesktops = false
      await manager.stopAll('per-agent desktops switched off')

      expect(await starting).toMatchObject({ code: 'unavailable' })
      expect(manager.runningDesktops()).toEqual([])
    } finally {
      await restore()
    }
  })
})

describe('a full machine', () => {
  it.skipIf(process.platform === 'win32')('refuses another agent as unavailable/desktops_full, not busy', async () => {
    const { manager, restore } = fakeManager(1)
    try {
      const first = await manager.forKey('agent-a', 'Agent A')
      first.computer.acquire('agent-a')
      const refusal = await manager.forKey('agent-b', 'Agent B').catch((error: unknown) => error)
      expect(refusal).toBeInstanceOf(ComputerError)
      expect(refusal).toMatchObject({ code: 'unavailable', details: { reason: 'desktops_full' } })
      // A person's takeover in the viewer holds the desktop as firmly as an agent's lease.
      first.computer.release('agent-a')
      first.computer.takeOver('viewer')
      const whileWatched = await manager.forKey('agent-b', 'Agent B').catch((error: unknown) => error)
      expect(whileWatched).toMatchObject({ code: 'unavailable', details: { reason: 'desktops_full' } })
      first.computer.handBack('viewer')
      // Once the first agent and the person let go, its idle desktop makes room.
      const second = await manager.forKey('agent-b', 'Agent B')
      expect(second.record.id).not.toBe(first.record.id)
      expect(manager.runningDesktops()).toHaveLength(1)
    } finally {
      await restore()
    }
  })
})

describe('memory for one more desktop', () => {
  const GiB = 1024 * 1024 * 1024
  const files = (entries: Record<string, string>) => (path: string) => {
    if (!(path in entries)) throw new Error(`ENOENT ${path}`)
    return entries[path]!
  }
  const meminfo = (gib: number) => `MemTotal: 99 kB\nMemAvailable: ${gib * 1024 * 1024} kB\n`

  it("counts the machine's free memory, or a container limit's headroom when that is less", () => {
    expect(memoryGiB(files({ '/proc/meminfo': meminfo(6.5) }))).toBe(6)
    expect(memoryGiB(files({ '/proc/meminfo': meminfo(6), '/sys/fs/cgroup/memory.max': 'max\n' }))).toBe(6)
    const pod = {
      '/proc/meminfo': meminfo(60),
      '/sys/fs/cgroup/memory.max': `${3 * GiB}\n`,
      '/sys/fs/cgroup/memory.current': `${1.2 * GiB}\n`
    }
    expect(memoryGiB(files(pod))).toBe(1)
    expect(memoryGiB(files({}))).toBe(1)
  })
})
