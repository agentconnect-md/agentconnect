// Pure readers, targets and report for `pnpm eval:nightly`; loaded by plain Node, so erasable syntax and no workspace imports.

export const NIGHTLY_SCHEMA_VERSION = 'agentconnect.eval-nightly/v2' as const

export const SUITES = [
  'addons',
  'counting',
  'relay',
  'night-collection',
  'thread-chatter',
  'webchat-addressed',
  'coordinator-probe',
  'send-message-probe'
] as const

export type SuiteId = (typeof SUITES)[number]

/** One measurement. An invalid trial measured nothing and never counts for or against a target. */
export interface Trial {
  suite: SuiteId
  caseId: string
  treatment?: string
  valid: boolean
  /** The trial met its target (valid trials only). */
  met?: boolean
  safety?: boolean
  score?: number
  invalidReason?: string
}

export type Mark = 'on-target' | 'below' | 'safety' | 'no-valid'

export interface Cell {
  suite: SuiteId
  caseId: string
  treatment?: string
  trials: number
  valid: number
  met: number
  safety: number
  meanScore?: number
  mark: Mark
  knownCause?: string
  invalidReasons: string[]
}

/** Add-on cells whose target is 0: the treatment lacks the capability, so a pass means the control leaked. */
const ADDON_CONTROLS = new Set(['memory-cross-session-recall/daemon-core', 'memory-collab-handoff/daemon-core'])

/** Causes already understood; a cell below target for one of these does not raise an alert. */
export const KNOWN_CAUSES: Record<string, string> = {
  'addons/collab-delivery-reply/daemon-core':
    'the add-on runner loads no collaboration routes, so callAgent is refused',
  'addons/memory-collab-handoff/memory-only':
    'the add-on runner loads no collaboration routes, so callAgent is refused',
  'counting/counting-quota-v1':
    'the loop guard admits 8 automatic turns per agent a minute, and whoever posts 12 has seen 9 peer posts by then'
}

const ADDON_VALID = new Set(['passed', 'agent_failed', 'safety_failed'])

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function promptfooRows(document: unknown): Record<string, unknown>[] {
  return list(record(record(document).results).results).map(record)
}

function rowCaseId(row: Record<string, unknown>, index: number): string {
  return (
    text(record(record(row.response).metadata).caseId) ??
    text(record(row.testCase).description) ??
    `test-${String(row.testIdx ?? index)}`
  )
}

/** Add-on suite: target 1 for every cell except the memory-off controls, whose target is 0. */
export function readAddons(document: unknown): Trial[] {
  return promptfooRows(document).map((row, index) => {
    const caseId = rowCaseId(row, index)
    const provider = record(row.provider)
    const treatment = text(provider.label) ?? String(provider.id ?? 'unknown')
    const status = text(record(record(row.response).metadata).status) ?? (row.error ? 'grader_error' : 'passed')
    if (!ADDON_VALID.has(status)) return { suite: 'addons', caseId, treatment, valid: false, invalidReason: status }
    const score = status === 'passed' ? (finite(record(row.namedScores).outcome) ?? 0) : 0
    const target = ADDON_CONTROLS.has(`${caseId}/${treatment}`) ? 0 : 1
    return {
      suite: 'addons',
      caseId,
      treatment,
      valid: true,
      met: score === target,
      score,
      ...(status === 'safety_failed' ? { safety: true } : {})
    }
  })
}

/** Game suites: target is a completed game (score 1); a failed assertion is an invalid game or an invariant violation. */
export function readGames(suite: 'counting' | 'relay', document: unknown): Trial[] {
  return promptfooRows(document).map((row, index) => {
    const caseId = rowCaseId(row, index)
    const grading = record(row.gradingResult)
    const reason = text(grading.reason) ?? text(row.error) ?? 'no game result'
    const passed = typeof row.success === 'boolean' ? row.success : grading.pass === true
    if (!passed) {
      if (reason.includes('product-invariant violation')) {
        return { suite, caseId, valid: true, met: false, safety: true, score: 0 }
      }
      return { suite, caseId, valid: false, invalidReason: reason.split(':')[0]!.slice(0, 80) }
    }
    const score = finite(record(row.namedScores).game) ?? 0
    return { suite, caseId, valid: true, met: score >= 1, score }
  })
}

/** Night collection: each valid trial must lose no child reply. */
export function readNightCollection(summary: unknown): Trial[] {
  return list(record(summary).replyLossByTrial).map((raw) => {
    const row = record(raw)
    if (row.status !== 'ok') {
      return { suite: 'night-collection', caseId: 'night-1', valid: false, invalidReason: String(row.status) }
    }
    const lost = list(row.lost).length
    return { suite: 'night-collection', caseId: 'night-1', valid: true, met: lost === 0, score: lost }
  })
}

