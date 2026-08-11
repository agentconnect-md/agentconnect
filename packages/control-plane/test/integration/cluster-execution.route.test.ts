/**
 * Cluster-execution routes over a real database and an in-process fake API
 * server. The invariants under test are the ones that make this surface a
 * PROVISIONER rather than a settings page: a write reaches the cluster, the
 * derived namespace is written once and never rewritten, disabling deletes the
 * resource, and status is always read from the cluster instead of the row.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { K8sHttp } from '@agentconnect.md/k8s-client'
import { closeFakeApiServers, fakeApiServer, type FakeRoute } from '@agentconnect.md/k8s-client/testing'
import { prisma } from '../setup.db.js'
import { buildHttpApp, TEST_API_KEY_PEPPER, type HttpApp } from '../fakes/build-http.js'
import { AgentConnectOrgApi, ClusterExecutionService, ClusterSecretApi, orgNamespace } from '../../src/cluster/index.js'
import { ApiKeyCodec } from '../../src/registry/apiKey.js'
import { ApiKeyService } from '../../src/registry/apiKeyService.js'
import { systemClock } from '../../src/domain/clock.js'
import { PgOrgClusterExecutionRepo } from '../../src/persistence/repositories/org-cluster-execution.repo.js'
import { PgApiKeyRepo } from '../../src/persistence/repositories/api-key.repo.js'
import { PgAuditRepo } from '../../src/persistence/repositories/audit.repo.js'
import { PgDaemonRepo } from '../../src/persistence/repositories/daemon.repo.js'
import { PgOrgRepo } from '../../src/persistence/repositories/org.repo.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import type { ClusterExecutionDefaults, OrgMemberRole } from '../../src/persistence/ports.js'
import { OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const CLUSTER = `${ORG}/cluster-execution`
const CONTROL_NAMESPACE = 'agentconnect-control'
const POLICY = {
  namespacePrefix: 'ac-org-',
  daemonImage: 'registry.example.test/daemon:1.0.0',
  runtimeImage: 'registry.example.test/runtime:1.0.0',
  daemonTier: 'small',
  runtimeTiers: [{ name: 'small', warmReplicas: 0 }],
  controlPlaneUrl: 'wss://api.example.test/daemon/ws'
}
const TARGET_NAMESPACE = orgNamespace(POLICY.namespacePrefix, DEFAULT_ORG_ID)
/** What the service derives for an org that has never configured anything. */
const DEFAULTS: ClusterExecutionDefaults = {
  targetNamespace: TARGET_NAMESPACE,
  daemonImage: POLICY.daemonImage,
  daemonTier: POLICY.daemonTier,
  credentialSecretName: 'ac-daemon-token',
  runtimeImage: POLICY.runtimeImage,
  runtimeTiers: POLICY.runtimeTiers,
  quota: { maxAgents: 0, cpu: '0', memory: '0', storage: '0' },
  egressPolicy: 'curated'
}
const RESOURCE_PATH = `/apis/agentconnect.md/v1alpha1/namespaces/${CONTROL_NAMESPACE}/agentconnectorgs/${TARGET_NAMESPACE}`

/** A per-request override; undefined falls through to the harness's default store. */
type MaybeRoute = (req: Parameters<FakeRoute>[0]) => ReturnType<FakeRoute> | undefined

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
  await closeFakeApiServers()
})

interface ClusterHarness {
  http: HttpApp
  /** Every request the provisioner sent, as `<METHOD> <path>`. */
  calls: string[]
  /** Bodies of the apply PATCHes, newest last. */
  applied: { spec?: Record<string, unknown> }[]
  /** Credential Secrets written, newest last. */
  secrets: { path: string; seq: number; configJson: string }[]
  /** Make every Secret call 404 from here on, as an uncreated namespace does. */
  setNamespaceMissing(missing: boolean): void
}

/**
 * An app whose cluster service talks to a fake API server. `route` decides the
 * reply per request; the default is a store that answers GET from whatever was
 * last applied, which is what a real API server does.
 */
