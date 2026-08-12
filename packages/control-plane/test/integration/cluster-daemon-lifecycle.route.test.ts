/**
 * The cluster daemon's lifecycle surface. A machine daemon is commanded over its
 * WebSocket; an operator-managed pod has no npm install to replace and no supervisor to
 * exit to, so the same two routes mean something different for it: restart is refused,
 * and upgrade rewrites the version tag on its organization's `AgentConnectOrg`.
 *
 * The two invariants worth a real database and a real API server are that the image
 * change lands on BOTH the resource and the settings row (the periodic re-apply renders
 * the spec from the row, so a CR-only write would be reverted), and that none of it
 * requires the daemon to be reachable — rescuing a pod crash-looping on a bad image is
 * the point.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { K8sHttp } from '@agentconnect.md/k8s-client'
import { closeFakeApiServers, fakeApiServer } from '@agentconnect.md/k8s-client/testing'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { AgentConnectOrgApi, ClusterExecutionService, orgResourceName } from '../../src/cluster/index.js'
import { systemClock } from '../../src/domain/clock.js'
import { PgOrgClusterExecutionRepo } from '../../src/persistence/repositories/org-cluster-execution.repo.js'
import { PgDaemonRepo } from '../../src/persistence/repositories/daemon.repo.js'
import { PgDaemonLifecycleOpRepo } from '../../src/persistence/repositories/daemon-lifecycle-op.repo.js'
import { PgOrgRepo } from '../../src/persistence/repositories/org.repo.js'
import { PgRuntimeProfileRepo } from '../../src/persistence/repositories/runtime-profile.repo.js'
import { DaemonRegistryService } from '../../src/registry/registryService.js'
import { DaemonId, OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const DAEMON = '11111111-1111-4111-8111-111111111111'
const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const CLUSTER = `${ORG}/cluster-execution`
const CONTROL_NAMESPACE = 'agentconnect-control'
const POLICY = {
  namespacePrefix: 'ac-org-',
  daemonImage: 'registry.example.test/daemon:v1.4.0',
  runtimeImage: 'registry.example.test/runtime:v1.4.0',
  daemonTier: 'small',
  runtimeTiers: [{ name: 'small', warmReplicas: 0 }],
  controlPlaneUrl: 'wss://api.example.test/daemon/ws'
}
const RESOURCE_NAME = orgResourceName(POLICY.namespacePrefix, DEFAULT_ORG_ID)

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
  await closeFakeApiServers()
})

interface Harness {
  http: HttpApp
  /** Bodies of the apply PATCHes, newest last. */
  applied: { spec?: { daemon?: { image?: string } } }[]
  cluster: ClusterExecutionService
  /** Flip to make every later apply fail — the cluster refusing a durable change. */
  refuseApply: { on: boolean }
}

/**
 * An app whose provisioner talks to a fake API server that stores what it is applied.
 *
 * `afterApply` runs between the image write and the route's arming step, which is the only
 * way to land the replacement pod's READY inside that window from a test.
 */
