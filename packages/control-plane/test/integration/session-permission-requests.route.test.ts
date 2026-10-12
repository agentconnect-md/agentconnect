// A webchat conversation's own approval requests over the REST surface: its owner answers them where people in chat may approve, editors always, proxied to the daemon and kept nowhere.
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  CONVERSATION_PERMISSION_REQUESTS_FEATURE,
  PERMISSION_REQUEST_NOT_IN_CONVERSATION,
  SUBSESSION_COORDINATE_PREFIX,
  type Ack,
  type AgentPermissionDecision,
  type AgentPermissionRequestList,
  type AgentPermissionRequestPage,
  type AgentPermissionRequestRecord,
  type ChatActions
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon, seedSessionMeta } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { NoConnection } from '../../src/orchestrator/outbound.js'
import type { DaemonLiveness } from '../../src/ports.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd6d6d6d6-dddd-4ddd-8ddd-ddddddddd0b2'
const AGENT = 'a6a6a6a6-aaaa-4aaa-8aaa-aaaaaaaaa0b2'
const REQUEST = '11111111-2222-4333-8444-555555555555'
const CAPABILITIES = {
  platforms: ['slack'],
  runtimes: ['claude'],
  acp: true,
  features: [CONVERSATION_PERMISSION_REQUESTS_FEATURE]
}
const LIVE: DaemonLiveness = {
  get: (id) => (id === DAEMON ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined)
}

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()))
})

/** The daemon's approval queue, recording what the Control Plane asks of it. */
class QueueSpy {
  lists: AgentPermissionRequestList[] = []
  decisions: AgentPermissionDecision[] = []
  requests: AgentPermissionRequestRecord[] = []
  ack: Ack = { ok: true }
  failure: Error | null = null

  async agentPermissionRequests(
    daemonId: string,
    req: AgentPermissionRequestList
  ): Promise<AgentPermissionRequestPage> {
    expect(daemonId).toBe(DAEMON)
    this.lists.push(req)
    if (this.failure) throw this.failure
    return { agentId: req.agentId, requests: this.requests }
  }

  async agentPermissionDecision(daemonId: string, req: AgentPermissionDecision): Promise<Ack> {
    expect(daemonId).toBe(DAEMON)
    this.decisions.push(req)
    if (this.failure) throw this.failure
    return this.ack
  }
}

function app(control: QueueSpy, userId: string): HttpApp {
  const running = buildHttpApp(prisma, { DEFAULT_OWNER_ID: userId }, LIVE, control as unknown as ControlSender)
  opened.push(running)
  return running
}

async function makeUser(sub: string, role: OrgMemberRole, displayName?: string): Promise<string> {
  const users = new PgUserRepo(prisma)
  const email = `${sub}@example.test`
  const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  if (displayName) await users.updateProfile(userId, { displayName })
  return userId
}

