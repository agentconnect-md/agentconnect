/**
 * Phase 5 — Wire-up & app assembly, first failing test (design §6 Phase 5).
 *
 * Builds the WHOLE app through the single composition entrypoint
 * `buildApp({ prisma, clock, secretsProvider })` — the same graph production
 * constructs — and proves the two edges share one DB and one orchestrator:
 *
 *   1. `/health` is still served (200) from the assembled Fastify instance.
 *   2. A daemon completes a real WS handshake over the live `http.Server`
 *      (`auth → auth/ok → register → register/ok`) at the configured `WS_PATH`.
 *   3. A REST `POST /agents` (through `app.http.inject`) is visible in a
 *      subsequently-connecting daemon's `register/ok` reconcile snapshot — i.e.
 *      the agent the C2 BFF wrote is placed and the WS reconcile reads it back
 *      from the SAME Postgres (REST + WS share one DB/orchestrator).
 *
 * Runs against real Testcontainers Postgres; the clock is the system clock (the
 * handshake mints a real epoch and the reconcile reads the real routing table).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { isFrame, type AnyFrame } from '@agentconnect.md/protocol'

import { prisma } from '../setup.db.js'
import { buildApp, type App } from '../../src/app.js'
import { AppConfigSchema, type AppConfig } from '../../src/config/env.js'
import { systemClock } from '../../src/domain/clock.js'
import { MemorySecretsProvider } from '../../src/secrets/providers/memory.js'
import { ApiKeyCodec } from '../../src/registry/apiKey.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

// Console routes are org-scoped: /orgs/:orgId/… (devAuth = seeded owner of the default org).
const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`

const DAEMON = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const SUBPROTOCOL = 'agentconnect.v1'
const API_KEY_PEPPER = 'smoke-api-key-pepper-0123456789abcdef'

/** A full AppConfig for the smoke test (memory secrets, no OIDC → devAuth). */
function smokeConfig(): AppConfig {
  return AppConfigSchema.parse({
    DATABASE_URL: 'postgresql://smoke/ignored', // prisma is injected; URL unused
    API_KEY_PEPPER,
    SECRETS_PROVIDER: 'memory',
    WS_PATH: '/daemon/ws',
    HEARTBEAT_SEC: 15
  })
}

let running: App | undefined

afterEach(async () => {
  await running?.shutdown()
  running = undefined
})

/** Build the whole app, listen on an ephemeral port, mount the WS gateway. */
async function start(): Promise<{ app: App; wsUrl: string; token: string }> {
  const config = smokeConfig()
  const app = buildApp({
    prisma,
    config,
    clock: systemClock,
    secretsProvider: new MemorySecretsProvider()
  })
  running = app

  const address = await app.http.listen({ port: 0, host: '127.0.0.1' })
  app.mountWs() // http.server exists now

  // Provision the daemon row + mint an API key with the SAME pepper the app trusts.
  const codec = new ApiKeyCodec({ API_KEY_PEPPER })
  const minted = codec.mint()
  await prisma.daemon.create({ data: { id: DAEMON, orgId: DEFAULT_ORG_ID, status: 'provisioned' } })
  await prisma.apiKey.create({
    data: {
      principalType: 'daemon',
      orgId: DEFAULT_ORG_ID,
      daemonId: DAEMON,
      hash: minted.hash,
      displayTail: minted.displayTail
    }
  })

  return { app, wsUrl: `${address.replace(/^http/, 'ws')}${config.WS_PATH}`, token: minted.token }
}

function dial(url: string, protocols: string | string[]): Promise<WebSocket> {
  const ws = new WebSocket(url, protocols)
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
    ws.once('close', (code) => reject(new Error(`closed before open: ${code}`)))
  })
}

function nextFrame(ws: WebSocket, type: string): Promise<AnyFrame> {
  return new Promise((resolve, reject) => {
    const onMsg = (data: Buffer): void => {
      const frame = JSON.parse(data.toString()) as AnyFrame
      if (frame.type === type) {
        ws.off('message', onMsg)
        resolve(frame)
      }
    }
    ws.on('message', onMsg)
    ws.once('close', (code) => reject(new Error(`closed waiting for ${type}: ${code}`)))
  })
}

function sendFrame(ws: WebSocket, type: string, payload: unknown, id = randomUUID()): string {
  ws.send(JSON.stringify({ v: 1, id, ts: new Date().toISOString(), type, payload }))
  return id
}

