/**
 * LaunchRepo / RuntimeProfileRepo / AuditRepo (design §3.4, §3.9, §3.12, §6 Phase 1).
 *
 * Covers the launch fence (`currentLaunch`), the runtime-profile upsert on
 * (daemonId, runtime), and the append-only audit feed — all against real Postgres.
 */
import { describe, it, expect } from 'vitest'
import { prisma } from '../setup.db.js'
import { PgLaunchRepo } from '../../src/persistence/repositories/launch.repo.js'
import { PgRuntimeProfileRepo } from '../../src/persistence/repositories/runtime-profile.repo.js'
import { PgDaemonRepo } from '../../src/persistence/repositories/daemon.repo.js'
import { PgAuditRepo } from '../../src/persistence/repositories/audit.repo.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { AgentId, DaemonId, LaunchId, OrgId } from '../../src/domain/ids.js'

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DAEMON = 'd1111111-1111-4111-8111-111111111111'
const L1 = '10000000-0000-4000-8000-000000000001'
const L2 = '10000000-0000-4000-8000-000000000002'

async function fixtures(): Promise<void> {
  await seedDaemon(prisma, DAEMON)
  await seedAgent(prisma, AGENT)
}

describe('LaunchRepo — launch fence (real Postgres)', () => {
  it('records a launch and returns it as the current launch', async () => {
    await fixtures()
    const repo = new PgLaunchRepo(prisma)

    await repo.record({
      launchId: LaunchId(L1),
      agentId: AgentId(AGENT),
      daemonId: DaemonId(DAEMON),
      runtime: 'claude',
      acpSessionId: 'acp-1',
      activeCapabilities: ['message.send'],
      epoch: 1n
    })

    expect(await repo.currentLaunch(AgentId(AGENT))).toBe(L1)
  })

  it('a newer launch supersedes the previous as current; stopped launches drop out', async () => {
    await fixtures()
    const repo = new PgLaunchRepo(prisma)

    await repo.record({
      launchId: LaunchId(L1),
      agentId: AgentId(AGENT),
      daemonId: DaemonId(DAEMON),
      runtime: 'claude',
      epoch: 1n
    })
    await repo.record({
      launchId: LaunchId(L2),
      agentId: AgentId(AGENT),
      daemonId: DaemonId(DAEMON),
      runtime: 'claude',
      epoch: 2n
    })
    expect(await repo.currentLaunch(AgentId(AGENT))).toBe(L2)

    await repo.markStopped(LaunchId(L2), 'stopped', new Date())
    expect(await repo.currentLaunch(AgentId(AGENT))).toBe(L1) // falls back to the live one
  })
})

describe('RuntimeProfileRepo — upsert on (daemonId, runtime) (real Postgres)', () => {
  it('records then replaces the profile for a runtime', async () => {
    await seedDaemon(prisma, DAEMON)
    const repo = new PgRuntimeProfileRepo(prisma)
    const at = new Date()

    await repo.record(
      DaemonId(DAEMON),
      { runtime: 'claude', version: '1.0', models: ['a'], acpSupport: 'full', toolCalling: true },
      at
    )
    await repo.record(
      DaemonId(DAEMON),
      { runtime: 'claude', version: '2.0', models: ['a', 'b'], acpSupport: 'partial', toolCalling: false },
      at
    )

    const profiles = await repo.forDaemon(DaemonId(DAEMON))
    expect(profiles).toHaveLength(1) // upsert, not append
    expect(profiles[0]?.version).toBe('2.0')
    expect(profiles[0]?.models).toEqual(['a', 'b'])
    expect(profiles[0]?.acpSupport).toBe('partial')
  })

  it('round-trips mcpCapabilities: absent reads null; a value persists; a later omit resets', async () => {
    await seedDaemon(prisma, DAEMON)
    const repo = new PgRuntimeProfileRepo(prisma)
    const at = new Date()
    const base = {
      runtime: 'claude',
      version: '1.0',
      models: [] as string[],
      acpSupport: 'full' as const,
      toolCalling: true
    }

    // Not probed (older daemon) ⇒ null, never undefined (the DTO is `.nullable()`).
    const unprobed = await repo.record(DaemonId(DAEMON), { ...base }, at)
    expect(unprobed.mcpCapabilities).toBeNull()

    const probed = await repo.record(DaemonId(DAEMON), { ...base, mcpCapabilities: { http: true, sse: false } }, at)
    expect(probed.mcpCapabilities).toEqual({ http: true, sse: false })

    // A re-probe without the field resets to null rather than keeping a stale value.
    const reset = await repo.record(DaemonId(DAEMON), { ...base }, at)
    expect(reset.mcpCapabilities).toBeNull()
  })

  it('round-trips modelCatalog + modelsSource + observedAt; a later omit resets both', async () => {
    await seedDaemon(prisma, DAEMON)
    const repo = new PgRuntimeProfileRepo(prisma)
    const at = new Date('2026-07-18T00:00:00.000Z')
    const base = {
      runtime: 'claude',
      version: '1.0',
      models: ['claude-opus-4'],
      acpSupport: 'full' as const,
      toolCalling: true
    }
    const catalog = {
      models: [
        { id: 'claude-opus-4', efforts: [{ value: 'high', name: 'High' }], defaultEffort: 'high', fastMode: true }
      ],
      defaultModel: 'claude-opus-4',
      permissionModes: [{ value: 'acceptEdits' }],
      source: 'acp' as const,
      observedAt: '2026-07-18T00:00:00.000Z'
    }

    const stored = await repo.record(DaemonId(DAEMON), { ...base, modelCatalog: catalog, modelsSource: 'cached' }, at)
    expect(stored.modelCatalog).toEqual(catalog) // JSONB stores the wire object verbatim
    expect(stored.modelsSource).toBe('cached')
    expect(stored.observedAt).toEqual(at)

    // Absent ⇒ reset to null (same convention as mcpCapabilities), never stale.
    const reset = await repo.record(DaemonId(DAEMON), { ...base }, at)
    expect(reset.modelCatalog).toBeNull()
    expect(reset.modelsSource).toBeNull()
  })
})

