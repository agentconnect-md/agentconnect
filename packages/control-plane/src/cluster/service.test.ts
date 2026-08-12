/**
 * The provisioner's convergence fence. The operator reconciles the CR, not the
 * settings row, and nothing here re-reads on a timer — so a write that applies
 * an older spec after a newer one would leave the two permanently apart. These
 * tests drive exactly that interleaving, plus the transition claim that keeps
 * enable, disable and the teardown drain from undoing each other.
 */
import { describe, expect, it } from 'vitest'
import { ClusterExecutionService, ClusterTransitionInProgressError, type ClusterExecutionPolicy } from './service.js'
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

const ORG = OrgId('acme')
const POLICY: ClusterExecutionPolicy = {
  namespacePrefix: 'ac-org-',
  daemonImage: 'registry.example.test/daemon:1',
  runtimeImage: 'registry.example.test/runtime:1',
  daemonTier: 'small',
  runtimeTiers: [{ name: 'small', warmReplicas: 0 }],
  controlPlaneUrl: 'wss://api.example.test/daemon/ws'
}

/** In-memory settings row with the repo's revision-bump-on-every-write contract. */
class FakeRepo implements OrgClusterExecutionRepo {
  row: ClusterExecutionSettings | null = null
  tombstones: PendingEnvelopeTeardown[] = []
  transitionAt: Date | null = null
  transitionToken: string | null = null
  /** Simulates a write whose row is cascaded away before anything reads it. */
  swallowUpsert = false

  async get(): Promise<ClusterExecutionSettings | null> {
    return this.row ? { ...this.row } : null
  }

  async getByResourceName(resourceName: string): Promise<ClusterExecutionSettings | null> {
    return this.row?.resourceName === resourceName ? { ...this.row } : null
  }

  async listPendingTeardowns(limit: number): Promise<PendingEnvelopeTeardown[]> {
    return this.tombstones.slice(0, limit)
  }

  async clearPendingTeardown(orgId: string): Promise<void> {
    this.tombstones = this.tombstones.filter((entry) => entry.orgId !== orgId)
  }

  async beginTransition(
    _orgId: OrgId,
    token: string,
    now: Date,
    leaseMs: number
  ): Promise<ClusterExecutionSettings | null> {
    if (!this.row) return null
    const held = this.transitionAt
    if (held && this.transitionToken && held.getTime() > now.getTime() - leaseMs) return null
    this.transitionAt = now
    this.transitionToken = token
    return { ...this.row }
  }

  async endTransition(_orgId: OrgId, token: string): Promise<void> {
    if (this.transitionToken !== token) return
    this.transitionAt = null
    this.transitionToken = null
  }

  async disableAndRecordTeardown(_orgId: OrgId, token: string): Promise<boolean> {
    if (this.transitionToken !== token || !this.row) return false
    this.tombstones.push({ orgId: this.row.orgId, resourceName: this.row.resourceName })
    this.row = { ...this.row, enabled: false, specRevision: this.row.specRevision + 1 }
    return true
  }

  /** Insert-only, like the repo's `ON CONFLICT DO NOTHING`. */
  async createIfAbsent(orgId: OrgId, defaults: ClusterExecutionDefaults): Promise<void> {
    if (this.row || this.swallowUpsert) return
    this.row = {
      orgId,
      enabled: false,
      specRevision: 1,
      suspend: false,
      ...defaults,
      createdAt: new Date(0),
      updatedAt: new Date(0)
    }
  }

  async upsert(
    orgId: OrgId,
    defaults: ClusterExecutionDefaults,
    patch: ClusterExecutionPatch
  ): Promise<ClusterExecutionSettings> {
    const base: ClusterExecutionSettings = this.row ?? {
      orgId,
      enabled: false,
      specRevision: 0,
      suspend: false,
      ...defaults,
      createdAt: new Date(0),
      updatedAt: new Date(0)
    }
    const next: ClusterExecutionSettings = {
      ...base,
      specRevision: base.specRevision + 1,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.suspend !== undefined ? { suspend: patch.suspend } : {}),
      ...(patch.daemonImage !== undefined ? { daemonImage: patch.daemonImage } : {})
    }
    if (!this.swallowUpsert) this.row = next
    return next
  }
}

