// Informational run projection writer (gitlab-com-integration.md §16): one service-account note per
// merge-request head, created once, updated in place, reconciled by the hidden marker, never replayed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CODEHOST_NOTE_PROJECTION_V1_FEATURE,
  GITLAB_COM_V1_FEATURE,
  type CodeHostNoteDesired,
  type CodeHostNoteResult,
  type CodeHostNoteState
} from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { DatabaseSync } from 'node:sqlite'
import { CodeHostNoteProjector, projectionMarker, renderProjectionNote } from '../src/gitlab/note-projection.js'
import type { PosterScheduler } from '../src/github/poster.js'
import { LocalStore } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import { statePath } from '../src/paths.js'

const DAEMON = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const HOOK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
const PROJECTION = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'
const PROJECTION_B = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2'
const MARKER_A = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1'
const MARKER_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2'
const PROJECT = '4455667'
const IID = 77
const HEAD = 'abc123def4567890abc123def4567890abc123de'
const NOW = Date.parse('2026-08-22T10:00:00.000Z')
/** The credential purge fence the desired frame and the effect grant must agree on. */
const EPOCH = '3'
const RESWEEP_BASE_MS = 30_000
const RESWEEP_CAP_MS = 120_000

function desiredFrame(over: Partial<CodeHostNoteDesired> = {}): CodeHostNoteDesired {
  return {
    projectionId: PROJECTION,
    provider: 'gitlab',
    hookId: HOOK,
    agentId: AGENT,
    agentName: 'Reviewer',
    deliveryKey: 'delivery-1',
    generation: '1',
    projectionEpoch: '1',
    projectionKey: PROJECTION,
    writeMarker: MARKER_A,
    projectId: PROJECT,
    projectPath: 'example-group/example-project',
    mergeRequestIid: IID,
    headSha: HEAD,
    state: 'queued',
    queuedAt: '2026-08-22T09:59:00.000Z',
    desiredAt: '2026-08-22T10:00:00.000Z',
    snapshot: {
      configRevision: '4',
      dispatchRevision: '9',
      dispatchDaemonId: DAEMON,
      reviewPolicy: 'off',
      reportingMode: 'off',
      gateMode: 'informational'
    },
    credentialEpoch: '3',
    leaseUntil: '2026-08-22T10:02:00.000Z',
    ...over
  }
}

/** A hand-driven timer seam: the resweep is armed on it and fired only when a test says so. */
function fakeScheduler() {
  let nextId = 1
  const pending = new Map<number, { fn: () => void; at: number }>()
  const delays: number[] = []
  const sched: PosterScheduler = {
    now: () => NOW,
    setTimeout: (fn, ms) => {
      const id = nextId++
      delays.push(ms)
      pending.set(id, { fn, at: ms })
      return id
    },
    clearTimeout: (handle) => {
      pending.delete(handle as number)
    }
  }
  return {
    sched,
    delays: () => [...delays],
    armed: () => pending.size,
    /** Fire the single armed timer, as the event loop would. */
    fire: () => {
      const [id, entry] = [...pending.entries()][0] ?? []
      if (id === undefined || !entry) throw new Error('no resweep is armed')
      pending.delete(id)
      entry.fn()
    }
  }
}

interface Call {
  method: string
  url: string
  body?: string
}

/** `answers` is consumed per call; anything past the end is a 200 with an empty note object. */
function fakeFetch(answers: Array<{ status?: number; body?: string; throws?: boolean }>) {
  const calls: Call[] = []
  let n = 0
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const answer = answers[n] ?? {}
    n += 1
    calls.push({
      method: init?.method ?? 'GET',
      url: String(url),
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)).body as string })
    })
    if (answer.throws) throw new Error('socket hang up')
    return new Response(answer.body ?? '{"id":12345}', { status: answer.status ?? 200 })
  }) as typeof fetch
  return { fetchImpl, calls }
}

let root: string
let store: LocalStore

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'note-projection-'))
  store = await LocalStore.open(statePath(root))
})

afterEach(async () => {
  await store.close()
  rmSync(root, { recursive: true, force: true })
})

/** A control-plane answer to `codehost/note-result`, as the correlator surfaces it. */
class FakeWireError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message)
  }
}

