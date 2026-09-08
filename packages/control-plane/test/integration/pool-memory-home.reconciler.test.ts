// The boot-time memory-home flip (memory-evolution.md §3.2.1 "Rollout"): pool-placed agents, and only those, move home.
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Ack, AgentActivate, AgentDetach, AgentUpsert, McpServerSpec } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon, seedDutyGroup } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { poolSetId, seedPoolMember } from '../fakes/member-set.js'
import type { DaemonLiveness } from '../../src/ports.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { PoolMemoryHomeReconciler } from '../../src/orchestrator/poolMemoryHomeReconciler.js'

const SOURCE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const MEMBER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const CAPS = { platforms: ['slack'], runtimes: ['Claude Code'], acp: true, features: ['agent-move-v1'] }

const CP = { provider: 'managed', home: 'control-plane' }
const PENDING = { ...CP, homeMigration: 'pending' }
const DAEMON_HOME = { provider: 'managed', home: 'daemon' }
const EXTERNAL = { provider: 'external', connectionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

/** The daemon-side seam: records every spec push with the binding it carried. */
class ControlSpy {
  readonly upserts: Array<{ daemonId: string; agentId: string; memory: unknown }> = []
  async agentDetach(_daemonId: string, _value: AgentDetach): Promise<Ack> {
    return { ok: true }
  }
  async agentActivate(_daemonId: string, _value: AgentActivate): Promise<Ack> {
    return { ok: true }
  }
  async agentUpsert(daemonId: string, value: AgentUpsert): Promise<void> {
    this.upserts.push({ daemonId, agentId: value.agentId, memory: (value.spec as { memory?: unknown }).memory })
  }
  async mcpServerUpsert(_daemonId: string, _spec: McpServerSpec): Promise<void> {}
  async mcpServerRemove(_daemonId: string, _orgId: string, _name: string): Promise<void> {}
}

const live: DaemonLiveness = {
  get: (id) => ([SOURCE, MEMBER].includes(id) ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined)
}

const logs: unknown[] = []
const log = { info: (obj: unknown) => void logs.push(obj), warn: () => {} }

function harness(): { reconciler: PoolMemoryHomeReconciler; spy: ControlSpy } {
  const spy = new ControlSpy()
  running = buildHttpApp(prisma, undefined, live, spy as unknown as ControlSender)
  const { repos, agentDelivery } = running.deps
  return {
    reconciler: new PoolMemoryHomeReconciler({
      agents: repos.agent,
      memberSets: repos.memberSet,
      delivery: agentDelivery,
      log
    }),
    spy
  }
}

const row = (agentId: string) => prisma.agent.findUniqueOrThrow({ where: { id: agentId } })
const storedMemory = async (agentId: string) =>
  ((await row(agentId)).runtimeOverrides as { memory?: unknown } | null)?.memory ?? null

/** An agent on the pool set, or pinned to a machine; `memory` is what its row already carries. */
async function seed(
  memory: Record<string, unknown> | null,
  placement: { pool: true } | { daemonId: string }
): Promise<string> {
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, {
    ...('pool' in placement ? { setId: await poolSetId(prisma) } : { daemonId: placement.daemonId }),
    ...(memory ? { runtimeOverrides: { memory } } : {})
  })
  return agentId
}