async function clusterApp(
  options: { route?: MaybeRoute; userId?: string; namespaceMissing?: boolean } = {}
): Promise<ClusterHarness> {
  const calls: string[] = []
  const applied: { spec?: Record<string, unknown> }[] = []
  const secrets: { path: string; seq: number; configJson: string }[] = []
  let stored: unknown = null
  let storedSecret: { metadata: { resourceVersion: string; annotations: Record<string, string> } } | null = null
  let namespaceMissing = options.namespaceMissing ?? false
  const server = await fakeApiServer((req) => {
    calls.push(`${req.method} ${req.url.pathname}`)
    // Secrets are a real little store: the provisioner reads before it writes,
    // and only creates when the read said the Secret is absent.
    const isSecret = req.url.pathname.includes('/secrets')
    if (isSecret) {
      const missing = { status: 404, json: { kind: 'Status', reason: 'NotFound', message: 'not found' } }
      if (namespaceMissing) return missing
      if (req.method === 'GET') return storedSecret ? { json: storedSecret } : missing
      if (req.method === 'POST' || req.method === 'PUT') {
        const body = JSON.parse(req.body) as {
          metadata?: { annotations?: Record<string, string> }
          stringData?: Record<string, string>
        }
        storedSecret = {
          metadata: {
            resourceVersion: String(secrets.length + 1),
            annotations: body.metadata?.annotations ?? {}
          }
        }
        secrets.push({
          path: req.url.pathname,
          seq: Number(body.metadata?.annotations?.['agentconnect.md/credential-seq'] ?? 0),
          configJson: body.stringData?.['config.json'] ?? ''
        })
        return { json: storedSecret }
      }
    }
    if (req.method === 'PATCH') {
      const body = JSON.parse(req.body) as { spec?: Record<string, unknown> }
      applied.push(body)
      stored = { ...body, status: { observedGeneration: applied.length } }
    }
    if (req.method === 'DELETE' && !isSecret) stored = null
    const custom = options.route?.(req)
    if (custom) return custom
    if (req.method === 'GET') {
      return stored
        ? { json: stored }
        : { status: 404, json: { kind: 'Status', reason: 'NotFound', message: 'not found' } }
    }
    return { json: stored ?? {} }
  })
  // The same key service the app builds, over the same pepper — a credential
  // minted here authenticates a real daemon handshake.
  const apiKeys = new ApiKeyService(
    new ApiKeyCodec({ API_KEY_PEPPER: TEST_API_KEY_PEPPER }),
    new PgApiKeyRepo(prisma),
    new PgDaemonRepo(prisma),
    new PgAuditRepo(prisma),
    systemClock
  )
  const cluster = new ClusterExecutionService(
    new PgOrgClusterExecutionRepo(prisma),
    new AgentConnectOrgApi(new K8sHttp(server.config), CONTROL_NAMESPACE),
    new PgOrgRepo(prisma),
    POLICY,
    new ClusterSecretApi(new K8sHttp(server.config)),
    apiKeys,
    systemClock
  )
  const http = buildHttpApp(
    prisma,
    options.userId ? { DEFAULT_OWNER_ID: options.userId } : undefined,
    undefined,
    undefined,
    { clusterExecution: cluster }
  )
  opened.push(http)
  return {
    http,
    calls,
    applied,
    secrets,
    setNamespaceMissing: (missing: boolean) => {
      namespaceMissing = missing
    }
  }
}

/** Provision a user and add them to the default org with a role. */
async function makeUser(sub: string, role: OrgMemberRole): Promise<string> {
  const users = new PgUserRepo(prisma)
  const email = `${sub}@cluster.test`
  const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

describe('GET /cluster-execution', () => {
  it('answers with the deployment defaults before the first write', async () => {
    const { http, calls } = await clusterApp()
    const res = await http.app.inject({ method: 'GET', url: CLUSTER })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      enabled: false,
      suspend: false,
      controlNamespace: CONTROL_NAMESPACE,
      targetNamespace: TARGET_NAMESPACE,
      daemonImage: POLICY.daemonImage,
      runtimeImage: POLICY.runtimeImage,
      credentialSecretName: 'ac-daemon-token',
      egressPolicy: 'curated',
      quota: { maxAgents: 0, cpu: '0', memory: '0', storage: '0' }
    })
    // A read of unconfigured settings must not touch the cluster at all.
    expect(calls).toEqual([])
  })
})

