// Repository Decision routing on the CP (code-host-decisions.md §3, §7): validation, members, host choice, fences, usages, and evaluations.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import {
  DECISION_EVALUATIONS_V1_FEATURE,
  HOOK_DECISION_ROUTING_V1_FEATURE,
  type DecisionDraft,
  type DecisionEvaluationRecordDetail,
  type DecisionEvaluationRecordPage,
  type DecisionEvaluationRequest,
  type DecisionEvaluationsRequest,
  type HookRoutingProjection,
  type RcHookAssign,
  type RelayCpFrameType
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, TEST_API_KEY_PEPPER, type HttpApp } from '../fakes/build-http.js'
import { GithubService } from '../../src/github/service.js'
import { PgGithubInstallationRepo, PgGithubInstallStateStore } from '../../src/persistence/index.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import type { RelayChannel } from '../../src/ws/relay-registry.js'
import { systemClock } from '../../src/domain/clock.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const EARLY_DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const LATE_DAEMON = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd'
const REPO_ID = 424242
const INSTALLATION = 7654321n
const SCOPE = `${ORG}/decision-routing/github/${REPO_ID}/issues`

const boolDraft: DecisionDraft = {
  name: 'Bug',
  providerId: 'typesafe',
  model: 'jev-1.13.0',
  visibility: 'org',
  sharedWith: [],
  question: { type: 'boolean', instructions: 'Is this a bug report?', criteria: { true: 'Yes', false: 'No' } }
}
const choiceDraft: DecisionDraft = {
  ...boolDraft,
  name: 'Kind',
  question: { type: 'choice', instructions: 'Which kind?', criteria: { bug: 'A bug', question: 'A question' } }
}

const row = {
  seq: 3,
  at: '2026-01-01T00:00:00.000Z',
  messageId: 'issue-comment-1',
  decisionId: 'd-1',
  outcome: 'triggered' as const,
  reason: null,
  answer: { type: 'boolean' as const, value: true, probability: 0.9 },
  matchedKeys: [],
  latencyMs: 80,
  requestedModel: 'jev-1.13.0',
  actualModel: 'jev-1.13.0',
  usage: { inputTokens: 10, outputTokens: 1 },
  detailsExpired: false
}
const page: DecisionEvaluationRecordPage = { items: [row], nextCursor: 3 }
const detail: DecisionEvaluationRecordDetail = {
  ...row,
  snapshot: {
    decisionId: 'd-1',
    providerId: 'typesafe',
    model: 'jev-1.13.0',
    question: boolDraft.question,
    condition: { type: 'boolean', values: [true] },
    sessionMode: 'createNew'
  },
  input: {
    currentMessage: { id: 'm1', sender: { id: 'U1' }, text: 'body', threadId: null },
    history: [],
    historyOmitted: 0,
    context: { partial: false, reasons: [], omittedMessages: 0 }
  },
  fullAnswer: { type: 'boolean', value: true, probability: 0.9 },
  evidence: { snapshotSeq: 3, suppliedBackground: 0 }
}

type Spec = { agentId: string; hookRoutings?: HookRoutingProjection[] }

class SpyControl {
  readonly lists: DecisionEvaluationsRequest[] = []
  readonly gets: DecisionEvaluationRequest[] = []
  readonly specs: Spec[] = []
  async decisionEvaluations(_daemonId: string, _orgId: string, req: DecisionEvaluationsRequest) {
    this.lists.push(req)
    return page
  }
  async decisionEvaluation(_daemonId: string, _orgId: string, req: DecisionEvaluationRequest) {
    this.gets.push(req)
    return { evaluation: detail }
  }
  async agentUpsert(_daemonId: string, u: { spec: Spec }): Promise<void> {
    this.specs.push(u.spec)
  }
  daemonFeatures(): readonly string[] {
    return []
  }
  lastSpec(agentId: string): Spec | undefined {
    return this.specs.filter((s) => s.agentId === agentId).at(-1)
  }
}

class FakeRelay implements RelayChannel {
  sends: { type: RelayCpFrameType; payload: unknown }[] = []
  constructor(
    readonly relayId: string,
    readonly features: readonly string[]
  ) {}
  send(type: RelayCpFrameType, payload: unknown): void {
    this.sends.push({ type, payload })
  }
  close(): void {}
  lastRule(hookId: string): { type: RelayCpFrameType; payload: unknown } | undefined {
    return this.sends.filter((s) => (s.payload as { hookId?: string }).hookId === hookId).at(-1)
  }
}