function projector(
  fetchImpl: typeof fetch,
  over: {
    access?: 'read' | 'comment' | 'write'
    leaseTokens?: string[]
    leaseThrows?: boolean
    daemonId?: string
    /** Per-mint credential epoch; the default matches the desired frame's fence. */
    leaseEpochs?: (string | undefined)[]
    /** Reject this many reports before the fake control plane starts accepting them. */
    reportRejections?: number
    reportRetryable?: boolean
    /** A store other than the per-test one — the shared-store restart cases open their own. */
    store?: LocalStore
    scheduler?: ReturnType<typeof fakeScheduler>
    /** Make the unsettled-row scan throw this many times before it starts answering. */
    scanFailures?: number
    /** Runs inside the FIRST scan, after it read the rows — the interleave the arm fence guards. */
    onFirstScan?: () => Promise<void>
  } = {}
) {
  const results: Array<{ result: CodeHostNoteResult; orgId?: string }> = []
  const invalidated: string[] = []
  const tokens = over.leaseTokens ?? ['glpat-1', 'glpat-2']
  const db = over.store ?? store
  const clock = over.scheduler ?? fakeScheduler()
  let mint = 0
  let rejections = over.reportRejections ?? 0
  let scanFailures = over.scanFailures ?? 0
  let firstScan = over.onFirstScan
  const projector = new CodeHostNoteProjector({
    daemonId: () => over.daemonId ?? DAEMON,
    store: {
      getNoteProjection: (daemonId, key) => db.getNoteProjection(daemonId, key),
      beginNoteProjectionWrite: (row, now) => db.beginNoteProjectionWrite(row, now),
      recordNoteProjectionOutcome: (row, outcome, code, now) => db.recordNoteProjectionOutcome(row, outcome, code, now),
      markNoteProjectionReported: (daemonId, key, marker, now) =>
        db.markNoteProjectionReported(daemonId, key, marker, now),
      listUnsettledNoteProjections: async (daemonId) => {
        if (scanFailures > 0) {
          scanFailures -= 1
          throw new Error('ledger scan unavailable')
        }
        const rows = await db.listUnsettledNoteProjections(daemonId)
        const hook = firstScan
        firstScan = undefined
        await hook?.()
        return rows
      }
    },
    lease: async () => {
      if (over.leaseThrows) throw new Error('effect lease refused')
      const token = tokens[Math.min(mint, tokens.length - 1)]!
      const epochs = over.leaseEpochs ?? [EPOCH]
      const credentialEpoch = epochs[Math.min(mint, epochs.length - 1)]
      mint += 1
      return { token, access: over.access ?? 'comment', ...(credentialEpoch ? { credentialEpoch } : {}) }
    },
    invalidateLease: (_target, token) => invalidated.push(token),
    report: async (result, orgId) => {
      if (rejections > 0) {
        rejections -= 1
        throw new FakeWireError('control plane unreachable', over.reportRetryable ?? true)
      }
      results.push({ result, ...(orgId ? { orgId } : {}) })
    },
    log: { warn: () => undefined },
    now: () => NOW,
    scheduler: clock.sched,
    resweepBaseMs: RESWEEP_BASE_MS,
    resweepCapMs: RESWEEP_CAP_MS,
    apiBaseUrl: () => 'https://gitlab.example.test/api/v4',
    fetchImpl
  })
  return { projector, results, invalidated, clock, mints: () => mint }
}

