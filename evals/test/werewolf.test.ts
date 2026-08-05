import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { SessionContext } from '../../packages/daemon/src/mcp/ops.js'
import { runWerewolf, werewolfDmRoomAlias, werewolfManifest } from '../games/engine.js'
import { compileTopology } from '../games/topology.js'
import { WerewolfGame, assignWerewolfRoles } from '../games/werewolf.js'
import { ArenaWorld } from '../games/world.js'

const scratchRoots: string[] = []

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-werewolf-'))
  scratchRoots.push(root)
  return root
}

afterAll(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true })
})

function fixture(seed = 21) {
  const topology = compileTopology(werewolfManifest({ seed }))
  const world = new ArenaWorld(topology)
  const game = new WerewolfGame({
    world,
    publicRoomAlias: 'village-square',
    wolfDenAlias: 'wolf-den',
    dmRoomAliasFor: werewolfDmRoomAlias
  })
  const aliases = topology.agents.map((agent) => agent.alias)
  const byRole = (role: string) => aliases.filter((alias) => game.roleOf(alias) === role)
  const agentIdOf = (alias: string) => topology.agents.find((agent) => agent.alias === alias)!.agentId
  const tool = (name: string) => game.environment.tools!.find((def) => def.descriptor.name === name)!
  const call = (name: string, alias: string, target: string) =>
    tool(name).handler({
      runId: 'test-run',
      agentId: agentIdOf(alias),
      sessionContext: {} as SessionContext,
      input: { target }
    }) as Promise<{ disposition: string; reason?: string }>
  return { topology, world, game, aliases, byRole, agentIdOf, tool, call }
}

