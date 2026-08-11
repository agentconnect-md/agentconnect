/**
 * The provisioner's convergence fence. The operator reconciles the CR, not the
 * settings row, and nothing here re-reads on a timer — so a write that applies
 * an older spec after a newer one would leave the two permanently apart. These
 * tests drive exactly that interleaving.
 */
import { describe, expect, it } from 'vitest'
import {
  ClusterExecutionService,
  ClusterNotEnabledError,
  ClusterRotationInProgressError,
  type ClusterExecutionPolicy,
  type ClusterKeyAuthority
} from './service.js'
import { NamespaceNotReadyError, type OrgSecretApi } from './secret-api.js'
import type { OrgResourceApi } from './org-api.js'
import type { AgentConnectOrg, AgentConnectOrgSpec } from './crd.js'
import { OrgId } from '../domain/ids.js'
import { systemClock } from '../domain/clock.js'
import type {
  ClusterExecutionDefaults,
  ClusterExecutionPatch,
  ClusterExecutionSettings,
  OrgClusterExecutionRepo,
  PendingDaemonKeyRevocation,
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
  revocations: PendingDaemonKeyRevocation[] = []
  rotationAt: Date | null = null
  rotationToken: string | null = null
  /** Simulates an upsert whose row is cascaded away before anything reads it. */
  swallowUpsert = false

  async get(): Promise<ClusterExecutionSettings | null> {
    return this.row ? { ...this.row } : null
  }

  async listPendingTeardowns(limit: number): Promise<PendingEnvelopeTeardown[]> {
    return this.tombstones.slice(0, limit)
  }

  async clearPendingTeardown(orgId: string): Promise<void> {
    this.tombstones = this.tombstones.filter((entry) => entry.orgId !== orgId)
  }

  async beginCredentialRotation(
    _orgId: OrgId,
    token: string,
    now: Date,
    leaseMs: number
  ): Promise<ClusterExecutionSettings | null> {
    if (!this.row) return null
    const held = this.rotationAt
    if (held && this.rotationToken && held.getTime() > now.getTime() - leaseMs) return null
    this.rotationAt = now
    this.rotationToken = token
    const staged = this.row.credentialStagedApiKeyId
    if (staged) {
      await this.enqueueKeyRevocation(this.row.orgId, staged, 'cluster credential rotation abandoned')
      this.row = { ...this.row, credentialStagedApiKeyId: undefined }
    }
    return { ...this.row }
  }

  async endCredentialRotation(_orgId: OrgId, token: string): Promise<void> {
    if (this.rotationToken !== token) return
    this.rotationAt = null
    this.rotationToken = null
  }

  async stageCredentialDaemon(_orgId: OrgId, token: string, daemonId: string): Promise<boolean> {
    if (this.rotationToken !== token || !this.row) return false
    this.row = { ...this.row, credentialDaemonId: daemonId }
    return true
  }

  async stageCredentialKey(_orgId: OrgId, token: string, apiKeyId: string): Promise<boolean> {
    if (this.rotationToken !== token || !this.row) return false
    this.row = { ...this.row, credentialStagedApiKeyId: apiKeyId }
    return true
  }

  async commitCredential(
    _orgId: OrgId,
    token: string,
    credential: { daemonId: string; apiKeyId: string; revision: string },
    reason: string
  ): Promise<boolean> {
    if (this.rotationToken !== token || !this.row) return false
    const superseded = this.row.credentialApiKeyId
    this.row = {
      ...this.row,
      specRevision: this.row.specRevision + 1,
      credentialDaemonId: credential.daemonId,
      credentialApiKeyId: credential.apiKeyId,
      credentialRevision: credential.revision,
      credentialStagedApiKeyId: undefined
    }
    if (superseded && superseded !== credential.apiKeyId) {
      await this.enqueueKeyRevocation(this.row.orgId, superseded, reason)
    }
    return true
  }

  async abandonStagedCredential(_orgId: OrgId, token: string, reason: string): Promise<void> {
    if (this.rotationToken !== token || !this.row?.credentialStagedApiKeyId) return
    await this.enqueueKeyRevocation(this.row.orgId, this.row.credentialStagedApiKeyId, reason)
    this.row = { ...this.row, credentialStagedApiKeyId: undefined }
  }

  async retireCredential(_orgId: OrgId, token: string, reason: string): Promise<boolean> {
    if (this.rotationToken !== token || !this.row) return false
    for (const apiKeyId of [this.row.credentialApiKeyId, this.row.credentialStagedApiKeyId]) {
      if (apiKeyId) await this.enqueueKeyRevocation(this.row.orgId, apiKeyId, reason)
    }
    this.tombstones.push({ orgId: this.row.orgId, targetNamespace: this.row.targetNamespace })
    this.row = {
      ...this.row,
      specRevision: this.row.specRevision + 1,
      credentialApiKeyId: undefined,
      credentialRevision: undefined,
      credentialStagedApiKeyId: undefined
    }
    return true
  }

  async enqueueKeyRevocation(orgId: string, apiKeyId: string, reason: string): Promise<void> {
    if (!this.revocations.some((entry) => entry.apiKeyId === apiKeyId)) {
      this.revocations.push({ apiKeyId, orgId, reason })
    }
  }

  async listPendingKeyRevocations(limit: number): Promise<PendingDaemonKeyRevocation[]> {
    return this.revocations.slice(0, limit)
  }

  async clearKeyRevocation(apiKeyId: string): Promise<void> {
    this.revocations = this.revocations.filter((entry) => entry.apiKeyId !== apiKeyId)
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

  failDelete = false

  async delete(name: string): Promise<void> {
    if (this.failDelete) throw new Error('cluster unreachable')
    this.deleted.push(name)
  }
}

/** Records what the key authority published, so ordering can be asserted. */
class FakeSecrets implements OrgSecretApi {
  written: { namespace: string; name: string; configJson: string }[] = []
  namespaceMissing = false
  /** Runs inside the publish, so a test can steal the claim mid-flight. */
  duringApply?: () => void

  async applyCredential(namespace: string, name: string, configJson: string): Promise<void> {
    if (this.namespaceMissing) throw new NamespaceNotReadyError(namespace)
    this.duringApply?.()
    this.written.push({ namespace, name, configJson })
  }

  async delete(): Promise<void> {}
}

class FakeKeys implements ClusterKeyAuthority {
  minted = 0
  revoked: string[] = []
  failRevoke = false

  async provisionDaemon(): Promise<{ daemonId: string; apiKeyId: string; token: string }> {
    this.minted += 1
    return { daemonId: 'daemon-1', apiKeyId: `key-${this.minted}`, token: `token-${this.minted}` }
  }

  async mintForDaemon(): Promise<{ apiKeyId: string; token: string }> {
    this.minted += 1
    return { apiKeyId: `key-${this.minted}`, token: `token-${this.minted}` }
  }

  async revoke(apiKeyId: string): Promise<unknown> {
    if (this.failRevoke) throw new Error('revoke unavailable')
    this.revoked.push(apiKeyId)
    return undefined
  }
}

interface Harness {
  service: ClusterExecutionService
  repo: FakeRepo
  api: FakeApi
  secrets: FakeSecrets
  keys: FakeKeys
}

function build(): Harness {
  const repo = new FakeRepo()
  const api = new FakeApi()
  const secrets = new FakeSecrets()
  const keys = new FakeKeys()
  const service = new ClusterExecutionService(
    repo,
    api,
    { slugById: async () => 'acme' },
    POLICY,
    secrets,
    keys,
    systemClock
  )
  return { service, repo, api, secrets, keys }
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

  it('removes the resource it just created when the org is deleted mid-flight', async () => {
    const { service, repo, api } = build()
    // The delete commits between this request's apply and its re-read, which is
    // the one window the tombstone written by that delete cannot cover.
    api.duringApply = async () => {
      repo.row = null
    }
    const settings = await service.configure(ORG, { enabled: true })

    expect(api.applied).toHaveLength(1)
    expect(api.deleted).toEqual(['ac-org-acme'])
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
      targetNamespace: 'ac-org-acme',
      daemonImage: POLICY.daemonImage,
      runtimeImage: POLICY.runtimeImage
    })
    expect(api.applied).toHaveLength(0)
  })
})