describe('the run-projection note (gitlab-com-integration.md §16)', () => {
  it('creates one note carrying the hidden marker on the first generation', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 201, body: '{"id":12345}' }])
    const { projector: p, results } = projector(fetchImpl)
    await p.apply(desiredFrame(), 'org-1')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url).toBe(`https://gitlab.example.test/api/v4/projects/${PROJECT}/merge_requests/${IID}/notes`)
    expect(calls[0]!.body).toContain(projectionMarker(PROJECTION))
    expect(results).toEqual([
      {
        result: {
          projectionId: PROJECTION,
          hookId: HOOK,
          generation: '1',
          writeMarker: MARKER_A,
          outcome: 'written',
          noteId: '12345',
          observedState: 'queued',
          observedAt: '2026-08-22T10:00:00.000Z'
        },
        orgId: 'org-1'
      }
    ])
    const row = await store.getNoteProjection(DAEMON, PROJECTION)
    expect(row?.phase).toBe('settled')
    expect(row?.noteId).toBe('12345')
  })

  it('updates the SAME note in place on the next generation — never a second note per head', async () => {
    const first = fakeFetch([{ status: 201, body: '{"id":12345}' }])
    const a = projector(first.fetchImpl)
    await a.projector.apply(desiredFrame())

    const second = fakeFetch([{ status: 200, body: '{"id":12345}' }])
    const b = projector(second.fetchImpl)
    await b.projector.apply(desiredFrame({ generation: '2', writeMarker: MARKER_B, state: 'completed' }))

    expect(second.calls).toHaveLength(1)
    expect(second.calls[0]!.method).toBe('PUT')
    expect(second.calls[0]!.url.endsWith(`/merge_requests/${IID}/notes/12345`)).toBe(true)
    expect(second.calls[0]!.body).toContain(projectionMarker(PROJECTION))
    expect(b.results[0]!.result).toMatchObject({
      generation: '2',
      writeMarker: MARKER_B,
      outcome: 'written',
      noteId: '12345',
      observedState: 'completed'
    })
  })

  it('preserves a note id beyond the safe-integer range', async () => {
    const bigId = '9007199254740993123'
    const { fetchImpl } = fakeFetch([{ status: 201, body: `{"id":${bigId}}` }])
    const { projector: p, results } = projector(fetchImpl)
    await p.apply(desiredFrame())

    expect(results[0]!.result.noteId).toBe(bigId)
    expect((await store.getNoteProjection(DAEMON, PROJECTION))?.noteId).toBe(bigId)
  })

  it('reports ambiguous and keeps the row in flight when the request never resolved', async () => {
    const { fetchImpl, calls } = fakeFetch([{ throws: true }])
    const { projector: p, results } = projector(fetchImpl)
    await p.apply(desiredFrame())

    // No blind retry: a started mutation with an unknown outcome stays fail-closed on this writer.
    expect(calls).toHaveLength(1)
    expect(results[0]!.result).toMatchObject({ outcome: 'ambiguous', code: 'request_unresolved' })
    expect(results[0]!.result.noteId).toBeUndefined()
    const row = await store.getNoteProjection(DAEMON, PROJECTION)
    expect(row?.phase).toBe('in_flight')
    expect(row?.writeMarker).toBe(MARKER_A)
  })

  it('reconciles an interrupted write by LISTING the notes and adopting the marker match', async () => {
    const interrupted = fakeFetch([{ throws: true }])
    await projector(interrupted.fetchImpl).projector.apply(desiredFrame())
    expect((await store.getNoteProjection(DAEMON, PROJECTION))?.phase).toBe('in_flight')

    // A fresh process opens the same store and finds the write marker the crash left behind.
    const listed = JSON.stringify([
      { id: 999, body: 'someone else commented' },
      { id: 12345, body: `${projectionMarker(PROJECTION)}\n**AgentConnect run — Queued**` }
    ])
    const restarted = fakeFetch([
      { status: 200, body: listed },
      { status: 200, body: '{"id":12345}' }
    ])
    const b = projector(restarted.fetchImpl)
    await b.projector.reconcilePending()

    expect(restarted.calls.map((c) => c.method)).toEqual(['GET', 'PUT'])
    expect(restarted.calls[1]!.url.endsWith('/notes/12345')).toBe(true)
    expect(b.results[0]!.result).toMatchObject({ outcome: 'written', noteId: '12345', observedState: 'queued' })
    expect((await store.getNoteProjection(DAEMON, PROJECTION))?.phase).toBe('settled')
  })

  it('creates exactly once when reconciliation finds no marker — the interrupted write had no effect', async () => {
    const interrupted = fakeFetch([{ throws: true }])
    await projector(interrupted.fetchImpl).projector.apply(desiredFrame())

    const restarted = fakeFetch([
      { status: 200, body: '[{"id":999,"body":"unrelated"}]' },
      { status: 201, body: '{"id":54321}' }
    ])
    const b = projector(restarted.fetchImpl)
    await b.projector.reconcilePending()

    expect(restarted.calls.map((c) => c.method)).toEqual(['GET', 'POST'])
    expect(b.results[0]!.result).toMatchObject({ outcome: 'written', noteId: '54321' })
  })

  it('skips without any provider call when the placement fence names another daemon', async () => {
    const { fetchImpl, calls } = fakeFetch([])
    const { projector: p, results, mints } = projector(fetchImpl, { daemonId: 'another-daemon' })
    await p.apply(desiredFrame())

    expect(calls).toHaveLength(0)
    expect(mints()).toBe(0)
    expect(results[0]!.result).toMatchObject({ outcome: 'skipped', code: 'not_dispatch_owner' })
    expect(await store.getNoteProjection(DAEMON, PROJECTION)).toBeUndefined()
  })

  it('skips without any provider call when the write lease has already expired', async () => {
    const { fetchImpl, calls } = fakeFetch([])
    const { projector: p, results } = projector(fetchImpl)
    await p.apply(desiredFrame({ leaseUntil: '2026-08-22T09:59:00.000Z' }))

    expect(calls).toHaveLength(0)
    expect(results[0]!.result).toMatchObject({ outcome: 'skipped', code: 'lease_expired' })
  })

  it('refreshes the effect lease exactly once after a definite auth rejection, then retries', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 401 }, { status: 201, body: '{"id":12345}' }])
    const { projector: p, results, invalidated, mints } = projector(fetchImpl)
    await p.apply(desiredFrame())

    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST'])
    expect(invalidated).toEqual(['glpat-1'])
    expect(mints()).toBe(2)
    expect(results[0]!.result).toMatchObject({ outcome: 'written', noteId: '12345' })
  })

  it('fails deterministically after a second auth rejection instead of writing again', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 403 }, { status: 403 }])
    const { projector: p, results } = projector(fetchImpl)
    await p.apply(desiredFrame())

    expect(calls).toHaveLength(2)
    expect(results[0]!.result).toMatchObject({ outcome: 'failed', code: 'http_403' })
  })

  it('fails without a provider call when the effect lease is refused or clamped below comment', async () => {
    const refused = fakeFetch([])
    const a = projector(refused.fetchImpl, { leaseThrows: true })
    await a.projector.apply(desiredFrame())
    expect(refused.calls).toHaveLength(0)
    expect(a.results[0]!.result).toMatchObject({ outcome: 'failed', code: 'token_unavailable' })

    const clamped = fakeFetch([])
    const b = projector(clamped.fetchImpl, { access: 'read' })
    await b.projector.apply(desiredFrame({ writeMarker: MARKER_B, generation: '2' }))
    expect(clamped.calls).toHaveLength(0)
    expect(b.results[0]!.result).toMatchObject({ outcome: 'failed', code: 'insufficient_authority' })
  })

  it('refuses a frame whose natural key contradicts the projection key the ledger already holds', async () => {
    const first = fakeFetch([{ status: 201, body: '{"id":12345}' }])
    await projector(first.fetchImpl).projector.apply(desiredFrame())

    const second = fakeFetch([])
    const b = projector(second.fetchImpl)
    await b.projector.apply(desiredFrame({ generation: '2', writeMarker: MARKER_B, headSha: 'f'.repeat(40) }))

    expect(second.calls).toHaveLength(0)
    expect(b.results[0]!.result).toMatchObject({ outcome: 'skipped', code: 'projection_key_conflict' })
  })
})

