/**
 * Moving envelopes onto a published daemon version: the console's per-org command
 * (`setDaemonVersion`) and the boot-time deployment sweep (`alignDaemonVersion` behind
 * `ClusterDaemonImageSync`).
 *
 * The sweep's whole risk is doing too much — rolling a fleet backwards, or stomping an
 * org somebody pointed elsewhere — so most of what is asserted here is what it leaves
 * alone. It writes through the settings row on purpose: the periodic re-apply renders the
 * spec from that row, so an image applied only to the CR would be reverted.
 */
import { describe, expect, it } from 'vitest'
import { ClusterDaemonImageSync } from './image-sync.js'
import {
  ClusterEnvelopeNotEnabledError,
  ClusterExecutionService,
  ClusterImageNotVersionedError,
  ClusterImageWriteDeferredError,
  type ClusterExecutionPolicy
} from './service.js'
import type { OrgResourceApi } from './org-api.js'
import type { AgentConnectOrg, AgentConnectOrgSpec } from './crd.js'
import { OrgId } from '../domain/ids.js'
import { systemClock } from '../domain/clock.js'
import type {
  ClusterExecutionDefaults,
  ClusterExecutionPatch,
  ClusterExecutionSettings,
  OrgClusterExecutionRepo,
  PendingEnvelopeTeardown
} from '../persistence/ports.js'

const INSTALL_IMAGE = 'registry.example.test/agentconnect/daemon:v1.4.0'
const POLICY: ClusterExecutionPolicy = {
  namespacePrefix: 'ac-org-',
  daemonImage: INSTALL_IMAGE,
  runtimeImage: 'registry.example.test/agentconnect/runtime:v1.4.0',
  daemonTier: 'small',
  runtimeTiers: [{ name: 'small', warmReplicas: 0 }],
  controlPlaneUrl: 'wss://api.example.test/daemon/ws'
}

/** Multi-org in-memory rows — the sweep's unit of work is the whole enabled set. */
class FakeRepo implements OrgClusterExecutionRepo {
  rows = new Map<string, ClusterExecutionSettings>()

  seed(orgId: string, daemonImage: string, enabled = true): void {
    this.rows.set(orgId, {
      orgId,
      enabled,
      specRevision: 1,
      resourceName: orgId,
      suspend: false,
      daemonImage,
      daemonTier: 'small',
      runtimeImage: POLICY.runtimeImage,
      runtimeTiers: POLICY.runtimeTiers,
      quota: { maxAgents: 0, cpu: '0', memory: '0', storage: '0' },
      egressPolicy: 'curated',
      createdAt: new Date(0),
      updatedAt: new Date(0)
    })
  }

  async get(orgId: OrgId): Promise<ClusterExecutionSettings | null> {
    const row = this.rows.get(orgId)
    return row ? { ...row } : null
  }

  async getByResourceName(name: string): Promise<ClusterExecutionSettings | null> {
    for (const row of this.rows.values()) if (row.resourceName === name) return { ...row }
    return null
  }

  async listEnabled(): Promise<ClusterExecutionSettings[]> {
    return [...this.rows.values()].filter((r) => r.enabled).map((r) => ({ ...r }))
  }

  async listPendingTeardowns(): Promise<PendingEnvelopeTeardown[]> {
    return []
  }

  /** Nothing here claims a transition, so the periodic pass sees every enabled org. */
  async listResyncableOrgIds(afterOrgId: string | null, limit: number): Promise<string[]> {
    return [...this.rows.values()]
      .filter((row) => row.enabled)
      .map((row) => row.orgId)
      .filter((orgId) => afterOrgId === null || orgId > afterOrgId)
      .sort()
      .slice(0, limit)
  }

  async clearPendingTeardown(): Promise<void> {}

  async beginTransition(orgId: OrgId): Promise<ClusterExecutionSettings | null> {
    return this.get(orgId)
  }

  async endTransition(): Promise<void> {}

  async disableAndRecordTeardown(): Promise<boolean> {
    return true
  }

  async createIfAbsent(): Promise<void> {}

