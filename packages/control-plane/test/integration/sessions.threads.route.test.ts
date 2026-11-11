/** The thread reads (webchat-threads.md §8): `GET /sessions/:id/messages?view=roots` and `GET /sessions/:id/threads/:rootId/messages`, authorized by §7.1. */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent, DEFAULT_DAEMON_CAPABILITIES } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { NoConnection, type ControlSender } from '../../src/orchestrator/outbound.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import type { DaemonLiveness } from '../../src/ports.js'
import {
  SESSION_THREAD_READS_FEATURE,
  TRANSCRIPT_IMAGE_MAX_COUNT,
  type SessionHistoryPage,
  type SessionHistoryReq,
  type SessionThreadPage,
  type SessionThreadReq,
  type SessionThreadSummary
} from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd0d0d0d0-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_AGENT = 'a1a1a1a1-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CONV = '0c0c0c0c-cccc-4ccc-8ccc-cccccccccccc'
const COORDINATOR = '50505050-5555-4555-8555-555555555555'
const SHARED_TASK = '51515151-5555-4555-8555-555555555555'
const PRIVATE_TASK = '52525252-5555-4555-8555-555555555555'
const FOREIGN_TASK = '53535353-5555-4555-8555-555555555555'
const ROOT_UNOWNED = '60606060-6666-4666-8666-666666666661'
const ROOT_SHARED = '60606060-6666-4666-8666-666666666662'
const ROOT_PRIVATE = '60606060-6666-4666-8666-666666666663'
const ROOT_FOREIGN = '60606060-6666-4666-8666-666666666664'
const ROOT_UNSTARTED = '60606060-6666-4666-8666-666666666665'

const LIVE: DaemonLiveness = {
  get: (id) => (id === DAEMON ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined)
}

const footer = (rootId: string, task?: SessionThreadSummary['task']): SessionThreadSummary => ({
  rootId,
  rootExcerpt: `root ${rootId}`,
  replies: 2,
  lastReplyAt: '2026-11-06T10:00:00.000Z',
  lastReply: { sender: AGENT, senderName: 'Ada', excerpt: `reply in ${rootId}` },
  // The platform's picture rides a footer's author as its name does.
  participants: [{ sender: AGENT, senderName: 'Ada', senderAvatarUrl: 'https://avatars.example.test/ada.png' }],
  ...(task ? { task } : {})
})

const THREADS: SessionThreadSummary[] = [
  footer(ROOT_UNOWNED),
  footer(ROOT_SHARED, { sessionId: SHARED_TASK, title: 'Shared task', state: 'open' }),
  footer(ROOT_PRIVATE, { sessionId: PRIVATE_TASK, title: 'Private task', state: 'done' }),
  footer(ROOT_FOREIGN, { sessionId: FOREIGN_TASK, title: 'Foreign task', state: 'open' }),
  footer(ROOT_UNSTARTED, { title: 'Not started', state: 'open' })
]

const ROOTS_PAGE: SessionHistoryPage = {
  sessionId: COORDINATOR,
  messages: [
    { seq: 1, sender: 'user:owner', ts: '1', kind: 'text', text: 'hello', postId: ROOT_UNOWNED },
    { seq: 2, sender: AGENT, ts: '2', kind: 'text', text: 'answering a reply', thread: ROOT_UNOWNED },
    { seq: 4, sender: 'user:owner', ts: '4', kind: 'text', text: 'also this', handedTo: ROOT_SHARED }
  ],
  nextCursor: 'c-1',
  liveCursor: '9',
  threads: THREADS
}

const threadPage = (rootId: string): SessionThreadPage => {
  const summary = THREADS.find((t) => t.rootId === rootId)
  return {
    sessionId: COORDINATOR,
    rootId,
    messages: summary
      ? [
          { seq: 3, sender: 'user:owner', ts: '3', kind: 'text', text: `in ${rootId}` },
          { seq: 4, sender: 'user:owner', ts: '4', kind: 'text', text: 'handed here', handedTo: rootId }
        ]
      : [],
    ...(summary ? { nextCursor: 'tc-1', liveCursor: '12', liveMore: true, summary } : {})
  }
}

class SpyControl {
  histCalls: Array<{ daemonId: string; req: SessionHistoryReq }> = []
  threadCalls: Array<{ daemonId: string; orgId: string; req: SessionThreadReq }> = []
  constructor(private readonly offline = false) {}
  async sessionHistory(daemonId: string, _orgId: string, req: SessionHistoryReq): Promise<SessionHistoryPage> {
    this.histCalls.push({ daemonId, req })
    if (this.offline) throw new NoConnection(daemonId)
    return req.view === 'roots' ? ROOTS_PAGE : { sessionId: COORDINATOR, messages: [] }
  }
  async sessionThread(daemonId: string, orgId: string, req: SessionThreadReq): Promise<SessionThreadPage> {
    this.threadCalls.push({ daemonId, orgId, req })
    if (this.offline) throw new NoConnection(daemonId)
    return threadPage(req.rootId)
  }
}

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