function stubbedGithub(): GithubService {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const fetchImpl = async (url: string): Promise<Response> => {
    if (url.includes('/access_tokens'))
      return Response.json(
        { token: 'ghs_test', expires_at: new Date(Date.now() + 3600_000).toISOString() },
        { status: 201 }
      )
    if (/\/repos\//.test(url))
      return Response.json({ id: REPO_ID, full_name: 'example-org/example-repo', private: true }, { status: 200 })
    throw new Error(`unexpected github call: ${url}`)
  }
  return new GithubService({
    cfg: { appId: 1, slug: 'example-deployment', jwtIssuer: '1', privateKey },
    clock: systemClock,
    installations: new PgGithubInstallationRepo(prisma),
    installState: new PgGithubInstallStateStore(prisma),
    pepper: TEST_API_KEY_PEPPER,
    fetchImpl
  })
}

let running: HttpApp[] = []
afterEach(async () => {
  for (const app of running) await app.close()
  running = []
})

function appWith(opts: { features?: string[] | null; userId?: string } = {}) {
  const spy = new SpyControl()
  const features =
    opts.features === undefined ? [DECISION_EVALUATIONS_V1_FEATURE, HOOK_DECISION_ROUTING_V1_FEATURE] : opts.features
  const liveness = { get: () => (features ? { state: 'READY', capabilities: { features } } : undefined) }
  const app = buildHttpApp(
    prisma,
    { PUBLIC_RELAY_URL: 'https://relay.example.test', ...(opts.userId ? { DEFAULT_OWNER_ID: opts.userId } : {}) },
    liveness as never,
    spy as unknown as ControlSender,
    { github: stubbedGithub() }
  )
  running.push(app)
  return { app, spy }
}

/** Two agents watching one repository: `early` on the earlier-created daemon, `late` on the later one. */
async function seedWorld(opts: { lateVisibility?: 'org' | 'restricted' } = {}) {
  for (const [id, at] of [
    [EARLY_DAEMON, new Date('2026-01-01T00:00:00Z')],
    [LATE_DAEMON, new Date('2026-02-01T00:00:00Z')]
  ] as const) {
    if (!(await prisma.daemon.findUnique({ where: { id } }))) await seedDaemon(prisma, id)
    await prisma.daemon.update({ where: { id }, data: { createdAt: at } })
  }
  await prisma.relay.create({
    data: {
      id: randomUUID(),
      name: `relay-${randomUUID().slice(0, 8)}`,
      daemonUrl: 'wss://relay-0',
      lastSeenAt: new Date()
    }
  })
  await prisma.githubInstallation.create({
    data: {
      orgId: DEFAULT_ORG_ID,
      installationId: INSTALLATION,
      accountLogin: 'example-org',
      accountType: 'Organization',
      repositorySelection: 'all'
    }
  })
  const late = randomUUID()
  const early = randomUUID()
  const gitRepo = 'https://github.com/example-org/example-repo'
  // The later daemon's agent is created first, so the daemon order, not the agent order, picks the host.
  await seedAgent(prisma, late, {
    daemonId: LATE_DAEMON,
    gitRepo,
    ...(opts.lateVisibility === 'restricted' ? { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] } : {})
  })
  await seedAgent(prisma, early, { daemonId: EARLY_DAEMON, gitRepo })
  return { early, late }
}

async function createHook(app: HttpApp, agentId: string): Promise<string> {
  const res = await app.app.inject({
    method: 'POST',
    url: `${ORG}/hooks`,
    payload: {
      agentId,
      kind: 'github',
      name: 'triage',
      repoFullName: 'example-org/example-repo',
      family: 'issues',
      events: ['issues:opened', 'issue_comment:created'],
      commentFamilies: ['issues']
    }
  })
  expect(res.statusCode).toBe(200)
  return (res.json() as { id: string }).id
}

async function createDecision(app: HttpApp, draft: DecisionDraft = boolDraft): Promise<string> {
  const res = await app.app.inject({ method: 'POST', url: `${ORG}/decisions`, payload: draft })
  expect(res.statusCode).toBe(201)
  return (res.json() as { id: string }).id
}