describe('PUT /cluster-execution', () => {
  it('persists the settings and applies the projected spec', async () => {
    const { http, calls, applied } = await clusterApp()
    const res = await http.app.inject({
      method: 'PUT',
      url: CLUSTER,
      payload: {
        enabled: true,
        daemonImage: 'registry.example.test/daemon:2.0.0',
        runtimeTiers: [{ name: 'medium', warmReplicas: 2 }],
        quota: { maxAgents: 6 },
        egressPolicy: 'locked'
      }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      enabled: true,
      daemonImage: 'registry.example.test/daemon:2.0.0',
      runtimeImage: POLICY.runtimeImage,
      runtimeTiers: [{ name: 'medium', warmReplicas: 2 }],
      quota: { maxAgents: 6, cpu: '0', memory: '0', storage: '0' },
      egressPolicy: 'locked'
    })

    expect(calls).toContain(`PATCH ${RESOURCE_PATH}`)
    expect(applied.at(-1)?.spec).toMatchObject({
      targetNamespace: TARGET_NAMESPACE,
      suspend: false,
      daemon: { image: 'registry.example.test/daemon:2.0.0', tier: 'small', credentialSecretName: 'ac-daemon-token' },
      runtime: { image: POLICY.runtimeImage, tiers: [{ name: 'medium', warmReplicas: 2 }] },
      quota: { maxAgents: 6, cpu: '0', memory: '0', storage: '0' },
      egressPolicy: 'locked'
    })

    const row = await prisma.orgClusterExecution.findUnique({ where: { orgId: DEFAULT_ORG_ID } })
    expect(row?.enabled).toBe(true)
    expect(row?.targetNamespace).toBe(TARGET_NAMESPACE)
  })

  it('keeps the derived namespace across later edits', async () => {
    const { http, applied } = await clusterApp()
    await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { enabled: true } })
    await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { suspend: true } })
    expect(applied).toHaveLength(2)
    expect(applied[1]?.spec).toMatchObject({ targetNamespace: TARGET_NAMESPACE, suspend: true })
  })

  it('applies a partial patch without resetting the untouched fields', async () => {
    const { http } = await clusterApp()
    await http.app.inject({
      method: 'PUT',
      url: CLUSTER,
      payload: { enabled: true, daemonTier: 'large', quota: { cpu: '32', memory: '64Gi' } }
    })
    const res = await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { suspend: true } })
    expect(res.json()).toMatchObject({
      enabled: true,
      suspend: true,
      daemonTier: 'large',
      quota: { maxAgents: 0, cpu: '32', memory: '64Gi', storage: '0' }
    })
  })

  it('deletes the resource when cluster execution is switched off', async () => {
    const { http, calls } = await clusterApp()
    await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { enabled: true } })
    const res = await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { enabled: false } })
    expect(res.statusCode).toBe(200)
    expect(res.json().enabled).toBe(false)
    expect(calls).toContain(`DELETE ${RESOURCE_PATH}`)
  })

  it('is owner-only', async () => {
    const { http, calls } = await clusterApp({ userId: await makeUser('collab-cluster', 'collaborator') })
    const res = await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { enabled: true } })
    expect(res.statusCode).toBe(403)
    expect(calls).toEqual([])
    expect(await prisma.orgClusterExecution.count()).toBe(0)
  })

  it('reports a rejected cluster write as 502 while keeping the stored intent', async () => {
    const { http } = await clusterApp({
      route: (req) =>
        req.method === 'PATCH'
          ? { status: 403, json: { kind: 'Status', reason: 'Forbidden', message: 'cannot patch agentconnectorgs' } }
          : undefined
    })
    const res = await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { enabled: true } })
    expect(res.statusCode).toBe(502)
    expect(res.json().code).toBe('CLUSTER_API_ERROR')
    // The row still records what was asked for, so a retry converges.
    const row = await prisma.orgClusterExecution.findUnique({ where: { orgId: DEFAULT_ORG_ID } })
    expect(row?.enabled).toBe(true)
  })

  it('never writes an existing row backwards while bootstrapping a first enable', async () => {
    const repo = new PgOrgClusterExecutionRepo(prisma)
    // Two first enables both see no row. The one that gets there second must
    // find its bootstrap a pure no-op — an upsert here would push the winner's
    // envelope back to disabled on its way to a 409.
    await repo.upsert(OrgId(DEFAULT_ORG_ID), DEFAULTS, { enabled: true, daemonImage: 'registry.example.test/daemon:2' })
    const winner = await repo.get(OrgId(DEFAULT_ORG_ID))

    await repo.createIfAbsent(OrgId(DEFAULT_ORG_ID), { ...DEFAULTS, daemonImage: 'registry.example.test/daemon:3' })
    expect(await repo.get(OrgId(DEFAULT_ORG_ID))).toEqual(winner)
  })
})

