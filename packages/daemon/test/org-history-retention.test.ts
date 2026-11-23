// The delivered per-org history retention and the dry-run judgement (org-session-policy.md, History retention).
import { describe, expect, it, vi } from 'vitest'
import { CONFIG_KEY_ORG_HISTORY_RETENTION, RegisterOk } from '@agentconnect.md/protocol'
import {
  OrgHistoryRetentionState,
  countDryRun,
  emptyDryRunSummary,
  formatDryRunSummary,
  judgeOrgRetention,
  type OrgRetentionVerdict
} from '../src/daemon/org-history-retention.js'
import {
  applyConfigPush,
  applyReconcileSnapshot,
  type ConfigApplyCoreHost,
  type ConfigApplyHost
} from '../src/cp/config-apply-handlers.js'
import { ConfigSchema } from '../src/config/config-schema.js'

const DAY = 86_400_000
const NOW = 400 * DAY

function synced(
  entries: Array<{ orgId: string; revision: number; historyRetentionDays: number | null }>,
  orgIds: string[] = []
) {
  const state = new OrgHistoryRetentionState()
  state.applySnapshot({ orgIds, entries })
  return state
}

describe('OrgHistoryRetentionState', () => {
  it('pauses every org before any register/ok, and after one from a Control Plane that does not deliver it', () => {
    const state = new OrgHistoryRetentionState()
    expect(state.engaged()).toBe(false)
    expect(state.verdict('org-a')).toEqual({ kind: 'paused', reason: 'unsynced' })
    state.applySnapshot(undefined)
    expect(state.engaged()).toBe(true)
    expect(state.verdict('org-a')).toEqual({ kind: 'paused', reason: 'unsynced' })
  })

  it('reads a policy as its window, null as unlimited, a listed org without one as missing, and an unlisted org as unknown', () => {
    const state = synced(
      [
        { orgId: 'org-a', revision: 3, historyRetentionDays: 7 },
        { orgId: 'org-b', revision: 1, historyRetentionDays: null }
      ],
      ['org-a', 'org-b', 'org-c']
    )
    expect(state.verdict('org-a')).toEqual({ kind: 'policy', windowMs: 7 * DAY, revision: 3 })
    expect(state.verdict('org-b')).toEqual({ kind: 'policy', windowMs: null, revision: 1 })
    expect(state.verdict('org-c')).toEqual({ kind: 'missing' })
    expect(state.verdict('org-d')).toEqual({ kind: 'paused', reason: 'unknown' })
    // A local agent has no org, so nothing but today's rule could ever apply to it.
    expect(state.verdict(undefined)).toEqual({ kind: 'missing' })
    expect(state.windowsMs()).toEqual([7 * DAY])
  })

  it('pauses after the link drops until the next register/ok', () => {
    const state = synced([{ orgId: 'org-a', revision: 1, historyRetentionDays: 7 }], ['org-a'])
    state.linkLost()
    expect(state.verdict('org-a')).toEqual({ kind: 'paused', reason: 'unsynced' })
    state.applySnapshot({ orgIds: ['org-a'], entries: [{ orgId: 'org-a', revision: 1, historyRetentionDays: 7 }] })
    expect(state.verdict('org-a').kind).toBe('policy')
  })

  it('marks an org stale when a snapshot carries a revision older than one seen, or drops a policy it saw', () => {
    const state = synced([{ orgId: 'org-a', revision: 5, historyRetentionDays: 7 }], ['org-a', 'org-b'])
    expect(state.applyUpdate({ orgId: 'org-b', revision: 2, historyRetentionDays: 30 })).toBe(true)
    state.applySnapshot({
      orgIds: ['org-a', 'org-b'],
      entries: [{ orgId: 'org-a', revision: 4, historyRetentionDays: 90 }]
    })
    expect(state.verdict('org-a')).toEqual({ kind: 'paused', reason: 'stale' })
    expect(state.verdict('org-b')).toEqual({ kind: 'paused', reason: 'stale' })
    // A push at or above the highest revision seen settles it again.
    state.applyUpdate({ orgId: 'org-a', revision: 6, historyRetentionDays: 14 })
    expect(state.verdict('org-a')).toEqual({ kind: 'policy', windowMs: 14 * DAY, revision: 6 })
  })

  it('keeps the newer entry when a push carries an older revision, and refuses a malformed value', () => {
    const state = synced([{ orgId: 'org-a', revision: 5, historyRetentionDays: 7 }], ['org-a'])
    expect(state.applyUpdate({ orgId: 'org-a', revision: 4, historyRetentionDays: 90 })).toBe(true)
    expect(state.verdict('org-a')).toEqual({ kind: 'policy', windowMs: 7 * DAY, revision: 5 })
    expect(state.applyUpdate({ orgId: 'org-a', revision: 0, historyRetentionDays: 7 })).toBe(false)
    expect(state.applyUpdate('7d')).toBe(false)
  })

  it('covers an org first named by a push', () => {
    const state = synced([], [])
    expect(state.verdict('org-n')).toEqual({ kind: 'paused', reason: 'unknown' })
    state.applyUpdate({ orgId: 'org-n', revision: 1, historyRetentionDays: 30 })
    expect(state.verdict('org-n')).toEqual({ kind: 'policy', windowMs: 30 * DAY, revision: 1 })
  })
})