describe('PoolMemoryHomeReconciler', () => {
  it('a pool agent with no binding is flipped to the Control Plane, flagged for migration, and pushed to its holder', async () => {
    await seedPoolMember(prisma, MEMBER)
    const agentId = await seed(null, { pool: true })
    await seedDutyGroup(prisma, randomUUID(), MEMBER, [agentId], { confirmed: true })
    const before = await row(agentId)
    const { reconciler, spy } = harness()

    expect(await reconciler.run()).toEqual({ flipped: 1, already: 0, skipped: 0, failed: 0 })
    expect(await storedMemory(agentId)).toEqual(PENDING)
    const after = await row(agentId)
    expect(after.configRevision).toBe(before.configRevision + 1n)
    expect(spy.upserts).toEqual([{ daemonId: MEMBER, agentId, memory: PENDING }])
  })

  it('a legacy agent pinned to a pool member keeps its managed policy and is pushed to that member', async () => {
    await seedPoolMember(prisma, MEMBER)
    const agentId = await seed({ ...DAEMON_HOME, autoDistill: false }, { daemonId: MEMBER })
    const { reconciler, spy } = harness()

    expect(await reconciler.run()).toMatchObject({ flipped: 1 })
    expect(await storedMemory(agentId)).toEqual({ ...PENDING, autoDistill: false })
    expect(spy.upserts.map((u) => u.daemonId)).toEqual([MEMBER])
  })

  it('leaves alone what has no daemon home to move: already homed, non-managed, or not on the pool', async () => {
    await seedDaemon(prisma, SOURCE, { capabilities: CAPS })
    await seedPoolMember(prisma, MEMBER)
    const homed = await seed(CP, { pool: true })
    const migrating = await seed(PENDING, { pool: true })
    const external = await seed(EXTERNAL, { pool: true })
    const selfHosted = await seed(DAEMON_HOME, { daemonId: SOURCE })
    const selfHostedBare = await seed(null, { daemonId: SOURCE })
    await seedDutyGroup(prisma, randomUUID(), MEMBER, [homed, migrating, external], { confirmed: true })
    const revisions = await Promise.all(
      [homed, migrating, external, selfHosted].map(async (id) => (await row(id)).configRevision)
    )
    const { reconciler, spy } = harness()

    expect(await reconciler.run()).toEqual({ flipped: 0, already: 2, skipped: 1, failed: 0 })
    expect(await storedMemory(homed)).toEqual(CP)
    expect(await storedMemory(migrating)).toEqual(PENDING)
    expect(await storedMemory(external)).toEqual(EXTERNAL)
    expect(await storedMemory(selfHosted)).toEqual(DAEMON_HOME)
    expect(await storedMemory(selfHostedBare)).toBeNull()
    expect(
      await Promise.all([homed, migrating, external, selfHosted].map(async (id) => (await row(id)).configRevision))
    ).toEqual(revisions)
    expect(spy.upserts).toEqual([])
  })

  it('honors an edit that lands between the scan and the row lock instead of overwriting it', async () => {
    await seedPoolMember(prisma, MEMBER)
    const switched = await seed(null, { pool: true })
    const repoliced = await seed({ ...DAEMON_HOME, autoDistill: true }, { pool: true })
    await seedDutyGroup(prisma, randomUUID(), MEMBER, [switched, repoliced], { confirmed: true })
    const spy = new ControlSpy()
    running = buildHttpApp(prisma, undefined, live, spy as unknown as ControlSender)
    const { repos, agentDelivery } = running.deps
    // A user's edit commits after the scan read the row and before the flip takes the lock.
    const raced: Record<string, Record<string, unknown>> = {
      [switched]: { provider: 'none' },
      [repoliced]: { ...DAEMON_HOME, autoDistill: false }
    }
    const agents: typeof repos.agent = Object.assign(Object.create(repos.agent), {
      update: async (...args: Parameters<typeof repos.agent.update>) => {
        const [orgId, agentId] = args
        await repos.agent.update(orgId, agentId, { memory: raced[agentId] as never })
        return repos.agent.update(...args)
      }
    })
    const reconciler = new PoolMemoryHomeReconciler({
      agents,
      memberSets: repos.memberSet,
      delivery: agentDelivery,
      log
    })

    expect(await reconciler.run()).toEqual({ flipped: 1, already: 0, skipped: 1, failed: 0 })
    expect(await storedMemory(switched)).toEqual({ provider: 'none' })
    expect(await storedMemory(repoliced)).toEqual({ ...PENDING, autoDistill: false })
    expect(spy.upserts.map((u) => u.agentId)).toEqual([repoliced])
  })

  it('is idempotent: a second pass changes nothing and pushes nothing', async () => {
    await seedPoolMember(prisma, MEMBER)
    const bare = await seed(null, { pool: true })
    const pinned = await seed(DAEMON_HOME, { daemonId: MEMBER })
    await seedDutyGroup(prisma, randomUUID(), MEMBER, [bare], { confirmed: true })
    const { reconciler, spy } = harness()

    expect(await reconciler.run()).toEqual({ flipped: 2, already: 0, skipped: 0, failed: 0 })
    expect(spy.upserts.map((u) => u.agentId).sort()).toEqual([bare, pinned].sort())
    const revisions = await Promise.all([bare, pinned].map(async (id) => (await row(id)).configRevision))

    expect(await reconciler.run()).toEqual({ flipped: 0, already: 2, skipped: 0, failed: 0 })
    expect(spy.upserts).toHaveLength(2)
    expect(await Promise.all([bare, pinned].map(async (id) => (await row(id)).configRevision))).toEqual(revisions)
    expect(await storedMemory(bare)).toEqual(PENDING)
    expect(logs.at(-1)).toEqual({ flipped: 0, already: 2, skipped: 0, failed: 0 })
  })
})
