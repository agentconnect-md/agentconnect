import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DAEMON_AUTO_UPGRADE_FEATURE, RESERVED_RESTART_CODE } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { ConfigSchema } from '../src/config/config-schema.js'
import { FakeClock } from './cp/fake-clock.js'

const roots: string[] = []

function scaffold(limits?: Record<string, number>): string {
  const root = mkdtempSync(join(tmpdir(), 'agentconnect-fleet-upgrade-'))
  roots.push(root)
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } },
      ...(limits ? { limits } : {})
    })
  )
  const cliEntry = join(root, 'agentconnect-cli.js')
  writeFileSync(cliEntry, '')
  writeFileSync(join(root, 'cli-entry'), `${cliEntry}\n`)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('daemon fleet upgrade coordination', () => {
  it('joins the same READY-delivered install when bootstrap auth reconnects', async () => {
    let finishInstall!: (installed: boolean) => void
    const blockedInstall = new Promise<boolean>((resolve) => (finishInstall = resolve))
    const upgradeInstaller = vi.fn(async () => await blockedInstall)
    const requestExit = vi.fn()
    const daemon = new Daemon({ root: scaffold(), supervisor: 'cli', upgradeInstaller, requestExit })
    ;(daemon as any).stop = vi.fn(async () => {})
    const reportLifecycleProgress = vi.fn(async () => {})
    ;(daemon as any).cpClient = { reportLifecycleProgress }

    expect((daemon as any).fleetUpgrade.scheduleFleetExit('upgrade', '9.9.9', 'upgrade-1')).toEqual({ accepted: true })
    await vi.waitFor(() => expect(upgradeInstaller).toHaveBeenCalledTimes(1))
    expect(reportLifecycleProgress).toHaveBeenCalledWith({ operationId: 'upgrade-1', phase: 'preparing' })
    expect((daemon as any).stop).not.toHaveBeenCalled()

    const reconnectOutcome = (daemon as any).fleetUpgrade.runBootstrapFleetUpgrade('9.9.9', 'upgrade-1')
    finishInstall(true)

    const outcome = await reconnectOutcome
    expect(outcome.status).toBe('installed')
    expect(upgradeInstaller).toHaveBeenCalledTimes(1)
    outcome.restart()
    await vi.waitFor(() => expect(requestExit).toHaveBeenCalledTimes(1))
    expect(reportLifecycleProgress).toHaveBeenCalledWith({ operationId: 'upgrade-1', phase: 'restarting' })
  })

  it('exits for the relaunch when stop() is still parked past the drain budget', async () => {
    const clock = new FakeClock()
    const requestExit = vi.fn()
    const root = scaffold({ shutdownDrainMs: 5_000 })
    const daemon = new Daemon({ root, supervisor: 'cli', clock, requestExit })
    await daemon.start()
    const realStop = daemon.stop.bind(daemon)
    const stop = vi.fn(() => new Promise<void>(() => {}))
    Object.assign(daemon, { stop })
    const error = vi.spyOn((daemon as any).log, 'error')

    try {
      expect((daemon as any).fleetUpgrade.scheduleFleetExit('restart')).toMatchObject({ accepted: true })
      await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1))
      clock.advance(34_999)
      await new Promise((resolve) => setImmediate(resolve))
      expect(requestExit).not.toHaveBeenCalled()

      clock.advance(1)
      await vi.waitFor(() => expect(requestExit).toHaveBeenCalledWith(RESERVED_RESTART_CODE))
      expect(error).toHaveBeenCalledWith('cp: restart shutdown still running after 35s — exiting anyway')
    } finally {
      await realStop()
    }
  })

  it('reports preparation failure without stopping the serving daemon', async () => {
    const requestExit = vi.fn()
    const daemon = new Daemon({ root: scaffold(), supervisor: 'cli', upgradeInstaller: async () => false, requestExit })
    const stop = vi.fn(async () => {})
    const reportLifecycleProgress = vi.fn(async () => {})
    Object.assign(daemon, { stop, cpClient: { reportLifecycleProgress } })

    expect((daemon as any).fleetUpgrade.scheduleFleetExit('upgrade', '9.9.9', 'upgrade-2')).toEqual({ accepted: true })

    await vi.waitFor(() =>
      expect(reportLifecycleProgress).toHaveBeenCalledWith({ operationId: 'upgrade-2', phase: 'failed' })
    )
    expect(stop).not.toHaveBeenCalled()
    expect(requestExit).not.toHaveBeenCalled()
  })

  it('advertises auto-upgrade exactly when an unattended upgrade is possible', () => {
    const root = scaffold()
    const features = (opts: Record<string, unknown>) => {
      const daemon = new Daemon({ root, ...opts })
      Object.assign(daemon, { root, cfg: ConfigSchema.parse({ version: 1 }) })
      return (daemon as any).registrationFeatures() as string[]
    }
    expect(features({ supervisor: 'cli' })).toContain(DAEMON_AUTO_UPGRADE_FEATURE)
    expect(features({ supervisor: 'service' })).toContain(DAEMON_AUTO_UPGRADE_FEATURE)
    expect(features({})).not.toContain(DAEMON_AUTO_UPGRADE_FEATURE)
    expect(features({ supervisor: 'k8s' })).not.toContain(DAEMON_AUTO_UPGRADE_FEATURE)
  })

  it('keeps CP-commanded and automatic lifecycle operations mutually exclusive', () => {
    const upgradeInstaller = vi.fn(() => new Promise<boolean>(() => {}))
    const daemon = new Daemon({ root: scaffold(), supervisor: 'cli', upgradeInstaller, requestExit: vi.fn() })
    const fleet = (daemon as any).fleetUpgrade
    const auto = fleet.autoUpgradeLifecycle()
    expect(auto.reserve('9.9.9')).toMatchObject({ accepted: true })
    expect(fleet.scheduleFleetExit('restart')).toMatchObject({ accepted: false })
    expect(auto.reserve('9.9.9')).toMatchObject({ accepted: false })
    auto.release()
    expect(fleet.lifecycleBusy()).toBe(false)
    expect(fleet.scheduleFleetExit('upgrade', '9.9.9')).toMatchObject({ accepted: true })
    expect(auto.reserve('9.9.9')).toMatchObject({ accepted: false })
  })

  it('closes turn admission in the same step as the final idle check of an automatic exit', () => {
    const daemon = new Daemon({ root: scaffold(), supervisor: 'cli', requestExit: vi.fn() })
    const stop = vi.fn(() => new Promise<void>(() => {}))
    Object.assign(daemon, { stop })
    const auto = (daemon as any).fleetUpgrade.autoUpgradeLifecycle()
    expect(auto.reserve('9.9.9')).toMatchObject({ accepted: true })

    // Work arrived: nothing closes, nothing exits, and the reservation stays with the upgrader.
    expect(auto.exit('op-1', () => false)).toBe(false)
    expect((daemon as any).draining).toBe(false)

    // Still idle: admission is shut before the `restarting` report is awaited.
    expect(auto.exit('op-1', () => true)).toBe(true)
    expect((daemon as any).draining).toBe(true)
    expect(stop).not.toHaveBeenCalled()
  })
})