describe('ClusterExecutionService.issueCredential', () => {
  it('publishes the Secret before bumping the revision that rolls the pod', async () => {
    const { service, api, secrets } = build()
    await service.configure(ORG, { enabled: true })
    api.applied.length = 0

    const view = await service.issueCredential(ORG)
    expect(secrets.written).toHaveLength(1)
    expect(secrets.written[0]).toMatchObject({ namespace: 'ac-org-acme', name: 'ac-daemon-token' })
    expect(JSON.parse(secrets.written[0]!.configJson)).toEqual({
      version: 1,
      daemonId: 'daemon-1',
      controlPlane: { enabled: true, url: POLICY.controlPlaneUrl, key: 'token-1' }
    })
    expect(api.applied.at(-1)?.daemon.credentialRevision).toBe(view.revision)
    expect(view.rotated).toBe(false)
  })

  it('leaves the running pod on its old key when the Secret cannot be written', async () => {
    const { service, repo, secrets, keys } = build()
    await service.configure(ORG, { enabled: true })
    const issued = await service.issueCredential(ORG)
    const settled = await repo.get()

    secrets.namespaceMissing = true
    await expect(service.issueCredential(ORG)).rejects.toThrow(NamespaceNotReadyError)
    // The published credential is untouched: no revision bump, and the key the
    // running pod holds is NOT the one that got revoked.
    expect((await repo.get())?.credentialRevision).toBe(settled?.credentialRevision)
    expect(keys.revoked).not.toContain(issued.revision)
  })

  it('revokes the key it minted when publication fails, instead of leaking it', async () => {
    const { service, repo, secrets, keys } = build()
    await service.configure(ORG, { enabled: true })
    secrets.namespaceMissing = true

    await expect(service.issueCredential(ORG)).rejects.toThrow(NamespaceNotReadyError)
    // Daemon keys never expire, so an unpublished one must not survive.
    expect(keys.revoked).toEqual(['key-1'])
    expect(repo.revocations).toEqual([])
  })

  it('reuses the daemon a failed first attempt provisioned, rather than making another', async () => {
    const { service, repo, secrets, keys } = build()
    await service.configure(ORG, { enabled: true })
    secrets.namespaceMissing = true
    await expect(service.issueCredential(ORG)).rejects.toThrow(NamespaceNotReadyError)
    expect((await repo.get())?.credentialDaemonId).toBe('daemon-1')

    secrets.namespaceMissing = false
    const issued = await service.issueCredential(ORG)
    expect(issued.daemonId).toBe('daemon-1')
    expect(keys.minted).toBe(2) // two keys, one daemon
  })

  it('lets exactly one caller own the transition', async () => {
    const { service, repo } = build()
    await service.configure(ORG, { enabled: true })
    // Someone else claimed it a moment ago and has not released it.
    await repo.beginCredentialRotation(ORG, 'peer-token', new Date(), 60_000)

    await expect(service.issueCredential(ORG)).rejects.toThrow(ClusterRotationInProgressError)
  })

  it('takes over a claim whose holder died, so the envelope is not wedged', async () => {
    const { service, repo } = build()
    await service.configure(ORG, { enabled: true })
    repo.rotationAt = new Date(Date.now() - 60 * 60 * 1000)
    repo.rotationToken = 'dead-holder'

    await expect(service.issueCredential(ORG)).resolves.toMatchObject({ rotated: false })
  })

  it('adopts the key a crashed rotation left staged, instead of stranding it', async () => {
    const { service, repo, keys } = build()
    await service.configure(ORG, { enabled: true })
    // A holder that died after staging its key and before committing it.
    repo.row = { ...repo.row!, credentialStagedApiKeyId: 'orphan-key' }
    repo.rotationAt = new Date(Date.now() - 60 * 60 * 1000)
    repo.rotationToken = 'dead-holder'

    await service.issueCredential(ORG)
    expect(keys.revoked).toContain('orphan-key')
    expect((await repo.get())?.credentialStagedApiKeyId).toBeUndefined()
  })

  it('refuses to commit behind the successor that took its claim over', async () => {
    const { service, repo, secrets, keys } = build()
    await service.configure(ORG, { enabled: true })
    // The claim is stolen while this pass is publishing — the exact window an
    // expiry timestamp alone could not fence.
    secrets.duringApply = () => {
      repo.rotationToken = 'successor'
    }

    await expect(service.issueCredential(ORG)).rejects.toThrow(ClusterRotationInProgressError)
    expect((await repo.get())?.credentialRevision).toBeUndefined()
    // The key it minted is not silently dropped.
    expect(keys.revoked).toEqual(['key-1'])
    // And its release did not unlock the successor.
    expect(repo.rotationToken).toBe('successor')
  })

  it('releases the claim even when the attempt fails', async () => {
    const { service, repo, secrets } = build()
    await service.configure(ORG, { enabled: true })
    secrets.namespaceMissing = true
    await expect(service.issueCredential(ORG)).rejects.toThrow(NamespaceNotReadyError)

    expect(repo.rotationAt).toBeNull()
    secrets.namespaceMissing = false
    await expect(service.issueCredential(ORG)).resolves.toBeDefined()
  })

  it('refuses on a disabled envelope, which disable has already retired', async () => {
    const { service, secrets } = build()
    await service.configure(ORG, { enabled: true })
    await service.issueCredential(ORG)
    await service.configure(ORG, { enabled: false })
    secrets.written.length = 0

    await expect(service.issueCredential(ORG)).rejects.toThrow(ClusterNotEnabledError)
    expect(secrets.written).toEqual([])
  })

  it('keeps owing a revocation whose attempt failed, and settles it on the next drain', async () => {
    const { service, repo, keys } = build()
    await service.configure(ORG, { enabled: true })
    const first = await service.issueCredential(ORG)

    keys.failRevoke = true
    await service.issueCredential(ORG)
    // The handle survives the failure — the old key would otherwise stay live
    // forever with nothing left naming it.
    expect(repo.revocations.map((entry) => entry.apiKeyId)).toEqual([first.revision])

    keys.failRevoke = false
    expect(await service.drainKeyRevocations()).toBe(1)
    expect(keys.revoked).toEqual([first.revision])
    expect(repo.revocations).toEqual([])
  })

  it('reuses the daemon identity and revokes the superseded key last', async () => {
    const { service, keys } = build()
    await service.configure(ORG, { enabled: true })
    const first = await service.issueCredential(ORG)
    const second = await service.issueCredential(ORG)

    expect(second.daemonId).toBe(first.daemonId)
    expect(keys.minted).toBe(2)
    expect(keys.revoked).toEqual([first.revision])
  })

  it('refuses when the org has no envelope to attach a credential to', async () => {
    const { service } = build()
    await expect(service.issueCredential(ORG)).rejects.toThrow(ClusterNotEnabledError)
  })

  it('retires the credential when cluster execution is switched off', async () => {
    const { service, repo, keys } = build()
    await service.configure(ORG, { enabled: true })
    const issued = await service.issueCredential(ORG)

    await service.configure(ORG, { enabled: false })
    const row = await repo.get()
    expect(row?.credentialRevision).toBeUndefined()
    expect(row?.credentialApiKeyId).toBeUndefined()
    expect(keys.revoked).toEqual([issued.revision])
  })

  it('records the revocation and the teardown BEFORE touching the cluster on disable', async () => {
    const { service, repo, api, keys } = build()
    await service.configure(ORG, { enabled: true })
    const issued = await service.issueCredential(ORG)

    // A cluster that refuses the delete must not leave a disabled row beside a
    // live pod holding a live key with nothing recorded.
    api.failDelete = true
    keys.failRevoke = true
    await service.configure(ORG, { enabled: false })

    expect((await repo.get())?.credentialApiKeyId).toBeUndefined()
    expect(repo.revocations.map((entry) => entry.apiKeyId)).toEqual([issued.revision])
    expect(repo.tombstones.map((entry) => entry.orgId)).toEqual([ORG])

    // Both settle on the next maintenance pass.
    api.failDelete = false
    keys.failRevoke = false
    expect(await service.drainTeardowns()).toBe(1)
    expect(await service.drainKeyRevocations()).toBe(1)
    expect(api.deleted).toContain('ac-org-acme')
    expect(keys.revoked).toEqual([issued.revision])
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
})

describe('ClusterExecutionService.drainTeardowns', () => {
  it('deletes each deleted org’s resource and drops its tombstone', async () => {
    const { service, repo, api } = build()
    repo.tombstones = [
      { orgId: 'gone-1', targetNamespace: 'ac-org-gone-1' },
      { orgId: 'gone-2', targetNamespace: 'ac-org-gone-2' }
    ]
    expect(await service.drainTeardowns()).toBe(2)
    expect(api.deleted).toEqual(['ac-org-gone-1', 'ac-org-gone-2'])
    expect(repo.tombstones).toEqual([])
  })

  it('keeps a tombstone whose resource could not be deleted, for the next pass', async () => {
    const { service, repo, api } = build()
    repo.tombstones = [{ orgId: 'gone', targetNamespace: 'ac-org-gone' }]
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
})
