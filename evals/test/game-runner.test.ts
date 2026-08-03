import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runSameRoomCounting } from '../games/engine.js'

const scratchRoots: string[] = []

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-arena-artifacts-'))
  scratchRoots.push(root)
  return root
}

afterAll(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true })
})

describe('collaboration game runner — same-room counting with scripted hosts', () => {
  it('completes the counting game through the real daemon and writes all six coherent artifacts', async () => {
    const artifactDir = join(scratch(), 'run-1')
    const result = await runSameRoomCounting({ seed: 42, target: 12, artifactDir, timeoutMs: 90_000 })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe('passed')
    expect(result.valid).toBe(true)
    expect(result.verdict.terminalReason).toBe('completed')
    expect(result.verdict.refereeConsistent).toBe(true)
    expect(result.verdict.outcome).toMatchObject({ completed: true, acceptedPrefix: 12, target: 12 })
    // §9.2 hard gates: zero attempted violations.
    expect(result.verdict.invariants).toMatchObject({
      attemptedUnauthorizedEffects: 0,
      wrongRoomMessages: 0,
      privateLeaks: 0
    })

    // Existing artifact layers.
    for (const path of [result.paths.manifest, result.paths.events, result.paths.trajectory]) {
      expect(existsSync(path)).toBe(true)
    }
    const manifest = JSON.parse(readFileSync(result.paths.manifest, 'utf8'))
    expect(manifest).toMatchObject({
      schemaVersion: 'agentconnect.eval-run/v1',
      caseId: 'same-room-counting',
      status: 'passed'
    })

    // New game artifact layers (§11).
    const gameResult = JSON.parse(readFileSync(result.paths.gameResult, 'utf8'))
    expect(gameResult).toMatchObject({
      schemaVersion: 'agentconnect.game-result/v1',
      game: 'same-room-counting',
      seed: 42,
      mode: 'deterministic',
      subjectKind: 'scripted',
      valid: true,
      terminalReason: 'completed',
      outcome: { completed: true, acceptedPrefix: 12, target: 12 }
    })

    const topology = JSON.parse(readFileSync(result.paths.topology, 'utf8'))
    expect(topology.aliasMap.agents['agent-a']).toMatch(/^[0-9a-f-]{36}$/)
    expect(topology.aliasMap.rooms['counting-room'].channel).toMatch(/^C[A-Z0-9]{10}$/)

    const worldEvents = readFileSync(result.paths.worldEvents, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    // Monotonic sequence over the unified stream.
    const sequences = worldEvents.map((event) => event.sequence)
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences)
    // The referee accepted exactly 1..12, and never the same agent twice in a row.
    const acceptedCandidates = worldEvents.filter((event) => event.type === 'count.candidate' && event.accepted)
    expect(acceptedCandidates.map((event) => event.value)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    for (let i = 1; i < acceptedCandidates.length; i++) {
      expect(acceptedCandidates[i].agentId).not.toBe(acceptedCandidates[i - 1].agentId)
    }
    // Referee room events are tagged origin: 'referee' (§4.2 exclusion rule).
    expect(worldEvents.some((event) => event.origin === 'referee' && event.type === 'referee.room_event')).toBe(true)
    // Concurrent fan-out: waves address every member integration.
    const waves = worldEvents.filter((event) => event.type === 'wave')
    expect(waves.length).toBeGreaterThanOrEqual(12)
    expect(waves[0].platformEvents).toHaveLength(4)
    // Wave admissions: every injected copy was admitted through real routing.
    for (const wave of waves) {
      for (const admission of wave.admissions) expect(admission.admitted).toBe(true)
    }
    // Collisions happened (all four agents propose every round) and were scored.
    expect(gameResult.metrics.collisions).toBeGreaterThan(0)
  }, 120_000)

  it('peer-driven variant (§3.3): agents continue the count from EACH OTHER, the referee only starts and validates', async () => {
    const artifactDir = join(scratch(), 'peer-run')
    const result = await runSameRoomCounting({
      seed: 11,
      target: 6,
      artifactDir,
      variant: 'peer-driven',
      timeoutMs: 90_000
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe('passed')
    expect(result.verdict.terminalReason).toBe('completed')
    expect(result.verdict.outcome).toMatchObject({
      completed: true,
      variant: 'peer-driven',
      acceptedPrefix: 6,
      target: 6
    })
    expect(result.verdict.invariants).toMatchObject({
      attemptedUnauthorizedEffects: 0,
      wrongRoomMessages: 0,
      privateLeaks: 0
    })
    const worldEvents = readFileSync(result.paths.worldEvents, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    // The referee speaks exactly once (the start message); every subsequent
    // wave's ingress is a PEER message relay.
    expect(worldEvents.filter((event) => event.type === 'referee.room_event')).toHaveLength(1)
    const relays = worldEvents.filter((event) => event.type === 'peer.relay')
    expect(relays.length).toBeGreaterThanOrEqual(6)
    // Every accepted number after 1 was posted in response to peer ingress:
    // waves after the first contain only relay message ids.
    const waves = worldEvents.filter((event) => event.type === 'wave')
    const relayMessageIds = new Set(relays.map((event) => event.messageId))
    for (const wave of waves.slice(1)) {
      for (const event of wave.platformEvents as { messageId: string }[]) {
        expect(relayMessageIds.has(event.messageId)).toBe(true)
      }
      for (const admission of wave.admissions as { admitted: boolean }[]) {
        expect(admission.admitted).toBe(true)
      }
    }
  }, 120_000)

  it('classifies a game stalled by failing turns as infra_error, never a passed trial (§9.1)', async () => {
    // A subject whose host cannot complete any turn (e.g. an unreachable model)
    // must invalidate the trial — the scripted default is replaced by a
    // scripted-shaped subject whose runtime rejects every prompt.
    const { CollaborationGameRunner } = await import('../../packages/daemon/src/evaluation/index.js')
    const { compileTopology } = await import('../games/topology.js')
    const { ArenaWorld } = await import('../games/world.js')
    const { CountingGame } = await import('../games/counting.js')
    const { countingManifest, scaffoldSubject } = await import('../games/engine.js')
    const topology = compileTopology(countingManifest({ seed: 3, agents: ['agent-a', 'agent-b'] }))
    const world = new ArenaWorld(topology)
    const game = new CountingGame({ world, roomAlias: 'counting-room', target: 3 })
    const subject = scaffoldSubject(topology)
    try {
      const runner = new CollaborationGameRunner({
        root: subject.root,
        world: game,
        artifactDir: join(scratch(), 'failing'),
        game: 'same-room-counting',
        seed: 3,
        mode: 'deterministic',
        subjectKind: 'scripted',
        hostFactory: ((agent: { id: string }) => ({
          start: async () => {},
          newSession: async () => `failing-${agent.id.slice(0, 8)}`,
          hasSession: () => true,
          modelOptions: () => ({ current: 'failing', models: ['failing'] }),
          prompt: async () => {
            throw new Error('model unreachable')
          },
          cancel: async () => {},
          stop: async () => {}
        })) as never,
        capabilityProfile: { memory: 'off', collaboration: 'configured' },
        limits: { maxSteps: 6, timeoutMs: 60_000 },
        agents: topology.agents.map((agent) => ({ agentId: agent.agentId, name: agent.alias }))
      })
      const result = await runner.run()
      expect(result.status).toBe('infra_error')
      expect(result.valid).toBe(false)
      expect(result.error?.code).toBe('TURN_FAILURES')
      expect(result.verdict.outcome).toMatchObject({ completed: false })
    } finally {
      subject.cleanup()
    }
  }, 120_000)

  it('is environment-deterministic (§8.1): same seed, same world, same reproducible outcome', async () => {
    const first = await runSameRoomCounting({
      seed: 7,
      target: 5,
      artifactDir: join(scratch(), 'a'),
      timeoutMs: 90_000
    })
    const second = await runSameRoomCounting({
      seed: 7,
      target: 5,
      artifactDir: join(scratch(), 'b'),
      timeoutMs: 90_000
    })
    expect(first.status).toBe('passed')
    expect(second.status).toBe('passed')
    // The scripted-host OUTCOME is reproducible. WITHIN a wave the arrival
    // order of concurrent turns follows runtime scheduling ("first valid
    // arrival wins", §8.1), so per-number scorer identity is explainable via
    // the recorded sequence log rather than guaranteed identical.
    for (const result of [first, second]) {
      expect(result.verdict.outcome).toMatchObject({ completed: true, acceptedPrefix: 5, target: 5 })
      expect(result.verdict.refereeConsistent).toBe(true)
    }
    // Environment determinism: identical compiled topologies for equal seeds.
    const topologyA = JSON.parse(readFileSync(first.paths.topology, 'utf8'))
    const topologyB = JSON.parse(readFileSync(second.paths.topology, 'utf8'))
    expect(topologyA).toEqual(topologyB)
  }, 180_000)
})
