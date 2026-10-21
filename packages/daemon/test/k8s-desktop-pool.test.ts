import { afterEach, describe, expect, it } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import { K8sHttp } from '@agentconnect.md/k8s-client'
import { closeFakeApiServers, fakeApiServer, type FakeRoute } from '@agentconnect.md/k8s-client/testing'
import type { ComputerPoolOp, ComputerPoolRegistration } from '@agentconnect.md/protocol'
import {
  AC_LABEL_COMPUTER,
  DesktopPool,
  desktopClaimName,
  desktopPoolSettings,
  type DesktopBootstrap,
  type DesktopBootstrapStatus
} from '../src/k8s/desktop-pool.js'
import { SandboxApi, type Sandbox, type SandboxClaim } from '../src/k8s/sandbox-api.js'
import { OrphanReconciler } from '../src/k8s/orphan-reconciler.js'

// Desktop claims for managed computers (computer-use.md §15.1) against the k8s-client fake API server.

afterEach(closeFakeApiServers)

const NS = 'agents'
const CLAIMS = `/apis/extensions.agents.x-k8s.io/v1beta1/namespaces/${NS}/sandboxclaims`
const SANDBOXES = `/apis/agents.x-k8s.io/v1beta1/namespaces/${NS}/sandboxes`
const C1 = '11111111-1111-4111-8111-111111111111'
const C2 = '22222222-2222-4222-8222-222222222222'
const T0 = '2026-10-21T10:00:00.000Z'

interface Volume {
  files: Record<string, string>
  key?: DesktopBootstrapStatus
}

/** Just enough of the agent-sandbox controller: a claim binds a Sandbox of its own name, whose pod becomes ready on `settle`. */
class FakeSandboxCluster {
  readonly claims = new Map<string, SandboxClaim>()
  readonly sandboxes = new Map<string, Sandbox>()
  /** Each claim's volume: deleted with the claim, kept across suspend and resume. */
  readonly volumes = new Map<string, Volume>()
  readonly writes: Array<{ method: string; path: string; body: unknown }> = []
  /** Pod addresses whose desktop daemon does not answer yet. */
  readonly unanswered = new Set<string>()
  private uid = 0

  readonly route: FakeRoute = ({ method, url, body }) => {
    const path = url.pathname
    const parsed = body ? (JSON.parse(body) as unknown) : undefined
    if (method !== 'GET') this.writes.push({ method, path, body: parsed })
    if (path === CLAIMS && method === 'POST') {
      const claim = parsed as SandboxClaim
      const name = claim.metadata!.name!
      if (this.claims.has(name)) return { status: 409, json: { reason: 'AlreadyExists', message: 'exists' } }
      const stored: SandboxClaim = {
        ...claim,
        metadata: { ...claim.metadata, uid: `claim-${++this.uid}`, creationTimestamp: T0 },
        status: { sandbox: { name } }
      }
      this.claims.set(name, stored)
      this.sandboxes.set(name, {
        metadata: { name, uid: `sandbox-${++this.uid}`, generation: 1 },
        spec: { operatingMode: 'Running' }
      })
      this.volumes.set(name, { files: {} })
      return { status: 201, json: stored }
    }
    if (path === CLAIMS && method === 'GET') {
      const selector = url.searchParams.get('labelSelector')
      const items = [...this.claims.values()].filter((c) => !selector || c.metadata?.labels?.[selector] !== undefined)
      return { json: { items } }
    }
    if (path.startsWith(`${CLAIMS}/`)) {
      const name = path.slice(CLAIMS.length + 1)
      const claim = this.claims.get(name)
      if (!claim) return { status: 404, json: { reason: 'NotFound', message: 'gone' } }
      if (method === 'GET') return { json: claim }
      if (method === 'DELETE') {
        this.claims.delete(name)
        this.sandboxes.delete(name)
        this.volumes.delete(name)
        return { json: {} }
      }
    }
    if (path === SANDBOXES && method === 'GET') return { json: { items: [...this.sandboxes.values()] } }
    if (path.startsWith(`${SANDBOXES}/`)) {
      const name = path.slice(SANDBOXES.length + 1)
      const sandbox = this.sandboxes.get(name)
      if (!sandbox) return { status: 404, json: { reason: 'NotFound', message: 'gone' } }
      if (method === 'GET') return { json: sandbox }
      if (method === 'PATCH') {
        const ops = parsed as Array<{ op: string; path: string; value: string }>
        for (const op of ops) {
          const current = op.path === '/metadata/uid' ? sandbox.metadata?.uid : sandbox.spec?.operatingMode
          if (op.op === 'test' && current !== op.value) return { status: 422, json: { reason: 'Invalid' } }
        }
        const mode = ops.find((op) => op.op === 'replace')!.value as 'Running' | 'Suspended'
        // A mode change is a new spec: the pod goes, and readiness waits for the next settle.
        sandbox.spec = { ...sandbox.spec, operatingMode: mode }
        sandbox.metadata = { ...sandbox.metadata, generation: (sandbox.metadata?.generation ?? 1) + 1 }
        delete sandbox.status
        return { json: sandbox }
      }
    }
    return { status: 404, json: { reason: 'NotFound', message: path } }
  }