describe('GET /cluster-execution/status', () => {
  it('reads the live resource status, not the stored row', async () => {
    const { http } = await clusterApp({
      route: (req) =>
        req.method === 'GET'
          ? {
              json: {
                status: {
                  observedGeneration: 3,
                  namespace: TARGET_NAMESPACE,
                  conditions: [
                    { type: 'Degraded', status: 'False' },
                    { type: 'Ready', status: 'True', reason: 'Reconciled' }
                  ],
                  daemon: { ready: true, image: POLICY.daemonImage },
                  sandboxes: { total: 2, running: 1, suspended: 1 },
                  pools: [{ name: 'small', warmAvailable: 1, claimed: 0 }]
                }
              }
            }
          : undefined
    })
    await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { enabled: true } })

    const res = await http.app.inject({ method: 'GET', url: `${CLUSTER}/status` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.present).toBe(true)
    expect(body.observedGeneration).toBe(3)
    expect(body.conditions.map((c: { type: string }) => c.type)).toEqual(['Ready', 'Degraded'])
    expect(body.daemon).toEqual({ ready: true, image: POLICY.daemonImage })
    expect(body.sandboxes).toEqual({ total: 2, running: 1, suspended: 1 })
  })

  it('reports an absent envelope before the org enables cluster execution', async () => {
    const { http } = await clusterApp()
    const res = await http.app.inject({ method: 'GET', url: `${CLUSTER}/status` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ present: false, conditions: [] })
  })

  it('reports an absent envelope when the resource is gone from under us', async () => {
    const { http } = await clusterApp()
    await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { enabled: true } })
    await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { enabled: false } })
    const res = await http.app.inject({ method: 'GET', url: `${CLUSTER}/status` })
    expect(res.json()).toEqual({ present: false, conditions: [] })
  })

  it('is readable by a non-owner member', async () => {
    const { http } = await clusterApp({ userId: await makeUser('viewer-cluster', 'viewer') })
    const res = await http.app.inject({ method: 'GET', url: `${CLUSTER}/status` })
    expect(res.statusCode).toBe(200)
  })
})

