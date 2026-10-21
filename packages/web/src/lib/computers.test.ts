import { describe, expect, it } from 'vitest'
import { computerInstallCommand, computerStatusTone, doctorCounts, sortedDoctorChecks } from './computers'

describe('computer console helpers', () => {
  it('builds a one-line register command quoted for each shell', () => {
    const url = 'https://cp.example.com/v1/computers/register'
    const installer = 'https://cp.example.com/v1/computers/install.sh'
    const registration = { token: 'ac_tok', exchangeUrl: url, linuxInstallerUrl: installer }
    expect(computerInstallCommand('linux', registration)).toBe(
      `wget -nv -O- '${installer}' | sh -s -- --register 'ac_tok'`
    )
    // A CP without the desktop bundle leaves Linux on the CLI command, like macOS and Windows.
    expect(computerInstallCommand('linux', { ...registration, linuxInstallerUrl: null })).toBe(
      `npx -y @agentconnect.md/cli desktop setup --register 'ac_tok' --cp-url '${url}'`
    )
    expect(computerInstallCommand('macos', registration)).toContain(`--register 'ac_tok' --cp-url '${url}'`)
    expect(computerInstallCommand('windows', registration)).toContain(`--register "ac_tok" --cp-url "${url}"`)
    expect(computerInstallCommand('docker', registration)).toBe(
      `docker run -d --name agentconnect-desktop --hostname agentconnect-desktop --restart unless-stopped --shm-size=1g -v agentconnect-desktop:/home/desktop -e LISTEN_HOST=127.0.0.1 -e AGENTCONNECT_CP_URL='${url}' -e AGENTCONNECT_REGISTER_TOKEN='ac_tok' ghcr.io/agentconnect-md/desktop:latest`
    )
    // The CP names the image at its own release, so the desktop speaks its protocol version.
    expect(
      computerInstallCommand('docker', { ...registration, desktopImage: 'ghcr.io/agentconnect-md/desktop:v2.6.0' })
    ).toMatch(/ ghcr\.io\/agentconnect-md\/desktop:v2\.6\.0$/)
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
