/**
 * Daemon read model — `GET /daemons` live-status overlay + `PATCH /daemons/:id`.
 *
 * The durable `Daemon.status` is a lifecycle marker that is NOT downgraded when a
 * daemon disconnects, so the read model overlays the LIVE connection index: a row
 * with no live connection reads as `offline` even though the DB still says `ready`
 * (the "exited but still shows connected" bug). The route also surfaces the
 * console-assigned `name` and the registered `capabilities`.
 *
 * Driven through `app.inject` (DB-backed, no socket). A daemon row is seeded via
 * the repo's `upsertOnAuth` + `applyRegister` (the same writes the WS handshake
 * performs); liveness is injected as a stub so connect/disconnect is deterministic.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedAgent, seedSessionMeta, seedDaemon as fixtureSeedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { PgDaemonRepo } from '../../src/persistence/repositories/daemon.repo.js'
import { PgDaemonLifecycleOpRepo } from '../../src/persistence/repositories/daemon-lifecycle-op.repo.js'
import { PgRuntimeProfileRepo } from '../../src/persistence/repositories/runtime-profile.repo.js'
import { DaemonRegistryService } from '../../src/registry/registryService.js'
import { systemClock } from '../../src/domain/clock.js'
import { DaemonId, OrgId } from '../../src/domain/ids.js'
import type { DaemonLiveness } from '../../src/ports.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { retryArm } from '../../src/http/routes/daemons.js'
import { DAEMON_BOOTSTRAP_UPGRADE_FEATURE, type DaemonControlAck } from '@agentconnect.md/protocol'

// Console routes are org-scoped: /orgs/:orgId/… (devAuth = seeded owner of the default org).
const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`

const DAEMON = '15606a7a-f103-4b30-9ec7-5823a6bf5c1c'

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
  vi.restoreAllMocks()
})

/** A liveness index backed by a plain map — what the in-memory ConnectionRegistry is, sans
 *  socket. `sessionEpoch` defaults to 1 (seedDaemon's first auth epoch). */
function liveness(
  entries: Record<string, { state: string; reachable: boolean; sessionEpoch?: number }>,
  reconnectForBootstrap?: DaemonLiveness['reconnectForBootstrap']
): DaemonLiveness {
  return {
    get: (id) => {
      const e = entries[id]
      return e ? { state: e.state, reachable: e.reachable, sessionEpoch: e.sessionEpoch ?? 1 } : undefined
    },
    ...(reconnectForBootstrap ? { reconnectForBootstrap } : {})
  }
}

/** Seed a registered daemon row (status `ready`, host + capabilities + version). */
async function seedDaemon(features = ['worktree-iso']) {
  const repo = new PgDaemonRepo(prisma)
  await repo.upsertOnAuth({ daemonId: DaemonId(DAEMON), orgId: OrgId(DEFAULT_ORG_ID), agentVersion: '0.4.2' })
  await repo.applyRegister(
    DaemonId(DAEMON),
    {
      host: 'macbook-pro',
      capabilities: { platforms: ['slack'], runtimes: ['claude', 'codex'], acp: true, features },
      maxAgents: 3
    },
    new Date()
  )
}

type DaemonDto = {
  daemonId: string
  host: string | null
  name: string | null
  agentVersion: string | null
  status: string
  createdAt: string
  createdBy: string | null
  lastModifiedAt: string
  lastModifiedBy: string | null
  capabilities: { platforms: string[]; runtimes: string[]; acp: boolean; features: string[] }
  runtimeProfiles: {
    runtime: string
    version: string
    models: string[]
    contextWindow: number | null
    acpSupport: string
    toolCalling: boolean
    mcpCapabilities: { http: boolean; sse: boolean } | null
    modelCatalog: {
      models: { id: string; efforts?: { value: string; name?: string }[]; defaultEffort?: string; fastMode?: boolean }[]
      defaultModel?: string
      permissionModes?: { value: string; name?: string; description?: string }[]
      source: string
      observedAt: string
    } | null
    modelsSource: string | null
    authRequired: boolean
    observedAt: string | null
  }[]
  mcpServers: {
    name: string
    transport: string
  }[]
  canEdit: boolean
  canManageSharing: boolean
  canManageLifecycle: boolean
}

