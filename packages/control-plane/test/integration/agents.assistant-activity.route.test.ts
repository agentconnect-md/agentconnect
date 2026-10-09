// The assistant-mode Activity view over the REST surface (assistant-mode.md §1.7, §5.11): who may read and edit what, proxied to the daemon and kept nowhere.
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  ASSISTANT_ACTIVITY_FEATURE,
  ASSISTANT_DRAFT_DECISION_FEATURE,
  TASK_LIST_FEATURE,
  type AssistantActivityReadReq,
  type AssistantActivityReadResult,
  type AssistantActivityWriteReq,
  type AssistantActivityWriteResult
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon, seedSessionMeta } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { NoConnection } from '../../src/orchestrator/outbound.js'
import type { DaemonLiveness } from '../../src/ports.js'
import { ProtocolError } from '../../src/domain/errors.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd5d5d5d5-dddd-4ddd-8ddd-ddddddddd0a1'
const AGENT = 'a5a5a5a5-aaaa-4aaa-8aaa-aaaaaaaaa0a1'
const GRANT = 'c'.repeat(32)
const CAPABILITIES = {
  platforms: ['slack'],
  runtimes: ['claude'],
  acp: true,
  features: [ASSISTANT_ACTIVITY_FEATURE, ASSISTANT_DRAFT_DECISION_FEATURE]
}
const LIVE: DaemonLiveness = {
  get: (id) => (id === DAEMON ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined)
}
const ITEM = {
  id: 'item-1',
  title: 'Ship the release notes',
  status: 'active' as const,
  doneWhen: 'The notes are published',
  nextCheck: '2026-10-10T09:00:00.000Z',
  origin: { platform: 'slack', channel: 'D0ALICE' },
  places: [{ platform: 'slack', channel: 'C0SUPPORT' }],
  createdAt: '2026-10-09T09:00:00.000Z',
  updatedAt: '2026-10-09T09:00:00.000Z'
}

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()))
})

/** The two daemon seams under test, recording every forwarded request and answering from fixtures. */
class ActivitySpy {
  reads: AssistantActivityReadReq[] = []
  writes: AssistantActivityWriteReq[] = []
  subsessions: Extract<AssistantActivityReadResult, { operation: 'subsessions' }>['subsessions'] = []
  found = true
  decision: Omit<Extract<AssistantActivityWriteResult, { operation: 'decide-draft' }>, 'operation'> = {
    result: 'decided',
    status: 'succeeded',
    granted: false,
    failure: null
  }
  failure: Error | null = null

  async assistantActivityRead(daemonId: string, req: AssistantActivityReadReq): Promise<AssistantActivityReadResult> {
    expect(daemonId).toBe(DAEMON)
    this.reads.push(req)
    if (this.failure) throw this.failure
    switch (req.operation) {
      case 'items':
        return { operation: 'items', items: [ITEM], truncated: true }
      case 'item':
        return {
          operation: 'item',
          item:
            req.itemId === ITEM.id
              ? {
                  ...ITEM,
                  summary: 'In review.',
                  observations: [{ text: 'PR opened', at: '2026-10-09T10:00:00.000Z' }]
                }
              : null
        }
      case 'subsessions':
        return { operation: 'subsessions', subsessions: this.subsessions, truncated: false }
      case 'drafts':
        return {
          operation: 'drafts',
          drafts: [
            {
              id: 'draft-1',
              kind: 'elsewhere',
              target: {
                platform: 'slack',
                integrationId: 'int-1',
                channel: 'C0SUPPORT',
                thread: null,
                name: 'support',
                dm: false,
                external: false
              },
              text: 'The release is out.',
              offerAlways: true,
              approver: null,
              createdAt: '2026-10-09T09:00:00.000Z',
              expiresAt: '2026-10-10T09:00:00.000Z'
            }
          ],
          truncated: false
        }
      case 'grants':
        return {
          operation: 'grants',
          grants: [
            {
              id: GRANT,
              source: { platform: 'webchat', integrationId: null, channel: 'conv-1' },
              target: { platform: 'slack', integrationId: 'int-1', channel: 'C0SUPPORT' },
              grantedByName: 'Alice',
              grantedAt: '2026-10-09T09:00:00.000Z'
            }
          ],
          truncated: false
        }
    }
  }

