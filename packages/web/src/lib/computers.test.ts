import { describe, expect, it } from 'vitest'
import { computerInstallCommand, computerStatusTone, doctorCounts, sortedDoctorChecks } from './computers'

describe('computer console helpers', () => {
  it('builds a one-line register command quoted for each shell', () => {
    const url = 'https://cp.example.com/v1/computers/register'
    expect(computerInstallCommand('linux', 'ac_tok', url)).toBe(
      `npx -y @agentconnect.md/cli desktop setup --register 'ac_tok' --cp-url '${url}'`
    )
    expect(computerInstallCommand('windows', 'ac_tok', url)).toContain(`--register "ac_tok" --cp-url "${url}"`)
  })

  it('puts failing checks first, then warnings, keeping the reported order', () => {
    const checks = [
      { name: 'config', status: 'ok' as const, detail: '' },
      { name: 'ffmpeg', status: 'warn' as const, detail: '' },
      { name: 'driver', status: 'fail' as const, detail: '', fix: 'install it' },
      { name: 'session', status: 'fail' as const, detail: '' }
    ]
    expect(sortedDoctorChecks(checks).map((c) => c.name)).toEqual(['driver', 'session', 'ffmpeg', 'config'])
    expect(doctorCounts({ doctor: { checkedAt: '2026-10-21T00:00:00.000Z', checks } })).toEqual({
      fail: 2,
      warn: 1,
      total: 4
    })
    expect(doctorCounts({ doctor: null })).toEqual({ fail: 0, warn: 0, total: 0 })
  })

  it('tones a stop like a pause and a revoke as an error', () => {
    expect(computerStatusTone('paused')).toEqual(computerStatusTone('human_in_control'))
    expect(computerStatusTone('revoked').dot).toBe('var(--status-error)')
  })
})
