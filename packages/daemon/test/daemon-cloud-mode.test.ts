import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DAEMON_BOOTSTRAP_UPGRADE_FEATURE } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import type { ResolvedRuntimeCatalog } from '../src/runtimes/registry.js'

/** The behavior matrix for `--k8s`: each assertion here is one row of the mode
 *  contract, so cloud and self-hosted behavior cannot drift apart unnoticed. */

function root(opts: { declared?: unknown; requireSandbox?: boolean; cliEntry?: boolean } = {}): string {
  const path = mkdtempSync(join(tmpdir(), 'ac-cloud-mode-'))
  writeFileSync(
    join(path, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      ...(opts.requireSandbox ? { security: { requireSandbox: true } } : {})
    })
  )
  if (opts.declared !== undefined) {
    writeFileSync(join(path, 'k8s-runtimes.json'), JSON.stringify(opts.declared))
  }
  // A stale pointer left on the root volume is exactly the case that must NOT re-enable
  // the self-installing upgrade path in cloud mode. readCliEntry only accepts a pointer
  // whose target exists, so the fixture writes a real file to point at.
  if (opts.cliEntry) {
    const entry = join(path, 'cli-dist-entry.js')
    writeFileSync(entry, '// stand-in for an installed CLI entry\n')
    writeFileSync(join(path, 'cli-entry'), entry)
  }
  return path
}

function catalog(): ResolvedRuntimeCatalog {
  // Deliberately a command that does not exist on the test host: host discovery must
  // find nothing, so anything advertised came from the declared table.
  const absent = { command: 'ac-cloud-absent-runtime', args: [], env: [] }
  const hermes = { command: 'hermes', args: ['acp'], env: [] }
  return {
    entries: {
      claude: { runtime: absent, source: 'registry', name: 'Claude Code', version: '1.0.0', skillsAgentId: 'claude' },
      'hermes-agent': { runtime: hermes, source: 'curated', name: 'Hermes Agent', version: '', skillsAgentId: null }
    },
    runtimes: { claude: absent, 'hermes-agent': hermes }
  }
}

function daemon(opts: { root: string; k8s: boolean; probe?: ReturnType<typeof vi.fn>; supervisor?: string }): Daemon {
  return new Daemon({
    root: opts.root,
    cloud: opts.k8s,
    ...(opts.supervisor ? { supervisor: opts.supervisor } : {}),
    resolveCatalog: async () => catalog(),
    ...(opts.probe ? { probeRuntimes: opts.probe as never } : {}),
    hostFactory: () => ({}) as never
  })
}

describe('daemon --k8s mode', () => {
  it('advertises the runtimes the image declares, not what is installed on the host', async () => {
    const probe = vi.fn(async () => [])
    const cloud = daemon({
      root: root({ declared: { runtimes: [{ id: 'claude', models: ['sonnet'] }] } }),
      cloud: true,
      probe
    })
    try {
      await cloud.start()
      expect(Object.keys((cloud as any).runtimes)).toEqual(['claude'])
      // Never launches a runtime locally to learn this — the table is the source.
      expect(probe).not.toHaveBeenCalled()
      const profile = (cloud as any).runtimeProfileFor('claude')
      expect(profile.models).toEqual(['sonnet'])
      // Declared, not probed: model gates must stay permissive on this provenance.
      expect(profile.modelsSource).toBe('cached')
    } finally {
      await cloud.stop()
    }
  })

  it('advertises nothing in the same tree without --k8s, where host discovery decides', async () => {
    const local = daemon({ root: root({ declared: { runtimes: [{ id: 'claude' }] } }), cloud: false })
    try {
      await local.start()
      expect(Object.keys((local as any).runtimes)).toEqual([])
    } finally {
      await local.stop()
    }
  })

  it('drops a declared curated runtime instead of advertising one that cannot launch', async () => {
    const cloud = daemon({ root: root({ declared: { runtimes: [{ id: 'hermes-agent' }] } }), cloud: true })
    try {
      await cloud.start()
      expect(Object.keys((cloud as any).runtimes)).toEqual([])
    } finally {
      await cloud.stop()
    }
  })

  it('advertises no runtime and keeps running when the declared table is missing', async () => {
    const cloud = daemon({ root: root(), cloud: true })
    try {
      await cloud.start()
      expect(Object.keys((cloud as any).runtimes)).toEqual([])
    } finally {
      await cloud.stop()
    }
  })

  it('claims no sandbox capability: the pod is the isolation unit, not the SRT mechanism', async () => {
    const cloud = daemon({ root: root({ declared: { runtimes: [{ id: 'claude' }] } }), cloud: true })
    try {
      await cloud.start()
      expect((cloud as any).sandboxMechanism).toBeUndefined()
      const features: string[] = (cloud as any).registrationFeatures()
      expect(features).not.toContain('sandbox')
      expect(features).not.toContain('sandbox-required')
    } finally {
      await cloud.stop()
    }
  })

  it('refuses the self-installing upgrade even with a supervisor marker and a cli-entry present', async () => {
    // Both prerequisites of the normal capability check are satisfied here: without a
    // mode-level refusal, the daemon would advertise bootstrap-upgrade and accept a
    // command that runs the CLI installer and exits the pod for an unrequested version.
    const cloud = daemon({
      root: root({ declared: { runtimes: [{ id: 'claude' }] }, cliEntry: true }),
      cloud: true,
      supervisor: 'service'
    })
    try {
      await cloud.start()
      expect((cloud as any).bootstrapUpgradeCapable()).toBe(false)
      expect((cloud as any).registrationFeatures()).not.toContain(DAEMON_BOOTSTRAP_UPGRADE_FEATURE)
    } finally {
      await cloud.stop()
    }
  })

  it('still offers the self-installing upgrade outside cloud mode with the same prerequisites', async () => {
    // The control case, so the refusal above is attributable to the mode and not to a
    // missing prerequisite in the fixture.
    const local = daemon({ root: root({ cliEntry: true }), cloud: false, supervisor: 'service' })
    try {
      await local.start()
      expect((local as any).bootstrapUpgradeCapable()).toBe(true)
      expect((local as any).registrationFeatures()).toContain(DAEMON_BOOTSTRAP_UPGRADE_FEATURE)
    } finally {
      await local.stop()
    }
  })

  it('refuses to start when requireSandbox is configured, rather than pretending', async () => {
    const cloud = daemon({
      root: root({ declared: { runtimes: [{ id: 'claude' }] }, requireSandbox: true }),
      cloud: true
    })
    await expect(cloud.start()).rejects.toThrow(/requireSandbox is not supported with --k8s/)
  })
})
