import { describe, expect, it } from 'vitest'
import { ComputerCapabilitiesSchema, ComputerDoctorReport } from '@agentconnect.md/protocol/computer'
import type { Check } from '../setup.js'
import { capabilitiesFrom, doctorReport, isolationKind, sessionKind } from './report.js'

const linuxChecks: Check[] = [
  { name: 'session', status: 'ok', detail: 'X11 display :0' },
  { name: 'cua-driver', status: 'ok', detail: '0.35.2' },
  { name: 'screenshot', status: 'ok', detail: 'desktop capture works' },
  { name: 'ffmpeg', status: 'ok', detail: '/usr/bin/ffmpeg' },
  { name: 'screen capture', status: 'ok', detail: 'x11grab' },
  { name: 'portal', status: 'fail', detail: 'not running', fix: 'install xdg-desktop-portal' }
]

describe('Control Plane report', () => {
  it('reads capabilities off doctor and the last capture', () => {
    const caps = capabilitiesFrom(
      linuxChecks,
      { screenWidth: 1920, screenHeight: 1080, scale: 1 },
      {
        platform: 'linux',
        session: 'x11',
        keyboardActivity: true
      }
    )
    expect(caps).toEqual({
      screenshot: true,
      input: true,
      textInput: 'full',
      humanActivity: 'pointer+keyboard',
      backgroundInput: false,
      accessibilityTree: false,
      viewer: true,
      viewerStun: true,
      displays: [{ id: 'primary', width: 1920, height: 1080, scale: 1 }],
      permissions: { portal: false }
    })
    expect(ComputerCapabilitiesSchema.safeParse(caps).success).toBe(true)
  })

  it('reports what is known to be broken instead of guessing', () => {
    const caps = capabilitiesFrom(
      [
        { name: 'cua-driver', status: 'ok', detail: '' },
        { name: 'accessibility', status: 'fail', detail: 'not granted' },
        { name: 'screenshot', status: 'ok', detail: '' },
        { name: 'ffmpeg', status: 'warn', detail: 'not found' }
      ],
      undefined,
      { platform: 'darwin', session: 'aqua' }
    )
    expect(caps).toMatchObject({
      screenshot: true,
      input: false,
      viewer: false,
      displays: [],
      humanActivity: 'pointer'
    })
    expect(capabilitiesFrom(linuxChecks, undefined, { platform: 'linux', session: 'wayland-gnome' }).textInput).toBe(
      'keymap-only'
    )
  })

  it('bounds the doctor report to what the wire accepts', () => {
    const many: Check[] = Array.from({ length: 80 }, (_, i) => ({
      name: `check-${i}`,
      status: 'warn',
      detail: 'x'.repeat(5000),
      fix: 'y'.repeat(5000)
    }))
    const report = doctorReport(many, new Date('2026-10-20T00:00:00Z'))
    expect(report.checks).toHaveLength(64)
    expect(ComputerDoctorReport.safeParse(report).success).toBe(true)
  })

  it('tells the session and isolation apart', () => {
    expect(sessionKind('darwin', {})).toBe('aqua')
    expect(sessionKind('win32', { SESSIONNAME: 'RDP-Tcp#1' })).toBe('rdp')
    expect(sessionKind('win32', { SESSIONNAME: 'Console' })).toBe('console')
    expect(sessionKind('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe('wayland-gnome')
    expect(isolationKind({ AGENTCONNECT_DESKTOP_ISOLATION: 'container' })).toBe('container')
  })
})
