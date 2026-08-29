import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Backoff } from '@agentconnect.md/connection'
import { K8sHttp } from '@agentconnect.md/k8s-client'
import { closeFakeApiServers, fakeApiServer } from '@agentconnect.md/k8s-client/testing'
import { AcpHost } from '../src/acp/acp-host.js'
import { Daemon } from '../src/daemon.js'
import { SandboxApi } from '../src/k8s/sandbox-api.js'
import { startK8sRuntimePlane, type K8sRuntimePlane } from '../src/k8s/runtime-plane.js'
import { ShimClient, type ShimTransport } from '../src/shim/client.js'
import { ShimServer } from '../src/shim/server.js'
import { fakeGenerations } from './fake-generations.js'
import { waitBudget } from './wait-support.js'

/**
 * The sandbox cold-start race (#1010).
 *
 * A pod that is still coming up — PVC bind plus image pull — cannot answer a dial at all, and
 * the daemon used to read that as a lost channel: after a fixed 20s window it revoked the
 * binding, tore the ACP host down, and left it torn down, so every later turn failed with "ACP
 * connection closed" until the member was replaced. Both halves are checked here: the loss
 * window starts from the pod being up, and a runtime that DID reach terminal exit leaves no
 * dead host memoized behind it.
 */

const here = dirname(fileURLToPath(import.meta.url))
const fakeAgent = join(here, 'fixtures', 'fake-acp-agent.mjs')
const SILENT = { info: () => {}, warn: () => {}, debug: () => {} }
const POD_NAME = 'pool-pod-9'
const AGENT = 'agent-a'
const WAIT = waitBudget(15_000)

const planes: K8sRuntimePlane[] = []
const clients: ShimClient[] = []
const servers: ShimServer[] = []
const hosts: AcpHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop(2_000).catch(() => undefined)
  for (const client of clients.splice(0)) client.stop()
  for (const plane of planes.splice(0)) await plane.stop()
  for (const server of servers.splice(0)) await server.stop()
  await closeFakeApiServers()
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A gate the test opens when the pod starts answering dials. */
function gate(): { closed: () => void; open: () => void; wait: () => Promise<void> } {
  let waiting: Promise<void> = Promise.resolve()
  let release: () => void = () => {}
  return {
    closed: () => {
      waiting = new Promise<void>((resolve) => (release = resolve))
    },
    open: () => release(),
    wait: () => waiting
  }
}

/** The Sandbox as the API server reports it; `ready` is the pod being up. */
function sandboxObject(ready: boolean): unknown {
  return {
    metadata: { name: 'sb-1', uid: 'sandbox-uid-1', annotations: { 'agents.x-k8s.io/pod-name': POD_NAME } },
    spec: { operatingMode: 'Running' },
    status: { conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }], podIPs: ['127.0.0.1'] }
  }
}

/**
 * A cluster the test drives: a real SandboxApi over the in-process fake API server, a real
 * dialer reaching a real sandbox listener over a real socket, and one flag per thing the test
 * changes — whether the pod reports Ready, and whether its shim answers the daemon's dial.
 */
async function clusterUnderTest(options: {
  rebindGraceMs: number
  readyTimeoutMs: number
  log?: { info: (m: string) => void; warn: (m: string) => void; debug: (m: string) => void }
}): Promise<{
  plane: K8sRuntimePlane
  server: ShimServer
  state: { ready: boolean; hang: boolean }
  reachable: ReturnType<typeof gate>
  shim: () => ShimClient
}> {
  const server = new ShimServer()
  const port = await server.start(0, '127.0.0.1')
  servers.push(server)
  const state = { ready: true, hang: false }
  let claim: unknown
  const { config } = await fakeApiServer(({ method, url }) => {
    const path = url.pathname
    if (path.endsWith('/tokenreviews')) {
      return {
        json: {
          status: {
            authenticated: true,
            user: {
              username: 'system:serviceaccount:agent-sandboxes:sandbox',
              extra: {
                'authentication.kubernetes.io/pod-name': [POD_NAME],
                'authentication.kubernetes.io/pod-uid': ['pod-uid-1']
              }
            }
          }
        }
      }
    }
    if (path.endsWith('/sandboxes/sb-1')) {
      // `hang` is an API server that accepts the read and never answers it — headers withheld,
      // response never ended — which is what a request with no deadline waits on forever.
      if (state.hang) return { lines: [], hold: true }
      return { json: sandboxObject(state.ready) }
    }
    if (path.endsWith('/sandboxclaims')) {
      if (method !== 'POST') return { json: { items: [] } }
      claim = { metadata: { name: `agent-${AGENT}`, uid: 'claim-uid-1' }, status: { sandbox: { name: 'sb-1' } } }
      return { json: claim }
    }
    if (path.endsWith(`/sandboxclaims/agent-${AGENT}`)) {
      if (method === 'DELETE') {
        claim = undefined
        return { json: {} }
      }
      if (!claim) return { status: 404, json: { kind: 'Status', reason: 'NotFound', message: 'no claim' } }
      return { json: claim }
    }
    return { status: 404, json: { kind: 'Status', reason: 'NotFound', message: path } }
  })
  const plane = await startK8sRuntimePlane({
    orgForAgent: () => 'org-1',
    warmPoolName: 'pool',
    generations: fakeGenerations(),
    sandboxNamespace: 'agent-sandboxes',
    memberId: 'member-a',
    shimPort: port,
    readyTimeoutMs: options.readyTimeoutMs,
    rebindGraceMs: options.rebindGraceMs,
    api: new SandboxApi(new K8sHttp(config), 'agent-sandboxes') as never,
    log: options.log ?? SILENT
  })
  planes.push(plane)
  const reachable = gate()
  const shim = (): ShimClient => {
    const client = new ShimClient({
      endpoint: 'accepted-daemon-channel',
      // The pod answers a dial only while the gate is open; a closed gate is a pod that is
      // still coming up, which is what the daemon must not read as a lost channel.
      dial: async () => {
        await reachable.wait()
        return (await server.nextTransport()) as ShimTransport
      },
      readToken: () => 'projected-token',
      backoff: new Backoff({ baseMs: 25, capMs: 100, jitter: () => 0 }),
      log: { info: () => {}, warn: () => {} }
    })
    clients.push(client)
    void client.start()
    return client
  }
  return { plane, server, state, reachable, shim }
}

