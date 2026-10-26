import { describe, expect, it } from 'vitest'
import { menuBarMenu, startMenuBar, type Menu, type MenuBarFacts, type MenuBarHost } from './menu-bar.js'
import type { TrayState } from './linux/tray.js'
import type { HelperTray, HelperTrayOptions } from './tray-helper.js'

const READY: TrayState = { tone: 'online', status: 'ready, no agent in control', canStop: true, canResume: false }
const FACTS: MenuBarFacts = {
  name: 'macos.shared',
  version: '2.7.0',
  appVersion: '2.7.0-rc.7',
  controlPlane: { state: 'connected', host: 'api.example.com' },
  screenRecording: true,
  accessibility: true,
  driver: { version: '0.35.2', running: true },
  ffmpeg: { version: 'b6.1.1', installed: true, installable: true },
  startAtLogin: true
}

const item = (menu: Menu, prefix: string) => menu.items.find((entry) => entry.title.startsWith(prefix))!

describe('menu bar menu', () => {
  it('marks each part of the desktop and offers the fix only where something is missing', () => {
    const healthy = menuBarMenu(READY, FACTS)
    expect(
      healthy.items.map((entry) => (entry.separator ? '---' : `${entry.mark ?? ''} ${entry.title}`.trim()))
    ).toEqual([
      'AgentConnect Computer · macos.shared',
      'Agents: ready, no agent in control',
      'Stop All Agent Input',
      '---',
      'ok Control Plane (api.example.com): connected',
      'ok Screen Recording: allowed',
      'ok Device Control (Accessibility): allowed',
      'ok Cua Driver 0.35.2: running',
      'ok ffmpeg b6.1.1: installed',
      '---',
      'Start at Login',
      'Open Logs',
      'Version 2.7.0 (app 2.7.0-rc.7)',
      '---',
      'Uninstall…',
      'Quit AgentConnect Computer'
    ])
    expect(item(healthy, 'Control Plane').enabled).toBe(false)
    expect(item(healthy, 'Start at Login').checked).toBe(true)
    expect(item(healthy, 'Uninstall').confirm?.button).toBe('Uninstall')
    expect(item(healthy, 'Quit').confirm?.button).toBe('Quit')

    const broken = menuBarMenu(
      { tone: 'paused', status: 'paused, stopped from the tray', canStop: false, canResume: true },
      {
        ...FACTS,
        controlPlane: { state: 'disconnected' },
        screenRecording: false,
        accessibility: undefined,
        driver: { version: '0.35.2', running: false },
        ffmpeg: { version: 'b6.1.1', installed: false, installable: true },
        startAtLogin: false
      }
    )
    expect(broken.items[2]).toEqual({ id: 'resume', title: 'Resume Agent Input' })
    expect(item(broken, 'Control Plane')).toMatchObject({ mark: 'fail', enabled: true })
    expect(item(broken, 'Screen Recording')).toMatchObject({ id: 'screen-recording', mark: 'fail' })
    expect(item(broken, 'Device Control')).toMatchObject({ mark: 'warn' })
    expect(item(broken, 'Cua Driver').title).toContain('click to reinstall')
    expect(item(broken, 'ffmpeg')).toMatchObject({ id: 'ffmpeg', mark: 'fail' })
    expect(item(broken, 'Start at Login').checked).toBe(false)

    const installing = menuBarMenu(READY, FACTS, new Set(['ffmpeg', 'control-plane'] as const))
    expect(item(installing, 'ffmpeg')).toMatchObject({ mark: 'progress', enabled: false })
    expect(item(installing, 'Control Plane')).toMatchObject({ mark: 'progress', enabled: false })
    const revoked = menuBarMenu(READY, { ...FACTS, controlPlane: { state: 'revoked' } })
    expect(item(revoked, 'Control Plane')).toMatchObject({ mark: 'fail', enabled: false })
  })
})

function harness(facts: Partial<MenuBarFacts> = {}) {
  const calls: string[] = []
  const menus: Menu[] = []
  let options: HelperTrayOptions | undefined
  let reconnects = true
  let current: MenuBarFacts = { ...FACTS, ...facts }
  const host: MenuBarHost = {
    facts: async () => current,
    stop: () => calls.push('stop'),
    resume: () => calls.push('resume'),
    reconnect: async () => (calls.push('reconnect'), reconnects),
    installDriver: async () => void calls.push('installDriver'),
    installFfmpeg: async () => {
      calls.push('installFfmpeg')
      current = { ...current, ffmpeg: { ...current.ffmpeg, installed: true } }
    },
    openSettings: (pane) => calls.push(`settings ${pane}`),
    setStartAtLogin: (on) => {
      calls.push(`startAtLogin ${on}`)
      current = { ...current, startAtLogin: on }
    },
    openLogs: () => calls.push('logs'),
    uninstall: () => calls.push('uninstall'),
    quit: () => calls.push('quit'),
    restart: () => calls.push('restart'),
    log: () => undefined
  }
  const bar = startMenuBar('helper', host, READY, (_path, given) => {
    options = given
    return {
      problem: undefined,
      update: (menu: Menu) => menus.push(menu),
      close: () => undefined
    } as unknown as HelperTray
  })
  return {
    bar,
    calls,
    menus,
    click: (id: string) => options!.onClick(id),
    options: () => options!,
    fail: () => (reconnects = false)
  }
}

describe('menu bar actions', () => {
  it('runs each item in the daemon and redraws with what changed', async () => {
    const h = harness({ ffmpeg: { version: 'b6.1.1', installed: false, installable: true }, startAtLogin: true })
    await expect.poll(() => h.menus.length).toBeGreaterThan(0)
    for (const id of ['stop', 'resume', 'screen-recording', 'accessibility', 'logs', 'uninstall', 'quit']) h.click(id)
    expect(h.calls).toEqual([
      'stop',
      'resume',
      'settings screenRecording',
      'settings accessibility',
      'logs',
      'uninstall',
      'quit'
    ])
    h.click('ffmpeg')
    expect(item(h.menus.at(-1)!, 'ffmpeg').mark).toBe('progress')
    h.click('ffmpeg')
    await expect.poll(() => item(h.menus.at(-1)!, 'ffmpeg').mark).toBe('ok')
    expect(h.calls.filter((call) => call === 'installFfmpeg')).toHaveLength(1)
    h.click('start-at-login')
    await expect.poll(() => item(h.menus.at(-1)!, 'Start at Login').checked).toBe(false)
    expect(h.calls).toContain('startAtLogin false')
    h.options().onRestart()
    expect(h.calls.at(-1)).toBe('restart')
    h.bar.update({ ...READY, tone: 'busy', status: 'controlled by claude' })
    expect(h.menus.at(-1)!.tone).toBe('busy')
  })

  it('retries the Control Plane, and opens the logs when it stays away', async () => {
    const h = harness({ controlPlane: { state: 'disconnected' } })
    await expect.poll(() => h.menus.length).toBeGreaterThan(0)
    h.click('control-plane')
    await expect.poll(() => h.calls).toEqual(['reconnect'])
    h.fail()
    h.click('control-plane')
    await expect.poll(() => h.calls).toEqual(['reconnect', 'reconnect', 'logs'])
  })
})
