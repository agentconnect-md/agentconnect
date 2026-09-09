/**
 * The CP's rules for a managed memory binding's `home` (memory-evolution.md §3.2.1, §6), at the REST surface:
 *
 *  - create stores a RESOLVED home: the install-wide pool gets `control-plane` (an explicit `daemon` there is 409),
 *    anywhere else the given value or `daemon`;
 *  - an edit without `home` keeps the current one, the migration flag included — the console's wholesale save
 *    from a Control-Plane-homed agent is not a reverse change;
 *  - `daemon` → `control-plane` is accepted and flags `homeMigration: pending`; the reverse is 409 unless `force`
 *    is set, and then the agent's CP tree and change log are dropped with the write;
 *  - a provider switch never migrates; a move onto the pool is refused while the home is the daemon;
 *  - `memory/history` for a Control-Plane home is answered from the table, daemon or no daemon.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type {
  Ack,
  AgentActivate,
  AgentDetach,
  AgentUpsert,
  McpServerSpec,
  MemoryConnectionSpec
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { DEF_ORG, seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { joinPool, poolSetId } from '../fakes/member-set.js'
import type { DaemonLiveness } from '../../src/ports.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import {
  PgAgentMemoryFileRepo,
  PgAgentMemoryHistoryRepo
} from '../../src/persistence/repositories/agent-memory.repo.js'
import { AgentId } from '../../src/domain/ids.js'
import type { AgentMemoryHistoryInput } from '../../src/persistence/ports.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import { PgAgentConfigWriter } from '../../src/persistence/repositories/agent-config.writer.js'
import { PlaintextSecretCipher } from '../../src/secrets/cipher.js'
import { MemoryHomeRefusedError } from '../../src/agent-memory/home.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const SOURCE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const MEMBER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const CAPS = { platforms: ['slack'], runtimes: ['Claude Code'], acp: true, features: ['agent-move-v1'] }

const CP = { provider: 'managed', home: 'control-plane' }
const PENDING = { ...CP, homeMigration: 'pending' }
const DAEMON_HOME = { provider: 'managed', home: 'daemon' }

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

/** The daemon-side seam, answering every push with an ack and refusing the one read the CP must answer itself. */
class ControlSpy {
  readonly calls: string[] = []
  async agentDetach(daemonId: string, _value: AgentDetach): Promise<Ack> {
    this.calls.push(`detach:${daemonId}`)
    return { ok: true }
  }
  async agentActivate(daemonId: string, _value: AgentActivate): Promise<Ack> {
    this.calls.push(`activate:${daemonId}`)
    return { ok: true }
  }
  async agentUpsert(daemonId: string, _value: AgentUpsert): Promise<void> {
    this.calls.push(`upsert:${daemonId}`)
  }
  async memoryConnectionUpsert(_daemonId: string, _spec: MemoryConnectionSpec): Promise<void> {}
  async memoryConnectionRemove(_daemonId: string, _connectionId: string): Promise<void> {}
  async mcpServerUpsert(_daemonId: string, _spec: McpServerSpec): Promise<void> {}
  async mcpServerRemove(_daemonId: string, _orgId: string, _name: string): Promise<void> {}
  async memoryHistory(): Promise<never> {
    throw new Error('memory/history must not reach the daemon for a Control-Plane home')
  }
}

const live: DaemonLiveness = {
  get: (id) => ([SOURCE, MEMBER].includes(id) ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined)
}

/** One install-wide pool member: org-less, Pod-bound, enrolled — what `upsertOnAuth` writes for a real Pod. */
async function seedPoolMember(): Promise<void> {
  await prisma.daemon.create({
    data: {
      id: MEMBER,
      orgId: null,
      clusterIdentity: 'system:serviceaccount:ac-example:ac-cloud-daemon',
      clusterPodUid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      maxAgents: 8,
      status: 'ready',
      capabilities: CAPS
    }
  })
  await joinPool(prisma, MEMBER)
}

function app(): HttpApp {
  running = buildHttpApp(prisma, undefined, live, new ControlSpy() as unknown as ControlSender)
  return running
}

const storedMemory = async (agentId: string) =>
  ((await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).runtimeOverrides as { memory?: unknown } | null)
    ?.memory ?? null

const create = (payload: Record<string, unknown>) => app().app.inject({ method: 'POST', url: `${ORG}/agents`, payload })
const patch = (agentId: string, payload: Record<string, unknown>) =>
  app().app.inject({ method: 'PATCH', url: `${ORG}/agents/${agentId}`, payload })

