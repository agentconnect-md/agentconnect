import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import type { ResolvedRuntimeCatalog } from '../src/runtimes/registry.js'

/** The behavior matrix for `--cloud`: each assertion here is one row of the mode
 *  contract, so cloud and self-hosted behavior cannot drift apart unnoticed. */

function root(opts: { declared?: unknown; requireSandbox?: boolean } = {}): string {
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
    writeFileSync(join(path, 'cloud-runtimes.json'), JSON.stringify(opts.declared))
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

function daemon(opts: { root: string; cloud: boolean; probe?: ReturnType<typeof vi.fn> }): Daemon {
  return new Daemon({
    root: opts.root,
    cloud: opts.cloud,
    resolveCatalog: async () => catalog(),
    ...(opts.probe ? { probeRuntimes: opts.probe as never } : {}),
    hostFactory: () => ({}) as never
  })
}

describe('daemon --cloud mode', () => {
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

  it('advertises nothing in the same tree without --cloud, where host discovery decides', async () => {
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
      // No CLI or version store in an image ⇒ no self-installing upgrade on offer.
      expect((cloud as any).bootstrapUpgradeCapable()).toBe(false)
    } finally {
      await cloud.stop()
    }
  })

  it('refuses to start when requireSandbox is configured, rather than pretending', async () => {
    const cloud = daemon({
      root: root({ declared: { runtimes: [{ id: 'claude' }] }, requireSandbox: true }),
      cloud: true
    })
    await expect(cloud.start()).rejects.toThrow(/requireSandbox is not supported with --cloud/)
  })
})