  /** The controller's next pass: every Running sandbox gets a ready pod. */
  settle(): void {
    let ip = 10
    for (const sandbox of this.sandboxes.values()) {
      ip++
      if (sandbox.spec?.operatingMode !== 'Running') continue
      sandbox.status = {
        conditions: [{ type: 'Ready', status: 'True', observedGeneration: sandbox.metadata?.generation ?? 1 }],
        podIPs: [{ ip: `10.0.0.${ip}` }]
      }
    }
  }

  volumeAt(ip: string): Volume | undefined {
    for (const [name, sandbox] of this.sandboxes) {
      const addr = sandbox.status?.podIPs?.[0]
      if (addr && typeof addr !== 'string' && addr.ip === ip) return this.volumes.get(name)
    }
    return undefined
  }
}

/** The desktop pods' bootstrap: the key lives on the claim's volume, so it survives sleep and goes with the claim. */
function fakeBootstrap(cluster: FakeSandboxCluster, onRegister?: (r: ComputerPoolRegistration) => string) {
  const pushes: ComputerPoolRegistration[] = []
  const bootstrap: DesktopBootstrap = {
    async status(address) {
      const volume = cluster.volumeAt(address)
      if (!volume || cluster.unanswered.has(address)) throw new Error('connect ECONNREFUSED')
      return volume.key ?? { registered: false }
    },
    async register(address, _port, registration) {
      pushes.push(registration)
      const volume = cluster.volumeAt(address)!
      volume.key = { registered: true, computerId: onRegister?.(registration) ?? C1 }
      return volume.key
    }
  }
  return { bootstrap, pushes }
}

async function setup(onRegister?: (r: ComputerPoolRegistration) => string) {
  const cluster = new FakeSandboxCluster()
  const server = await fakeApiServer(cluster.route)
  const api = new SandboxApi(new K8sHttp(server.config), NS)
  const { bootstrap, pushes } = fakeBootstrap(cluster, onRegister)
  const pool = new DesktopPool({ api, settings: { warmPoolName: 'desktop-pool', bootstrapPort: 7690 }, bootstrap })
  return { cluster, pool, pushes, api }
}

const ensure = (computerId: string, over: Partial<Extract<ComputerPoolOp, { op: 'ensure' }>> = {}): ComputerPoolOp => ({
  op: 'ensure',
  computerId,
  allocation: 'per-agent',
  running: true,
  create: true,
  ...over
})

describe('desktop pool settings', () => {
  it('serves desktop claims only when the deployment names a desktop warm pool', () => {
    expect(desktopPoolSettings({})).toBeUndefined()
    expect(desktopPoolSettings({ AC_K8S_DESKTOP_WARM_POOL: 'desk' })).toEqual({
      warmPoolName: 'desk',
      bootstrapPort: 7690
    })
    expect(() => desktopPoolSettings({ AC_K8S_DESKTOP_WARM_POOL: 'desk', AC_K8S_DESKTOP_BOOTSTRAP_PORT: '0' })).toThrow(
      /not a valid port/
    )
  })
})

