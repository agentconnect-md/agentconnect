import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_WAKE_FEATURE, SANDBOX_KEEP_ALIVE_FEATURE } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import type { ResolvedRuntimeCatalog } from '../src/runtimes/registry.js'
import { VM_BIN, VM_IMAGE_DIR } from '../src/vm/settings.js'

/** The behavior matrix for `--vm`, the sibling of `daemon-k8s-mode`: each assertion is one row of
 *  the mode contract, so a placement cannot quietly start claiming something it does not deliver. */

const dirs: string[] = []
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function root(opts: { requireSandbox?: boolean; helper?: boolean; image?: boolean } = {}): string {
  const path = mkdtempSync(join(tmpdir(), 'ac-vm-mode-'))
  dirs.push(path)
  writeFileSync(
    join(path, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      ...(opts.requireSandbox ? { security: { requireSandbox: true } } : {})
    })
  )
  if (opts.helper !== false) {
    mkdirSync(join(path, 'vm', 'bin'), { recursive: true })
    writeFileSync(join(path, VM_BIN), '#!/bin/sh\n')
  }
  if (opts.image !== false) {
    mkdirSync(join(path, VM_IMAGE_DIR), { recursive: true })
    for (const file of ['kernel', 'disk.img', 'manifest.json']) {
      writeFileSync(join(path, VM_IMAGE_DIR, file), 'x')
    }
  }
  return path
}

function catalog(): ResolvedRuntimeCatalog {
  const absent = { command: 'ac-vm-absent-runtime', args: [], env: [] }
  return {
    entries: {
      claude: { runtime: absent, source: 'registry', name: 'Claude Code', version: '1.0.0', skillsAgentId: 'claude' }
    },
    runtimes: { claude: absent }
  }
}

/** The plane needs a hypervisor and has its own suite; this file is about what the MODE changes. */
function stubPlane(onStart?: (options: any) => void) {
  return async (options: any) => {
    onStart?.(options)
    return {
      driver: {} as never,
      memberId: 'vm-host-under-test',
      runtimeImage: async () => '/images/trixie',
      gitRunnerFor: () => undefined,
      workspaceFilesFor: () => undefined,
      workspaceFsFor: () => undefined,
      autoMergeFor: () => undefined,
      memoryFsFor: () => undefined,
      runsInSandbox: () => false,
      clearPath: async () => undefined,
      workspaceRootFor: () => undefined,
      ensureChannel: async () => {},
      withSandbox: async (_id: string, work: () => Promise<unknown>) => work(),
      probeRuntimes: async () => ({ runtimes: [] }),
      launchedAgents: () => [],
      adoptAgent: async () => {},
      releaseAgent: () => {},
      suspendIdle: async () => 'absent',
      discardAgent: async () => {},
      stop: async () => {}
    } as never
  }
}

function daemon(opts: { root: string; vm?: boolean; k8s?: boolean; onPlaneStart?: (o: any) => void }): Daemon {
  return new Daemon({
    root: opts.root,
    ...(opts.vm ? { vm: true, startVmPlane: stubPlane(opts.onPlaneStart) as never } : {}),
    ...(opts.k8s ? { k8s: true } : {}),
    startControlPlane: vi.fn(() => Promise.resolve()) as never,
    resolveCatalog: async () => catalog(),
    hostFactory: () => ({}) as never
  })
}

describe('daemon --vm mode', () => {
  // Two placements cannot both own an agent's runtime, and picking one silently would put agent
  // code somewhere the operator did not ask for.
  it('refuses --k8s and --vm together rather than choosing one', () => {
    expect(() => daemon({ root: root(), vm: true, k8s: true })).toThrow(/mutually exclusive/)
  })

  it('installs the execution plane and points it at the configured image', async () => {
    const rootDir = root()
    let seen: any
    const instance = daemon({ root: rootDir, vm: true, onPlaneStart: (o) => (seen = o) })
    try {
      await instance.start()
      expect(seen).toBeDefined()
      expect(await seen.guestImage()).toBe(join(rootDir, VM_IMAGE_DIR))
      expect(seen.memberId).toBeDefined()
      expect(seen.disks.dataDiskPath('agent-a')).toBe(join(rootDir, 'vms', 'agent-a', 'data.img'))
      expect(seen.vmm.binary).toBe(join(rootDir, VM_BIN))
      // Every guest gets the MCP bridge; a managed-credential workspace also gets gitcred.
      expect(seen.tunnelsFor('unknown-agent')).toEqual([])
      expect(seen.budget.cpuPerVm).toBe(1)
    } finally {
      await instance.stop()
    }
  })

  // The first placement that can advertise `sandbox` honestly: a hypervisor boundary is a real
  // one, which is why --k8s on the cluster's default runtimeClass deliberately does not claim it.
  it('advertises the sandbox capability, and the sandbox-shaped CP features with it', async () => {
    const instance = daemon({ root: root(), vm: true })
    try {
      await instance.start()
      const features: string[] = (instance as any).registrationFeatures()
      expect(features).toContain('sandbox')
      expect(features).toContain(SANDBOX_KEEP_ALIVE_FEATURE)
      expect(features).toContain(AGENT_WAKE_FEATURE)
    } finally {
      await instance.stop()
    }
  })

  // On macOS the in-process SRT mechanism does not exist, so before --vm this configuration could
  // not be honoured at all on this platform.
  it('satisfies requireSandbox, which no other placement can do on this platform', async () => {
    const instance = daemon({ root: root({ requireSandbox: true }), vm: true })
    try {
      await expect(instance.start()).resolves.toBeUndefined()
      expect((instance as any).registrationFeatures()).toContain('sandbox-required')
    } finally {
      await instance.stop()
    }
  })

  // Fail-closed: degrading to a local child process is agent code on this host with the daemon
  // user's authority, which is the one outcome the mode exists to prevent.
  it('refuses to boot without the helper, naming how to build it', async () => {
    const instance = daemon({ root: root({ helper: false }), vm: true })
    await expect(instance.start()).rejects.toThrow(/make -C packages\/vmm build/)
  })

  it('refuses to boot without a guest image, naming how to build one', async () => {
    const instance = daemon({ root: root({ image: false }), vm: true })
    await expect(instance.start()).rejects.toThrow(/make -C packages\/vmm image/)
  })

  it('changes nothing when the flag is absent', async () => {
    const instance = daemon({ root: root() })
    try {
      await instance.start()
      const features: string[] = (instance as any).registrationFeatures()
      expect(features).not.toContain(SANDBOX_KEEP_ALIVE_FEATURE)
    } finally {
      await instance.stop()
    }
  })
})