const session = (id: string, agentId: string, extra: Record<string, unknown> = {}) =>
  prisma.sessionMeta.create({
    data: {
      id,
      agentId,
      daemonId: DAEMON,
      orgId: DEFAULT_ORG_ID,
      platform: 'webchat',
      channel: CONV,
      phase: 'start',
      lastActivityAt: new Date('2026-11-06T10:00:00.000Z'),
      ...extra
    }
  })

/** A coordinator and its tasks; returns a collaborator who may view the coordinator and the shared task, not the private one. */
async function seed(features: string[] = [SESSION_THREAD_READS_FEATURE]): Promise<string> {
  await seedDaemon(prisma, DAEMON, { capabilities: { ...DEFAULT_DAEMON_CAPABILITIES, features } })
  await seedAgent(prisma, AGENT, { daemonId: DAEMON })
  await seedAgent(prisma, OTHER_AGENT, { daemonId: DAEMON })
  await session(COORDINATOR, AGENT, { thread: `append:webchat:${CONV}` })
  await session(SHARED_TASK, AGENT, { thread: ROOT_SHARED, taskParentSessionId: COORDINATOR })
  await session(PRIVATE_TASK, AGENT, {
    thread: ROOT_PRIVATE,
    taskParentSessionId: COORDINATOR,
    visibility: 'private',
    ownerIdentity: `user:${randomUUID()}`
  })
  await session(FOREIGN_TASK, OTHER_AGENT, { thread: ROOT_FOREIGN })
  const users = new PgUserRepo(prisma)
  const email = `threads-viewer-${randomUUID()}@acme.dev`
  const { userId } = await users.provisionOidcUser({
    oidcSubject: `threads-viewer-${randomUUID()}`,
    email,
    emailVerified: true
  })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, 'collaborator')
  return userId
}

function app(viewer: string, spy: SpyControl): HttpApp {
  return buildHttpApp(prisma, { DEFAULT_OWNER_ID: viewer }, LIVE, spy as unknown as ControlSender)
}

type FooterBody = SessionThreadSummary & { readable: boolean }