/** A host whose runtime runs in the sandbox, over the plane's driver. */
function hostUnderTest(plane: K8sRuntimePlane, onTerminal?: () => void): AcpHost {
  const host = new AcpHost(
    { command: process.execPath, args: [fakeAgent], env: [] },
    {
      driver: plane.driver,
      onUpdate: () => {},
      ...(onTerminal ? { onTerminal } : {}),
      env: { AC_AGENT_ID: AGENT }
    }
  )
  hosts.push(host)
  return host
}

/** Collect unhandled rejections raised while `work` runs — `binding revoked` was one. */
async function unhandledRejectionsDuring(work: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = []
  const listener = (reason: unknown): void => void seen.push(reason)
  process.on('unhandledRejection', listener)
  try {
    await work()
    // Node reports an unobserved rejection a tick after it is created, so give it one.
    await delay(250)
  } finally {
    process.off('unhandledRejection', listener)
  }
  return seen
}

describe('a shim channel that drops while its sandbox pod is coming up', () => {
  it('keeps dialing the cold pod and serves a turn once it binds', async () => {
    // The defect: a dial that could not complete while the pod was being created counted
    // against a fixed grace window, so the launch was revoked and the runtime killed — even
    // though the pod was on its way up and its shim would have bound moments later.
    const { plane, state, reachable, shim } = await clusterUnderTest({ rebindGraceMs: 400, readyTimeoutMs: 8_000 })
    shim()
    const host = hostUnderTest(plane)
    await host.start()
    const sessionId = await host.newSession('/tmp')
    expect(await host.prompt(sessionId, [{ type: 'text', text: 'before' }])).toMatchObject({ stopReason: 'end_turn' })

    // The pod goes down for a cold restart: the Sandbox stops reporting Ready and nothing
    // answers a dial until its image is pulled and the shim is listening again.
    state.ready = false
    reachable.closed()
    plane.dialer.connectionsFor(AGENT)[0]?.close('pod restarting')
    await vi.waitFor(() => expect(plane.dialer.connectionsFor(AGENT)).toHaveLength(0), WAIT)

    // Five grace windows of cold start. None of it is a loss: the launch stands, and so does
    // the session the runtime speaks ACP over.
    await delay(2_000)
    expect(plane.driver.currentLaunch(AGENT)).toBeDefined()
    expect(plane.driver.sessionFor(AGENT)).toBeDefined()

    // The pod comes up and its shim binds again.
    state.ready = true
    reachable.open()
    await vi.waitFor(() => expect(plane.dialer.connectionsFor(AGENT).length).toBeGreaterThan(0), WAIT)
    await vi.waitFor(() => expect(plane.runsInSandbox(AGENT)).toBe(true), WAIT)

    // The agent is serving, which is the whole point: same host, same ACP session, a turn
    // dispatched after the bind.
    expect(await host.prompt(sessionId, [{ type: 'text', text: 'after' }])).toMatchObject({ stopReason: 'end_turn' })
  }, 60_000)

  it('still reports loss when the pod is up and no shim comes back, without an unhandled rejection', async () => {
    // The other half of the same window: waiting for a pod that IS up would be waiting forever,
    // and the revoke that follows a real loss must not surface as an unhandled rejection —
    // `stopDial` rejects a dial nobody is awaiting, which is expected and is swallowed there.
    const { plane, reachable, shim } = await clusterUnderTest({ rebindGraceMs: 400, readyTimeoutMs: 4_000 })
    const client = shim()
    let terminal = 0
    const host = hostUnderTest(plane, () => (terminal += 1))
    await host.start()

    const rejections = await unhandledRejectionsDuring(async () => {
      // The pod is Ready throughout; its shim simply never comes back.
      reachable.closed()
      client.stop()
      await vi.waitFor(() => expect(plane.driver.currentLaunch(AGENT)).toBeUndefined(), WAIT)
      await vi.waitFor(() => expect(terminal).toBe(1), WAIT)
    })
    expect(rejections).toEqual([])
  }, 60_000)

  it('gives the shim the whole grace window measured from the pod coming up', async () => {
    // The window is for a pod that is up: a pod that arrives late must still get the full grace
    // to dial in, or a cold start that finishes just as the window elapses is killed on arrival.
    const grace = 400
    let lostAt = 0
    const log = {
      info: () => {},
      debug: () => {},
      warn: (message: string) => {
        if (message.includes('reporting loss') && lostAt === 0) lostAt = Date.now()
      }
    }
    const { plane, state, reachable, shim } = await clusterUnderTest({
      rebindGraceMs: grace,
      readyTimeoutMs: 8_000,
      log
    })
    const client = shim()
    const host = hostUnderTest(plane)
    await host.start()

    // The pod goes cold and its shim never comes back, so the only question is WHEN the window
    // that ends the launch starts.
    state.ready = false
    reachable.closed()
    client.stop()
    await delay(1_500)
    expect(lostAt).toBe(0)
    const readyAt = Date.now()
    state.ready = true

    await vi.waitFor(() => expect(lostAt).toBeGreaterThan(0), WAIT)
    // Measured from the pod being observed up, not from the socket that dropped while there was
    // no pod to dial at all — the readiness poll is a quarter of the window, so a report that
    // started its clock at the drop would land far inside it.
    expect(lostAt - readyAt).toBeGreaterThanOrEqual(grace - 50)
  }, 60_000)

  it('reports loss at the ceiling when the readiness read itself never answers', async () => {
    // The readiness read is the new dependency this window has, and the Kubernetes client has no
    // request deadline of its own: one accepted-but-unanswered GET would otherwise pin the watch,
    // and with it the lost session and the dead host — exactly the stuck-forever outcome the
    // window exists to remove. Each read is bounded by what is LEFT of the ceiling instead.
    const { plane, state, reachable, shim } = await clusterUnderTest({ rebindGraceMs: 400, readyTimeoutMs: 2_000 })
    const client = shim()
    let terminal = 0
    const host = hostUnderTest(plane, () => (terminal += 1))
    await host.start()

    state.hang = true
    reachable.closed()
    client.stop()
    // The launch is released and the runtime learns its channel is gone, so the next message
    // re-claims a pod and rebuilds the host rather than waiting on a read that never returns.
    await vi.waitFor(() => expect(plane.driver.currentLaunch(AGENT)).toBeUndefined(), WAIT)
    await vi.waitFor(() => expect(terminal).toBe(1), WAIT)
  }, 60_000)

  it('reports loss for a pod that never comes up, bounded by the pod-up timeout', async () => {
    // The ceiling: a sandbox stuck pulling an image forever must not pin a dead launch, or the
    // agent would never be re-claimed onto a pod that works.
    const { plane, state, reachable, shim } = await clusterUnderTest({ rebindGraceMs: 400, readyTimeoutMs: 2_000 })
    const client = shim()
    const host = hostUnderTest(plane)
    await host.start()

    state.ready = false
    reachable.closed()
    client.stop()
    await vi.waitFor(() => expect(plane.driver.currentLaunch(AGENT)).toBeUndefined(), WAIT)
  }, 60_000)
})

