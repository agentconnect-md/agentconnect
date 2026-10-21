import { describe, expect, it } from 'vitest'
import { CONSOLE_STOP_REASON } from './cp/console-stop.js'
import {
  HOTKEY_STOP_REASON,
  LOCAL_OWNER_STOP_REASON,
  TRAY_STOP_REASON,
  startLocalControls,
  trayState,
  type LocallyControlled
} from './local-controls.js'
import type { X11LocalControls, X11LocalOptions } from './linux/x11-local.js'
import type { Tray, TrayOptions, TrayState } from './linux/tray.js'

class FakeComputer implements LocallyControlled {
  status: 'online' | 'paused' | 'human_in_control' | 'busy' = 'online'
  reason: string | undefined
  human = 0
  holder: string | undefined
  liveStatus() {
    return this.status
  }
  pauseReason() {
    return this.reason
  }
  pause(reason: string) {
    this.status = 'paused'
    this.reason = reason
  }
  resume() {
    this.status = 'online'
    this.reason = undefined
  }
  noteHumanInput() {
    this.human++
  }
  leaseActivity() {
    return this.holder ? { holder: this.holder } : undefined
  }
}

async function start(
  computer: FakeComputer,
  problems: { keyboard?: string; hotkey?: string; tray?: string; x11?: Error } = {},
  stopHotkey = 'Ctrl+Alt+Shift+Escape'
) {
  const hooks: { x11?: X11LocalOptions; tray?: TrayOptions; states: TrayState[] } = { states: [] }
  const controls = await startLocalControls({
    computer,
    refusal: () => undefined,
    stopHotkey,
    log: () => undefined,
    platform: 'linux',
    env: { DISPLAY: ':0' },
    startX11: async (options) => {
      hooks.x11 = options
      if (problems.x11) throw problems.x11
      return {
        keyboardProblem: problems.keyboard,
        hotkeyProblem: problems.hotkey,
        close: () => undefined
      } as unknown as X11LocalControls
    },
    startTray: async (options) => {
      hooks.tray = options
      return {
        problem: problems.tray,
        update: (state: TrayState) => hooks.states.push(state),
        close: () => undefined
      } as unknown as Tray
    }
  })
  return { controls: controls!, hooks }
}