  async upsert(
    orgId: OrgId,
    _defaults: ClusterExecutionDefaults,
    patch: ClusterExecutionPatch
  ): Promise<ClusterExecutionSettings> {
    const base = this.rows.get(orgId)!
    const next: ClusterExecutionSettings = {
      ...base,
      specRevision: base.specRevision + 1,
      ...(patch.daemonImage !== undefined ? { daemonImage: patch.daemonImage } : {})
    }
    this.rows.set(orgId, next)
    return next
  }
}

class FakeApi implements OrgResourceApi {
  readonly namespace = 'agentconnect-control'
  applied: { name: string; spec: AgentConnectOrgSpec }[] = []
  failFor = new Set<string>()

  async apply(name: string, spec: AgentConnectOrgSpec): Promise<AgentConnectOrg> {
    if (this.failFor.has(name)) throw new Error('cluster unreachable')
    this.applied.push({ name, spec })
    return { spec }
  }

  async get(): Promise<AgentConnectOrg | null> {
    return { metadata: { uid: 'uid-1', resourceVersion: '1' } }
  }

  async delete(): Promise<void> {}
}

function build(policy: Partial<ClusterExecutionPolicy> = {}) {
  const repo = new FakeRepo()
  const api = new FakeApi()
  const service = new ClusterExecutionService(
    repo,
    api,
    { slugById: async () => 'acme' },
    { ...POLICY, ...policy },
    { clusterBoundIds: async () => [] },
    systemClock
  )
  return { repo, api, service }
}

/** The image the CR was last applied with, for one org. */
const appliedImage = (api: FakeApi, name: string): string | undefined =>
  [...api.applied].reverse().find((a) => a.name === name)?.spec.daemon.image

