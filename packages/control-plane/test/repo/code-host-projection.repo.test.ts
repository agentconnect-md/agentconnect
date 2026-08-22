/**
 * The §16 desired-generation ledger's durable rules, against real Postgres: the
 * generation advance and its terminal `sealedThrough` watermark, supersession on
 * a newer head, the write mutex and its out-of-order settlement fence, the
 * parked pending intent, and the one-way tombstone.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { AgentId, HookId, OrgId } from '../../src/domain/ids.js'
import { PgCodeHostRunProjectionRepo } from '../../src/persistence/repositories/code-host-projection.repo.js'
import type { UpsertCodeHostRunProjectionInput } from '../../src/persistence/ports.js'

const NOW = new Date('2026-07-07T00:00:00.000Z')
const LATER = new Date('2026-07-07T00:01:00.000Z')
const HEAD = 'a'.repeat(40)
const NEXT_HEAD = 'b'.repeat(40)
const PROJECT = 4455667n
const DAEMON = '00000000-0000-4000-8000-0000000000d1'

const repo = () => new PgCodeHostRunProjectionRepo(prisma)

function input(overrides: Partial<UpsertCodeHostRunProjectionInput> = {}): UpsertCodeHostRunProjectionInput {
  return {
    provider: 'gitlab',
    hookId: HookId(randomUUID()),
    orgId: OrgId(DEFAULT_ORG_ID),
    agentId: AgentId(randomUUID()),
    agentName: 'reviewer',
    projectId: PROJECT,
    projectPath: 'example-group/example-project',
    mergeRequestIid: 42,
    headSha: HEAD,
    projectionEpoch: 1n,
    desiredState: 'queued',
    currentDeliveryKey: 'delivery-1',
    currentRunAt: NOW,
    // The accepted dispatch tuple, stored verbatim so the desired frame echoes it.
    configRevision: 3n,
    dispatchRevision: 5n,
    dispatchDaemonId: DAEMON,
    reviewPolicySnapshot: 'off',
    reportingModeSnapshot: 'off',
    gateModeSnapshot: 'informational',
    nextAttemptAt: NOW,
    ...overrides
  }
}

describe('code-host run projection ledger (gitlab-com-integration.md §16)', () => {
  it('opens generation 1 and advances it only for a strictly newer delivery', async () => {
    const ledger = repo()
    const base = input()
    const opened = await ledger.upsert(base)
    expect(opened.generation).toBe(1n)
    expect(opened.externalId).toBe(opened.id)
    expect(opened.dispatchDaemonId).toBe(DAEMON)
    expect(opened.reportingModeSnapshot).toBe('off')

    // A later edge of the SAME delivery keeps the generation — the state moves inside it.
    const same = await ledger.upsert({ ...base, desiredState: 'completed', completedAt: LATER })
    expect(same.generation).toBe(1n)
    expect(await ledger.setDesired(same.id, same.generation, 'completed', LATER)).toBe(true)

    // A NEW delivery on the same head is a re-request: a fresh generation with a clean slate.
    const rerun = await ledger.upsert({
      ...base,
      desiredState: 'queued',
      currentDeliveryKey: 'delivery-2',
      currentRunAt: LATER
    })
    expect(rerun.generation).toBe(2n)
    expect(rerun.desiredState).toBe('queued')
    expect(rerun.observedState).toBeNull()

    // An OLDER delivery never takes the row back from the newer one.
    const stale = await ledger.upsert({
      ...base,
      desiredState: 'failed',
      currentDeliveryKey: 'delivery-0',
      currentRunAt: new Date(NOW.getTime() - 60_000)
    })
    expect(stale.generation).toBe(2n)
    expect(stale.currentDeliveryKey).toBe('delivery-2')
  })

  it('seals a terminal generation against a delayed queued edge', async () => {
    const ledger = repo()
    const base = input({ desiredState: 'completed', completedAt: NOW })
    const opened = await ledger.upsert(base)
    expect(opened.sealedThrough).toBe(1n)
    // The late lifecycle hint loses; the terminal authority stands.
    expect(await ledger.setDesired(opened.id, opened.generation, 'queued', LATER)).toBe(false)
    expect((await ledger.get(opened.id))!.desiredState).toBe('completed')
    // A terminal state may still replace a terminal state on the same generation.
    expect(await ledger.setDesired(opened.id, opened.generation, 'failed', LATER)).toBe(true)
  })

  it('supersedes every older head on the merge request and leaves the current one alone', async () => {
    const ledger = repo()
    const hookId = HookId(randomUUID())
    const old = await ledger.upsert(input({ hookId, headSha: HEAD }))
    const other = await ledger.upsert(input({ hookId, headSha: HEAD, mergeRequestIid: 7 }))
    const current = await ledger.upsert(input({ hookId, headSha: NEXT_HEAD, currentDeliveryKey: 'delivery-2' }))

    expect(await ledger.supersede(hookId, PROJECT, 42, NEXT_HEAD, LATER)).toBe(1)
    const superseded = (await ledger.get(old.id))!
    expect(superseded.desiredState).toBe('superseded')
    expect(superseded.generation).toBe(2n)
    expect(superseded.sealedThrough).toBe(2n)
    expect((await ledger.get(current.id))!.desiredState).toBe('queued')
    // A different merge request on the same hook is a different subject.
    expect((await ledger.get(other.id))!.desiredState).toBe('queued')
    // Supersession is idempotent — a second pass finds nothing left to preempt.
    expect(await ledger.supersede(hookId, PROJECT, 42, NEXT_HEAD, LATER)).toBe(0)
  })

  it('holds one write at a time and ignores an older generation settling it', async () => {
    const ledger = repo()
    const base = input()
    const opened = await ledger.upsert(base)
    const marker = randomUUID()
    expect(await ledger.beginWrite(opened.id, 1n, DAEMON, marker, 'create', NOW, LATER)).toBe(true)
    // Ownership may not move while a mutation is in flight — not to another daemon, not to a retry.
    expect(await ledger.beginWrite(opened.id, 1n, DAEMON, randomUUID(), 'update', NOW, LATER)).toBe(false)

    // A terminal edge lands mid-write: it parks rather than moving the generation.
    const parked = await ledger.upsert({
      ...base,
      desiredState: 'completed',
      currentDeliveryKey: 'delivery-2',
      currentRunAt: LATER,
      completedAt: LATER
    })
    expect(parked.generation).toBe(1n)
    expect(parked.pendingIntent).toMatchObject({ desiredState: 'completed' })

    // Out-of-order settlement fences: wrong generation, wrong owner, wrong marker all no-op.
    const settle = { projectionId: opened.id, observedState: 'queued' as const, noteId: '987654321' }
    expect(await ledger.completeWrite({ ...settle, generation: 0n, leaseOwner: DAEMON, writeMarker: marker })).toBe(
      false
    )
    expect(await ledger.completeWrite({ ...settle, generation: 1n, leaseOwner: 'other', writeMarker: marker })).toBe(
      false
    )
    expect(
      await ledger.completeWrite({ ...settle, generation: 1n, leaseOwner: DAEMON, writeMarker: randomUUID() })
    ).toBe(false)
    expect((await ledger.get(opened.id))!.noteId).toBeNull()

    expect(await ledger.completeWrite({ ...settle, generation: 1n, leaseOwner: DAEMON, writeMarker: marker })).toBe(
      true
    )
    const settled = (await ledger.get(opened.id))!
    expect(settled.noteId).toBe('987654321')
    expect(settled.observedState).toBe('queued')
    expect(settled.writeMarker).toBeNull()
    expect(settled.leaseOwner).toBeNull()

    // The parked intent now drains into a fresh generation.
    const advanced = await ledger.advancePending(opened.id, 1n, LATER)
    expect(advanced!.generation).toBe(2n)
    expect(advanced!.desiredState).toBe('completed')
    expect(advanced!.sealedThrough).toBe(2n)
    expect(advanced!.pendingIntent).toBeNull()
  })

  it('keeps an ambiguous mutation fail-closed on its writer and releases a proved non-effect', async () => {
    const ledger = repo()
    const opened = await ledger.upsert(input())
    const marker = randomUUID()
    await ledger.beginWrite(opened.id, 1n, DAEMON, marker, 'create', NOW, LATER)
    expect(await ledger.failWrite(opened.id, 1n, DAEMON, 'ambiguous_write', LATER, true)).toBe(true)
    const held = (await ledger.get(opened.id))!
    expect(held.writeMarker).toBe(marker)
    expect(held.attempts).toBe(1)
    // Nobody may start a second mutation while the ambiguous one is unreconciled.
    expect(await ledger.beginWrite(opened.id, 1n, DAEMON, randomUUID(), 'update', NOW, LATER)).toBe(false)

    await ledger.beginWrite(opened.id, 1n, DAEMON, marker, 'create', NOW, LATER)
    expect(await ledger.failWrite(opened.id, 1n, DAEMON, 'forbidden', LATER, false)).toBe(false)
  })

  it('makes a tombstone one-way: no revival, no desired-state change, no generation advance', async () => {
    const ledger = repo()
    const base = input()
    const opened = await ledger.upsert(base)
    expect(await ledger.tombstone([base.hookId], LATER)).toBe(1)
    const dead = (await ledger.get(opened.id))!
    expect(dead.tombstonedAt).toEqual(LATER)
    expect(dead.desiredState).toBe('skipped')
    expect(dead.generation).toBe(2n)

    // A delayed lifecycle edge observes the historical run but may never revive the row.
    const delayed = await ledger.upsert({
      ...base,
      desiredState: 'completed',
      currentDeliveryKey: 'delivery-2',
      currentRunAt: LATER
    })
    expect(delayed.generation).toBe(2n)
    expect(delayed.desiredState).toBe('skipped')
    expect(await ledger.setDesired(opened.id, 2n, 'completed', LATER)).toBe(false)
    // Tombstoning again is idempotent rather than a second cleanup generation.
    expect(await ledger.tombstone([base.hookId], LATER)).toBe(0)
  })
})
