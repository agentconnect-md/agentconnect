import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DECISION_PROVIDER_PROFILES, DECISION_PREVIEW_V1_FEATURE, type DecisionDraft } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const BASE = `/api/v1/orgs/${DEFAULT_ORG_ID}/decisions`
const draft: DecisionDraft = {
  name: 'Useful reply',
  providerId: 'typesafe',
  model: 'jev-latest',
  visibility: 'org',
  sharedWith: [],
  question: {
    type: 'boolean',
    instructions: 'Does this need a reply?',
    criteria: { true: 'Actionable', false: 'Noise' }
  }
}
const evaluation = {
  status: 'answered' as const,
  model: 'jev-1.13.0',
  answer: { type: 'boolean' as const, value: false, probability: 0.2 },
  usage: { inputTokens: 12, outputTokens: 1 }
}
const opened: HttpApp[] = []
afterEach(async () => {
  for (const app of opened.splice(0)) await app.close()
})
function appAs(userId = DEFAULT_OWNER_ID) {
  const instance = buildHttpApp(prisma, { DEFAULT_OWNER_ID: userId })
  opened.push(instance)
  return instance
}
async function member(role: 'viewer' | 'collaborator') {
  const repo = new PgUserRepo(prisma)
  const email = `${role}@example.test`
  const { userId } = await repo.provisionOidcUser({ oidcSubject: role, email, emailVerified: true })
  await repo.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}
async function execution(userId = DEFAULT_OWNER_ID) {
  const daemonId = randomUUID(),
    agentId = randomUUID()
  await seedDaemon(prisma, daemonId)
  await seedAgent(prisma, agentId, { daemonId })
  const instance = appAs(userId)
  instance.deps.daemonConns = {
    get: () => ({ state: 'READY', capabilities: { features: [DECISION_PREVIEW_V1_FEATURE] } })
  }
  const catalog = vi.spyOn(instance.deps.control, 'decisionCatalog').mockResolvedValue({
    providers: DECISION_PROVIDER_PROFILES.map((profile) => ({ ...profile, cloudAvailable: true }))
  })
  const preview = vi.spyOn(instance.deps.control, 'decisionPreview').mockResolvedValue({ evaluation })
  const payload = {
    decision: draft,
    daemonId,
    state: { history: [{ text: 'Earlier example' }], currentMessage: { text: 'Sample only' } },
    consumer: { type: 'none' }
  }
  return { ...instance, daemonId, agentId, catalog, preview, payload }
}

