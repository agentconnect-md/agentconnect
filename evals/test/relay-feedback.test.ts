import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { CrossPlatformRelayGame, relayManifest, runCrossPlatformRelay } from '../games/cross-platform-relay.js'
import {
  relayFixture,
  RELAY_VARIANTS,
  scoreRelayReport,
  scriptedRelayReport,
  type RelayVariant
} from '../games/relay-feedback.js'
import { compileTopology } from '../games/topology.js'
import { ArenaWorld } from '../games/world.js'
import { parseGameCase } from '../providers/collaboration-game.js'

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('relay scoring', () => {
  it('validates the complete twenty-case manifest with unique IDs and balanced variants', () => {
    const cases = parseYaml(readFileSync(join(process.cwd(), 'evals/cases/relay-feedback.yaml'), 'utf8')) as {
      vars: { case: string }
    }[]
    const parsed = cases.map((item) => parseGameCase(JSON.parse(item.vars.case)))
    expect(parsed).toHaveLength(20)
    expect(new Set(parsed.map((item) => item.id)).size).toBe(20)
    for (const variant of RELAY_VARIANTS) expect(parsed.filter((item) => item.variant === variant)).toHaveLength(5)
  })

  it.each(RELAY_VARIANTS)('scores %s without silently repairing the report', (variant) => {
    const fixture = relayFixture(compileTopology(relayManifest(7)), variant)
    const valid = scriptedRelayReport(fixture.task, fixture.feedback)
    expect(scoreRelayReport(fixture.task, fixture.feedback, variant, valid).successful).toBe(true)
    expect(
      scoreRelayReport(fixture.task, fixture.feedback, variant, { ...valid, sourceId: 'another-request' }).successful
    ).toBe(false)
    expect(scoreRelayReport(fixture.task, fixture.feedback, variant, { ...valid, evidenceIds: [] }).successful).toBe(
      false
    )
    expect(
      scoreRelayReport(fixture.task, fixture.feedback, variant, {
        ...valid,
        evidenceIds: [...valid.evidenceIds, 'invented-approval']
      }).successful
    ).toBe(false)
  })

  it.each(RELAY_VARIANTS)('scores revision 2 and rejects superseded feedback for %s', (variant) => {
    const { task, feedback } = relayFixture(compileTopology(relayManifest(7)), variant)
    const previous = scriptedRelayReport(task, feedback)
    const revised = feedback.map((item) => ({
      ...item,
      id: `${item.id}-revised`,
      revision: item.revision + 1,
      quantity: item.quantity + 10,
      format: 'markdown'
    }))
    const combined = [...feedback, ...revised, ...feedback]
    const current = revised.filter((item) => item.revision === 2)
    const valid = {
      caseId: task.caseId,
      sourceId: task.sourceId,
      status: variant === 'conflict' ? 'needs_clarification' : 'completed',
      ...(variant !== 'conflict' ? { quantity: current[0]!.quantity, format: 'markdown' } : {}),
      evidenceIds: [...new Set(current.map((item) => item.id))]
    }
    expect(scriptedRelayReport(task, combined)).toEqual(valid)
    expect(scoreRelayReport(task, combined, variant, valid).successful).toBe(true)
    expect(scoreRelayReport(task, combined, variant, previous).successful).toBe(false)
    expect(
      scoreRelayReport(task, combined, variant, { ...valid, evidenceIds: previous.evidenceIds }).evidenceCorrect
    ).toBe(false)
    if (variant !== 'conflict') {
      expect(
        scoreRelayReport(task, combined, variant, { ...valid, quantity: previous.quantity }).requirementsSatisfied
      ).toBe(false)
      expect(
        scoreRelayReport(task, combined, variant, { ...valid, format: previous.format }).requirementsSatisfied
      ).toBe(false)
    }
  })

  it('rejects adopting stale feedback, duplicate citations, and fabricated conflict resolution', () => {
    for (const variant of ['stale', 'duplicate', 'conflict'] as const) {
      const { task, feedback } = relayFixture(compileTopology(relayManifest(42)), variant)
      const valid = scriptedRelayReport(task, feedback)
      const invalid =
        variant === 'stale'
          ? { ...valid, quantity: task.quantity, format: task.format }
          : variant === 'duplicate'
            ? { ...valid, evidenceIds: [...valid.evidenceIds, ...valid.evidenceIds] }
            : { ...valid, status: 'completed', quantity: feedback[0]!.quantity, format: feedback[0]!.format }
      expect(scoreRelayReport(task, feedback, variant, invalid).successful).toBe(false)
    }
  })

  it.each([undefined, null, [], 'completed', {}, { evidenceIds: 'feedback-1' }])(
    'fails closed on malformed reports: %j',
    (raw) => {
      const { task, feedback } = relayFixture(compileTopology(relayManifest(42)), 'clean')
      expect(scoreRelayReport(task, feedback, 'clean', raw).successful).toBe(false)
    }
  )

  it('validates relay provider inputs', () => {
    expect(parseGameCase({ kind: 'game', id: 'relay-1', game: 'relay' })).toMatchObject({
      game: 'relay',
      variant: 'clean'
    })
    for (const field of [
      { variant: 'unknown' },
      { seed: -1 },
      { timeoutMs: 0 },
      { target: 100 },
      { agentIds: ['other'] }
    ]) {
      expect(() => parseGameCase({ kind: 'game', id: 'relay-1', game: 'relay', ...field })).toThrow()
    }
  })
})