class FakeApi implements OrgResourceApi {
  readonly namespace = 'agentconnect-control'
  applied: AgentConnectOrgSpec[] = []
  deleted: string[] = []
  /** Runs inside `apply`, so a test can land a peer write mid-flight. */
  duringApply?: () => Promise<void>

  failApply = false

  async apply(_name: string, spec: AgentConnectOrgSpec): Promise<AgentConnectOrg> {
    const hook = this.duringApply
    this.duringApply = undefined
    if (hook) await hook()
    if (this.failApply) throw new Error('cluster unreachable')
    this.applied.push(spec)
    return { spec }
  }

  /** The namespace is the OPERATOR's to derive and publish; absent until it has. */
  namespaceStatus: string | undefined = 'ac-org-acme'

  async get(): Promise<AgentConnectOrg | null> {
    if (!this.present) return null
    return {
      metadata: { uid: 'uid-1', resourceVersion: '1' },
      ...(this.namespaceStatus ? { status: { namespace: this.namespaceStatus } } : {})
    }
  }

  failDelete = false

  async delete(name: string): Promise<void> {
    if (this.failDelete) throw new Error('cluster unreachable')
    this.deleted.push(name)
  }

  /** The drain reads before it deletes, so a resource must exist to be deleted. */
  present = true
}

/** The identity binding the token path writes, as the org-delete guard reads it. */
class FakeDaemons {
  bound: string[] = []

  async clusterBoundIds(): Promise<string[]> {
    return this.bound
  }
}

interface Harness {
  service: ClusterExecutionService
  repo: FakeRepo
  api: FakeApi
  daemons: FakeDaemons
}

function build(): Harness {
  const repo = new FakeRepo()
  const api = new FakeApi()
  const daemons = new FakeDaemons()
  const service = new ClusterExecutionService(repo, api, { slugById: async () => 'acme' }, POLICY, daemons, systemClock)
  return { service, repo, api, daemons }
}

describe('ClusterExecutionService.configure', () => {
  it('applies the stored settings and returns them', async () => {
    const { service, api } = build()
    const settings = await service.configure(ORG, { enabled: true })
    expect(settings.enabled).toBe(true)
    expect(api.applied).toHaveLength(1)
    expect(api.applied[0]).toMatchObject({ displayName: 'acme' })
  })

  it('re-applies when a concurrent write superseded the snapshot it just applied', async () => {
    const { service, repo, api } = build()
    await service.configure(ORG, { enabled: true, daemonImage: 'first' })
    api.applied.length = 0

    // The peer's write lands after this request read the row and before its
    // apply completes — the interleaving that would otherwise revert the CR.
    api.duringApply = async () => {
      await repo.upsert(ORG, {} as ClusterExecutionDefaults, { daemonImage: 'second' })
    }
    const settings = await service.configure(ORG, { daemonImage: 'third' })

    expect(api.applied.map((spec) => spec.daemon.image)).toEqual(['third', 'second'])
    // The last apply matches the durable row, which is what the fence guarantees.
    expect(settings.daemonImage).toBe('second')
    expect((await repo.get())?.daemonImage).toBe('second')
  })

  it('stops re-applying once the row stops moving', async () => {
    const { service, api } = build()
    await service.configure(ORG, { enabled: true })
    await service.configure(ORG, { suspend: true })
    expect(api.applied).toHaveLength(2)
  })

  it('deletes the resource instead of applying when execution is switched off', async () => {
    const { service, api } = build()
    await service.configure(ORG, { enabled: true })
    await service.configure(ORG, { enabled: false })
    expect(api.deleted).toEqual(['acme'])
    expect(api.applied).toHaveLength(1)
  })

  it('removes the resource it just created when the org is deleted mid-flight', async () => {
    const { service, repo, api } = build()
    // The delete commits between this request's apply and its re-read, which is
    // the one window the tombstone written by that delete cannot cover.
    api.duringApply = async () => {
      repo.row = null
    }
    const settings = await service.configure(ORG, { enabled: true })

    expect(api.applied).toHaveLength(1)
    expect(api.deleted).toEqual(['acme'])
    expect(settings.enabled).toBe(false)
  })

  it('never applies at all when the org is already gone by the first read', async () => {
    const { service, repo, api } = build()
    repo.swallowUpsert = true
    await service.configure(ORG, { enabled: true })
    expect(api.applied).toHaveLength(0)
    expect(api.deleted).toHaveLength(0)
  })

  it('reports the deployment defaults for an org that never configured anything', async () => {
    const { service, api } = build()
    const settings = await service.settings(ORG)
    expect(settings).toMatchObject({
      enabled: false,
      specRevision: 0,
      resourceName: 'acme',
      daemonImage: POLICY.daemonImage,
      runtimeImage: POLICY.runtimeImage
    })
    expect(api.applied).toHaveLength(0)
  })

  it('records the teardown BEFORE touching the cluster on disable', async () => {
    const { service, repo, api } = build()
    await service.configure(ORG, { enabled: true })

    // A cluster that refuses the delete must not leave a disabled row beside a
    // live envelope with nothing recorded.
    api.failDelete = true
    await service.configure(ORG, { enabled: false })

    expect((await repo.get())?.enabled).toBe(false)
    expect(repo.tombstones.map((entry) => entry.orgId)).toEqual([ORG])

    // It settles on the next maintenance pass.
    api.failDelete = false
    expect(await service.drainTeardowns()).toBe(1)
    expect(api.deleted).toContain('acme')
  })

  it('cancels a pending teardown when the org is enabled again', async () => {
    const { service, repo, api } = build()
    await service.configure(ORG, { enabled: true })
    api.failDelete = true
    await service.configure(ORG, { enabled: false })
    expect(repo.tombstones).toHaveLength(1)

    api.failDelete = false
    await service.configure(ORG, { enabled: true })
    // Otherwise the drain would delete the resource this re-enable just created.
    expect(repo.tombstones).toEqual([])
  })

  it('refuses to enable behind a peer that owns the transition', async () => {
    const { service, repo } = build()
    await service.configure(ORG, { enabled: true })
    await repo.beginTransition(ORG, 'peer-token', new Date(), 60_000)
    await expect(service.configure(ORG, { enabled: true })).rejects.toThrow(ClusterTransitionInProgressError)
  })
})

