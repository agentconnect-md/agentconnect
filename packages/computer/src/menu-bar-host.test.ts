import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ComputerCpClient } from './cp/client.js'
import type { Registration } from './cp/registration.js'
import type { CuaDriver } from './driver/client.js'
import { appVersion, controlPlaneState, grantState, macMenuBarHost, uninstallScript } from './menu-bar-host.js'

const calls = vi.hoisted(() => ({ spawnSync: [] as string[][], opened: [] as string[], asked: 0 }))
vi.mock('node:child_process', async (actual) => ({
  ...(await actual<typeof import('node:child_process')>()),
  spawnSync: (command: string, args: string[]) => {
    calls.spawnSync.push([command, ...args])
    return { status: 0, stdout: '', stderr: '' }
  }
}))
vi.mock('./setup.js', async (actual) => ({
  ...(await actual<typeof import('./setup.js')>()),
  open: (url: string) => calls.opened.push(url)
}))
vi.mock('./self.js', async (actual) => ({
  ...(await actual<typeof import('./self.js')>()),
  runSelf: async () => {
    calls.asked++
    return '{}'
  }
}))

describe('macOS menu bar host', () => {
  it('reads the Control Plane state from the registration and the channel', () => {
    const registration = { channelUrl: 'wss://api.example.com/v1/computers/ws' } as Registration
    const client = (state: ComputerCpClient['state']) => ({ state }) as ComputerCpClient
    expect(controlPlaneState(undefined, undefined)).toBe('unregistered')
    expect(controlPlaneState({ ...registration, revokedAt: '2026-10-26T00:00:00Z' }, client('READY'))).toBe('revoked')
    expect(controlPlaneState(registration, client('READY'))).toBe('connected')
    expect(controlPlaneState(registration, client('AUTHENTICATING'))).toBe('connecting')
    expect(controlPlaneState(registration, client('DEGRADED'))).toBe('disconnected')
    expect(controlPlaneState(registration, undefined)).toBe('disconnected')
  })

  it('tells a grant held for an earlier build from one never switched on', () => {
    const record = { asked: { accessibility: 'then' }, held: { screenRecording: 'then' } }
    expect(grantState(true, record, 'screenRecording')).toBe('allowed')
    expect(grantState(false, record, 'screenRecording')).toBe('stale')
    expect(grantState(false, record, 'accessibility')).toBe('off')
  })

  it('reads the app’s version from its Info.plist', () => {
    const app = join(mkdtempSync(join(tmpdir(), 'menu-bar-host-')), 'AgentConnect Computer.app')
    mkdirSync(join(app, 'Contents'), { recursive: true })
    writeFileSync(
      join(app, 'Contents', 'Info.plist'),
      '<dict>\n  <key>CFBundleShortVersionString</key><string>2.7.0-rc.7</string>\n</dict>'
    )
    expect(appVersion(app)).toBe('2.7.0-rc.7')
    expect(appVersion(undefined)).toBeUndefined()
    expect(appVersion(join(app, 'missing'))).toBeUndefined()
  })

  it('uninstalls through the CLI on the channel the desktop follows', () => {
    expect(uninstallScript('rc')).toContain('npx -y @agentconnect.md/cli@rc computer uninstall')
    expect(uninstallScript('latest')).toContain('npx -y @agentconnect.md/cli computer uninstall')
    expect(uninstallScript(undefined)).toContain('agentconnect computer uninstall')
  })

  it('resets a stale grant, and restarts for Screen Recording, which macOS asks a running app for only once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'menu-bar-host-'))
    writeFileSync(
      join(dir, 'macos-grants.json'),
      JSON.stringify({ asked: {}, held: { accessibility: 'then', screenRecording: 'then' } })
    )
    const exits: number[] = []
    const host = macMenuBarHost({
      dir,
      appPath: undefined,
      driver: {} as CuaDriver,
      name: () => undefined,
      registration: undefined,
      client: () => undefined,
      shutdown: (code) => exits.push(code),
      onFfmpegInstalled: () => undefined,
      accessibilityGranted: async () => false,
      log: () => undefined
    })
    host.resetGrant('accessibility')
    expect(calls.spawnSync.at(-1)).toEqual(['tccutil', 'reset', 'Accessibility', 'md.agentconnect.computer'])
    expect(calls.asked).toBe(1)
    expect(exits).toEqual([])
    host.resetGrant('screenRecording')
    expect(calls.spawnSync.at(-1)).toEqual(['tccutil', 'reset', 'ScreenCapture', 'md.agentconnect.computer'])
    expect(calls.asked).toBe(1)
    expect(exits).toEqual([1])
    expect(calls.opened).toHaveLength(2)
    expect(JSON.parse(readFileSync(join(dir, 'macos-grants.json'), 'utf8')).held).toEqual({})
  })
})