describe('authority and outcome fences (round-2 review)', () => {
  it('never mutates when the effect grant was minted under a different credential epoch', async () => {
    const { fetchImpl, calls } = fakeFetch([])
    const { projector: p, results } = projector(fetchImpl, { leaseEpochs: ['2'] })
    await p.apply(desiredFrame())

    expect(calls).toHaveLength(0)
    expect(results[0]!.result).toMatchObject({ outcome: 'skipped', code: 'stale_credential_epoch' })
    // Stale authority must not leave a claim on the note either.
    expect((await store.getNoteProjection(DAEMON, PROJECTION))?.noteId).toBeUndefined()
  })

  it('re-checks the epoch after the auth refresh, so a purge mid-write stops the retry', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 401 }, { status: 201, body: '{"id":12345}' }])
    const { projector: p, results, invalidated } = projector(fetchImpl, { leaseEpochs: [EPOCH, '4'] })
    await p.apply(desiredFrame())

    expect(invalidated).toEqual(['glpat-1'])
    // The refreshed grant crossed a purge, so the second write never leaves the daemon.
    expect(calls).toHaveLength(1)
    expect(results[0]!.result).toMatchObject({ outcome: 'skipped', code: 'stale_credential_epoch' })
  })

  it('still writes when the refreshed grant carries the same epoch — the negative control', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 401 }, { status: 201, body: '{"id":12345}' }])
    const { projector: p, results } = projector(fetchImpl, { leaseEpochs: [EPOCH, EPOCH] })
    await p.apply(desiredFrame())

    expect(calls).toHaveLength(2)
    expect(results[0]!.result).toMatchObject({ outcome: 'written', noteId: '12345' })
  })

  it('treats an accepted create whose id is unreadable as ambiguous, then recovers it by marker', async () => {
    const created = fakeFetch([{ status: 201, body: 'not json at all' }])
    const a = projector(created.fetchImpl)
    await a.projector.apply(desiredFrame())

    expect(a.results[0]!.result).toMatchObject({ outcome: 'ambiguous', code: 'create_id_unreadable' })
    expect((await store.getNoteProjection(DAEMON, PROJECTION))?.phase).toBe('in_flight')

    const listed = JSON.stringify([{ id: 777, body: `${projectionMarker(PROJECTION)}\n**AgentConnect run**` }])
    const recovered = fakeFetch([
      { status: 200, body: listed },
      { status: 200, body: '{"id":777}' }
    ])
    const b = projector(recovered.fetchImpl)
    await b.projector.reconcilePending()

    // Reconciliation adopts the note GitLab really created; a redispatch would have posted a second one.
    expect(recovered.calls.map((c) => c.method)).toEqual(['GET', 'PUT'])
    expect(b.results[0]!.result).toMatchObject({ outcome: 'written', noteId: '777' })
  })

  it('keeps an update deterministic when its response is unreadable — the target id is already known', async () => {
    const first = fakeFetch([{ status: 201, body: '{"id":12345}' }])
    await projector(first.fetchImpl).projector.apply(desiredFrame())

    const second = fakeFetch([{ status: 200, body: 'not json at all' }])
    const b = projector(second.fetchImpl)
    await b.projector.apply(desiredFrame({ generation: '2', writeMarker: MARKER_B, state: 'completed' }))

    expect(second.calls.map((c) => c.method)).toEqual(['PUT'])
    expect(b.results[0]!.result).toMatchObject({ outcome: 'written', noteId: '12345', observedState: 'completed' })
  })

  it('reports ambiguous for a 5xx on the retried attempt, not a deterministic failure', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 401 }, { status: 500 }])
    const { projector: p, results } = projector(fetchImpl)
    await p.apply(desiredFrame())

    expect(calls).toHaveLength(2)
    // The refreshed POST may well have created the note, so only reconciliation may decide.
    expect(results[0]!.result).toMatchObject({ outcome: 'ambiguous', code: 'http_500' })
    expect((await store.getNoteProjection(DAEMON, PROJECTION))?.phase).toBe('in_flight')
  })

  it('keeps an answered 4xx on the retried attempt deterministic — the negative control', async () => {
    const { fetchImpl } = fakeFetch([{ status: 401 }, { status: 422 }])
    const { projector: p, results } = projector(fetchImpl)
    await p.apply(desiredFrame())

    expect(results[0]!.result).toMatchObject({ outcome: 'failed', code: 'http_422' })
    // Definite: the outcome was persisted, reported, and acknowledged in one pass.
    expect(await store.getNoteProjection(DAEMON, PROJECTION)).toMatchObject({ phase: 'settled', outcome: 'failed' })
  })

  it('replays a dropped result until the control plane takes it, exactly once in effect', async () => {
    const wrote = fakeFetch([{ status: 201, body: '{"id":12345}' }])
    const a = projector(wrote.fetchImpl, { reportRejections: 1 })
    await a.projector.apply(desiredFrame())

    // The note exists and the outcome is durable, but the control plane never heard it.
    expect(a.results).toHaveLength(0)
    const pending = await store.getNoteProjection(DAEMON, PROJECTION)
    expect(pending).toMatchObject({ phase: 'settled_unreported', outcome: 'written', noteId: '12345' })

    const replay = fakeFetch([])
    const b = projector(replay.fetchImpl)
    await b.projector.reconcilePending()

    // A replay touches no provider — the outcome is already definite.
    expect(replay.calls).toHaveLength(0)
    expect(b.results).toHaveLength(1)
    expect(b.results[0]!.result).toMatchObject({
      generation: '1',
      writeMarker: MARKER_A,
      outcome: 'written',
      noteId: '12345',
      observedState: 'queued'
    })
    expect((await store.getNoteProjection(DAEMON, PROJECTION))?.phase).toBe('settled')

    // Acknowledged means retired: a later sweep re-sends nothing.
    const after = projector(fakeFetch([]).fetchImpl)
    await after.projector.reconcilePending()
    expect(after.results).toHaveLength(0)
  })

  it('retires an unreported row the control plane permanently refuses instead of replaying forever', async () => {
    const wrote = fakeFetch([{ status: 201, body: '{"id":12345}' }])
    const a = projector(wrote.fetchImpl, { reportRejections: 1 })
    await a.projector.apply(desiredFrame())
    expect((await store.getNoteProjection(DAEMON, PROJECTION))?.phase).toBe('settled_unreported')

    const refused = projector(fakeFetch([]).fetchImpl, { reportRejections: 1, reportRetryable: false })
    await refused.projector.reconcilePending()

    // The control plane already moved past this generation; the row must not keep asking.
    expect(refused.results).toHaveLength(0)
    expect((await store.getNoteProjection(DAEMON, PROJECTION))?.phase).toBe('settled')
  })
})

