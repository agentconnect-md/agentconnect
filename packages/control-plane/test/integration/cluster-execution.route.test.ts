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
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { AgentConnectOrgApi, ClusterExecutionService, orgResourceName } from '../../src/cluster/index.js'
import { systemClock } from '../../src/domain/clock.js'
import { PgOrgClusterExecutionRepo } from '../../src/persistence/repositories/org-cluster-execution.repo.js'
import { PgDaemonRepo } from '../../src/persistence/repositories/daemon.repo.js'
import { PgDaemonLifecycleOpRepo } from '../../src/persistence/repositories/daemon-lifecycle-op.repo.js'
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
const RESOURCE_NAME = orgResourceName(POLICY.namespacePrefix, DEFAULT_ORG_ID)
/** What the OPERATOR derives from the CR name; the fake server below publishes it on status. */
const TARGET_NAMESPACE = `${POLICY.namespacePrefix}${RESOURCE_NAME}`
/** What the service derives for an org that has never configured anything. */
const DEFAULTS: ClusterExecutionDefaults = {
  resourceName: RESOURCE_NAME,
  daemonImage: POLICY.daemonImage,
  daemonTier: POLICY.daemonTier,
  runtimeImage: POLICY.runtimeImage,
  runtimeTiers: POLICY.runtimeTiers,
  quota: { maxAgents: 0, cpu: '0', memory: '0', storage: '0' },
  egressPolicy: 'curated'
}
const RESOURCE_PATH = `/apis/agentconnect.md/v1alpha1/namespaces/${CONTROL_NAMESPACE}/agentconnectorgs/${RESOURCE_NAME}`

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
  /** The service behind the routes, for driving its maintenance drain. */
  cluster: ClusterExecutionService
}

/**
 * An app whose cluster service talks to a fake API server. `route` decides the
 * reply per request; the default is a store that answers GET from whatever was
 * last applied, which is what a real API server does.
 */
async function clusterApp(options: { route?: MaybeRoute; userId?: string } = {}): Promise<ClusterHarness> {
  const calls: string[] = []
  const applied: { spec?: Record<string, unknown> }[] = []
  let stored: unknown = null
  const server = await fakeApiServer((req) => {
    calls.push(`${req.method} ${req.url.pathname}`)
    if (req.method === 'PATCH') {
      const body = JSON.parse(req.body) as { spec?: Record<string, unknown> }
      applied.push(body)
      // Standing in for the operator: it derives the namespace and publishes it on status.
      stored = { ...body, status: { observedGeneration: applied.length, namespace: TARGET_NAMESPACE } }
    }
    if (req.method === 'DELETE') stored = null
    const custom = options.route?.(req)
    if (custom) return custom
    if (req.method === 'GET') {
      return stored
        ? { json: stored }
        : { status: 404, json: { kind: 'Status', reason: 'NotFound', message: 'not found' } }
    }
    return { json: stored ?? {} }
  })
  const cluster = new ClusterExecutionService(
    new PgOrgClusterExecutionRepo(prisma),
    new AgentConnectOrgApi(new K8sHttp(server.config), CONTROL_NAMESPACE),
    new PgOrgRepo(prisma),
    POLICY,
    new PgDaemonRepo(prisma),
    new PgDaemonLifecycleOpRepo(prisma),
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
  return { http, calls, applied, cluster }
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
      resourceName: RESOURCE_NAME,
      daemonImage: POLICY.daemonImage,
      runtimeImage: POLICY.runtimeImage,
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
      suspend: false,
      daemon: { image: 'registry.example.test/daemon:2.0.0', tier: 'small' },
      controlPlane: { url: POLICY.controlPlaneUrl },
      runtime: { image: POLICY.runtimeImage, tiers: [{ name: 'medium', warmReplicas: 2 }] },
      quota: { maxAgents: 6, cpu: '0', memory: '0', storage: '0' },
      egressPolicy: 'locked'
    })

    const row = await prisma.orgClusterExecution.findUnique({ where: { orgId: DEFAULT_ORG_ID } })
    expect(row?.enabled).toBe(true)
    expect(row?.resourceName).toBe(RESOURCE_NAME)
    // The namespace is the operator's alone: the applied spec never names one.
    expect(applied.at(-1)?.spec).not.toHaveProperty('targetNamespace')
  })

  it('keeps addressing the same resource across later edits', async () => {
    const { http, calls, applied } = await clusterApp()
    await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { enabled: true } })
    await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { suspend: true } })
    expect(applied).toHaveLength(2)
    expect(applied[1]?.spec).toMatchObject({ suspend: true })
    expect(calls.filter((call) => call === `PATCH ${RESOURCE_PATH}`)).toHaveLength(2)
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

