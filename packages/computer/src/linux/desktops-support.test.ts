import { describe, expect, it } from 'vitest'
import { desktopsCheck, desktopsEnabled, probeDesktopSupport, type ProbeDeps } from './desktops-support.js'

const installed =
  (...names: string[]): ProbeDeps['which'] =>
  (name) =>
    names.includes(name) ? `/usr/bin/${name}` : undefined

const linux = (deps: ProbeDeps): ProbeDeps => ({
  platform: 'linux',
  tryXvfb: async () => undefined,
  browser: () => '/usr/bin/chromium',
  ...deps
})

describe('probeDesktopSupport', () => {
  it('supports a machine with Xvfb, D-Bus and Xfce where Xvfb really starts', async () => {
    const support = await probeDesktopSupport(linux({ which: installed('Xvfb', 'dbus-launch', 'xfce4-session') }))
    expect(support).toEqual({ supported: true, session: 'xfce', browser: '/usr/bin/chromium' })
  })

  it("falls back to Xfce's window manager when its session is missing", async () => {
    const support = await probeDesktopSupport(linux({ which: installed('Xvfb', 'dbus-launch', 'xfwm4') }))
    expect(support).toMatchObject({ supported: true, session: 'xfwm4' })
  })

  it('names what is missing and what to install', async () => {
    expect(await probeDesktopSupport(linux({ which: installed('dbus-launch', 'xfce4-session') }))).toMatchObject({
      supported: false,
      reason: 'Xvfb is not installed',
      fix: 'install xvfb dbus-x11 xfce4'
    })
    expect(await probeDesktopSupport(linux({ which: installed('Xvfb', 'dbus-launch') }))).toMatchObject({
      supported: false,
      reason: 'Xfce is not installed'
    })
  })

  it('is unsupported when Xvfb is installed but cannot start', async () => {
    const support = await probeDesktopSupport(
      linux({ which: installed('Xvfb', 'dbus-launch', 'xfce4-session'), tryXvfb: async () => 'Xvfb exited (1)' })
    )
    expect(support).toMatchObject({ supported: false, reason: 'Xvfb exited (1)' })
  })

  it('is Linux only', async () => {
    expect(await probeDesktopSupport({ platform: 'darwin' })).toMatchObject({ supported: false })
  })
})

describe('the switch', () => {
  const supported = { supported: true, session: 'xfce', browser: '/usr/bin/chromium' } as const

  it('is on only where it is switched on and the machine supports it', () => {
    expect(desktopsEnabled(true, supported)).toBe(true)
    expect(desktopsEnabled(false, supported)).toBe(false)
    expect(desktopsEnabled(true, { supported: false, reason: 'Xvfb is not installed' })).toBe(false)
  })

  it('reports in doctor what it means here', () => {
    expect(desktopsCheck(true, supported, 'agentconnect-computer')).toEqual({
      name: 'desktops',
      status: 'ok',
      detail: 'on: each agent gets its own desktop (Xvfb + Xfce)'
    })
    expect(desktopsCheck(false, supported, 'agentconnect-computer')).toMatchObject({
      status: 'info',
      fix: 'turn on: agentconnect-computer desktops on'
    })
    expect(
      desktopsCheck(true, { supported: false, reason: 'Xvfb is not installed', fix: 'install xvfb' }, 'x')
    ).toMatchObject({ status: 'warn', detail: expect.stringContaining('unavailable (Xvfb is not installed)') })
    expect(desktopsCheck(true, { supported: true, session: 'xfce' }, 'x')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('no Chromium found')
    })
  })
})
