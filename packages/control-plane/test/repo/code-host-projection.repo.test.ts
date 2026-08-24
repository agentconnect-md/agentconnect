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
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { AgentId, DaemonId, HookId, OrgId } from '../../src/domain/ids.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import {
  PgCodeHostRunProjectionRepo,
  tombstoneCodeHostRunProjections
} from '../../src/persistence/repositories/code-host-projection.repo.js'
import { PgHookRepo } from '../../src/persistence/repositories/hook.repo.js'
import type { UpsertCodeHostRunProjectionInput } from '../../src/persistence/ports.js'

const NOW = new Date('2026-07-07T00:00:00.000Z')
const LATER = new Date('2026-07-07T00:01:00.000Z')
const HEAD = 'a'.repeat(40)
const NEXT_HEAD = 'b'.repeat(40)
const PROJECT = 4455667n
const DAEMON = '00000000-0000-4000-8000-0000000000d1'
const NEXT_DAEMON = '00000000-0000-4000-8000-0000000000d2'

const repo = () => new PgCodeHostRunProjectionRepo(prisma)
const hooks = () => new PgHookRepo(prisma)
const tombstone = (hookIds: string[]) =>
  prisma.$transaction((tx) => tombstoneCodeHostRunProjections(tx, { hookIds }, LATER))

/** A live owner: creation is fenced on the HookDef, so every test needs a real one. */
async function owner(): Promise<{ hookId: HookId; agentId: AgentId }> {
  const daemonId = DaemonId(randomUUID())
  await seedDaemon(prisma, daemonId)
  const agentId = AgentId(randomUUID())
  await seedAgent(prisma, agentId, { daemonId, name: `agent-${randomUUID().slice(0, 8)}` })
  const hook = await hooks().upsert({
    hookId: HookId(randomUUID()),
    orgId: OrgId(DEFAULT_ORG_ID),
    agentId,
    kind: 'gitlab',
    axisBaseUrl: 'https://gitlab.com',
    name: `gitlab review ${randomUUID().slice(0, 8)}`,
    sessionMode: 'perThread',
    repoId: PROJECT,
    events: ['merge_request:*']
  })
  return { hookId: hook.id, agentId }
}

/** Upsert that must have produced a row — the null arm is the retired-owner refusal. */
async function upsert(overrides: Partial<UpsertCodeHostRunProjectionInput> & { hookId: HookId; agentId: AgentId }) {
  const row = await repo().upsert(input(overrides))
  expect(row).not.toBeNull()
  return row!
}

