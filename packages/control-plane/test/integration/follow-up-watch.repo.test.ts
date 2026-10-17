import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { AgentId, OrgId } from '../../src/domain/ids.js'
import { foldWake } from '../../src/codehost/follow-up-watch.service.js'
import { PgFollowUpWatchRepo } from '../../src/persistence/repositories/follow-up-watch.repo.js'
import type { FollowUpWatchObject } from '../../src/persistence/ports.js'

const DAEMON_ID = '11111111-1111-4111-8111-111111111111'
const AGENT_ID = AgentId('22222222-2222-4222-8222-222222222222')
const OTHER_AGENT_ID = AgentId('33333333-3333-4333-8333-333333333333')
const ORG_ID = OrgId(DEFAULT_ORG_ID)
const NOW = new Date('2026-10-17T00:00:00.000Z')

const object = (number: number): FollowUpWatchObject => ({
  orgId: ORG_ID,
  provider: 'github',
  bindingId: '',
  repoId: 456n,
  subject: 'pull',
  number
})

function put(repo: PgFollowUpWatchRepo, agentId: AgentId, followUpId: string, number: number) {
  return repo.put({
    ...object(number),
    agentId,
    followUpId,
    installationId: 99n,
    host: 'github.com',
    repoPath: 'example-org/example-repo'
  })
}

async function row(repo: PgFollowUpWatchRepo, agentId: AgentId, followUpId: string) {
  return (await repo.listForAgent(agentId)).find((watch) => watch.followUpId === followUpId)!
}

describe('PgFollowUpWatchRepo', () => {
  beforeEach(async () => {
    await seedDaemon(prisma, DAEMON_ID)
    await seedAgent(prisma, AGENT_ID, { daemonId: DAEMON_ID })
    await seedAgent(prisma, OTHER_AGENT_ID, { daemonId: DAEMON_ID, name: 'other-agent' })
  })

  it('folds, claims, and keeps an event that arrived during delivery pending', async () => {
    const repo = new PgFollowUpWatchRepo(prisma)
    await put(repo, AGENT_ID, 'f1', 12)
    const watch = await row(repo, AGENT_ID, 'f1')
    await expect(repo.fold(watch, foldWake(watch, 'merged', NOW))).resolves.toBe(true)
    // A fold computed from a stale read loses the race and is retried by the caller.
    await expect(repo.fold(watch, foldWake(watch, 'checks', NOW))).resolves.toBe(false)

    const owner = randomUUID()
    const later = new Date(NOW.getTime() + 60_000)
    await expect(repo.claimNext(owner, NOW, later)).resolves.toBeNull()
    const claimed = await repo.claimNext(owner, later, new Date(later.getTime() + 60_000))
    expect(claimed).toMatchObject({ followUpId: 'f1', wakeSeq: 1, pendingKinds: ['merged'] })
    await expect(repo.claimNext(randomUUID(), later, later)).resolves.toBeNull()

    const current = await row(repo, AGENT_ID, 'f1')
    await repo.fold(current, foldWake(current, 'comment', later))
    await repo.complete(claimed!, owner, later)
    expect(await row(repo, AGENT_ID, 'f1')).toMatchObject({ wakeSeq: 2, pendingKinds: ['merged', 'comment'] })

    const again = await repo.claimNext(owner, new Date(later.getTime() + 60_000), new Date(later.getTime() + 120_000))
    await repo.complete(again!, owner, later)
    expect(await row(repo, AGENT_ID, 'f1')).toMatchObject({
      pendingKinds: [],
      dueAt: null,
      lastWakeAt: later,
      lastWakeKinds: ['merged', 'comment']
    })
  })

  it('records one receipt per object and delivery', async () => {
    const repo = new PgFollowUpWatchRepo(prisma)
    await expect(repo.receive(object(12), 'd1', NOW)).resolves.toBe(true)
    await expect(repo.receive(object(12), 'd1', NOW)).resolves.toBe(false)
    await expect(repo.receive(object(13), 'd1', NOW)).resolves.toBe(true)
    await expect(repo.deleteExpiredReceipts(new Date(NOW.getTime() + 1))).resolves.toBe(2)
  })

  it('moves a watch to a new object without its old pending wake, and lists distinct objects', async () => {
    const repo = new PgFollowUpWatchRepo(prisma)
    await put(repo, AGENT_ID, 'f1', 12)
    await put(repo, OTHER_AGENT_ID, 'f2', 12)
    const watch = await row(repo, AGENT_ID, 'f1')
    await repo.fold(watch, foldWake(watch, 'comment', NOW))
    await put(repo, AGENT_ID, 'f1', 13)
    expect(await row(repo, AGENT_ID, 'f1')).toMatchObject({ number: 13, pendingKinds: [], dueAt: null })
    expect((await repo.objects('github')).map((o) => o.number).sort()).toEqual([12, 13])
    expect(await repo.forObject(object(12))).toHaveLength(1)
  })

  it('ends a watch with a notice due now, which no event folds into', async () => {
    const repo = new PgFollowUpWatchRepo(prisma)
    await put(repo, AGENT_ID, 'f1', 12)
    const watch = await row(repo, AGENT_ID, 'f1')
    await repo.end(watch, 'access_lost', NOW)
    expect(await repo.forObject(object(12))).toEqual([])
    await expect(repo.watched(object(12))).resolves.toBe(true)
    await expect(repo.fold(watch, foldWake(watch, 'merged', NOW))).resolves.toBe(false)
    expect(await repo.claimNext(randomUUID(), NOW, NOW)).toMatchObject({ endedReason: 'access_lost' })
  })

  it('fences a moved watch from work begun on its old object', async () => {
    const repo = new PgFollowUpWatchRepo(prisma)
    await put(repo, AGENT_ID, 'f1', 12)
    const old = await row(repo, AGENT_ID, 'f1')
    await repo.fold(old, foldWake(old, 'merged', NOW))
    const owner = randomUUID()
    const claimed = (await repo.claimNext(owner, new Date(NOW.getTime() + 60_000), new Date(NOW.getTime() + 120_000)))!
    await put(repo, AGENT_ID, 'f1', 13)
    const moved = await row(repo, AGENT_ID, 'f1')
    expect(moved).toMatchObject({ number: 13, pendingKinds: [] })
    expect(moved.generation).not.toBe(old.generation)
    await expect(repo.fold(claimed, foldWake(claimed, 'checks', NOW))).resolves.toBe(false)
    await expect(repo.end(claimed, 'access_lost', NOW)).resolves.toBe(false)
    await expect(repo.removeIf(claimed)).resolves.toBe(false)
    await repo.complete(claimed, owner, NOW)
    expect(await row(repo, AGENT_ID, 'f1')).toMatchObject({ number: 13, endedReason: null, lastWakeAt: null })
    await expect(repo.removeIf(moved)).resolves.toBe(true)
    // A watch removed and taken again is a new generation, so a delivery of the old one changes nothing.
    await put(repo, AGENT_ID, 'f1', 13)
    await expect(repo.removeIf(moved)).resolves.toBe(false)
    expect((await row(repo, AGENT_ID, 'f1')).generation).not.toBe(moved.generation)
  })

  it('goes with its agent', async () => {
    const repo = new PgFollowUpWatchRepo(prisma)
    await put(repo, AGENT_ID, 'f1', 12)
    await prisma.agent.delete({ where: { id: AGENT_ID } })
    await expect(repo.watched(object(12))).resolves.toBe(false)
  })
})