  async assistantActivityWrite(
    daemonId: string,
    req: AssistantActivityWriteReq
  ): Promise<AssistantActivityWriteResult> {
    expect(daemonId).toBe(DAEMON)
    this.writes.push(req)
    if (this.failure) throw this.failure
    if (req.operation === 'decide-draft') return { operation: 'decide-draft', ...this.decision }
    return { operation: req.operation, found: this.found }
  }
}

function app(control: ActivitySpy, userId?: string): HttpApp {
  const running = buildHttpApp(
    prisma,
    userId ? { DEFAULT_OWNER_ID: userId } : undefined,
    LIVE,
    control as unknown as ControlSender
  )
  opened.push(running)
  return running
}

async function makeUser(sub: string, role: OrgMemberRole): Promise<string> {
  const users = new PgUserRepo(prisma)
  const email = `${sub}@acme.dev`
  const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

async function seedAssistant(
  opts: { features?: string[]; enabled?: boolean; visibility?: 'org' | 'restricted' } = {}
): Promise<void> {
  await seedDaemon(prisma, DAEMON, {
    capabilities: { ...CAPABILITIES, features: opts.features ?? CAPABILITIES.features }
  })
  await seedAgent(prisma, AGENT, {
    daemonId: DAEMON,
    runtime: 'claude-acp',
    ...(opts.visibility === 'restricted' ? { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] } : {})
  })
  await prisma.agent.update({
    where: { id: AGENT },
    data: { assistantMode: { enabled: opts.enabled ?? true, responsibleUserId: DEFAULT_OWNER_ID } }
  })
}

