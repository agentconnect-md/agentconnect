import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { K8S_SUPERVISOR, RESERVED_RESTART_CODE } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { LocalStore } from '../src/store/local-store.js'

/** Kubernetes supervises restart but not upgrade, so the lifecycle contract has to
 *  distinguish them rather than gate both on "is there a supervisor at all". */

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'ac-k8s-supervisor-'))
  writeFileSync(join(path, 'config.json'), JSON.stringify({ version: 1, controlPlane: { enabled: false } }))
  // Present so an upgrade refusal cannot be attributed to a missing CLI pointer.
  const cliEntry = join(path, 'cli-dist-entry.js')
  writeFileSync(cliEntry, '')
  writeFileSync(join(path, 'cli-entry'), cliEntry)
  return path
}

function daemon(opts: { k8s?: boolean; supervisor?: string; requestExit?: (code: number) => void } = {}): Daemon {
  return new Daemon({
    root: root(),
    ...(opts.k8s
      ? {
          k8s: true,
          // This suite tests k8s lifecycle policy; cluster and data-plane behavior have dedicated suites.
          openDataPlane: async () =>
            ({
              store: await LocalStore.open(':memory:'),
              transcripts: {
                appendTranscript: () => {},
                insertToolCall: () => {},
                updateToolCall: () => {}
              },
              close: async () => {}
            }) as never,
          startControlPlane: async () => {},
          startK8sPlane: async () =>
            ({
              driver: {} as never,
              listener: { listeningPort: () => 0 } as never,
              gitRunnerFor: () => undefined,
              stop: async () => {}
            }) as never
        }
      : {}),
    ...(opts.supervisor ? { supervisor: opts.supervisor } : {}),
    ...(opts.requestExit ? { requestExit: opts.requestExit } : {}),
    resolveCatalog: async () => ({ entries: {}, runtimes: {} }),
    hostFactory: () => ({}) as never
  })
}

describe('daemon lifecycle under the k8s supervisor', () => {
  it('accepts a restart: the kubelet brings the container back after the reserved exit code', async () => {
    const requestExit = vi.fn()
    const instance = daemon({ k8s: true, supervisor: K8S_SUPERVISOR, requestExit })
    await instance.start()
    const realStop = instance.stop.bind(instance)
    ;(instance as any).stop = vi.fn(async () => {})
    try {
      const ack = (instance as any).fleetUpgrade.scheduleFleetExit('restart')
      expect(ack.accepted).toBe(true)
      // The drain window is advertised so the control plane knows how long to wait.
      expect(typeof ack.willDrainUntil).toBe('string')
      await vi.waitFor(() => expect(requestExit).toHaveBeenCalledWith(RESERVED_RESTART_CODE))
      expect((instance as any).stop).toHaveBeenCalled()
    } finally {
      await realStop()
    }
  })

  it('refuses an upgrade because the version is the image, not for want of a supervisor', async () => {
    const instance = daemon({ k8s: true, supervisor: K8S_SUPERVISOR })
    await instance.start()
    try {
      const ack = (instance as any).fleetUpgrade.admitFleetExit('upgrade', '9.9.9')
      expect(ack.accepted).toBe(false)
      // The reason has to describe the real situation: a cli-entry exists here, so the
      // generic "no supervisor" message would send an operator looking in the wrong place.
      expect(ack.reason).toMatch(/image/)
      expect(ack.reason).not.toMatch(/no supervisor/)
      // A refused admission must not latch the lifecycle, or later restarts wedge.
      expect((instance as any).fleetUpgrade.lifecycleInFlight).toBe(false)
    } finally {
      await instance.stop()
    }
  })

  it.each(['service', 'cli'])(
    'refuses an upgrade in k8s mode even with an inherited %s marker and a valid cli-entry',
    async (marker) => {
      // The state that must not reach the installer: a live daemon/upgrade is delivered
      // without consulting the advertised capability, so admission is the last defence,
      // and both prerequisites of the ordinary path are satisfied here.
      const instance = daemon({ k8s: true, supervisor: marker })
      await instance.start()
      try {
        const ack = (instance as any).fleetUpgrade.admitFleetExit('upgrade', '9.9.9')
        expect(ack.accepted).toBe(false)
        expect(ack.reason).toMatch(/image/)
        expect((instance as any).fleetUpgrade.lifecycleInFlight).toBe(false)
      } finally {
        await instance.stop()
      }
    },
    20_000
  )

  it('still admits a restart in k8s mode under an inherited service marker', async () => {
    // Restart is not what k8s mode refuses: whatever supervises the process can bring
    // it back, so only the self-installing upgrade is gated on the mode.
    const instance = daemon({ k8s: true, supervisor: 'service' })
    await instance.start()
    try {
      expect((instance as any).fleetUpgrade.admitFleetExit('restart').accepted).toBe(true)
    } finally {
      await instance.stop()
    }
  })

  it('still refuses a restart when no supervisor is declared, k8s or not', async () => {
    const instance = daemon({ k8s: true })
    await instance.start()
    try {
      const ack = (instance as any).fleetUpgrade.admitFleetExit('restart')
      expect(ack.accepted).toBe(false)
      // Exiting without a supervisor leaves the daemon down, so the mode alone is not
      // enough — the launcher has to declare that something will bring it back.
      expect(ack.reason).toMatch(/no supervisor/)
    } finally {
      await instance.stop()
    }
  })

  it('keeps the CLI and service supervisors unchanged', async () => {
    const instance = daemon({ supervisor: 'service' })
    await instance.start()
    try {
      expect((instance as any).fleetUpgrade.admitFleetExit('upgrade', '9.9.9').accepted).toBe(true)
    } finally {
      await instance.stop()
    }
  })
})
