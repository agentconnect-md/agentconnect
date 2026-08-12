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
  ClusterVersionNotPublishedError,
  type ClusterExecutionPolicy
} from './service.js'
import type { OrgResourceApi } from './org-api.js'
import type { AgentConnectOrg, AgentConnectOrgSpec } from './crd.js'
import { DaemonId, OrgId } from '../domain/ids.js'
import { systemClock } from '../domain/clock.js'
import type {
  ClusterExecutionDefaults,
  ClusterExecutionPatch,
  ClusterExecutionSettings,
  OrgClusterExecutionRepo,
  OverdueUpgradeCompensation,
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

  /** Conditional on the image, and reports what the row ends up holding. */
  async restoreDaemonImage(orgId: OrgId, daemonImage: string, expectedImage: string): Promise<string | null> {
    const row = this.rows.get(orgId)
    if (!row) return null
    if (row.daemonImage === expectedImage) {
      this.rows.set(orgId, { ...row, daemonImage, specRevision: row.specRevision + 1 })
      return daemonImage
    }
    return row.daemonImage
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
      ...(patch.suspend !== undefined ? { suspend: patch.suspend } : {}),
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

/** The compensation worklist plus a record of what got settled. */
class FakeOps {
  owed: OverdueUpgradeCompensation[] = []
  settled: { opId: string; status: string; outcome: string | null }[] = []
  /** Ops a peer closed between the listing and the settle. */
  alreadyClosed = new Set<string>()

  async listOverdueCompensations(): Promise<OverdueUpgradeCompensation[]> {
    return [...this.owed]
  }

  async settle(opId: string, status: 'succeeded' | 'failed', outcome: string | null): Promise<boolean> {
    if (this.alreadyClosed.has(opId)) return false
    this.settled.push({ opId, status, outcome })
    return true
  }
}

function build(policy: Partial<ClusterExecutionPolicy> = {}) {
  const repo = new FakeRepo()
  const api = new FakeApi()
  const ops = new FakeOps()
  const service = new ClusterExecutionService(
    repo,
    api,
    { slugById: async () => 'acme' },
    { ...POLICY, ...policy },
    { clusterBoundIds: async () => [] },
    ops,
    systemClock
  )
  return { repo, api, ops, service }
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

  // The seam re-checks its own input: it composes the tag, and an unnormalized `v1.5.0`
  // arriving here would become `vv1.5.0` in a registry reference.
  it('normalizes an image-spelled target and refuses a dist-tag', async () => {
    const { repo, service } = build()
    repo.seed('acme', 'registry.example.test/agentconnect/daemon:v1.4.0')
    expect(await service.setDaemonVersion(OrgId('acme'), 'v1.5.0')).toBe(
      'registry.example.test/agentconnect/daemon:v1.5.0'
    )
    await expect(service.setDaemonVersion(OrgId('acme'), 'latest')).rejects.toThrow(ClusterVersionNotPublishedError)
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

  /**
   * Converging on its own is right for the fleet sweep and wrong for a command, which has a
   * deadline it would outlive. Abandoning restores the previous image so "failed" is the
   * truth rather than a description that expires.
   */
  it('abandons a deferred image back to the previous one', async () => {
    const { repo, api, service } = build()
    repo.seed('acme', 'registry.example.test/agentconnect/daemon:v1.4.0')
    api.failFor.add('acme')
    const deferred = await service.setDaemonVersion(OrgId('acme'), '1.5.0').catch((e) => e)
    expect(await service.abandonDaemonVersion(OrgId('acme'), deferred.image, deferred.previousImage)).toBe(true)
    expect((await repo.get(OrgId('acme')))!.daemonImage).toBe('registry.example.test/agentconnect/daemon:v1.4.0')
  })

  /**
   * A peer that replaced the image owns it, so reverting blindly would discard their value.
   * It still counts as abandoned: what will be applied is their image, not this call's, so
   * the caller's operation is genuinely not going to happen.
   */
  it('leaves a peer’s later image alone and still reports abandoned', async () => {
    const { repo, api, service } = build()
    repo.seed('acme', 'registry.example.test/agentconnect/daemon:v1.4.0')
    api.failFor.add('acme')
    const deferred = await service.setDaemonVersion(OrgId('acme'), '1.5.0').catch((e) => e)
    await repo.upsert(OrgId('acme'), {} as never, {
      daemonImage: 'registry.example.test/agentconnect/daemon:v1.7.0'
    })
    expect(await service.abandonDaemonVersion(OrgId('acme'), deferred.image, deferred.previousImage)).toBe(true)
    expect((await repo.get(OrgId('acme')))!.daemonImage).toBe('registry.example.test/agentconnect/daemon:v1.7.0')
  })

  /**
   * The hole a revision fence left open. Any unrelated settings edit — quota here — bumps
   * the revision while leaving this command's image exactly where it was, so a
   * revision-fenced restore matched nothing and reported success over a change that the
   * re-apply pass would still enact. Fencing on the IMAGE is what closes it.
   */
  it('still rolls back after an unrelated settings edit bumped the revision', async () => {
    const { repo, api, service } = build()
    repo.seed('acme', 'registry.example.test/agentconnect/daemon:v1.4.0')
    api.failFor.add('acme')
    const deferred = await service.setDaemonVersion(OrgId('acme'), '1.5.0').catch((e) => e)
    await repo.upsert(OrgId('acme'), {} as never, { suspend: true })

    expect(await service.abandonDaemonVersion(OrgId('acme'), deferred.image, deferred.previousImage)).toBe(true)
    expect((await repo.get(OrgId('acme')))!.daemonImage).toBe('registry.example.test/agentconnect/daemon:v1.4.0')
  })

  // Verified, not assumed: a restore that silently matched nothing must not read as success.
  it('reports not-abandoned when the image survives the restore', async () => {
    const { repo, api, service } = build()
    repo.seed('acme', 'registry.example.test/agentconnect/daemon:v1.4.0')
    api.failFor.add('acme')
    const deferred = await service.setDaemonVersion(OrgId('acme'), '1.5.0').catch((e) => e)
    // A store whose conditional update lands nowhere and says nothing about it.
    repo.restoreDaemonImage = async () => 'registry.example.test/agentconnect/daemon:v1.5.0'
    expect(await service.abandonDaemonVersion(OrgId('acme'), deferred.image, deferred.previousImage)).toBe(false)
  })

  // The restore failing is the one case where the image really is still coming.
  it('reports not-abandoned when the restore itself fails', async () => {
    const { repo, api, service } = build()
    repo.seed('acme', 'registry.example.test/agentconnect/daemon:v1.4.0')
    api.failFor.add('acme')
    const deferred = await service.setDaemonVersion(OrgId('acme'), '1.5.0').catch((e) => e)
    repo.restoreDaemonImage = async () => {
      throw new Error('database unavailable')
    }
    expect(await service.abandonDaemonVersion(OrgId('acme'), deferred.image, deferred.previousImage)).toBe(false)
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

/**
 * The durable half of the rollback. An in-request abandon is one process's intention; this is
 * the same decision reconstructed from the obligation stored on the operation, so a control
 * plane that exited mid-command — or one whose bounded retries ran out — still finishes it.
 *
 * The rule under test is one-directional: an operation becomes terminal only once its image
 * is OBSERVED gone. While the image is still durable it is still going to be applied, and
 * that is exactly when reporting failure would be the contradiction.
 */
describe('ClusterExecutionService.drainUpgradeCompensations', () => {
  const owed = (orgId: string, command: string, rollback: string): OverdueUpgradeCompensation => ({
    opId: `op-${orgId}`,
    daemonId: DaemonId('11111111-1111-4111-8111-111111111111'),
    orgId,
    commandImage: command,
    rollbackImage: rollback
  })

  it('restores the envelope and settles the operation failed', async () => {
    const { repo, ops, service } = build()
    repo.seed('acme', 'registry.example.test/agentconnect/daemon:v1.5.0')
    ops.owed = [
      owed(
        'acme',
        'registry.example.test/agentconnect/daemon:v1.5.0',
        'registry.example.test/agentconnect/daemon:v1.4.0'
      )
    ]

    expect(await service.drainUpgradeCompensations()).toBe(1)
    expect((await repo.get(OrgId('acme')))!.daemonImage).toBe('registry.example.test/agentconnect/daemon:v1.4.0')
    expect(ops.settled).toEqual([{ opId: 'op-acme', status: 'failed', outcome: expect.any(String) }])
  })

  // The whole point: an operation whose change is still coming stays pending.
  it('leaves an operation pending while its image is still durable', async () => {
    const { repo, ops, service } = build()
    repo.seed('acme', 'registry.example.test/agentconnect/daemon:v1.5.0')
    repo.restoreDaemonImage = async () => 'registry.example.test/agentconnect/daemon:v1.5.0'
    ops.owed = [
      owed(
        'acme',
        'registry.example.test/agentconnect/daemon:v1.5.0',
        'registry.example.test/agentconnect/daemon:v1.4.0'
      )
    ]

    expect(await service.drainUpgradeCompensations()).toBe(0)
    expect(ops.settled).toEqual([])
  })

  // A peer that closed the op between the listing and here keeps its verdict — notably the
  // `succeeded` a recovered cluster's replacement pod would have written.
  it('does not count an operation a peer already closed', async () => {
    const { repo, ops, service } = build()
    repo.seed('acme', 'registry.example.test/agentconnect/daemon:v1.5.0')
    ops.owed = [
      owed(
        'acme',
        'registry.example.test/agentconnect/daemon:v1.5.0',
        'registry.example.test/agentconnect/daemon:v1.4.0'
      )
    ]
    ops.alreadyClosed.add('op-acme')

    expect(await service.drainUpgradeCompensations()).toBe(0)
  })

  it('keeps draining past an organization it cannot restore', async () => {
    const { repo, ops, service } = build()
    repo.seed('stuck', 'registry.example.test/agentconnect/daemon:v1.5.0')
    repo.seed('fine', 'registry.example.test/agentconnect/daemon:v1.5.0')
    const realRestore = repo.restoreDaemonImage.bind(repo)
    repo.restoreDaemonImage = async (orgId, image, expected) => {
      if (orgId === 'stuck') throw new Error('database unavailable')
      return realRestore(orgId, image, expected)
    }
    ops.owed = [
      owed(
        'stuck',
        'registry.example.test/agentconnect/daemon:v1.5.0',
        'registry.example.test/agentconnect/daemon:v1.4.0'
      ),
      owed(
        'fine',
        'registry.example.test/agentconnect/daemon:v1.5.0',
        'registry.example.test/agentconnect/daemon:v1.4.0'
      )
    ]

    expect(await service.drainUpgradeCompensations()).toBe(1)
    expect(ops.settled.map((s) => s.opId)).toEqual(['op-fine'])
  })
})