describe('DesktopPool', () => {
  it('claims a desktop from the warm pool, waits for its pod, and pushes the registration once', async () => {
    const { cluster, pool, pushes } = await setup()
    const registration = { token: 'acr_token', name: 'Agent desktop' }

    expect(await pool.handle(ensure(C1))).toEqual({
      ok: true,
      state: { computerId: C1, claim: 'present', pod: 'starting', createdAt: T0 }
    })
    const claim = cluster.claims.get(desktopClaimName(C1))!
    expect(claim.spec).toEqual({
      warmPoolRef: { name: 'desktop-pool' },
      additionalPodMetadata: {
        labels: { [AC_LABEL_COMPUTER]: C1, 'agentconnect.md/computer-allocation': 'per-agent' }
      }
    })
    // Never the agent label: the agent orphan sweep must not mistake a desktop for an agent's pod.
    expect(JSON.stringify(claim)).not.toContain('agentconnect.md/agent')

    cluster.settle()
    expect((await pool.handle(ensure(C1))).state).toMatchObject({ pod: 'running', registered: false })
    expect((await pool.handle(ensure(C1, { registration }))).state).toMatchObject({
      pod: 'running',
      registered: true,
      registeredComputerId: C1
    })
    expect((await pool.handle(ensure(C1, { registration }))).state).toMatchObject({ registered: true })
    expect(pushes).toEqual([registration])
  })

  it('suspends a desktop keeping its volume, and resumes it with the files and key it had', async () => {
    const { cluster, pool, pushes } = await setup()
    await pool.handle(ensure(C1))
    cluster.settle()
    await pool.handle(ensure(C1, { registration: { token: 't', name: 'n' } }))
    cluster.volumes.get(desktopClaimName(C1))!.files['profile/cookies.sqlite'] = 'signed-in'

    expect((await pool.handle(ensure(C1, { running: false, create: false }))).state).toMatchObject({ pod: 'suspended' })
    expect(cluster.sandboxes.get(desktopClaimName(C1))!.spec?.operatingMode).toBe('Suspended')
    // Suspending again is a no-op that writes nothing.
    const writes = cluster.writes.length
    expect((await pool.handle(ensure(C1, { running: false, create: false }))).state).toMatchObject({ pod: 'suspended' })
    expect(cluster.writes.length).toBe(writes)

    expect((await pool.handle(ensure(C1, { create: false }))).state).toMatchObject({ pod: 'starting' })
    expect(cluster.sandboxes.get(desktopClaimName(C1))!.spec?.operatingMode).toBe('Running')
    cluster.settle()
    expect((await pool.handle(ensure(C1, { create: false }))).state).toMatchObject({
      pod: 'running',
      registered: true,
      registeredComputerId: C1
    })
    expect(cluster.volumes.get(desktopClaimName(C1))!.files['profile/cookies.sqlite']).toBe('signed-in')
    expect(pushes).toHaveLength(1)
  })

  it('reports a wake whose claim is gone as missing and never creates a fresh one', async () => {
    const { cluster, pool } = await setup()
    expect((await pool.handle(ensure(C2, { create: false }))).state).toEqual({
      computerId: C2,
      claim: 'missing',
      pod: 'none'
    })
    expect(cluster.claims.size).toBe(0)
  })

  it('keeps a pod that is up but not answering as starting, with the reason', async () => {
    const { cluster, pool } = await setup()
    await pool.handle(ensure(C1))
    cluster.settle()
    cluster.unanswered.add('10.0.0.11')
    const state = (await pool.handle(ensure(C1))).state!
    expect(state.pod).toBe('starting')
    expect(state.detail).toMatch(/not answering/)
  })

  it('reports a pod that is not ready with its Ready condition', async () => {
    const { cluster, pool } = await setup()
    await pool.handle(ensure(C1))
    cluster.sandboxes.get(desktopClaimName(C1))!.status = {
      conditions: [{ type: 'Ready', status: 'False', reason: 'ImagePullBackOff' } as never]
    }
    expect((await pool.handle(ensure(C1))).state).toMatchObject({ pod: 'starting', detail: 'ImagePullBackOff' })
  })

  it('deletes a desktop with its volume, idempotently, and lists only desktop claims', async () => {
    const { cluster, pool, api } = await setup()
    await pool.handle(ensure(C1, { allocation: 'ephemeral' }))
    await pool.handle(ensure(C2, { allocation: 'manual' }))
    await api.ensureClaim({ metadata: { name: 'agent-x' }, spec: { warmPoolRef: { name: 'runtime' } } })
    const listed = await pool.handle({ op: 'list' })
    expect(listed.claims?.map((c) => c.computerId).sort()).toEqual([C1, C2])
    expect(listed.claims?.every((c) => c.createdAt === T0)).toBe(true)

    expect(await pool.handle({ op: 'delete', computerId: C1 })).toEqual({
      ok: true,
      state: { computerId: C1, claim: 'deleted', pod: 'none' }
    })
    expect(cluster.volumes.has(desktopClaimName(C1))).toBe(false)
    expect((await pool.handle({ op: 'delete', computerId: C1 })).ok).toBe(true)
  })

  it('answers a failure as not ok instead of throwing', async () => {
    const server = await fakeApiServer(() => ({ status: 500, json: { message: 'boom' } }))
    const pool = new DesktopPool({
      api: new SandboxApi(new K8sHttp(server.config), NS),
      settings: { warmPoolName: 'desktop-pool', bootstrapPort: 7690 }
    })
    const result = await pool.handle(ensure(C1))
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/500/)
  })

  it('runs one op per desktop at a time, so a resent push joins the one in flight', async () => {
    const { cluster, pool, pushes } = await setup()
    await pool.handle(ensure(C1))
    cluster.settle()
    const op = ensure(C1, { registration: { token: 't', name: 'n' } })
    const [a, b] = await Promise.all([pool.handle(op), pool.handle(op)])
    expect(a).toEqual(b)
    expect(pushes).toHaveLength(1)
  })

  it('is never collected by the agent orphan sweep', async () => {
    const { pool, api } = await setup()
    await pool.handle(ensure(C1))
    const clock = new FakeClock(Date.parse(T0) + 30 * 86_400_000)
    const reconciler = new OrphanReconciler({
      api,
      liveAgents: async () => new Set(),
      settings: { graceMs: 1, movedGraceMs: 1, deleteEnabled: true },
      clock,
      log: { info: () => {}, warn: () => {}, debug: () => {} }
    })
    const summary = await reconciler.sweep()
    expect(summary?.candidates).toBe(0)
    expect((await pool.handle(ensure(C1, { create: false }))).state?.claim).toBe('present')
  })
})

describe('httpDesktopBootstrap', () => {
  it('reads the status and pushes a registration, taking 409 as already registered', async () => {
    const { createServer } = await import('node:http')
    const { httpDesktopBootstrap } = await import('../src/k8s/desktop-pool.js')
    let registered = false
    const bodies: string[] = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        res.setHeader('content-type', 'application/json')
        if (req.url === '/pool/status')
          return res.end(JSON.stringify(registered ? { registered, computerId: C1 } : { registered }))
        bodies.push(body)
        res.statusCode = registered ? 409 : 200
        registered = true
        res.end(JSON.stringify({ registered: true, computerId: C1 }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      expect(await httpDesktopBootstrap.status('127.0.0.1', port)).toEqual({ registered: false })
      expect(await httpDesktopBootstrap.register('127.0.0.1', port, { token: 't', name: 'n' })).toEqual({
        registered: true,
        computerId: C1
      })
      expect(await httpDesktopBootstrap.register('127.0.0.1', port, { token: 't', name: 'n' })).toEqual({
        registered: true,
        computerId: C1
      })
      expect(JSON.parse(bodies[0]!)).toEqual({ token: 't', name: 'n' })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
