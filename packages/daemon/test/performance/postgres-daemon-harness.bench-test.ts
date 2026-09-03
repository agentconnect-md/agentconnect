import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'

import { LocalStore } from '../../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../../src/store/sqlite-async-database.js'
import { createPostgresDaemonHarness } from './postgres-daemon-harness.js'

async function localDataPlane(orgForAgent: (agentId: string) => string | undefined) {
  const store = await LocalStore.open({
    database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')),
    shared: true,
    ownerId: 'capacity-test-member',
    orgForAgent
  })
  return {
    store,
    close: async () => await store.close()
  }
}

describe('PostgreSQL daemon capacity harness', () => {
  it('runs distinct agents concurrently through the complete scripted lifecycle', async () => {
    const harness = await createPostgresDaemonHarness({
      concurrency: 2,
      streamDelayMs: 0,
      organizationId: 'benchmark-org',
      openDataPlane: async (orgForAgent) => localDataPlane(orgForAgent) as never
    })
    try {
      await expect(harness.runRung({ minTurns: 0, minWaves: 2, turnTimeoutMs: 1_000 })).rejects.toThrow('minTurns')
      const result = await harness.runRung({ minTurns: 4, minWaves: 2, turnTimeoutMs: 1_000 })

      expect(result.summary).toMatchObject({ concurrency: 2, attempted: 4, completed: 4, errors: 0, timeouts: 0 })
      expect(result.raw.waves).toBe(2)
      expect(result.raw.simulatedPauseMsPerTurn).toBe(0)
      expect(result.raw.turns.map((turn) => turn.agentId)).toEqual([
        'capacity-agent-001',
        'capacity-agent-002',
        'capacity-agent-001',
        'capacity-agent-002'
      ])
      expect(new Set(result.raw.turns.map((turn) => turn.conversationId)).size).toBe(2)
      expect(new Set(result.raw.turns.map((turn) => turn.turnId)).size).toBe(4)
      expect(result.raw.turns.every((turn) => turn.output === `answer:${turn.agentId}:${turn.promptOrdinal}`)).toBe(
        true
      )

      const observations = harness.observations()
      expect(observations.maxGlobalActive).toBe(2)
      expect(observations.maxPerAgentActive).toEqual({ 'capacity-agent-001': 1, 'capacity-agent-002': 1 })
      expect(observations.overlapViolations).toEqual([])
      expect(new Set(observations.sessionIds).size).toBe(2)
      expect(observations.newSessionCalls).toEqual({ 'capacity-agent-001': 1, 'capacity-agent-002': 1 })
      expect(observations.loadSessionCalls).toEqual({})
      expect(observations.discardSessionCalls).toEqual({})
      expect(observations.promptSessionIds).toEqual({
        'capacity-agent-001': Array.from({ length: 3 }, () => 'capacity-session-capacity-agent-001'),
        'capacity-agent-002': Array.from({ length: 3 }, () => 'capacity-session-capacity-agent-002')
      })
      expect(new Set(observations.toolIds).size).toBe(observations.toolIds.length)
      expect(observations.prompts).toHaveLength(6)
      for (const prompt of observations.prompts) {
        expect(prompt.updateKinds).toEqual([
          'agent_thought_chunk',
          ...Array.from({ length: 6 }, () => [
            'tool_call',
            ...Array.from({ length: 5 }, () => 'tool_call_update')
          ]).flat(),
          'agent_message_chunk'
        ])
        expect(prompt.pauseCount).toBe(38)
      }

      const verification = await harness.verification()
      expect(verification.completedOutputs).toBe(4)
      expect(verification.terminalSessions).toBe(2)
      expect(verification.reasoningRows).toBe(4)
      expect(verification.toolRows).toBe(24)
      expect(verification.resolvedOrganizationByAgent).toEqual({
        'capacity-agent-001': 'benchmark-org',
        'capacity-agent-002': 'benchmark-org'
      })
      expect(harness.plane.ensureChannelCalls).toEqual(expect.arrayContaining(harness.agentIds))
      await expect(harness.plane.withSandbox('capacity-agent-001', async () => 'held')).resolves.toBe('held')
      await expect(harness.plane.probeRuntimes()).resolves.toEqual({
        runtimes: [{ id: 'capacity-runtime', version: 'test', models: [] }]
      })
      await expect(harness.plane.clearPath('capacity-agent-001', '/workspace')).resolves.toBeUndefined()
      await expect(harness.plane.suspendIdle('capacity-agent-001')).resolves.toBe('absent')
      expect(harness.plane.runsInSandbox('capacity-agent-001')).toBe(true)
      expect(harness.plane.workspaceRootFor('capacity-agent-001')).toContain('sandbox-workspaces')
      expect(harness.plane.gitRunnerFor('capacity-agent-001')).toBeUndefined()
      expect(harness.plane.workspaceFilesFor('capacity-agent-001')).toBeUndefined()
      expect(harness.plane.memoryFsFor('capacity-agent-001')).toBeUndefined()
      expect(harness.plane.launched()).toEqual([])
      await expect(harness.plane.adoptAgent('capacity-agent-001')).resolves.toBeUndefined()
      expect(() => harness.plane.releaseAgent('capacity-agent-001')).not.toThrow()
      await expect(harness.plane.discardAgent('capacity-agent-001')).resolves.toBeUndefined()

      observations.prompts.length = 0
      observations.maxPerAgentActive['capacity-agent-001'] = 99
      expect(harness.observations().prompts).toHaveLength(6)
      expect(harness.observations().maxPerAgentActive['capacity-agent-001']).toBe(1)
    } finally {
      await Promise.all([harness.close(), harness.close()])
    }
    expect(harness.plane.stopped).toBe(true)
    expect(existsSync(harness.root)).toBe(false)
  }, 15_000)

  it('stops admitting waves after an error and drains before closing', async () => {
    const harness = await createPostgresDaemonHarness({
      concurrency: 2,
      streamDelayMs: 0,
      organizationId: 'benchmark-org',
      openDataPlane: async (orgForAgent) => localDataPlane(orgForAgent) as never,
      promptBehavior: ({ measured, agentId }) =>
        measured && agentId === 'capacity-agent-001'
          ? { kind: 'error', error: new Error('scripted failure') }
          : undefined
    })
    try {
      const result = await harness.runRung({ minTurns: 8, minWaves: 4, turnTimeoutMs: 1_000 })
      expect(result.summary.attempted).toBe(2)
      expect(result.summary.errors).toBe(1)
      expect(result.summary.completed + result.summary.errors + result.summary.timeouts).toBe(2)
      expect(result.raw.waves).toBe(1)
      await expect(harness.waitUntilIdle(1_000)).resolves.toBeUndefined()
    } finally {
      await harness.close()
    }
  }, 15_000)

  it('accounts for a timeout, stops admitting, and waits for the late turn to drain', async () => {
    const harness = await createPostgresDaemonHarness({
      concurrency: 2,
      streamDelayMs: 0,
      organizationId: 'benchmark-org',
      openDataPlane: async (orgForAgent) => localDataPlane(orgForAgent) as never,
      promptBehavior: ({ measured, agentId }) =>
        measured && agentId === 'capacity-agent-001' ? { kind: 'delay', delayMs: 200 } : undefined
    })
    try {
      const result = await harness.runRung({ minTurns: 8, minWaves: 4, turnTimeoutMs: 100 })
      expect(result.summary).toMatchObject({ attempted: 2, completed: 1, errors: 0, timeouts: 1 })
      expect(result.raw.waves).toBe(1)
      expect(result.raw.turns).toHaveLength(2)
      const observations = harness.observations()
      expect(observations.globalActive).toBe(0)
      expect(observations.prompts.filter((prompt) => prompt.measured).every((prompt) => prompt.pauseCount === 38)).toBe(
        true
      )
      expect(observations.overlapViolations).toEqual([])
    } finally {
      await harness.close()
    }
  }, 15_000)
})