/** Thread chatter (#4186): no reply to people's chatter and none missed where the agent was addressed. */
export function readThreadChatter(summary: unknown): Trial[] {
  return list(record(summary).records).map((raw) => {
    const row = record(raw)
    const caseId = text(row.scenario) ?? 'unknown'
    if (row.valid !== true) {
      return { suite: 'thread-chatter', caseId, valid: false, invalidReason: text(row.errorCode) ?? String(row.status) }
    }
    const unwanted = finite(row.unwantedReplies) ?? 0
    const missed = finite(row.missedReplies) ?? 0
    return { suite: 'thread-chatter', caseId, valid: true, met: unwanted === 0 && missed === 0 }
  })
}

/** Webchat addressing (#2865): exactly the addressed seats answer. */
export function readWebchatAddressed(summary: unknown): Trial[] {
  return list(record(summary).records).map((raw) => {
    const row = record(raw)
    const caseId = text(row.scenario) ?? 'unknown'
    if (row.status !== 'ok') {
      return { suite: 'webchat-addressed', caseId, valid: false, invalidReason: text(row.invalidReason) ?? 'invalid' }
    }
    return {
      suite: 'webchat-addressed',
      caseId,
      valid: true,
      met: list(row.missing).length === 0 && list(row.unwanted).length === 0
    }
  })
}

/** Runtime-matrix probes: one cell per scenario, every run must PASS; SKIPPED and INFO runs measure nothing. */
export function readProbe(suite: 'coordinator-probe' | 'send-message-probe', report: unknown): Trial[] {
  return list(record(report).runs).flatMap((raw): Trial[] => {
    const run = record(raw)
    const caseId = text(run.scenario) ?? 'unknown'
    const verdict = text(run.verdict) ?? 'UNKNOWN'
    if (verdict === 'SKIPPED' || verdict === 'INFO') return []
    if (verdict === 'UNAVAILABLE' || verdict === 'UNKNOWN')
      return [{ suite, caseId, valid: false, invalidReason: verdict }]
    return [{ suite, caseId, valid: true, met: verdict === 'PASS' }]
  })
}

export function cellKey(cell: Pick<Cell, 'suite' | 'caseId' | 'treatment'>): string {
  return [cell.suite, cell.caseId, cell.treatment].filter(Boolean).join('/')
}

/** A cell is on target only if every valid trial met it. */
export function summarizeCells(trials: readonly Trial[]): Cell[] {
  const groups = new Map<string, Trial[]>()
  for (const trial of trials) groups.set(cellKey(trial), [...(groups.get(cellKey(trial)) ?? []), trial])
  return [...groups.entries()].map(([key, group]) => {
    const valid = group.filter((trial) => trial.valid)
    const met = valid.filter((trial) => trial.met).length
    const safety = valid.filter((trial) => trial.safety).length
    const scores = valid.flatMap((trial) => (trial.score !== undefined ? [trial.score] : []))
    const mark: Mark =
      safety > 0 ? 'safety' : valid.length === 0 ? 'no-valid' : met === valid.length ? 'on-target' : 'below'
    return {
      suite: group[0]!.suite,
      caseId: group[0]!.caseId,
      ...(group[0]!.treatment ? { treatment: group[0]!.treatment } : {}),
      trials: group.length,
      valid: valid.length,
      met,
      safety,
      ...(scores.length > 0 ? { meanScore: scores.reduce((sum, value) => sum + value, 0) / scores.length } : {}),
      mark,
      ...(mark === 'below' && KNOWN_CAUSES[key] ? { knownCause: KNOWN_CAUSES[key] } : {}),
      invalidReasons: [...new Set(group.flatMap((trial) => (trial.invalidReason ? [trial.invalidReason] : [])))]
    }
  })
}

export interface SuiteRun {
  suite: SuiteId
  /** The suite wrote a readable result file. */
  results: boolean
  /** A scenario entry exited on an apparatus error, so its summary may be missing scenarios. */
  apparatusFailed?: boolean
}

export interface NightlyRun {
  at: string
  durationMs: number
  commit: string
  dirty: boolean
  node: string
  subject: string
  repeat: number
  suites: SuiteRun[]
  cells: Cell[]
}

/** Someone should look: a suite measured nothing, a cell has no valid trial, or a cell failed for an unknown reason. */
export function needsAttention(run: NightlyRun): boolean {
  return (
    run.suites.some((suite) => !suite.results || suite.apparatusFailed) ||
    run.cells.some(
      (cell) => cell.mark === 'safety' || cell.mark === 'no-valid' || (cell.mark === 'below' && !cell.knownCause)
    )
  )
}

const MARK: Record<Mark, string> = { 'on-target': '✅', below: '❌', safety: '🛑', 'no-valid': '⚠️' }

function cellName(cell: Cell): string {
  return [cell.caseId, cell.treatment].filter(Boolean).join(' · ')
}

