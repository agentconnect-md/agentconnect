import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { upgrade, type UpgradeDeps } from '../src/upgrade.js'
import { checkServiceHealthy } from '../src/health.js'
import { currentVersion, readMeta } from '../src/version-store.js'
import type { ResolvedTarget } from '../src/registry.js'

const root = () => mkdtempSync(join(tmpdir(), 'ac-upg-'))
const install = (r: string, v: string) => mkdirSync(join(r, 'versions', v), { recursive: true })
const target = (v: string): ResolvedTarget => ({ version: v, tarball: 'x', integrity: 'sha512-x' })

function deps(over: Partial<UpgradeDeps> = {}): UpgradeDeps {
  return {
    resolve: async ({ to }) => target(to ?? '2.0.0'),
    // "install" just materializes the version dir (real download is covered elsewhere)
    install: async (r, t) => {
      install(r, t.version)
      return t.version
    },
    serviceInstalled: () => true,
    restartService: vi.fn(async () => {}),
    health: async () => ({ healthy: true, reason: 'stable pid 1' }),
    log: () => {},
    ...over
  }
}

describe('upgrade', () => {
  it('installs, flips current, restarts, and stays on the new version when healthy', async () => {
    const r = root()
    install(r, '1.0.0')
    const useVersionFirst = async () => {
      const { useVersion } = await import('../src/version-ops.js')
      useVersion(r, '1.0.0')
    }
    await useVersionFirst()
    const restart = vi.fn(async () => {})
    await upgrade(r, { to: '2.0.0', restart: true }, deps({ restartService: restart }))
    expect(currentVersion(r)).toBe('2.0.0')
    expect(readMeta(r).previous).toBe('1.0.0')
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('flips current but does not restart without --restart', async () => {
    const r = root()
    install(r, '1.0.0')
    const { useVersion } = await import('../src/version-ops.js')
    useVersion(r, '1.0.0')
    const restart = vi.fn(async () => {})
    await upgrade(r, { to: '2.0.0' }, deps({ restartService: restart }))
    expect(currentVersion(r)).toBe('2.0.0')
    expect(restart).not.toHaveBeenCalled()
  })

  it('rolls back to the previous version when the health check fails', async () => {
    const r = root()
    install(r, '1.0.0')
    const { useVersion } = await import('../src/version-ops.js')
    useVersion(r, '1.0.0')
    const restart = vi.fn(async () => {})
    await expect(
      upgrade(
        r,
        { to: '2.0.0', restart: true },
        deps({ restartService: restart, health: async () => ({ healthy: false, reason: 'crash-looping' }) })
      )
    ).rejects.toThrow(/rolled back to 1\.0\.0/)
    expect(currentVersion(r)).toBe('1.0.0') // rolled back
    expect(restart).toHaveBeenCalledTimes(2) // once for upgrade, once for rollback
  })

  it('skips restart when no OS service is installed', async () => {
    const r = root()
    install(r, '1.0.0')
    const { useVersion } = await import('../src/version-ops.js')
    useVersion(r, '1.0.0')
    const restart = vi.fn(async () => {})
    await upgrade(r, { to: '2.0.0', restart: true }, deps({ serviceInstalled: () => false, restartService: restart }))
    expect(currentVersion(r)).toBe('2.0.0')
    expect(restart).not.toHaveBeenCalled()
  })
})

describe('checkServiceHealthy', () => {
  const noDelay = async () => {}
  const st = (running: boolean, pid?: number) => ({ installed: true, running, pid, label: 'svc', logPath: '' })

  it('healthy when running with a stable pid', async () => {
    const r = await checkServiceHealthy(async () => st(true, 42), { delay: noDelay })
    expect(r.healthy).toBe(true)
  })
  it('unhealthy when not running', async () => {
    const r = await checkServiceHealthy(async () => st(false), { delay: noDelay })
    expect(r.healthy).toBe(false)
  })
  it('unhealthy when the pid changes (crash loop)', async () => {
    let n = 0
    const r = await checkServiceHealthy(async () => st(true, n++ === 0 ? 42 : 99), { delay: noDelay })
    expect(r.healthy).toBe(false)
    expect(r.reason).toMatch(/pid changed/)
  })
})