describe('ClusterExecutionService.drainTeardowns', () => {
  it('deletes each deleted org’s resource and drops its tombstone', async () => {
    const { service, repo, api } = build()
    repo.tombstones = [
      { orgId: 'gone-1', resourceName: 'gone-1' },
      { orgId: 'gone-2', resourceName: 'gone-2' }
    ]
    expect(await service.drainTeardowns()).toBe(2)
    expect(api.deleted).toEqual(['gone-1', 'gone-2'])
    expect(repo.tombstones).toEqual([])
  })

  it('keeps a tombstone whose resource could not be deleted, for the next pass', async () => {
    const { service, repo, api } = build()
    repo.tombstones = [{ orgId: 'gone', resourceName: 'gone' }]
    api.failDelete = true
    // Swallowed per row: one unreachable envelope must not hold up the others,
    // and callers that only recorded an intent must not fail on the sweep.
    expect(await service.drainTeardowns()).toBe(0)
    expect(repo.tombstones).toHaveLength(1)

    api.failDelete = false
    expect(await service.drainTeardowns()).toBe(1)
    expect(repo.tombstones).toEqual([])
  })

  it('is a no-op when nothing is pending', async () => {
    const { service, api } = build()
    expect(await service.drainTeardowns()).toBe(0)
    expect(api.deleted).toEqual([])
  })

  it('never deletes the resource a re-enable created, even from a stale listing', async () => {
    const { service, repo, api } = build()
    await service.configure(ORG, { enabled: true })
    api.failDelete = true
    await service.configure(ORG, { enabled: false })
    api.failDelete = false
    // The tombstone is still listed when the org comes back.
    await service.configure(ORG, { enabled: true })
    api.deleted.length = 0

    // A drain that had already listed the entry must not act on it now.
    repo.tombstones = [{ orgId: ORG, resourceName: 'acme' }]
    expect(await service.drainTeardowns()).toBe(0)
    expect(api.deleted).toEqual([])
  })

  it('skips an org whose transition someone else owns, and settles it next pass', async () => {
    const { service, repo, api } = build()
    await service.configure(ORG, { enabled: true })
    await service.configure(ORG, { enabled: false })
    api.deleted.length = 0
    repo.tombstones = [{ orgId: ORG, resourceName: 'acme' }]
    await repo.beginTransition(ORG, 'peer-token', new Date(), 60_000)

    expect(await service.drainTeardowns()).toBe(0)
    await repo.endTransition(ORG, 'peer-token')
    expect(await service.drainTeardowns()).toBe(1)
    expect(api.deleted).toEqual(['acme'])
  })
})

