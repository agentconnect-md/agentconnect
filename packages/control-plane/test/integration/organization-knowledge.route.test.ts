import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  AgentUpsert,
  OrganizationSuggestionContent,
  OrganizationSuggestionReadReq,
  OrganizationSuggestionReviewReq
} from '@agentconnect.md/protocol'
import {
  ORGANIZATION_KNOWLEDGE_FEATURE,
  ORGANIZATION_SUGGESTION_REVIEW_FEATURE,
  organizationSuggestionCanonical
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { DEF_ORG, seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { NoConnection, type ControlSender } from '../../src/orchestrator/outbound.js'
import { AgentId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import type { DaemonLiveness } from '../../src/ports.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'
import { organizationSuggestionSnapshotToken } from '../../src/organization-knowledge/suggestion-snapshot.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd0d0d0d0-dddd-4ddd-8ddd-dddddddddddd'
const OLD_DAEMON = 'e0e0e0e0-eeee-4eee-8eee-eeeeeeeeeeee'

const opened: HttpApp[] = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()))
})

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function app(options: { userId?: string; control?: KnowledgeControl; connected?: boolean } = {}): HttpApp {
  const liveness: DaemonLiveness = {
    get: (daemonId) =>
      options.connected && daemonId === DAEMON ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined
  }
  const built = buildHttpApp(
    prisma,
    options.userId ? { DEFAULT_OWNER_ID: options.userId } : undefined,
    liveness,
    options.control as unknown as ControlSender | undefined
  )
  opened.push(built)
  return built
}