/** Drive a daemon through auth → register over `ws`; return the register/ok payload. */
async function handshake(
  ws: WebSocket,
  token: string,
  localState: { assignments: string[]; crons: string[]; leases: string[] } = {
    assignments: [],
    crons: [],
    leases: []
  }
): Promise<{
  assignments: Array<{ agentId: string; workspaceId: string }>
  agents: Array<{
    agentId: string
    name: string
    workspace?: { mode: string; gitRepo?: string; gitBranch?: string; branch?: string; agentDir?: string }
  }>
}> {
  const authId = sendFrame(ws, 'auth', { apiKey: token, daemonId: DAEMON, agentVersion: '1.5.0' })
  const ok = await nextFrame(ws, 'auth/ok')
  if (!isFrame('auth/ok')(ok)) throw new Error('expected auth/ok')
  expect(ok.corr).toBe(authId)

  const regId = sendFrame(ws, 'register', {
    host: 'smoke-host',
    capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true },
    maxAgents: 4,
    localState
  })
  const regOk = await nextFrame(ws, 'register/ok')
  if (!isFrame('register/ok')(regOk)) throw new Error('expected register/ok')
  expect(regOk.corr).toBe(regId)
  return regOk.payload
}

describe('Phase 5 — whole-app assembly via buildApp (REST + WS share one DB/orchestrator)', () => {
  it('serves /health 200 from the assembled app', async () => {
    const { app } = await start()
    const res = await app.http.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })

  it('completes a daemon WS handshake over the live http.Server', async () => {
    const { wsUrl, token } = await start()
    const ws = await dial(wsUrl, SUBPROTOCOL)
    try {
      expect(ws.protocol).toBe(SUBPROTOCOL)
      const snap = await handshake(ws, token)
      expect(snap.assignments).toEqual([]) // nothing placed yet
      const row = await prisma.daemon.findUnique({ where: { id: DAEMON } })
      expect(row?.status).toBe('ready')
      expect(row?.sessionEpoch).toBe(1n)
    } finally {
      ws.close()
    }
  })

  it("a REST POST /agents is visible in a later daemon's register/ok reconcile snapshot", async () => {
    const { app, wsUrl, token } = await start()

    // 1. Create an agent placed on THIS daemon, with an inline github workspace,
    //    through the C2 BFF (REST) — same app instance.
    const agentRes = await app.http.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: 'smoke-agent',
        runtime: 'claude',
        daemonId: DAEMON,
        // A host nothing manages: the §6 derivation takes it anonymously with NO
        // preflight, so this assembly smoke test reaches no provider over the network.
        workspace: { mode: 'git', gitRepo: 'https://git.example.test/acme/infra', agentDir: './services/api' }
      }
    })
    expect(agentRes.statusCode).toBe(201)
    const agentId = (agentRes.json() as { id: string }).id

    // 2. Place that REST-created agent on this daemon by writing an active routing
    //    row (the orchestrator's table). The workspace is inline on the agent now,
    //    so the assignment's opaque scope id = the agentId — both through the SAME
    //    shared prisma.
    await prisma.assignment.create({
      data: {
        platform: 'slack',
        channel: '#smoke',
        agentId,
        daemonId: DAEMON,
        workspaceId: agentId,
        assignedEpoch: 1n,
        routingEpoch: 1n,
        state: 'active'
      }
    })

    // 3. Connect a daemon over the LIVE socket. Its register/ok reconcile must
    //    surface the agent the REST POST created — proving the WS reconcile reads
    //    the same Postgres the BFF wrote to (one DB, one orchestrator).
    const ws = await dial(wsUrl, SUBPROTOCOL)
    try {
      const snap = await handshake(ws, token)
      expect(snap.assignments).toHaveLength(1)
      expect(snap.assignments[0]!.agentId).toBe(agentId)
      expect(snap.assignments[0]!.workspaceId).toBe(agentId)
      // The agent roster carries the inline workspace (it rides the reconcile
      // snapshot). This daemon advertises no `workspace-git-v1`, so it arrives on the
      // LEGACY arm — whose gitRepo is host-agnostic, which is why an anonymous
      // workspace on any host rides it unchanged (git-workspace-model.md §8).
      const agentSpec = snap.agents.find((a) => a.agentId === agentId)
      expect(agentSpec?.workspace).toEqual({
        mode: 'github',
        isolation: 'session',
        gitRepo: 'https://git.example.test/acme/infra',
        branch: 'main',
        agentDir: 'services/api',
        additionalRepos: []
      })
    } finally {
      ws.close()
    }
  })
})