/** An agent at `chatActions`, the viewer who owns one of its webchat conversations, and an editor. */
async function world(chatActions: ChatActions, features = CAPABILITIES.features) {
  await seedDaemon(prisma, DAEMON, { capabilities: { ...CAPABILITIES, features } })
  await seedAgent(prisma, AGENT, { daemonId: DAEMON, runtime: 'claude-acp', runtimeOverrides: { chatActions } })
  const owner = await makeUser(`conv-owner-${randomUUID()}`, 'viewer', 'Olive')
  const viewer = await makeUser(`conv-viewer-${randomUUID()}`, 'viewer')
  const editor = await makeUser(`conv-editor-${randomUUID()}`, 'collaborator', 'Grace')
  const [mine, team, theirs, slack, sub, foreign] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID()
  ]
  const webchat = { daemonId: DAEMON, platform: 'webchat' }
  await seedSessionMeta(prisma, mine, AGENT, {
    ...webchat,
    channel: 'conv-mine',
    visibility: 'private',
    ownerIdentity: `user:${owner}`
  })
  // Open to the organization: the owner's, which other members may view.
  await seedSessionMeta(prisma, team, AGENT, {
    ...webchat,
    channel: 'conv-team',
    visibility: 'org',
    ownerIdentity: `user:${owner}`
  })
  await seedSessionMeta(prisma, theirs, AGENT, {
    ...webchat,
    channel: 'conv-theirs',
    visibility: 'org',
    ownerIdentity: `user:${editor}`
  })
  await seedSessionMeta(prisma, slack, AGENT, {
    daemonId: DAEMON,
    channel: 'C0SUPPORT',
    thread: 'append:1',
    visibility: 'org',
    ownerIdentity: `user:${owner}`
  })
  await seedSessionMeta(prisma, sub, AGENT, {
    ...webchat,
    channel: 'conv-team',
    thread: `${SUBSESSION_COORDINATE_PREFIX}9`,
    ownerIdentity: `user:${owner}`
  })
  const otherAgent = randomUUID()
  // An agent restricted to someone else: its conversations are not the owner's to reach, even one they started.
  await seedAgent(prisma, otherAgent, {
    daemonId: DAEMON,
    runtimeOverrides: { chatActions },
    visibility: 'restricted',
    sharedWith: [editor]
  })
  await seedSessionMeta(prisma, foreign, otherAgent, {
    ...webchat,
    channel: 'conv-mine',
    ownerIdentity: `user:${owner}`
  })
  return { owner, viewer, editor, mine, team, theirs, slack, sub, foreign }
}

const record = (sessionId: string, over: Partial<AgentPermissionRequestRecord> = {}): AgentPermissionRequestRecord => ({
  id: randomUUID(),
  agentId: AGENT,
  sessionId,
  createdAt: '2026-10-09T09:00:00.000Z',
  requesterId: null,
  requesterName: 'Olive',
  command: 'Bash: npm test',
  status: 'pending',
  resolvedAt: null,
  ...over
})

const list = (running: HttpApp, sessionId: string) =>
  running.app.inject({ method: 'GET', url: `${ORG}/sessions/${sessionId}/permission-requests` })
const decide = (running: HttpApp, sessionId: string, body: Record<string, unknown> = { decision: 'allow' }) =>
  running.app.inject({
    method: 'POST',
    url: `${ORG}/sessions/${sessionId}/permission-requests/${REQUEST}/decision`,
    payload: body
  })