async function makeUser(sub: string, role: OrgMemberRole): Promise<string> {
  const users = new PgUserRepo(prisma)
  const email = `${sub}@knowledge.test`
  const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

class KnowledgeControl {
  readonly contents = new Map<string, OrganizationSuggestionContent>()
  readonly reviews: Array<{ daemonId: string; request: OrganizationSuggestionReviewReq }> = []
  readonly upserts: Array<{ daemonId: string; request: AgentUpsert }> = []
  onRead?: (request: OrganizationSuggestionReadReq) => Promise<void>

  async organizationSuggestionRead(
    _daemonId: string,
    request: OrganizationSuggestionReadReq
  ): Promise<OrganizationSuggestionContent> {
    await this.onRead?.(request)
    const content = this.contents.get(request.candidateId)
    if (!content) throw new NoConnection(DAEMON)
    return content
  }

  async organizationSuggestionReview(
    daemonId: string,
    request: OrganizationSuggestionReviewReq
  ): Promise<{ ok: true }> {
    this.reviews.push({ daemonId, request })
    return { ok: true }
  }

  async agentUpsert(daemonId: string, request: AgentUpsert): Promise<void> {
    this.upserts.push({ daemonId, request })
  }
}

describe('organization knowledge REST lifecycle', () => {
  it('publishes immutable revisions, searches current content, archives, and lets every member read', async () => {
    const owner = app()
    const oversizedUtf8 = await owner.app.inject({
      method: 'POST',
      url: `${ORG}/knowledge`,
      // 70k emoji are under Zod's character-count ceiling but over the product's
      // 256 KiB UTF-8 byte limit.
      payload: { title: 'Too large', content: '😀'.repeat(70_000), tags: [] }
    })
    expect(oversizedUtf8.statusCode).toBe(400)

    const created = await owner.app.inject({
      method: 'POST',
      url: `${ORG}/knowledge`,
      payload: {
        title: 'Incident response',
        content: '# Incident response\nPage the primary on-call.',
        summary: 'How to page the primary on-call',
        tags: ['operations', 'on-call']
      }
    })
    expect(created.statusCode).toBe(201)
    const first = created.json() as {
      id: string
      currentRevision: number
      digest: string
      canManage: boolean
      createdByUserId: string | null
      reviewedByUserId: string | null
    }
    expect(first).toMatchObject({ currentRevision: 1, canManage: true, reviewedByUserId: null })
    expect(first.createdByUserId).toBeTruthy()
    expect(first.digest).toBe(digest('# Incident response\nPage the primary on-call.'))

    const updated = await owner.app.inject({
      method: 'PATCH',
      url: `${ORG}/knowledge/${first.id}`,
      payload: {
        expectedRevision: 1,
        title: 'Incident response',
        content: '# Incident response\nPage the primary, then the incident commander.',
        summary: 'Escalation order',
        tags: ['operations']
      }
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({ id: first.id, currentRevision: 2, source: 'manual' })

    const stale = await owner.app.inject({
      method: 'PATCH',
      url: `${ORG}/knowledge/${first.id}`,
      payload: {
        expectedRevision: 1,
        title: 'Stale edit',
        content: 'must not publish',
        tags: []
      }
    })
    expect(stale.statusCode).toBe(409)

    const revisions = await owner.app.inject({ method: 'GET', url: `${ORG}/knowledge/${first.id}/revisions` })
    expect(revisions.statusCode).toBe(200)
    expect((revisions.json() as Array<{ revision: number; content: string }>).map((row) => row.revision)).toEqual([
      2, 1
    ])

    const repo = owner.deps.repos.organizationKnowledge!
    expect(
      (await repo.searchKnowledge(DEF_ORG, { query: 'incident commander', limit: 5 })).map((row) => row.id)
    ).toEqual([first.id])
    expect(
      (await repo.searchKnowledge(DEF_ORG, { query: 'incident', tags: ['operations'], limit: 5 })).map((row) => row.id)
    ).toEqual([first.id])
    expect(
      await repo.searchKnowledge(DEF_ORG, { query: 'incident', tags: ['operations', 'missing'], limit: 5 })
    ).toEqual([])

    const viewerId = await makeUser('knowledge-viewer', 'viewer')
    const viewer = app({ userId: viewerId })
    const readable = await viewer.app.inject({ method: 'GET', url: `${ORG}/knowledge/${first.id}` })
    expect(readable.statusCode).toBe(200)
    expect(readable.json()).toMatchObject({ id: first.id, currentRevision: 2, canManage: false })
    expect(
      (
        await viewer.app.inject({
          method: 'POST',
          url: `${ORG}/knowledge`,
          payload: { title: 'Forbidden', content: 'viewer write', tags: [] }
        })
      ).statusCode
    ).toBe(403)

    expect(
      (
        await owner.app.inject({
          method: 'POST',
          url: `${ORG}/knowledge/${first.id}/archive`,
          payload: { archived: true }
        })
      ).statusCode
    ).toBe(200)
    expect((await owner.app.inject({ method: 'GET', url: `${ORG}/knowledge` })).json()).toEqual([])
    expect((await owner.app.inject({ method: 'GET', url: `${ORG}/knowledge?includeArchived=false` })).json()).toEqual(
      []
    )
    expect(await repo.searchKnowledge(DEF_ORG, { query: 'incident commander', limit: 5 })).toEqual([])
    expect(
      (await owner.app.inject({ method: 'GET', url: `${ORG}/knowledge?includeArchived=true` })).json()
    ).toHaveLength(1)
  })
})

describe('Dream organization suggestion review', () => {
  it('reads a daemon-local body, accepts it once, and retains terminal metadata across replay', async () => {
    const sourceAgentId = randomUUID()
    await seedDaemon(prisma, DAEMON, {
      capabilities: {
        platforms: [],
        runtimes: ['claude'],
        acp: true,
        features: [ORGANIZATION_KNOWLEDGE_FEATURE, ORGANIZATION_SUGGESTION_REVIEW_FEATURE]
      }
    })
    await seedAgent(prisma, sourceAgentId, { name: 'dreamer', daemonId: DAEMON })
    const candidateId = randomUUID()
    const content = '# Runbook\nRotate the signing key every 90 days.'
    const candidateDigest = digest(content)
    const control = new KnowledgeControl()
    control.contents.set(candidateId, {
      sourceAgentId,
      dreamId: 'dream-accept-1',
      candidateId,
      digest: candidateDigest,
      exists: true,
      body: { kind: 'knowledge', content, summary: 'Signing-key rotation', tags: ['security'] }
    })
    const owner = app({ control, connected: true })
    const repo = owner.deps.repos.organizationKnowledge!
    const [pending] = await repo.syncSuggestions(DEF_ORG, DAEMON, [
      {
        sourceAgentId,
        dreamId: 'dream-accept-1',
        candidateId,
        kind: 'knowledge',
        operation: 'create',
        title: 'Signing-key rotation',
        summary: 'Signing-key rotation',
        tags: ['security'],
        digest: candidateDigest,
        contentBytes: Buffer.byteLength(content),
        state: 'proposed',
        sessionIds: ['session-1'],
        createdAt: '2026-07-31T10:00:00.000Z'
      }
    ])
    expect(pending).toBeDefined()
    const snapshotToken = organizationSuggestionSnapshotToken(pending!)

    const listed = await owner.app.inject({ method: 'GET', url: `${ORG}/knowledge-suggestions?state=pending` })
    expect(listed.statusCode).toBe(200)
    expect(listed.json()).toMatchObject([
      { id: pending!.id, sourceAgentName: 'dreamer', state: 'pending', contentAvailable: true }
    ])

    const body = await owner.app.inject({
      method: 'GET',
      url: `${ORG}/knowledge-suggestions/${pending!.id}/content`
    })
    expect(body.statusCode).toBe(200)
    expect(body.json()).toEqual({
      kind: 'knowledge',
      digest: candidateDigest,
      snapshotToken,
      content,
      summary: 'Signing-key rotation',
      tags: ['security']
    })

    const accepted = await owner.app.inject({
      method: 'POST',
      url: `${ORG}/knowledge-suggestions/${pending!.id}/review`,
      payload: { decision: 'accept', snapshotToken }
    })
    expect(accepted.statusCode).toBe(200)
    const acceptedDto = accepted.json() as {
      state: string
      acceptedArtifactId: string
      acceptedArtifactRevision: number
      contentAvailable: boolean
    }
    expect(acceptedDto).toMatchObject({ state: 'accepted', acceptedArtifactRevision: 1, contentAvailable: false })
    expect(control.reviews).toEqual([
      {
        daemonId: DAEMON,
        request: { sourceAgentId, dreamId: 'dream-accept-1', candidateId, state: 'accepted' }
      }
    ])

    const artifact = await repo.getKnowledge(DEF_ORG, acceptedDto.acceptedArtifactId)
    expect(artifact).toMatchObject({
      title: 'Signing-key rotation',
      content,
      currentRevision: 1,
      source: 'dream',
      sourceAgentId,
      sourceDreamId: 'dream-accept-1',
      sourceSessionIds: ['session-1']
    })
    expect(
      (
        await owner.app.inject({
          method: 'POST',
          url: `${ORG}/knowledge-suggestions/${pending!.id}/review`,
          payload: { decision: 'accept', snapshotToken }
        })
      ).statusCode
    ).toBe(409)

    const [replayed] = await repo.syncSuggestions(DEF_ORG, DAEMON, [
      {
        sourceAgentId,
        dreamId: 'dream-accept-1',
        candidateId,
        kind: 'knowledge',
        operation: 'create',
        title: 'Replay must not overwrite terminal metadata',
        digest: candidateDigest,
        contentBytes: Buffer.byteLength(content),
        state: 'proposed',
        sessionIds: ['session-2'],
        createdAt: '2026-07-31T11:00:00.000Z'
      }
    ])
    expect(replayed).toMatchObject({ state: 'accepted', title: 'Signing-key rotation', sessionIds: ['session-1'] })
  })

  it('serializes concurrent acceptance and creates exactly one immutable artifact', async () => {
    const sourceAgentId = randomUUID()
    await seedDaemon(prisma, DAEMON, {
      capabilities: {
        platforms: [],
        runtimes: ['claude'],
        acp: true,
        features: [ORGANIZATION_KNOWLEDGE_FEATURE, ORGANIZATION_SUGGESTION_REVIEW_FEATURE]
      }
    })
    await seedAgent(prisma, sourceAgentId, { name: 'concurrent-dreamer', daemonId: DAEMON })
    const candidateId = randomUUID()
    const content = '# Recovery\nPromote the warm replica.'
    const control = new KnowledgeControl()
    control.contents.set(candidateId, {
      sourceAgentId,
      dreamId: 'dream-concurrent-accept',
      candidateId,
      digest: digest(content),
      exists: true,
      body: { kind: 'knowledge', content }
    })
    const owner = app({ control, connected: true })
    const repo = owner.deps.repos.organizationKnowledge!
    const [pending] = await repo.syncSuggestions(DEF_ORG, DAEMON, [
      {
        sourceAgentId,
        dreamId: 'dream-concurrent-accept',
        candidateId,
        kind: 'knowledge',
        operation: 'create',
        title: 'Replica recovery',
        digest: digest(content),
        contentBytes: Buffer.byteLength(content),
        state: 'proposed',
        sessionIds: ['session-concurrent'],
        createdAt: '2026-07-31T10:30:00.000Z'
      }
    ])
    const snapshotToken = organizationSuggestionSnapshotToken(pending!)

    const responses = await Promise.all(
      [0, 1].map(() =>
        owner.app.inject({
          method: 'POST',
          url: `${ORG}/knowledge-suggestions/${pending!.id}/review`,
          payload: { decision: 'accept', snapshotToken }
        })
      )
    )
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409])
    const accepted = responses.find((response) => response.statusCode === 200)!.json() as {
      acceptedArtifactId: string
    }
    expect((await repo.listKnowledge(DEF_ORG)).filter((row) => row.id === accepted.acceptedArtifactId)).toHaveLength(1)
    expect(await repo.listKnowledgeRevisions(accepted.acceptedArtifactId)).toHaveLength(1)
    expect(control.reviews).toHaveLength(1)
  })

  it('rejects a staged body whose bytes no longer match the indexed suggestion metadata', async () => {
    const sourceAgentId = randomUUID()
    await seedDaemon(prisma, DAEMON, {
      capabilities: {
        platforms: [],
        runtimes: ['claude'],
        acp: true,
        features: [ORGANIZATION_KNOWLEDGE_FEATURE, ORGANIZATION_SUGGESTION_REVIEW_FEATURE]
      }
    })
    await seedAgent(prisma, sourceAgentId, { name: 'mutated-dreamer', daemonId: DAEMON })
    const candidateId = randomUUID()
    const indexedContent = '# Approved candidate'
    const control = new KnowledgeControl()
    control.contents.set(candidateId, {
      sourceAgentId,
      dreamId: 'dream-mutated-body',
      candidateId,
      digest: digest(indexedContent),
      exists: true,
      body: { kind: 'knowledge', content: `${indexedContent}\nUnexpected mutation` }
    })
    const owner = app({ control, connected: true })
    const repo = owner.deps.repos.organizationKnowledge!
    const [pending] = await repo.syncSuggestions(DEF_ORG, DAEMON, [
      {
        sourceAgentId,
        dreamId: 'dream-mutated-body',
        candidateId,
        kind: 'knowledge',
        operation: 'create',
        title: 'Mutated candidate',
        digest: digest(indexedContent),
        contentBytes: Buffer.byteLength(indexedContent),
        state: 'proposed',
        sessionIds: ['session-mutated'],
        createdAt: '2026-07-31T10:45:00.000Z'
      }
    ])
    const snapshotToken = organizationSuggestionSnapshotToken(pending!)

    const response = await owner.app.inject({
      method: 'POST',
      url: `${ORG}/knowledge-suggestions/${pending!.id}/review`,
      payload: { decision: 'accept', snapshotToken }
    })
    expect(response.statusCode).toBe(409)
    expect(await repo.getSuggestion(DEF_ORG, pending!.id)).toMatchObject({ state: 'pending', acceptedArtifactId: null })
    expect((await repo.listKnowledge(DEF_ORG)).some((row) => row.title === 'Mutated candidate')).toBe(false)
    expect(control.reviews).toEqual([])
  })

  it('keeps a suggestion pending when its metadata refreshes after inspection starts', async () => {
    const sourceAgentId = randomUUID()
    await seedDaemon(prisma, DAEMON, {
      capabilities: {
        platforms: [],
        runtimes: ['claude'],
        acp: true,
        features: [ORGANIZATION_KNOWLEDGE_FEATURE, ORGANIZATION_SUGGESTION_REVIEW_FEATURE]
      }
    })
    await seedAgent(prisma, sourceAgentId, { name: 'metadata-race-dreamer', daemonId: DAEMON })
    const candidateId = randomUUID()
    const content = '# Stable bytes\nMetadata can still race.'
    const control = new KnowledgeControl()
    control.contents.set(candidateId, {
      sourceAgentId,
      dreamId: 'dream-metadata-race',
      candidateId,
      digest: digest(content),
      exists: true,
      body: { kind: 'knowledge', content, summary: 'Stable summary', tags: ['race'] }
    })
    const owner = app({ control, connected: true })
    const repo = owner.deps.repos.organizationKnowledge!
    const candidate = {
      sourceAgentId,
      dreamId: 'dream-metadata-race',
      candidateId,
      kind: 'knowledge' as const,
      operation: 'create' as const,
      title: 'Original title',
      summary: 'Stable summary',
      tags: ['race'],
      digest: digest(content),
      contentBytes: Buffer.byteLength(content),
      state: 'proposed' as const,
      sessionIds: ['session-race'],
      createdAt: '2026-07-31T11:00:00.000Z'
    }
    const [pending] = await repo.syncSuggestions(DEF_ORG, DAEMON, [candidate])
    const inspected = await owner.app.inject({
      method: 'GET',
      url: `${ORG}/knowledge-suggestions/${pending!.id}/content`
    })
    expect(inspected.statusCode).toBe(200)
    const snapshotToken = (inspected.json() as { snapshotToken: string }).snapshotToken
    await repo.syncSuggestions(DEF_ORG, DAEMON, [{ ...candidate, title: 'Refreshed title' }])

    const response = await owner.app.inject({
      method: 'POST',
      url: `${ORG}/knowledge-suggestions/${pending!.id}/review`,
      payload: { decision: 'accept', snapshotToken }
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ message: expect.stringContaining('metadata changed') })
    expect(await repo.getSuggestion(DEF_ORG, pending!.id)).toMatchObject({ state: 'pending', title: 'Refreshed title' })
    expect(await repo.listKnowledge(DEF_ORG)).toEqual([])
    expect(control.reviews).toEqual([])
  })

  it('keeps an update suggestion pending when its target revision has advanced', async () => {
    const sourceAgentId = randomUUID()
    await seedDaemon(prisma, DAEMON, {
      capabilities: {
        platforms: [],
        runtimes: ['claude'],
        acp: true,
        features: [ORGANIZATION_KNOWLEDGE_FEATURE, ORGANIZATION_SUGGESTION_REVIEW_FEATURE]
      }
    })
    await seedAgent(prisma, sourceAgentId, { name: 'stale-dreamer', daemonId: DAEMON })
    const control = new KnowledgeControl()
    const owner = app({ control, connected: true })
    const repo = owner.deps.repos.organizationKnowledge!
    const target = await repo.createKnowledge(
      DEF_ORG,
      { title: 'Escalation', content: 'revision one' },
      { source: 'manual' }
    )
    const candidateId = randomUUID()
    const candidateContent = 'dream revision two'
    control.contents.set(candidateId, {
      sourceAgentId,
      dreamId: 'dream-stale-update',
      candidateId,
      digest: digest(candidateContent),
      exists: true,
      body: { kind: 'knowledge', content: candidateContent }
    })
    const [pending] = await repo.syncSuggestions(DEF_ORG, DAEMON, [
      {
        sourceAgentId,
        dreamId: 'dream-stale-update',
        candidateId,
        kind: 'knowledge',
        operation: 'update',
        targetId: target.id,
        targetRevision: 1,
        title: 'Escalation',
        digest: digest(candidateContent),
        contentBytes: Buffer.byteLength(candidateContent),
        state: 'proposed',
        sessionIds: ['session-stale'],
        createdAt: '2026-07-31T11:30:00.000Z'
      }
    ])
    const snapshotToken = organizationSuggestionSnapshotToken(pending!)
    await repo.updateKnowledge(
      DEF_ORG,
      target.id,
      1,
      { title: 'Escalation', content: 'manual revision two' },
      { source: 'manual' }
    )

    const response = await owner.app.inject({
      method: 'POST',
      url: `${ORG}/knowledge-suggestions/${pending!.id}/review`,
      payload: { decision: 'accept', snapshotToken }
    })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ message: 'the target has a newer revision; regenerate the suggestion' })
    expect(await repo.getSuggestion(DEF_ORG, pending!.id)).toMatchObject({ state: 'pending', acceptedArtifactId: null })
    expect(await repo.getKnowledge(DEF_ORG, target.id)).toMatchObject({
      currentRevision: 2,
      content: 'manual revision two'
    })
    expect(await repo.listKnowledgeRevisions(target.id)).toHaveLength(2)
    expect(control.reviews).toEqual([])
  })

  it('retains a rejection reason when the source review surface is ready', async () => {
    await seedDaemon(prisma, DAEMON, {
      capabilities: {
        platforms: [],
        runtimes: ['claude'],
        acp: true,
        features: [ORGANIZATION_KNOWLEDGE_FEATURE, ORGANIZATION_SUGGESTION_REVIEW_FEATURE]
      }
    })
    const sourceAgentId = randomUUID()
    await seedAgent(prisma, sourceAgentId, { name: 'reviewable-dreamer', daemonId: DAEMON })
    const candidateId = randomUUID()
    const control = new KnowledgeControl()
    const owner = app({ control, connected: true })
    const repo = owner.deps.repos.organizationKnowledge!
    const [pending] = await repo.syncSuggestions(DEF_ORG, DAEMON, [
      {
        sourceAgentId,
        dreamId: 'dream-reject-ready',
        candidateId,
        kind: 'knowledge',
        operation: 'create',
        title: 'Unsafe draft',
        digest: digest('unsafe'),
        contentBytes: 6,
        state: 'proposed',
        sessionIds: ['session-3'],
        createdAt: '2026-07-31T12:00:00.000Z'
      }
    ])

    const rejected = await owner.app.inject({
      method: 'POST',
      url: `${ORG}/knowledge-suggestions/${pending!.id}/review`,
      payload: { decision: 'reject', reason: 'Conflicts with the approved runbook' }
    })

    expect(rejected.statusCode).toBe(200)
    expect(rejected.json()).toMatchObject({
      state: 'rejected',
      reviewReason: 'Conflicts with the approved runbook',
      contentAvailable: false
    })
    expect(control.reviews).toEqual([
      {
        daemonId: DAEMON,
        request: {
          sourceAgentId,
          dreamId: 'dream-reject-ready',
          candidateId,
          state: 'rejected'
        }
      }
    ])
  })

  it('keeps a rejection pending while the source daemon is offline', async () => {
    const sourceAgentId = randomUUID()
    await seedAgent(prisma, sourceAgentId, { name: 'offline-dreamer' })
    const candidateId = randomUUID()
    const owner = app()
    const [pending] = await owner.deps.repos.organizationKnowledge!.syncSuggestions(DEF_ORG, DAEMON, [
      {
        sourceAgentId,
        dreamId: 'dream-reject-1',
        candidateId,
        kind: 'knowledge',
        operation: 'create',
        title: 'Unsafe draft',
        digest: digest('unsafe'),
        contentBytes: 6,
        state: 'proposed',
        sessionIds: ['session-3'],
        createdAt: '2026-07-31T12:00:00.000Z'
      }
    ])

    const listed = await owner.app.inject({ method: 'GET', url: `${ORG}/knowledge-suggestions?state=pending` })
    expect(listed.json()).toMatchObject([{ id: pending!.id, contentAvailable: false }])
    const offline = await owner.app.inject({
      method: 'GET',
      url: `${ORG}/knowledge-suggestions/${pending!.id}/content`
    })
    expect(offline.statusCode).toBe(503)

    const rejected = await owner.app.inject({
      method: 'POST',
      url: `${ORG}/knowledge-suggestions/${pending!.id}/review`,
      payload: { decision: 'reject', reason: 'Conflicts with the approved runbook' }
    })
    expect(rejected.statusCode).toBe(503)
    expect(await owner.deps.repos.organizationKnowledge!.getSuggestion(DEF_ORG, pending!.id)).toMatchObject({
      state: 'pending',
      reviewedAt: null,
      reviewedByUserId: null,
      reviewReason: null,
      acceptedArtifactId: null,
      acceptedArtifactRevision: null
    })

    const viewerId = await makeUser('suggestion-viewer', 'viewer')
    expect(
      (await app({ userId: viewerId }).app.inject({ method: 'GET', url: `${ORG}/knowledge-suggestions` })).statusCode
    ).toBe(403)
  })

  it('keeps review read-only when a connected daemon advertises metadata but not staged review', async () => {
    await seedDaemon(prisma, DAEMON, {
      capabilities: { platforms: [], runtimes: ['claude'], acp: true, features: [ORGANIZATION_KNOWLEDGE_FEATURE] }
    })
    const sourceAgentId = randomUUID()
    await seedAgent(prisma, sourceAgentId, { name: 'old-dreamer', daemonId: DAEMON })
    const candidateId = randomUUID()
    const content = '# Draft'
    const control = new KnowledgeControl()
    let readCalls = 0
    control.onRead = async () => {
      readCalls += 1
    }
    control.contents.set(candidateId, {
      sourceAgentId,
      dreamId: 'dream-old-daemon',
      candidateId,
      digest: digest(content),
      exists: true,
      body: { kind: 'knowledge', content }
    })
    const owner = app({ control, connected: true })
    const [pending] = await owner.deps.repos.organizationKnowledge!.syncSuggestions(DEF_ORG, DAEMON, [
      {
        sourceAgentId,
        dreamId: 'dream-old-daemon',
        candidateId,
        kind: 'knowledge',
        operation: 'create',
        title: 'Old daemon draft',
        digest: digest(content),
        contentBytes: Buffer.byteLength(content),
        state: 'proposed',
        sessionIds: ['session-old'],
        createdAt: '2026-07-31T12:30:00.000Z'
      }
    ])

    expect((await owner.app.inject({ method: 'GET', url: `${ORG}/knowledge-suggestions` })).json()).toMatchObject([
      { id: pending!.id, contentAvailable: false }
    ])
    expect(
      (
        await owner.app.inject({
          method: 'GET',
          url: `${ORG}/knowledge-suggestions/${pending!.id}/content`
        })
      ).statusCode
    ).toBe(503)
    expect(
      (
        await owner.app.inject({
          method: 'POST',
          url: `${ORG}/knowledge-suggestions/${pending!.id}/review`,
          payload: { decision: 'accept', snapshotToken: organizationSuggestionSnapshotToken(pending!) }
        })
      ).statusCode
    ).toBe(503)
    expect(
      (
        await owner.app.inject({
          method: 'POST',
          url: `${ORG}/knowledge-suggestions/${pending!.id}/review`,
          payload: { decision: 'reject', reason: 'must remain pending during the hold' }
        })
      ).statusCode
    ).toBe(503)
    expect(await owner.deps.repos.organizationKnowledge!.getSuggestion(DEF_ORG, pending!.id)).toMatchObject({
      state: 'pending',
      reviewedAt: null,
      reviewedByUserId: null,
      reviewReason: null,
      acceptedArtifactId: null,
      acceptedArtifactRevision: null
    })
    expect(readCalls).toBe(0)
    expect(await owner.deps.repos.organizationKnowledge!.listKnowledge(DEF_ORG)).toEqual([])
    expect(control.reviews).toEqual([])
  })
})

