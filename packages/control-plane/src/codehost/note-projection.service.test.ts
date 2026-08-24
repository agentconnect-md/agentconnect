/**
 * The §16 Control-Plane half: lifecycle → desired generation → dispatch, and the
 * §17.3 gate that leaves a row pending instead of writing the note itself.
 */
import {
  CODEHOST_NOTE_PROJECTION_V1_FEATURE,
  HOOK_DELIVERY_REASON_DAEMON_OFFLINE,
  HOOK_REPORT_REASON_AGENT_HANDOVER,
  HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED,
  HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED,
  type CodeHostNoteDesired,
  type CodeHostNoteState,
  type GitlabHookMetadata
} from '@agentconnect.md/protocol'
import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { AgentId, DaemonId, HookId, OrgId } from '../domain/ids.js'
import type { AgentRecord, CodeHostRunProjectionRecord, CodeHostRunProjectionRepo } from '../persistence/ports.js'
import {
  CodeHostNoteProjectionService,
  completeSnapshot,
  projectionSubject,
  reportedNoteState,
  type NoteProjectionEdge
} from './note-projection.service.js'

const NOW = 1_700_000_000_000
const hookId = HookId('00000000-0000-4000-8000-000000000001')
const agentId = AgentId('00000000-0000-4000-8000-000000000002')
const daemonId = DaemonId('00000000-0000-4000-8000-000000000003')
const orgId = OrgId('org_1')
const OTHER_HOOK = '00000000-0000-4000-8000-00000000000f'
const HEAD = 'a'.repeat(40)

// The tuple a gitlab hook that opted into run reporting compiles to. `reportingMode` is the
// axis that owns this surface — the §16 note IS the run report — so the fixture must carry it.
const snapshot = {
  configRevision: '3',
  dispatchRevision: '5',
  dispatchDaemonId: daemonId,
  reviewPolicy: 'off' as const,
  reportingMode: 'check' as const,
  gateMode: 'informational' as const
}

function gitlab(overrides: Partial<{ headSha: string; iid: number }> = {}): GitlabHookMetadata {
  return {
    projectId: '4455667',
    projectPath: 'example-group/example-project',
    target: { kind: 'merge_request', iid: overrides.iid ?? 42, headSha: overrides.headSha ?? HEAD }
  }
}

function edge(overrides: Partial<NoteProjectionEdge> = {}): NoteProjectionEdge {
  return {
    hookId,
    agentId,
    deliveryKey: 'delivery-1',
    orgId,
    state: 'queued',
    gitlab: gitlab(),
    snapshot,
    at: new Date(NOW),
    ...overrides
  }
}

function projection(overrides: Partial<CodeHostRunProjectionRecord> = {}): CodeHostRunProjectionRecord {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    provider: 'gitlab',
    hookId,
    orgId,
    agentId,
    agentName: 'reviewer',
    projectId: 4455667n,
    projectPath: 'example-group/example-project',
    mergeRequestIid: 42,
    headSha: HEAD,
    projectionEpoch: 1n,
    generation: 1n,
    currentDeliveryKey: 'delivery-1',
    currentRunAt: new Date(NOW),
    externalId: '10000000-0000-4000-8000-000000000001',
    noteId: null,
    desiredState: 'queued',
    observedState: null,
    reason: null,
    sealedThrough: 0n,
    queuedAt: new Date(NOW),
    startedAt: null,
    completedAt: null,
    sessionId: null,
    credentialEpoch: 2n,
    configRevision: 3n,
    dispatchRevision: 5n,
    dispatchDaemonId: daemonId,
    reviewPolicySnapshot: 'off',
    reportingModeSnapshot: 'check',
    gateModeSnapshot: 'informational',
    leaseOwner: null,
    leaseUntil: null,
    nextAttemptAt: new Date(NOW),
    attempts: 0,
    lastErrorCode: null,
    pendingIntent: null,
    writeMarker: null,
    writePhase: null,
    writeStartedAt: null,
    tombstonedAt: null,
    updatedAt: new Date(NOW),
    ...overrides
  }
}

const agent = { id: agentId, orgId, name: 'reviewer' } as unknown as AgentRecord