describe('judgeOrgRetention', () => {
  const policy = (days: number | null): OrgRetentionVerdict => ({
    kind: 'policy',
    windowMs: days === null ? null : days * DAY,
    revision: 1
  })
  const judge = (ageDays: number, verdict: OrgRetentionVerdict, currentDays: number | null, guarded = false) =>
    judgeOrgRetention(
      { updatedAt: NOW - ageDays * DAY, protected: guarded, verdict },
      currentDays === null ? null : currentDays * DAY,
      NOW
    )

  it('would delete more under a shorter org window', () => {
    expect(judge(10, policy(7), 90)).toEqual({ current: 'keep', org: 'delete' })
  })

  it('would keep under a longer or unlimited org window', () => {
    expect(judge(100, policy(365), 90)).toEqual({ current: 'delete', org: 'keep' })
    expect(judge(100, policy(null), 90)).toEqual({ current: 'delete', org: 'keep' })
  })

  it('follows today’s rule for a missing policy, pauses for an unsynced or stale one, and keeps a guarded session', () => {
    expect(judge(100, { kind: 'missing' }, 90)).toEqual({ current: 'delete', org: 'delete' })
    expect(judge(10, { kind: 'missing' }, 90)).toEqual({ current: 'keep', org: 'keep' })
    expect(judge(100, { kind: 'paused', reason: 'stale' }, 90)).toEqual({ current: 'delete', org: 'paused' })
    expect(judge(100, policy(7), 90, true)).toEqual({ current: 'keep', org: 'protected' })
  })

  it('folds decisions into one summary whose parts add up to the candidates', () => {
    const summary = emptyDryRunSummary()
    const rows: Array<[number, OrgRetentionVerdict, boolean]> = [
      [10, policy(7), false],
      [100, policy(null), false],
      [100, { kind: 'missing' }, false],
      [100, { kind: 'paused', reason: 'stale' }, false],
      [100, { kind: 'paused', reason: 'unsynced' }, false],
      [100, { kind: 'paused', reason: 'unknown' }, false],
      [100, policy(7), true]
    ]
    for (const [age, verdict, guarded] of rows) countDryRun(summary, verdict, judge(age, verdict, 90, guarded))
    expect(summary).toEqual({
      candidates: 7,
      currentDeletes: 5,
      wouldDelete: 2,
      wouldKeep: 1,
      differs: 2,
      orgDeletesMore: 1,
      orgKeepsMore: 1,
      policyMissing: 1,
      paused: 3,
      pausedUnsynced: 1,
      pausedStale: 1,
      pausedUnknown: 1,
      protected: 1
    })
    expect(summary.wouldDelete + summary.wouldKeep + summary.paused + summary.protected).toBe(summary.candidates)
    expect(formatDryRunSummary(summary)).toBe(
      'retention dry run: org history retention candidates=7 currentDeletes=5 wouldDelete=2 wouldKeep=1 differs=2' +
        ' orgDeletesMore=1 orgKeepsMore=1 policyMissing=1 paused=3 pausedUnsynced=1 pausedStale=1 pausedUnknown=1' +
        ' protected=1'
    )
  })
})

describe('delivery into the daemon', () => {
  function host() {
    const cfg = ConfigSchema.parse({ version: 1 })
    const log = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const state = new OrgHistoryRetentionState()
    const core = {
      cfg: () => cfg,
      log: () => log,
      setLog: () => {},
      orgHistoryRetention: () => state
    } as unknown as ConfigApplyCoreHost
    return { cfg, log, state, core }
  }

  it('routes the config/push key to the org state without touching the daemon-wide window', () => {
    const { cfg, log, state, core } = host()
    state.applySnapshot({ orgIds: ['org-a'], entries: [] })
    const before = cfg.sessions.retention
    applyConfigPush(core, {
      [CONFIG_KEY_ORG_HISTORY_RETENTION]: { orgId: 'org-a', revision: 2, historyRetentionDays: 7 }
    })
    expect(state.verdict('org-a')).toEqual({ kind: 'policy', windowMs: 7 * DAY, revision: 2 })
    expect(cfg.sessions.retention).toBe(before)
    expect(log.info).toHaveBeenCalledWith(`cp: applied config keys: ${CONFIG_KEY_ORG_HISTORY_RETENTION}`)
    applyConfigPush(core, { [CONFIG_KEY_ORG_HISTORY_RETENTION]: { orgId: 'org-a' } })
    expect(log.warn).toHaveBeenCalledWith(`cp: ignored config keys: ${CONFIG_KEY_ORG_HISTORY_RETENTION}`)
  })

  it('applies the register/ok snapshot, and an older Control Plane’s absent field leaves every org unsynced', async () => {
    const { core, state } = host()
    const snapHost = {
      ...core,
      setGitCommitIdentity: () => {},
      setFileTransfer: () => {},
      reserveAgentRemoval: () => () => {},
      queueAgentLifecycle: async () => {},
      cpAgents: () => undefined,
      cpIntegrations: () => undefined,
      cpCrons: () => undefined,
      cpRouting: () => undefined,
      memoryConnections: () => undefined,
      cpMcpDefs: () => undefined
    } as unknown as ConfigApplyHost
    const base = {
      routingEpoch: 1,
      assignments: [],
      crons: [],
      leases: [],
      drop: { assignments: [], crons: [] }
    }
    const withField = RegisterOk.parse({
      ...base,
      orgHistoryRetention: { orgIds: ['org-a'], entries: [{ orgId: 'org-a', revision: 1, historyRetentionDays: 7 }] }
    })
    await applyReconcileSnapshot(snapHost, withField).catch(() => undefined)
    expect(state.verdict('org-a')).toEqual({ kind: 'policy', windowMs: 7 * DAY, revision: 1 })
    await applyReconcileSnapshot(snapHost, RegisterOk.parse(base)).catch(() => undefined)
    expect(state.verdict('org-a')).toEqual({ kind: 'paused', reason: 'unsynced' })
  })
})