describe('POST /cluster-execution/credential', () => {
  const CREDENTIAL = `${CLUSTER}/credential`

  it('publishes the daemon config as the Secret the CRD names and never returns the key', async () => {
    const { http, calls, applied, secrets } = await clusterApp()
    await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { enabled: true } })

    const res = await http.app.inject({ method: 'POST', url: CREDENTIAL })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.secretName).toBe('ac-daemon-token')
    expect(body.rotated).toBe(false)
    expect(calls).toContain(`POST /api/v1/namespaces/${TARGET_NAMESPACE}/secrets`)
    expect(secrets.at(-1)?.path).toContain('/secrets')

    const config = JSON.parse(secrets.at(-1)!.configJson)
    expect(config.version).toBe(1)
    expect(config.daemonId).toBe(body.daemonId)
    expect(config.controlPlane).toMatchObject({ enabled: true, url: POLICY.controlPlaneUrl })
    expect(config.controlPlane.key).toMatch(/^[0-9A-Za-z]{49}$/)
    // The key exists only inside the cluster Secret — not in the response.
    expect(JSON.stringify(body)).not.toContain(config.controlPlane.key)

    // The resource is re-applied so the operator sees the new revision.
    expect(applied.at(-1)?.spec).toMatchObject({ daemon: { credentialRevision: body.revision } })
  })

  it('binds the credential to a real daemon row in the org', async () => {
    const { http } = await clusterApp()
    await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { enabled: true } })
    const body = (await http.app.inject({ method: 'POST', url: CREDENTIAL })).json()

    const daemon = await prisma.daemon.findUnique({ where: { id: body.daemonId } })
    expect(daemon?.orgId).toBe(DEFAULT_ORG_ID)
    const keys = await prisma.apiKey.findMany({ where: { daemonId: body.daemonId } })
    expect(keys).toHaveLength(1)
    expect(keys[0]?.revokedAt).toBeNull()
  })

  it('rotates onto a new key, keeping the daemon identity and revoking the old key', async () => {
    const { http, secrets } = await clusterApp()
    await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { enabled: true } })
    const first = (await http.app.inject({ method: 'POST', url: CREDENTIAL })).json()

    const second = (await http.app.inject({ method: 'POST', url: CREDENTIAL })).json()
    expect(second.rotated).toBe(true)
    expect(second.daemonId).toBe(first.daemonId)
    expect(second.revision).not.toBe(first.revision)

    // The published key changed, and the superseded one is revoked — in that order.
    const [before, after] = secrets.slice(-2).map((entry) => JSON.parse(entry.configJson).controlPlane.key)
    expect(after).not.toBe(before)
    const keys = await prisma.apiKey.findMany({ where: { daemonId: first.daemonId }, orderBy: { createdAt: 'asc' } })
    expect(keys).toHaveLength(2)
    expect(keys[0]?.revokedAt).not.toBeNull()
    expect(keys[1]?.revokedAt).toBeNull()
  })

  it('is owner-only', async () => {
    const { http, secrets } = await clusterApp({ userId: await makeUser('collab-credential', 'collaborator') })
    expect((await http.app.inject({ method: 'POST', url: CREDENTIAL })).statusCode).toBe(403)
    expect(secrets).toEqual([])
  })

  it('409s before cluster execution is enabled', async () => {
    const { http } = await clusterApp()
    const res = await http.app.inject({ method: 'POST', url: CREDENTIAL })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('CLUSTER_NOT_ENABLED')
  })

  it('409s once cluster execution is switched off, rather than re-publishing a Secret', async () => {
    const { http, secrets } = await clusterApp()
    await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { enabled: true } })
    await http.app.inject({ method: 'POST', url: CREDENTIAL })
    await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { enabled: false } })
    const written = secrets.length

    const res = await http.app.inject({ method: 'POST', url: CREDENTIAL })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('CLUSTER_NOT_ENABLED')
    expect(secrets).toHaveLength(written)
  })

  it('409s while another rotation owns the transition', async () => {
    const { http } = await clusterApp()
    await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { enabled: true } })
    await prisma.orgClusterExecution.update({
      where: { orgId: DEFAULT_ORG_ID },
      data: { credentialRotationAt: new Date(), credentialRotationToken: 'peer-token' }
    })

    const res = await http.app.inject({ method: 'POST', url: CREDENTIAL })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('CLUSTER_ROTATION_IN_PROGRESS')
    // The loser minted nothing at all — no daemon, no key.
    expect(await prisma.daemon.count()).toBe(0)
  })

  it('stamps the rotation sequence on the Secret so a stalled publish cannot win', async () => {
    const { http, secrets, calls } = await clusterApp()
    await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { enabled: true } })
    await http.app.inject({ method: 'POST', url: CREDENTIAL })
    await http.app.inject({ method: 'POST', url: CREDENTIAL })

    // Read-before-write on every publish, and a create only when the read said absent.
    expect(calls.filter((call) => call.startsWith('GET /api/v1/namespaces')).length).toBeGreaterThanOrEqual(2)
    expect(calls.filter((call) => call === `POST /api/v1/namespaces/${TARGET_NAMESPACE}/secrets`)).toHaveLength(1)
    expect(secrets).toHaveLength(2)
    // Monotonic is the whole requirement — every claim advances it, so the
    // second publish can never carry a sequence the first already used.
    expect(secrets[1]!.seq).toBeGreaterThan(secrets[0]!.seq)
    const row = await prisma.orgClusterExecution.findUnique({ where: { orgId: DEFAULT_ORG_ID } })
    expect(row?.credentialRotationSeq).toBe(secrets[1]!.seq)
  })

  it('adopts the key a crashed rotation left staged, rather than stranding it', async () => {
    const { http } = await clusterApp()
    await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { enabled: true } })
    const first = (await http.app.inject({ method: 'POST', url: CREDENTIAL })).json()

    // A holder that died after staging a second key and before committing it,
    // with its lease long expired.
    const orphan = await prisma.apiKey.findFirstOrThrow({ where: { daemonId: first.daemonId } })
    await prisma.orgClusterExecution.update({
      where: { orgId: DEFAULT_ORG_ID },
      data: {
        credentialStagedApiKeyId: orphan.id,
        credentialRotationAt: new Date(Date.now() - 60 * 60 * 1000),
        credentialRotationToken: 'dead-holder'
      }
    })

    expect((await http.app.inject({ method: 'POST', url: CREDENTIAL })).statusCode).toBe(201)
    const row = await prisma.orgClusterExecution.findUnique({ where: { orgId: DEFAULT_ORG_ID } })
    expect(row?.credentialStagedApiKeyId).toBeNull()
    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: orphan.id } })).revokedAt).not.toBeNull()
    expect(await prisma.pendingDaemonKeyRevocation.count()).toBe(0)
  })

  it('never revokes a displaced key while the Secret may still carry it', async () => {
    const { http, setNamespaceMissing } = await clusterApp()
    await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { enabled: true } })
    const first = (await http.app.inject({ method: 'POST', url: CREDENTIAL })).json()
    const orphan = await prisma.apiKey.findFirstOrThrow({ where: { daemonId: first.daemonId } })
    // A holder that died after staging that key — it is what the Secret holds.
    await prisma.orgClusterExecution.update({
      where: { orgId: DEFAULT_ORG_ID },
      data: {
        credentialStagedApiKeyId: orphan.id,
        credentialRotationAt: new Date(Date.now() - 60 * 60 * 1000),
        credentialRotationToken: 'dead-holder'
      }
    })

    // This pass displaces the orphan and then fails to publish anything, so the
    // Secret is unchanged: draining the orphan now would kill the live credential.
    setNamespaceMissing(true)
    expect((await http.app.inject({ method: 'POST', url: CREDENTIAL })).statusCode).toBe(409)
    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: orphan.id } })).revokedAt).toBeNull()
    expect(await prisma.pendingDaemonKeyRevocation.findUniqueOrThrow({ where: { apiKeyId: orphan.id } })).toMatchObject(
      { held: true }
    )

    // The next publish is the higher sequence it was waiting on.
    setNamespaceMissing(false)
    expect((await http.app.inject({ method: 'POST', url: CREDENTIAL })).statusCode).toBe(201)
    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: orphan.id } })).revokedAt).not.toBeNull()
    expect(await prisma.pendingDaemonKeyRevocation.count()).toBe(0)
  })

  it('409s while the operator has not created the envelope namespace yet', async () => {
    const { http } = await clusterApp({ namespaceMissing: true })
    await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { enabled: true } })

    const res = await http.app.inject({ method: 'POST', url: CREDENTIAL })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('CLUSTER_NAMESPACE_NOT_READY')
    // No credential was recorded, so a retry after NamespaceReady starts clean —
    // but the daemon identity IS kept, so the retry re-keys it rather than
    // provisioning a second daemon, and the unpublished key is already revoked.
    const row = await prisma.orgClusterExecution.findUnique({ where: { orgId: DEFAULT_ORG_ID } })
    expect(row?.credentialRevision).toBeNull()
    expect(row?.credentialDaemonId).not.toBeNull()
    expect(row?.credentialRotationAt).toBeNull()
    const keys = await prisma.apiKey.findMany({ where: { daemonId: row!.credentialDaemonId! } })
    expect(keys).toHaveLength(1)
    expect(keys[0]?.revokedAt).not.toBeNull()
    expect(await prisma.pendingDaemonKeyRevocation.count()).toBe(0)
  })

  it('retires the credential when cluster execution is switched off', async () => {
    const { http } = await clusterApp()
    await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { enabled: true } })
    const issued = (await http.app.inject({ method: 'POST', url: CREDENTIAL })).json()

    await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { enabled: false } })
    const row = await prisma.orgClusterExecution.findUnique({ where: { orgId: DEFAULT_ORG_ID } })
    expect(row?.credentialRevision).toBeNull()
    expect(row?.credentialApiKeyId).toBeNull()
    const keys = await prisma.apiKey.findMany({ where: { daemonId: issued.daemonId } })
    expect(keys.every((key) => key.revokedAt !== null)).toBe(true)
  })
})