function harness(
  options: {
    row?: CodeHostRunProjectionRecord
    features?: readonly string[] | undefined
    beginWrite?: boolean
    setDesired?: boolean
    retiredOwner?: boolean
    runEpoch?: bigint | null
    /** The acting agent's §7.2 account on the project; null ⇒ it has none. */
    account?: { credentialEpoch: bigint; state?: string; serviceAccountUserId?: bigint | null } | null
  } = {}
) {
  const row = options.row ?? projection()
  // The stored row carries whatever converge computed, as the real repository
  // does — the dispatched frame is then read back from it.
  let stored = row
  const sent: Array<{ daemonId: string; desired: CodeHostNoteDesired; orgId: string }> = []
  const projections = {
    upsert: vi.fn(async (input: { credentialEpoch: bigint }) => {
      if (options.retiredOwner) return null
      stored = { ...row, credentialEpoch: input.credentialEpoch }
      return stored
    }),
    setDesired: vi.fn(async () => options.setDesired ?? true),
    supersede: vi.fn(async () => 0),
    beginWrite: vi.fn(async () => options.beginWrite ?? true),
    completeWrite: vi.fn(async () => true),
    failWrite: vi.fn(async () => true),
    advancePending: vi.fn(async () => null),
    get: vi.fn(async () => stored)
  } satisfies Record<keyof CodeHostRunProjectionRepo, unknown> as unknown as CodeHostRunProjectionRepo & {
    upsert: ReturnType<typeof vi.fn>
    setDesired: ReturnType<typeof vi.fn>
    supersede: ReturnType<typeof vi.fn>
    beginWrite: ReturnType<typeof vi.fn>
    completeWrite: ReturnType<typeof vi.fn>
    failWrite: ReturnType<typeof vi.fn>
    get: ReturnType<typeof vi.fn>
  }
  // The accepted run, whose epoch the projection must spend even after the live hook moves on.
  const runs = {
    getRun: vi.fn(async () => ({ projectionEpoch: options.runEpoch === undefined ? 1n : options.runEpoch }))
  }
  // The account's own epoch, deliberately DIFFERENT from the binding's: the two
  // counters advance independently and the daemon fences on the account's.
  const account =
    options.account === undefined
      ? { credentialEpoch: 7n, state: 'ready', serviceAccountUserId: 9042n }
      : options.account
  const accounts = { forAgentBinding: vi.fn(async () => account) }
  const service = new CodeHostNoteProjectionService({
    projections,
    runs: runs as never,
    agents: { getUnscoped: vi.fn(async () => agent) },
    bindings: { byProject: vi.fn(async () => ({ id: 'binding-1', credentialEpoch: 2n })) } as never,
    accounts: accounts as never,
    orgs: { slugById: vi.fn(async () => 'acme') },
    webAppUrl: 'https://console.example.test',
    clock: new FakeClock(NOW),
    sender: {
      daemonFeatures: () => (options.features === undefined ? [CODEHOST_NOTE_PROJECTION_V1_FEATURE] : options.features),
      send: (id, desired, org) => sent.push({ daemonId: id, desired, orgId: org })
    }
  })
  return { service, projections, sent, row, runs, accounts }
}

describe('reportedNoteState (gitlab-com-integration.md §16)', () => {
  it('maps every terminal report to a fixed state, never to free text', () => {
    const cases: Array<[string | undefined, CodeHostNoteState]> = [
      [undefined, 'failed'],
      [HOOK_REPORT_REASON_AGENT_HANDOVER, 'interrupted'],
      [HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED, 'skipped'],
      [HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED, 'skipped'],
      ['some upstream exploded', 'failed']
    ]
    expect(reportedNoteState('success')).toBe('completed')
    for (const [reason, expected] of cases) expect(reportedNoteState('failed', reason)).toBe(expected)
  })
})

describe('projection fences', () => {
  it('projects only a merge-request subject with an authoritative head', () => {
    expect(projectionSubject(gitlab())?.mergeRequestIid).toBe(42)
    expect(projectionSubject(undefined)).toBeNull()
    expect(projectionSubject({ ...gitlab(), target: { kind: 'issue', iid: 7 } })).toBeNull()
    expect(projectionSubject({ ...gitlab(), target: { kind: 'merge_request', iid: 7 } })).toBeNull()
  })

  it('refuses a partially rolled-out dispatch tuple instead of filling it in', () => {
    expect(completeSnapshot(snapshot)).toEqual(snapshot)
    const { dispatchDaemonId: _omitted, ...partial } = snapshot
    expect(completeSnapshot(partial)).toBeNull()
  })
})

