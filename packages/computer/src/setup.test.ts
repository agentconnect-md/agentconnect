import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readGrantRecord, recordGrants } from './macos-grants.js'
import { localizeChecks, macPermissionChecks, printChecks, profileCovered } from './setup.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('setup helpers', () => {
  it('renders checks relayed from the service with the command the user ran', () => {
    vi.stubEnv('AGENTCONNECT_COMPUTER_COMMAND', 'agentconnect computer')
    const relayed = [
      { name: 'ffmpeg', status: 'warn' as const, detail: 'missing', fix: 'run: agentconnect-computer install-ffmpeg' },
      { name: 'daemon', status: 'fail' as const, detail: 'start it with: agentconnect-computer run' },
      { name: 'driver', status: 'ok' as const, detail: '/opt/bin/agentconnect-computer ok' }
    ]
    expect(localizeChecks(relayed)).toEqual([
      { name: 'ffmpeg', status: 'warn', detail: 'missing', fix: 'run: agentconnect computer install-ffmpeg' },
      { name: 'daemon', status: 'fail', detail: 'start it with: agentconnect computer run' },
      { name: 'driver', status: 'ok', detail: '/opt/bin/agentconnect-computer ok' }
    ])
  })

  it('matches Windows network categories against firewall rule profiles', () => {
    expect(profileCovered('Any', 'Public')).toBe(true)
    expect(profileCovered('Private, Public', 'Public')).toBe(true)
    expect(profileCovered('Private', 'Public')).toBe(false)
    expect(profileCovered('Domain', 'DomainAuthenticated')).toBe(true)
  })

  it('fails the report only on failed checks and prints the fix for anything not ok', () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line))
    expect(printChecks([{ name: 'a', status: 'warn', detail: 'meh', fix: 'do x' }])).toBe(true)
    expect(lines.some((line) => line.includes('→ do x'))).toBe(true)
    expect(
      printChecks([
        { name: 'b', status: 'fail', detail: 'broken' },
        { name: 'c', status: 'info', detail: 'fyi' }
      ])
    ).toBe(false)
  })
})

describe('macOS grants', () => {
  const app = 'AgentConnect Computer.app'
  const off = { accessibility: false, screenRecording: false, directCapture: 'not_checked' }

  it('records what the app asked for and what it held, keeping the first time of each', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-grants-'))
    try {
      expect(readGrantRecord(dir)).toEqual({ asked: {}, held: {} })
      recordGrants(dir, { accessibility: false, screenRecording: false }, false, new Date('2026-01-01T00:00:00Z'))
      expect(readGrantRecord(dir)).toEqual({ asked: {}, held: {} })
      recordGrants(dir, { accessibility: false, screenRecording: false }, true, new Date('2026-01-02T00:00:00Z'))
      recordGrants(dir, { accessibility: true, screenRecording: false }, true, new Date('2026-01-03T00:00:00Z'))
      expect(readGrantRecord(dir)).toEqual({
        asked: { accessibility: '2026-01-02T00:00:00.000Z', screenRecording: '2026-01-02T00:00:00.000Z' },
        held: { accessibility: '2026-01-03T00:00:00.000Z' }
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('tells a listed-but-off grant from one never asked for and one the app lost', () => {
    vi.stubEnv('AGENTCONNECT_COMPUTER_COMMAND', 'agentconnect computer')
    const [never] = macPermissionChecks(off, { asked: {}, held: {} }, app)
    expect(never).toMatchObject({ status: 'fail', fix: 'run: agentconnect computer setup' })
    const [listed] = macPermissionChecks(off, { asked: { accessibility: 'x' }, held: {} }, app)
    expect(listed!.detail).toMatch(/listed in Privacy & Security > Accessibility .* but switched off: clicks and keys/)
    expect(listed!.fix).toMatch(/listed is not enough/)
    const [, lost] = macPermissionChecks(off, { asked: {}, held: { screenRecording: 'x' } }, app)
    expect(lost!.fix).toBe(
      'run: tccutil reset ScreenCapture md.agentconnect.computer, then: agentconnect computer setup'
    )
    const granted = macPermissionChecks({ ...off, accessibility: true, screenRecording: true }, undefined, app)
    expect(granted.map((check) => check.status)).toEqual(['ok', 'ok'])
  })

  it('points a terminal-held grant at the settings pane rather than at the app', () => {
    const [terminal] = macPermissionChecks(off, undefined, 'Terminal')
    expect(terminal!.fix).toMatch(/^Privacy & Security > Accessibility .*: switch it on, then Cmd\+Q and reopen$/)
  })
})
