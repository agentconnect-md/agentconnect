import { describe, expect, it, vi } from 'vitest'
import { menuBarMenu, startMenuBar, type Menu, type MenuBarFacts, type MenuBarHost } from './menu-bar.js'
import type { TrayState } from './linux/tray.js'
import type { HelperTray, HelperTrayOptions } from './tray-helper.js'

const READY: TrayState = { tone: 'online', status: 'ready, no agent in control', canStop: true, canResume: false }
const FACTS: MenuBarFacts = {
  name: 'macos.shared',
  version: '2.7.0',
  appVersion: '2.7.0-rc.7',
  controlPlane: { state: 'connected', host: 'api.example.com' },
  screenRecording: 'allowed',
  accessibility: 'allowed',
  driver: { version: '0.35.2', running: true },
  ffmpeg: { version: 'b6.1.1', installed: true, installable: true },
  startAtLogin: true
}

const item = (menu: Menu, prefix: string) => menu.items.find((entry) => entry.title.startsWith(prefix))!

describe('menu bar menu', () => {
  it('shows the Windows service and who answers UAC prompts in place of the macOS grants', () => {
    const windows = menuBarMenu(READY, {
      ...FACTS,
      screenRecording: undefined,
      accessibility: undefined,
      windows: { service: true, firewall: 'allowed', adminPrompts: { mode: 'people', editable: true } }
    })
    const rows = windows.items.map((entry) => (entry.separator ? '---' : `${entry.mark ?? ''} ${entry.title}`.trim()))
    expect(rows.slice(4, 10)).toEqual([
      'ok Control Plane (api.example.com): connected',
      'ok Service: running as SYSTEM',
      'ok Windows Firewall: direct video allowed',
      'Administrator Prompts: People Approve Each One',
      'ok Cua Driver 0.35.2: running',
      'ok ffmpeg b6.1.1: installed'
    ])
    expect(
      item(windows, 'Administrator Prompts').items?.map((entry) => [entry.id, entry.checked, entry.enabled])
    ).toEqual([
      ['admin-prompts:people', true, true],
      ['admin-prompts:agent', false, true],
      ['admin-prompts:approve', false, true],
      ['admin-prompts:deny', false, true]
    ])
    expect(rows).toContain('Start at Sign-in')
    expect(item(windows, 'Uninstall').confirm?.message).toContain('administrator prompt')
    const revoked = menuBarMenu(READY, {
      ...FACTS,
      controlPlane: { state: 'revoked' },
      windows: { service: false }
    })
    expect(item(revoked, 'Control Plane').title).toContain('add this computer again')
    expect(item(revoked, 'Service')).toMatchObject({ mark: 'warn' })
    expect(item(revoked, 'Administrator prompts')).toMatchObject({ mark: 'warn', enabled: false })
  })

  it('offers to add the firewall rule whenever direct video is not allowed, and says when the rules cannot be read', () => {
    const row = (firewall?: 'allowed' | 'blocked' | 'missing' | 'uncovered') =>
      item(
        menuBarMenu(READY, { ...FACTS, windows: { service: true, ...(firewall ? { firewall } : {}) } }),
        'Windows Firewall'
      )
    expect(row('allowed')).toMatchObject({ mark: 'ok', enabled: false })
    expect(row('allowed').id).toBeUndefined()
    for (const [state, title] of [
      ['missing', 'Windows Firewall: no rule for direct video, click to allow'],
      ['blocked', 'Windows Firewall: blocks direct video, click to allow'],
      ['uncovered', 'Windows Firewall: blocks direct video on this network, click to allow']
    ] as const)
      expect(row(state)).toEqual({ id: 'firewall', title, mark: 'fail' })
    expect(row()).toMatchObject({ title: 'Windows Firewall: cannot read the rules', mark: 'warn', enabled: false })
    expect(menuBarMenu(READY, { ...FACTS, windows: { service: true, firewall: 'missing' } }).badge).toBe('error')
  })

  it('shows a waiting prompt and a helper problem, and locks the modes while the Control Plane is away', () => {
    const menu = menuBarMenu(READY, {
      ...FACTS,
      windows: {
        service: true,
        adminPrompts: {
          mode: 'agent',
          editable: false,
          locked: 'Connect to the Control Plane to change this',
          pending: 'Windows Command Processor',
          problem: 'the administrator prompt helper exited (code 1)'
        }
      }
    })
    expect(item(menu, 'Administrator prompt waiting')).toMatchObject({
      title: 'Administrator prompt waiting: Windows Command Processor',
      mark: 'warn'
    })
    expect(item(menu, 'Administrator prompts:')).toMatchObject({ mark: 'fail' })
    const modes = item(menu, 'Administrator Prompts').items!
    expect(modes.filter((entry) => entry.id).every((entry) => entry.enabled === false)).toBe(true)
    expect(modes.at(-1)).toMatchObject({ title: 'Connect to the Control Plane to change this', enabled: false })
    expect(item(menu, 'Administrator Prompts').title).toBe('Administrator Prompts: Agent Decides')
  })

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
        screenRecording: 'off',
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
    const stale = menuBarMenu(READY, { ...FACTS, screenRecording: 'stale', accessibility: 'stale' })
    expect(item(stale, 'Screen Recording')).toMatchObject({ id: 'reset-screen-recording', mark: 'fail' })
    expect(item(stale, 'Device Control').id).toBe('reset-accessibility')
    expect(item(broken, 'Cua Driver').title).toContain('click to reinstall')
    expect(item(broken, 'ffmpeg')).toMatchObject({ id: 'ffmpeg', mark: 'fail' })
    expect(item(broken, 'Start at Login').checked).toBe(false)

    const installing = menuBarMenu(READY, FACTS, new Set(['ffmpeg', 'control-plane'] as const))
    expect(item(installing, 'ffmpeg')).toMatchObject({ mark: 'progress', enabled: false })
    expect(item(installing, 'Control Plane')).toMatchObject({ mark: 'progress', enabled: false })
    expect(healthy.badge).toBeUndefined()
    expect(broken.badge).toBe('paused')
    expect(menuBarMenu(READY, { ...FACTS, screenRecording: 'off' })).toMatchObject({ badge: 'error' })
    expect(menuBarMenu({ ...READY, tone: 'busy' }, { ...FACTS, screenRecording: 'off' }).badge).toBe('busy')
    expect(
      menuBarMenu(READY, { ...FACTS, ffmpeg: { ...FACTS.ffmpeg, installed: false, installable: false } }).badge
    ).toBe(undefined)
    const revoked = menuBarMenu(READY, { ...FACTS, controlPlane: { state: 'revoked' } })
    expect(item(revoked, 'Control Plane')).toMatchObject({ mark: 'fail', enabled: false })
  })
})