describe('GET /sessions/:id/messages?view=roots', () => {
  it('asks for the roots view, keeps each row’s thread and handed thread, and leaves the content out of footers whose task the caller may not view', async () => {
    const viewer = await seed()
    const spy = new SpyControl()
    running = app(viewer, spy)
    const res = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions/${COORDINATOR}/messages?view=roots&after=4&limit=20`
    })
    expect(res.statusCode).toBe(200)
    expect(spy.histCalls).toEqual([
      {
        daemonId: DAEMON,
        req: {
          agentId: AGENT,
          sessionId: COORDINATOR,
          after: '4',
          limit: 20,
          imagesPerMessage: TRANSCRIPT_IMAGE_MAX_COUNT,
          view: 'roots'
        }
      }
    ])
    const body = res.json() as {
      messages: Array<{ thread?: string; handedTo?: string }>
      threads: FooterBody[]
      nextCursor: string
    }
    expect(body.nextCursor).toBe('c-1')
    expect(body.messages.map((m) => [m.thread, m.handedTo])).toEqual([
      [undefined, undefined],
      [ROOT_UNOWNED, undefined],
      [undefined, ROOT_SHARED]
    ])
    const byRoot = new Map(body.threads.map((t) => [t.rootId, t]))
    expect(byRoot.get(ROOT_UNOWNED)).toEqual({ ...footer(ROOT_UNOWNED), readable: true })
    expect(byRoot.get(ROOT_SHARED)).toEqual({ ...THREADS[1], readable: true })
    for (const [rootId, state] of [
      [ROOT_PRIVATE, 'done'],
      [ROOT_FOREIGN, 'open'],
      [ROOT_UNSTARTED, 'open']
    ] as const) {
      const hidden = byRoot.get(rootId)!
      expect(hidden).toMatchObject({ rootId, replies: 2, readable: false, task: { state } })
      expect(hidden.rootExcerpt).toBeUndefined()
      expect(hidden.lastReply).toEqual({ sender: AGENT, senderName: 'Ada' })
      expect(hidden.task?.title).toBeUndefined()
    }
    // Only a task with no session row yet is starting; a private or another agent's task is withheld.
    expect(byRoot.get(ROOT_UNSTARTED)!.task).toEqual({ state: 'open', starting: true })
    expect(byRoot.get(ROOT_PRIVATE)!.task).not.toHaveProperty('starting')
    expect(byRoot.get(ROOT_FOREIGN)!.task).not.toHaveProperty('starting')
  })

  it('keeps the flat view as it was, and never sends the roots view to a daemon without thread reads', async () => {
    const viewer = await seed([])
    const spy = new SpyControl()
    running = app(viewer, spy)
    const flat = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${COORDINATOR}/messages` })
    expect(flat.statusCode).toBe(200)
    expect(flat.json()).not.toHaveProperty('threads')
    const roots = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${COORDINATOR}/messages?view=roots` })
    expect(roots.statusCode).toBe(409)
    expect(roots.json()).toMatchObject({ code: 'DAEMON_FEATURE_MISSING' })
    expect(spy.histCalls.map((c) => c.req.view)).toEqual([undefined])
    const bad = await running.app.inject({ method: 'GET', url: `${ORG}/sessions/${COORDINATOR}/messages?view=threads` })
    expect(bad.statusCode).toBe(400)
  })
})

describe('GET /sessions/:id/threads/:rootId/messages', () => {
  it('proxies an unowned thread and one whose task the caller may view, with their footers', async () => {
    const viewer = await seed()
    const spy = new SpyControl()
    running = app(viewer, spy)
    const res = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions/${COORDINATOR}/threads/${ROOT_UNOWNED}/messages?cursor=tc-9&limit=10`
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      sessionId: COORDINATOR,
      rootId: ROOT_UNOWNED,
      messages: [
        { seq: 3, sender: 'user:owner', ts: '3', kind: 'text', text: `in ${ROOT_UNOWNED}` },
        { seq: 4, sender: 'user:owner', ts: '4', kind: 'text', text: 'handed here', handedTo: ROOT_UNOWNED }
      ],
      nextCursor: 'tc-1',
      liveCursor: '12',
      liveMore: true,
      summary: { ...footer(ROOT_UNOWNED), readable: true }
    })
    expect(spy.threadCalls).toEqual([
      {
        daemonId: DAEMON,
        orgId: DEFAULT_ORG_ID,
        req: {
          agentId: AGENT,
          sessionId: COORDINATOR,
          rootId: ROOT_UNOWNED,
          cursor: 'tc-9',
          limit: 10,
          imagesPerMessage: TRANSCRIPT_IMAGE_MAX_COUNT
        }
      }
    ])
    const shared = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions/${COORDINATOR}/threads/${ROOT_SHARED}/messages?after=12`
    })
    expect(shared.statusCode).toBe(200)
    expect(shared.json()).toMatchObject({
      messages: [{ seq: 3 }, { seq: 4, handedTo: ROOT_SHARED }],
      summary: { readable: true, task: { title: 'Shared task' } }
    })
    expect(spy.threadCalls[1]!.req).toEqual({
      agentId: AGENT,
      sessionId: COORDINATOR,
      rootId: ROOT_SHARED,
      after: '12',
      limit: 50,
      imagesPerMessage: TRANSCRIPT_IMAGE_MAX_COUNT
    })
  })

  it('gives a thread whose task the caller may not view its footer without content and no messages', async () => {
    const viewer = await seed()
    running = app(viewer, new SpyControl())
    for (const rootId of [ROOT_PRIVATE, ROOT_FOREIGN, ROOT_UNSTARTED]) {
      const res = await running.app.inject({
        method: 'GET',
        url: `${ORG}/sessions/${COORDINATOR}/threads/${rootId}/messages`
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { messages: unknown[]; nextCursor: null; liveCursor: null; summary: FooterBody }
      expect(body).toMatchObject({ messages: [], nextCursor: null, liveCursor: null, liveMore: false })
      expect(body.summary).toMatchObject({ rootId, replies: 2, readable: false })
      expect(body.summary.rootExcerpt).toBeUndefined()
      expect(body.summary.lastReply?.excerpt).toBeUndefined()
      expect(body.summary.task?.title).toBeUndefined()
    }
  })

  it('404s a root the session never received, a session the caller may not view, and a purged session', async () => {
    const viewer = await seed()
    const spy = new SpyControl()
    running = app(viewer, spy)
    const unknown = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions/${COORDINATOR}/threads/${randomUUID()}/messages`
    })
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json()).toMatchObject({ message: 'thread not found' })

    const hidden = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions/${PRIVATE_TASK}/threads/${ROOT_PRIVATE}/messages`
    })
    expect(hidden.statusCode).toBe(404)
    expect(spy.threadCalls.map((c) => c.req.sessionId)).toEqual([COORDINATOR])

    await prisma.sessionMeta.update({ where: { id: COORDINATOR }, data: { contentPurgedAt: new Date() } })
    const purged = await running.app.inject({
      method: 'GET',
      url: `${ORG}/sessions/${COORDINATOR}/threads/${ROOT_UNOWNED}/messages`
    })
    expect(purged.statusCode).toBe(404)
    expect(spy.threadCalls).toHaveLength(1)
  })

  it('409s a daemon without thread reads before sending the frame, and 503s an unreachable one', async () => {
    const viewer = await seed([])
    const spy = new SpyControl()
    running = app(viewer, spy)
    const url = `${ORG}/sessions/${COORDINATOR}/threads/${ROOT_UNOWNED}/messages`
    const missing = await running.app.inject({ method: 'GET', url })
    expect(missing.statusCode).toBe(409)
    expect(missing.json()).toMatchObject({ code: 'DAEMON_FEATURE_MISSING' })
    expect(spy.threadCalls).toEqual([])
    await running.close()

    await prisma.daemon.update({
      where: { id: DAEMON },
      data: { capabilities: { ...DEFAULT_DAEMON_CAPABILITIES, features: [SESSION_THREAD_READS_FEATURE] } }
    })
    running = app(viewer, new SpyControl(true))
    expect((await running.app.inject({ method: 'GET', url })).statusCode).toBe(503)
  })
})