async function member(role: 'viewer' | 'collaborator') {
  const repo = new PgUserRepo(prisma)
  const email = `${role}-${randomUUID()}@example.test`
  const { userId } = await repo.provisionOidcUser({ oidcSubject: email, email, emailVerified: true })
  await repo.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

const routingOf = (relay: FakeRelay, hookId: string) =>
  (relay.lastRule(hookId)?.payload as RcHookAssign | undefined)?.routing

async function routedWorld() {
  const world = await seedWorld()
  const { app, spy } = appWith()
  const relay = new FakeRelay('relay-new', [HOOK_DECISION_ROUTING_V1_FEATURE])
  app.relayReg.add(relay)
  const earlyHook = await createHook(app, world.early)
  const lateHook = await createHook(app, world.late)
  const decisionId = await createDecision(app)
  const config = {
    enabled: true,
    decisionId,
    rules: [{ id: 'r1', when: { type: 'boolean', values: [true] }, action: { type: 'agent', agentId: world.late } }],
    otherwise: { type: 'skip' }
  }
  return { ...world, app, spy, relay, earlyHook, lateHook, decisionId, config }
}

describe('repository Decision routing — configuration', () => {
  it('lists the members before any routing exists, and 404s a repository nobody watches', async () => {
    const world = await seedWorld()
    const { app } = appWith()
    const earlyHook = await createHook(app, world.early)
    const res = await app.app.inject({ method: 'GET', url: SCOPE })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      repoId: String(REPO_ID),
      repoFullName: 'example-org/example-repo',
      family: 'issues',
      config: null,
      status: null,
      members: [{ agentId: world.early, hookId: earlyHook, name: expect.any(String) }],
      evaluationAgentId: null
    })
    expect((await app.app.inject({ method: 'GET', url: `${ORG}/decision-routing/github/999/issues` })).statusCode).toBe(
      404
    )
    expect(
      (await app.app.inject({ method: 'GET', url: `${ORG}/decision-routing/github/${REPO_ID}/pull_request` }))
        .statusCode
    ).toBe(404)
  })

  it('saves a routing, hosts it on the earliest daemon, stamps every scope rule, and projects the host', async () => {
    const w = await routedWorld()
    const hostRevision = (await prisma.agent.findUniqueOrThrow({ where: { id: w.early } })).configRevision
    const saved = await w.app.app.inject({ method: 'PUT', url: SCOPE, payload: { config: w.config } })
    expect(saved.statusCode).toBe(200)
    expect(saved.json()).toMatchObject({ config: w.config, status: 'enabled', evaluationAgentId: w.early })
    const routingId = (await prisma.codeHostDecisionRouting.findFirstOrThrow()).id
    const expected = {
      routingId,
      decisionId: w.decisionId,
      evaluationAgentId: w.early,
      evaluationDaemonId: EARLY_DAEMON
    }
    await vi.waitFor(() => {
      expect(routingOf(w.relay, w.earlyHook)).toEqual(expected)
      expect(routingOf(w.relay, w.lateHook)).toEqual(expected)
    })
    expect(w.spy.lastSpec(w.early)?.hookRoutings).toEqual([
      expect.objectContaining({
        routingId,
        repoId: String(REPO_ID),
        family: 'issues',
        config: w.config,
        definition: expect.objectContaining({ id: w.decisionId }),
        members: expect.arrayContaining([
          { agentId: w.early, hookId: w.earlyHook },
          { agentId: w.late, hookId: w.lateHook }
        ])
      })
    ])
    expect(w.spy.lastSpec(w.late)?.hookRoutings ?? []).toEqual([])
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: w.early } })).configRevision).toBeGreaterThan(
      hostRevision
    )
    // A relay without the feature never holds the routed rules.
    const older = new FakeRelay('relay-old', [])
    await w.app.deps.hooks.replayTo(older)
    expect(older.sends).toEqual([])
  })

  it('refuses a non-member target, an invisible Decision, and enabling behind an older relay', async () => {
    const w = await routedWorld()
    const stranger = randomUUID()
    const bad = await w.app.app.inject({
      method: 'PUT',
      url: SCOPE,
      payload: {
        config: {
          ...w.config,
          rules: [{ id: 'r1', when: { type: 'boolean', values: [true] }, action: { type: 'agent', agentId: stranger } }]
        }
      }
    })
    expect(bad.statusCode).toBe(400)
    expect((bad.json() as { issues: unknown[] }).issues).toContainEqual(
      expect.objectContaining({ path: ['rules', 0, 'action'] })
    )
    const missing = await w.app.app.inject({
      method: 'PUT',
      url: SCOPE,
      payload: { config: { ...w.config, decisionId: randomUUID() } }
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toMatchObject({ code: 'DECISION_NOT_FOUND' })
    w.app.relayReg.add(new FakeRelay('relay-old', []))
    const held = await w.app.app.inject({ method: 'PUT', url: SCOPE, payload: { config: w.config } })
    expect(held.statusCode).toBe(409)
    expect(held.json()).toMatchObject({ code: 'DECISION_UNSUPPORTED_CONSUMER' })
    expect(await prisma.codeHostDecisionRouting.count()).toBe(0)
  })

  it('pauses to unrouted rules and deletes back to them, clearing the host projection', async () => {
    const w = await routedWorld()
    expect((await w.app.app.inject({ method: 'PUT', url: SCOPE, payload: { config: w.config } })).statusCode).toBe(200)
    await vi.waitFor(() => expect(routingOf(w.relay, w.lateHook)).toBeDefined())
    const paused = await w.app.app.inject({
      method: 'PUT',
      url: SCOPE,
      payload: { config: { ...w.config, enabled: false } }
    })
    expect(paused.statusCode).toBe(200)
    await vi.waitFor(() => expect(routingOf(w.relay, w.lateHook)).toBeUndefined())
    expect(w.spy.lastSpec(w.early)?.hookRoutings).toEqual([])

    expect((await w.app.app.inject({ method: 'PUT', url: SCOPE, payload: { config: w.config } })).statusCode).toBe(200)
    await vi.waitFor(() => expect(routingOf(w.relay, w.lateHook)).toBeDefined())
    const removed = await w.app.app.inject({ method: 'DELETE', url: SCOPE })
    expect(removed.statusCode).toBe(204)
    await vi.waitFor(() => {
      expect(routingOf(w.relay, w.lateHook)).toBeUndefined()
      expect(routingOf(w.relay, w.earlyHook)).toBeUndefined()
    })
    expect(w.spy.lastSpec(w.early)?.hookRoutings).toEqual([])
    expect((await w.app.app.inject({ method: 'GET', url: SCOPE })).json()).toMatchObject({ config: null, status: null })
  })

  it('moves the host when its trigger leaves the scope', async () => {
    const w = await routedWorld()
    const lateOnly = {
      ...w.config,
      rules: []
    }
    expect((await w.app.app.inject({ method: 'PUT', url: SCOPE, payload: { config: lateOnly } })).statusCode).toBe(200)
    await vi.waitFor(() => expect(routingOf(w.relay, w.lateHook)?.evaluationAgentId).toBe(w.early))
    const removed = await w.app.app.inject({ method: 'DELETE', url: `${ORG}/hooks/${w.earlyHook}` })
    expect(removed.statusCode).toBe(204)
    await vi.waitFor(() => expect(routingOf(w.relay, w.lateHook)?.evaluationAgentId).toBe(w.late))
    expect((await prisma.codeHostDecisionRouting.findFirstOrThrow()).evaluationAgentId).toBe(w.late)
    await vi.waitFor(() =>
      expect(w.spy.lastSpec(w.late)?.hookRoutings?.[0]?.members).toEqual([{ agentId: w.late, hookId: w.lateHook }])
    )
    expect(w.spy.lastSpec(w.early)?.hookRoutings ?? []).toEqual([])
  })

  it('marks the routing Needs review after an incompatible Decision edit, holds it, and protects the Decision', async () => {
    const w = await routedWorld()
    const decisionId = await createDecision(w.app, choiceDraft)
    const config = {
      enabled: true,
      decisionId,
      rules: [
        { id: 'r1', when: { type: 'choice', thresholds: { bug: 0.5 } }, action: { type: 'agent', agentId: w.late } }
      ],
      otherwise: { type: 'default_agent' }
    }
    expect((await w.app.app.inject({ method: 'PUT', url: SCOPE, payload: { config } })).statusCode).toBe(200)

    const usage = await w.app.app.inject({ method: 'GET', url: `${ORG}/decisions/${decisionId}` })
    const routingId = (await prisma.codeHostDecisionRouting.findFirstOrThrow()).id
    expect((usage.json() as { usages: unknown[] }).usages).toContainEqual({
      kind: 'code_host_routing',
      id: routingId,
      label: 'example-org/example-repo · issues',
      repoId: String(REPO_ID),
      family: 'issues'
    })

    const revision = (await prisma.agent.findUniqueOrThrow({ where: { id: w.early } })).configRevision
    const edited = await w.app.app.inject({
      method: 'PATCH',
      url: `${ORG}/decisions/${decisionId}`,
      payload: {
        ...choiceDraft,
        question: { type: 'choice', instructions: 'Which kind?', criteria: { feature: 'A feature', question: 'Q' } }
      }
    })
    expect(edited.statusCode).toBe(200)
    expect((await w.app.app.inject({ method: 'GET', url: SCOPE })).json()).toMatchObject({ status: 'needs_review' })
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: w.early } })).configRevision).toBeGreaterThan(revision)
    // Held, not unrouted: the rules still name the routing and the host's copy is disabled.
    await vi.waitFor(() => expect(w.spy.lastSpec(w.early)?.hookRoutings?.[0]?.config.enabled).toBe(false))
    expect(routingOf(w.relay, w.lateHook)?.routingId).toBe(routingId)

    const refused = await w.app.app.inject({ method: 'DELETE', url: `${ORG}/decisions/${decisionId}` })
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({ usages: [expect.objectContaining({ kind: 'code_host_routing' })] })
    expect(await prisma.decision.count({ where: { id: decisionId } })).toBe(1)
  })
})