/** Answers by METHOD rather than call order, so a multi-row sweep is not order-sensitive. */
function markerFetch(projectionKeys: string[]) {
  const calls: Call[] = []
  const listed = JSON.stringify(projectionKeys.map((key, i) => ({ id: 900 + i, body: projectionMarker(key) })))
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url: String(url) })
    if (method === 'GET') return new Response(listed, { status: 200 })
    return new Response('{"id":900}', { status: 200 })
  }) as typeof fetch
  return { fetchImpl, calls }
}

/** One shared-store handle, as a pool member (or a restarted one) opens it. */
async function sharedStore(path: string, ownerId: string): Promise<LocalStore> {
  return await LocalStore.open({
    database: SqliteAsyncDatabase.adopt(new DatabaseSync(path)),
    shared: true,
    ownerId,
    orgForAgent: () => 'org-1'
  })
}

describe('recovery scheduling and ownership (round-3 review)', () => {
  it('reconciles an ambiguous write on its own backoff, with no control-plane reconnect', async () => {
    const listed = JSON.stringify([{ id: 12345, body: projectionMarker(PROJECTION) }])
    const { fetchImpl, calls } = fakeFetch([
      { throws: true },
      { status: 200, body: listed },
      { status: 200, body: '{"id":12345}' }
    ])
    const { projector: p, results, clock } = projector(fetchImpl)
    await p.apply(desiredFrame())

    expect(results[0]!.result).toMatchObject({ outcome: 'ambiguous' })
    // The provider timed out while the control socket stayed healthy, so the writer arms its own retry.
    expect(clock.armed()).toBe(1)
    expect(clock.delays()).toEqual([RESWEEP_BASE_MS])

    clock.fire()
    await vi.waitFor(() => expect(results).toHaveLength(2))

    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET', 'PUT'])
    expect(results[1]!.result).toMatchObject({ outcome: 'written', noteId: '12345' })
    expect(await store.getNoteProjection(DAEMON, PROJECTION)).toMatchObject({ phase: 'settled' })
    // Nothing is owed any more, so the writer goes quiet instead of polling forever.
    expect(clock.armed()).toBe(0)
  })

  it('backs off exponentially to a cap while work remains, then stops once it settles', async () => {
    const listed = JSON.stringify([{ id: 12345, body: projectionMarker(PROJECTION) }])
    const { fetchImpl } = fakeFetch([
      { throws: true },
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 200, body: listed },
      { status: 200, body: '{"id":12345}' }
    ])
    const { projector: p, results, clock } = projector(fetchImpl)
    await p.apply(desiredFrame())

    for (let sweep = 0; sweep < 3; sweep += 1) {
      const before = results.length
      clock.fire()
      await vi.waitFor(() => expect(results.length).toBeGreaterThan(before))
    }
    // 30s, 60s, then pinned at the 120s cap — a wedged projection never becomes a hot loop.
    expect(clock.delays()).toEqual([RESWEEP_BASE_MS, 60_000, RESWEEP_CAP_MS, RESWEEP_CAP_MS])

    clock.fire()
    await vi.waitFor(() => expect(results).toHaveLength(5))
    expect(results[4]!.result).toMatchObject({ outcome: 'written', noteId: '12345' })
    expect(clock.armed()).toBe(0)
  })

  it('recovers a previous incarnation’s rows on a shared store, and only its own daemon’s', async () => {
    const poolRoot = mkdtempSync(join(tmpdir(), 'note-projection-pool-'))
    const path = statePath(poolRoot)
    await (await LocalStore.open(path)).close()
    const first = await sharedStore(path, 'incarnation-1')

    // One write left in flight, and one whose definite outcome the control plane never acknowledged.
    const stalled = projector(fakeFetch([{ throws: true }]).fetchImpl, { store: first })
    await stalled.projector.apply(desiredFrame())
    const unreported = projector(fakeFetch([{ status: 201, body: '{"id":901}' }]).fetchImpl, {
      store: first,
      reportRejections: 1
    })
    await unreported.projector.apply(desiredFrame({ projectionId: PROJECTION_B, projectionKey: PROJECTION_B }))
    expect(await first.getNoteProjection(DAEMON, PROJECTION)).toMatchObject({ phase: 'in_flight' })
    expect(await first.getNoteProjection(DAEMON, PROJECTION_B)).toMatchObject({ phase: 'settled_unreported' })

    // A RESTART: same daemon identity, a brand-new process incarnation over the same database.
    const second = await sharedStore(path, 'incarnation-2')

    // The negative control runs first, while both rows are still owed: a pool peer sees neither.
    const peerFetch = markerFetch([PROJECTION])
    const peer = projector(peerFetch.fetchImpl, { store: second, daemonId: 'peer-daemon-id' })
    await peer.projector.reconcilePending()
    expect(peer.results).toHaveLength(0)
    expect(peerFetch.calls).toHaveLength(0)
    expect(peer.clock.armed()).toBe(0)

    const recovery = markerFetch([PROJECTION, PROJECTION_B])
    const restarted = projector(recovery.fetchImpl, { store: second })
    await restarted.projector.reconcilePending()

    // Both rows are this daemon identity's to finish, whatever process started them.
    expect(restarted.results).toHaveLength(2)
    expect(restarted.results.map((r) => r.result.outcome)).toEqual(['written', 'written'])
    expect(await second.getNoteProjection(DAEMON, PROJECTION)).toMatchObject({ phase: 'settled' })
    expect(await second.getNoteProjection(DAEMON, PROJECTION_B)).toMatchObject({ phase: 'settled', noteId: '901' })
    expect(restarted.clock.armed()).toBe(0)

    await second.close()
    await first.close()
    rmSync(poolRoot, { recursive: true, force: true })
  })
})