describe('ClusterExecutionService.setDaemonVersion', () => {
  it('rewrites the tag and applies the CR', async () => {
    const { repo, api, service } = build()
    repo.seed('acme', 'registry.example.test/agentconnect/daemon:v1.4.0')
    const image = await service.setDaemonVersion(OrgId('acme'), '1.5.0')
    expect(image).toBe('registry.example.test/agentconnect/daemon:v1.5.0')
    expect(appliedImage(api, 'acme')).toBe('registry.example.test/agentconnect/daemon:v1.5.0')
    // Through the row, not around it: the periodic re-apply would revert a CR-only write.
    expect((await repo.get(OrgId('acme')))!.daemonImage).toBe('registry.example.test/agentconnect/daemon:v1.5.0')
  })

  // Unlike the sweep, an explicit command may move backwards — the picker offers every
  // published version, and an operator rolling back a bad release is the point.
  it('allows an explicit downgrade', async () => {
    const { repo, service } = build()
    repo.seed('acme', 'registry.example.test/agentconnect/daemon:v1.5.0')
    expect(await service.setDaemonVersion(OrgId('acme'), '1.4.0')).toBe(
      'registry.example.test/agentconnect/daemon:v1.4.0'
    )
  })

  it('refuses an organization with no live envelope', async () => {
    const { repo, service } = build()
    repo.seed('acme', INSTALL_IMAGE, false)
    await expect(service.setDaemonVersion(OrgId('acme'), '1.5.0')).rejects.toThrow(ClusterEnvelopeNotEnabledError)
    await expect(service.setDaemonVersion(OrgId('nobody'), '1.5.0')).rejects.toThrow(ClusterEnvelopeNotEnabledError)
  })

  it('refuses a digest-pinned image rather than discarding the pin', async () => {
    const { repo, api, service } = build()
    repo.seed('acme', `registry.example.test/agentconnect/daemon@sha256:${'a'.repeat(64)}`)
    await expect(service.setDaemonVersion(OrgId('acme'), '1.5.0')).rejects.toThrow(ClusterImageNotVersionedError)
    expect(api.applied).toHaveLength(0)
  })

  /**
   * A floating tag says which image to run, never how the repository spells a version. The
   * install's own reference does say, for its own repository — so an org that drifted onto
   * `:latest` upgrades to the tag this deployment actually publishes.
   */
  it('takes the convention from the install reference when the org tag is floating', async () => {
    const { repo, service } = build()
    repo.seed('acme', 'registry.example.test/agentconnect/daemon:latest')
    expect(await service.setDaemonVersion(OrgId('acme'), '1.5.0')).toBe(
      'registry.example.test/agentconnect/daemon:v1.5.0'
    )
  })

  // Neither side names a version, so composing one would invent a tag nothing published.
  it('refuses a floating tag when the install reference is floating too', async () => {
    const { repo, api, service } = build({ daemonImage: 'registry.example.test/agentconnect/daemon:latest' })
    repo.seed('acme', 'registry.example.test/agentconnect/daemon:latest')
    await expect(service.setDaemonVersion(OrgId('acme'), '1.5.0')).rejects.toThrow(ClusterImageNotVersionedError)
    expect(api.applied).toHaveLength(0)
  })

  // A convention observed on one registry says nothing about another's tags.
  it('refuses a floating tag on a repository the install did not configure', async () => {
    const { repo, api, service } = build()
    repo.seed('acme', 'other.registry.test/fork/daemon:latest')
    await expect(service.setDaemonVersion(OrgId('acme'), '1.5.0')).rejects.toThrow(ClusterImageNotVersionedError)
    expect(api.applied).toHaveLength(0)
  })

  /**
   * An apply that fails AFTER the row was written is not a failed upgrade: the periodic
   * re-apply renders the spec from the row, so the pod is still going to be replaced.
   * Saying "failed" here is what would let a caller close an operation that then executes.
   */
  it('reports a durable write the cluster refused as deferred, not failed', async () => {
    const { repo, api, service } = build()
    repo.seed('acme', 'registry.example.test/agentconnect/daemon:v1.4.0')
    api.failFor.add('acme')
    await expect(service.setDaemonVersion(OrgId('acme'), '1.5.0')).rejects.toThrow(ClusterImageWriteDeferredError)
    // The distinguishing fact: the desired state survived the failure.
    expect((await repo.get(OrgId('acme')))!.daemonImage).toBe('registry.example.test/agentconnect/daemon:v1.5.0')
  })

  // The refusals above are checked BEFORE any write, which is what makes them safe to
  // report as terminal — nothing is left behind for a later pass to enact.
  it('writes nothing when it refuses', async () => {
    const { repo, service } = build()
    repo.seed('acme', INSTALL_IMAGE, false)
    await expect(service.setDaemonVersion(OrgId('acme'), '1.5.0')).rejects.toThrow(ClusterEnvelopeNotEnabledError)
    expect((await repo.get(OrgId('acme')))!.daemonImage).toBe(INSTALL_IMAGE)
  })
})