describe('GET /daemons — live-status overlay', () => {
  it('reads `offline` for a registered daemon with no live connection (the exited-but-connected bug)', async () => {
    await seedDaemon()
    running = buildHttpApp(prisma) // default: empty liveness ⇒ nothing connected
    const rows = (await running.app.inject({ method: 'GET', url: `${ORG}/daemons` })).json() as DaemonDto[]

    const d = rows.find((r) => r.daemonId === DAEMON)
    expect(d).toBeDefined()
    expect(d!.status).toBe('offline') // durable status is still `ready`, but it is not connected
  })

  it('lists an install-wide pool member without granting org-owned mutation access', async () => {
    const poolMember = await new PgDaemonRepo(prisma).resolvePoolClusterIdentity(
      'system:serviceaccount:agentconnect:ac-cloud-daemon',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    )
    running = buildHttpApp(prisma)

    const rows = (await running.app.inject({ method: 'GET', url: `${ORG}/daemons` })).json() as DaemonDto[]
    expect(rows.find((row) => row.daemonId === poolMember.id)).toMatchObject({
      canEdit: false,
      canManageSharing: false,
      canManageLifecycle: false
    })

    const issueKey = await running.app.inject({ method: 'POST', url: `${ORG}/daemons/${poolMember.id}/keys` })
    expect(issueKey.statusCode).toBe(404)
    expect(await prisma.apiKey.count({ where: { daemonId: poolMember.id } })).toBe(0)

    expect(
      (await running.app.inject({ method: 'POST', url: `${ORG}/daemons/${poolMember.id}/restart` })).statusCode
    ).toBe(404)
    expect(
      (await running.app.inject({ method: 'PATCH', url: `${ORG}/daemons/${poolMember.id}`, payload: { name: 'mine' } }))
        .statusCode
    ).toBe(404)
  })

  it('reads `ready` when the daemon is live + reachable, `unreachable` when frozen', async () => {
    await seedDaemon()

    running = buildHttpApp(prisma, undefined, liveness({ [DAEMON]: { state: 'READY', reachable: true } }))
    const online = (await running.app.inject({ method: 'GET', url: `${ORG}/daemons` })).json() as DaemonDto[]
    expect(online.find((r) => r.daemonId === DAEMON)!.status).toBe('ready')
    await running.close()

    running = buildHttpApp(prisma, undefined, liveness({ [DAEMON]: { state: 'READY', reachable: false } }))
    const frozen = (await running.app.inject({ method: 'GET', url: `${ORG}/daemons` })).json() as DaemonDto[]
    expect(frozen.find((r) => r.daemonId === DAEMON)!.status).toBe('unreachable')
  })

  it('reads `connecting` for a disconnected daemon still within the reconnect grace', async () => {
    // A CP restart empties the in-memory liveness index, so every daemon looks
    // disconnected until it re-handshakes. With a grace window configured, a daemon
    // that heartbeated recently reads `connecting` (amber) rather than `offline`.
    await seedDaemon()
    await prisma.daemon.update({ where: { id: DAEMON }, data: { lastSeenAt: new Date() } })

    running = buildHttpApp(prisma, { DAEMON_OFFLINE_GRACE_MS: 45_000 }) // empty liveness
    const rows = (await running.app.inject({ method: 'GET', url: `${ORG}/daemons` })).json() as DaemonDto[]
    expect(rows.find((r) => r.daemonId === DAEMON)!.status).toBe('connecting')
  })

  it('reads `offline` for a disconnected daemon whose last heartbeat is older than the grace', async () => {
    await seedDaemon()
    await prisma.daemon.update({ where: { id: DAEMON }, data: { lastSeenAt: new Date(Date.now() - 10 * 60_000) } })

    running = buildHttpApp(prisma, { DAEMON_OFFLINE_GRACE_MS: 45_000 })
    const rows = (await running.app.inject({ method: 'GET', url: `${ORG}/daemons` })).json() as DaemonDto[]
    expect(rows.find((r) => r.daemonId === DAEMON)!.status).toBe('offline')
  })

  it('never applies the grace to a never-authed provisioned daemon (stays `pending`)', async () => {
    // No auth handshake yet ⇒ status `provisioned`; even a fresh lastSeenAt must not
    // promote it to `connecting` — it has never connected, so `pending` is correct.
    const repo = new PgDaemonRepo(prisma)
    await repo.provision(DaemonId(DAEMON), OrgId(DEFAULT_ORG_ID))
    await prisma.daemon.update({ where: { id: DAEMON }, data: { lastSeenAt: new Date() } })

    running = buildHttpApp(prisma, { DAEMON_OFFLINE_GRACE_MS: 45_000 })
    const rows = (await running.app.inject({ method: 'GET', url: `${ORG}/daemons` })).json() as DaemonDto[]
    expect(rows.find((r) => r.daemonId === DAEMON)!.status).toBe('pending')
  })

  it('surfaces host, version and the registered capabilities', async () => {
    await seedDaemon()
    running = buildHttpApp(prisma)
    const rows = (await running.app.inject({ method: 'GET', url: `${ORG}/daemons` })).json() as DaemonDto[]

    const d = rows.find((r) => r.daemonId === DAEMON)!
    expect(d.host).toBe('macbook-pro')
    expect(d.agentVersion).toBe('0.4.2')
    expect(d.name).toBe('macbook-pro') // seeded from the hostname on first register
    expect(d.createdBy).toBeNull()
    expect(Date.parse(d.createdAt)).not.toBeNaN()
    expect(d.lastModifiedBy).toBeNull()
    expect(Date.parse(d.lastModifiedAt)).not.toBeNaN()

    expect(d.capabilities.runtimes).toEqual(['claude', 'codex'])
    expect(d.capabilities.platforms).toEqual(['slack'])
    expect(d.capabilities.acp).toBe(true)
  })

  it('defaults runtimeProfiles + mcpServers to [] for a daemon that has reported none', async () => {
    await seedDaemon()
    running = buildHttpApp(prisma)
    const rows = (await running.app.inject({ method: 'GET', url: `${ORG}/daemons` })).json() as DaemonDto[]
    const d = rows.find((r) => r.daemonId === DAEMON)!
    expect(d.runtimeProfiles).toEqual([])
    expect(d.mcpServers).toEqual([])
  })

  it('surfaces the observed runtime profiles (the available models per runtime)', async () => {
    await seedDaemon()
    const profiles = new PgRuntimeProfileRepo(prisma)
    await profiles.record(
      DaemonId(DAEMON),
      {
        runtime: 'claude',
        version: '1.4.0',
        models: ['claude-opus-4', 'claude-sonnet-4-5'],
        contextWindow: 200000,
        acpSupport: 'full',
        toolCalling: true
      },
      new Date()
    )
    running = buildHttpApp(prisma)
    const rows = (await running.app.inject({ method: 'GET', url: `${ORG}/daemons` })).json() as DaemonDto[]

    const d = rows.find((r) => r.daemonId === DAEMON)!
    expect(d.runtimeProfiles).toHaveLength(1)
    expect(d.runtimeProfiles[0]!.runtime).toBe('claude')
    expect(d.runtimeProfiles[0]!.models).toEqual(['claude-opus-4', 'claude-sonnet-4-5'])
    expect(d.runtimeProfiles[0]!.acpSupport).toBe('full')
    expect(d.runtimeProfiles[0]!.contextWindow).toBe(200000)
    // Never probed for MCP transports ⇒ explicit null (assume stdio-only), not undefined.
    expect(d.runtimeProfiles[0]!.mcpCapabilities).toBeNull()
    // No catalog reported ⇒ explicit nulls (the console falls back to its static tables).
    expect(d.runtimeProfiles[0]!.modelCatalog).toBeNull()
    expect(d.runtimeProfiles[0]!.modelsSource).toBeNull()
    // No login warning reported ⇒ explicit false (older daemons never send it).
    expect(d.runtimeProfiles[0]!.authRequired).toBe(false)
  })

  it('surfaces the per-runtime authRequired login warning', async () => {
    await seedDaemon()
    await new PgRuntimeProfileRepo(prisma).record(
      DaemonId(DAEMON),
      {
        runtime: 'claude',
        version: '1.4.0',
        models: [],
        acpSupport: 'full',
        toolCalling: true,
        authRequired: true
      },
      new Date()
    )
    running = buildHttpApp(prisma)
    const rows = (await running.app.inject({ method: 'GET', url: `${ORG}/daemons` })).json() as DaemonDto[]
    expect(rows.find((r) => r.daemonId === DAEMON)!.runtimeProfiles[0]!.authRequired).toBe(true)
  })

  it('serves the reported modelCatalog, modelsSource and observedAt per runtime profile', async () => {
    await seedDaemon()
    const catalog = {
      models: [
        { id: 'claude-opus-4', efforts: [{ value: 'high', name: 'High' }], defaultEffort: 'high', fastMode: true },
        { id: 'claude-sonnet-4-5', efforts: [] }
      ],
      defaultModel: 'claude-opus-4',
      permissionModes: [{ value: 'acceptEdits', name: 'Accept edits', description: 'Ask before running commands.' }],
      source: 'acp' as const,
      observedAt: '2026-07-18T00:00:00.000Z'
    }
    const at = new Date('2026-07-18T01:02:03.000Z')
    await new PgRuntimeProfileRepo(prisma).record(
      DaemonId(DAEMON),
      {
        runtime: 'claude',
        version: '1.4.0',
        models: ['claude-opus-4', 'claude-sonnet-4-5'],
        acpSupport: 'full',
        toolCalling: true,
        modelCatalog: catalog,
        modelsSource: 'cached'
      },
      at
    )

    running = buildHttpApp(prisma)
    const res = await running.app.inject({ method: 'GET', url: `${ORG}/daemons` })
    expect(res.statusCode).toBe(200)
    const d = (res.json() as DaemonDto[]).find((r) => r.daemonId === DAEMON)!

    // One shape wire → JSONB → DTO: the catalog comes back verbatim.
    expect(d.runtimeProfiles[0]!.modelCatalog).toEqual(catalog)
    expect(d.runtimeProfiles[0]!.modelsSource).toBe('cached')
    expect(d.runtimeProfiles[0]!.observedAt).toBe(at.toISOString())
  })

  it('surfaces the per-runtime mcpCapabilities and the daemon-level mcpServers list', async () => {
    await seedDaemon()
    const profiles = new PgRuntimeProfileRepo(prisma)
    await profiles.record(
      DaemonId(DAEMON),
      {
        runtime: 'claude',
        version: '1.4.0',
        models: ['claude-opus-4'],
        acpSupport: 'full',
        toolCalling: true,
        mcpCapabilities: { http: true, sse: false }
      },
      new Date()
    )
    await new PgDaemonRepo(prisma).setMcpServers(DaemonId(DAEMON), [
      { name: 'github', transport: 'stdio' },
      { name: 'flaky', transport: 'http' }
    ])

    running = buildHttpApp(prisma)
    const res = await running.app.inject({ method: 'GET', url: `${ORG}/daemons` })
    expect(res.statusCode).toBe(200)
    const d = (res.json() as DaemonDto[]).find((r) => r.daemonId === DAEMON)!

    expect(d.runtimeProfiles[0]!.mcpCapabilities).toEqual({ http: true, sse: false })
    expect(d.mcpServers).toEqual([
      { name: 'github', transport: 'stdio' },
      { name: 'flaky', transport: 'http' }
    ])
  })

  it('serializes an omitted contextWindow as null through the route (not undefined)', async () => {
    // Protocol `contextWindow` is optional (undefined); the DTO is `.nullable()`.
    // Prisma's `Int?` column reads an omitted value back as null — assert that
    // null (never undefined) reaches the route serializer, which would 500 on undefined.
    await seedDaemon()
    const profiles = new PgRuntimeProfileRepo(prisma)
    await profiles.record(
      DaemonId(DAEMON),
      { runtime: 'claude', version: '1.4.0', models: ['claude-opus-4'], acpSupport: 'full', toolCalling: true },
      new Date()
    )
    running = buildHttpApp(prisma)
    const res = await running.app.inject({ method: 'GET', url: `${ORG}/daemons` })
    expect(res.statusCode).toBe(200)
    const rows = res.json() as DaemonDto[]
    expect(rows.find((r) => r.daemonId === DAEMON)!.runtimeProfiles[0]!.contextWindow).toBeNull()
  })

  it('groups runtime profiles per daemon (multiple runtimes on one daemon; no cross-daemon bleed)', async () => {
    const DAEMON_B = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b'
    await seedDaemon() // daemon A
    const repo = new PgDaemonRepo(prisma)
    await repo.upsertOnAuth({ daemonId: DaemonId(DAEMON_B), orgId: OrgId(DEFAULT_ORG_ID), agentVersion: '0.4.2' })

    const profiles = new PgRuntimeProfileRepo(prisma)
    // Two runtimes on A (exercises the byDaemon append branch), one on B.
    await profiles.record(
      DaemonId(DAEMON),
      { runtime: 'claude', version: '1.4.0', models: ['claude-opus-4'], acpSupport: 'full', toolCalling: true },
      new Date()
    )
    await profiles.record(
      DaemonId(DAEMON),
      { runtime: 'codex', version: '0.9.0', models: ['gpt-5'], acpSupport: 'partial', toolCalling: true },
      new Date()
    )
    await profiles.record(
      DaemonId(DAEMON_B),
      { runtime: 'claude', version: '1.4.0', models: ['claude-haiku-4-5'], acpSupport: 'full', toolCalling: true },
      new Date()
    )

    running = buildHttpApp(prisma)
    const rows = (await running.app.inject({ method: 'GET', url: `${ORG}/daemons` })).json() as DaemonDto[]

    const a = rows.find((r) => r.daemonId === DAEMON)!
    expect(a.runtimeProfiles.map((p) => p.runtime)).toEqual(['claude', 'codex']) // ordered by runtime
    expect(a.runtimeProfiles.find((p) => p.runtime === 'codex')!.models).toEqual(['gpt-5'])

    const b = rows.find((r) => r.daemonId === DAEMON_B)!
    expect(b.runtimeProfiles).toHaveLength(1) // only its own — no bleed from A
    expect(b.runtimeProfiles[0]!.models).toEqual(['claude-haiku-4-5'])
  })
})

