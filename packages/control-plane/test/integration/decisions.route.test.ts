import { randomUUID } from 'node:crypto'
import { PgDecisionRepo } from '../../src/persistence/repositories/decision.repo.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DECISION_PROVIDER_PROFILES, DECISION_PREVIEW_V1_FEATURE, type DecisionDraft } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon, seedDutyGroup } from '../fixtures/seed.js'
import { poolSetId, seedPoolMember } from '../fakes/member-set.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { DaemonId, OrgId } from '../../src/domain/ids.js'
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
  it('authorizes model bindings, validates rules, and protects bound Decisions from deletion', async () => {
    const owner = appAs(),
      editor = appAs(await member('collaborator'))
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    const url = `/api/v1/orgs/${DEFAULT_ORG_ID}/agents/${agentId}`
    const id = (
      await owner.app.inject({
        method: 'POST',
        url: BASE,
        payload: { ...draft, visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
      })
    ).json().id
    const modelSelection = {
      decisionId: id,
      rules: [{ when: { type: 'boolean', values: [true] }, runtime: 'claude', model: 'model-capable' }]
    }
    const patch = (app: HttpApp, payload: object) => app.app.inject({ method: 'PATCH', url, payload })
    expect((await patch(editor, { model: 'model-standard', modelSelection })).statusCode).toBe(403)
    expect((await patch(owner, { modelSelection })).statusCode).toBe(400)
    expect(
      (
        await patch(owner, {
          model: 'model-standard',
          modelSelection: {
            ...modelSelection,
            rules: [{ when: { type: 'score', min: 0, max: 1 }, runtime: 'claude', model: 'model-capable' }]
          }
        })
      ).statusCode
    ).toBe(400)
    expect((await patch(owner, { model: 'model-standard', modelSelection })).json()).toMatchObject({
      modelSelection,
      decisionIds: []
    })
    expect((await patch(editor, { modelSelection })).statusCode).toBe(200)
    expect((await patch(editor, { decisionIds: [id] })).statusCode).toBe(403)
    expect((await owner.app.inject({ method: 'GET', url: `${BASE}/${id}` })).json().usages).toEqual([
      expect.objectContaining({ kind: 'model_selection', id: agentId })
    ])
    expect((await editor.app.inject({ method: 'GET', url: `${url}/decisions` })).json()).toEqual([])
    const retained = (
      await editor.app.inject({ method: 'GET', url: `${url}/decisions?purpose=model_selection` })
    ).json()
    expect(retained).toEqual([expect.objectContaining({ id })])
    expect(retained[0]).not.toHaveProperty('question')
    expect((await owner.app.inject({ method: 'DELETE', url: `${BASE}/${id}` })).statusCode).toBe(409)
    const nextId = (
      await owner.app.inject({
        method: 'POST',
        url: BASE,
        payload: {
          ...draft,
          name: 'Complexity',
          visibility: 'restricted',
          sharedWith: [DEFAULT_OWNER_ID]
        }
      })
    ).json().id
    const chain = {
      ...modelSelection,
      rules: [{ when: modelSelection.rules[0]!.when, nextStepId: 'complexity' }],
      steps: [{ id: 'complexity', decisionId: nextId, rules: modelSelection.rules }]
    }
    expect((await patch(editor, { modelSelection: chain })).statusCode).toBe(403)
    expect(
      (
        await patch(owner, {
          modelSelection: {
            ...chain,
            steps: [
              {
                ...chain.steps[0],
                rules: [{ when: { type: 'score', min: 0, max: 1 }, runtime: 'claude', model: 'model-capable' }]
              }
            ]
          }
        })
      ).statusCode
    ).toBe(400)
    expect((await patch(owner, { modelSelection: chain })).json()).toMatchObject({ modelSelection: chain })
    expect((await patch(editor, { modelSelection: chain })).statusCode).toBe(200)
    expect((await owner.app.inject({ method: 'GET', url: `${BASE}/${nextId}` })).json().usages).toEqual([
      expect.objectContaining({ kind: 'model_selection', id: agentId })
    ])
    expect((await owner.app.inject({ method: 'DELETE', url: `${BASE}/${nextId}` })).statusCode).toBe(409)
    const chainMetadata = (
      await editor.app.inject({ method: 'GET', url: `${url}/decisions?purpose=model_selection` })
    ).json()
    expect(chainMetadata.map((entry: { id: string }) => entry.id).sort()).toEqual([id, nextId].sort())
    expect(chainMetadata.every((entry: object) => !('question' in entry))).toBe(true)
    expect((await patch(editor, { modelSelection })).statusCode).toBe(200)
    expect((await owner.app.inject({ method: 'DELETE', url: `${BASE}/${nextId}` })).statusCode).toBe(204)
    expect((await patch(owner, { model: null })).statusCode).toBe(400)
    expect((await patch(owner, { modelSelection: null })).statusCode).toBe(200)
    expect((await owner.app.inject({ method: 'DELETE', url: `${BASE}/${id}` })).statusCode).toBe(204)
  })
  it('resolves only attached IDs in the organization, including Selected Decisions, and pages deterministically', async () => {
    const repo = new PgDecisionRepo(prisma)
    const orgId = OrgId(DEFAULT_ORG_ID)
    const actor = { userId: DEFAULT_OWNER_ID, role: 'owner' as const }
    const first = await repo.create(orgId, { ...draft, name: 'Reply A' }, actor)
    const second = await repo.create(orgId, { ...draft, name: 'Reply B' }, actor)
    const restricted = await repo.create(
      orgId,
      { ...draft, name: 'Selected only', visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] },
      actor
    )
    const attached = [first.id, second.id, restricted.id]
    const rows = await repo.listForAgent(orgId, attached, { query: 'reply', limit: 1 })
    expect(rows.map((row) => row.id)).toEqual([first.id, second.id].sort())
    expect(Object.keys(rows[0]!).sort()).toEqual(['id', 'model', 'name', 'providerId', 'question'])
    expect(
      (await repo.listForAgent(orgId, attached, { query: 'REPLY', cursor: rows[0]!.id, limit: 1 })).map((row) => row.id)
    ).toEqual([rows[1]!.id])
    expect(await repo.getForAgent(orgId, restricted.id)).toMatchObject({ id: restricted.id })
    expect(await repo.listForAgent(orgId, [restricted.id], { limit: 10 })).toEqual([
      expect.objectContaining({ id: restricted.id })
    ])
    expect(await repo.getForAgent(OrgId('another-org'), first.id)).toBeNull()
    expect(await repo.listForAgent(OrgId('another-org'), attached, { limit: 10 })).toEqual([])
    expect(await repo.listForAgent(orgId, [], { limit: 10 })).toEqual([])
    await repo.update(orgId, first.id, { ...draft, visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }, actor)
    expect(await repo.getForAgent(orgId, first.id)).toMatchObject({ id: first.id })
    await repo.delete(orgId, second.id, actor)
    expect(await repo.getForAgent(orgId, second.id)).toBeNull()
  })

  it('authorizes new attachments like skills, preserves existing hidden bindings, and requires unbinding before delete', async () => {
    const collaborator = await member('collaborator')
    const viewer = await member('viewer')
    const { app } = appAs()
    const restricted = await app.inject({
      method: 'POST',
      url: BASE,
      payload: { ...draft, visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
    })
    const decisionId = restricted.json().id
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)
    const agentUrl = `/api/v1/orgs/${DEFAULT_ORG_ID}/agents/${agentId}`
    const collaboratorApp = appAs(collaborator).app
    const bind = (target: typeof app, ids: string[]) =>
      target.inject({ method: 'PATCH', url: agentUrl, payload: { decisionIds: ids } })
    expect((await bind(collaboratorApp, [decisionId])).statusCode).toBe(403)
    expect((await bind(app, [decisionId])).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: agentUrl })).json().decisionIds).toEqual([decisionId])
    expect((await bind(collaboratorApp, [decisionId])).statusCode).toBe(200)
    const attached = await collaboratorApp.inject({ method: 'GET', url: `${agentUrl}/decisions` })
    expect(attached.statusCode).toBe(200)
    expect(attached.json()).toEqual([
      { id: decisionId, name: draft.name, model: draft.model, providerId: draft.providerId, questionType: 'boolean' }
    ])
    expect((await bind(appAs(viewer).app, [])).statusCode).toBe(403)
    expect((await app.inject({ method: 'DELETE', url: `${BASE}/${decisionId}` })).statusCode).toBe(409)
    expect((await bind(collaboratorApp, [])).statusCode).toBe(200)
    expect((await bind(collaboratorApp, [decisionId])).statusCode).toBe(403)
    expect((await bind(app, [randomUUID()])).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: agentUrl })).json().decisionIds).toEqual([])
    expect((await app.inject({ method: 'DELETE', url: `${BASE}/${decisionId}` })).statusCode).toBe(204)
  })

  it('counts agents the caller cannot see in a delete refusal without naming them', async () => {
    const collaborator = appAs(await member('collaborator'))
    const decisionId = (await appAs().app.inject({ method: 'POST', url: BASE, payload: draft })).json().id
    const hidden = { visibility: 'restricted' as const, sharedWith: [DEFAULT_OWNER_ID], name: 'secret-agent' }
    await seedAgent(prisma, randomUUID(), { ...hidden, runtimeOverrides: { decisionIds: [decisionId] } })
    await seedAgent(prisma, randomUUID(), {
      ...hidden,
      name: 'secret-router',
      runtimeOverrides: { modelSelection: { decisionId, rules: [] } }
    })
    const refused = await collaborator.app.inject({ method: 'DELETE', url: `${BASE}/${decisionId}` })
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ usages: [], hiddenUsageCount: 2 })
    expect(refused.body).not.toContain('secret-')

    const shownId = randomUUID()
    await seedAgent(prisma, shownId, { name: 'open-agent', runtimeOverrides: { decisionIds: [decisionId] } })
    const mixed = await collaborator.app.inject({ method: 'DELETE', url: `${BASE}/${decisionId}` })
    expect(mixed.json()).toMatchObject({
      message: 'This Decision is used by 3 agents.',
      usages: [expect.objectContaining({ kind: 'agent_tool', id: shownId })],
      hiddenUsageCount: 2
    })
  })

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
    const { daemonId: _daemonId, ...sample } = payload
    const response = await app.inject({
      method: 'POST',
      url: `${BASE}/preview`,
      payload: { ...sample, target: { kind: 'daemon', daemonId } }
    })
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

  it.each(['pool', 'set'] as const)('resolves a %s target within its current ready members', async (kind) => {
    const { app, deps, preview, payload } = await execution()
    const setId =
      kind === 'pool'
        ? await poolSetId(prisma)
        : (await deps.repos.memberSet.createForOrg(DEFAULT_ORG_ID, 'Example group')).id
    const first = randomUUID(),
      second = randomUUID(),
      agentId = randomUUID(),
      dutyId = randomUUID()
    for (const daemonId of [first, second]) {
      if (kind === 'pool') await seedPoolMember(prisma, daemonId)
      else {
        await seedDaemon(prisma, daemonId)
        await deps.repos.memberSet.enroll(setId, DaemonId(daemonId))
      }
    }
    await seedAgent(prisma, agentId, { setId })
    await seedDutyGroup(prisma, dutyId, second, [agentId], { confirmed: true })
    const { daemonId: _daemonId, ...sample } = payload
    const input = { ...sample, target: kind === 'pool' ? { kind } : { kind, setId } }
    const catalog = (await app.inject({ method: 'GET', url: `${BASE}/providers` })).json()
    expect(catalog.find((entry: { daemonId: string }) => entry.daemonId === second)).toMatchObject({
      pool: kind === 'pool',
      memberSetId: setId,
      readiness: { status: 'ready' }
    })
    expect((await app.inject({ method: 'POST', url: `${BASE}/preview`, payload: input })).statusCode).toBe(200)
    expect(preview).toHaveBeenLastCalledWith(second, DEFAULT_ORG_ID, expect.objectContaining({ agentId }))

    await prisma.dutyGroup.update({ where: { id: dutyId }, data: { holder: first, confirmedHolder: first } })
    expect((await app.inject({ method: 'POST', url: `${BASE}/preview`, payload: input })).statusCode).toBe(200)
    expect(preview).toHaveBeenLastCalledWith(first, DEFAULT_ORG_ID, expect.objectContaining({ agentId }))

    await prisma.memberSetMember.deleteMany({ where: { setId } })
    expect((await app.inject({ method: 'POST', url: `${BASE}/preview`, payload: input })).statusCode).toBe(503)
    expect(preview).toHaveBeenCalledTimes(2)
  })

  it('fences group tenancy and suppresses results after the execution daemon leaves the group', async () => {
    const { app, deps, daemonId, preview, payload } = await execution()
    const other = await prisma.org.create({ data: { slug: 'other-preview-org' } })
    const foreign = await deps.repos.memberSet.createForOrg(other.id, 'Other group')
    const { daemonId: _daemonId, ...sample } = payload
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${BASE}/preview`,
          payload: { ...sample, target: { kind: 'set', setId: foreign.id } }
        })
      ).statusCode
    ).toBe(404)
    expect(preview).not.toHaveBeenCalled()

    const group = await deps.repos.memberSet.createForOrg(DEFAULT_ORG_ID, 'Example group')
    await deps.repos.memberSet.enroll(group.id, DaemonId(daemonId))
    preview.mockImplementationOnce(async () => {
      await prisma.memberSetMember.delete({ where: { daemonId } })
      return { evaluation }
    })
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${BASE}/preview`,
          payload: { ...sample, target: { kind: 'set', setId: group.id } }
        })
      ).statusCode
    ).toBe(404)
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