describe('managed organization skills', () => {
  it('packages a complete tree, persists an immutable ZIP revision, and enables it explicitly per agent', async () => {
    const sourceAgentId = randomUUID()
    await seedDaemon(prisma, DAEMON, {
      capabilities: {
        platforms: [],
        runtimes: ['claude'],
        acp: true,
        features: [ORGANIZATION_KNOWLEDGE_FEATURE, ORGANIZATION_SUGGESTION_REVIEW_FEATURE]
      }
    })
    await seedAgent(prisma, sourceAgentId, { name: 'skill-dreamer', daemonId: DAEMON })
    const candidateId = randomUUID()
    const files = [
      {
        path: 'SKILL.md',
        encoding: 'utf8' as const,
        content:
          '---\nname: deploy-check\ndescription: Validate a deployment before promotion.\n---\n\n# Deploy check\n'
      },
      { path: 'scripts/check.sh', encoding: 'utf8' as const, content: '#!/bin/sh\nset -eu\necho ready\n' },
      { path: 'references/policy.md', encoding: 'utf8' as const, content: '# Policy\nRequire green health checks.\n' }
    ]
    const canonicalCandidate = organizationSuggestionCanonical({ kind: 'skill', files })
    const candidateDigest = digest(canonicalCandidate)
    const control = new KnowledgeControl()
    control.contents.set(candidateId, {
      sourceAgentId,
      dreamId: 'dream-skill-1',
      candidateId,
      digest: candidateDigest,
      exists: true,
      body: { kind: 'skill', files }
    })
    const owner = app({ control, connected: true })
    const repo = owner.deps.repos.organizationKnowledge!
    const [pending] = await repo.syncSuggestions(DEF_ORG, DAEMON, [
      {
        sourceAgentId,
        dreamId: 'dream-skill-1',
        candidateId,
        kind: 'skill',
        operation: 'create',
        title: 'deploy-check',
        summary: 'Validate a deployment before promotion.',
        digest: candidateDigest,
        contentBytes: Buffer.byteLength(canonicalCandidate),
        state: 'proposed',
        sessionIds: ['session-skill'],
        createdAt: '2026-07-31T13:00:00.000Z'
      }
    ])
    const snapshotToken = organizationSuggestionSnapshotToken(pending!)

    const accepted = await owner.app.inject({
      method: 'POST',
      url: `${ORG}/knowledge-suggestions/${pending!.id}/review`,
      payload: { decision: 'accept', snapshotToken }
    })
    expect(accepted.statusCode).toBe(200)
    const skillId = (accepted.json() as { acceptedArtifactId: string }).acceptedArtifactId

    const managed = await owner.app.inject({ method: 'GET', url: `${ORG}/managed-skills/${skillId}` })
    expect(managed.statusCode).toBe(200)
    expect(managed.json()).toMatchObject({
      id: skillId,
      name: 'deploy-check',
      description: 'Validate a deployment before promotion.',
      currentRevision: 1,
      fileCount: 3,
      manifest: {
        name: 'deploy-check',
        files: [{ path: 'SKILL.md' }, { path: 'references/policy.md' }, { path: 'scripts/check.sh' }]
      }
    })
    const revisions = await owner.app.inject({ method: 'GET', url: `${ORG}/managed-skills/${skillId}/revisions` })
    expect(revisions.statusCode).toBe(200)
    expect(revisions.body).not.toContain('# Deploy check')
    expect(revisions.json()).toMatchObject([{ managedSkillId: skillId, revision: 1, source: 'dream' }])
    expect((await repo.getManagedSkillRevision(skillId, 1))!.archive.byteLength).toBeGreaterThan(0)

    const unknown = await owner.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'unknown-skill-agent', runtime: 'claude', managedSkills: [randomUUID()] }
    })
    expect(unknown.statusCode).toBe(400)

    const createdAgent = await owner.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'managed-skill-agent', runtime: 'claude', daemonId: DAEMON, managedSkills: [skillId] }
    })
    expect(createdAgent.statusCode).toBe(201)
    const agentDto = createdAgent.json() as { id: string; managedSkills: string[] }
    expect(agentDto.managedSkills).toEqual([skillId])
    const agent = await owner.deps.repos.agent.get(DEF_ORG, AgentId(agentDto.id))
    expect((await owner.deps.agentSpecs.assemble(agent!)).managedSkills).toEqual([
      {
        id: skillId,
        name: 'deploy-check',
        revision: 1,
        digest: (managed.json() as { digest: string }).digest
      }
    ])

    control.upserts.length = 0
    const updateCandidateId = randomUUID()
    const updatedFiles = [
      {
        path: 'SKILL.md',
        encoding: 'utf8' as const,
        content:
          '---\nname: deploy-check\ndescription: Validate deployment and rollback readiness.\n---\n\n# Deploy check v2\n'
      },
      { path: 'scripts/check.sh', encoding: 'utf8' as const, content: '#!/bin/sh\nset -eu\necho ready-v2\n' }
    ]
    const updatedCanonical = organizationSuggestionCanonical({ kind: 'skill', files: updatedFiles })
    control.contents.set(updateCandidateId, {
      sourceAgentId,
      dreamId: 'dream-skill-update',
      candidateId: updateCandidateId,
      digest: digest(updatedCanonical),
      exists: true,
      body: { kind: 'skill', files: updatedFiles }
    })
    const [updateSuggestion] = await repo.syncSuggestions(DEF_ORG, DAEMON, [
      {
        sourceAgentId,
        dreamId: 'dream-skill-update',
        candidateId: updateCandidateId,
        kind: 'skill',
        operation: 'update',
        targetId: skillId,
        targetRevision: 1,
        title: 'deploy-check',
        summary: 'Validate deployment and rollback readiness.',
        digest: digest(updatedCanonical),
        contentBytes: Buffer.byteLength(updatedCanonical),
        state: 'proposed',
        sessionIds: ['session-skill-update'],
        createdAt: '2026-07-31T13:15:00.000Z'
      }
    ])
    const updateSnapshotToken = organizationSuggestionSnapshotToken(updateSuggestion!)
    const updated = await owner.app.inject({
      method: 'POST',
      url: `${ORG}/knowledge-suggestions/${updateSuggestion!.id}/review`,
      payload: { decision: 'accept', snapshotToken: updateSnapshotToken }
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({ acceptedArtifactId: skillId, acceptedArtifactRevision: 2 })
    expect(control.upserts).toHaveLength(1)
    expect(control.upserts[0]).toMatchObject({
      daemonId: DAEMON,
      request: {
        agentId: agentDto.id,
        spec: { managedSkills: [{ id: skillId, name: 'deploy-check', revision: 2 }] }
      }
    })

    await seedDaemon(prisma, OLD_DAEMON, {
      capabilities: { platforms: [], runtimes: ['claude'], acp: true, features: [] }
    })
    const createOnOldDaemon = await owner.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: 'old-daemon-managed-skill',
        runtime: 'claude',
        daemonId: OLD_DAEMON,
        managedSkills: [skillId]
      }
    })
    expect(createOnOldDaemon.statusCode).toBe(409)
    expect(createOnOldDaemon.json()).toMatchObject({ message: expect.stringContaining('organization knowledge') })

    const oldDaemonAgent = await owner.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'old-daemon-agent', runtime: 'claude', daemonId: OLD_DAEMON }
    })
    expect(oldDaemonAgent.statusCode).toBe(201)
    expect(
      (
        await owner.app.inject({
          method: 'PATCH',
          url: `${ORG}/agents/${(oldDaemonAgent.json() as { id: string }).id}`,
          payload: { managedSkills: [skillId] }
        })
      ).statusCode
    ).toBe(409)

    expect(
      (
        await owner.app.inject({
          method: 'POST',
          url: `${ORG}/managed-skills/${skillId}/archive`,
          payload: { archived: true }
        })
      ).statusCode
    ).toBe(200)
    expect(
      (await owner.deps.agentSpecs.assemble((await owner.deps.repos.agent.get(DEF_ORG, AgentId(agentDto.id)))!))
        .managedSkills
    ).toEqual([])
    expect(
      (
        await owner.app.inject({
          method: 'PATCH',
          url: `${ORG}/agents/${agentDto.id}`,
          payload: { managedSkills: [skillId] }
        })
      ).statusCode
    ).toBe(400)
    expect((await owner.app.inject({ method: 'GET', url: `${ORG}/managed-skills` })).json()).toEqual([])
    expect(
      (await owner.app.inject({ method: 'GET', url: `${ORG}/managed-skills?includeArchived=false` })).json()
    ).toEqual([])
    expect(
      (await owner.app.inject({ method: 'GET', url: `${ORG}/managed-skills?includeArchived=true` })).json()
    ).toHaveLength(1)
  })
})