describe('Decision management and standalone preview', () => {
  it('persists definitions across clients, preserves omitted sharing, and deletes without a daemon', async () => {
    const { app } = appAs()
    const created = await app.inject({
      method: 'POST',
      url: BASE,
      payload: { ...draft, visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
    })
    expect(created.statusCode).toBe(201)
    const id = created.json().id
    await expect(
      prisma.$executeRaw`UPDATE "decision" SET "sharedWith" = NULL WHERE "id" = ${id}::uuid`
    ).rejects.toThrow()
    expect((await appAs().app.inject({ method: 'GET', url: `${BASE}/${id}` })).json()).toMatchObject({
      decision: { name: draft.name, visibility: 'restricted', canEdit: true },
      usages: []
    })
    const changed = await app.inject({
      method: 'PATCH',
      url: `${BASE}/${id}`,
      payload: {
        name: 'Updated',
        providerId: draft.providerId,
        model: draft.model,
        question: draft.question
      }
    })
    expect(changed.statusCode).toBe(200)
    expect(changed.json()).toMatchObject({ name: 'Updated', visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] })
    expect((await app.inject({ method: 'GET', url: BASE })).json()).toMatchObject([{ id, usageCount: 0 }])
    expect((await app.inject({ method: 'DELETE', url: `${BASE}/${id}` })).statusCode).toBe(204)
    expect(await prisma.decision.count()).toBe(0)
    expect((await app.inject({ method: 'GET', url: `${BASE}/invalid-id` })).statusCode).toBe(400)
  })

  it('enforces tenant and Selected visibility and denies viewer mutations and paid previews', async () => {
    const collaborator = await member('collaborator'),
      viewer = await member('viewer')
    const owner = appAs(),
      hidden = appAs(collaborator),
      readOnly = appAs(viewer)
    const id = (
      await owner.app.inject({
        method: 'POST',
        url: BASE,
        payload: { ...draft, visibility: 'restricted', sharedWith: [viewer] }
      })
    ).json().id
    expect((await hidden.app.inject({ method: 'GET', url: BASE })).json()).toEqual([])
    for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
      expect(
        (await hidden.app.inject({ method, url: `${BASE}/${id}`, ...(method === 'PATCH' ? { payload: draft } : {}) }))
          .statusCode
      ).toBe(404)
    }
    expect((await readOnly.app.inject({ method: 'GET', url: `${BASE}/${id}` })).json().decision.canEdit).toBe(false)
    expect((await readOnly.app.inject({ method: 'POST', url: BASE, payload: draft })).statusCode).toBe(403)
    expect((await readOnly.app.inject({ method: 'PATCH', url: `${BASE}/${id}`, payload: draft })).statusCode).toBe(403)
    expect((await readOnly.app.inject({ method: 'DELETE', url: `${BASE}/${id}` })).statusCode).toBe(403)
    expect(
      (
        await readOnly.app.inject({
          method: 'POST',
          url: `${BASE}/preview`,
          payload: {
            decision: draft,
            daemonId: randomUUID(),
            state: {},
            consumer: { type: 'none' }
          }
        })
      ).statusCode
    ).toBe(403)
    const other = await prisma.org.create({
      data: { slug: 'other-decision-org', members: { create: { userId: DEFAULT_OWNER_ID, role: 'owner' } } }
    })
    expect(
      (await owner.app.inject({ method: 'GET', url: `/api/v1/orgs/${other.id}/decisions/${id}` })).statusCode
    ).toBe(404)
  })

  it('validates provider/model and membership, and repairs a Selected audience on member removal', async () => {
    const selected = await member('collaborator')
    const { app } = appAs()
    for (const input of [
      { ...draft, model: 'unknown' },
      { ...draft, providerId: 'openrouter' },
      { ...draft, visibility: 'restricted', sharedWith: ['missing-member'] }
    ]) {
      expect((await app.inject({ method: 'POST', url: BASE, payload: input })).statusCode).toBe(400)
    }
    const id = (
      await app.inject({
        method: 'POST',
        url: BASE,
        payload: { ...draft, visibility: 'restricted', sharedWith: [selected] }
      })
    ).json().id
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `${BASE}/${id}`,
          payload: { ...draft, visibility: 'restricted', sharedWith: [] }
        })
      ).statusCode
    ).toBe(400)
    const repo = new PgUserRepo(prisma)
    expect((await repo.previewMemberRemoval(DEFAULT_ORG_ID, selected, DEFAULT_OWNER_ID)).resources).toContainEqual({
      kind: 'decision',
      selected: 1,
      reassigned: 1
    })
    await repo.removeMember(DEFAULT_ORG_ID, selected, DEFAULT_OWNER_ID)
    expect((await prisma.decision.findUniqueOrThrow({ where: { id } })).sharedWith).toEqual([DEFAULT_OWNER_ID])
  })

  it('projects daemon capabilities and BYOK priority without decrypting or evaluating', async () => {
    const { app, deps, daemonId, preview } = await execution()
    const path = `${BASE}/providers?daemonId=${daemonId}`
    expect((await app.inject({ method: 'GET', url: path })).json()[0]).toMatchObject({
      source: 'ac_credits',
      readiness: { status: 'ready' }
    })
    await deps.repos.providerKey.put(OrgId(DEFAULT_ORG_ID), 'typesafe', { apiKey: 'example-key' })
    const byok = await app.inject({ method: 'GET', url: path })
    expect(byok.json()[0]).toMatchObject({
      source: 'byok',
      models: [{ id: 'jev-1.13.0' }, { id: 'jev-latest' }, { id: 'jev-preview' }]
    })
    expect(byok.body).not.toContain('example-key')
    expect(preview).not.toHaveBeenCalled()
    deps.daemonConns = { get: () => undefined }
    expect((await app.inject({ method: 'GET', url: path })).json()[0].readiness.status).toBe('daemon_offline')
  })

  it('sends sample context and model to the authorized daemon without persisting sample, evaluation, or session', async () => {
    const { app, agentId, daemonId, preview, payload } = await execution()
    const sessions = await prisma.sessionMeta.count()
    const response = await app.inject({ method: 'POST', url: `${BASE}/preview`, payload })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ mode: 'live', readiness: { status: 'ready' }, evaluation, consumer: null })
    expect(preview).toHaveBeenCalledExactlyOnceWith(
      daemonId,
      DEFAULT_ORG_ID,
      expect.objectContaining({
        agentId,
        decision: draft,
        state: payload.state,
        evaluationId: expect.any(String)
      })
    )
    expect(await prisma.decision.count()).toBe(0)
    expect(await prisma.sessionMeta.count()).toBe(sessions)
  })

  it('rejects oversized or consumer-bound previews and returns unavailable distinctly from No', async () => {
    const { app, preview, payload } = await execution()
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${BASE}/preview`,
          payload: { ...payload, state: { text: 'x'.repeat(33 * 1024) } }
        })
      ).statusCode
    ).toBe(400)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${BASE}/preview`,
          payload: { ...payload, consumer: { type: 'gate' } }
        })
      ).statusCode
    ).toBe(400)
    expect(preview).not.toHaveBeenCalled()
    preview.mockResolvedValueOnce({ evaluation: { status: 'unavailable', reason: 'credentials' } })
    expect((await app.inject({ method: 'POST', url: `${BASE}/preview`, payload })).json().evaluation).toEqual({
      status: 'unavailable',
      reason: 'credentials'
    })
    preview.mockRejectedValueOnce(new Error('example-secret-error'))
    const offline = await app.inject({ method: 'POST', url: `${BASE}/preview`, payload })
    expect(offline.statusCode).toBe(503)
    expect(offline.body).not.toContain('example-secret-error')
  })

  it('refuses hidden execution resources and suppresses results after access is revoked in flight', async () => {
    const userId = await member('collaborator')
    const { app, daemonId, agentId, payload, preview } = await execution(userId)
    await prisma.daemon.update({
      where: { id: daemonId },
      data: { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
    })
    expect((await app.inject({ method: 'POST', url: `${BASE}/preview`, payload })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `${BASE}/providers` })).json()).toEqual([])
    expect(preview).not.toHaveBeenCalled()
    await prisma.daemon.update({ where: { id: daemonId }, data: { visibility: 'org' } })
    preview.mockImplementationOnce(async () => {
      await prisma.agent.update({
        where: { id: agentId },
        data: { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
      })
      return { evaluation }
    })
    expect((await app.inject({ method: 'POST', url: `${BASE}/preview`, payload })).statusCode).toBe(404)
  })
})