function fixture(variant: RelayVariant = 'clean') {
  const topology = compileTopology(relayManifest(7))
  const world = new ArenaWorld(topology)
  const game = new CrossPlatformRelayGame(world, variant)
  const origin = topology.rooms.find((room) => room.alias === 'discord-origin')!
  const review = topology.rooms.find((room) => room.alias === 'slack-review')!
  const post = async (alias: string, room: typeof origin, text: string, thread?: string) => {
    const integration = topology.integrations.find((i) => i.agentAlias === alias && i.platform === room.platform)!
    await world.recordOutbound({
      kind: 'reply',
      platform: room.platform,
      integrationId: integration.integrationId,
      channel: room.channel,
      ...(thread !== undefined ? { thread } : {}),
      identity: { agentAuthorId: integration.agentId },
      text
    })
    game.applyEffects(game.drainOutboundEffects())
  }
  return { world, game, origin, review, post }
}

describe('relay referee', () => {
  it('does not introduce feedback until an actual, correctly addressed request arrives', async () => {
    const f = fixture()
    f.game.nextDeliveries()
    expect(f.game.nextDeliveries().platformEvents).toHaveLength(0)
    await f.post('bridge', f.origin, `RELAY_REQUEST ${JSON.stringify(f.game.fixture.task)}`)
    expect(f.game.nextDeliveries().platformEvents).toHaveLength(0)
    expect(f.game.verdict().metrics.wrongAddress).toBe(1)
    await f.post('bridge', f.review, `RELAY_REQUEST ${JSON.stringify(f.game.fixture.task)}`)
    expect(f.game.nextDeliveries().platformEvents[0]!.payload.text).toContain('RELAY_REVIEW_FIXTURE')
  })

  it('rejects wrong-thread returns and reports before feedback, then accepts a full evidence loop', async () => {
    const f = fixture()
    f.game.nextDeliveries()
    const report = scriptedRelayReport(f.game.fixture.task, f.game.fixture.feedback)
    await f.post('bridge', f.origin, `RELAY_REPORT ${JSON.stringify(report)}`)
    expect(f.game.verdict().outcome.completed).toBe(false)
    await f.post('bridge', f.review, `RELAY_REQUEST ${JSON.stringify(f.game.fixture.task)}`)
    await f.post('reviewer', f.review, `RELAY_FEEDBACK ${JSON.stringify(f.game.fixture.feedback)}`)
    await f.post('bridge', f.origin, `RELAY_REPORT ${JSON.stringify(report)}`, f.origin.thread)
    expect(f.game.verdict().outcome.completed).toBe(false)
    await f.post('bridge', f.origin, `RELAY_REPORT ${JSON.stringify(report)}`)
    expect(f.game.verdict().outcome).toMatchObject({ completed: true, taskCompleted: true, acceptedPrefix: 3 })
  })

  it('records a delivered but incorrect report as a valid failed outcome', async () => {
    const f = fixture('conflict')
    f.game.nextDeliveries()
    await f.post('bridge', f.review, `RELAY_REQUEST ${JSON.stringify(f.game.fixture.task)}`)
    await f.post('reviewer', f.review, `RELAY_FEEDBACK ${JSON.stringify(f.game.fixture.feedback)}`)
    await f.post(
      'bridge',
      f.origin,
      `RELAY_REPORT ${JSON.stringify({ ...scriptedRelayReport(f.game.fixture.task, f.game.fixture.feedback), status: 'completed' })}`
    )
    expect(f.game.verdict()).toMatchObject({
      terminalReason: 'incorrect_report',
      outcome: { completed: false },
      metrics: { invalidReports: 1 }
    })
  })
})

describe('relay real daemon path with scripted ACP hosts', () => {
  it.each(RELAY_VARIANTS)(
    'runs %s through real sendMessage and records evidence',
    async (variant) => {
      const root = mkdtempSync(join(tmpdir(), 'ac-relay-e2e-'))
      roots.push(root)
      const result = await runCrossPlatformRelay({ seed: 7, variant, artifactDir: root })
      expect(result.error).toBeUndefined()
      expect(result.valid).toBe(true)
      expect(result.verdict.outcome).toMatchObject({
        completed: true,
        taskCompleted: variant !== 'conflict',
        clarificationReported: variant === 'conflict'
      })
      expect(result.verdict.metrics).toMatchObject({
        requestDelivered: 1,
        feedbackDelivered: 1,
        reportDelivered: 1,
        invalidReports: 0
      })
    },
    180_000
  )
})