function harness(facts: Partial<MenuBarFacts> = {}, extra: Partial<MenuBarHost> = {}) {
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
    resetGrant: (grant) => calls.push(`reset ${grant}`),
    setStartAtLogin: (on) => {
      calls.push(`startAtLogin ${on}`)
      current = { ...current, startAtLogin: on }
    },
    openLogs: () => calls.push('logs'),
    uninstall: () => calls.push('uninstall'),
    quit: () => calls.push('quit'),
    restart: () => calls.push('restart'),
    log: () => undefined,
    ...extra
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
  it('sets who answers UAC prompts from the submenu through the host, showing it saving meanwhile', async () => {
    let finish!: () => void
    const setAdminPrompts = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    const h = harness(
      { windows: { service: true, adminPrompts: { mode: 'people', editable: true } } },
      { setAdminPrompts }
    )
    await expect.poll(() => h.menus.length).toBeGreaterThan(0)
    h.click('admin-prompts:deny')
    h.click('admin-prompts:bogus')
    expect(setAdminPrompts).toHaveBeenCalledTimes(1)
    expect(setAdminPrompts).toHaveBeenCalledWith('deny')
    expect(item(h.menus.at(-1)!, 'Administrator Prompts').title).toBe('Administrator Prompts: saving…')
    finish()
    await expect.poll(() => item(h.menus.at(-1)!, 'Administrator Prompts').title).not.toContain('saving')
  })

  it('adds the firewall rule through the host, showing it in progress meanwhile', async () => {
    let finish!: () => void
    const allowFirewall = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    const h = harness({ windows: { service: true, firewall: 'missing' } }, { allowFirewall })
    await expect.poll(() => h.menus.length).toBeGreaterThan(0)
    h.click('firewall')
    h.click('firewall')
    expect(allowFirewall).toHaveBeenCalledTimes(1)
    expect(item(h.menus.at(-1)!, 'Windows Firewall')).toMatchObject({ mark: 'progress', enabled: false })
    finish()
    await expect.poll(() => item(h.menus.at(-1)!, 'Windows Firewall').mark).toBe('fail')
  })

  it('runs each item in the daemon and redraws with what changed', async () => {
    const h = harness({ ffmpeg: { version: 'b6.1.1', installed: false, installable: true }, startAtLogin: true })
    await expect.poll(() => h.menus.length).toBeGreaterThan(0)
    for (const id of [
      'stop',
      'resume',
      'screen-recording',
      'accessibility',
      'reset-screen-recording',
      'reset-accessibility',
      'logs',
      'uninstall',
      'quit'
    ])
      h.click(id)
    expect(h.calls).toEqual([
      'stop',
      'resume',
      'settings screenRecording',
      'settings accessibility',
      'reset screenRecording',
      'reset accessibility',
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
