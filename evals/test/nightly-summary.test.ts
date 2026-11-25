import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  caseDescriptions,
  needsAttention,
  pairedEffects,
  readAddons,
  readGames,
  readNightCollection,
  readProbe,
  readThreadChatter,
  readWebchatAddressed,
  renderMarkdown,
  singleTrialMisses,
  summarizeCells,
  type NightlyRun
} from '../nightly/summary.js'

const addonRow = (caseId: string, label: string, status: string, outcome?: number) => ({
  provider: { id: 'file://providers/agentconnect.ts', label },
  ...(outcome !== undefined ? { namedScores: { outcome } } : {}),
  response: { metadata: { caseId, status } }
})

const promptfoo = (rows: unknown[]) => ({ results: { results: rows } })

const run = (
  cells: NightlyRun['cells'],
  suites: NightlyRun['suites'] = [{ suite: 'addons', results: true }]
): NightlyRun => ({
  at: '2026-01-02T00:00:00.000Z',
  durationMs: 600_000,
  commit: 'abcdef1234567890',
  dirty: false,
  node: 'v26.0.0',
  subject: 'claude-agent-acp@1.0.0 · sonnet',
  repeat: 3,
  suites,
  cells
})

describe('nightly add-on targets', () => {
  it('holds treatments to 1 and the memory-off controls to 0', () => {
    const cells = summarizeCells(
      readAddons(
        promptfoo([
          addonRow('core-simple-instruction', 'raw-acp', 'passed', 1),
          addonRow('memory-cross-session-recall', 'daemon-core', 'passed', 0),
          addonRow('memory-cross-session-recall', 'memory-only', 'passed', 1),
          addonRow('memory-cross-session-recall', 'memory-only', 'agent_failed')
        ])
      )
    )
    expect(cells.map((cell) => [cell.caseId, cell.treatment, cell.mark, `${cell.met}/${cell.valid}`])).toEqual([
      ['core-simple-instruction', 'raw-acp', 'on-target', '1/1'],
      ['memory-cross-session-recall', 'daemon-core', 'on-target', '1/1'],
      ['memory-cross-session-recall', 'memory-only', 'below', '1/2']
    ])
  })

  it('flags a leaking control, keeps infrastructure errors out, and stops on a safety failure', () => {
    const cells = summarizeCells(
      readAddons(
        promptfoo([
          addonRow('memory-cross-session-recall', 'daemon-core', 'passed', 1),
          addonRow('core-simple-instruction', 'daemon-core', 'infra_error'),
          addonRow('core-simple-instruction', 'raw-acp', 'safety_failed')
        ])
      )
    )
    expect(cells.map((cell) => cell.mark)).toEqual(['below', 'no-valid', 'safety'])
    expect(cells[1]!.invalidReasons).toEqual(['infra_error'])
  })

  it('attaches a known cause so the cell does not raise an alert', () => {
    const [cell] = summarizeCells(
      readAddons(promptfoo([addonRow('core-simple-instruction', 'daemon-core', 'passed', 0)])),
      {
        'addons/core-simple-instruction/daemon-core': 'a cause already understood'
      }
    )
    expect(cell!.knownCause).toBe('a cause already understood')
    expect(needsAttention(run([cell!]))).toBe(false)
  })
})

describe('nightly game targets', () => {
  it('requires a completed game, treats an invariant violation as safety and an invalid game as no measurement', () => {
    const trials = readGames(
      'relay',
      promptfoo([
        { success: true, namedScores: { game: 1 }, response: { metadata: { caseId: 'relay-clean-v1' } } },
        { success: true, namedScores: { game: 0.67 }, response: { metadata: { caseId: 'relay-stale-v1' } } },
        {
          success: false,
          gradingResult: { reason: 'product-invariant violation (§9.2): wrongRoomMessages=1' },
          response: { metadata: { caseId: 'relay-duplicate-v1' } }
        },
        {
          success: false,
          gradingResult: { reason: 'invalid trial (§9.1): terminalReason=timeout' },
          response: { metadata: { caseId: 'relay-conflict-v1' } }
        }
      ])
    )
    expect(summarizeCells(trials).map((cell) => cell.mark)).toEqual(['on-target', 'below', 'safety', 'no-valid'])
    expect(trials[3]!.invalidReason).toBe('invalid trial (§9.1)')
  })
})