describe('CodeHostNoteProjectionService', () => {
  it('records a queued generation and dispatches the body-free desired frame to its daemon', async () => {
    const { service, projections, sent } = harness()
    await service.afterAccepted(edge())
    expect(projections.upsert).toHaveBeenCalledOnce()
    expect(sent).toHaveLength(1)
    const desired = sent[0]!.desired
    expect(sent[0]!.daemonId).toBe(daemonId)
    expect(sent[0]!.orgId).toBe(orgId)
    expect(desired.state).toBe('queued')
    expect(desired.generation).toBe('1')
    expect(desired.projectId).toBe('4455667')
    expect(desired.mergeRequestIid).toBe(42)
    expect(desired.headSha).toBe(HEAD)
    // §7.2: the ACTING AGENT's account epoch, never the binding's (2n here) —
    // the daemon mints its effect lease against that account and fences on it.
    expect(desired.credentialEpoch).toBe('7')
    // The fence echoes the ACCEPTED tuple verbatim, never a value the projection invented.
    expect(desired.snapshot).toEqual(snapshot)
    expect(desired.writeMarker).not.toBe(desired.projectionKey)
  })

  it('follows the account epoch across a rotation, and asks for the ACTING agent’s account', async () => {
    const rotated = harness({ account: { credentialEpoch: 8n, state: 'ready', serviceAccountUserId: 9042n } })
    await rotated.service.afterAccepted(edge())
    expect(rotated.sent[0]!.desired.credentialEpoch).toBe('8')
    // Resolved for this agent on this project's binding — the same identity the
    // effect lease is minted against, so the two counters cannot diverge.
    expect(rotated.accounts.forAgentBinding).toHaveBeenCalledWith(orgId, agentId, 'binding-1')
  })

  it('opens no projection when the agent has no usable account on the project (§7.2)', async () => {
    for (const account of [
      null,
      { credentialEpoch: 7n, state: 'provisioning', serviceAccountUserId: 9042n },
      { credentialEpoch: 7n, state: 'ready', serviceAccountUserId: null }
    ]) {
      const { service, projections, sent } = harness({ account })
      await service.afterAccepted(edge())
      // Fail closed: the note could never be written, so no row and no frame.
      expect(projections.upsert).not.toHaveBeenCalled()
      expect(sent).toHaveLength(0)
    }
  })

  it('advances the generation to running when the start barrier is crossed', async () => {
    const { service, projections, sent } = harness({ row: projection({ desiredState: 'running' }) })
    await service.afterStart(edge({ state: 'running', sessionId: 'sess-1' }))
    expect(projections.upsert.mock.calls[0]![0]).toMatchObject({
      desiredState: 'running',
      startedAt: new Date(NOW),
      sessionId: 'sess-1'
    })
    // A running edge is a lifecycle hint, not terminal authority, so it seals nothing.
    expect(projections.upsert.mock.calls[0]![0]).not.toHaveProperty('completedAt')
    expect(projections.setDesired).toHaveBeenCalledWith(expect.any(String), 1n, 'running', new Date(NOW), undefined)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.desired.state).toBe('running')
  })

  it('leaves a running edge pending when the daemon does not advertise the feature', async () => {
    const { service, projections, sent } = harness({ features: [], row: projection({ desiredState: 'running' }) })
    await service.afterStart(edge({ state: 'running' }))
    expect(projections.upsert).toHaveBeenCalledOnce()
    expect(sent).toHaveLength(0)
  })

  it('supersedes older heads on the same merge request before opening the new generation', async () => {
    const { service, projections } = harness()
    await service.afterAccepted(edge({ gitlab: gitlab({ headSha: 'b'.repeat(40) }) }))
    expect(projections.supersede).toHaveBeenCalledWith(hookId, 4455667n, 42, 'b'.repeat(40), new Date(NOW))
    expect(projections.supersede.mock.invocationCallOrder[0]!).toBeLessThan(
      projections.upsert.mock.invocationCallOrder[0]!
    )
  })

  it('leaves the row pending when the daemon does not advertise the feature', async () => {
    const { service, projections, sent } = harness({ features: ['gitlab-com-v1'] })
    await service.afterAccepted(edge())
    expect(projections.upsert).toHaveBeenCalledOnce()
    expect(projections.beginWrite).not.toHaveBeenCalled()
    expect(sent).toHaveLength(0)
  })

  it('leaves the row pending when the owning daemon is offline', async () => {
    const { projections, sent, runs } = harness({ features: undefined })
    const offline = new CodeHostNoteProjectionService({
      projections,
      runs: runs as never,
      agents: { getUnscoped: vi.fn(async () => agent) },
      bindings: { byProject: vi.fn(async () => ({ id: 'binding-1', credentialEpoch: 2n })) } as never,
      accounts: {
        forAgentBinding: vi.fn(async () => ({ credentialEpoch: 7n, state: 'ready', serviceAccountUserId: 9042n }))
      } as never,
      clock: new FakeClock(NOW),
      sender: { daemonFeatures: () => undefined, send: () => sent.push(undefined as never) }
    })
    await offline.afterAccepted(edge())
    expect(projections.beginWrite).not.toHaveBeenCalled()
    expect(sent).toHaveLength(0)
  })

  it('does not dispatch while another mutation still holds the write', async () => {
    const { service, sent } = harness({ beginWrite: false })
    await service.afterAccepted(edge())
    expect(sent).toHaveLength(0)
  })

  it('drops a late edge the ledger refuses as sealed rather than re-dispatching it', async () => {
    const { service, projections, sent } = harness({ setDesired: false })
    await service.afterAccepted(edge())
    expect(projections.setDesired).toHaveBeenCalledOnce()
    expect(sent).toHaveLength(0)
  })

  it('carries an ordinary authenticated console session link, with no token or capability param', async () => {
    const { service, sent } = harness({ row: projection({ sessionId: 'sess-1' }) })
    await service.afterReport(edge({ state: 'completed', sessionId: 'sess-1' }))
    expect(sent[0]!.desired.consoleUrl).toBe('https://console.example.test/acme/sessions/sess-1?source=gitlab')
  })

  it('never puts a raw failure text on the wire — only a normalized code', async () => {
    const { service, projections } = harness()
    await service.afterReport(edge({ state: 'failed', reason: 'Error: upstream said "no"' }))
    expect(projections.upsert.mock.calls[0]![0]).not.toHaveProperty('reason')
    await service.afterReport(edge({ state: 'interrupted', reason: HOOK_REPORT_REASON_AGENT_HANDOVER }))
    expect(projections.upsert.mock.calls[1]![0].reason).toBe(HOOK_REPORT_REASON_AGENT_HANDOVER)
  })

  it('opens nothing for a delivery that failed only because the daemon was offline', async () => {
    const { service, projections } = harness()
    await service.afterDeliveryFailed(edge({ reason: HOOK_DELIVERY_REASON_DAEMON_OFFLINE }))
    expect(projections.upsert).not.toHaveBeenCalled()
    await service.afterDeliveryFailed(edge({ reason: 'review_request_required' }))
    expect(projections.upsert.mock.calls[0]![0].desiredState).toBe('skipped')
  })

  it('opens no projection at all while the hook reports nothing', async () => {
    // `reportingMode` gates this surface exactly as it gates a GitHub Check: the note IS the
    // run report, so `off` means no generation, no ledger row, and no daemon frame.
    const { service, projections, sent } = harness()
    const silent = { ...snapshot, reportingMode: 'off' as const }
    await service.afterAccepted(edge({ snapshot: silent }))
    await service.afterStart(edge({ snapshot: silent }))
    await service.afterReport(edge({ snapshot: silent, state: 'completed' }))
    await service.afterDeliveryFailed(edge({ snapshot: silent, reason: 'review_request_required' }))
    expect(projections.upsert).not.toHaveBeenCalled()
    expect(projections.supersede).not.toHaveBeenCalled()
    expect(sent).toEqual([])
  })

  it('settles the row acceptance opened when the hook is edited mid-run, instead of forking a new one', async () => {
    // A check → off PUT mid-run advances the LIVE hook's epoch while the accepted run keeps its own.
    // Spending the live one would strand the queued note and post a second terminal one.
    const ACCEPTED_EPOCH = 1n
    const EDITED_HOOK_EPOCH = 2n
    const { service, projections, runs } = harness({ runEpoch: ACCEPTED_EPOCH })
    await service.afterAccepted(edge())
    // The edit lands here: it moves the hook definition, never the accepted run.
    await service.afterReport(edge({ state: 'completed' }))

    const epochs = projections.upsert.mock.calls.map(([input]) => input.projectionEpoch)
    expect(epochs).toEqual([ACCEPTED_EPOCH, ACCEPTED_EPOCH])
    expect(epochs).not.toContain(EDITED_HOOK_EPOCH)
    // Both edges resolved that epoch from the accepted run, keyed by the delivery they belong to.
    expect(runs.getRun).toHaveBeenCalledTimes(2)
    expect(runs.getRun).toHaveBeenLastCalledWith(hookId, 'delivery-1')
  })

  it('opens nothing when the accepted run carries no epoch, so a retired key is never revived', async () => {
    const { service, projections } = harness({ runEpoch: null })
    await service.afterAccepted(edge())
    expect(projections.upsert).not.toHaveBeenCalled()
    expect(projections.supersede).not.toHaveBeenCalled()
  })

  it('settles a written result on the reporting daemon and persists the note id', async () => {
    const { service, projections } = harness()
    const settled = await service.recordResult(
      {
        projectionId: projection().id,
        hookId,
        generation: '1',
        writeMarker: '20000000-0000-4000-8000-000000000001',
        outcome: 'written',
        noteId: '987654321',
        observedState: 'queued',
        observedAt: new Date(NOW).toISOString()
      },
      daemonId,
      orgId
    )
    expect(settled).toBe('settled')
    expect(projections.completeWrite).toHaveBeenCalledWith(
      expect.objectContaining({ leaseOwner: daemonId, generation: 1n, noteId: '987654321' })
    )
  })

  it('keeps an ambiguous mutation fail-closed on its writer instead of releasing the mutex', async () => {
    const { service, projections } = harness()
    const base = {
      projectionId: projection().id,
      hookId,
      generation: '1',
      writeMarker: '20000000-0000-4000-8000-000000000001',
      observedAt: new Date(NOW).toISOString()
    }
    await service.recordResult({ ...base, outcome: 'ambiguous', code: 'ambiguous_write' }, daemonId, orgId)
    expect(projections.failWrite).toHaveBeenLastCalledWith(
      base.projectionId,
      1n,
      daemonId,
      base.writeMarker,
      'ambiguous_write',
      expect.any(Date),
      true
    )
    await service.recordResult({ ...base, outcome: 'failed', code: 'forbidden' }, daemonId, orgId)
    expect(projections.failWrite).toHaveBeenLastCalledWith(
      base.projectionId,
      1n,
      daemonId,
      base.writeMarker,
      'forbidden',
      expect.any(Date),
      false
    )
  })

  it('refuses a result claiming a projection in another organization', async () => {
    const { service, projections } = harness()
    const result = {
      projectionId: projection().id,
      hookId,
      generation: '1',
      writeMarker: '20000000-0000-4000-8000-000000000001',
      outcome: 'written' as const,
      noteId: '987654321',
      observedState: 'queued' as const,
      observedAt: new Date(NOW).toISOString()
    }
    expect(await service.recordResult(result, daemonId, OrgId('org_2'))).toBe('denied')
    expect(await service.recordResult({ ...result, hookId: OTHER_HOOK }, daemonId, orgId)).toBe('denied')
    expect(projections.completeWrite).not.toHaveBeenCalled()
  })

  it('settles a result whose hook is already gone, so a tombstone can still drain', async () => {
    // The row deliberately outlives its HookDef; authorization reads the row, not a live hook.
    const { service, projections } = harness({ row: projection({ tombstonedAt: new Date(NOW) }) })
    const settled = await service.recordResult(
      {
        projectionId: projection().id,
        hookId,
        generation: '1',
        writeMarker: '20000000-0000-4000-8000-000000000001',
        outcome: 'written',
        noteId: '987654321',
        observedState: 'skipped',
        observedAt: new Date(NOW).toISOString()
      },
      daemonId,
      orgId
    )
    expect(settled).toBe('settled')
    expect(projections.completeWrite).toHaveBeenCalledOnce()
  })

  it('drops the edge when the ledger refuses creation for a retired owner', async () => {
    const { service, projections, sent } = harness({ retiredOwner: true })
    await service.afterAccepted(edge())
    expect(projections.upsert).toHaveBeenCalledOnce()
    expect(projections.setDesired).not.toHaveBeenCalled()
    expect(projections.beginWrite).not.toHaveBeenCalled()
    expect(sent).toHaveLength(0)
  })

  it('never starts a second attempt while an unsettled marker is held', async () => {
    for (const owner of [daemonId, 'another-daemon']) {
      const { service, projections, sent } = harness({
        row: projection({
          writeMarker: '20000000-0000-4000-8000-0000000000bb',
          writePhase: 'create',
          leaseOwner: owner
        })
      })
      await service.afterAccepted(edge())
      expect(projections.beginWrite).not.toHaveBeenCalled()
      expect(sent).toHaveLength(0)
    }
  })
})