describe('resweep scheduling edges (round-4 review)', () => {
  it('continues the backoff when a fired sweep cannot read the ledger at all', async () => {
    const listed = JSON.stringify([{ id: 12345, body: projectionMarker(PROJECTION) }])
    const { fetchImpl, calls } = fakeFetch([
      { throws: true },
      { status: 200, body: listed },
      { status: 200, body: '{"id":12345}' }
    ])
    // The scan fails once, on the sweep the first armed timer fires.
    const { projector: p, results, clock } = projector(fetchImpl, { scanFailures: 1 })
    await p.apply(desiredFrame())
    expect(clock.delays()).toEqual([RESWEEP_BASE_MS])

    clock.fire()
    // An unreadable ledger proves nothing about the durable work, so the chain must not end here.
    await vi.waitFor(() => expect(clock.delays()).toEqual([RESWEEP_BASE_MS, 60_000]))
    expect(clock.armed()).toBe(1)
    expect(calls).toHaveLength(1)

    clock.fire()
    await vi.waitFor(() => expect(results).toHaveLength(2))
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET', 'PUT'])
    expect(results[1]!.result).toMatchObject({ outcome: 'written', noteId: '12345' })
    expect(await store.getNoteProjection(DAEMON, PROJECTION)).toMatchObject({ phase: 'settled' })
    expect(clock.armed()).toBe(0)
  })

  it('never lets a zero-work disarm clear a timer that concurrent new work just armed', async () => {
    const listed = JSON.stringify([{ id: 12345, body: projectionMarker(PROJECTION) }])
    const { fetchImpl, calls } = fakeFetch([
      { throws: true },
      { status: 200, body: listed },
      { status: 200, body: '{"id":12345}' }
    ])
    // A box, because the hook must reach the projector the same call is still constructing.
    const box: { projector?: CodeHostNoteProjector } = {}
    const started = projector(fetchImpl, {
      // The interleave: the sweep has already read an EMPTY ledger when new work arms the timer.
      onFirstScan: async () => {
        await box.projector!.apply(desiredFrame())
      }
    })
    box.projector = started.projector

    await started.projector.reconcilePending()

    // The sweep decided there was nothing to do, but that decision predates the row now on disk.
    expect(started.results[0]!.result).toMatchObject({ outcome: 'ambiguous' })
    expect(started.clock.armed()).toBe(1)
    expect(await store.getNoteProjection(DAEMON, PROJECTION)).toMatchObject({ phase: 'in_flight' })

    started.clock.fire()
    await vi.waitFor(() => expect(started.results).toHaveLength(2))
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET', 'PUT'])
    expect(started.results[1]!.result).toMatchObject({ outcome: 'written', noteId: '12345' })
    expect(started.clock.armed()).toBe(0)
  })

  it('fences the disarm even when the racing work reused an ALREADY armed timer', async () => {
    const listed = JSON.stringify([{ id: 700, body: projectionMarker(PROJECTION_B) }])
    const { fetchImpl, calls } = fakeFetch([
      { throws: true },
      { throws: true },
      { status: 200, body: listed },
      { status: 200, body: '{"id":700}' }
    ])
    const box: { projector?: CodeHostNoteProjector } = {}
    const started = projector(fetchImpl, {
      onFirstScan: async () => {
        // Arms while a timer is already pending, so arm() takes its early-return path.
        await box.projector!.apply(
          desiredFrame({ projectionId: PROJECTION_B, projectionKey: PROJECTION_B, writeMarker: MARKER_B })
        )
      }
    })
    box.projector = started.projector

    await started.projector.apply(desiredFrame())
    expect(started.clock.delays()).toEqual([RESWEEP_BASE_MS])

    // Retire the first row out of band: the next scan reads an empty ledger with the timer still up.
    const first = (await store.getNoteProjection(DAEMON, PROJECTION))!
    await store.recordNoteProjectionOutcome(first, 'written', undefined, NOW)
    await store.markNoteProjectionReported(DAEMON, PROJECTION, MARKER_A, NOW)

    await started.projector.reconcilePending()

    // No second timer was scheduled — this is the reused-timer path — and it survived the disarm.
    expect(started.clock.delays()).toEqual([RESWEEP_BASE_MS])
    expect(started.clock.armed()).toBe(1)
    expect(await store.getNoteProjection(DAEMON, PROJECTION_B)).toMatchObject({ phase: 'in_flight' })

    started.clock.fire()
    await vi.waitFor(() => expect(started.results).toHaveLength(3))
    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST', 'GET', 'PUT'])
    expect(started.results[2]!.result).toMatchObject({ outcome: 'written', noteId: '700' })
    expect(started.clock.armed()).toBe(0)
  })
})