describe('POST /cluster-execution/ensure', () => {
  const ENSURE = `${CLUSTER}/ensure`

  it('provisions an envelope for an org that never configured one', async () => {
    const { http, calls, applied } = await clusterApp()
    const res = await http.app.inject({ method: 'POST', url: ENSURE })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ enabled: true, resourceName: RESOURCE_NAME })
    expect(calls).toContain(`PATCH ${RESOURCE_PATH}`)
    // Applying the resource is the whole job — nothing is delivered after it.
    expect(applied).toHaveLength(1)
    expect(calls.some((call) => call.includes('/secrets'))).toBe(false)
  })

  it('leaves an org whose owner switched cluster execution off alone', async () => {
    const { http, applied } = await clusterApp()
    await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { enabled: true } })
    await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { enabled: false } })
    applied.length = 0

    const res = await http.app.inject({ method: 'POST', url: ENSURE })
    expect(res.statusCode).toBe(200)
    expect(res.json().enabled).toBe(false)
    expect(applied).toEqual([])
  })

  it('is owner-only', async () => {
    const { http } = await clusterApp({ userId: await makeUser('collab-ensure', 'collaborator') })
    expect((await http.app.inject({ method: 'POST', url: ENSURE })).statusCode).toBe(403)
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

  it('keeps the tombstone — the only surviving record of the envelope — when the cluster refuses', async () => {
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
    expect(pending.map((row) => row.resourceName)).toEqual([RESOURCE_NAME])
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
    expect(pending[0]?.resourceName).toBe(RESOURCE_NAME)
  })

  // The envelope's daemon is the control plane's own — nobody could be asked to
  // detach it — and it is recognized by the identity binding its token connect wrote.
  it('retires the envelope’s own daemon instead of refusing the delete', async () => {
    const { http } = await clusterApp()
    await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { enabled: true } })
    const daemonId = '99999999-9999-4999-8999-999999999999'
    await prisma.daemon.create({
      data: {
        id: daemonId,
        orgId: DEFAULT_ORG_ID,
        sessionEpoch: 1n,
        status: 'ready',
        clusterIdentity: `system:serviceaccount:${TARGET_NAMESPACE}:ac-daemon`
      }
    })

    expect((await http.app.inject({ method: 'DELETE', url: ORG })).statusCode).toBe(204)
    expect(await prisma.daemon.findUnique({ where: { id: daemonId } })).toBeNull()
  })

  it('still refuses while a daemon someone attached by hand survives', async () => {
    const { http } = await clusterApp()
    await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { enabled: true } })
    const daemonId = '88888888-8888-4888-8888-888888888888'
    await prisma.daemon.create({
      data: { id: daemonId, orgId: DEFAULT_ORG_ID, sessionEpoch: 1n, status: 'ready' }
    })

    const res = await http.app.inject({ method: 'DELETE', url: ORG })
    expect(res.statusCode).toBe(409)
    // Refusing must not have retired the envelope on the way out.
    expect(await prisma.daemon.findUnique({ where: { id: daemonId } })).not.toBeNull()
    expect((await prisma.orgClusterExecution.findUnique({ where: { orgId: DEFAULT_ORG_ID } }))?.enabled).toBe(true)
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