describe('nightly scenario and probe targets', () => {
  it('reads night collection, thread chatter and webchat addressing summaries', () => {
    const night = readNightCollection({
      replyLossByTrial: [
        { trial: 1, status: 'ok', lost: [] },
        { trial: 2, status: 'ok', lost: ['seer'] },
        { trial: 3, status: 'invalid', lost: [] }
      ]
    })
    expect(summarizeCells(night)[0]).toMatchObject({ mark: 'below', met: 1, valid: 2, trials: 3 })
    const chatter = readThreadChatter({
      records: [
        { scenario: 'ticketing', valid: true, unwantedReplies: 0, missedReplies: 0 },
        { scenario: 'ticketing', valid: true, unwantedReplies: 2, missedReplies: 0 },
        { scenario: 'named-without-tag', valid: false, errorCode: 'runtime_unavailable' }
      ]
    })
    expect(summarizeCells(chatter).map((cell) => [cell.caseId, cell.mark])).toEqual([
      ['ticketing', 'below'],
      ['named-without-tag', 'no-valid']
    ])
    const addressed = readWebchatAddressed({
      records: [{ scenario: 'mentioned-one', status: 'ok', missing: [], unwanted: [] }]
    })
    expect(summarizeCells(addressed)[0]!.mark).toBe('on-target')
  })

  it('needs every probe run to pass and ignores runs that measured nothing', () => {
    const trials = readProbe('coordinator-probe', {
      runs: [
        { scenario: 'ignore-peer', verdict: 'PASS' },
        { scenario: 'ignore-peer', verdict: 'DEGRADED' },
        { scenario: 'webchat-status', verdict: 'SKIPPED' },
        { scenario: 'greeting', verdict: 'UNAVAILABLE' }
      ]
    })
    expect(summarizeCells(trials).map((cell) => [cell.caseId, cell.mark])).toEqual([
      ['ignore-peer', 'below'],
      ['greeting', 'no-valid']
    ])
  })
})

describe('nightly report', () => {
  it('alerts on a missing suite or an unexplained miss, and lists misses first', () => {
    const cells = summarizeCells([
      ...readThreadChatter({ records: [{ scenario: 'ticketing', valid: true, unwantedReplies: 1, missedReplies: 0 }] }),
      ...readProbe('coordinator-probe', { runs: [{ scenario: 'ignore-peer', verdict: 'PASS' }] })
    ])
    const nightly = run(cells, [
      { suite: 'thread-chatter', results: true },
      { suite: 'coordinator-probe', results: true },
      { suite: 'relay', results: false }
    ])
    expect(needsAttention(nightly)).toBe(true)
    const markdown = renderMarkdown(nightly)
    expect(markdown).toContain('❌ 1 of 2 below target · 🛑 0 safety · ⚠️ 1 unmeasured')
    expect(markdown).toContain('⚠️ relay: no result file')
    expect(markdown).toContain('❌ thread-chatter · ticketing: 0/1')
    expect(markdown).toContain('✅ coordinator-probe 1/1')
    expect(markdown).not.toContain('ignore-peer')
  })

  it('collapses a suite of misses into one line and groups known misses apart from the alert', () => {
    const relay = Array.from({ length: 8 }, (_, index) => ({
      success: true,
      namedScores: { game: 0 },
      response: { metadata: { caseId: `relay-${index}` } }
    }))
    const cells = summarizeCells(
      [
        ...readGames('relay', promptfoo(relay)),
        ...readAddons(
          promptfoo([
            addonRow('core-simple-instruction', 'daemon-core', 'passed', 0),
            addonRow('memory-cross-session-recall', 'memory-only', 'passed', 0)
          ])
        )
      ],
      {
        'addons/core-simple-instruction/daemon-core': 'a cause already understood',
        'addons/memory-cross-session-recall/memory-only': 'a cause already understood'
      }
    )
    const markdown = renderMarkdown(
      run(cells, [
        { suite: 'relay', results: true },
        { suite: 'addons', results: true }
      ])
    )
    expect(markdown).toContain('❌ relay: all 8 cases below target')
    expect(markdown).not.toContain('relay-3')
    expect(markdown).toMatch(
      /\*Known, no alert\*\n❌ core-simple-instruction · daemon-core 0\/1, memory-cross-session-recall · memory-only 0\/1: /
    )
    expect(markdown).toContain('❌ relay 0/8')
  })

  it('alerts when a scenario entry failed to run even though every recorded cell is on target', () => {
    const cells = summarizeCells(
      readThreadChatter({ records: [{ scenario: 'ticketing', valid: true, unwantedReplies: 0, missedReplies: 0 }] })
    )
    const nightly = run(cells, [{ suite: 'thread-chatter', results: true, apparatusFailed: true }])
    expect(needsAttention(nightly)).toBe(true)
    const markdown = renderMarkdown(nightly)
    expect(markdown).not.toContain('✅ all')
    expect(markdown).toContain('⚠️ thread-chatter: a scenario failed to run, so its results may be incomplete')
  })

  it('says so when everything is on target', () => {
    const cells = summarizeCells(
      readProbe('send-message-probe', { runs: [{ scenario: 'origin-reply', verdict: 'PASS' }] })
    )
    const nightly = run(cells, [{ suite: 'send-message-probe', results: true }])
    expect(needsAttention(nightly)).toBe(false)
    expect(renderMarkdown(nightly)).toContain('✅ all 1 cells on target')
  })

  it('reports the add-on deltas over mean outcome', () => {
    const cells = summarizeCells(
      readAddons(
        promptfoo([
          addonRow('memory-cross-session-recall', 'daemon-core', 'passed', 0),
          addonRow('memory-cross-session-recall', 'memory-only', 'passed', 1),
          addonRow('memory-cross-session-recall', 'memory-only', 'passed', 0)
        ])
      )
    )
    expect(pairedEffects(cells)).toEqual([{ caseId: 'memory-cross-session-recall', memory: 0.5 }])
  })
})

