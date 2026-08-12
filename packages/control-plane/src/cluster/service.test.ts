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
import { NamespaceNotReadyError, StaleCredentialWriteError, type OrgSecretApi } from './secret-api.js'
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

/** A queued revocation plus the eligibility flag the table carries. */
type QueuedRevocation = PendingDaemonKeyRevocation & { held: boolean }

/** In-memory settings row with the repo's revision-bump-on-every-write contract. */
class FakeRepo implements OrgClusterExecutionRepo {
  row: ClusterExecutionSettings | null = null
  tombstones: PendingEnvelopeTeardown[] = []
  revocations: QueuedRevocation[] = []
  rotationAt: Date | null = null
  rotationToken: string | null = null
  rotationSeq = 0
  /** A committed credential whose revision has not reached the CR yet. */
  rolloutPending = false
  /** Simulates a write whose row is cascaded away before anything reads it. */
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
    this.rotationSeq += 1
    this.row = { ...this.row, credentialRotationSeq: this.rotationSeq }
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
    const displaced = this.row.credentialStagedApiKeyId
    this.row = { ...this.row, credentialStagedApiKeyId: apiKeyId }
    if (displaced && displaced !== apiKeyId) {
      await this.enqueueKeyRevocation(this.row.orgId, displaced, 'cluster credential rotation abandoned', true)
    }
    return true
  }

  async commitCredential(
    _orgId: OrgId,
    token: string,
    credential: { daemonId: string; apiKeyId: string; revision: string },
    reason: string
  ): Promise<boolean> {
    if (this.rotationToken !== token || !this.row?.enabled) return false
    const superseded = this.row.credentialApiKeyId
    const stagedBefore = this.row.credentialStagedApiKeyId
    this.row = {
      ...this.row,
      specRevision: this.row.specRevision + 1,
      credentialDaemonId: credential.daemonId,
      credentialApiKeyId: credential.apiKeyId,
      credentialRevision: credential.revision,
      credentialStagedApiKeyId: undefined
    }
    this.rolloutPending = true
    for (const key of [superseded, stagedBefore]) {
      if (key && key !== credential.apiKeyId) await this.enqueueKeyRevocation(this.row.orgId, key, reason, true)
    }
    return true
  }

  async completeCredentialRollout(_orgId: OrgId, token: string): Promise<void> {
    if (this.rotationToken !== token) return
    this.rolloutPending = false
    this.releaseHeld()
  }

  async listPendingCredentialRollouts(limit: number): Promise<string[]> {
    return this.rolloutPending && this.row ? [this.row.orgId].slice(0, limit) : []
  }

  async abandonStagedCredential(_orgId: OrgId, token: string, reason: string): Promise<void> {
    if (this.rotationToken !== token || !this.row?.credentialStagedApiKeyId) return
    await this.enqueueKeyRevocation(this.row.orgId, this.row.credentialStagedApiKeyId, reason)
    this.row = { ...this.row, credentialStagedApiKeyId: undefined }
  }

  async retireCredential(_orgId: OrgId, token: string, reason: string): Promise<boolean> {
    if (this.rotationToken !== token || !this.row) return false
    this.row = { ...this.row, enabled: false }
    for (const apiKeyId of [this.row.credentialApiKeyId, this.row.credentialStagedApiKeyId]) {
      if (apiKeyId) await this.enqueueKeyRevocation(this.row.orgId, apiKeyId, reason)
    }
    this.releaseHeld()
    this.rolloutPending = false
    this.tombstones.push({ orgId: this.row.orgId, resourceName: this.row.resourceName })
    this.row = {
      ...this.row,
      specRevision: this.row.specRevision + 1,
      credentialApiKeyId: undefined,
      credentialRevision: undefined,
      credentialStagedApiKeyId: undefined
    }
    return true
  }

  async enqueueKeyRevocation(orgId: string, apiKeyId: string, reason: string, held = false): Promise<void> {
    if (!this.revocations.some((entry) => entry.apiKeyId === apiKeyId)) {
      this.revocations.push({ apiKeyId, orgId, reason, held })
    }
  }

  /** A higher-sequence publish landed, so nothing older is the pod's credential. */
  private releaseHeld(): void {
    this.revocations = this.revocations.map((entry) => ({ ...entry, held: false }))
  }

  async listPendingKeyRevocations(limit: number): Promise<PendingDaemonKeyRevocation[]> {
    return this.revocations.filter((entry) => !entry.held).slice(0, limit)
  }

  async clearKeyRevocation(apiKeyId: string): Promise<void> {
    this.revocations = this.revocations.filter((entry) => entry.apiKeyId !== apiKeyId)
  }

  /** Insert-only, like the repo's `ON CONFLICT DO NOTHING`. */
  async createIfAbsent(orgId: OrgId, defaults: ClusterExecutionDefaults): Promise<void> {
    if (this.row || this.swallowUpsert) return
    this.row = {
      orgId,
      enabled: false,
      specRevision: 1,
      credentialRotationSeq: 0,
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
      credentialRotationSeq: 0,
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

/** Records what the key authority published, so ordering can be asserted. */
class FakeSecrets implements OrgSecretApi {
  written: { namespace: string; name: string; seq: number; configJson: string }[] = []
  namespaceMissing = false
  /** Fails the publish AFTER it has committed, like a dropped response would. */
  failAfterPublish = false
  /** Runs inside the publish, so a test can steal the claim mid-flight. */
  duringApply?: () => void

  async publishCredential(namespace: string, name: string, seq: number, configJson: string): Promise<void> {
    if (this.namespaceMissing) throw NamespaceNotReadyError.missing(namespace)
    this.duringApply?.()
    // Same cluster-side ordering guard the real client enforces.
    if (seq < this.publishedSeq_) throw new StaleCredentialWriteError(seq, this.publishedSeq_)
    this.publishedSeq_ = seq
    this.written.push({ namespace, name, seq, configJson })
    if (this.failAfterPublish) throw new Error('connection reset')
  }

  async publishedSeq(): Promise<number> {
    if (this.readFails) throw new Error('cluster unreachable')
    return this.publishedSeq_
  }

  readFails = false
  publishedSeq_ = 0

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

  it('refuses to publish before the operator has derived and published the namespace', async () => {
    const { service, api, secrets, keys } = build()
    await service.configure(ORG, { enabled: true })
    api.namespaceStatus = undefined // the envelope namespace is not claimed yet

    await expect(service.issueCredential(ORG)).rejects.toThrow(NamespaceNotReadyError)
    expect(secrets.written).toEqual([])
    // Read before minting: a key with nowhere to be published is a key to leak.
    expect(keys.minted).toBe(0)
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

  it('never loses the handle to a key a crashed rotation left staged', async () => {
    const { service, repo, keys } = build()
    await service.configure(ORG, { enabled: true })
    // A holder that died after staging its key — which may already have been
    // published, so the pod could be running on it right now.
    repo.row = { ...repo.row!, credentialStagedApiKeyId: 'orphan-key' }
    repo.rotationAt = new Date(Date.now() - 60 * 60 * 1000)
    repo.rotationToken = 'dead-holder'

    // Taking the claim alone must not retire it — only a pass that reaches the
    // staging write, which is what makes the orphan unreachable, hands it over.
    await service.issueCredential(ORG)
    expect(keys.revoked).toContain('orphan-key')
    expect((await repo.get())?.credentialStagedApiKeyId).toBeUndefined()
  })

  it('does not revoke the displaced orphan until a publish has superseded it', async () => {
    const { service, repo, secrets, keys } = build()
    await service.configure(ORG, { enabled: true })
    repo.row = { ...repo.row!, credentialStagedApiKeyId: 'orphan-key' }
    repo.rotationAt = new Date(Date.now() - 60 * 60 * 1000)
    repo.rotationToken = 'dead-holder'
    // The orphan may be what the Secret currently holds, and this pass never
    // reaches the cluster — so its own cleanup must not drain the orphan with it.
    secrets.namespaceMissing = true

    await expect(service.issueCredential(ORG)).rejects.toThrow(NamespaceNotReadyError)
    expect(keys.revoked).toEqual(['key-1'])
    expect(repo.revocations.map((entry) => entry.apiKeyId)).toEqual(['orphan-key'])

    // The next successful rotation is the higher-sequence publish it was waiting
    // on, so only then does it become revocable.
    secrets.namespaceMissing = false
    await service.issueCredential(ORG)
    expect(keys.revoked).toContain('orphan-key')
    expect(repo.revocations).toEqual([])
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
    // The key it minted is not silently dropped — but its publish DID land, so
    // it is named and held rather than revoked out from under a restarting pod.
    expect(repo.revocations.map((entry) => entry.apiKeyId)).toEqual(['key-1'])
    expect(keys.revoked).toEqual([])
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

  it('refuses to overwrite a Secret a newer rotation already published', async () => {
    const { service, repo, secrets, keys } = build()
    await service.configure(ORG, { enabled: true })
    // This pass stalls past its lease; the successor claims, publishes at a
    // higher sequence, and only then does the stalled publish reach the cluster.
    secrets.duringApply = () => {
      repo.rotationToken = 'successor'
      secrets.publishedSeq_ = repo.rotationSeq + 10
    }

    await expect(service.issueCredential(ORG)).rejects.toThrow(ClusterRotationInProgressError)
    // The Secret still holds the successor's credential, not this pass's.
    expect(secrets.written).toEqual([])
    expect(keys.revoked).toEqual(['key-1'])
  })

  it('refuses to commit onto an envelope disabled while it was publishing', async () => {
    const { service, repo, secrets, keys } = build()
    await service.configure(ORG, { enabled: true })
    secrets.duringApply = () => {
      repo.row = { ...repo.row!, enabled: false }
    }

    await expect(service.issueCredential(ORG)).rejects.toThrow(ClusterRotationInProgressError)
    expect((await repo.get())?.credentialRevision).toBeUndefined()
    // Named, and held only until the retirement that disabling performs releases
    // it — the envelope is going away, so nothing is left to strand.
    expect(repo.revocations.map((entry) => entry.apiKeyId)).toEqual(['key-1'])
    await service.configure(ORG, { enabled: false })
    expect(keys.revoked).toEqual(['key-1'])
  })

  it('does NOT revoke a key whose publish committed before the response was lost', async () => {
    const { service, repo, secrets, keys } = build()
    await service.configure(ORG, { enabled: true })
    // The write lands and the connection then drops — indistinguishable from a
    // rejection at the call site, and revoking here would leave the pod holding
    // a credential the cluster considers current.
    secrets.failAfterPublish = true

    await expect(service.issueCredential(ORG)).rejects.toThrow('connection reset')
    expect(keys.revoked).toEqual([])
    expect((await repo.get())?.credentialStagedApiKeyId).toBe('key-1')
  })

  it('treats an unverifiable publish as possibly landed rather than revoking', async () => {
    const { service, secrets, keys } = build()
    await service.configure(ORG, { enabled: true })
    secrets.failAfterPublish = true
    secrets.readFails = true // cannot ask the cluster what happened

    await expect(service.issueCredential(ORG)).rejects.toThrow('connection reset')
    expect(keys.revoked).toEqual([])
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

  it('keeps the superseded key alive until the CR actually carries the new revision', async () => {
    const { service, repo, api, keys } = build()
    await service.configure(ORG, { enabled: true })
    const first = await service.issueCredential(ORG)

    // The commit lands and the apply does not: the pod has not been asked to
    // roll, so it is still running on the predecessor's key.
    api.failApply = true
    await expect(service.issueCredential(ORG)).rejects.toThrow('cluster unreachable')
    expect(repo.revocations.map((entry) => entry.apiKeyId)).toEqual([first.revision])
    expect(keys.revoked).toEqual([])
    // Even a full maintenance pass must not touch it while the rollout is owed.
    expect(await service.drainKeyRevocations()).toBe(0)

    api.failApply = false
    expect(await service.drainCredentialRollouts()).toBe(1)
    expect(await service.drainKeyRevocations()).toBe(1)
    expect(keys.revoked).toEqual([first.revision])
    expect(await service.drainCredentialRollouts()).toBe(0)
  })

  it('drains the rollout through the convergence fence, not a bare apply', async () => {
    const { service, repo, api } = build()
    await service.configure(ORG, { enabled: true })
    await service.issueCredential(ORG)
    api.failApply = true
    await expect(service.issueCredential(ORG)).rejects.toThrow('cluster unreachable')
    api.failApply = false
    api.applied.length = 0

    // A settings write needs no credential claim, so it can land while the
    // drain's apply is in flight — the interleaving that would otherwise revert
    // the CR to the spec this pass captured and then close the only pending work.
    api.duringApply = async () => {
      await repo.upsert(ORG, {} as ClusterExecutionDefaults, { daemonImage: 'peer' })
    }
    expect(await service.drainCredentialRollouts()).toBe(1)
    expect(api.applied.at(-1)?.daemon.image).toBe('peer')
  })

  it('keeps owing the rollout while the cluster stays unreachable', async () => {
    const { service, api, keys } = build()
    await service.configure(ORG, { enabled: true })
    await service.issueCredential(ORG)
    api.failApply = true
    await expect(service.issueCredential(ORG)).rejects.toThrow('cluster unreachable')

    expect(await service.drainCredentialRollouts()).toBe(0)
    expect(await service.drainKeyRevocations()).toBe(0)
    expect(keys.revoked).toEqual([])
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
    expect(api.deleted).toContain('acme')
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
    await repo.beginCredentialRotation(ORG, 'peer-token', new Date(), 60_000)

    expect(await service.drainTeardowns()).toBe(0)
    await repo.endCredentialRotation(ORG, 'peer-token')
    expect(await service.drainTeardowns()).toBe(1)
    expect(api.deleted).toEqual(['acme'])
  })
})

/**
 * The provisioning path an org create and every Daemons-page visit take. It has
 * to be safely repeatable, has to finish a job an earlier pass could not, and
 * must never reverse an owner who switched cluster execution off.
 */
describe('ensureProvisioned', () => {
  it('provisions an org that was never configured, credential included', async () => {
    const { service, api, secrets, keys } = build()
    const settings = await service.ensureProvisioned(ORG)
    expect(settings.enabled).toBe(true)
    expect(api.applied.length).toBeGreaterThan(0)
    expect(keys.minted).toBe(1)
    expect(secrets.written).toHaveLength(1)
    expect(settings.credentialRevision).toBe('key-1')
  })

  it('is idempotent — a second pass mints nothing and rotates nothing', async () => {
    const { service, secrets, keys } = build()
    await service.ensureProvisioned(ORG)
    const settings = await service.ensureProvisioned(ORG)
    expect(keys.minted).toBe(1)
    expect(secrets.written).toHaveLength(1)
    expect(settings.credentialRevision).toBe('key-1')
  })

  // The operator has not created the namespace yet at org-create time, which is
  // the ordinary state, not a failure — the next visit finishes the job.
  it('defers the credential until the operator publishes the namespace', async () => {
    const { service, api, secrets } = build()
    api.namespaceStatus = undefined
    const deferred = await service.ensureProvisioned(ORG)
    expect(deferred.enabled).toBe(true)
    expect(deferred.credentialRevision).toBeUndefined()
    expect(secrets.written).toEqual([])

    api.namespaceStatus = 'ac-org-acme'
    expect((await service.ensureProvisioned(ORG)).credentialRevision).toBe('key-1')
    expect(secrets.written).toHaveLength(1)
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

  it('yields to a peer that owns the credential transition', async () => {
    const { service, repo, keys } = build()
    await service.configure(ORG, { enabled: true })
    await repo.beginCredentialRotation(ORG, 'peer-token', new Date(), 60_000)

    const settings = await service.ensureProvisioned(ORG)
    expect(settings.credentialRevision).toBeUndefined()
    expect(keys.minted).toBe(0)
  })

  it('surfaces a cluster that refuses the apply', async () => {
    const { service, api } = build()
    api.failApply = true
    await expect(service.ensureProvisioned(ORG)).rejects.toThrow(/cluster unreachable/)
  })
})
