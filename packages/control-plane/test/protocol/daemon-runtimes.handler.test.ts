/**
 * `facts/daemon-runtimes` handler (protocol §7.3a).
 *
 * After the daemon reaches READY, a `facts/daemon-runtimes` EVT carries the
 * daemon's FULL runtime snapshot (emitted once its probe sweep completes).
 * Unlike the per-runtime `facts/runtime-profile` upsert, the handler must
 * RECONCILE the stored runtime list to exactly the snapshot: every entry
 * upserted, absent runtimes pruned — so an uninstalled runtime stops being
 * offered by the console.
 *
 * Runs over the `InMemoryDaemonStub` against real Testcontainers Postgres.
 */
import { describe, it, expect, vi } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildWsHarness } from '../fakes/build-ws.js'
import { PgRuntimeProfileRepo } from '../../src/persistence/repositories/runtime-profile.repo.js'
import { DaemonId } from '../../src/domain/ids.js'

const DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const AUTH_ID = '44444444-4444-4444-8444-444444444444'
const REG_ID = '55555555-5555-4555-8555-555555555555'

function authPayload(token: string) {
  return { apiKey: token, daemonId: DAEMON, agentVersion: '1.4.0' }
}

function registerPayload() {
  return {
    host: 'host-1',
    capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true },
    maxAgents: 4,
    localState: { assignments: [], crons: [], leases: [] }
  }
}

/** Drive a fresh daemon to READY (auth/ok → register/ok). */
async function connectReady(h: ReturnType<typeof buildWsHarness>) {
  const token = await h.mintToken(DAEMON)
  const { conn, stub } = h.connect()
  stub.inject('auth', authPayload(token), { id: AUTH_ID })
  await stub.expectFrame('auth/ok')
  stub.inject('register', registerPayload(), { id: REG_ID })
  await stub.expectFrame('register/ok')
  return { conn, stub }
}

const profile = (runtime: string, models: string[] = []) => ({
  runtime,
  version: '1.0.0',
  models,
  acpSupport: 'full',
  toolCalling: true
})

const mcpServer = (name: string, transport: 'stdio' | 'http' | 'sse' = 'stdio') => ({ name, transport })