const get = (running: HttpApp, path: string) =>
  running.app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT}/assistant${path}` })
const del = (running: HttpApp, path: string) =>
  running.app.inject({ method: 'DELETE', url: `${ORG}/agents/${AGENT}/assistant${path}` })

describe('the assistant Activity routes', () => {
  it('proxies every section and both edits for an editor, storing nothing', async () => {
    await seedAssistant()
    const control = new ActivitySpy()
    const running = app(control)
    const sessionsBefore = await prisma.sessionMeta.count()

    const open = await get(running, '/items')
    expect(open.statusCode, open.body).toBe(200)
    expect(open.json()).toEqual({ items: [ITEM], truncated: true })
    const closed = await get(running, '/items?section=closed&limit=20')
    expect(closed.statusCode).toBe(200)
    const item = await get(running, '/items/item-1')
    expect(item.json()).toMatchObject({ id: 'item-1', summary: 'In review.', observations: [{ text: 'PR opened' }] })
    expect((await get(running, '/items/item-2')).statusCode).toBe(404)
    expect((await get(running, '/drafts')).json()).toMatchObject({
      drafts: [{ id: 'draft-1', text: 'The release is out.', offerAlways: true, target: { name: 'support' } }],
      truncated: false
    })
    expect((await get(running, '/grants')).json()).toMatchObject({ grants: [{ id: GRANT, grantedByName: 'Alice' }] })

    expect(control.reads).toEqual([
      { agentId: AGENT, operation: 'items', section: 'open', limit: 100 },
      { agentId: AGENT, operation: 'items', section: 'closed', limit: 20 },
      { agentId: AGENT, operation: 'item', itemId: 'item-1' },
      { agentId: AGENT, operation: 'item', itemId: 'item-2' },
      { agentId: AGENT, operation: 'drafts', limit: 50 },
      { agentId: AGENT, operation: 'grants' }
    ])

    const deleted = await del(running, '/items/item-1')
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toEqual({ ok: true })
    const revoked = await del(running, `/grants/${GRANT}`)
    expect(revoked.json()).toEqual({ ok: true })
    control.found = false
    expect((await del(running, '/items/item-1')).statusCode).toBe(404)
    expect((await del(running, `/grants/${GRANT}`)).statusCode).toBe(404)
    expect(control.writes).toEqual([
      { agentId: AGENT, operation: 'delete-item', itemId: 'item-1' },
      { agentId: AGENT, operation: 'revoke-grant', grantId: GRANT },
      { agentId: AGENT, operation: 'delete-item', itemId: 'item-1' },
      { agentId: AGENT, operation: 'revoke-grant', grantId: GRANT }
    ])
    expect(await prisma.sessionMeta.count()).toBe(sessionsBefore)
  })

  it('lets a viewer read items and sub-sessions, and keeps drafts, grants and both edits for editors', async () => {
    await seedAssistant()
    const viewer = await makeUser(`activity-viewer-${randomUUID()}`, 'viewer')
    const control = new ActivitySpy()
    const running = app(control, viewer)

    expect((await get(running, '/items')).statusCode).toBe(200)
    expect((await get(running, '/items/item-1')).statusCode).toBe(200)
    expect((await get(running, '/subsessions')).statusCode).toBe(200)
    for (const res of [
      await get(running, '/drafts'),
      await get(running, '/grants'),
      await del(running, '/items/item-1'),
      await del(running, `/grants/${GRANT}`)
    ]) {
      expect(res.statusCode).toBe(403)
    }
    expect(control.reads.map((r) => r.operation)).toEqual(['items', 'item', 'subsessions'])
    expect(control.writes).toEqual([])

    // A collaborator edits.
    const collaborator = await makeUser(`activity-editor-${randomUUID()}`, 'collaborator')
    expect((await get(app(control, collaborator), '/drafts')).statusCode).toBe(200)
    expect((await del(app(control, collaborator), '/items/item-1')).statusCode).toBe(200)
  })

  it('reads a restricted agent as absent to a member it is not shared with', async () => {
    await seedAssistant({ visibility: 'restricted' })
    const other = await makeUser(`activity-other-${randomUUID()}`, 'collaborator')
    const control = new ActivitySpy()
    const res = await get(app(control, other), '/items')
    expect(res.statusCode).toBe(404)
    expect((await del(app(control, other), '/items/item-1')).statusCode).toBe(404)
    expect(control.reads).toEqual([])
    expect(control.writes).toEqual([])
  })

  it('refuses an agent outside assistant mode and a daemon without the feature before any daemon I/O', async () => {
    await seedAssistant({ enabled: false })
    const control = new ActivitySpy()
    const off = await get(app(control), '/items')
    expect(off.statusCode).toBe(409)
    expect(off.json()).toMatchObject({ code: 'ASSISTANT_MODE_OFF' })
    expect((await del(app(control), '/items/item-1')).json()).toMatchObject({ code: 'ASSISTANT_MODE_OFF' })

    await prisma.agent.update({
      where: { id: AGENT },
      data: { assistantMode: { enabled: true, responsibleUserId: DEFAULT_OWNER_ID } }
    })
    await prisma.daemon.update({
      where: { id: DAEMON },
      data: { capabilities: { ...CAPABILITIES, features: [TASK_LIST_FEATURE] } }
    })
    const old = await get(app(control), '/items')
    expect(old.statusCode).toBe(409)
    expect(old.json()).toMatchObject({ code: 'DAEMON_FEATURE_MISSING' })
    expect(control.reads).toEqual([])
    expect(control.writes).toEqual([])
  })

  it('maps the daemon’s refusals and an offline daemon', async () => {
    await seedAssistant()
    const control = new ActivitySpy()
    const running = app(control)
    control.failure = new ProtocolError('BAD_PAYLOAD', 'not in assistant mode', {
      details: { reason: 'assistant-mode-off' }
    })
    expect((await get(running, '/items')).json()).toMatchObject({ statusCode: 409, code: 'ASSISTANT_MODE_OFF' })
    control.failure = new ProtocolError('BAD_PAYLOAD', 'unknown agent', { details: { reason: 'unknown-agent' } })
    expect((await del(running, '/items/item-1')).statusCode).toBe(404)
    control.failure = new NoConnection(DAEMON)
    expect((await get(running, '/grants')).json()).toMatchObject({ statusCode: 503, code: 'DAEMON_OFFLINE' })
  })

  it('shows every sub-session’s state, and its conversation only to those who may view it', async () => {
    await seedAssistant()
    const member = await makeUser(`activity-member-${randomUUID()}`, 'collaborator')
    const [team, teamChild, dm, dmChild, foreign] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID()
    ]
    await seedSessionMeta(prisma, team, AGENT, { daemonId: DAEMON, channel: 'C0SUPPORT' })
    await prisma.sessionMeta.update({ where: { id: team }, data: { title: 'support', channelName: 'support' } })
    await seedSessionMeta(prisma, teamChild, AGENT, { daemonId: DAEMON, parentSessionId: team })
    await prisma.sessionMeta.update({ where: { id: teamChild }, data: { title: 'Fix the flaky test' } })
    // A sub-session of the owner's DM takes the DM's audience.
    await seedSessionMeta(prisma, dm, AGENT, {
      daemonId: DAEMON,
      visibility: 'private',
      ownerIdentity: `user:${DEFAULT_OWNER_ID}`
    })
    await seedSessionMeta(prisma, dmChild, AGENT, {
      daemonId: DAEMON,
      visibility: 'private',
      ownerIdentity: `user:${DEFAULT_OWNER_ID}`,
      parentSessionId: dm
    })
    // Another agent's session is never this agent's sub-session.
    const otherAgent = randomUUID()
    await seedAgent(prisma, otherAgent, { daemonId: DAEMON })
    await seedSessionMeta(prisma, foreign, otherAgent, { daemonId: DAEMON })

    const control = new ActivitySpy()
    control.subsessions = [
      { sessionId: teamChild, parentSessionId: team, state: 'open', createdAt: '2026-10-09T09:00:00.000Z' },
      { sessionId: null, parentSessionId: team, state: 'open', createdAt: '2026-10-09T08:30:00.000Z' },
      { sessionId: dmChild, parentSessionId: dm, state: 'done', createdAt: '2026-10-09T08:00:00.000Z' },
      { sessionId: foreign, parentSessionId: foreign, state: 'failed', createdAt: '2026-10-09T07:00:00.000Z' }
    ]
    const parent = { sessionId: team, title: 'support', platform: 'slack', channelName: 'support' }

    const asMember = (await get(app(control, member), '/subsessions')).json()
    expect(asMember).toEqual({
      subsessions: [
        {
          sessionId: teamChild,
          title: 'Fix the flaky test',
          state: 'open',
          startedAt: '2026-10-09T09:00:00.000Z',
          visible: true,
          parent
        },
        { sessionId: null, title: null, state: 'open', startedAt: '2026-10-09T08:30:00.000Z', visible: true, parent },
        {
          sessionId: null,
          title: null,
          state: 'done',
          startedAt: '2026-10-09T08:00:00.000Z',
          visible: false,
          parent: null
        },
        {
          sessionId: null,
          title: null,
          state: 'failed',
          startedAt: '2026-10-09T07:00:00.000Z',
          visible: false,
          parent: null
        }
      ],
      truncated: false
    })

    // The DM's owner sees their own sub-session and where it came from.
    const asOwner = (await get(app(control), '/subsessions')).json()
    expect(asOwner.subsessions[2]).toMatchObject({ sessionId: dmChild, visible: true, parent: { sessionId: dm } })
    expect(asOwner.subsessions[3]).toMatchObject({ sessionId: null, visible: false, parent: null })
  })
})

const decide = (running: HttpApp, decision: string, draftId = 'draft-1') =>
  running.app.inject({
    method: 'POST',
    url: `${ORG}/agents/${AGENT}/assistant/drafts/${draftId}/decision`,
    payload: { decision }
  })

describe('deciding a draft from the console', () => {
  it('forwards an editor’s decision under the editor’s own identity and answers its outcome', async () => {
    await seedAssistant()
    const editor = await makeUser(`activity-decider-${randomUUID()}`, 'collaborator')
    await new PgUserRepo(prisma).updateProfile(editor, { displayName: 'Grace' })
    const control = new ActivitySpy()
    const running = app(control, editor)

    control.decision = { result: 'decided', status: 'succeeded', granted: true, failure: null }
    const approved = await decide(running, 'approve_always')
    expect(approved.statusCode, approved.body).toBe(200)
    expect(approved.json()).toEqual({ status: 'succeeded', alwaysAllowed: true, failure: null })

    control.decision = { result: 'decided', status: 'outcome_unknown', granted: false, failure: 'socket hang up' }
    expect((await decide(running, 'approve', 'draft-2')).json()).toEqual({
      status: 'outcome_unknown',
      alwaysAllowed: false,
      failure: 'socket hang up'
    })
    control.decision = { result: 'decided', status: 'denied', granted: false, failure: null }
    expect((await decide(running, 'discard', 'draft-3')).json()).toMatchObject({ status: 'denied' })

    const decider = { userId: editor, name: 'Grace' }
    expect(control.writes).toEqual([
      { agentId: AGENT, operation: 'decide-draft', draftId: 'draft-1', choice: 'always', decider },
      { agentId: AGENT, operation: 'decide-draft', draftId: 'draft-2', choice: 'approve', decider },
      { agentId: AGENT, operation: 'decide-draft', draftId: 'draft-3', choice: 'discard', decider }
    ])
  })

  it('refuses an expired, an already decided and an unknown draft with their reasons', async () => {
    await seedAssistant()
    const control = new ActivitySpy()
    const running = app(control)
    control.decision = { result: 'expired', status: 'expired', granted: false, failure: null }
    const expired = await decide(running, 'approve')
    expect(expired.statusCode).toBe(409)
    expect(expired.json()).toMatchObject({ code: 'DRAFT_EXPIRED', message: 'the draft expired; nothing was posted' })
    control.decision = { result: 'already-decided', status: 'executing', granted: false, failure: null }
    expect((await decide(running, 'discard')).json()).toMatchObject({ statusCode: 409, code: 'DRAFT_ALREADY_DECIDED' })
    control.decision = { result: 'not-found', status: null, granted: false, failure: null }
    expect((await decide(running, 'approve')).json()).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' })
    expect((await decide(running, 'allow_once')).statusCode).toBe(400)
    expect(control.writes).toHaveLength(3)
  })

  it('lets no viewer decide', async () => {
    await seedAssistant()
    const control = new ActivitySpy()
    const viewer = await makeUser(`activity-decide-viewer-${randomUUID()}`, 'viewer')
    expect((await decide(app(control, viewer), 'approve')).statusCode).toBe(403)
    expect(control.writes).toEqual([])
  })

  it('reads a restricted agent as absent to a member it is not shared with', async () => {
    await seedAssistant({ visibility: 'restricted' })
    const control = new ActivitySpy()
    const other = await makeUser(`activity-decide-other-${randomUUID()}`, 'collaborator')
    expect((await decide(app(control, other), 'approve')).statusCode).toBe(404)
    expect(control.writes).toEqual([])
  })

  it('refuses a daemon that cannot decide, and reports a decision it sent but could not confirm', async () => {
    await seedAssistant({ features: [ASSISTANT_ACTIVITY_FEATURE] })
    const control = new ActivitySpy()
    const old = await decide(app(control), 'approve')
    expect(old.statusCode).toBe(409)
    expect(old.json()).toMatchObject({ code: 'DAEMON_FEATURE_MISSING' })
    // Reading still works on that daemon.
    expect((await get(app(control), '/drafts')).statusCode).toBe(200)
    expect(control.writes).toEqual([])

    await prisma.daemon.update({ where: { id: DAEMON }, data: { capabilities: CAPABILITIES } })
    control.failure = new ProtocolError('INTERNAL', 'no ack after 1 tries')
    expect((await decide(app(control), 'approve')).json()).toMatchObject({
      statusCode: 503,
      code: 'DECISION_UNCONFIRMED'
    })
    control.failure = new NoConnection(DAEMON)
    expect((await decide(app(control), 'approve')).json()).toMatchObject({ statusCode: 503, code: 'DAEMON_OFFLINE' })
    control.failure = new ProtocolError('BAD_PAYLOAD', 'not in assistant mode', {
      details: { reason: 'assistant-mode-off' }
    })
    expect((await decide(app(control), 'approve')).json()).toMatchObject({ code: 'ASSISTANT_MODE_OFF' })
  })
})
