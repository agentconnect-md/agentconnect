// `repo-candidates/request` over the real daemon WS edge and real Postgres, with GitHub's roster pages scripted.
import { describe, it, expect, vi } from 'vitest'
import { isFrame, REPO_CANDIDATES_V1_FEATURE } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildWsHarness, type WsHarness } from '../fakes/build-ws.js'
import { InMemoryDaemonStub } from '../fakes/daemon-stub.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { RepoCandidatesService } from '../../src/github/repo-candidates.js'
import {
  PgAgentInstallationAuthorizationRepo,
  PgAgentRepoAuthorizationRepo,
  PgGithubInstallationRepo
} from '../../src/persistence/index.js'
import type { GithubInstallationRecord } from '../../src/persistence/ports.js'

const DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddd01'
const OTHER_DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddd02'
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01'
const FOREIGN_ORG = 'example-foreign-org'
const FOREIGN_AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02'
const INSTALLATION = 12345n
const ON_DEMAND_INSTALLATION = 12346n
const FOREIGN_INSTALLATION = 12347n

const repo = (id: number, name: string, pushedAt: string | null, description: string | null = null) => ({
  id: String(id),
  full_name: name,
  private: true,
  default_branch: 'main',
  description,
  pushed_at: pushedAt
})

const ROSTERS = new Map([
  [
    INSTALLATION,
    [
      repo(101, 'acme/tooling', '2026-09-01T00:00:00Z', 'Shared build tooling'),
      repo(102, 'acme/infra', '2026-09-20T00:00:00Z'),
      repo(103, 'acme/pinned', '2026-09-24T00:00:00Z')
    ]
  ],
  [ON_DEMAND_INSTALLATION, [repo(201, 'example-co/docs', '2026-09-22T00:00:00Z')]],
  [FOREIGN_INSTALLATION, [repo(301, 'example-foreign/app', '2026-09-23T00:00:00Z')]]
])

/** The org's claimed installations, the agent's grants (one `decision`, one `on-demand`), and a row for acme/pinned. */
async function seedGrants(): Promise<void> {
  await seedDaemon(prisma, DAEMON)
  await seedAgent(prisma, AGENT, { daemonId: DAEMON })
  for (const [installationId, accountLogin] of [
    [INSTALLATION, 'acme'],
    [ON_DEMAND_INSTALLATION, 'example-co']
  ] as const) {
    await prisma.githubInstallation.create({
      data: {
        orgId: DEFAULT_ORG_ID,
        installationId,
        accountLogin,
        accountType: 'Organization',
        repositorySelection: 'all'
      }
    })
  }
  // Written directly: the route preconditions for `decision` are agent-repos.route.test.ts’s concern.
  await prisma.agentInstallationAuthorization.createMany({
    data: [
      { agentId: AGENT, installationId: INSTALLATION, accountLogin: 'acme', access: 'read', materialize: 'decision' },
      {
        agentId: AGENT,
        installationId: ON_DEMAND_INSTALLATION,
        accountLogin: 'example-co',
        access: 'read',
        materialize: 'on_demand'
      }
    ]
  })
  await prisma.agentRepoAuthorization.create({
    data: { agentId: AGENT, provider: 'github', repoId: 103n, repoFullName: 'acme/pinned', access: 'write' }
  })
}

/** A foreign organization with its own agent, claimed installation, and `decision` grant. */
async function seedForeignOrg(): Promise<void> {
  await prisma.org.create({ data: { id: FOREIGN_ORG, slug: FOREIGN_ORG } })
  await seedAgent(prisma, FOREIGN_AGENT, { orgId: FOREIGN_ORG })
  await prisma.githubInstallation.create({
    data: {
      orgId: FOREIGN_ORG,
      installationId: FOREIGN_INSTALLATION,
      accountLogin: 'example-foreign',
      accountType: 'Organization',
      repositorySelection: 'all'
    }
  })
  await prisma.agentInstallationAuthorization.create({
    data: {
      agentId: FOREIGN_AGENT,
      installationId: FOREIGN_INSTALLATION,
      accountLogin: 'example-foreign',
      access: 'read',
      materialize: 'decision'
    }
  })
}

/** The harness with the real roster service over a scripted page reader. */
function harness(withRosters = true) {
  const h = buildWsHarness(prisma)
  const listRepos = vi.fn(async (ins: GithubInstallationRecord, page: number, perPage: number) => {
    const all = ROSTERS.get(ins.installationId) ?? []
    return { repos: all.slice((page - 1) * perPage, page * perPage), totalCount: all.length }
  })
  if (withRosters) {
    h.deps.repoCandidates = new RepoCandidatesService({
      installationAuths: new PgAgentInstallationAuthorizationRepo(prisma),
      repoAuths: new PgAgentRepoAuthorizationRepo(prisma),
      installations: new PgGithubInstallationRepo(prisma),
      github: { listRepos }
    })
  }
  return { h, listRepos }
}