describe('DELETE /orgs/:orgId', () => {
  it('records the envelope in the delete transaction and retires it right after', async () => {
    const { http, calls } = await clusterApp()
    await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { enabled: true } })

    const res = await http.app.inject({ method: 'DELETE', url: ORG })
    expect(res.statusCode).toBe(204)
    expect(calls).toContain(`DELETE ${RESOURCE_PATH}`)
    expect(await prisma.orgClusterExecution.count()).toBe(0)
    expect(await prisma.pendingEnvelopeTeardown.count()).toBe(0)
  })

  it('keeps the tombstone — the only surviving record of the namespace — when the cluster refuses', async () => {
    const { http } = await clusterApp({
      route: (req) =>
        req.method === 'DELETE'
          ? { status: 403, json: { kind: 'Status', reason: 'Forbidden', message: 'cannot delete agentconnectorgs' } }
          : undefined
    })
    await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { enabled: true } })

    // The deletion still succeeds: cleanup authority no longer depends on this
    // request, because the intent outlives the organization it names.
    const res = await http.app.inject({ method: 'DELETE', url: ORG })
    expect(res.statusCode).toBe(204)
    const pending = await prisma.pendingEnvelopeTeardown.findMany()
    expect(pending.map((row) => row.targetNamespace)).toEqual([TARGET_NAMESPACE])
  })

  it('records the envelope even when this process has no cluster credentials', async () => {
    // The org enabled cluster execution under a configured process; this one has
    // the module off, which used to skip teardown and orphan the envelope.
    const configured = await clusterApp()
    await configured.http.app.inject({ method: 'PUT', url: CLUSTER, payload: { enabled: true } })

    const offline = buildHttpApp(prisma)
    opened.push(offline)
    expect((await offline.app.inject({ method: 'DELETE', url: ORG })).statusCode).toBe(204)

    const pending = await prisma.pendingEnvelopeTeardown.findMany()
    expect(pending.map((row) => row.orgId)).toEqual([DEFAULT_ORG_ID])
    expect(pending[0]?.targetNamespace).toBe(TARGET_NAMESPACE)
  })

  it('writes no tombstone for an org that never enabled cluster execution', async () => {
    const { http } = await clusterApp()
    expect((await http.app.inject({ method: 'DELETE', url: ORG })).statusCode).toBe(204)
    expect(await prisma.pendingEnvelopeTeardown.count()).toBe(0)
  })
})

describe('without cluster credentials', () => {
  it('does not mount the surface at all', async () => {
    const http = buildHttpApp(prisma)
    opened.push(http)
    expect((await http.app.inject({ method: 'GET', url: CLUSTER })).statusCode).toBe(404)
    expect((await http.app.inject({ method: 'GET', url: `${CLUSTER}/status` })).statusCode).toBe(404)
  })
})