describe('repository Decision routing — authorization', () => {
  it('refuses a viewer write and a collaborator who cannot edit every member', async () => {
    const world = await seedWorld({ lateVisibility: 'restricted' })
    const owner = appWith()
    owner.app.relayReg.add(new FakeRelay('relay-new', [HOOK_DECISION_ROUTING_V1_FEATURE]))
    await createHook(owner.app, world.early)
    await createHook(owner.app, world.late)
    const decisionId = await createDecision(owner.app)
    const config = { enabled: true, decisionId, rules: [], otherwise: { type: 'default_agent' } }

    const viewer = appWith({ userId: await member('viewer') })
    expect((await viewer.app.app.inject({ method: 'PUT', url: SCOPE, payload: { config } })).statusCode).toBe(403)

    const collaborator = appWith({ userId: await member('collaborator') })
    const read = await collaborator.app.app.inject({ method: 'GET', url: SCOPE })
    expect(read.statusCode).toBe(200)
    // The restricted member is listed as a target id, without its name.
    expect((read.json() as { members: Array<{ agentId: string; name: string | null }> }).members).toContainEqual(
      expect.objectContaining({ agentId: world.late, name: null })
    )
    const write = await collaborator.app.app.inject({ method: 'PUT', url: SCOPE, payload: { config } })
    expect(write.statusCode).toBe(403)
    expect(await prisma.codeHostDecisionRouting.count()).toBe(0)
  })
})

