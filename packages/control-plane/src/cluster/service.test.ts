/**
 * The provisioner's convergence fence. The operator reconciles the CR, not the
 * settings row, and nothing here re-reads on a timer — so a write that applies
 * an older spec after a newer one would leave the two permanently apart. These
 * tests drive exactly that interleaving.
 */
import { describe, expect, it } from 'vitest'
import { ClusterExecutionService, type ClusterExecutionPolicy } from './service.js'
import type { OrgResourceApi } from './org-api.js'
import type { AgentConnectOrg, AgentConnectOrgSpec } from './crd.js'
import { OrgId } from '../domain/ids.js'
import type {
  ClusterExecutionDefaults,
  ClusterExecutionPatch,
  ClusterExecutionSettings,
  OrgClusterExecutionRepo
} from '../persistence/ports.js'

const ORG = OrgId('acme')
const POLICY: ClusterExecutionPolicy = {
  namespacePrefix: 'ac-org-',
  daemonImage: 'registry.example.test/daemon:1',
  runtimeImage: 'registry.example.test/runtime:1',
  daemonTier: 'small',
  runtimeTiers: [{ name: 'small', warmReplicas: 0 }]
}

/** In-memory settings row with the repo's revision-bump-on-every-write contract. */
class FakeRepo implements OrgClusterExecutionRepo {
  row: ClusterExecutionSettings | null = null

  async get(): Promise<ClusterExecutionSettings | null> {
    return this.row ? { ...this.row } : null
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
    this.row = {
      ...base,
      specRevision: base.specRevision + 1,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.suspend !== undefined ? { suspend: patch.suspend } : {}),
      ...(patch.daemonImage !== undefined ? { daemonImage: patch.daemonImage } : {})
    }
    return { ...this.row }
  }
}

class FakeApi implements OrgResourceApi {
  readonly namespace = 'agentconnect-control'
  applied: AgentConnectOrgSpec[] = []
  deleted: string[] = []
  /** Runs inside `apply`, so a test can land a peer write mid-flight. */
  duringApply?: () => Promise<void>

  async apply(_name: string, spec: AgentConnectOrgSpec): Promise<AgentConnectOrg> {
    const hook = this.duringApply
    this.duringApply = undefined
    if (hook) await hook()
    this.applied.push(spec)
    return { spec }
  }

  async get(): Promise<AgentConnectOrg | null> {
    return null
  }

  async delete(name: string): Promise<void> {
    this.deleted.push(name)
  }
}

function build(): { service: ClusterExecutionService; repo: FakeRepo; api: FakeApi } {
  const repo = new FakeRepo()
  const api = new FakeApi()
  const service = new ClusterExecutionService(repo, api, { slugById: async () => 'acme' }, POLICY)
  return { service, repo, api }
}

describe('ClusterExecutionService.configure', () => {
  it('applies the stored settings and returns them', async () => {
    const { service, api } = build()
    const settings = await service.configure(ORG, { enabled: true })
    expect(settings.enabled).toBe(true)
    expect(api.applied).toHaveLength(1)
    expect(api.applied[0]).toMatchObject({ targetNamespace: 'ac-org-acme', displayName: 'acme' })
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
    expect(api.deleted).toEqual(['ac-org-acme'])
    expect(api.applied).toHaveLength(1)
  })

  it('reports the deployment defaults for an org that never configured anything', async () => {
    const { service, api } = build()
    const settings = await service.settings(ORG)
    expect(settings).toMatchObject({
      enabled: false,
      specRevision: 0,
      targetNamespace: 'ac-org-acme',
      daemonImage: POLICY.daemonImage,
      runtimeImage: POLICY.runtimeImage
    })
    expect(api.applied).toHaveLength(0)
  })
})