async function clusterApp(options: { afterApply?: () => Promise<void> } = {}): Promise<Harness> {
  const applied: { spec?: { daemon?: { image?: string } } }[] = []
  const refuseApply = { on: false }
  let stored: unknown = null
  const server = await fakeApiServer((req) => {
    if (req.method === 'PATCH') {
      if (refuseApply.on) return { status: 500, json: { kind: 'Status', message: 'apply refused' } }
      const body = JSON.parse(req.body) as { spec?: { daemon?: { image?: string } } }
      applied.push(body)
      // Standing in for the operator, which derives and publishes the namespace.
      stored = { ...body, status: { namespace: `${POLICY.namespacePrefix}${RESOURCE_NAME}` } }
    }
    if (req.method === 'DELETE') stored = null
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
    systemClock
  )
  if (options.afterApply) {
    const write = cluster.setDaemonVersion.bind(cluster)
    cluster.setDaemonVersion = async (orgId, version) => {
      const image = await write(orgId, version)
      await options.afterApply!()
      return image
    }
  }
  const http = buildHttpApp(prisma, undefined, undefined, undefined, { clusterExecution: cluster })
  opened.push(http)
  return { http, applied, cluster, refuseApply }
}

/** The pod the operator replaced, coming back: a fresh auth (higher epoch) then READY. */
async function replacementRegisters(agentVersion: string): Promise<void> {
  const daemons = new PgDaemonRepo(prisma)
  await daemons.upsertOnAuth({ daemonId: DaemonId(DAEMON), orgId: OrgId(DEFAULT_ORG_ID), agentVersion })
  await daemons.applyRegister(DaemonId(DAEMON), {
    host: 'ac-daemon',
    capabilities: { platforms: [], runtimes: ['claude'], acp: true, features: [] },
    maxAgents: 4,
    cluster: true
  })
  await new DaemonRegistryService(
    daemons,
    new PgRuntimeProfileRepo(prisma),
    new PgDaemonLifecycleOpRepo(prisma),
    systemClock
  ).settleLifecycleOpOnReady(DaemonId(DAEMON))
}

/** A registered daemon row, never connected — `cluster` is what `register` reported. */
async function seedDaemon(cluster: boolean, agentVersion = '1.4.0'): Promise<void> {
  const repo = new PgDaemonRepo(prisma)
  await repo.upsertOnAuth({ daemonId: DaemonId(DAEMON), orgId: OrgId(DEFAULT_ORG_ID), agentVersion })
  await repo.applyRegister(DaemonId(DAEMON), {
    host: 'ac-daemon',
    capabilities: { platforms: [], runtimes: ['claude'], acp: true, features: [] },
    maxAgents: 4,
    cluster
  })
}

/** Switch cluster execution on for the org so there is an envelope to repoint. */
async function enableEnvelope(http: HttpApp): Promise<void> {
  const res = await http.app.inject({ method: 'PUT', url: CLUSTER, payload: { enabled: true } })
  expect(res.statusCode).toBe(200)
}

describe('GET /daemons', () => {
  it('reports a registered cluster daemon as one', async () => {
    const { http } = await clusterApp()
    await seedDaemon(true)
    const res = await http.app.inject({ method: 'GET', url: `${ORG}/daemons` })
    expect(res.statusCode).toBe(200)
    expect(res.json()[0]).toMatchObject({ daemonId: DAEMON, cluster: true })
  })

  it('reports a machine daemon as not one', async () => {
    const { http } = await clusterApp()
    await seedDaemon(false)
    const res = await http.app.inject({ method: 'GET', url: `${ORG}/daemons` })
    expect(res.json()[0]).toMatchObject({ cluster: false })
  })
})

describe('POST /daemons/:id/upgrade — cluster daemon', () => {
  it('repoints the envelope and opens an op, with the daemon offline', async () => {
    const { http, applied } = await clusterApp()
    await enableEnvelope(http)
    await seedDaemon(true)

    const res = await http.app.inject({
      method: 'POST',
      url: `${ORG}/daemons/${DAEMON}/upgrade`,
      payload: { version: '1.5.0' }
    })
    // 202 even though nothing is connected: the image change IS the command.
    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ op: 'upgrade', status: 'pending', targetVersion: '1.5.0' })

    expect(applied.at(-1)?.spec?.daemon?.image).toBe('registry.example.test/daemon:v1.5.0')
    // And through the settings row, so the next ordinary write does not revert it.
    const settings = await http.app.inject({ method: 'GET', url: CLUSTER })
    expect(settings.json()).toMatchObject({ daemonImage: 'registry.example.test/daemon:v1.5.0' })

    // Armed, so the replacement pod's READY can settle it (a bare `pending` never would).
    const op = await new PgDaemonLifecycleOpRepo(prisma).pendingForDaemon(DaemonId(DAEMON))
    expect(op?.acceptedAt).not.toBeNull()
  })

  it('refuses a second command while one is in flight', async () => {
    const { http } = await clusterApp()
    await enableEnvelope(http)
    await seedDaemon(true)
    const first = await http.app.inject({
      method: 'POST',
      url: `${ORG}/daemons/${DAEMON}/upgrade`,
      payload: { version: '1.5.0' }
    })
    expect(first.statusCode).toBe(202)
    const second = await http.app.inject({
      method: 'POST',
      url: `${ORG}/daemons/${DAEMON}/upgrade`,
      payload: { version: '1.6.0' }
    })
    expect(second.statusCode).toBe(409)
  })

  // Re-applying the running image changes no generation, so the op could only expire.
  it('refuses the version the daemon already runs', async () => {
    const { http, applied } = await clusterApp()
    await enableEnvelope(http)
    await seedDaemon(true, '1.5.0')
    const before = applied.length
    const res = await http.app.inject({
      method: 'POST',
      url: `${ORG}/daemons/${DAEMON}/upgrade`,
      payload: { version: '1.5.0' }
    })
    expect(res.statusCode).toBe(409)
    expect(applied).toHaveLength(before)
  })

  /**
   * `DaemonUpgradeBody` admits any plain token, so the route normalizes before anything
   * durable is written: `v1.5.0` is the same version spelled the image's way (and would
   * otherwise compose `vv1.5.0`), while `latest` names no version an image tag or a pod
   * report could ever match.
   */
  it('accepts the image spelling of a version and stores the canonical one', async () => {
    const { http, applied } = await clusterApp()
    await enableEnvelope(http)
    await seedDaemon(true)
    const res = await http.app.inject({
      method: 'POST',
      url: `${ORG}/daemons/${DAEMON}/upgrade`,
      payload: { version: 'v1.5.0' }
    })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ targetVersion: '1.5.0' }) // what the pod will report
    expect(applied.at(-1)?.spec?.daemon?.image).toBe('registry.example.test/daemon:v1.5.0')
  })

  it('refuses a dist-tag before writing anything', async () => {
    const { http, applied } = await clusterApp()
    await enableEnvelope(http)
    await seedDaemon(true)
    const before = applied.length
    const res = await http.app.inject({
      method: 'POST',
      url: `${ORG}/daemons/${DAEMON}/upgrade`,
      payload: { version: 'latest' }
    })
    expect(res.statusCode).toBe(400)
    expect(applied).toHaveLength(before)
    expect(await new PgDaemonLifecycleOpRepo(prisma).latestForDaemon(DaemonId(DAEMON))).toBeNull()
  })

  it('refuses when the organization has no live envelope', async () => {
    const { http } = await clusterApp()
    await seedDaemon(true)
    const res = await http.app.inject({
      method: 'POST',
      url: `${ORG}/daemons/${DAEMON}/upgrade`,
      payload: { version: '1.5.0' }
    })
    expect(res.statusCode).toBe(409)
    // The op is opened before the write is attempted, so it must be closed on failure.
    const op = await new PgDaemonLifecycleOpRepo(prisma).latestForDaemon(DaemonId(DAEMON))
    expect(op).toMatchObject({ status: 'failed' })
  })
})