describe('PATCH /daemons/:id — rename', () => {
  it('assigns a display name and persists it, stamping the last-modified audit', async () => {
    await seedDaemon()
    running = buildHttpApp(prisma)

    // Seeded (system) daemon: no human has touched it yet.
    const before = await prisma.daemon.findUnique({ where: { id: DAEMON } })
    expect(before?.lastModifiedByUserId).toBeNull()

    // Bracket the rename with a same-process (Node) timestamp: the repo stamps
    // lastModifiedAt with `new Date()` in THIS process, so `>= t0` proves a fresh
    // re-stamp without comparing across the Node vs Postgres clocks (the seeded
    // `before` value lives on the DB/container clock).
    const t0 = Date.now()
    const res = await running.app.inject({
      method: 'PATCH',
      url: `${ORG}/daemons/${DAEMON}`,
      payload: { name: 'draco-mbp' }
    })
    expect(res.statusCode).toBe(200)
    const renamed = res.json() as DaemonDto
    expect(renamed.name).toBe('draco-mbp')
    expect(renamed.lastModifiedBy).toBeTruthy()
    expect(Date.parse(renamed.lastModifiedAt)).not.toBeNaN()

    const rows = (await running.app.inject({ method: 'GET', url: `${ORG}/daemons` })).json() as DaemonDto[]
    expect(rows.find((r) => r.daemonId === DAEMON)!.name).toBe('draco-mbp')

    // The rename is a human edit → last-modified now points at the devAuth owner
    // and is re-stamped at edit time.
    const after = await prisma.daemon.findUnique({ where: { id: DAEMON } })
    expect(after?.lastModifiedByUserId).toBeTruthy()
    expect(after!.lastModifiedAt.getTime()).toBeGreaterThanOrEqual(t0) // re-stamped at edit time
  })

  it('404s for an unknown daemon id', async () => {
    running = buildHttpApp(prisma)
    const res = await running.app.inject({
      method: 'PATCH',
      url: `${ORG}/daemons/00000000-0000-4000-8000-000000000000`,
      payload: { name: 'ghost' }
    })
    expect(res.statusCode).toBe(404)
  })

  it('400s on an empty name', async () => {
    await seedDaemon()
    running = buildHttpApp(prisma)
    const res = await running.app.inject({ method: 'PATCH', url: `${ORG}/daemons/${DAEMON}`, payload: { name: '   ' } })
    expect(res.statusCode).toBe(400)
  })

  it('400s on an empty body (nothing to update)', async () => {
    await seedDaemon()
    running = buildHttpApp(prisma)
    const res = await running.app.inject({ method: 'PATCH', url: `${ORG}/daemons/${DAEMON}`, payload: {} })
    expect(res.statusCode).toBe(400)
  })

  it('persists sessionRetention and hot-pushes it to the connected daemon (config/push)', async () => {
    await seedDaemon()
    const pushes: { id: string; keys: Record<string, unknown> }[] = []
    const control = {
      configPush: (id: string, keys: Record<string, unknown>) => {
        pushes.push({ id, keys })
      }
    } as unknown as ControlSender
    running = buildHttpApp(prisma, undefined, liveness({ [DAEMON]: { state: 'READY', reachable: true } }), control)

    const res = await running.app.inject({
      method: 'PATCH',
      url: `${ORG}/daemons/${DAEMON}`,
      payload: { sessionRetention: '90d' }
    })
    expect(res.statusCode).toBe(200)
    const updated = res.json() as DaemonDto & { sessionRetention: string }
    expect(updated.sessionRetention).toBe('90d')
    // A retention change is a human edit — the last-modified audit advances.
    expect(updated.lastModifiedBy).toBeTruthy()

    // Durable (the register/ok baseline reads this column) + hot-pushed.
    const row = await prisma.daemon.findUnique({ where: { id: DAEMON } })
    expect(row?.sessionRetention).toBe('90d')
    expect(pushes).toEqual([{ id: DAEMON, keys: { 'sessions.retention': '90d' } }])
  })

  it('still 200s a retention change when the daemon is offline (push is best-effort)', async () => {
    await seedDaemon()
    running = buildHttpApp(prisma) // empty liveness ⇒ configPush throws NoConnection internally
    const res = await running.app.inject({
      method: 'PATCH',
      url: `${ORG}/daemons/${DAEMON}`,
      payload: { sessionRetention: 'never' }
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { sessionRetention: string }).sessionRetention).toBe('never')
  })

  it("accepts any '<n>d' day count as a retention window", async () => {
    await seedDaemon()
    running = buildHttpApp(prisma)
    const res = await running.app.inject({
      method: 'PATCH',
      url: `${ORG}/daemons/${DAEMON}`,
      payload: { sessionRetention: '3d' }
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { sessionRetention: string }).sessionRetention).toBe('3d')
  })

  it('400s a malformed retention window', async () => {
    await seedDaemon()
    running = buildHttpApp(prisma)
    for (const bad of ['0d', '7', '2weeks', 'always']) {
      const res = await running.app.inject({
        method: 'PATCH',
        url: `${ORG}/daemons/${DAEMON}`,
        payload: { sessionRetention: bad }
      })
      expect(res.statusCode, bad).toBe(400)
    }
  })
})