function input(
  overrides: Partial<UpsertCodeHostRunProjectionInput> & { hookId: HookId; agentId: AgentId }
): UpsertCodeHostRunProjectionInput {
  return {
    provider: 'gitlab',
    orgId: OrgId(DEFAULT_ORG_ID),
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
    const base = input(await owner())
    const opened = await upsert(base)
    expect(opened.generation).toBe(1n)
    expect(opened.externalId).toBe(opened.id)
    expect(opened.dispatchDaemonId).toBe(DAEMON)
    expect(opened.reportingModeSnapshot).toBe('off')

    // A later edge of the SAME delivery keeps the generation — the state moves inside it.
    const same = await upsert({ ...base, desiredState: 'completed', completedAt: LATER })
    expect(same.generation).toBe(1n)
    expect(await ledger.setDesired(same.id, same.generation, 'completed', LATER)).toBe(true)

    // A NEW delivery on the same head is a re-request: a fresh generation with a clean slate.
    const rerun = await upsert({
      ...base,
      desiredState: 'queued',
      currentDeliveryKey: 'delivery-2',
      currentRunAt: LATER
    })
    expect(rerun.generation).toBe(2n)
    expect(rerun.desiredState).toBe('queued')
    expect(rerun.observedState).toBeNull()

    // An OLDER delivery never takes the row back from the newer one.
    const stale = await upsert({
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
    const base = input({ ...(await owner()), desiredState: 'completed', completedAt: NOW })
    const opened = await upsert(base)
    expect(opened.sealedThrough).toBe(1n)
    // The late lifecycle hint loses; the terminal authority stands.
    expect(await ledger.setDesired(opened.id, opened.generation, 'queued', LATER)).toBe(false)
    expect((await ledger.get(opened.id))!.desiredState).toBe('completed')
    // A terminal state may still replace a terminal state on the same generation.
    expect(await ledger.setDesired(opened.id, opened.generation, 'failed', LATER)).toBe(true)
  })

  it('supersedes every older head on the merge request and leaves the current one alone', async () => {
    const ledger = repo()
    const subject = await owner()
    const { hookId } = subject
    const old = await upsert({ ...subject, headSha: HEAD })
    const other = await upsert({ ...subject, headSha: HEAD, mergeRequestIid: 7 })
    const current = await upsert({ ...subject, headSha: NEXT_HEAD, currentDeliveryKey: 'delivery-2' })

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
    const base = input(await owner())
    const opened = await upsert(base)
    const marker = randomUUID()
    expect(await ledger.beginWrite(opened.id, 1n, DAEMON, marker, 'create', NOW, LATER)).toBe(true)
    // Ownership may not move while a mutation is in flight — not to another daemon, not to a retry.
    expect(await ledger.beginWrite(opened.id, 1n, DAEMON, randomUUID(), 'update', NOW, LATER)).toBe(false)

    // A terminal edge lands mid-write: it parks rather than moving the generation.
    const parked = await upsert({
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

  it('lets the terminal edge of a run win after the daemon refused its non-terminal write', async () => {
    const ledger = repo()
    const base = input(await owner())
    const opened = await upsert(base)
    // The create lands: the note exists and reads queued.
    const created = randomUUID()
    expect(await ledger.beginWrite(opened.id, 1n, DAEMON, created, 'create', NOW, LATER)).toBe(true)
    expect(
      await ledger.completeWrite({
        projectionId: opened.id,
        generation: 1n,
        leaseOwner: DAEMON,
        writeMarker: created,
        observedState: 'queued',
        noteId: '987654321'
      })
    ).toBe(true)

    // The running edge of the SAME run moves the state inside this generation, and the daemon
    // refuses that write with a ledger code — a proved non-effect, so the mutex is released.
    expect(await ledger.setDesired(opened.id, 1n, 'running', LATER)).toBe(true)
    const refused = randomUUID()
    expect(await ledger.beginWrite(opened.id, 1n, DAEMON, refused, 'update', NOW, LATER)).toBe(true)
    expect(await ledger.failWrite(opened.id, 1n, DAEMON, refused, 'projection_key_conflict', LATER, false)).toBe(true)
    const stuck = (await ledger.get(opened.id))!
    expect(stuck.desiredState).toBe('running')
    expect(stuck.observedState).toBe('queued')
    expect(stuck.attempts).toBe(1)
    expect(stuck.lastErrorCode).toBe('projection_key_conflict')

    // Nothing re-dispatches a refused generation on its own, so the terminal edge is the only
    // thing that can move this row — a refusal must never cost the run its final state.
    const reported = await upsert({ ...base, desiredState: 'completed', currentRunAt: LATER, completedAt: LATER })
    expect(reported.generation).toBe(1n)
    expect(reported.pendingIntent).toBeNull()
    expect(await ledger.setDesired(opened.id, 1n, 'completed', LATER)).toBe(true)
    const terminal = (await ledger.get(opened.id))!
    expect(terminal.desiredState).toBe('completed')
    expect(terminal.sealedThrough).toBe(1n)
    // And it is dispatchable: the refusal left no marker or lease behind to fence the write out.
    expect(terminal.writeMarker).toBeNull()
    expect(terminal.writePhase).toBeNull()
    expect(await ledger.beginWrite(opened.id, 1n, DAEMON, randomUUID(), 'update', LATER, LATER)).toBe(true)
  })

  it('keeps an ambiguous mutation on its writer and lets that writer reconcile it', async () => {
    const ledger = repo()
    const opened = await upsert(await owner())
    const marker = randomUUID()
    await ledger.beginWrite(opened.id, 1n, DAEMON, marker, 'create', NOW, LATER)
    expect(await ledger.failWrite(opened.id, 1n, DAEMON, marker, 'ambiguous_write', LATER, true)).toBe(true)
    const held = (await ledger.get(opened.id))!
    expect(held.writeMarker).toBe(marker)
    expect(held.attempts).toBe(1)
    // The owner is PRESERVED, otherwise no reconciliation could ever settle this attempt.
    expect(held.leaseOwner).toBe(DAEMON)
    // Nobody may start a second mutation while the ambiguous one is unreconciled.
    expect(await ledger.beginWrite(opened.id, 1n, DAEMON, randomUUID(), 'update', NOW, LATER)).toBe(false)
    // Another daemon may not settle it either.
    expect(
      await ledger.completeWrite({
        projectionId: opened.id,
        generation: 1n,
        leaseOwner: 'other-daemon',
        writeMarker: marker,
        observedState: 'queued',
        noteId: '111'
      })
    ).toBe(false)

    // The original writer reconciles by the hidden marker and settles the attempt.
    expect(
      await ledger.completeWrite({
        projectionId: opened.id,
        generation: 1n,
        leaseOwner: DAEMON,
        writeMarker: marker,
        observedState: 'queued',
        noteId: '987654321'
      })
    ).toBe(true)
    const settled = (await ledger.get(opened.id))!
    expect(settled.noteId).toBe('987654321')
    expect(settled.writeMarker).toBeNull()
    expect(settled.leaseOwner).toBeNull()
  })

  it('ignores a late duplicate of an earlier attempt on every settlement path', async () => {
    const ledger = repo()
    const opened = await upsert(await owner())
    const first = randomUUID()
    await ledger.beginWrite(opened.id, 1n, DAEMON, first, 'create', NOW, LATER)
    // Attempt 1 proved a non-effect and released the mutex; attempt 2 then took it.
    expect(await ledger.failWrite(opened.id, 1n, DAEMON, first, 'forbidden', LATER, false)).toBe(true)
    const second = randomUUID()
    expect(await ledger.beginWrite(opened.id, 1n, DAEMON, second, 'create', NOW, LATER)).toBe(true)

    // A duplicate of attempt 1's result must not clear attempt 2's mutex.
    expect(await ledger.failWrite(opened.id, 1n, DAEMON, first, 'forbidden', LATER, false)).toBe(false)
    expect(
      await ledger.completeWrite({
        projectionId: opened.id,
        generation: 1n,
        leaseOwner: DAEMON,
        writeMarker: first,
        observedState: 'queued',
        noteId: '111'
      })
    ).toBe(false)
    const stillHeld = (await ledger.get(opened.id))!
    expect(stillHeld.writeMarker).toBe(second)
    expect(stillHeld.noteId).toBeNull()
  })

  it("drains a parked edge with its OWN placement and credential fence, not the in-flight run's", async () => {
    const ledger = repo()
    const base = input(await owner())
    const opened = await upsert(base)
    await ledger.beginWrite(opened.id, 1n, DAEMON, randomUUID(), 'create', NOW, LATER)

    // Run B arrives mid-write after the agent moved and credentials rotated.
    const parked = await upsert({
      ...base,
      desiredState: 'queued',
      currentDeliveryKey: 'delivery-2',
      currentRunAt: LATER,
      queuedAt: LATER,
      sessionId: 'sess-b',
      dispatchDaemonId: NEXT_DAEMON,
      configRevision: 9n,
      dispatchRevision: 11n,
      credentialEpoch: 4n
    })
    expect(parked.generation).toBe(1n)
    expect(parked.dispatchDaemonId).toBe(DAEMON)

    await ledger.completeWrite({
      projectionId: opened.id,
      generation: 1n,
      leaseOwner: DAEMON,
      writeMarker: (await ledger.get(opened.id))!.writeMarker!,
      observedState: 'queued',
      noteId: '987654321'
    })
    const drained = (await ledger.advancePending(opened.id, 1n, LATER))!
    expect(drained.generation).toBe(2n)
    // B's authority, end to end — dispatching this to DAEMON would target the previous placement.
    expect(drained.dispatchDaemonId).toBe(NEXT_DAEMON)
    expect(drained.configRevision).toBe(9n)
    expect(drained.dispatchRevision).toBe(11n)
    expect(drained.credentialEpoch).toBe(4n)
    expect(drained.sessionId).toBe('sess-b')
    expect(drained.queuedAt).toEqual(LATER)
    expect(drained.currentDeliveryKey).toBe('delivery-2')
  })

  it("keeps the running delivery's own timestamps when its later edge parks", async () => {
    const ledger = repo()
    const base = input({ ...(await owner()), queuedAt: NOW })
    const opened = await upsert(base)
    await ledger.beginWrite(opened.id, 1n, DAEMON, randomUUID(), 'create', NOW, LATER)
    // Same delivery, terminal edge: it carries completedAt but not queuedAt.
    await upsert({ ...base, desiredState: 'completed', completedAt: LATER, sessionId: 'sess-a' })
    await ledger.completeWrite({
      projectionId: opened.id,
      generation: 1n,
      leaseOwner: DAEMON,
      writeMarker: (await ledger.get(opened.id))!.writeMarker!,
      observedState: 'queued'
    })
    const drained = (await ledger.advancePending(opened.id, 1n, LATER))!
    expect(drained.desiredState).toBe('completed')
    expect(drained.queuedAt).toEqual(NOW)
    expect(drained.completedAt).toEqual(LATER)
    expect(drained.sessionId).toBe('sess-a')
  })

  it('makes a tombstone one-way: no revival, no desired-state change, no generation advance', async () => {
    const ledger = repo()
    const base = input(await owner())
    const opened = await upsert(base)
    // The production entry point is the transaction-scoped helper the owner lifecycles call.
    expect(await tombstone([base.hookId])).toBe(1)
    const dead = (await ledger.get(opened.id))!
    expect(dead.tombstonedAt).toEqual(LATER)
    expect(dead.desiredState).toBe('skipped')
    expect(dead.generation).toBe(2n)

    // A delayed lifecycle edge observes the historical run but may never revive the row.
    const delayed = await upsert({
      ...base,
      desiredState: 'completed',
      currentDeliveryKey: 'delivery-2',
      currentRunAt: LATER
    })
    expect(delayed.generation).toBe(2n)
    expect(delayed.desiredState).toBe('skipped')
    expect(await ledger.setDesired(opened.id, 2n, 'completed', LATER)).toBe(false)
    // Tombstoning again is idempotent rather than a second cleanup generation.
    expect(await tombstone([base.hookId])).toBe(0)
  })
})

describe('projection cleanup rides the owner lifecycle, not a route', () => {
  it('commits the cleanup intent in the same transaction that deletes the hook', async () => {
    const subject = await owner()
    const projection = await upsert(subject)

    await hooks().remove(OrgId(DEFAULT_ORG_ID), subject.hookId, subject.agentId)
    // The HookDef is gone AND the FK-free ledger row carries cleanup intent — one transaction.
    expect(await prisma.hookDef.findUnique({ where: { id: subject.hookId } })).toBeNull()
    const dead = (await repo().get(projection.id))!
    expect(dead.tombstonedAt).not.toBeNull()
    expect(dead.desiredState).toBe('skipped')
  })

  it('tombstones through the agent-delete cascade, which never enters an HTTP route', async () => {
    const subject = await owner()
    const projection = await upsert(subject)

    await new PgAgentRepo(prisma).delete(OrgId(DEFAULT_ORG_ID), subject.agentId)
    expect(await prisma.hookDef.findUnique({ where: { id: subject.hookId } })).toBeNull()
    const dead = (await repo().get(projection.id))!
    expect(dead.tombstonedAt).not.toBeNull()
    expect(dead.desiredState).toBe('skipped')
  })

  it('parks cleanup behind an in-flight write instead of stomping its mutex', async () => {
    const subject = await owner()
    const projection = await upsert(subject)
    const marker = randomUUID()
    await repo().beginWrite(projection.id, 1n, DAEMON, marker, 'create', NOW, LATER)

    await hooks().remove(OrgId(DEFAULT_ORG_ID), subject.hookId, subject.agentId)
    const parked = (await repo().get(projection.id))!
    expect(parked.tombstonedAt).not.toBeNull()
    expect(parked.writeMarker).toBe(marker)
    expect(parked.pendingIntent).toMatchObject({ desiredState: 'skipped', tombstoned: true })

    // The daemon's result still settles after the hook is gone, and the tombstone then drains.
    expect(
      await repo().completeWrite({
        projectionId: projection.id,
        generation: 1n,
        leaseOwner: DAEMON,
        writeMarker: marker,
        observedState: 'queued',
        noteId: '987654321'
      })
    ).toBe(true)
    const drained = (await repo().advancePending(projection.id, 1n, LATER))!
    expect(drained.desiredState).toBe('skipped')
    expect(drained.tombstonedAt).not.toBeNull()
  })

  it('refuses a create that races an owner deletion, and never leaves a live row behind', async () => {
    const subject = await owner()
    // T1 holds the hook lifecycle lock and deletes, exactly as the route path does.
    const deletion = hooks().remove(OrgId(DEFAULT_ORG_ID), subject.hookId, subject.agentId)
    // T2's converge starts after T1's cleanup snapshot; the fence makes it wait, then refuse.
    const raced = await repo().upsert(input({ ...subject, currentDeliveryKey: 'delivery-race' }))
    await deletion

    expect(raced).toBeNull()
    expect(await prisma.hookDef.findUnique({ where: { id: subject.hookId } })).toBeNull()
    expect(await prisma.codeHostRunProjection.count({ where: { hookId: subject.hookId } })).toBe(0)
  })

  it('would leak a live row without the fence, and still creates normally for a live owner', async () => {
    // Negative control: the same interleaving through an UNFENCED insert leaves a row whose
    // HookDef is gone — the leak the create-path fence exists to prevent.
    const leaked = await owner()
    await hooks().remove(OrgId(DEFAULT_ORG_ID), leaked.hookId, leaked.agentId)
    await prisma.codeHostRunProjection.create({
      data: {
        id: randomUUID(),
        provider: 'gitlab',
        hookId: leaked.hookId,
        orgId: DEFAULT_ORG_ID,
        agentId: leaked.agentId,
        projectId: PROJECT,
        projectPath: 'example-group/example-project',
        mergeRequestIid: 42,
        headSha: HEAD,
        projectionEpoch: 1n,
        externalId: randomUUID(),
        desiredState: 'queued'
      }
    })
    const orphan = await prisma.codeHostRunProjection.findFirst({ where: { hookId: leaked.hookId } })
    expect(orphan?.tombstonedAt ?? null).toBeNull()

    // And the fence is scoped: a live owner still gets its projection.
    const live = await owner()
    expect(await repo().upsert(input(live))).not.toBeNull()
  })

  it('refuses a create for a hook the agent cascade already retired', async () => {
    const subject = await owner()
    // The cascade disables the hook and bumps its projection epoch before the Agent row goes.
    await hooks().tombstoneReviewProjections([subject.hookId], LATER, 'failure')
    expect(await repo().upsert(input(subject))).toBeNull()
    expect(await prisma.codeHostRunProjection.count({ where: { hookId: subject.hookId } })).toBe(0)
  })
})