describe('RuntimeProfileRepo — snapshot seq fence (real Postgres)', () => {
  const profile = (runtime: string) => ({
    runtime,
    version: '1.0',
    models: [] as string[],
    acpSupport: 'full' as const,
    toolCalling: true
  })
  const storedSeq = async () => (await prisma.daemon.findUnique({ where: { id: DAEMON } }))?.runtimesSnapshotSeq

  it('drops a snapshot older than the last applied seq; register resets the fence', async () => {
    await seedDaemon(prisma, DAEMON)
    const profiles = new PgRuntimeProfileRepo(prisma)
    const at = new Date()

    expect(await profiles.replaceAll(DaemonId(DAEMON), [profile('claude')], at, 2)).toBe(true)

    // An older snapshot is skipped WHOLE — stored rows and the fence untouched.
    expect(await profiles.replaceAll(DaemonId(DAEMON), [profile('codex')], at, 1)).toBe(false)
    expect((await profiles.forDaemon(DaemonId(DAEMON))).map((p) => p.runtime)).toEqual(['claude'])
    expect(await storedSeq()).toBe(2)

    // A newer one applies as usual.
    expect(await profiles.replaceAll(DaemonId(DAEMON), [profile('codex')], at, 3)).toBe(true)

    // register resets the fence, so a reconnecting daemon's fresh per-connection
    // counter is accepted from 1 again.
    await new PgDaemonRepo(prisma).applyRegister(
      DaemonId(DAEMON),
      {
        host: 'host-1',
        capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true, features: [] },
        maxAgents: 4
      },
      new Date()
    )
    expect(await storedSeq()).toBeNull()
    expect(await profiles.replaceAll(DaemonId(DAEMON), [profile('claude')], at, 1)).toBe(true)
    expect((await profiles.forDaemon(DaemonId(DAEMON))).map((p) => p.runtime)).toEqual(['claude'])
  })

  it('a seq-less snapshot stays latest-commit-wins and leaves the fence alone (older daemons)', async () => {
    await seedDaemon(prisma, DAEMON)
    const profiles = new PgRuntimeProfileRepo(prisma)
    const at = new Date()

    expect(await profiles.replaceAll(DaemonId(DAEMON), [profile('claude')], at, 5)).toBe(true)
    expect(await profiles.replaceAll(DaemonId(DAEMON), [profile('codex')], at)).toBe(true)
    expect((await profiles.forDaemon(DaemonId(DAEMON))).map((p) => p.runtime)).toEqual(['codex'])
    expect(await storedSeq()).toBe(5)
  })
})

describe('AuditRepo — append-only feed (real Postgres)', () => {
  it('appends events and reads the most recent first', async () => {
    await seedDaemon(prisma, DAEMON)
    const repo = new PgAuditRepo(prisma)

    await repo.append({
      kind: 'daemon_auth',
      orgId: OrgId(DEFAULT_ORG_ID),
      daemonId: DaemonId(DAEMON),
      message: 'auth ok'
    })
    await repo.append({
      kind: 'scope_denied',
      orgId: OrgId(DEFAULT_ORG_ID),
      daemonId: DaemonId(DAEMON),
      details: { capability: 'attachment.put' }
    })

    const recent = await repo.recent(10)
    expect(recent).toHaveLength(2)
    expect(recent[0]?.kind).toBe('scope_denied') // newest first
    expect(recent[0]?.details).toEqual({ capability: 'attachment.put' })
  })
})
