import { afterEach, describe, expect, it, vi } from 'vitest'
import { localizeChecks, printChecks, profileCovered } from './setup.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('setup helpers', () => {
  it('renders checks relayed from the service with the command the user ran', () => {
    vi.stubEnv('AGENTCONNECT_DESKTOP_COMMAND', 'agentconnect desktop')
    const relayed = [
      { name: 'ffmpeg', status: 'warn' as const, detail: 'missing', fix: 'run: agentconnect-desktop install-ffmpeg' },
      { name: 'daemon', status: 'fail' as const, detail: 'start it with: agentconnect-desktop run' },
      { name: 'driver', status: 'ok' as const, detail: '/opt/bin/agentconnect-desktop ok' }
    ]
    expect(localizeChecks(relayed)).toEqual([
      { name: 'ffmpeg', status: 'warn', detail: 'missing', fix: 'run: agentconnect desktop install-ffmpeg' },
      { name: 'daemon', status: 'fail', detail: 'start it with: agentconnect desktop run' },
      { name: 'driver', status: 'ok', detail: '/opt/bin/agentconnect-desktop ok' }
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