describe('POST /daemons/:id/restart — cluster daemon', () => {
  it('is refused: relaunching the pod belongs to the operator', async () => {
    const { http } = await clusterApp()
    await enableEnvelope(http)
    await seedDaemon(true)
    const res = await http.app.inject({ method: 'POST', url: `${ORG}/daemons/${DAEMON}/restart` })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'DAEMON_CLUSTER_MANAGED' })
    // Refused before anything durable: no op row to leave behind.
    expect(await new PgDaemonLifecycleOpRepo(prisma).latestForDaemon(DaemonId(DAEMON))).toBeNull()
  })
})

describe('cluster daemon upgrade — settlement and durability', () => {
  /**
   * The replacement pod can reach READY before the route finishes arming the op, and an
   * unarmed op ignores that READY on purpose (the command may still be declined). Nothing
   * would look again, so the op would sit pending until its 15-minute deadline even though
   * the upgrade succeeded. The route therefore re-checks after arming.
   */
  it('settles an upgrade whose pod came back before the op was armed', async () => {
    const { http } = await clusterApp({ afterApply: () => replacementRegisters('1.5.0') })
    await enableEnvelope(http)
    await seedDaemon(true)

    const res = await http.app.inject({
      method: 'POST',
      url: `${ORG}/daemons/${DAEMON}/upgrade`,
      payload: { version: '1.5.0' }
    })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ status: 'succeeded' })
    expect(await new PgDaemonLifecycleOpRepo(prisma).pendingForDaemon(DaemonId(DAEMON))).toBeNull()
  })

  /**
   * The row is written before the apply, so a refused apply leaves a change that the
   * re-apply pass would eventually push — outliving this operation's deadline and landing
   * under an op already reported failed. A COMMAND cannot leave that behind, so the intent
   * is abandoned: the envelope goes back to the image it had, and failure is then simply
   * true rather than a description that expires.
   */
  it('rolls the envelope back and fails the op when the cluster refuses the apply', async () => {
    const { http, refuseApply } = await clusterApp()
    await enableEnvelope(http)
    await seedDaemon(true)
    refuseApply.on = true

    const res = await http.app.inject({
      method: 'POST',
      url: `${ORG}/daemons/${DAEMON}/upgrade`,
      payload: { version: '1.5.0' }
    })
    expect(res.statusCode).toBe(502)
    expect(res.json()).toMatchObject({ code: 'CLUSTER_API_ERROR' })

    const ops = new PgDaemonLifecycleOpRepo(prisma)
    expect(await ops.pendingForDaemon(DaemonId(DAEMON))).toBeNull()
    expect(await ops.latestForDaemon(DaemonId(DAEMON))).toMatchObject({ status: 'failed' })
    // The decisive assertion: nothing durable survives, so no later pass can enact it.
    const settings = await http.app.inject({ method: 'GET', url: CLUSTER })
    expect(settings.json()).toMatchObject({ daemonImage: 'registry.example.test/daemon:v1.4.0' })
  })

  // And with the intent abandoned, a recovered cluster converges on the OLD image — the
  // version the failed operation reported, not a surprise upgrade after the fact.
  it('does not apply the abandoned image once the cluster recovers', async () => {
    const { http, cluster, applied, refuseApply } = await clusterApp()
    await enableEnvelope(http)
    await seedDaemon(true)
    refuseApply.on = true
    await http.app.inject({
      method: 'POST',
      url: `${ORG}/daemons/${DAEMON}/upgrade`,
      payload: { version: '1.5.0' }
    })
    refuseApply.on = false

    const outcome = await cluster.resyncEnvelopes()
    expect(outcome.failures).toEqual([])
    expect(applied.at(-1)?.spec?.daemon?.image).toBe('registry.example.test/daemon:v1.4.0')
  })

  /**
   * The fleet sweep has no deadline to outlive, so it keeps the durable intent and lets the
   * re-apply pass push what its own attempt could not. Same failure, opposite decision —
   * which is why abandoning lives with the caller that owns a deadline, not in the seam.
   */
  it('keeps a sweep’s durable intent and converges it on the next pass', async () => {
    const { http, cluster, applied, refuseApply } = await clusterApp()
    await enableEnvelope(http)
    refuseApply.on = true
    const sweep = await cluster.alignDaemonVersion('1.5.0')
    expect(sweep.moved).toEqual([DEFAULT_ORG_ID])
    refuseApply.on = false

    await cluster.resyncEnvelopes()
    expect(applied.at(-1)?.spec?.daemon?.image).toBe('registry.example.test/daemon:v1.5.0')
    const settings = await http.app.inject({ method: 'GET', url: CLUSTER })
    expect(settings.json()).toMatchObject({ daemonImage: 'registry.example.test/daemon:v1.5.0' })
  })
})
