/**
 * Inbound-webhook trigger CRUD over the C2 REST surface
 * (webhook-triggers-and-github-events.md). Covered:
 *
 *  - creation is GATED on a reachable ingress — no `PUBLIC_RELAY_URL` or no live
 *    relay ⇒ 409 (mirrors the shared-bot "no live relay" gate);
 *  - the create response echoes the one-time signing secret + the full ingress
 *    URL (relay-pool origin), and the secret NEVER appears on any later read;
 *  - hooks are agent-scoped: `GET /agents/:agentId/hooks` lists one agent's hooks
 *    (gated by the agent's visibility — no org-wide hook list, no per-hook
 *    visibility of its own; it inherits the agent's, like an Integration);
 *  - `agentId` must reference a visible agent in the org (400);
 *  - `GET /hooks/:id/runs` returns the bookkeeping history, newest first;
 *  - each write appends a `hook_change` audit row.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent } from '../fixtures/seed.js'
import { buildHttpApp, TEST_API_KEY_PEPPER, type HttpApp } from '../fakes/build-http.js'
import { GithubService } from '../../src/github/service.js'
import { PgGithubInstallationRepo, PgGithubInstallStateStore } from '../../src/persistence/index.js'
import { systemClock } from '../../src/domain/clock.js'
import { AgentId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const RELAY_URL = 'https://relay.test'
const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

/** A live relay row so the create gate ("a relay is registered") passes. */
async function seedRelay(): Promise<void> {
  await prisma.relay.create({
    data: {
      id: randomUUID(),
      name: `relay-${randomUUID().slice(0, 8)}`,
      daemonUrl: 'wss://relay-0',
      lastSeenAt: new Date()
    }
  })
}

/** An app with the ingress configured (PUBLIC_RELAY_URL) — most tests need it. */
function app(): HttpApp {
  running = buildHttpApp(prisma, { PUBLIC_RELAY_URL: RELAY_URL })
  return running
}

const body = (agentId: string, over: Record<string, unknown> = {}) => ({
  agentId,
  kind: 'webhook',
  name: 'ci-webhook',
  hmac: true,
  ...over
})

async function placedAgent(): Promise<string> {
  await seedDaemon(prisma, DAEMON)
  const agentId = randomUUID()
  await seedAgent(prisma, agentId, { daemonId: DAEMON })
  return agentId
}