async function seedHomed(memory: Record<string, unknown> | null, opts: { pool?: boolean } = {}): Promise<string> {
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, {
    ...(opts.pool ? { setId: await poolSetId(prisma) } : { daemonId: SOURCE }),
    ...(memory ? { runtimeOverrides: { memory } } : {})
  })
  return agentId
}

describe('POST /agents — the memory home is resolved on create', () => {
  it('an agent placed on the pool keeps its memory in the Control Plane, with or without a binding', async () => {
    await seedDaemon(prisma, SOURCE, { capabilities: CAPS })
    await seedPoolMember()
    const bare = await create({ name: 'pooled-bare', runtime: 'Claude Code', placementKind: 'pool' })
    expect(bare.statusCode).toBe(201)
    expect(bare.json().memory).toEqual(CP)
    expect(await storedMemory(bare.json().id)).toEqual(CP)

    const bound = await create({
      name: 'pooled-bound',
      runtime: 'Claude Code',
      placementKind: 'pool',
      memory: { provider: 'managed', autoDistill: false }
    })
    expect(bound.statusCode).toBe(201)
    expect(bound.json().memory).toEqual({ provider: 'managed', autoDistill: false, home: 'control-plane' })
    // (A create pinned to a member directly is refused by the repo itself — `DaemonPlacementInSet` — so the
    // member-pinned shape only exists on legacy rows, which the edit and move rules below still cover.)
  })

  it('refuses an explicit daemon home on the pool, and never accepts the CP-owned flag from a client', async () => {
    await seedDaemon(prisma, SOURCE, { capabilities: CAPS })
    await seedPoolMember()
    const res = await create({
      name: 'pooled-daemon',
      runtime: 'Claude Code',
      placementKind: 'pool',
      memory: DAEMON_HOME
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().message).toContain('control-plane')
    expect(await prisma.agent.findFirst({ where: { name: 'pooled-daemon' } })).toBeNull()

    const flagged = await create({ name: 'flagged', runtime: 'Claude Code', memory: PENDING })
    expect(flagged.statusCode).toBe(400)
  })

  it('a self-hosted agent stores the given home or daemon, and no binding stays the managed default', async () => {
    await seedDaemon(prisma, SOURCE, { capabilities: CAPS })
    const bare = await create({ name: 'local-bare', runtime: 'Claude Code', daemonId: SOURCE })
    expect(bare.statusCode).toBe(201)
    expect(bare.json().memory).toBeNull()

    const managed = await create({
      name: 'local-managed',
      runtime: 'Claude Code',
      daemonId: SOURCE,
      memory: { provider: 'managed' }
    })
    expect(managed.json().memory).toEqual(DAEMON_HOME)

    const cp = await create({ name: 'local-cp', runtime: 'Claude Code', daemonId: SOURCE, memory: CP })
    // Created straight into the Control Plane: there is no tree to copy, so nothing is flagged.
    expect(cp.json().memory).toEqual(CP)
  })
})

describe('PATCH /agents/:id — the home moves one way and comes back only by force', () => {
  it('an absent home keeps the current one, the pending flag included; the same value re-sent is a no-op', async () => {
    await seedDaemon(prisma, SOURCE, { capabilities: CAPS })
    const agentId = await seedHomed(PENDING)
    const saved = await patch(agentId, { memory: { provider: 'managed', autoDistill: true } })
    expect(saved.statusCode).toBe(200)
    expect(saved.json().memory).toEqual({
      provider: 'managed',
      autoDistill: true,
      home: 'control-plane',
      homeMigration: 'pending'
    })

    const settled = await seedHomed(CP)
    const same = await patch(settled, { memory: CP })
    expect(same.statusCode).toBe(200)
    expect(same.json().memory).toEqual(CP)
    // The managed default on a Control-Plane-homed agent keeps the home rather than silently reversing it.
    const cleared = await patch(settled, { memory: null })
    expect(cleared.json().memory).toEqual(CP)
  })

  it('daemon → control-plane persists the home and the pending flag in one write', async () => {
    await seedDaemon(prisma, SOURCE, { capabilities: CAPS })
    const agentId = await seedHomed(null)
    const res = await patch(agentId, { memory: { provider: 'managed', home: 'control-plane' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().memory).toEqual(PENDING)
    expect(await storedMemory(agentId)).toEqual(PENDING)
  })

  it('control-plane → daemon is refused without force, and with force drops the CP tree and change log', async () => {
    await seedDaemon(prisma, SOURCE, { capabilities: CAPS })
    const agentId = await seedHomed(PENDING)
    const other = await seedHomed(CP)
    const files = new PgAgentMemoryFileRepo(prisma)
    const history = new PgAgentMemoryHistoryRepo(prisma)
    const record = (): AgentMemoryHistoryInput => ({
      id: randomUUID(),
      path: 'MEMORY.md',
      event: 'add',
      after: 'x',
      at: new Date(),
      source: 'tool',
      bytes: 10
    })
    for (const id of [agentId, other]) {
      const temp = `memory/.tmp-${randomUUID()}`
      await files.append(AgentId(id), DEF_ORG, temp, Buffer.from('hello'), true, new Date())
      await files.commit(AgentId(id), 'memory/MEMORY.md', temp, undefined, new Date())
      await history.append(AgentId(id), DEF_ORG, 'memory', [record()], {
        maxVersionsPerFile: 10,
        maxBytesPerRoot: 1000
      })
    }

    const refused = await patch(agentId, { memory: DAEMON_HOME })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().message).toContain('force')
    expect(await storedMemory(agentId)).toEqual(PENDING)
    expect(await prisma.agentMemoryFile.count({ where: { agentId } })).toBe(1)

    const forced = await patch(agentId, { memory: DAEMON_HOME, force: true })
    expect(forced.statusCode).toBe(200)
    expect(forced.json().memory).toEqual(DAEMON_HOME)
    expect(await storedMemory(agentId)).toEqual(DAEMON_HOME)
    expect(await prisma.agentMemoryFile.count({ where: { agentId } })).toBe(0)
    expect(await prisma.agentMemoryHistory.count({ where: { agentId } })).toBe(0)
    // Only this agent's rows went.
    expect(await prisma.agentMemoryFile.count({ where: { agentId: other } })).toBe(1)
    expect(await prisma.agentMemoryHistory.count({ where: { agentId: other } })).toBe(1)
    // `force` alone is not an edit.
    expect((await patch(agentId, { force: true })).statusCode).toBe(400)
  })

  it('a provider round trip never migrates: away drops the home, back resolves as on create with no flag', async () => {
    await seedDaemon(prisma, SOURCE, { capabilities: CAPS })
    const agentId = await seedHomed(PENDING)
    const away = await patch(agentId, { memory: { provider: 'native' } })
    expect(away.json().memory).toEqual({ provider: 'native' })
    const back = await patch(agentId, { memory: { provider: 'managed', home: 'control-plane' } })
    expect(back.json().memory).toEqual(CP)
    // Once back in the Control Plane the ordinary rules apply again: a bare save keeps it, naming daemon needs force.
    expect((await patch(agentId, { memory: { provider: 'managed' } })).json().memory).toEqual(CP)
    const reverse = await patch(agentId, { memory: DAEMON_HOME })
    expect(reverse.statusCode).toBe(409)
    expect(reverse.json().message).toContain('force')
    const local = await patch(agentId, { memory: { provider: 'none' } })
    expect(local.json().memory).toEqual({ provider: 'none' })
    expect((await patch(agentId, { memory: { provider: 'managed' } })).json().memory).toEqual(DAEMON_HOME)
  })

  it('an agent on the pool can never name the daemon home, force or not', async () => {
    await seedDaemon(prisma, SOURCE, { capabilities: CAPS })
    await seedPoolMember()
    const agentId = await seedHomed(CP, { pool: true })
    expect((await patch(agentId, { memory: DAEMON_HOME })).statusCode).toBe(409)
    expect((await patch(agentId, { memory: DAEMON_HOME, force: true })).statusCode).toBe(409)
    expect((await patch(agentId, { memory: null })).json().memory).toEqual(CP)
    expect((await patch(agentId, { memory: { provider: 'managed', scope: 'channel' } })).json().memory).toEqual({
      ...CP,
      scope: 'channel'
    })
  })
})

describe('the home is resolved against the locked binding, not the caller’s earlier read', () => {
  const repo = () => new PgAgentRepo(prisma)
  const writer = () => new PgAgentConfigWriter(prisma, new PlaintextSecretCipher())

  it('a save that read a pending binding cannot restore the flag memory/home/migrated cleared meanwhile', async () => {
    await seedDaemon(prisma, SOURCE, { capabilities: CAPS })
    const agentId = AgentId(await seedHomed(PENDING))
    // The console read `PENDING`; the daemon's completion lands before its save commits.
    expect(await repo().settleMemoryHomeMigration(DEF_ORG, agentId)).toBe('cleared')
    // The save carries no flag of its own — it is resolved under the row lock, where the binding is already settled.
    const saved = await writer().update(
      DEF_ORG,
      agentId,
      { memory: { provider: 'managed', autoDistill: false, home: 'control-plane' } },
      undefined,
      { memoryHome: { input: { provider: 'managed', autoDistill: false }, onPool: false, force: false } }
    )
    expect(saved.memory).toEqual({ provider: 'managed', autoDistill: false, home: 'control-plane' })
    expect(await storedMemory(agentId)).toEqual({ provider: 'managed', autoDistill: false, home: 'control-plane' })
  })

  it('a reverse that was fine against the caller’s read is refused once the locked binding is the Control Plane', async () => {
    await seedDaemon(prisma, SOURCE, { capabilities: CAPS })
    const agentId = AgentId(await seedHomed(DAEMON_HOME))
    // Another edit switched the home after the caller read `daemon`.
    await repo().update(DEF_ORG, agentId, { memory: { provider: 'managed', home: 'control-plane' } })
    await expect(
      writer().update(DEF_ORG, agentId, { memory: DAEMON_HOME as never }, undefined, {
        memoryHome: { input: DAEMON_HOME as never, onPool: false, force: false }
      })
    ).rejects.toBeInstanceOf(MemoryHomeRefusedError)
    expect(await storedMemory(agentId)).toEqual(CP)
  })
})

describe('PUT /agents/:id/daemon — a daemon-home agent may not move onto the pool', () => {
  it('refuses the move until the home is switched, for the set and for a member alike', async () => {
    await seedDaemon(prisma, SOURCE, { capabilities: CAPS })
    await seedPoolMember()
    const agentId = await seedHomed(null)
    const onto = await app().app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/daemon`,
      payload: { placementKind: 'pool' }
    })
    expect(onto.statusCode).toBe(409)
    expect(onto.json().message).toContain('control-plane')
    const pinned = await running!.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/daemon`,
      payload: { daemonId: MEMBER }
    })
    expect(pinned.statusCode).toBe(409)
    expect(pinned.json().message).toContain('control-plane')
    expect(await prisma.agent.findUnique({ where: { id: agentId } })).toMatchObject({
      placementKind: 'daemon',
      daemonId: SOURCE
    })
  })
})

