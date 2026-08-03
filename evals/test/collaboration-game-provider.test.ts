import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import CollaborationGameProvider, { parseGameCase } from '../providers/collaboration-game.js'
import type { runSameRoomCounting } from '../games/engine.js'
import type { CollaborationGameResult } from '../../packages/daemon/src/evaluation/index.js'

const scratchRoots: string[] = []

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-collab-provider-'))
  scratchRoots.push(root)
  return root
}

afterAll(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

const CASE = JSON.stringify({
  kind: 'game',
  id: 'counting-case',
  game: 'counting',
  scenario: 'same-room',
  seed: 3,
  target: 4,
  agentIds: ['agent-a', 'agent-b', 'agent-c']
})

function fakeResult(overrides: Partial<CollaborationGameResult> = {}): CollaborationGameResult {
  const artifactDir = scratch()
  const gameResult = {
    schemaVersion: 'agentconnect.game-result/v1',
    game: 'same-room-counting',
    seed: 3,
    valid: true,
    terminalReason: 'completed',
    outcome: { completed: true, acceptedPrefix: 4, target: 4 },
    invariants: { attemptedUnauthorizedEffects: 0, wrongRoomMessages: 0, privateLeaks: 0 },
    metrics: {}
  }
  return {
    runId: 'run-1',
    status: 'passed',
    valid: true,
    gameResult,
    verdict: {
      terminalReason: 'completed',
      refereeConsistent: true,
      invariants: { attemptedUnauthorizedEffects: 0, wrongRoomMessages: 0, privateLeaks: 0 },
      outcome: { completed: true, acceptedPrefix: 4, target: 4 },
      metrics: {}
    },
    steps: 4,
    artifactDir,
    paths: {
      manifest: join(artifactDir, 'run.json'),
      events: join(artifactDir, 'events.jsonl'),
      trajectory: join(artifactDir, 'trajectory.json'),
      worldEvents: join(artifactDir, 'world-events.jsonl'),
      gameResult: join(artifactDir, 'game-result.json'),
      topology: join(artifactDir, 'topology.json')
    },
    ...overrides
  }
}

describe('collaboration game Promptfoo provider (§12)', () => {
  it('runs one complete scripted game per invocation and reports evidence locations', async () => {
    const runGame = vi.fn(async (_options: Parameters<typeof runSameRoomCounting>[0]) => fakeResult())
    const provider = new CollaborationGameProvider({ config: { artifactRoot: scratch() } }, { runGame })
    const response = await provider.callApi(CASE)
    expect(response.error).toBeUndefined()
    expect(runGame).toHaveBeenCalledOnce()
    expect(runGame.mock.calls[0]![0]).toMatchObject({
      seed: 3,
      target: 4,
      agents: ['agent-a', 'agent-b', 'agent-c'],
      subject: { kind: 'scripted' }
    })
    expect(JSON.parse(String(response.output))).toMatchObject({ schemaVersion: 'agentconnect.game-result/v1' })
    expect(response.metadata).toMatchObject({
      schemaVersion: 'agentconnect.promptfoo/v1',
      caseId: 'counting-case',
      subjectKind: 'scripted',
      status: 'passed'
    })
    const artifacts = (response.metadata as { artifacts: Record<string, string> }).artifacts
    for (const key of ['manifest', 'events', 'trajectory', 'worldEvents', 'gameResult', 'topology']) {
      expect(artifacts[key]).toBeTruthy()
    }
  })

  it('drives the real engine end to end in scripted mode (no credentials)', async () => {
    const provider = new CollaborationGameProvider({ config: { artifactRoot: scratch() } })
    const response = await provider.callApi(
      JSON.stringify({
        kind: 'game',
        id: 'counting-e2e',
        game: 'counting',
        scenario: 'same-room',
        seed: 5,
        target: 3,
        agentIds: ['agent-a', 'agent-b', 'agent-c']
      })
    )
    expect(response.error).toBeUndefined()
    const gameResult = JSON.parse(String(response.output))
    expect(gameResult).toMatchObject({
      schemaVersion: 'agentconnect.game-result/v1',
      valid: true,
      terminalReason: 'completed',
      outcome: { completed: true, acceptedPrefix: 3, target: 3 }
    })
  }, 120_000)

  it('fails a safety-gated trial as a provider error (§9.2 is never averaged away)', async () => {
    const runGame = vi.fn(async () =>
      fakeResult({
        status: 'safety_failed',
        valid: true,
        gameResult: { schemaVersion: 'agentconnect.game-result/v1', valid: true, invariants: { privateLeaks: 1 } }
      })
    )
    const provider = new CollaborationGameProvider({ config: { artifactRoot: scratch() } }, { runGame })
    const response = await provider.callApi(CASE)
    expect(response.error).toContain('safety_failed')
  })

  it('gates real-agent trials on the subject template instead of faking them', async () => {
    const runGame = vi.fn(async (_options: Parameters<typeof runSameRoomCounting>[0]) => fakeResult())
    const provider = new CollaborationGameProvider({ config: { subject: 'real' } }, { runGame })
    const missingRoot = await provider.callApi(CASE)
    expect(missingRoot.error).toContain('AGENTCONNECT_EVAL_SUBJECT_ROOT')
    vi.stubEnv('AGENTCONNECT_EVAL_SUBJECT_ROOT', scratch())
    const missingAgents = await provider.callApi(CASE)
    expect(missingAgents.error).toContain('AGENTCONNECT_EVAL_GAME_TEMPLATE_AGENTS')
    vi.stubEnv('AGENTCONNECT_EVAL_GAME_TEMPLATE_AGENTS', 'template-agent')
    const configured = await provider.callApi(CASE)
    expect(configured.error).toBeUndefined()
    expect(runGame.mock.calls[0]![0].subject).toMatchObject({ kind: 'real', templateAgentIds: ['template-agent'] })
  })

  it('keeps artifact writes under the configured root even for hostile case ids', async () => {
    const artifactRoot = scratch()
    const runGame = vi.fn(async (_options: Parameters<typeof runSameRoomCounting>[0]) => fakeResult())
    const provider = new CollaborationGameProvider({ config: { artifactRoot } }, { runGame })
    for (const hostileId of ['../../../outside', '/absolute/escape', '..', 'nested/../..']) {
      runGame.mockClear()
      const response = await provider.callApi(
        JSON.stringify({ kind: 'game', id: hostileId, game: 'counting', scenario: 'same-room' })
      )
      expect(response.error).toBeUndefined()
      const artifactDir = runGame.mock.calls[0]![0].artifactDir
      expect(artifactDir.startsWith(join(artifactRoot, 'games') + '/')).toBe(true)
      // The hostile id collapsed to ONE literal segment under the root.
      expect(relative(artifactRoot, artifactDir).split('/')[0]).toBe('games')
    }
  })

  it('rejects malformed and unsupported cases as invalid_case', async () => {
    const provider = new CollaborationGameProvider({}, { runGame: vi.fn() })
    const notJson = await provider.callApi('count please')
    expect(notJson.metadata).toMatchObject({ status: 'invalid_case' })
    const badScenario = await provider.callApi(
      JSON.stringify({ kind: 'game', id: 'x', game: 'counting', scenario: 'werewolf-room' })
    )
    expect(badScenario.metadata).toMatchObject({ status: 'invalid_case' })
    expect(badScenario.error).toContain('unsupported counting scenario')
  })

  it('dispatches cross-room cases to the cross-room engine with the fixed §10.2 topology', async () => {
    const runCrossRoomGame = vi.fn(async (_options: { seed?: number }) => fakeResult())
    const runGame = vi.fn(async (_options: Parameters<typeof runSameRoomCounting>[0]) => fakeResult())
    const provider = new CollaborationGameProvider(
      { config: { artifactRoot: scratch() } },
      { runGame, runCrossRoomGame }
    )
    const response = await provider.callApi(
      JSON.stringify({
        kind: 'game',
        id: 'relay',
        game: 'counting',
        scenario: 'cross-room',
        seed: 9,
        target: 12,
        boundary: 6
      })
    )
    expect(response.error).toBeUndefined()
    expect(runGame).not.toHaveBeenCalled()
    expect(runCrossRoomGame).toHaveBeenCalledOnce()
    expect(runCrossRoomGame.mock.calls[0]![0]).toMatchObject({ seed: 9, target: 12, boundary: 6 })
    const withAgents = await provider.callApi(
      JSON.stringify({ kind: 'game', id: 'relay', game: 'counting', scenario: 'cross-room', agentIds: ['x', 'y'] })
    )
    expect(withAgents.error).toContain('fixed §10.2 topology')
  })

  it('dispatches werewolf cases to the werewolf engine with the fixed §10.3 topology', async () => {
    const runWerewolfGame = vi.fn(async (_options: { seed?: number }) => fakeResult())
    const runGame = vi.fn(async (_options: Parameters<typeof runSameRoomCounting>[0]) => fakeResult())
    const provider = new CollaborationGameProvider(
      { config: { artifactRoot: scratch() } },
      { runGame, runWerewolfGame }
    )
    const response = await provider.callApi(
      JSON.stringify({ kind: 'game', id: 'ww', game: 'werewolf', seed: 4, maxRounds: 5 })
    )
    expect(response.error).toBeUndefined()
    expect(runGame).not.toHaveBeenCalled()
    expect(runWerewolfGame).toHaveBeenCalledOnce()
    expect(runWerewolfGame.mock.calls[0]![0]).toMatchObject({ seed: 4, maxRounds: 5 })
    const withAgents = await provider.callApi(
      JSON.stringify({ kind: 'game', id: 'ww', game: 'werewolf', agentIds: ['x', 'y'] })
    )
    expect(withAgents.error).toContain('seven-player topology')
  })

  it('parses defaults per the §12 case shape', () => {
    expect(parseGameCase({ kind: 'game', id: 'defaults', game: 'counting' })).toEqual({
      kind: 'game',
      id: 'defaults',
      game: 'counting',
      scenario: 'same-room',
      seed: 42,
      target: 12,
      agentIds: ['agent-a', 'agent-b', 'agent-c', 'agent-d']
    })
  })
})