describe('a webchat conversation’s approval requests', () => {
  it.each(['approve', 'settings'] as const)(
    'lets its owner who only views list and decide them at %s, bound to the conversation',
    async (level) => {
      const w = await world(level)
      const control = new QueueSpy()
      const own = record(w.mine)
      const fromSubsession = record(w.sub, { parentSessionId: w.mine })
      // A daemon that answers for another conversation is not believed.
      control.requests = [own, fromSubsession, record(w.theirs)]
      const running = app(control, w.owner)

      const listed = await list(running, w.mine)
      expect(listed.statusCode, listed.body).toBe(200)
      expect(listed.json()).toEqual({ requests: [own, fromSubsession] })
      const decided = await decide(running, w.mine, { decision: 'allow', optionId: 'allow-once' })
      expect(decided.statusCode, decided.body).toBe(200)
      expect(decided.json()).toEqual({ ok: true })

      expect(control.lists).toEqual([{ agentId: AGENT, limit: 100, conversation: { sessionId: w.mine } }])
      expect(control.decisions).toEqual([
        {
          agentId: AGENT,
          requestId: REQUEST,
          decision: 'allow',
          optionId: 'allow-once',
          decidedBy: `user:${w.owner}`,
          decidedByName: 'Olive',
          conversation: { sessionId: w.mine }
        }
      ])
    }
  )

  it('keeps them the editors’ alone at talk, and lets an editor answer at any level', async () => {
    const w = await world('talk')
    const control = new QueueSpy()
    for (const res of [await list(app(control, w.owner), w.mine), await decide(app(control, w.owner), w.mine)]) {
      expect(res.statusCode).toBe(403)
      expect(res.json().message).toMatch(/Agent editor/)
    }
    expect(control.lists).toEqual([])
    expect(control.decisions).toEqual([])

    // The editor reads the conversation open to the organization and decides under their own name.
    expect((await list(app(control, w.editor), w.team)).statusCode).toBe(200)
    expect((await decide(app(control, w.editor), w.team, { decision: 'deny' })).statusCode).toBe(200)
    expect(control.decisions).toEqual([
      {
        agentId: AGENT,
        requestId: REQUEST,
        decision: 'deny',
        decidedBy: `user:${w.editor}`,
        decidedByName: 'Grace',
        conversation: { sessionId: w.team }
      }
    ])
  })

  it('refuses anyone else who may view it, and a session that is not one of the agent’s webchat conversations', async () => {
    const w = await world('settings')
    const control = new QueueSpy()
    // A viewer sees the owner’s conversation open to the organization, but neither owns it nor edits the agent.
    for (const res of [await list(app(control, w.viewer), w.team), await decide(app(control, w.viewer), w.team)]) {
      expect(res.statusCode).toBe(403)
      expect(res.json().message).toMatch(/Agent editor or the conversation’s owner/)
    }
    // Nor does the owner of one conversation answer another’s.
    expect((await decide(app(control, w.owner), w.theirs)).statusCode).toBe(403)
    // A private conversation of someone else reads as absent.
    expect((await list(app(control, w.viewer), w.mine)).statusCode).toBe(404)
    // A Slack conversation, a sub-session’s page, a conversation of an agent hidden from them and none at all are not one.
    for (const id of [w.slack, w.sub, w.foreign, randomUUID()]) {
      expect((await list(app(control, w.owner), id)).statusCode).toBe(404)
      expect((await decide(app(control, w.owner), id)).statusCode).toBe(404)
    }
    expect(control.lists).toEqual([])
    expect(control.decisions).toEqual([])
  })

  it('answers a request of another conversation 404, one no longer pending 409, and an unreachable daemon 503', async () => {
    const w = await world('approve')
    const control = new QueueSpy()
    const running = app(control, w.owner)
    control.ack = { ok: false, reason: PERMISSION_REQUEST_NOT_IN_CONVERSATION }
    expect((await decide(running, w.mine)).statusCode).toBe(404)
    control.ack = { ok: false, reason: 'permission request is no longer pending' }
    const gone = await decide(running, w.mine)
    expect(gone.statusCode).toBe(409)
    expect(gone.json().message).toBe('permission request is no longer pending')
    control.failure = new NoConnection(DAEMON)
    expect((await list(running, w.mine)).json()).toMatchObject({ statusCode: 503, code: 'DAEMON_OFFLINE' })
    expect((await decide(running, w.mine)).statusCode).toBe(503)
  })

  it('refuses the conversation’s path on a daemon that could not bind a decision to it', async () => {
    const w = await world('approve', [])
    const control = new QueueSpy()
    for (const res of [await list(app(control, w.owner), w.mine), await decide(app(control, w.owner), w.mine)]) {
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'DAEMON_FEATURE_MISSING' })
    }
    expect(control.lists).toEqual([])
    expect(control.decisions).toEqual([])
  })
})

describe('the session detail names the conversation’s owner', () => {
  it('tells its owner, whatever their role, and no one else', async () => {
    const w = await world('approve')
    const control = new QueueSpy()
    const detail = async (userId: string, sessionId: string) =>
      (await app(control, userId).app.inject({ method: 'GET', url: `${ORG}/sessions/${sessionId}` })).json()
    expect((await detail(w.owner, w.team)).ownsConversation).toBe(true)
    expect((await detail(w.viewer, w.team)).ownsConversation).toBe(false)
    expect((await detail(w.editor, w.team)).ownsConversation).toBe(false)
    // Only a webchat conversation has an owner chat actions name.
    expect((await detail(w.owner, w.slack)).ownsConversation).toBe(false)
  })
})