describe('ClusterExecutionService.alignDaemonVersion', () => {
  it('moves only the envelopes that are behind', async () => {
    const { repo, api, service } = build()
    repo.seed('behind', 'registry.example.test/agentconnect/daemon:v1.4.0')
    repo.seed('current', 'registry.example.test/agentconnect/daemon:v1.5.0')
    repo.seed('ahead', 'registry.example.test/agentconnect/daemon:v1.6.0')
    repo.seed('off', 'registry.example.test/agentconnect/daemon:v1.4.0', false)

    const sweep = await service.alignDaemonVersion('1.5.0')
    expect(sweep.moved).toEqual(['behind'])
    expect(sweep.scanned).toBe(3) // the disabled envelope is not even listed
    expect(sweep.skipped).toBe(2)
    expect(appliedImage(api, 'behind')).toBe('registry.example.test/agentconnect/daemon:v1.5.0')
    expect(appliedImage(api, 'ahead')).toBeUndefined()
    expect((await repo.get(OrgId('ahead')))!.daemonImage).toBe('registry.example.test/agentconnect/daemon:v1.6.0')
  })

  // Somebody pointed this org at their own registry; this channel says nothing about it.
  it('leaves an envelope on another repository alone', async () => {
    const { repo, api, service } = build()
    repo.seed('elsewhere', 'other.registry.test/fork/daemon:v1.4.0')
    const sweep = await service.alignDaemonVersion('1.5.0')
    expect(sweep.moved).toEqual([])
    expect(api.applied).toHaveLength(0)
  })

  it('leaves a floating tag and a digest pin alone', async () => {
    const { repo, api, service } = build()
    repo.seed('floating', 'registry.example.test/agentconnect/daemon:latest')
    repo.seed('pinned', `registry.example.test/agentconnect/daemon@sha256:${'b'.repeat(64)}`)
    const sweep = await service.alignDaemonVersion('1.5.0')
    expect(sweep.moved).toEqual([])
    expect(sweep.skipped).toBe(2)
    expect(api.applied).toHaveLength(0)
  })

  // Both orgs move: the one whose apply failed had its row written, and that row is what
  // the re-apply pass renders from — so it converges without a second sweep.
  it('counts an unappliable envelope as moved and keeps going', async () => {
    const { repo, api, service } = build()
    repo.seed('broken', 'registry.example.test/agentconnect/daemon:v1.4.0')
    repo.seed('fine', 'registry.example.test/agentconnect/daemon:v1.4.0')
    api.failFor.add('broken')

    const sweep = await service.alignDaemonVersion('1.5.0')
    expect(sweep.moved).toEqual(['broken', 'fine'])
    expect(sweep.failed).toEqual([])
    expect((await repo.get(OrgId('broken')))!.daemonImage).toBe('registry.example.test/agentconnect/daemon:v1.5.0')
  })

  // A row that could not be written IS a failure — nothing durable, nothing to converge.
  it('records an envelope whose row could not be written as failed', async () => {
    const { repo, service } = build()
    repo.seed('acme', 'registry.example.test/agentconnect/daemon:v1.4.0')
    repo.upsert = async () => {
      throw new Error('database unavailable')
    }
    const sweep = await service.alignDaemonVersion('1.5.0')
    expect(sweep.moved).toEqual([])
    expect(sweep.failed.map((f) => f.orgId)).toEqual(['acme'])
  })
})

describe('ClusterDaemonImageSync', () => {
  const logs = () => {
    const entries: { level: string; obj: Record<string, unknown>; msg: string }[] = []
    return {
      entries,
      info: (obj: Record<string, unknown>, msg: string) => entries.push({ level: 'info', obj, msg }),
      warn: (obj: Record<string, unknown>, msg: string) => entries.push({ level: 'warn', obj, msg })
    }
  }

  it('sweeps the fleet onto the channel version', async () => {
    const { repo, api, service } = build()
    repo.seed('acme', 'registry.example.test/agentconnect/daemon:v1.4.0')
    const log = logs()
    await new ClusterDaemonImageSync(
      service,
      { resolve: async () => ({ channel: 'rc', latestVersion: '1.5.0-rc.2', availableVersions: [] }) },
      log
    ).run()
    expect(appliedImage(api, 'acme')).toBe('registry.example.test/agentconnect/daemon:v1.5.0-rc.2')
    expect(log.entries.at(-1)).toMatchObject({ level: 'info', obj: { moved: 1, version: '1.5.0-rc.2' } })
  })

  // Nothing is known to be newer, so guessing a version onto every envelope is the one
  // thing this must not do.
  it('touches nothing when the channel has no published version', async () => {
    const { repo, api, service } = build()
    repo.seed('acme', 'registry.example.test/agentconnect/daemon:v1.4.0')
    const log = logs()
    await new ClusterDaemonImageSync(
      service,
      { resolve: async () => ({ channel: 'rc', latestVersion: null, availableVersions: [] }) },
      log
    ).run()
    expect(api.applied).toHaveLength(0)
    expect(log.entries.at(-1)?.level).toBe('warn')
  })

  it('never throws — the control plane must boot regardless', async () => {
    const { service } = build()
    const log = logs()
    await expect(
      new ClusterDaemonImageSync(
        service,
        {
          resolve: async () => {
            throw new Error('npm unreachable')
          }
        },
        log
      ).run()
    ).resolves.toBeUndefined()
    expect(log.entries.at(-1)?.level).toBe('warn')
  })
})