async function ready(h: WsHarness, daemonId: string) {
  const token = await h.mintToken(daemonId)
  const stub = new InMemoryDaemonStub()
  h.connect(stub)
  stub.inject('auth', { apiKey: token, daemonId, agentVersion: '1.4.0' })
  await stub.expectFrame('auth/ok')
  stub.inject('register', {
    host: 'daemon-1',
    capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true, features: [] },
    maxAgents: 4,
    localState: { assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }
  })
  const ok = await stub.expectFrame('register/ok')
  if (!isFrame('register/ok')(ok)) throw new Error('expected register/ok')
  return { stub, serverFeatures: ok.payload.serverFeatures ?? [] }
}

async function answerTo(stub: InMemoryDaemonStub, id: string) {
  await stub.settled()
  const reply = stub.sent.find((f) => f.corr === id && f.type === 'repo-candidates/reply')
  const error = stub.sent.find((f) => f.corr === id && f.type === 'error')
  return {
    reply: reply && isFrame('repo-candidates/reply')(reply) ? reply.payload : undefined,
    error: error && isFrame('error')(error) ? error.payload : undefined
  }
}

describe('repo-candidates/request over the daemon WS edge', () => {
  it('answers the serving daemon from its decision grants, after advertising the feature', async () => {
    await seedGrants()
    const { h, listRepos } = harness()
    const { stub, serverFeatures } = await ready(h, DAEMON)
    expect(serverFeatures).toContain(REPO_CANDIDATES_V1_FEATURE)

    const { reply, error } = await answerTo(stub, stub.inject('repo-candidates/request', { agentId: AGENT }))

    expect(error).toBeUndefined()
    // Most recent push first; acme/pinned has its own row, and the on-demand grant is never read.
    expect(reply).toEqual({
      candidates: [
        { provider: 'github', repoFullName: 'acme/infra', repoId: '102', pushedAt: '2026-09-20T00:00:00.000Z' },
        {
          provider: 'github',
          repoFullName: 'acme/tooling',
          repoId: '101',
          description: 'Shared build tooling',
          pushedAt: '2026-09-01T00:00:00.000Z'
        }
      ],
      partial: false
    })
    expect(listRepos.mock.calls.map(([ins, page, perPage]) => [ins.installationId, page, perPage])).toEqual([
      [INSTALLATION, 1, 100]
    ])
  })

  it('refuses a daemon that does not serve the agent before reading a roster', async () => {
    await seedGrants()
    const { h, listRepos } = harness()
    const { stub } = await ready(h, OTHER_DAEMON)

    const { reply, error } = await answerTo(stub, stub.inject('repo-candidates/request', { agentId: AGENT }))

    expect(reply).toBeUndefined()
    expect(error).toMatchObject({ code: 'SCOPE_DENIED', retryable: false })
    expect(listRepos).not.toHaveBeenCalled()
  })

  it('fences another organization’s agent, named or not', async () => {
    await seedGrants()
    await seedForeignOrg()
    const { h, listRepos } = harness()
    const { stub } = await ready(h, DAEMON)

    const unnamed = await answerTo(stub, stub.inject('repo-candidates/request', { agentId: FOREIGN_AGENT }))
    expect(unnamed.reply).toBeUndefined()
    expect(unnamed.error).toMatchObject({ code: 'SCOPE_DENIED', message: 'this daemon does not serve that agent' })

    const named = await answerTo(
      stub,
      stub.inject('repo-candidates/request', { agentId: FOREIGN_AGENT }, { orgId: FOREIGN_ORG })
    )
    expect(named.reply).toBeUndefined()
    expect(named.error).toMatchObject({ code: 'SCOPE_DENIED' })
    expect(listRepos).not.toHaveBeenCalled()
  })

  it('neither advertises nor answers without a roster reader', async () => {
    await seedGrants()
    const { h } = harness(false)
    const { stub, serverFeatures } = await ready(h, DAEMON)
    expect(serverFeatures).not.toContain(REPO_CANDIDATES_V1_FEATURE)

    const { reply, error } = await answerTo(stub, stub.inject('repo-candidates/request', { agentId: AGENT }))

    expect(reply).toBeUndefined()
    expect(error).toMatchObject({ code: 'SCOPE_DENIED', retryable: false })
  })
})