describe('DELETE /daemons/:id — remove from fleet', () => {
  it('removes an offline daemon (no live connection) → 204, gone from the read model', async () => {
    await seedDaemon()
    running = buildHttpApp(prisma) // empty liveness ⇒ offline

    const res = await running.app.inject({ method: 'DELETE', url: `${ORG}/daemons/${DAEMON}` })
    expect(res.statusCode).toBe(204)

    const rows = (await running.app.inject({ method: 'GET', url: `${ORG}/daemons` })).json() as DaemonDto[]
    expect(rows.find((r) => r.daemonId === DAEMON)).toBeUndefined()
  })

  it('cascades the daemon’s API keys (no orphaned credentials)', async () => {
    await seedDaemon()
    await prisma.apiKey.create({
      data: {
        principalType: 'daemon',
        orgId: DEFAULT_ORG_ID,
        daemonId: DAEMON,
        hash: `delete-test-${DAEMON}`,
        displayTail: '…a2b1'
      }
    })
    running = buildHttpApp(prisma)

    const res = await running.app.inject({ method: 'DELETE', url: `${ORG}/daemons/${DAEMON}` })
    expect(res.statusCode).toBe(204)
    expect(await prisma.apiKey.count({ where: { daemonId: DAEMON } })).toBe(0)
  })

  it('re-converges the unplaced agents’ hook rules (pool eviction, not daemon_offline limbo)', async () => {
    // An agent placed on the daemon with a github hook: deleting the daemon
    // SetNulls the placement, so the hook must leave the relay pool NOW —
    // compile() of an unplaced hook is null ⇒ broadcast() converges to remove.
    await seedDaemon()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    await prisma.hookDef.create({
      data: {
        id: randomUUID(),
        orgId: DEFAULT_ORG_ID,
        agentId,
        kind: 'github',
        name: 'gh-evict',
        sessionMode: 'perThread',
        repoId: 987654321,
        repoFullName: 'acme/infra',
        events: ['issues:*'],
        labelFilter: [],
        targetPlatform: 'slack'
      }
    })
    running = buildHttpApp(prisma)
    const removeSpy = vi.spyOn(running.deps.relayControl, 'hookRemove')

    const res = await running.app.inject({ method: 'DELETE', url: `${ORG}/daemons/${DAEMON}` })
    expect(res.statusCode).toBe(204)
    // The re-converge is fire-and-forget — wait for the eviction broadcast.
    await vi.waitFor(() => expect(removeSpy).toHaveBeenCalled())
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).daemonId).toBeNull()
  })

  it('marks the daemon’s agents inactive (the FK SetNull alone leaves a stale “active”)', async () => {
    // `daemonId` and `status` must agree: unplaced ⇒ inactive. The FK's SetNull only
    // clears the placement, so the route unplaces through the repo first — otherwise a
    // deleted daemon leaves `daemonId: null, status: 'active'` and every reader (console
    // badge, the `status === 'active'` routing gates) treats the agent as runnable.
    await seedDaemon()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    await prisma.agent.update({ where: { id: agentId }, data: { status: 'active' } })
    running = buildHttpApp(prisma)

    expect((await running.app.inject({ method: 'DELETE', url: `${ORG}/daemons/${DAEMON}` })).statusCode).toBe(204)
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })
    expect({ daemonId: agent.daemonId, status: agent.status }).toEqual({ daemonId: null, status: 'inactive' })
  })

  it('re-broadcasts the collaboration snapshot (its agents just left the peer directory)', async () => {
    // `Agent.daemonId` is SetNull, so the daemon's agents become UNPLACED and
    // `buildCollabSnapshot` drops them — but only for holders that receive a new snapshot.
    // Without this push every relay + remaining daemon keeps flat `agents[]` entries naming
    // the dead daemonId, and `admits()` keeps admitting wakes nothing can deliver.
    await seedDaemon()
    await seedAgent(prisma, randomUUID(), { daemonId: DAEMON })
    running = buildHttpApp(prisma)
    const collabSpy = vi.spyOn(running.deps.collabRoutes, 'broadcast')

    const res = await running.app.inject({ method: 'DELETE', url: `${ORG}/daemons/${DAEMON}` })
    expect(res.statusCode).toBe(204)
    expect(collabSpy).toHaveBeenCalledWith(DEFAULT_ORG_ID)
  })

  it('pushes NO collaboration snapshot when the daemon hosted no agents', async () => {
    await seedDaemon()
    running = buildHttpApp(prisma)
    const collabSpy = vi.spyOn(running.deps.collabRoutes, 'broadcast')

    expect((await running.app.inject({ method: 'DELETE', url: `${ORG}/daemons/${DAEMON}` })).statusCode).toBe(204)
    expect(collabSpy).not.toHaveBeenCalled() // nothing left the directory ⇒ no routingEpoch churn
  })

  it('refuses (409) while the daemon is live + reachable', async () => {
    await seedDaemon()
    running = buildHttpApp(prisma, undefined, liveness({ [DAEMON]: { state: 'READY', reachable: true } }))

    const res = await running.app.inject({ method: 'DELETE', url: `${ORG}/daemons/${DAEMON}` })
    expect(res.statusCode).toBe(409)

    const rows = (await running.app.inject({ method: 'GET', url: `${ORG}/daemons` })).json() as DaemonDto[]
    expect(rows.find((r) => r.daemonId === DAEMON)).toBeDefined() // not deleted
  })

  it('allows delete of a frozen (unreachable) daemon', async () => {
    await seedDaemon()
    running = buildHttpApp(prisma, undefined, liveness({ [DAEMON]: { state: 'READY', reachable: false } }))
    const res = await running.app.inject({ method: 'DELETE', url: `${ORG}/daemons/${DAEMON}` })
    expect(res.statusCode).toBe(204)
  })

  it('404s for an unknown daemon id', async () => {
    running = buildHttpApp(prisma)
    const res = await running.app.inject({
      method: 'DELETE',
      url: `${ORG}/daemons/00000000-0000-4000-8000-000000000000`
    })
    expect(res.statusCode).toBe(404)
  })
})

// ── CP-commanded restart/upgrade (cli-daemon-split.md §7) ────────────────────

type LifecycleOp = { id: string; op: string; status: string; targetVersion: string | null; outcome: string | null }

const future = () => new Date(Date.now() + 60_000)

const LIVE = liveness({ [DAEMON]: { state: 'READY', reachable: true } })

/** A ControlSender spy recording the lifecycle frames it would send and returning an `acked`
 *  outcome + the epoch it "sent" on (seedDaemon authed at epoch 1). */