describe('facts/daemon-runtimes handler — reconciles the runtime list to the snapshot', () => {
  it('persists every runtime in the snapshot', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = await connectReady(h)
    const repo = new PgRuntimeProfileRepo(prisma)

    stub.inject('facts/daemon-runtimes', {
      runtimes: [profile('claude-acp', ['claude-opus-4-8']), profile('codex-acp')]
    })

    // Fire-and-forget EVT (no reply) — poll for the persisted side effect.
    await vi.waitFor(async () => {
      expect(await repo.forDaemon(DaemonId(DAEMON))).toHaveLength(2)
    })

    const profiles = await repo.forDaemon(DaemonId(DAEMON))
    expect(profiles.map((p) => p.runtime)).toEqual(['claude-acp', 'codex-acp'])
    expect(profiles[0]!.models).toEqual(['claude-opus-4-8'])
    expect(stub.lastSent('error')).toBeUndefined()
  })

  it('prunes runtimes absent from the snapshot (replace, not upsert)', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = await connectReady(h)
    const repo = new PgRuntimeProfileRepo(prisma)

    // Seed two runtimes via the per-runtime upsert path.
    stub.inject('facts/runtime-profile', profile('claude-acp'))
    stub.inject('facts/runtime-profile', profile('codex-acp'))
    await vi.waitFor(async () => {
      expect(await repo.forDaemon(DaemonId(DAEMON))).toHaveLength(2)
    })

    // The next sweep no longer sees codex — the snapshot must prune it.
    stub.inject('facts/daemon-runtimes', {
      runtimes: [profile('claude-acp', ['claude-opus-4-8'])]
    })
    await vi.waitFor(async () => {
      expect(await repo.forDaemon(DaemonId(DAEMON))).toHaveLength(1)
    })

    const [p] = await repo.forDaemon(DaemonId(DAEMON))
    expect(p!.runtime).toBe('claude-acp')
    expect(p!.models).toEqual(['claude-opus-4-8']) // survivor was upserted, not left stale
    expect(stub.lastSent('error')).toBeUndefined()
  })

  it('an empty snapshot clears the daemon runtime list', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = await connectReady(h)
    const repo = new PgRuntimeProfileRepo(prisma)

    stub.inject('facts/runtime-profile', profile('claude-acp'))
    await vi.waitFor(async () => {
      expect(await repo.forDaemon(DaemonId(DAEMON))).toHaveLength(1)
    })

    stub.inject('facts/daemon-runtimes', { runtimes: [] })
    await vi.waitFor(async () => {
      expect(await repo.forDaemon(DaemonId(DAEMON))).toHaveLength(0)
    })
    expect(stub.lastSent('error')).toBeUndefined()
  })

  it('persists the per-runtime mcpCapabilities and resets them when a later probe omits them', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = await connectReady(h)
    const repo = new PgRuntimeProfileRepo(prisma)

    stub.inject('facts/daemon-runtimes', {
      runtimes: [{ ...profile('claude-acp'), mcpCapabilities: { http: true, sse: false } }]
    })
    await vi.waitFor(async () => {
      expect((await repo.forDaemon(DaemonId(DAEMON)))[0]?.mcpCapabilities).toEqual({ http: true, sse: false })
    })

    // The next sweep carries no mcpCapabilities (not probed) — the stored value
    // must reset to null (assume stdio-only), never stay stale.
    stub.inject('facts/daemon-runtimes', { runtimes: [profile('claude-acp')] })
    await vi.waitFor(async () => {
      expect((await repo.forDaemon(DaemonId(DAEMON)))[0]?.mcpCapabilities).toBeNull()
    })
    expect(stub.lastSent('error')).toBeUndefined()
  })

  it('persists the per-runtime modelCatalog + modelsSource and resets them when a later snapshot omits them', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = await connectReady(h)
    const repo = new PgRuntimeProfileRepo(prisma)
    const catalog = {
      models: [{ id: 'claude-opus-4-8', efforts: [{ value: 'high' }], defaultEffort: 'high', fastMode: true }],
      defaultModel: 'claude-opus-4-8',
      source: 'acp',
      observedAt: '2026-07-18T00:00:00.000Z'
    }

    stub.inject('facts/daemon-runtimes', {
      runtimes: [
        { ...profile('claude-acp', ['claude-opus-4-8']), modelCatalog: catalog, modelsSource: 'cached' as const }
      ]
    })
    await vi.waitFor(async () => {
      const [p] = await repo.forDaemon(DaemonId(DAEMON))
      expect(p?.modelCatalog).toEqual(catalog) // the wire object, stored verbatim
      expect(p?.modelsSource).toBe('cached')
    })

    // A snapshot without the fields (older daemon / no catalog yet) resets both —
    // same absent-⇒-null convention as mcpCapabilities.
    stub.inject('facts/daemon-runtimes', { runtimes: [profile('claude-acp')] })
    await vi.waitFor(async () => {
      const [p] = await repo.forDaemon(DaemonId(DAEMON))
      expect(p?.modelCatalog).toBeNull()
      expect(p?.modelsSource).toBeNull()
    })
    expect(stub.lastSent('error')).toBeUndefined()
  })

  it('persists the per-runtime authRequired login warning and clears it when a later snapshot omits it', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = await connectReady(h)
    const repo = new PgRuntimeProfileRepo(prisma)

    // The probe was rejected with ACP auth-required: the runtime stays listed
    // (installed) but carries the login warning.
    stub.inject('facts/daemon-runtimes', {
      runtimes: [{ ...profile('claude-acp'), authRequired: true }]
    })
    await vi.waitFor(async () => {
      expect((await repo.forDaemon(DaemonId(DAEMON)))[0]?.authRequired).toBe(true)
    })

    // Logged in meanwhile: the next snapshot omits the flag (a successful probe
    // never sends it) — the stored warning must clear, never stay stale.
    stub.inject('facts/daemon-runtimes', { runtimes: [profile('claude-acp')] })
    await vi.waitFor(async () => {
      expect((await repo.forDaemon(DaemonId(DAEMON)))[0]?.authRequired).toBe(false)
    })
    expect(stub.lastSent('error')).toBeUndefined()
  })

  it('stamps the frame seq, drops an older snapshot whole, and re-register resets the fence', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = await connectReady(h)
    const repo = new PgRuntimeProfileRepo(prisma)
    const storedSeq = async () => (await prisma.daemon.findUnique({ where: { id: DAEMON } }))?.runtimesSnapshotSeq

    stub.inject('facts/daemon-runtimes', { runtimes: [profile('claude-acp')], seq: 2 })
    await vi.waitFor(async () => {
      expect(await storedSeq()).toBe(2)
    })

    // A stale frame (older seq — e.g. a sweep frame committing after a catalog
    // frame) must be dropped whole: runtimes AND its mcpServers list.
    stub.inject('facts/daemon-runtimes', {
      runtimes: [profile('codex-acp')],
      mcpServers: [mcpServer('stale')],
      seq: 1
    })
    stub.inject('facts/daemon-runtimes', { runtimes: [profile('claude-acp'), profile('codex-acp')], seq: 3 })
    await vi.waitFor(async () => {
      expect(await storedSeq()).toBe(3)
      expect((await repo.forDaemon(DaemonId(DAEMON))).map((p) => p.runtime)).toEqual(['claude-acp', 'codex-acp'])
    })
    const row = await prisma.daemon.findUnique({ where: { id: DAEMON } })
    expect(row?.mcpServers).toEqual([]) // the stale frame's server list never landed

    // Re-register (reconnect) resets the fence, so the daemon's fresh
    // per-connection counter is accepted from 1 again. (Sync on the persisted
    // reset — `expectFrame` would resolve with the FIRST register/ok.)
    stub.inject('register', registerPayload())
    await vi.waitFor(async () => {
      expect(await storedSeq()).toBeNull()
    })
    stub.inject('facts/daemon-runtimes', { runtimes: [profile('claude-acp')], seq: 1 })
    await vi.waitFor(async () => {
      expect(await storedSeq()).toBe(1)
      expect((await repo.forDaemon(DaemonId(DAEMON))).map((p) => p.runtime)).toEqual(['claude-acp'])
    })
    expect(stub.lastSent('error')).toBeUndefined()
  })

  it('persists the daemon-level mcpServers snapshot on the daemon row', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = await connectReady(h)

    stub.inject('facts/daemon-runtimes', {
      runtimes: [profile('claude-acp')],
      mcpServers: [mcpServer('github'), mcpServer('flaky', 'http')]
    })

    await vi.waitFor(async () => {
      const row = await prisma.daemon.findUnique({ where: { id: DAEMON } })
      expect(row?.mcpServers).toEqual([
        { name: 'github', transport: 'stdio' },
        { name: 'flaky', transport: 'http' }
      ])
    })
    expect(stub.lastSent('error')).toBeUndefined()
  })

  it('a later snapshot REPLACES the mcpServers list; an absent/empty one clears it', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = await connectReady(h)

    stub.inject('facts/daemon-runtimes', {
      runtimes: [profile('claude-acp')],
      mcpServers: [mcpServer('github'), mcpServer('metrics')]
    })
    await vi.waitFor(async () => {
      const row = await prisma.daemon.findUnique({ where: { id: DAEMON } })
      expect(row?.mcpServers).toHaveLength(2)
    })

    // Replace, not merge: only the surviving server remains.
    stub.inject('facts/daemon-runtimes', {
      runtimes: [profile('claude-acp')],
      mcpServers: [mcpServer('metrics')]
    })
    await vi.waitFor(async () => {
      const row = await prisma.daemon.findUnique({ where: { id: DAEMON } })
      expect(row?.mcpServers).toEqual([mcpServer('metrics')])
    })

    // A frame without mcpServers (older daemon ⇒ schema default []) clears the list.
    stub.inject('facts/daemon-runtimes', { runtimes: [profile('claude-acp')] })
    await vi.waitFor(async () => {
      const row = await prisma.daemon.findUnique({ where: { id: DAEMON } })
      expect(row?.mcpServers).toEqual([])
    })
    expect(stub.lastSent('error')).toBeUndefined()
  })
})