describe('hooks REST — CRUD, ingress gating, secret echo, runs, audit', () => {
  it('POST /hooks creates a hook, echoes the one-time secret + ingress URL', async () => {
    const agentId = await placedAgent()
    await seedRelay()
    const a = app()

    const res = await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: body(agentId) })
    expect(res.statusCode).toBe(200)
    const dto = res.json() as { id: string; url: string | null; hmacSecret: string | null; hmacConfigured: boolean }
    expect(dto.url).toMatch(new RegExp(`^${RELAY_URL}/webhooks/in/whk_[0-9a-f]{32}$`))
    expect(dto.hmacSecret).toMatch(/^whsec_[0-9a-f]{64}$/)
    expect(dto.hmacConfigured).toBe(true)

    // The secret is NEVER returned again (GET omits it; the row keeps only presence).
    const get = await a.app.inject({ method: 'GET', url: `${ORG}/hooks/${dto.id}` })
    const read = get.json() as Record<string, unknown>
    expect('hmacSecret' in read).toBe(false)
    expect(read.hmacConfigured).toBe(true)
    expect(read.url).toBe(dto.url) // capability URL still surfaced to an editor
  })

  it('GET /agents/:agentId/hooks lists that agent’s hooks; unknown/cross-agent → 404', async () => {
    const agentId = await placedAgent()
    await seedRelay()
    const a = app()
    const other = randomUUID()
    await seedAgent(prisma, other, { daemonId: DAEMON })

    // Two hooks on `agentId`, one on `other` — the list is scoped to the agent.
    await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: body(agentId, { name: 'a1' }) })
    await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: body(agentId, { name: 'a2' }) })
    await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: body(other, { name: 'b1' }) })

    const res = await a.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}/hooks` })
    expect(res.statusCode).toBe(200)
    const rows = res.json() as Array<{ name: string; agentId: string }>
    expect(rows.map((r) => r.name).sort()).toEqual(['a1', 'a2'])
    expect(rows.every((r) => r.agentId === agentId)).toBe(true)

    // An agent that doesn't exist in the org reads 404 (the visibility gate's
    // negative branch — same shape as an agent the caller can't see).
    expect((await a.app.inject({ method: 'GET', url: `${ORG}/agents/${randomUUID()}/hooks` })).statusCode).toBe(404)
  })

  it('a hook created without hmac has no secret echo', async () => {
    const agentId = await placedAgent()
    await seedRelay()
    const res = await app().app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: body(agentId, { hmac: false }) })
    const dto = res.json() as { hmacSecret: string | null; hmacConfigured: boolean }
    expect(dto.hmacSecret).toBeNull()
    expect(dto.hmacConfigured).toBe(false)
  })

  it('refuses creation with 409 when the ingress is unavailable (no relay / no PUBLIC_RELAY_URL)', async () => {
    const agentId = await placedAgent()
    // (a) PUBLIC_RELAY_URL set but NO relay registered.
    const gated = await app().app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: body(agentId) })
    expect(gated.statusCode).toBe(409)
    await running!.close()

    // (b) A relay is live but PUBLIC_RELAY_URL is unset.
    await seedRelay()
    running = buildHttpApp(prisma) // no PUBLIC_RELAY_URL
    const noUrl = await running.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: body(agentId) })
    expect(noUrl.statusCode).toBe(409)

    expect(await prisma.hookDef.count()).toBe(0) // nothing persisted either way
  })

  it('rejects an unknown agentId (400) — nothing persisted', async () => {
    await seedRelay()
    const res = await app().app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: body(randomUUID()) })
    expect(res.statusCode).toBe(400)
    expect(await prisma.hookDef.count()).toBe(0)
  })

  it('PUT /hooks/:id still accepts the P1 contract (no kind field) for webhook hooks', async () => {
    // The published OpenAPI spec for PUT had no `kind` — the discriminated
    // update body must not 400 yesterday's valid client.
    const agentId = await placedAgent()
    await seedRelay()
    const a = app()
    const { id, url } = (
      await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: body(agentId) })
    ).json() as {
      id: string
      url: string
    }
    const put = await a.app.inject({
      method: 'PUT',
      url: `${ORG}/hooks/${id}`,
      payload: { agentId, name: 'renamed', sessionMode: 'shared', enabled: false }
    })
    expect(put.statusCode).toBe(200)
    expect(put.json()).toMatchObject({ kind: 'webhook', name: 'renamed', sessionMode: 'shared', enabled: false, url })
  })

  it('DELETE /hooks/:id removes it (cascading secret + runs); unknown id → 404', async () => {
    const agentId = await placedAgent()
    await seedRelay()
    const a = app()
    const { id } = (await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: body(agentId) })).json() as {
      id: string
    }

    const del = await a.app.inject({ method: 'DELETE', url: `${ORG}/hooks/${id}` })
    expect(del.statusCode).toBe(204)
    expect(await prisma.hookDef.findUnique({ where: { id } })).toBeNull()
    expect(await prisma.hookSecret.findUnique({ where: { hookId: id } })).toBeNull()

    expect((await a.app.inject({ method: 'DELETE', url: `${ORG}/hooks/${id}` })).statusCode).toBe(404)
  })

  it('GET /hooks/:id/runs returns bookkeeping history, newest first; unknown → 404', async () => {
    const agentId = await placedAgent()
    await seedRelay()
    const a = app()
    const { id } = (await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: body(agentId) })).json() as {
      id: string
    }
    await prisma.hookRun.createMany({
      data: [
        {
          hookId: id,
          orgId: DEFAULT_ORG_ID,
          deliveryKey: 'd-1',
          startedAt: new Date('2026-07-01T09:00:00Z'),
          status: 'success',
          durationMs: 3100,
          sessionId: 'ses_1'
        },
        {
          hookId: id,
          orgId: DEFAULT_ORG_ID,
          deliveryKey: 'd-2',
          startedAt: new Date('2026-07-02T09:00:00Z'),
          status: 'failed',
          reason: 'daemon_offline',
          redeliveryAttempts: 2,
          redeliveryLastRequestedAt: new Date('2026-07-02T09:01:00Z')
        }
      ]
    })
    const res = await a.app.inject({ method: 'GET', url: `${ORG}/hooks/${id}/runs` })
    expect(res.statusCode).toBe(200)
    const runs = res.json() as Array<{
      status: string
      sessionId: string | null
      reason: string | null
      redeliveryAttempts: number
      redeliveryLastRequestedAt: string | null
    }>
    expect(runs.map((r) => r.status)).toEqual(['failed', 'success'])
    expect(runs[0]).toMatchObject({
      redeliveryAttempts: 2,
      redeliveryLastRequestedAt: '2026-07-02T09:01:00.000Z'
    })
    expect(runs[1]).toMatchObject({ sessionId: 'ses_1', reason: null })
    expect(runs[1]).toMatchObject({ redeliveryAttempts: 0, redeliveryLastRequestedAt: null })

    expect((await a.app.inject({ method: 'GET', url: `${ORG}/hooks/${randomUUID()}/runs` })).statusCode).toBe(404)
  })

  describe('github kind (P2)', () => {
    const INSTALLATION = 1234567n
    const REPO_ID = 987654321

    /** A placed agent whose WORKSPACE is acme/infra: the watch-repo gate
     *  (issue #457) admits the workspace repo without an authorization row. */
    async function githubAgent(): Promise<string> {
      const daemon = await prisma.daemon.findUnique({ where: { id: DAEMON }, select: { id: true } })
      if (!daemon) await seedDaemon(prisma, DAEMON)
      const agentId = randomUUID()
      await seedAgent(prisma, agentId, { daemonId: DAEMON, gitRepo: 'https://github.com/acme/infra' })
      return agentId
    }

    // One row per (agent, repo, family): the default body is the ISSUES family,
    // and a github issue_comment subscription must scope itself to it.
    const ghBody = (agentId: string, over: Record<string, unknown> = {}) => ({
      agentId,
      kind: 'github',
      name: 'issues-hook',
      repoFullName: 'acme/infra',
      family: 'issues',
      events: ['issues:opened', 'issue_comment:created'],
      commentFamilies: ['issues'],
      labelFilter: ['bug'],
      ...over
    })

    /** The pull-request family — the only one that may carry review/reporting. */
    const prBody = (agentId: string, over: Record<string, unknown> = {}) =>
      ghBody(agentId, {
        name: 'pr-hook',
        family: 'pull_request',
        events: ['pull_request:*'],
        commentFamilies: [],
        ...over
      })

    async function seedInstallation(over: Record<string, unknown> = {}): Promise<void> {
      await prisma.githubInstallation.create({
        data: {
          orgId: DEFAULT_ORG_ID,
          installationId: INSTALLATION,
          accountLogin: 'acme',
          accountType: 'Organization',
          repositorySelection: 'all',
          ...over
        }
      })
    }

    /** A GithubService over the real Pg repos with a URL-routing fetch stub —
     *  token mint + repo lookup answered locally, no network. An array scripts
     *  one status per /repos/ call (the last repeats) to play partial outages. */
    function stubbedGithub(repoStatus: 200 | 404 | Array<200 | 404 | 503> = 200): GithubService {
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
      const statuses = Array.isArray(repoStatus) ? [...repoStatus] : [repoStatus]
      const fetchImpl = async (url: string): Promise<Response> => {
        if (url.includes('/access_tokens')) {
          return Response.json(
            { token: 'ghs_test', expires_at: new Date(Date.now() + 3600_000).toISOString() },
            { status: 201 }
          )
        }
        if (/\/repos\//.test(url)) {
          const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!
          if (status === 404) return Response.json({ message: 'Not Found' }, { status: 404 })
          if (status === 503) return Response.json({ message: 'Service Unavailable' }, { status: 503 })
          // Canonical casing comes back from GitHub, whatever the caller typed.
          return Response.json({ id: REPO_ID, full_name: 'acme/infra', private: true }, { status: 200 })
        }
        throw new Error(`unexpected github call: ${url}`)
      }
      return new GithubService({
        cfg: {
          appId: 1,
          slug: 'agentconnect-test',
          jwtIssuer: '1',
          privateKey
        },
        clock: systemClock,
        installations: new PgGithubInstallationRepo(prisma),
        installState: new PgGithubInstallStateStore(prisma),
        pepper: TEST_API_KEY_PEPPER,
        fetchImpl
      })
    }

    function ghApp(repoStatus: 200 | 404 | Array<200 | 404 | 503> = 200): HttpApp {
      running = buildHttpApp(prisma, { PUBLIC_RELAY_URL: RELAY_URL }, undefined, undefined, {
        github: stubbedGithub(repoStatus)
      })
      return running
    }

    it('POST creates a github hook: repoId recorded, perThread, no URL/secret', async () => {
      const agentId = await githubAgent()
      await seedRelay()
      await seedInstallation()
      const a = ghApp()

      // Casing is normalized to GitHub's canonical full name.
      const res = await a.app.inject({
        method: 'POST',
        url: `${ORG}/hooks`,
        payload: ghBody(agentId, { repoFullName: 'ACME/Infra', commentFamilies: ['issues'] })
      })
      expect(res.statusCode).toBe(200)
      const dto = res.json() as Record<string, unknown>
      expect(dto).toMatchObject({
        kind: 'github',
        sessionMode: 'perThread',
        repoId: String(REPO_ID),
        repoFullName: 'acme/infra',
        family: 'issues',
        events: ['issues:opened', 'issue_comment:created'],
        commentFamilies: ['issues'],
        labelFilter: ['bug'],
        mentionOnly: false,
        url: null,
        hmacSecret: null,
        hmacConfigured: false
      })
      // The numeric match key is losslessly exposed for rename-proof clients
      // and lands in the row as BigInt.
      const row = await prisma.hookDef.findUniqueOrThrow({ where: { id: dto.id as string } })
      expect(row.repoId).toBe(BigInt(REPO_ID))
      expect(row.family).toBe('issues')
      expect(row.githubSessionKey).toBe(`github:${REPO_ID}`)
      expect(row.commentFamilies).toEqual(['issues'])
      expect(row.urlToken).toBeNull()
      // Readers-first catalog convergence (gitlab-com-integration.md §8.1): the
      // resolved reference lands in the provider-qualified catalog with canonical hints.
      const catalog = await prisma.codeHostRepository.findUniqueOrThrow({
        where: {
          orgId_provider_externalId: { orgId: DEFAULT_ORG_ID, provider: 'github', externalId: BigInt(REPO_ID) }
        }
      })
      expect(catalog.displayPath).toBe('acme/infra')
      expect(catalog.cloneUrl).toBe('https://github.com/acme/infra')
    })

    it('POST and PUT reject reserved required/status modes without persisting them', async () => {
      const agentId = await githubAgent()
      await seedRelay()
      await seedInstallation()
      const a = ghApp()
      const futureModes = [
        { patch: { gateMode: 'required' as const }, message: /R2b/ },
        { patch: { reportingMode: 'status' as const }, message: /R3/ }
      ]

      for (const { patch, message } of futureModes) {
        const rejected = await a.app.inject({
          method: 'POST',
          url: `${ORG}/hooks`,
          payload: prBody(agentId, { enabled: false, ...patch })
        })
        expect(rejected.statusCode).toBe(409)
        expect((rejected.json() as { message: string }).message).toMatch(message)
      }
      expect(await prisma.hookDef.count({ where: { agentId } })).toBe(0)

      const created = await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: prBody(agentId) })
      expect(created.statusCode).toBe(200)
      const hookId = (created.json() as { id: string }).id

      for (const { patch, message } of futureModes) {
        const rejected = await a.app.inject({
          method: 'PUT',
          url: `${ORG}/hooks/${hookId}`,
          payload: prBody(agentId, { enabled: false, ...patch })
        })
        expect(rejected.statusCode).toBe(409)
        expect((rejected.json() as { message: string }).message).toMatch(message)
      }
      expect(await prisma.hookDef.findUniqueOrThrow({ where: { id: hookId } })).toMatchObject({
        enabled: true,
        reportingMode: 'off',
        gateMode: 'informational'
      })
    })

    it('POST 409s when the GitHub App is not configured (relay gate already passed)', async () => {
      const agentId = await placedAgent()
      await seedRelay()
      await seedInstallation()
      const res = await app().app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: ghBody(agentId) })
      expect(res.statusCode).toBe(409)
      expect((res.json() as { message: string }).message).toMatch(/GitHub App is not configured/)
      expect(await prisma.hookDef.count()).toBe(0)
    })

    it('POST 400s a repo outside the org grant: no installation, suspended, or GitHub 404', async () => {
      const agentId = await placedAgent()
      await seedRelay()

      // (a) no installation covers the owner at all
      const a = ghApp()
      expect((await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: ghBody(agentId) })).statusCode).toBe(
        400
      )
      await running!.close()

      // (b) the covering installation is suspended
      await seedInstallation({ suspendedAt: new Date() })
      const b = ghApp()
      expect((await b.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: ghBody(agentId) })).statusCode).toBe(
        400
      )
      await running!.close()
      await prisma.githubInstallation.deleteMany()

      // (c) installation live but the repo reads 404 (out of grant / gone)
      await seedInstallation()
      const c = ghApp(404)
      expect((await c.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: ghBody(agentId) })).statusCode).toBe(
        400
      )
      expect(await prisma.hookDef.count()).toBe(0)
    })

    it('POST maps a GitHub outage during the watch-repo gate to 502 — unless an explicit grant decides it', async () => {
      const agentId = await githubAgent()
      await seedRelay()
      await seedInstallation()
      // Repo resolution succeeds, then GitHub 503s the workspace-identity read.
      // Upstream trouble must read as 502 (retryable), never an unhandled 500
      // or a misleading "not authorized" 409.
      const a = ghApp([200, 503])
      const res = await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: ghBody(agentId) })
      expect(res.statusCode).toBe(502)
      expect((res.json() as { message: string }).message).toMatch(/github/)
      expect(await prisma.hookDef.count()).toBe(0)
      await running!.close()

      // The same outage with an explicit grant on the repo: authorization is
      // decidable without GitHub, so creation proceeds.
      await prisma.agentRepoAuthorization.create({
        data: { agentId, repoId: BigInt(REPO_ID), repoFullName: 'acme/infra', access: 'write' }
      })
      const b = ghApp([200, 503])
      const ok = await b.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: ghBody(agentId) })
      expect(ok.statusCode).toBe(200)
      expect(await prisma.hookDef.count()).toBe(1)
    })

    it('PUT maps a GitHub outage during effect validation to 502, leaving the hook unchanged', async () => {
      const agentId = await githubAgent()
      await seedRelay()
      await seedInstallation()
      const a = ghApp()
      const created = await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: prBody(agentId) })
      expect(created.statusCode).toBe(200)
      const hookId = (created.json() as { id: string }).id
      await running!.close()

      // GitHub 503s the authorization re-resolution behind a review-policy
      // widening — upstream trouble, not a 409 configuration verdict (and
      // regression cover: this used to escape as an unhandled 500).
      const b = ghApp([200, 503])
      const res = await b.app.inject({
        method: 'PUT',
        url: `${ORG}/hooks/${hookId}`,
        payload: prBody(agentId, { reviewPolicy: 'comment' })
      })
      expect(res.statusCode).toBe(502)
      expect((res.json() as { message: string }).message).toMatch(/github/)
      expect(await prisma.hookDef.findUniqueOrThrow({ where: { id: hookId } })).toMatchObject({ reviewPolicy: 'off' })
    })

    it('POST accepts push ("commits") subscriptions and 409s a duplicate FAMILY for the same repo', async () => {
      const agentId = await githubAgent()
      await seedRelay()
      await seedInstallation()
      const a = ghApp()

      const pushBody = ghBody(agentId, {
        name: 'push-hook',
        family: 'push',
        events: ['push:*'],
        commentFamilies: [],
        labelFilter: []
      })
      const first = await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: pushBody })
      expect(first.statusCode).toBe(200)
      expect((first.json() as { events: string[] }).events).toEqual(['push:*'])
      expect((first.json() as { commentFamilies: string[] }).commentFamilies).toEqual([])

      // Same repo AND family again for the same agent — the database's rule.
      const dup = await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: pushBody })
      expect(dup.statusCode).toBe(409)
      expect((dup.json() as { message: string }).message).toMatch(/already watches acme\/infra \(push\)/)
      expect(await prisma.hookDef.count()).toBe(1)

      // Another FAMILY on the same repo is the whole point of the split.
      const issues = await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: ghBody(agentId) })
      expect(issues.statusCode).toBe(200)

      // A DIFFERENT agent may watch the same repo (its own workspace here).
      const otherAgent = randomUUID()
      await seedAgent(prisma, otherAgent, { daemonId: DAEMON, gitRepo: 'https://github.com/acme/infra' })
      const other = await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: ghBody(otherAgent) })
      expect(other.statusCode).toBe(200)
    })

    it('the agents list carries hookKinds marks for enabled triggers', async () => {
      const agentId = await githubAgent()
      await seedRelay()
      await seedInstallation()
      const a = ghApp()
      await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: body(agentId, { hmac: false }) })
      await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: ghBody(agentId) })

      const list = await a.app.inject({ method: 'GET', url: `${ORG}/agents` })
      const row = (list.json() as Array<{ id: string; hookKinds: string[] }>).find((r) => r.id === agentId)
      expect(row?.hookKinds.slice().sort()).toEqual(['github', 'webhook'])

      // The single-agent read agrees; agents without triggers read [].
      const one = await a.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}` })
      expect((one.json() as { hookKinds: string[] }).hookKinds.slice().sort()).toEqual(['github', 'webhook'])
    })

    it('POST 400s malformed events / repoFullName (schema gate)', async () => {
      const agentId = await placedAgent()
      await seedRelay()
      await seedInstallation()
      const a = ghApp()
      for (const bad of [
        { events: ['releases:published'] }, // unsupported family
        { events: [] }, // at least one
        { events: ['issues'] }, // missing action
        { commentFamilies: ['push'] }, // only issue/PR subjects are valid
        { repoFullName: 'not-a-repo' }
      ]) {
        const res = await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: ghBody(agentId, bad) })
        expect(res.statusCode).toBe(400)
      }
    })

    it('PUT re-validates the repo, keeps perThread, and refuses a kind flip', async () => {
      const agentId = await githubAgent()
      await seedRelay()
      await seedInstallation()
      const a = ghApp()
      const { id } = (await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: ghBody(agentId) })).json() as {
        id: string
      }

      const put = await a.app.inject({
        method: 'PUT',
        url: `${ORG}/hooks/${id}`,
        payload: ghBody(agentId, {
          name: 'renamed',
          events: ['issues:*', 'issue_comment:created'],
          commentFamilies: ['issues'],
          labelFilter: [],
          mentionOnly: true
        })
      })
      expect(put.statusCode).toBe(200)
      expect(put.json()).toMatchObject({
        name: 'renamed',
        sessionMode: 'perThread',
        family: 'issues',
        events: ['issues:*', 'issue_comment:created'],
        commentFamilies: ['issues'],
        mentionOnly: true
      })

      // A pre-P3 client echoing the definition WITHOUT mentionOnly must not
      // silently downgrade mention mode (the route keeps the stored value).
      const echo = await a.app.inject({
        method: 'PUT',
        url: `${ORG}/hooks/${id}`,
        payload: {
          agentId,
          kind: 'github',
          name: 'renamed',
          repoFullName: 'acme/infra',
          events: ['issues:*', 'issue_comment:created'],
          labelFilter: []
        }
      })
      expect(echo.statusCode).toBe(200)
      expect(echo.json()).toMatchObject({ mentionOnly: true, commentFamilies: ['issues'] })

      const flip = await a.app.inject({
        method: 'PUT',
        url: `${ORG}/hooks/${id}`,
        payload: { agentId, kind: 'webhook', name: 'x', sessionMode: 'perDelivery' }
      })
      expect(flip.statusCode).toBe(400)
      expect((flip.json() as { message: string }).message).toMatch(/kind is immutable/)
    })

    it('persists check-off/disable cleanup without live GitHub and allocates a fresh epoch on re-enable', async () => {
      const agentId = await githubAgent()
      await seedRelay()
      await seedInstallation({ permissions: { checks: 'write', pull_requests: 'write' } })
      const installation = await prisma.githubInstallation.findUniqueOrThrow({
        where: { installationId: INSTALLATION }
      })
      await prisma.agent.update({
        where: { id: agentId },
        data: { installationId: installation.id, gitAccess: 'write' }
      })
      const createPayload = prBody(agentId, {
        labelFilter: [],
        reviewPolicy: 'off',
        reportingMode: 'check',
        gateMode: 'informational'
      })
      const good = ghApp()
      const created = await good.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: createPayload })
      expect(created.statusCode).toBe(200)
      const hookId = (created.json() as { id: string }).id
      const initialHook = await prisma.hookDef.findUniqueOrThrow({ where: { id: hookId } })
      const firstProjectionId = randomUUID()
      await prisma.hookReviewProjection.create({
        data: {
          id: firstProjectionId,
          externalId: firstProjectionId,
          hookId,
          orgId: DEFAULT_ORG_ID,
          agentId,
          repoId: BigInt(REPO_ID),
          repoFullName: 'acme/infra',
          headSha: 'd'.repeat(40),
          reportSha: 'd'.repeat(40),
          projectionEpoch: initialHook.projectionEpoch,
          generation: 1n,
          mode: 'check',
          gateMode: 'informational',
          desiredState: 'success',
          observedState: 'success'
        }
      })
      await good.close()
      running = undefined

      // The 404 stub proves these reducing mutations do not call repo resolve.
      const unavailable = ghApp(404)
      const checkOff = await unavailable.app.inject({
        method: 'PUT',
        url: `${ORG}/hooks/${hookId}`,
        payload: { ...createPayload, enabled: true, reportingMode: 'off' }
      })
      expect(checkOff.statusCode).toBe(200)
      const offHook = await prisma.hookDef.findUniqueOrThrow({ where: { id: hookId } })
      expect(offHook.projectionEpoch).toBe(initialHook.projectionEpoch + 1n)
      expect(await prisma.hookReviewProjection.findUniqueOrThrow({ where: { id: firstProjectionId } })).toMatchObject({
        tombstonedAt: expect.any(Date)
      })
      await unavailable.close()
      running = undefined

      const restored = ghApp()
      const checkOn = await restored.app.inject({
        method: 'PUT',
        url: `${ORG}/hooks/${hookId}`,
        payload: { ...createPayload, enabled: true, reportingMode: 'check' }
      })
      expect(checkOn.statusCode).toBe(200)
      const onHook = await prisma.hookDef.findUniqueOrThrow({ where: { id: hookId } })
      expect(onHook.projectionEpoch).toBe(offHook.projectionEpoch + 1n)
      const secondProjectionId = randomUUID()
      await prisma.hookReviewProjection.create({
        data: {
          id: secondProjectionId,
          externalId: secondProjectionId,
          hookId,
          orgId: DEFAULT_ORG_ID,
          agentId,
          repoId: BigInt(REPO_ID),
          repoFullName: 'acme/infra',
          headSha: 'd'.repeat(40),
          reportSha: 'd'.repeat(40),
          projectionEpoch: onHook.projectionEpoch,
          generation: 1n,
          mode: 'check',
          gateMode: 'informational',
          desiredState: 'success',
          observedState: 'success'
        }
      })
      await restored.close()
      running = undefined

      const unavailableAgain = ghApp(404)
      const disabled = await unavailableAgain.app.inject({
        method: 'PUT',
        url: `${ORG}/hooks/${hookId}`,
        payload: { ...createPayload, enabled: false, reportingMode: 'check' }
      })
      expect(disabled.statusCode).toBe(200)
      expect(await prisma.hookReviewProjection.findUniqueOrThrow({ where: { id: secondProjectionId } })).toMatchObject({
        tombstonedAt: expect.any(Date)
      })

      // Legacy whole-definition clients omitted `enabled`. Editing a disabled
      // hook must preserve false (and may use its persisted binding while
      // GitHub is unavailable), never silently restart event delivery.
      const editedDisabled = await unavailableAgain.app.inject({
        method: 'PUT',
        url: `${ORG}/hooks/${hookId}`,
        payload: { ...createPayload, name: 'still-disabled', reportingMode: 'check' }
      })
      expect(editedDisabled.statusCode).toBe(200)
      expect(editedDisabled.json()).toMatchObject({ name: 'still-disabled', enabled: false })
    })

    it('tombstones the old owner epoch before reassigning a GitHub hook', async () => {
      const firstAgent = await githubAgent()
      const secondAgent = await githubAgent()
      await seedRelay()
      await seedInstallation({ permissions: { checks: 'write', pull_requests: 'write' } })
      const installation = await prisma.githubInstallation.findUniqueOrThrow({
        where: { installationId: INSTALLATION }
      })
      await prisma.agent.updateMany({
        where: { id: { in: [firstAgent, secondAgent] } },
        data: { installationId: installation.id, gitAccess: 'write' }
      })
      const a = ghApp()
      const payload = prBody(firstAgent, {
        labelFilter: [],
        reviewPolicy: 'off',
        reportingMode: 'check',
        gateMode: 'informational'
      })
      const created = await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload })
      expect(created.statusCode).toBe(200)
      const hookId = (created.json() as { id: string }).id
      const before = await prisma.hookDef.findUniqueOrThrow({ where: { id: hookId } })
      const projectionId = randomUUID()
      await prisma.hookReviewProjection.create({
        data: {
          id: projectionId,
          externalId: projectionId,
          hookId,
          orgId: DEFAULT_ORG_ID,
          agentId: firstAgent,
          repoId: BigInt(REPO_ID),
          repoFullName: 'acme/infra',
          headSha: 'e'.repeat(40),
          reportSha: 'e'.repeat(40),
          projectionEpoch: before.projectionEpoch,
          generation: 1n,
          mode: 'check',
          gateMode: 'informational',
          desiredState: 'success',
          observedState: 'success'
        }
      })

      const reassigned = await a.app.inject({
        method: 'PUT',
        url: `${ORG}/hooks/${hookId}`,
        payload: { ...payload, agentId: secondAgent }
      })
      expect(reassigned.statusCode).toBe(200)
      const after = await prisma.hookDef.findUniqueOrThrow({ where: { id: hookId } })
      expect(after).toMatchObject({ agentId: secondAgent, projectionEpoch: before.projectionEpoch + 1n })
      expect(await prisma.hookReviewProjection.findUniqueOrThrow({ where: { id: projectionId } })).toMatchObject({
        agentId: firstAgent,
        tombstonedAt: expect.any(Date)
      })
    })

    // The point of the split: one repository, two families, two cadences.
    it('watches one repo per family, each with its own mention gate and compiled rule', async () => {
      const agentId = await githubAgent()
      await seedRelay()
      await seedInstallation()
      const a = ghApp()

      // PRs fire on every update; issues only when the agent is summoned.
      const pr = await a.app.inject({
        method: 'POST',
        url: `${ORG}/hooks`,
        payload: prBody(agentId, {
          events: ['pull_request:*', 'issue_comment:created'],
          commentFamilies: ['pull_request'],
          labelFilter: [],
          mentionOnly: false
        })
      })
      const issues = await a.app.inject({
        method: 'POST',
        url: `${ORG}/hooks`,
        payload: ghBody(agentId, {
          events: ['issues:*', 'issue_comment:created'],
          commentFamilies: ['issues'],
          labelFilter: [],
          mentionOnly: true
        })
      })
      expect([pr.statusCode, issues.statusCode]).toEqual([200, 200])
      expect(pr.json()).toMatchObject({ family: 'pull_request', mentionOnly: false })
      expect(issues.json()).toMatchObject({ family: 'issues', mentionOnly: true })

      const rows = await prisma.hookDef.findMany({ where: { agentId }, orderBy: { family: 'asc' } })
      expect(rows.map((r) => [r.family, r.mentionOnly, r.commentFamilies])).toEqual([
        ['issues', true, ['issues']],
        ['pull_request', false, ['pull_request']]
      ])
      // Sibling rows answer the same threads, so they share one session namespace.
      expect(new Set(rows.map((r) => r.githubSessionKey))).toEqual(new Set([`github:${REPO_ID}`]))

      // Two independent wire rules — the relay already fans one delivery out to
      // every rule for the repository, so the per-rule gate is what differs.
      const records = (await a.deps.repos.hook.listForAgent(AgentId(agentId))).sort((x, y) =>
        (x.family ?? '').localeCompare(y.family ?? '')
      )
      const compiled = await Promise.all(records.map((record) => a.deps.hooks.compile(record)))
      expect(
        compiled.map((rule) => [rule?.github?.commentFamilies, rule?.github?.mentionOnly, rule?.github?.events])
      ).toEqual([
        [['issues'], true, ['issues:*', 'issue_comment:created']],
        [['pull_request'], false, ['pull_request:*', 'issue_comment:created']]
      ])
    })

    it('400s a subscription that strays outside the row’s own family', async () => {
      const agentId = await githubAgent()
      await seedRelay()
      await seedInstallation()
      const a = ghApp()
      const cases: [Record<string, unknown>, RegExp][] = [
        // A pattern belonging to another family — that family has its own row.
        [{ family: 'pull_request', events: ['pull_request:*', 'issues:opened'] }, /"issues:opened"/],
        [{ family: 'push', events: ['push:*', 'issue_comment:created'] }, /"issue_comment:created"/],
        // An unscoped issue_comment is the legacy repo-wide meaning: it would
        // double-fire against the sibling row that owns the other thread family.
        [
          { family: 'pull_request', events: ['pull_request:*', 'issue_comment:created'], commentFamilies: [] },
          /must set commentFamilies/
        ],
        // commentFamilies may only narrow this row's own family.
        [{ family: 'pull_request', events: ['pull_request:*'], commentFamilies: ['issues'] }, /not issues/],
        // Reviews and run reporting belong to the change-proposal family.
        [{ reviewPolicy: 'comment' }, /pull-request\/merge-request rows/],
        [{ reportingMode: 'check' }, /pull-request\/merge-request rows/]
      ]
      for (const [over, message] of cases) {
        const res = await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: ghBody(agentId, over) })
        expect(res.statusCode).toBe(400)
        expect((res.json() as { message: string }).message).toMatch(message)
      }
      expect(await prisma.hookDef.count({ where: { agentId } })).toBe(0)

      // The family is immutable, so an edit is re-shaped against the STORED one.
      const created = await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: ghBody(agentId) })
      expect(created.statusCode).toBe(200)
      const strayEdit = await a.app.inject({
        method: 'PUT',
        url: `${ORG}/hooks/${(created.json() as { id: string }).id}`,
        payload: ghBody(agentId, { events: ['pull_request:*'], commentFamilies: [] })
      })
      expect(strayEdit.statusCode).toBe(400)
      expect((strayEdit.json() as { message: string }).message).toMatch(/issues family/)
    })

    it('409s a sibling family anchored somewhere else — one thread, one destination', async () => {
      const agentId = await githubAgent()
      await seedRelay()
      await seedInstallation()
      const a = ghApp()
      expect((await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: ghBody(agentId) })).statusCode).toBe(
        200
      )

      const diverging = await a.app.inject({
        method: 'POST',
        url: `${ORG}/hooks`,
        payload: prBody(agentId, { targetChannel: 'C-elsewhere' })
      })
      expect(diverging.statusCode).toBe(409)
      expect((diverging.json() as { message: string }).message).toMatch(/post somewhere else/)
      expect(await prisma.hookDef.count({ where: { agentId } })).toBe(1)
    })
  })

  it('refuses a rerun on a deployment with no GitLab application, without an existence oracle', async () => {
    const agentId = await placedAgent()
    await seedRelay()
    const a = app()
    const { id } = (await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: body(agentId) })).json() as {
      id: string
    }
    const rerun = await a.app.inject({
      method: 'POST',
      url: `${ORG}/hooks/${id}/rerun`,
      payload: { subject: { kind: 'merge_request', iid: 1 } }
    })
    expect(rerun.statusCode).toBe(409)
    expect((rerun.json() as { code: string }).code).toBe('GITLAB_NOT_CONFIGURED')
    // An unknown hook is still absent, not a configuration complaint.
    const missing = await a.app.inject({
      method: 'POST',
      url: `${ORG}/hooks/${randomUUID()}/rerun`,
      payload: { subject: { kind: 'merge_request', iid: 1 } }
    })
    expect(missing.statusCode).toBe(404)
  })

  it('POST and DELETE append hook_change audit rows', async () => {
    const agentId = await placedAgent()
    await seedRelay()
    const a = app()
    const { id } = (await a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: body(agentId) })).json() as {
      id: string
    }
    await a.app.inject({ method: 'DELETE', url: `${ORG}/hooks/${id}` })

    // Both appends are fire-and-forget: order is not guaranteed, and a prior test's row can outlive the sweep.
    await vi.waitFor(async () => {
      const rows = await prisma.auditEvent.findMany({
        where: { kind: 'hook_change', details: { path: ['hookId'], equals: id } }
      })
      expect(rows.sort((x, y) => (x.frameType ?? '').localeCompare(y.frameType ?? ''))).toMatchObject([
        { frameType: 'rc/hook-assign', agentId },
        { frameType: 'rc/hook-remove', agentId }
      ])
    })
  })
})