describe('single-trial reruns', () => {
  const probe = (verdicts: string[], rerun?: boolean) =>
    readProbe('coordinator-probe', {
      runs: verdicts.map((verdict) => ({ scenario: 'elsewhere-read-task', verdict }))
    }).map((trial) => ({ ...trial, ...(rerun ? { rerun } : {}) }))

  it('reruns only a single-trial cell whose one valid trial missed without a safety failure', () => {
    const trials = [
      ...probe(['DEGRADED']),
      ...readProbe('coordinator-probe', {
        runs: [
          { scenario: 'ignore-peer', verdict: 'PASS' },
          { scenario: 'greeting', verdict: 'UNAVAILABLE' },
          { scenario: 'webchat-status', verdict: 'DEGRADED' },
          { scenario: 'webchat-status', verdict: 'PASS' }
        ]
      }),
      ...readGames('relay', promptfoo([{ success: false, gradingResult: { reason: 'product-invariant violation' } }]))
    ]
    expect(singleTrialMisses(trials)).toEqual(['elsewhere-read-task'])
  })

  it('reruns nothing when more than five cells of a suite missed', () => {
    const relay = Array.from({ length: 6 }, (_, index) => ({
      success: true,
      namedScores: { game: 0 },
      response: { metadata: { caseId: `relay-${index}` } }
    }))
    expect(singleTrialMisses(readGames('relay', promptfoo(relay)))).toEqual([])
    expect(singleTrialMisses(readGames('relay', promptfoo(relay.slice(1))))).toHaveLength(5)
  })

  it('keeps a miss that passed every rerun out of the alert and lists it apart', () => {
    const cells = summarizeCells([...probe(['DEGRADED']), ...probe(['PASS', 'PASS'], true)])
    expect(cells[0]).toMatchObject({ mark: 'below', met: 2, valid: 3, reproduced: false })
    const nightly = run(cells, [{ suite: 'coordinator-probe', results: true }])
    expect(needsAttention(nightly)).toBe(false)
    const markdown = renderMarkdown(nightly)
    expect(markdown).toContain('*Needs a look*\nnone')
    expect(markdown).toContain(
      '*Did not reproduce, no alert*\n❌ coordinator-probe · elsewhere-read-task: 2/3, missed once and passed every rerun'
    )
  })

  it('alerts when a rerun misses again or measured nothing', () => {
    for (const reruns of [probe(['PASS', 'DEGRADED'], true), probe(['UNAVAILABLE', 'UNAVAILABLE'], true), []]) {
      const cells = summarizeCells([...probe(['DEGRADED']), ...reruns])
      expect(cells[0]!.reproduced).not.toBe(false)
      expect(needsAttention(run(cells, [{ suite: 'coordinator-probe', results: true }]))).toBe(true)
    }
  })

  it('maps game case ids to the descriptions promptfoo filters by', () => {
    const document = promptfoo([
      {
        testCase: { description: 'Quota counting · each agent posts exactly 2' },
        response: { metadata: { caseId: 'counting-quota-v2' } }
      },
      { testCase: {}, response: { metadata: { caseId: 'relay-clean-v1' } } }
    ])
    expect([...caseDescriptions(document)]).toEqual([
      ['counting-quota-v2', 'Quota counting · each agent posts exactly 2']
    ])
  })
})

describe('checked-in Claude subject', () => {
  it('pins the ACP adapter release the sandbox image ships', () => {
    const root = resolve(__dirname, '../..')
    const dockerfile = readFileSync(resolve(root, 'docker/runtime-sandbox.Dockerfile'), 'utf8')
    const pinned = /^ARG CLAUDE_ACP_VERSION=(\S+)$/m.exec(dockerfile)?.[1]
    const config = JSON.parse(readFileSync(resolve(root, 'evals/subjects/claude/config.json'), 'utf8')) as {
      runtimes: Record<string, { args: string[] }>
    }
    expect(pinned).toBeTruthy()
    expect(config.runtimes['claude-acp']!.args).toContain(`@agentclientprotocol/claude-agent-acp@${pinned}`)
  })
})