/** A daemon root with one agent whose runtime is the fake ACP adapter — a real host, not a stub. */
function daemonRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-cold-start-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: process.execPath, args: [fakeAgent] } }
    })
  )
  const agentDir = join(root, 'agents', 'bot-a')
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(
    join(agentDir, 'agent.json'),
    JSON.stringify({
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(agentDir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return root
}

describe('a runtime that reached terminal exit', () => {
  it('leaves no dead host memoized, so the next message starts a fresh one', async () => {
    // What kept #1010 broken after the re-bind: the host torn down with the lost channel stayed
    // in the daemon's map, so every later turn was dispatched into a closed ACP connection. The
    // teardown is paired with the ordinary start path — the exit reclaims the host, and the next
    // caller builds and starts a new one exactly as a fresh activation would.
    const daemon = new Daemon({ root: daemonRoot() })
    try {
      await daemon.start()
      const first = (await (daemon as any).ensureHostAsync('bot-a')) as AcpHost
      expect((daemon as any).hosts.get('bot-a')).toBe(first)

      // The runtime goes terminal. A lost sandbox channel produces exactly this signal —
      // cluster-acp-e2e covers that half — and a local adapter that crashes produces it too.
      await first.stop(2_000)
      await vi.waitFor(() => expect((daemon as any).hosts.has('bot-a')).toBe(false), WAIT)
      expect((daemon as any).readyHosts.has('bot-a')).toBe(false)

      const second = (await (daemon as any).ensureHostAsync('bot-a')) as AcpHost
      expect(second).not.toBe(first)
      expect((daemon as any).readyHosts.has('bot-a')).toBe(true)
      // Serving, not merely constructed: the rebuilt host answers a session on its own child.
      expect(await second.newSession(join(daemonRoot(), 'workspace'))).toBeTruthy()
    } finally {
      await daemon.stop()
    }
  }, 60_000)
})