describe('GET /agents/:id/memory/history — a Control-Plane home is answered from the table', () => {
  it('pages newest first by cursor, per store, and needs no daemon', async () => {
    const agentId = randomUUID()
    // Unplaced on purpose: the daemon-home path would answer 503 here.
    await seedAgent(prisma, agentId, { runtimeOverrides: { memory: CP } })
    const history = new PgAgentMemoryHistoryRepo(prisma)
    const t = Date.parse('2026-09-08T12:00:00.000Z')
    const record = (path: string, atMs: number, after: string): AgentMemoryHistoryInput => ({
      id: randomUUID(),
      path,
      event: 'update',
      before: 'old',
      after,
      at: new Date(atMs),
      source: 'console',
      bytes: 10
    })
    const keep = { maxVersionsPerFile: 100, maxBytesPerRoot: 10_000 }
    await history.append(
      AgentId(agentId),
      DEF_ORG,
      'memory',
      [
        record('a.md', t + 1, 'v1'),
        record('a.md', t + 2, 'v2'),
        record('a.md', t + 3, 'v3'),
        record('b.md', t + 4, 'b')
      ],
      keep
    )
    await history.append(AgentId(agentId), DEF_ORG, 'channels/c1/memory', [record('a.md', t + 5, 'c')], keep)

    const first = await app().app.inject({
      method: 'GET',
      url: `${ORG}/agents/${agentId}/memory/history?path=a.md&limit=2`
    })
    expect(first.statusCode).toBe(200)
    expect(first.json().events.map((e: { after: string }) => e.after)).toEqual(['v3', 'v2'])
    expect(first.json().events[0]).toMatchObject({
      path: 'a.md',
      event: 'update',
      before: 'old',
      at: new Date(t + 3).toISOString(),
      scope: 'agent',
      source: 'console'
    })
    const cursor = first.json().nextCursor as string
    expect(cursor).toMatch(/^[0-9a-f-]{36}$/)

    const second = await running!.app.inject({
      method: 'GET',
      url: `${ORG}/agents/${agentId}/memory/history?path=a.md&limit=2&cursor=${cursor}`
    })
    expect(second.json()).toMatchObject({ nextCursor: null })
    expect(second.json().events.map((e: { after: string }) => e.after)).toEqual(['v1'])

    const channel = await running!.app.inject({
      method: 'GET',
      url: `${ORG}/agents/${agentId}/memory/history?path=a.md&channelKey=c1`
    })
    expect(channel.json().events.map((e: { after: string }) => e.after)).toEqual(['c'])
  })
})