function controlSpy(ack: DaemonControlAck, epoch = 1) {
  const calls: { method: string; id: string; payload: unknown }[] = []
  const spy = {
    daemonUpgrade: async (id: string, payload: unknown) => {
      calls.push({ method: 'upgrade', id, payload })
      return { kind: 'acked' as const, epoch, ack }
    },
    daemonRestart: async (id: string, payload: unknown) => {
      calls.push({ method: 'restart', id, payload })
      return { kind: 'acked' as const, epoch, ack }
    }
  }
  return { spy: spy as unknown as ControlSender, calls }
}

describe('POST /daemons/:id/upgrade', () => {
  it('opens a pending upgrade op and sends daemon/upgrade → 202; the read model shows pendingOp', async () => {
    await seedDaemon()
    const { spy, calls } = controlSpy({ accepted: true, willDrainUntil: new Date().toISOString() })
    running = buildHttpApp(prisma, undefined, LIVE, spy)

    const res = await running.app.inject({
      method: 'POST',
      url: `${ORG}/daemons/${DAEMON}/upgrade`,
      payload: { version: '0.5.0' }
    })
    expect(res.statusCode).toBe(202)
    expect(calls).toEqual([{ method: 'upgrade', id: DAEMON, payload: { targetVersion: '0.5.0', drainFirst: true } }])
    // The 202 returns the opened op (with its id) so the console can track it.
    const opened = res.json() as { id: string; op: string; status: string; targetVersion: string | null }
    expect(opened).toMatchObject({ op: 'upgrade', status: 'pending', targetVersion: '0.5.0' })
    expect(opened.id).toBeTruthy()

    const rows = (await running.app.inject({ method: 'GET', url: `${ORG}/daemons` })).json() as (DaemonDto & {
      lifecycleOp: LifecycleOp | null
    })[]
    const row = rows.find((r) => r.daemonId === DAEMON)!
    expect(row.lifecycleOp).toMatchObject({ id: opened.id, op: 'upgrade', status: 'pending', targetVersion: '0.5.0' })
  })

  it('503s when the daemon is not reachable (no op opened)', async () => {
    await seedDaemon()
    const { spy, calls } = controlSpy({ accepted: true })
    running = buildHttpApp(prisma, undefined, liveness({ [DAEMON]: { state: 'READY', reachable: false } }), spy)
    const res = await running.app.inject({
      method: 'POST',
      url: `${ORG}/daemons/${DAEMON}/upgrade`,
      payload: { version: '0.5.0' }
    })
    expect(res.statusCode).toBe(503)
    expect(calls).toHaveLength(0)
    expect(await new PgDaemonLifecycleOpRepo(prisma).pendingForDaemon(DaemonId(DAEMON))).toBeNull()
  })

  it('queues an upgrade without sending control when the offline daemon supports bootstrap recovery', async () => {
    await seedDaemon(['worktree-iso', DAEMON_BOOTSTRAP_UPGRADE_FEATURE])
    const { spy, calls } = controlSpy({ accepted: true })
    running = buildHttpApp(prisma, undefined, liveness({}), spy)
    const res = await running.app.inject({
      method: 'POST',
      url: `${ORG}/daemons/${DAEMON}/upgrade`,
      payload: { version: '0.5.0' }
    })
    expect(res.statusCode).toBe(202)
    expect(calls).toHaveLength(0)
    const op = await new PgDaemonLifecycleOpRepo(prisma).pendingForDaemon(DaemonId(DAEMON))
    expect(op).toMatchObject({ op: 'upgrade', targetVersion: '0.5.0', acceptedAt: null })
  })

  it('reconnects a registering daemon after enqueue so auth cannot miss the upgrade', async () => {
    await seedDaemon(['worktree-iso', DAEMON_BOOTSTRAP_UPGRADE_FEATURE])
    const reconnect = vi.fn(() => true)
    const { spy, calls } = controlSpy({ accepted: true })
    running = buildHttpApp(
      prisma,
      undefined,
      liveness({ [DAEMON]: { state: 'REGISTERING', reachable: true } }, reconnect),
      spy
    )
    const res = await running.app.inject({
      method: 'POST',
      url: `${ORG}/daemons/${DAEMON}/upgrade`,
      payload: { version: '0.5.0' }
    })
    expect(res.statusCode).toBe(202)
    expect(calls).toHaveLength(0)
    expect(reconnect).toHaveBeenCalledWith(DAEMON, 1)
  })

  it('409s a second command while one is already in flight', async () => {
    await seedDaemon()
    const { spy } = controlSpy({ accepted: true, willDrainUntil: new Date().toISOString() })
    running = buildHttpApp(prisma, undefined, LIVE, spy)
    const first = await running.app.inject({
      method: 'POST',
      url: `${ORG}/daemons/${DAEMON}/upgrade`,
      payload: { version: '0.5.0' }
    })
    expect(first.statusCode).toBe(202)
    const second = await running.app.inject({
      method: 'POST',
      url: `${ORG}/daemons/${DAEMON}/restart`
    })
    expect(second.statusCode).toBe(409)
  })

  it('closes the op failed and 409s when the daemon declines (accepted:false)', async () => {
    await seedDaemon()
    const { spy } = controlSpy({ accepted: false, reason: 'no supervisor configured' })
    running = buildHttpApp(prisma, undefined, LIVE, spy)
    const res = await running.app.inject({
      method: 'POST',
      url: `${ORG}/daemons/${DAEMON}/upgrade`,
      payload: { version: '0.5.0' }
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().message).toContain('no supervisor')
    // The op was opened then failed — nothing is left pending (a retry is allowed).
    expect(await new PgDaemonLifecycleOpRepo(prisma).pendingForDaemon(DaemonId(DAEMON))).toBeNull()
  })

  it('expires a stuck overdue op and lets a new command through (no permanent 409)', async () => {
    // A prior op the daemon accepted but never re-registered for: still `pending` in the
    // DB with a lapsed deadline. Without clock-driven expiry it would 409 every command
    // forever (the partial unique index reserves the daemon).
    await seedDaemon()
    const ops = new PgDaemonLifecycleOpRepo(prisma)
    const stuck = await ops.open({
      daemonId: DaemonId(DAEMON),
      op: 'upgrade',
      targetVersion: '0.5.0',
      commandEpoch: 1n,
      deadline: new Date(Date.now() - 1_000)
    })
    const { spy } = controlSpy({ accepted: true, willDrainUntil: new Date().toISOString() })
    running = buildHttpApp(prisma, undefined, LIVE, spy)
    const res = await running.app.inject({
      method: 'POST',
      url: `${ORG}/daemons/${DAEMON}/upgrade`,
      payload: { version: '0.6.0' }
    })
    expect(res.statusCode).toBe(202) // the stuck op was expired, so the new one opens
    const latest = await ops.latestForDaemon(DaemonId(DAEMON))
    expect(latest?.targetVersion).toBe('0.6.0') // the NEW op is now latest + pending
    expect(latest?.status).toBe('pending')
    expect((await ops.pendingForDaemon(DaemonId(DAEMON)))?.id).not.toBe(stuck.id)
  })
})

describe('POST /daemons/:id/restart', () => {
  it('sends daemon/restart → 202 and opens a pending restart op', async () => {
    await seedDaemon()
    const { spy, calls } = controlSpy({ accepted: true, willDrainUntil: new Date().toISOString() })
    running = buildHttpApp(prisma, undefined, LIVE, spy)
    const res = await running.app.inject({ method: 'POST', url: `${ORG}/daemons/${DAEMON}/restart` })
    expect(res.statusCode).toBe(202)
    expect(calls[0]!.method).toBe('restart')
    const op = await new PgDaemonLifecycleOpRepo(prisma).pendingForDaemon(DaemonId(DAEMON))
    expect(op?.op).toBe('restart')
    expect(op?.targetVersion).toBeNull()
  })

  it('settles immediately when the daemon reaches READY during the ACK (fast restart)', async () => {
    await seedDaemon() // epoch 1
    // Spy: the daemon drains, relaunches, and re-registers (epoch bump) BEFORE the restart
    // ACK returns — the fast-restart race. The route arms the op then re-checks, so the
    // already-completed restart is recognized and the 202 body is already `succeeded`.
    const spy = {
      daemonRestart: async () => {
        await new PgDaemonRepo(prisma).upsertOnAuth({
          daemonId: DaemonId(DAEMON),
          orgId: OrgId(DEFAULT_ORG_ID),
          agentVersion: '0.4.2'
        }) // epoch 2 — re-registered during the ACK
        return { kind: 'acked' as const, epoch: 1, ack: { accepted: true } } // the command rode epoch 1
      }
    } as unknown as ControlSender
    running = buildHttpApp(prisma, undefined, LIVE, spy)
    const res = await running.app.inject({ method: 'POST', url: `${ORG}/daemons/${DAEMON}/restart` })
    expect(res.statusCode).toBe(202)
    expect((res.json() as LifecycleOp).status).toBe('succeeded')
    expect(await new PgDaemonLifecycleOpRepo(prisma).pendingForDaemon(DaemonId(DAEMON))).toBeNull()
  })
})

describe('lifecycle command delivery edge cases', () => {
  it('503s when the daemon is reachable but not yet READY (reconnecting) — no frame, no op', async () => {
    await seedDaemon()
    const { spy, calls } = controlSpy({ accepted: true })
    running = buildHttpApp(prisma, undefined, liveness({ [DAEMON]: { state: 'AUTHENTICATING', reachable: true } }), spy)
    const res = await running.app.inject({ method: 'POST', url: `${ORG}/daemons/${DAEMON}/restart` })
    expect(res.statusCode).toBe(503)
    expect(calls).toHaveLength(0)
    expect(await new PgDaemonLifecycleOpRepo(prisma).pendingForDaemon(DaemonId(DAEMON))).toBeNull()
  })

  it('fails the op + 503 on a pre-dispatch unsent outcome (definitely not delivered)', async () => {
    await seedDaemon()
    const spy = {
      daemonRestart: async () => ({ kind: 'unsent' as const })
    } as unknown as ControlSender
    running = buildHttpApp(prisma, undefined, LIVE, spy)
    const res = await running.app.inject({ method: 'POST', url: `${ORG}/daemons/${DAEMON}/restart` })
    expect(res.statusCode).toBe(503)
    const ops = new PgDaemonLifecycleOpRepo(prisma)
    expect(await ops.pendingForDaemon(DaemonId(DAEMON))).toBeNull()
    expect((await ops.latestForDaemon(DaemonId(DAEMON)))?.status).toBe('failed')
  })

  it('fails the op + 409 on a definite negative reply (correlated protocol rejection)', async () => {
    await seedDaemon()
    const spy = {
      daemonRestart: async () => ({ kind: 'rejected' as const, epoch: 1, code: 'PROTOCOL_STATE', message: 'not READY' })
    } as unknown as ControlSender
    running = buildHttpApp(prisma, undefined, LIVE, spy)
    const res = await running.app.inject({ method: 'POST', url: `${ORG}/daemons/${DAEMON}/restart` })
    expect(res.statusCode).toBe(409)
    expect(res.json().message).toContain('PROTOCOL_STATE')
    // A definite rejection is terminal-failed (NOT left resolvable) — it never ran.
    const ops = new PgDaemonLifecycleOpRepo(prisma)
    expect(await ops.pendingForDaemon(DaemonId(DAEMON))).toBeNull()
    expect((await ops.latestForDaemon(DaemonId(DAEMON)))?.status).toBe('failed')
  })

  it('leaves the op pending + armed (202) on an ambiguous post-dispatch loss, then settles on READY', async () => {
    await seedDaemon() // epoch 1
    // The ACK never arrives (timeout / socket closed after the frame was queued) — the
    // daemon may already be draining, so the route must NOT terminal-fail the op.
    const spy = {
      daemonRestart: async () => ({ kind: 'ambiguous' as const, epoch: 1, message: 'request timed out' })
    } as unknown as ControlSender
    running = buildHttpApp(prisma, undefined, LIVE, spy)
    const res = await running.app.inject({ method: 'POST', url: `${ORG}/daemons/${DAEMON}/restart` })
    expect(res.statusCode).toBe(202)
    const ops = new PgDaemonLifecycleOpRepo(prisma)
    const pend = await ops.pendingForDaemon(DaemonId(DAEMON))
    expect(pend?.status).toBe('pending')
    expect(pend?.acceptedAt).not.toBeNull() // armed with the attempted epoch (1)

    // The command HAD landed: the daemon drains, relaunches, re-auths (epoch 2), registers.
    await new PgDaemonRepo(prisma).upsertOnAuth({
      daemonId: DaemonId(DAEMON),
      orgId: OrgId(DEFAULT_ORG_ID),
      agentVersion: '0.4.2'
    })
    await new DaemonRegistryService(
      new PgDaemonRepo(prisma),
      new PgRuntimeProfileRepo(prisma),
      ops,
      systemClock
    ).settleLifecycleOpOnReady(DaemonId(DAEMON))
    expect((await ops.latestForDaemon(DaemonId(DAEMON)))?.status).toBe('succeeded')
  })

  it('502s when the daemon accepted but the arm write can’t be persisted (no false-timeout 202)', async () => {
    await seedDaemon()
    const { spy } = controlSpy({ accepted: true })
    running = buildHttpApp(prisma, undefined, LIVE, spy)
    vi.spyOn(running.deps.repos.daemonLifecycleOp, 'markAccepted').mockRejectedValue(new Error('db down'))
    const res = await running.app.inject({ method: 'POST', url: `${ORG}/daemons/${DAEMON}/restart` })
    expect(res.statusCode).toBe(502)
  })

  it('recovers from a one-shot arm-write failure via retry → armed + 202', async () => {
    await seedDaemon()
    const { spy } = controlSpy({ accepted: true })
    running = buildHttpApp(prisma, undefined, LIVE, spy)
    const repo = running.deps.repos.daemonLifecycleOp
    const real = repo.markAccepted.bind(repo)
    vi.spyOn(repo, 'markAccepted').mockRejectedValueOnce(new Error('transient')).mockImplementation(real)
    const res = await running.app.inject({ method: 'POST', url: `${ORG}/daemons/${DAEMON}/restart` })
    expect(res.statusCode).toBe(202)
    const op = await new PgDaemonLifecycleOpRepo(prisma).pendingForDaemon(DaemonId(DAEMON))
    expect(op?.acceptedAt).not.toBeNull() // armed on the retry
  })

  it('background retryArm recovers an exhausted arm write, then settles the already-observed READY', async () => {
    // Models the 502 path: the daemon accepted, in-request arming exhausted, and the daemon
    // has ALREADY relaunched (epoch 2 — a READY the still-unarmed op ignored). Background
    // recovery must arm and then settle it succeeded, so it never falsely times out.
    await seedDaemon() // epoch 1
    const ops = new PgDaemonLifecycleOpRepo(prisma)
    const op = await ops.open({ daemonId: DaemonId(DAEMON), op: 'restart', commandEpoch: 1n, deadline: future() })
    await new PgDaemonRepo(prisma).upsertOnAuth({
      daemonId: DaemonId(DAEMON),
      orgId: OrgId(DEFAULT_ORG_ID),
      agentVersion: '0.4.2'
    }) // epoch 2
    const registry = new DaemonRegistryService(
      new PgDaemonRepo(prisma),
      new PgRuntimeProfileRepo(prisma),
      ops,
      systemClock
    )
    const real = ops.markAccepted.bind(ops)
    vi.spyOn(ops, 'markAccepted').mockRejectedValueOnce(new Error('db blip')).mockImplementation(real)
    const ok = await retryArm(ops, registry, op.id, DAEMON, 1n, [0, 0]) // zero delays for the test
    expect(ok).toBe(true)
    expect(await ops.pendingForDaemon(DaemonId(DAEMON))).toBeNull()
    expect((await ops.latestForDaemon(DaemonId(DAEMON)))?.status).toBe('succeeded')
  })

  it('retryArm retries when the READY closure itself throws (not just the arm write)', async () => {
    // The op is armed but the settle read/write throws transiently. Since the fast-restart
    // READY may be the only trigger, retryArm must NOT report success until the settle
    // completes — it retries the whole (idempotent) arm+settle step.
    await seedDaemon() // epoch 1
    const ops = new PgDaemonLifecycleOpRepo(prisma)
    const op = await ops.open({ daemonId: DaemonId(DAEMON), op: 'restart', commandEpoch: 1n, deadline: future() })
    await new PgDaemonRepo(prisma).upsertOnAuth({
      daemonId: DaemonId(DAEMON),
      orgId: OrgId(DEFAULT_ORG_ID),
      agentVersion: '0.4.2'
    }) // epoch 2 — a READY already observed
    const registry = new DaemonRegistryService(
      new PgDaemonRepo(prisma),
      new PgRuntimeProfileRepo(prisma),
      ops,
      systemClock
    )
    const realSettle = registry.settleLifecycleOpOnReady.bind(registry)
    vi.spyOn(registry, 'settleLifecycleOpOnReady')
      .mockRejectedValueOnce(new Error('read blip'))
      .mockImplementation(realSettle)
    const ok = await retryArm(ops, registry, op.id, DAEMON, 1n, [0, 0])
    expect(ok).toBe(true) // reported only after the settle completed on the retry
    expect((await ops.latestForDaemon(DaemonId(DAEMON)))?.status).toBe('succeeded')
  })
})

describe('GET /daemons/:id/lifecycle/:opId', () => {
  it('returns the op by id even after a newer op becomes the daemon’s latest', async () => {
    await seedDaemon()
    const ops = new PgDaemonLifecycleOpRepo(prisma)
    const a = await ops.open({ daemonId: DaemonId(DAEMON), op: 'restart', commandEpoch: 1n, deadline: future() })
    await ops.settle(a.id, 'succeeded', null, new Date())
    const b = await ops.open({
      daemonId: DaemonId(DAEMON),
      op: 'upgrade',
      targetVersion: '0.5.0',
      commandEpoch: 1n,
      deadline: future()
    })
    running = buildHttpApp(prisma)
    expect((await ops.latestForDaemon(DaemonId(DAEMON)))?.id).toBe(b.id) // b is the fleet's latest slot
    // The console still resolves op A by id — its polling doesn't break when B appears.
    const res = await running.app.inject({ method: 'GET', url: `${ORG}/daemons/${DAEMON}/lifecycle/${a.id}` })
    expect(res.statusCode).toBe(200)
    expect(res.json() as LifecycleOp).toMatchObject({ id: a.id, status: 'succeeded' })
  })

  it('projects an overdue pending op as failed (timed out), and 404s an unknown id', async () => {
    await seedDaemon()
    const ops = new PgDaemonLifecycleOpRepo(prisma)
    const a = await ops.open({
      daemonId: DaemonId(DAEMON),
      op: 'restart',
      commandEpoch: 1n,
      deadline: new Date(Date.now() - 1_000)
    })
    running = buildHttpApp(prisma)
    const res = await running.app.inject({ method: 'GET', url: `${ORG}/daemons/${DAEMON}/lifecycle/${a.id}` })
    expect((res.json() as LifecycleOp).status).toBe('failed')
    expect((res.json() as LifecycleOp).outcome).toContain('timed out')
    const miss = await running.app.inject({ method: 'GET', url: `${ORG}/daemons/${DAEMON}/lifecycle/does-not-exist` })
    expect(miss.statusCode).toBe(404)
  })
})

describe('lifecycle op closure on register→READY', () => {
  const REG = {
    host: 'macbook-pro',
    capabilities: { platforms: [] as never[], runtimes: [] as string[], acp: true, features: [] as string[] },
    maxAgents: 3,
    localState: { assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }
  }
  const makeRegistry = (ops: PgDaemonLifecycleOpRepo) =>
    new DaemonRegistryService(new PgDaemonRepo(prisma), new PgRuntimeProfileRepo(prisma), ops, systemClock)
  // Re-auth the daemon (drain+relaunch → fresh connection → epoch bump), returning the new epoch.
  const reauth = async (agentVersion: string) =>
    (
      await new PgDaemonRepo(prisma).upsertOnAuth({
        daemonId: DaemonId(DAEMON),
        orgId: OrgId(DEFAULT_ORG_ID),
        agentVersion
      })
    ).sessionEpoch

  it('does NOT settle on upsertOnRegister alone — only the post-reconcile READY step settles', async () => {
    // The register handler persists the register (upsertOnRegister) BEFORE reconcile, and
    // only calls settleLifecycleOpOnReady after reconcile succeeds. So a reconcile that
    // throws (never reaching the READY step) must leave the op pending.
    await seedDaemon()
    const ops = new PgDaemonLifecycleOpRepo(prisma)
    const op = await ops.open({ daemonId: DaemonId(DAEMON), op: 'restart', commandEpoch: 1n, deadline: future() })
    await ops.markAccepted(op.id, new Date(), 1n)
    await makeRegistry(ops).upsertOnRegister(DaemonId(DAEMON), REG)
    expect((await ops.pendingForDaemon(DaemonId(DAEMON)))?.op).toBe('restart') // still pending
  })

  it('does NOT settle before the op is armed — a READY between open() and the ACK is ignored', async () => {
    // The row is opened before the daemon ACKs acceptance. A reconnect reaching READY in
    // that window (higher epoch) must NOT settle it (the ACK may still decline).
    await seedDaemon() // epoch 1
    const ops = new PgDaemonLifecycleOpRepo(prisma)
    const op = await ops.open({ daemonId: DaemonId(DAEMON), op: 'restart', commandEpoch: 1n, deadline: future() })
    await reauth('0.4.2') // epoch 2 — a reconnect before the ACK
    const registry = makeRegistry(ops)
    await registry.settleLifecycleOpOnReady(DaemonId(DAEMON))
    expect((await ops.pendingForDaemon(DaemonId(DAEMON)))?.id).toBe(op.id) // NOT armed ⇒ still pending

    // Now arm (the ACK returned) + re-check → the already-observed higher-epoch READY settles it.
    await ops.markAccepted(op.id, new Date(), 1n)
    await registry.settleLifecycleOpOnReady(DaemonId(DAEMON))
    expect(await ops.pendingForDaemon(DaemonId(DAEMON))).toBeNull()
    expect((await ops.latestForDaemon(DaemonId(DAEMON)))?.status).toBe('succeeded')
  })

  it('does NOT settle on a same-epoch READY (a duplicate register is not a relaunch)', async () => {
    await seedDaemon() // epoch 1
    const ops = new PgDaemonLifecycleOpRepo(prisma)
    const op = await ops.open({ daemonId: DaemonId(DAEMON), op: 'restart', commandEpoch: 1n, deadline: future() })
    await ops.markAccepted(op.id, new Date(), 1n) // armed, but the daemon has NOT re-authed
    await makeRegistry(ops).settleLifecycleOpOnReady(DaemonId(DAEMON))
    expect((await ops.pendingForDaemon(DaemonId(DAEMON)))?.id).toBe(op.id) // epoch unchanged ⇒ still pending
  })

  it('closes a pending upgrade succeeded once the daemon reaches READY on the target version', async () => {
    await seedDaemon() // epoch 1, agentVersion 0.4.2
    const ops = new PgDaemonLifecycleOpRepo(prisma)
    const op = await ops.open({
      daemonId: DaemonId(DAEMON),
      op: 'upgrade',
      targetVersion: '0.5.0',
      commandEpoch: 1n,
      deadline: future()
    })
    await ops.markAccepted(op.id, new Date(), 1n)
    const registry = makeRegistry(ops)
    // Re-auth on the OLD version (a failed install / prior-bundle relaunch) keeps it pending.
    await reauth('0.4.2') // epoch 2
    await registry.settleLifecycleOpOnReady(DaemonId(DAEMON))
    expect((await ops.pendingForDaemon(DaemonId(DAEMON)))?.op).toBe('upgrade')

    // Re-auth onto the target → closed succeeded (no longer pending).
    await reauth('0.5.0') // epoch 3
    await registry.settleLifecycleOpOnReady(DaemonId(DAEMON))
    expect(await ops.pendingForDaemon(DaemonId(DAEMON))).toBeNull()
    expect((await ops.latestForDaemon(DaemonId(DAEMON)))?.status).toBe('succeeded')
  })

  it('fails a pending op whose deadline has already lapsed when the daemon reaches READY', async () => {
    await seedDaemon()
    const ops = new PgDaemonLifecycleOpRepo(prisma)
    const op = await ops.open({
      daemonId: DaemonId(DAEMON),
      op: 'restart',
      commandEpoch: 1n,
      deadline: new Date(Date.now() - 1_000)
    })
    await ops.markAccepted(op.id, new Date(), 1n)
    await makeRegistry(ops).settleLifecycleOpOnReady(DaemonId(DAEMON))
    expect(await ops.pendingForDaemon(DaemonId(DAEMON))).toBeNull()
    const latest = await ops.latestForDaemon(DaemonId(DAEMON))
    expect(latest?.status).toBe('failed')
    expect(latest?.outcome).toContain('timed out')
  })
})

/**
 * `GET /daemons/session-series` — the infra detail pages' history strip.
 *
 * A COUNT of the sessions that started on named machines, per local day. The route fences the
 * set to what the caller can already list, so an id they cannot see contributes nothing rather
 * than being reported back as unknown — which would itself answer whether it exists.
 */
describe('GET /daemons/session-series', () => {
  const DAY = 24 * 60 * 60 * 1000
  const OTHER = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b'
  /** The window's end: the next UTC midnight, so `tz=0` makes today the last bucket. */
  const endOfToday = () => Math.ceil(Date.now() / DAY) * DAY

  type Series = { bucket: string; points: { start: string; count: number }[] }
  const ask = (app: HttpApp, query: string, days = 3) =>
    app.app.inject({ method: 'GET', url: `${ORG}/daemons/session-series?${query}&days=${days}&tz=0` })
  const series = async (app: HttpApp, daemons: string, days = 3): Promise<Series> =>
    (await ask(app, `daemons=${daemons}`, days)).json() as Series

  it('counts a machine’s sessions by day and fills the days it had none', async () => {
    await seedDaemon()
    const agent = await seedAgent(prisma, randomUUID(), { daemonId: DAEMON })
    const to = endOfToday()
    // Two today, one the day before yesterday, nothing yesterday — and one outside the window.
    await seedSessionMeta(prisma, randomUUID(), agent, { daemonId: DAEMON, startedAt: new Date(to - 60_000) })
    await seedSessionMeta(prisma, randomUUID(), agent, { daemonId: DAEMON, startedAt: new Date(to - 2 * 60_000) })
    await seedSessionMeta(prisma, randomUUID(), agent, { daemonId: DAEMON, startedAt: new Date(to - 2 * DAY - 60_000) })
    await seedSessionMeta(prisma, randomUUID(), agent, { daemonId: DAEMON, startedAt: new Date(to - 9 * DAY) })
    running = buildHttpApp(prisma)

    const body = await series(running, DAEMON)

    expect(body.bucket).toBe('day')
    expect(body.points.map((p) => p.count)).toEqual([1, 0, 2])
    expect(new Date(body.points[2]!.start).getTime()).toBe(to - DAY)
  })

  it('counts a set of machines together, and only the ones asked for', async () => {
    await seedDaemon()
    await fixtureSeedDaemon(prisma, OTHER)
    const here = await seedAgent(prisma, randomUUID(), { daemonId: DAEMON })
    const there = await seedAgent(prisma, randomUUID(), { daemonId: OTHER })
    const to = endOfToday()
    await seedSessionMeta(prisma, randomUUID(), here, { daemonId: DAEMON, startedAt: new Date(to - 60_000) })
    await seedSessionMeta(prisma, randomUUID(), there, { daemonId: OTHER, startedAt: new Date(to - 60_000) })
    running = buildHttpApp(prisma)

    expect((await series(running, DAEMON)).points.at(-1)!.count).toBe(1)
    expect((await series(running, `${DAEMON},${OTHER}`)).points.at(-1)!.count).toBe(2)
  })

  it('counts a SET by the store its members recorded into, so a rollout keeps its history', async () => {
    // A pool member is a Pod: its retirement SetNulls `daemonId` on every session it recorded
    // (domain/session-content.ts). Counting the pool by its current member ids would drop a
    // day of history to each rollout, so the set is counted by `contentSetId` instead.
    const set = await prisma.memberSet.create({
      data: { id: randomUUID(), orgId: DEFAULT_ORG_ID, name: 'edge-pool' }
    })
    await seedDaemon()
    const agent = await seedAgent(prisma, randomUUID(), { daemonId: DAEMON })
    const to = endOfToday()
    // One recorded by a member that is still here, one by a member already reaped.
    await seedSessionMeta(prisma, randomUUID(), agent, {
      daemonId: DAEMON,
      contentSetId: set.id,
      startedAt: new Date(to - 60_000)
    })
    await seedSessionMeta(prisma, randomUUID(), agent, { contentSetId: set.id, startedAt: new Date(to - 60_000) })
    running = buildHttpApp(prisma)

    const body = (await ask(running, `set=${set.id}`)).json() as Series

    expect(body.points.at(-1)!.count).toBe(2)
  })

  it('404s a set that is neither this org’s nor the pool they share', async () => {
    const other = await prisma.org.create({ data: { id: 'org_other', slug: 'other', name: 'Other' } })
    const set = await prisma.memberSet.create({ data: { id: randomUUID(), orgId: other.id, name: 'theirs' } })
    await seedDaemon()
    running = buildHttpApp(prisma)

    // Zeros would be a confusing lie about somebody else's set — this one is simply not theirs.
    expect((await ask(running, `set=${set.id}`)).statusCode).toBe(404)
  })

  it('ignores an id the caller cannot see rather than reporting it back', async () => {
    await seedDaemon()
    // Restricted to somebody else: it is not in this caller's fleet, so it contributes nothing.
    await fixtureSeedDaemon(prisma, OTHER, { visibility: 'restricted', sharedWith: ['u_someone_else'] })
    const there = await seedAgent(prisma, randomUUID(), { daemonId: OTHER })
    await seedSessionMeta(prisma, randomUUID(), there, { daemonId: OTHER, startedAt: new Date(endOfToday() - 60_000) })
    running = buildHttpApp(prisma)

    const body = await series(running, `${DAEMON},${OTHER}`)

    expect(body.points.every((p) => p.count === 0)).toBe(true)
  })
})