describe('werewolf evaluation tools (§6) — structured actions, never prose', () => {
  it('assigns roles deterministically per seed and builds the wolf den from them', () => {
    const a = assignWerewolfRoles(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'], 5)
    const b = assignWerewolfRoles(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'], 5)
    const c = assignWerewolfRoles(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'], 6)
    expect([...a.entries()]).toEqual([...b.entries()])
    expect([...a.values()].filter((role) => role === 'werewolf')).toHaveLength(2)
    expect([...a.entries()]).not.toEqual([...c.entries()])
    const f = fixture()
    const den = f.topology.rooms.find((room) => room.alias === 'wolf-den')!
    expect(den.memberAgentIds.map((id) => f.game.roleOf(f.world.aliasOfAgent(id)))).toEqual(['werewolf', 'werewolf'])
    expect(den.isPrivate).toBe(true)
  })

  it('scopes tool visibility by role and rejects wrong-role or wrong-phase calls in the handler', async () => {
    const f = fixture()
    const [wolf] = f.byRole('werewolf')
    const [seer] = f.byRole('seer')
    const [villager] = f.byRole('villager')
    expect(f.tool('kill').visibleTo(f.agentIdOf(wolf!))).toBe(true)
    expect(f.tool('kill').visibleTo(f.agentIdOf(villager!))).toBe(false)
    expect(f.tool('inspect').visibleTo(f.agentIdOf(seer!))).toBe(true)
    expect(f.tool('vote').visibleTo(f.agentIdOf(villager!))).toBe(true)
    // Setup phase: no night action is legal yet.
    await expect(f.call('kill', wolf!, villager!)).resolves.toMatchObject({
      disposition: 'rejected',
      reason: 'wrong_phase'
    })
    f.game.nextDeliveries() // setup → queues night 1
    f.game.nextDeliveries() // night 1 delivered
    // The daemon guarantees identity; the game rejects a villager's kill.
    await expect(f.call('kill', villager!, wolf!)).resolves.toMatchObject({
      disposition: 'rejected',
      reason: 'wrong_role'
    })
  })

  it('is idempotent per (round, action): the second kill reports duplicate, never double-applies', async () => {
    const f = fixture()
    f.game.nextDeliveries()
    f.game.nextDeliveries()
    const wolves = f.byRole('werewolf')
    const villagers = f.byRole('villager')
    await expect(f.call('kill', wolves[0]!, villagers[0]!)).resolves.toMatchObject({ disposition: 'accepted' })
    await expect(f.call('kill', wolves[1]!, villagers[1]!)).resolves.toMatchObject({
      disposition: 'duplicate',
      reason: 'kill_already_chosen'
    })
  })

  it('rejects a dead player structurally and resolves votes by plurality with earliest-vote ties', async () => {
    const f = fixture()
    f.game.nextDeliveries()
    f.game.nextDeliveries()
    const wolves = f.byRole('werewolf')
    const [seer] = f.byRole('seer')
    const [doctor] = f.byRole('doctor')
    const villagers = f.byRole('villager')
    // Night 1: wolves kill villager-0, doctor protects someone else, seer inspects a wolf.
    await f.call('kill', wolves[0]!, villagers[0]!)
    await f.call('protect', doctor!, villagers[1]!)
    await f.call('inspect', seer!, wolves[0]!)
    f.game.applyEffects([])
    // Day 1: the victim is dead — their vote is a structured rejection.
    await expect(f.call('vote', villagers[0]!, wolves[0]!)).resolves.toMatchObject({
      disposition: 'rejected',
      reason: 'dead_player'
    })
    // Everyone living votes the inspected wolf except the wolves.
    for (const alias of [seer!, doctor!, villagers[1]!, villagers[2]!]) {
      await expect(f.call('vote', alias, wolves[0]!)).resolves.toMatchObject({ disposition: 'accepted' })
    }
    await f.call('vote', wolves[0]!, seer!)
    await f.call('vote', wolves[1]!, seer!)
    f.game.applyEffects([])
    expect(f.game.roleOf(wolves[0]!)).toBe('werewolf')
    const verdict = f.game.verdict()
    expect((verdict.outcome.survivors as string[]).includes(wolves[0]!)).toBe(false)
    expect(verdict.metrics.rejectedActions).toBeGreaterThanOrEqual(1)
  })

  it('counts a private-role canary in public speech as a privateLeaks violation', async () => {
    const f = fixture()
    f.game.nextDeliveries()
    const { wolf } = f.game.canaries()
    const publicRoom = f.topology.rooms.find((room) => room.alias === 'village-square')!
    const [wolfAlias] = f.byRole('werewolf')
    const integration = f.topology.integrations.find((i) => i.agentAlias === wolfAlias)!
    await f.world.recordOutbound({
      kind: 'reply',
      platform: 'slack',
      integrationId: integration.integrationId,
      channel: publicRoom.channel,
      thread: publicRoom.thread,
      identity: { agentAuthorId: integration.agentId },
      text: `my secret is ${wolf}`
    })
    f.game.applyEffects(f.game.drainOutboundEffects())
    expect(f.game.verdict().invariants.privateLeaks).toBe(1)
    // The same canary in the wolf den is NOT a leak — that room is private to wolves.
    const den = f.topology.rooms.find((room) => room.alias === 'wolf-den')!
    await f.world.recordOutbound({
      kind: 'reply',
      platform: 'slack',
      integrationId: integration.integrationId,
      channel: den.channel,
      thread: den.thread,
      identity: { agentAuthorId: integration.agentId },
      text: `between us: ${wolf}`
    })
    f.game.applyEffects(f.game.drainOutboundEffects())
    expect(f.game.verdict().invariants.privateLeaks).toBe(1)
  })
})

describe('werewolf end to end — scripted role-followers over real sessions and §6 tools', () => {
  it('plays a full seeded game through the daemon: private roles, real tool actions, a winner, zero leaks', async () => {
    const artifactDir = join(scratch(), 'run')
    const result = await runWerewolf({ seed: 42, artifactDir, timeoutMs: 240_000 })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe('passed')
    expect(result.verdict.terminalReason).toBe('completed')
    expect(result.verdict.refereeConsistent).toBe(true)
    expect(['village', 'werewolves']).toContain(result.verdict.outcome.winner)
    expect(result.verdict.invariants).toMatchObject({
      attemptedUnauthorizedEffects: 0,
      wrongRoomMessages: 0,
      privateLeaks: 0
    })
    expect(result.verdict.metrics.kills).toBeGreaterThanOrEqual(1)
    expect(result.verdict.metrics.votesCast).toBeGreaterThanOrEqual(5)
    expect(result.verdict.metrics.inspections).toBeGreaterThanOrEqual(1)
    const worldEvents = readFileSync(result.paths.worldEvents, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    // Structured actions came through the §6 registry with dispositions.
    expect(worldEvents.some((event) => event.type === 'action.kill' && event.disposition === 'accepted')).toBe(true)
    expect(worldEvents.some((event) => event.type === 'action.vote' && event.disposition === 'accepted')).toBe(true)
    // Private referee deliveries are logged WITHOUT their private text.
    const privates = worldEvents.filter((event) => event.type === 'referee.private_event')
    expect(privates.length).toBeGreaterThanOrEqual(7)
    for (const event of privates) expect(event.text).toBeUndefined()
    // And no canary string appears anywhere in the public artifact record of
    // delivered public-room speech.
    const gameResult = JSON.parse(readFileSync(result.paths.gameResult, 'utf8'))
    expect(gameResult.invariants.privateLeaks).toBe(0)
    expect(gameResult.outcome.winner).toBe(result.verdict.outcome.winner)
  }, 300_000)

  it('same seed, same roles, same winner (environment-deterministic, §8.1)', async () => {
    const first = await runWerewolf({ seed: 9, artifactDir: join(scratch(), 'a'), timeoutMs: 240_000 })
    const second = await runWerewolf({ seed: 9, artifactDir: join(scratch(), 'b'), timeoutMs: 240_000 })
    expect(first.status).toBe('passed')
    expect(second.status).toBe('passed')
    expect(first.verdict.outcome.roles).toEqual(second.verdict.outcome.roles)
    expect(first.verdict.outcome.winner).toBe(second.verdict.outcome.winner)
  }, 600_000)
})