describe('the run-projection template', () => {
  it('names the three authorized re-request paths on a superseded or interrupted note', () => {
    for (const state of ['superseded', 'interrupted'] as CodeHostNoteState[]) {
      const body = renderProjectionNote(desiredFrame({ state }))
      expect(body).toContain('re-request a review from the project service account')
      expect(body).toContain('mention the agent explicitly')
      expect(body).toContain('"Run again" in the AgentConnect Console')
    }
    // A live generation carries no re-request sentence — nothing has ended yet.
    expect(renderProjectionNote(desiredFrame({ state: 'running' }))).not.toContain('To run again')
  })

  it('renders the fixed control fields and the stable marker, and nothing else', () => {
    const body = renderProjectionNote(
      desiredFrame({
        state: 'completed',
        reason: 'agent_handover',
        startedAt: '2026-08-22T09:59:30.000Z',
        completedAt: '2026-08-22T10:00:00.000Z',
        consoleUrl: 'https://console.example.test/example-org/sessions/s-1?source=gitlab'
      })
    )
    expect(body).toContain(projectionMarker(PROJECTION))
    expect(body).toContain('**AgentConnect run — Completed**')
    expect(body).toContain('- Agent: Reviewer')
    expect(body).toContain('- Revision: `abc123de`')
    expect(body).toContain('- Reason: `agent_handover`')
    expect(body).toContain('- Queued: 2026-08-22T09:59:00.000Z')
    expect(body).toContain('- Started: 2026-08-22T09:59:30.000Z')
    expect(body).toContain('- Completed: 2026-08-22T10:00:00.000Z')
    expect(body).toContain(
      '[View this run in the Console](https://console.example.test/example-org/sessions/s-1?source=gitlab)'
    )
    // The abbreviation only: a full revision would make the note a diff-adjacent artifact.
    expect(body).not.toContain(HEAD)
  })

  it('lets no field outside the template reach the body, and no display name break out of it', () => {
    const smuggled = 'SMUGGLED-PAYLOAD'
    const body = renderProjectionNote(
      desiredFrame({
        agentName: `Rev\niewer <script> [x](y) --> ${smuggled.toLowerCase()}`,
        projectPath: smuggled,
        deliveryKey: smuggled,
        projectionId: PROJECTION,
        consoleUrl: `javascript:alert(1)//${smuggled}` as string
      })
    )
    expect(body).not.toContain(smuggled)
    // The display name is one escaped line: it can neither close the marker nor open Markdown structure.
    expect(body.split('\n').filter((line) => line.startsWith('- Agent: '))).toHaveLength(1)
    expect(body.indexOf('-->')).toBe(
      body.indexOf(projectionMarker(PROJECTION)) + projectionMarker(PROJECTION).length - 3
    )
    // A non-http(s) link is not a Console link, so it never becomes one.
    expect(body).not.toContain('javascript:')
  })
})

describe('feature negotiation (§17.3)', () => {
  it('advertises codehost-note-projection-v1 so the Control Plane starts sending desired frames', async () => {
    const daemonRoot = mkdtempSync(join(tmpdir(), 'note-projection-feature-'))
    writeFileSync(
      join(daemonRoot, 'config.json'),
      JSON.stringify({ version: 1, controlPlane: { enabled: false }, runtimes: {} })
    )
    mkdirSync(join(daemonRoot, 'agents'), { recursive: true })
    const daemon = new Daemon({
      root: daemonRoot,
      hostFactory: () => ({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }) as never
    })
    await daemon.start()
    const features = (daemon as never as { registrationFeatures: () => string[] }).registrationFeatures()
    await daemon.stop().catch(() => undefined)
    rmSync(daemonRoot, { recursive: true, force: true })

    expect(features).toContain(CODEHOST_NOTE_PROJECTION_V1_FEATURE)
    // The projection rides the GitLab surface, so the older bit stays advertised beside it.
    expect(features).toContain(GITLAB_COM_V1_FEATURE)
  }, 20_000)
})