/**
 * The provisioning path an org create and every Daemons-page visit take. It has
 * to be safely repeatable, has to self-heal a CR that went missing, and must
 * never reverse an owner who switched cluster execution off.
 */
describe('ensureProvisioned', () => {
  it('provisions an org that was never configured', async () => {
    const { service, api } = build()
    const settings = await service.ensureProvisioned(ORG)
    expect(settings.enabled).toBe(true)
    expect(api.applied).toHaveLength(1)
  })

  it('is idempotent — a second pass changes nothing', async () => {
    const { service, repo } = build()
    await service.ensureProvisioned(ORG)
    const revision = repo.row?.specRevision
    const settings = await service.ensureProvisioned(ORG)
    expect(settings.enabled).toBe(true)
    expect(repo.row?.specRevision).toBe(revision)
  })

  // Nothing is delivered after the CR, so a namespace the operator has not
  // published yet leaves nothing owed — the pod's own token is its credential.
  it('does not wait on the operator publishing the envelope namespace', async () => {
    const { service, api } = build()
    api.namespaceStatus = undefined
    const settings = await service.ensureProvisioned(ORG)
    expect(settings.enabled).toBe(true)
    expect(api.applied).toHaveLength(1)
  })

  it('re-applies the spec when the resource went missing', async () => {
    const { service, api } = build()
    await service.ensureProvisioned(ORG)
    api.applied.length = 0
    api.present = false
    await service.ensureProvisioned(ORG)
    expect(api.applied).toHaveLength(1)
  })

  // Switching it off is a decision; a page load must not undo it.
  it('leaves an org whose owner disabled cluster execution alone', async () => {
    const { service, api } = build()
    await service.ensureProvisioned(ORG)
    await service.configure(ORG, { enabled: false })
    api.applied.length = 0

    const settings = await service.ensureProvisioned(ORG)
    expect(settings.enabled).toBe(false)
    expect(api.applied).toEqual([])
  })

  it('surfaces a cluster that refuses the apply', async () => {
    const { service, api } = build()
    api.failApply = true
    await expect(service.ensureProvisioned(ORG)).rejects.toThrow(/cluster unreachable/)
  })
})

/**
 * Which daemon records the organization delete may retire itself. Getting this
 * wrong in either direction is bad: naming too few makes an org undeletable,
 * naming too many silently detaches a machine someone attached by hand.
 */
describe('envelopeDaemonIds', () => {
  it('names the daemon bound to a Kubernetes identity', async () => {
    const { service, daemons } = build()
    daemons.bound = ['envelope-daemon']
    expect(await service.envelopeDaemonIds(ORG)).toEqual(['envelope-daemon'])
  })

  it('names an envelope provisioned under the retired key path, which has no binding yet', async () => {
    const { service, repo } = build()
    await service.configure(ORG, { enabled: true })
    repo.row = { ...repo.row!, legacyKeyDaemonId: 'pre-token-daemon' }
    expect(await service.envelopeDaemonIds(ORG)).toEqual(['pre-token-daemon'])
  })

  it('does not name it twice once its pod reconnected and adopted the record', async () => {
    const { service, repo, daemons } = build()
    await service.configure(ORG, { enabled: true })
    repo.row = { ...repo.row!, legacyKeyDaemonId: 'pre-token-daemon' }
    daemons.bound = ['pre-token-daemon']
    expect(await service.envelopeDaemonIds(ORG)).toEqual(['pre-token-daemon'])
  })

  it('names nothing for an org with no envelope', async () => {
    const { service } = build()
    expect(await service.envelopeDaemonIds(ORG)).toEqual([])
  })
})
