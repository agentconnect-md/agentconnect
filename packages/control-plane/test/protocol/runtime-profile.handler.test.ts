/**
 * `facts/runtime-profile` handler red→green (design §3.4, §3.14; protocol §7.3).
 *
 * After the daemon reaches READY (auth → register), a `facts/runtime-profile` EVT
 * is a fire-and-forget fact: it carries no reply, but the handler must persist the
 * observed runtime capabilities (version, available `models[]`, ACP coverage) via
 * the C4 registry, upserting on `(daemonId, runtime)`. The fleet read model then
 * surfaces these so the console can offer per-machine model choices.
 *
 * Runs over the `InMemoryDaemonStub` against real Testcontainers Postgres.
 */
import { describe, it, expect, vi } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildWsHarness } from '../fakes/build-ws.js'
import { PgRuntimeProfileRepo } from '../../src/persistence/repositories/runtime-profile.repo.js'
import { DaemonId } from '../../src/domain/ids.js'

const DAEMON = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
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

describe('facts/runtime-profile handler — persists observed runtime capabilities', () => {
  it('upserts the runtime profile (models, version, acp) for the daemon', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = await connectReady(h)
    const repo = new PgRuntimeProfileRepo(prisma)

    stub.inject('facts/runtime-profile', {
      runtime: 'claude',
      version: '1.4.0',
      models: ['claude-opus-4', 'claude-sonnet-4-5'],
      contextWindow: 200000,
      acpSupport: 'full',
      toolCalling: true
    })

    // Fire-and-forget EVT (no reply) — poll for the persisted side effect.
    await vi.waitFor(async () => {
      expect(await repo.forDaemon(DaemonId(DAEMON))).toHaveLength(1)
    })

    const [p] = await repo.forDaemon(DaemonId(DAEMON))
    expect(p!.runtime).toBe('claude')
    expect(p!.version).toBe('1.4.0')
    expect(p!.models).toEqual(['claude-opus-4', 'claude-sonnet-4-5'])
    expect(p!.acpSupport).toBe('full')
    expect(p!.toolCalling).toBe(true)
    // No error frame was produced for the EVT.
    expect(stub.lastSent('error')).toBeUndefined()
  })

  it('re-sending the same runtime replaces the prior models (upsert on (daemonId, runtime))', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = await connectReady(h)
    const repo = new PgRuntimeProfileRepo(prisma)

    stub.inject('facts/runtime-profile', {
      runtime: 'claude',
      version: '1.4.0',
      models: ['claude-opus-4'],
      acpSupport: 'full',
      toolCalling: true
    })
    await vi.waitFor(async () => {
      expect((await repo.forDaemon(DaemonId(DAEMON)))[0]?.models).toEqual(['claude-opus-4'])
    })

    stub.inject('facts/runtime-profile', {
      runtime: 'claude',
      version: '1.5.0',
      models: ['claude-opus-4-8', 'claude-haiku-4-5'],
      acpSupport: 'full',
      toolCalling: true
    })
    await vi.waitFor(async () => {
      expect((await repo.forDaemon(DaemonId(DAEMON)))[0]?.version).toBe('1.5.0')
    })

    const profiles = await repo.forDaemon(DaemonId(DAEMON))
    expect(profiles).toHaveLength(1) // upsert, not append
    expect(profiles[0]!.models).toEqual(['claude-opus-4-8', 'claude-haiku-4-5'])
  })

  it('persists mcpCapabilities through the deprecated per-runtime path (shared upsert)', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = await connectReady(h)
    const repo = new PgRuntimeProfileRepo(prisma)

    stub.inject('facts/runtime-profile', {
      runtime: 'claude',
      version: '1.4.0',
      models: ['claude-opus-4'],
      acpSupport: 'full',
      toolCalling: true,
      mcpCapabilities: { http: true, sse: true }
    })
    await vi.waitFor(async () => {
      expect((await repo.forDaemon(DaemonId(DAEMON)))[0]?.mcpCapabilities).toEqual({ http: true, sse: true })
    })
    expect(stub.lastSent('error')).toBeUndefined()
  })
})