describe('repository Decision routing — Recent evaluations', () => {
  it('proxies the routing lane to the host with source hook_routing', async () => {
    const w = await routedWorld()
    expect((await w.app.app.inject({ method: 'PUT', url: SCOPE, payload: { config: w.config } })).statusCode).toBe(200)
    const routingId = (await prisma.codeHostDecisionRouting.findFirstOrThrow()).id
    const list = await w.app.app.inject({ method: 'GET', url: `${SCOPE}/evaluations?limit=5` })
    expect(list.statusCode).toBe(200)
    expect(list.json()).toEqual(page)
    expect(w.spy.lists).toEqual([
      { agentId: w.early, integrationId: routingId, channel: routingId, source: 'hook_routing', limit: 5 }
    ])
    const one = await w.app.app.inject({ method: 'GET', url: `${SCOPE}/evaluations/3` })
    expect(one.statusCode).toBe(200)
    expect(one.json()).toEqual(detail)
    expect(w.spy.gets).toEqual([
      { agentId: w.early, integrationId: routingId, channel: routingId, source: 'hook_routing', seq: 3 }
    ])

    const viewer = appWith({ userId: await member('viewer') })
    expect((await viewer.app.app.inject({ method: 'GET', url: `${SCOPE}/evaluations` })).statusCode).toBe(200)
    expect((await viewer.app.app.inject({ method: 'GET', url: `${SCOPE}/evaluations/3` })).statusCode).toBe(403)
    expect(viewer.spy.gets).toEqual([])
  })

  it('503s when the host daemon is offline or cannot read routing lanes, and 404s without a routing', async () => {
    const w = await routedWorld()
    expect((await w.app.app.inject({ method: 'GET', url: `${SCOPE}/evaluations` })).statusCode).toBe(404)
    expect((await w.app.app.inject({ method: 'PUT', url: SCOPE, payload: { config: w.config } })).statusCode).toBe(200)
    const offline = appWith({ features: null })
    const res = await offline.app.app.inject({ method: 'GET', url: `${SCOPE}/evaluations` })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ code: 'DAEMON_OFFLINE' })
    const older = appWith({ features: [DECISION_EVALUATIONS_V1_FEATURE] })
    const upgrade = await older.app.app.inject({ method: 'GET', url: `${SCOPE}/evaluations/3` })
    expect(upgrade.statusCode).toBe(503)
    expect(upgrade.json()).toMatchObject({ code: 'DAEMON_UPGRADE_REQUIRED' })
    expect(older.spy.gets).toEqual([])
  })
})
