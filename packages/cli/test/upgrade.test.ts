import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareDaemonUpgrade, upgrade, type UpgradeDeps } from '../src/upgrade.js'
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
    prepare: vi.fn(async () => {}),
    serviceInstalled: () => true,
    restartService: vi.fn(async () => {}),
    health: async () => ({ healthy: true, reason: 'stable pid 1' }),
    prune: vi.fn(() => []),
    log: () => {},
    ...over
  }
}

describe('upgrade', () => {
  it('keeps the old version active until target preparation completes', async () => {
    const r = root()
    install(r, '1.0.0')
    const { useVersion } = await import('../src/version-ops.js')
    useVersion(r, '1.0.0')
    let release!: () => void
    const pending = new Promise<void>((resolve) => (release = resolve))
    const prepare = vi.fn(async () => pending)
    const restart = vi.fn(async () => {})
    const upgrading = upgrade(
      r,
      { to: '2.0.0', restart: true, configPath: '/custom/config.json' },
      deps({ prepare, restartService: restart })
    )
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledWith(r, '2.0.0', '/custom/config.json'))
    expect(currentVersion(r)).toBe('1.0.0')
    expect(restart).not.toHaveBeenCalled()
    release()
    await upgrading
    expect(currentVersion(r)).toBe('2.0.0')
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('leaves current, rollback metadata and the running service intact when preparation fails', async () => {
    const r = root()
    install(r, '1.0.0')
    const { useVersion } = await import('../src/version-ops.js')
    useVersion(r, '1.0.0')
    const before = readMeta(r)
    const d = deps({
      prepare: async () => {
        throw new Error('image unavailable')
      }
    })
    await expect(upgrade(r, { to: '2.0.0', restart: true }, d)).rejects.toThrow('image unavailable')
    expect(currentVersion(r)).toBe('1.0.0')
    expect(readMeta(r)).toEqual(before)
    expect(d.restartService).not.toHaveBeenCalled()
    expect(d.prune).not.toHaveBeenCalled()
  })

  it('runs the target bundle preparation entry and propagates its failure', async () => {
    const r = root()
    const dist = join(r, 'versions', '2.0.0', 'dist')
    mkdirSync(dist, { recursive: true })
    await prepareDaemonUpgrade(r, '1.0.0')
    writeFileSync(
      join(dist, 'prepare-upgrade.js'),
      'require("node:fs").writeFileSync(__dirname + "/prepared.json", JSON.stringify(process.argv.slice(2)))'
    )
    await prepareDaemonUpgrade(r, '2.0.0', '/custom/config.json')
    expect(JSON.parse(readFileSync(join(dist, 'prepared.json'), 'utf8'))).toEqual([
      '--root',
      r,
      '--config',
      '/custom/config.json'
    ])
    writeFileSync(join(dist, 'prepare-upgrade.js'), 'process.exit(7)')
    await expect(prepareDaemonUpgrade(r, '2.0.0')).rejects.toThrow('upgrade preparation failed (7)')
  })

  it('prunes with the default retention after switching, protecting the target', async () => {
    const r = root()
    install(r, '1.0.0')
    const { useVersion } = await import('../src/version-ops.js')
    useVersion(r, '1.0.0')
    const prune = vi.fn(() => ['0.9.0'])
    await upgrade(r, { to: '2.0.0' }, deps({ prune }))
    expect(prune).toHaveBeenCalledWith({ keep: 3, protect: ['2.0.0'], assumeIdle: false })
  })

  it('passes an explicit --keep through to the prune', async () => {
    const r = root()
    install(r, '1.0.0')
    const { useVersion } = await import('../src/version-ops.js')
    useVersion(r, '1.0.0')
    const prune = vi.fn(() => [])
    await upgrade(r, { to: '2.0.0', keep: 1 }, deps({ prune }))
    expect(prune).toHaveBeenCalledWith({ keep: 1, protect: ['2.0.0'], assumeIdle: false })
    await upgrade(r, { to: '3.0.0', keep: 0 }, deps({ prune }))
    expect(prune).toHaveBeenLastCalledWith({ keep: 0, protect: ['3.0.0'], assumeIdle: false })
  })

  it('prunes even when the target is already current', async () => {
    const r = root()
    install(r, '2.0.0')
    const { useVersion } = await import('../src/version-ops.js')
    useVersion(r, '2.0.0')
    const prune = vi.fn(() => [])
    await upgrade(r, { to: '2.0.0' }, deps({ prune }))
    expect(prune).toHaveBeenCalledWith({ keep: 3, protect: ['2.0.0'], assumeIdle: false })
  })

  it('prunes as idle only after a restart proved healthy', async () => {
    const r = root()
    install(r, '1.0.0')
    const { useVersion } = await import('../src/version-ops.js')
    useVersion(r, '1.0.0')
    const prune = vi.fn(() => [])
    await upgrade(r, { to: '2.0.0', restart: true }, deps({ prune }))
    expect(prune).toHaveBeenCalledWith({ keep: 3, protect: ['2.0.0'], assumeIdle: true })
  })

  it('does not prune when the upgrade rolled back', async () => {
    const r = root()
    install(r, '1.0.0')
    const { useVersion } = await import('../src/version-ops.js')
    useVersion(r, '1.0.0')
    const prune = vi.fn(() => [])
    await expect(
      upgrade(
        r,
        { to: '2.0.0', restart: true },
        deps({ prune, health: async () => ({ healthy: false, reason: 'exited' }) })
      )
    ).rejects.toThrow(/rolled back/)
    expect(prune).not.toHaveBeenCalled()
  })
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