/** Add-on deltas over mean outcome: core = daemon-core − raw-acp, memory = memory-only − daemon-core. */
export function pairedEffects(cells: readonly Cell[]): { caseId: string; core?: number; memory?: number }[] {
  const byCase = new Map<string, Record<string, number>>()
  for (const cell of cells) {
    if (cell.suite !== 'addons' || cell.meanScore === undefined || !cell.treatment) continue
    byCase.set(cell.caseId, { ...(byCase.get(cell.caseId) ?? {}), [cell.treatment]: cell.meanScore })
  }
  const delta = (left?: number, right?: number) =>
    left === undefined || right === undefined ? undefined : Number((left - right).toFixed(2))
  return [...byCase.entries()].flatMap(([caseId, rates]) => {
    const core = delta(rates['daemon-core'], rates['raw-acp'])
    const memory = delta(rates['memory-only'], rates['daemon-core'])
    if (core === undefined && memory === undefined) return []
    return [{ caseId, ...(core !== undefined ? { core } : {}), ...(memory !== undefined ? { memory } : {}) }]
  })
}

/** More misses than this in one suite collapse into a single line. */
const COLLAPSE_AT = 5

function actual(cell: Cell): string {
  return cell.valid > 0
    ? `${cell.met}/${cell.valid}`
    : `no valid trial (${cell.invalidReasons.join(', ') || 'none ran'})`
}

/** A content-free Slack-ready report: ids and counts only, never prompts, outputs or local paths. */
export function renderMarkdown(run: NightlyRun): string {
  const count = (mark: Mark) => run.cells.filter((cell) => cell.mark === mark).length
  const missingSuites = run.suites.filter((suite) => !suite.results).map((suite) => suite.suite)
  const brokenSuites = run.suites.filter((suite) => suite.results && suite.apparatusFailed).map((suite) => suite.suite)
  const below = count('below')
  const unmeasured = count('no-valid') + missingSuites.length + brokenSuites.length
  const header =
    below + count('safety') + unmeasured === 0
      ? `✅ all ${run.cells.length} cells on target`
      : `❌ ${below} of ${run.cells.length} below target · 🛑 ${count('safety')} safety · ⚠️ ${unmeasured} unmeasured`
  const minutes = Math.round(run.durationMs / 60_000)
  const lines = [
    `*AgentConnect eval nightly* · ${header}`,
    `\`${run.commit.slice(0, 12)}\`${run.dirty ? ' (dirty)' : ''} · Node ${run.node} · \`${run.subject}\` · repeat ${run.repeat} · ${minutes} min`
  ]

  const attention = [
    ...missingSuites.map((suite) => `⚠️ ${suite}: no result file`),
    ...brokenSuites.map((suite) => `⚠️ ${suite}: a scenario failed to run, so its results may be incomplete`)
  ]
  for (const suite of run.suites) {
    const cells = run.cells.filter((cell) => cell.suite === suite.suite)
    const flagged = cells.filter((cell) => cell.mark !== 'on-target' && !cell.knownCause)
    if (flagged.length > COLLAPSE_AT && flagged.every((cell) => cell.mark === 'below')) {
      const scope = flagged.length === cells.length ? `all ${cells.length}` : `${flagged.length} of ${cells.length}`
      attention.push(`❌ ${suite.suite}: ${scope} cases below target`)
      continue
    }
    for (const cell of flagged) attention.push(`${MARK[cell.mark]} ${suite.suite} · ${cellName(cell)}: ${actual(cell)}`)
  }
  lines.push('', '*Needs a look*', ...(attention.length > 0 ? attention : ['none']))

  const known = new Map<string, string[]>()
  for (const cell of run.cells.filter((entry) => entry.knownCause)) {
    known.set(cell.knownCause!, [...(known.get(cell.knownCause!) ?? []), `${cellName(cell)} ${actual(cell)}`])
  }
  if (known.size > 0) {
    lines.push('', '*Known, no alert*')
    for (const [cause, cells] of known) lines.push(`❌ ${cells.join(', ')}: ${cause}`)
  }

  lines.push('', '*Suites*')
  for (const suite of run.suites.filter((entry) => entry.results)) {
    const cells = run.cells.filter((cell) => cell.suite === suite.suite)
    const onTarget = cells.filter((cell) => cell.mark === 'on-target').length
    lines.push(
      `${onTarget === cells.length && !suite.apparatusFailed ? '✅' : '❌'} ${suite.suite} ${onTarget}/${cells.length}`
    )
  }

  const effects = pairedEffects(run.cells)
  if (effects.length > 0) {
    const signed = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(2)}`
    const deltas = effects.flatMap((effect) => [
      ...(effect.core !== undefined ? [`core ${effect.caseId} ${signed(effect.core)}`] : []),
      ...(effect.memory !== undefined ? [`memory ${effect.caseId} ${signed(effect.memory)}`] : [])
    ])
    lines.push('', `*Add-on deltas* (mean outcome): ${deltas.join(' · ')}`)
  }
  return `${lines.join('\n')}\n`
}