describe('local controls', () => {
  it('runs only in an X11 session on Linux', async () => {
    const computer = new FakeComputer()
    const base = { computer, refusal: () => undefined, stopHotkey: '', log: () => undefined }
    expect(await startLocalControls({ ...base, platform: 'darwin', env: { DISPLAY: ':0' } })).toBeUndefined()
    expect(
      await startLocalControls({ ...base, platform: 'linux', env: { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' } })
    ).toBeUndefined()
    expect(await startLocalControls({ ...base, platform: 'linux', env: {} })).toBeUndefined()
  })

  it('stops from the hotkey or the tray, and feeds key presses to the arbitration', async () => {
    const computer = new FakeComputer()
    const { controls, hooks } = await start(computer)
    expect(hooks.x11!.hotkey?.label).toBe('Ctrl+Alt+Shift+Escape')
    hooks.x11!.onHumanInput()
    expect(computer.human).toBe(1)
    hooks.x11!.onStopHotkey()
    expect(computer.reason).toBe(HOTKEY_STOP_REASON)
    // Already paused: a second Stop changes nothing, so the first reason stands.
    hooks.tray!.onStop()
    expect(computer.reason).toBe(HOTKEY_STOP_REASON)
    hooks.tray!.onResume()
    expect(computer.status).toBe('online')
    hooks.tray!.onStop()
    expect(computer.reason).toBe(TRAY_STOP_REASON)
    controls.update()
    expect(hooks.states.at(-1)).toEqual({ tone: 'paused', status: `paused, ${TRAY_STOP_REASON}`, canResume: true })
    controls.close()
  })

  it('takes the desktop back from a console viewer, but never lifts a console Stop', async () => {
    const computer = new FakeComputer()
    const { hooks } = await start(computer)
    computer.status = 'human_in_control'
    computer.reason = 'remote takeover by alice'
    hooks.tray!.onStop()
    expect(computer.reason).toBe(TRAY_STOP_REASON)
    computer.reason = CONSOLE_STOP_REASON
    hooks.tray!.onResume()
    expect(computer.status).toBe('paused')
  })

  it('reports each control as a doctor check', async () => {
    const healthy = await start(new FakeComputer())
    expect(healthy.controls.keyboard()).toBe(true)
    expect(healthy.controls.checks().map((check) => [check.name, check.status])).toEqual([
      ['keyboard activity', 'ok'],
      ['stop hotkey', 'ok'],
      ['tray', 'ok']
    ])
    const broken = await start(new FakeComputer(), {
      keyboard: 'XInput 2.0 is older than 2.1',
      hotkey: 'Ctrl+Alt+Shift+Escape is taken by another app',
      tray: 'no system tray in this session (no StatusNotifierWatcher)'
    })
    expect(broken.controls.keyboard()).toBe(false)
    expect(broken.controls.checks()).toMatchObject([
      {
        name: 'keyboard activity',
        status: 'warn',
        detail: 'XInput 2.0 is older than 2.1: only pointer movement pauses agents'
      },
      {
        name: 'stop hotkey',
        status: 'warn',
        detail: 'Ctrl+Alt+Shift+Escape: Ctrl+Alt+Shift+Escape is taken by another app'
      },
      { name: 'tray', status: 'warn' }
    ])
    const invalid = await start(new FakeComputer(), {}, 'Hyper+Q')
    expect(invalid.hooks.x11!.hotkey).toBeUndefined()
    expect(invalid.controls.checks()[1]).toMatchObject({
      status: 'warn',
      detail: 'Hyper+Q: "Hyper+Q" is not a valid hotkey'
    })
    const off = await start(new FakeComputer(), { hotkey: 'disabled in config' }, '')
    expect(off.controls.checks()[1]).toMatchObject({ status: 'info', detail: 'disabled in config ("stopHotkey": "")' })
    const noDisplay = await start(new FakeComputer(), { x11: new Error('connect ENOENT') })
    expect(noDisplay.controls.keyboard()).toBe(false)
    expect(noDisplay.controls.checks()[0]!.detail).toContain('cannot open the X display: connect ENOENT')
  })

  it('gives a virtual display no tray', async () => {
    let trays = 0
    const controls = await startLocalControls({
      computer: new FakeComputer(),
      refusal: () => undefined,
      stopHotkey: 'Ctrl+Alt+Shift+Escape',
      headless: true,
      log: () => undefined,
      platform: 'linux',
      env: { DISPLAY: ':99' },
      startX11: async () => ({ close: () => undefined }) as unknown as X11LocalControls,
      startTray: async () => {
        trays++
        return {} as Tray
      }
    })
    expect(trays).toBe(0)
    expect(controls!.checks()[2]).toMatchObject({ name: 'tray', status: 'info' })
    controls!.close()
  })

  it('shows who holds the desktop and whether agents can act', () => {
    const computer = new FakeComputer()
    expect(trayState(computer, undefined)).toEqual({
      tone: 'online',
      status: 'ready, no agent in control',
      canResume: false
    })
    computer.status = 'busy'
    computer.holder = 'claude'
    expect(trayState(computer, undefined)).toMatchObject({ tone: 'busy', status: 'controlled by claude' })
    expect(trayState(computer, 'not connected')).toMatchObject({ tone: 'unavailable' })
    computer.status = 'human_in_control'
    expect(trayState(computer, undefined)).toMatchObject({ tone: 'paused', canResume: false })
    computer.pause(CONSOLE_STOP_REASON)
    expect(trayState(computer, undefined)).toMatchObject({ tone: 'paused', canResume: false })
    computer.pause(LOCAL_OWNER_STOP_REASON)
    expect(trayState(computer, undefined).canResume).toBe(true)
  })
})
