/**
 * Binding on first use (gitea-integration.md §6): a trigger, an agent workspace or an
 * additional-repository grant binds the repository it names as the same write, several agents share
 * one binding and one webhook whose subscription is the union of their triggers, the binding is never
 * unbound on last use, and the operator's Remove is refused while anything still references it.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { buildGiteaSeam, type GiteaSeam } from '../fakes/gitea-seam.js'
import { makeSecretCipher } from '../../src/secrets/cipher.js'
import { trackedTestClock } from '../fakes/tracked-clock.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import type { DaemonLiveness } from '../../src/ports.js'
import { GiteaBindingUnavailable } from '../../src/persistence/errors.js'
import { joinGiteaBindingFence } from '../../src/persistence/repositories/gitea-binding-fence.js'
import { PgAgentRepo } from '../../src/persistence/repositories/agent.repo.js'
import { PgAgentRepoAuthorizationRepo } from '../../src/persistence/repositories/agent-repo-auth.repo.js'
import { PgHookRepo } from '../../src/persistence/repositories/hook.repo.js'
import { AgentId, HookId, OrgId } from '../../src/domain/ids.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const REPO = 556677n
const SECOND = 556678n
const NO_ADMIN = 556690n
const BASE = 'https://gitea.example.test'
const RELAY_URL = 'https://relay.example.test'
const MANAGED_URL = `${RELAY_URL}/webhooks/gitea`
// Real-time clock whose pending timers die with the test — see fakes/tracked-clock.ts.
const clock = trackedTestClock()
const cipher = makeSecretCipher({ SECRET_CIPHER: 'none' } as never)
const CAPS = {
  platforms: [],
  runtimes: ['claude'],
  acp: true,
  features: ['gitea-v1', 'workspace-git-v1', 'workspace-edit-v2']
}

let running: HttpApp | undefined
let seam: GiteaSeam | undefined
afterEach(async () => {
  // Own the routes' fire-and-forget convergence: a run outliving its test writes into the next one's swept database.
  await seam?.settled()
  await running?.close()
  running = undefined
  seam = undefined
})

/** The one online daemon: the workspace-replace route needs it READY and able to detach/activate; deletes tell it to drop the agent. */
class ControlSpy {
  async agentDetach(): Promise<{ ok: true }> {
    return { ok: true }
  }
  async agentActivate(): Promise<{ ok: true }> {
    return { ok: true }
  }
  async agentUpsert(): Promise<void> {}
  async agentRemove(): Promise<void> {}
}

async function harness() {
  const built = buildGiteaSeam(prisma, cipher, clock, {
    fake: {
      baseUrl: BASE,
      repositories: [
        { id: Number(REPO), full_name: 'example-org/example-repo', admin: true },
        { id: Number(SECOND), full_name: 'example-org/second-repo', admin: true },
        { id: Number(NO_ADMIN), full_name: 'example-org/public-unbound', admin: false, private: false }
      ]
    }
  })
  seam = built
  const daemonId = randomUUID()
  const liveness: DaemonLiveness = {
    get: (id) => (id === daemonId ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined)
  }
  running = buildHttpApp(
    prisma,
    { PUBLIC_RELAY_URL: RELAY_URL },
    liveness,
    new ControlSpy() as unknown as ControlSender,
    { gitea: built.httpDeps }
  )
  built.broadcast.current = (hook) => running!.deps.hooks.broadcast(hook)
  // A live relay row so the hook ingress gate passes.
  await prisma.relay.create({
    data: {
      id: randomUUID(),
      name: `relay-${randomUUID().slice(0, 8)}`,
      daemonUrl: 'wss://relay-0',
      lastSeenAt: new Date()
    }
  })
  const connection = await built.connections.connect(DEFAULT_ORG_ID, built.fake.token)
  // The connect step's own scope probes (§4.1) are not what these suites count.
  built.fake.requests.length = 0
  await seedDaemon(prisma, daemonId, { capabilities: CAPS })
  // NOTHING is bound yet: the writes under test bind.
  const withWorkspace = async (name: string, repoId = REPO): Promise<string> => {
    const id = randomUUID()
    await seedAgent(prisma, id, {
      daemonId,
      name,
      giteaRepoId: repoId,
      gitRepo: `${BASE}/example-org/example-repo.git`
    })
    return id
  }
  return { a: running, seam: built, fake: built.fake, connection, daemonId, withWorkspace }
}
type Harness = Awaited<ReturnType<typeof harness>>

const trigger = (agentId: string, over: Record<string, unknown> = {}) => ({
  agentId,
  kind: 'gitea',
  name: 'example-org/example-repo',
  repoId: REPO.toString(),
  family: 'merge_request',
  events: ['merge_request:*'],
  commentFamilies: ['merge_request'],
  ...over
})
const ISSUES_TRIGGER = { family: 'issues', events: ['issues:*'], commentFamilies: ['issues'] }
const PR_EVENTS = ['pull_request', 'pull_request_sync', 'pull_request_review_request', 'pull_request_comment']

/** Webhook creates the fake saw — the count that must stay at one however many agents subscribe. */
const webhookCreates = (h: Harness) =>
  h.fake.requests.filter(
    (r) => r.method === 'POST' && (r.body as { config?: { url?: string } } | undefined)?.config?.url === MANAGED_URL
  )
const managedHooks = (h: Harness) => [...h.fake.hooks.values()].filter((hook) => hook.url === MANAGED_URL)
const bindings = () => prisma.giteaRepositoryBinding.findMany({ where: { orgId: DEFAULT_ORG_ID } })
const claims = () => prisma.codeHostRepositoryClaim.count({ where: { provider: 'gitea' } })

/** A barrier over the first-use read: released once `writers` have reached it, failing loudly if they never do. */
function barrier(h: Harness, repoId: bigint, writers = 2): { arrivals: string[] } {
  const arrivals: string[] = []
  let release: () => void = () => undefined
  const open = new Promise<void>((resolve) => {
    release = resolve
  })
  const opened = Promise.race([
    open,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the barrier never saw every writer')), 5_000))
  ])
  h.fake.opts.gate = async (method, route) => {
    if (method !== 'GET' || route !== `/repositories/${repoId}`) return
    arrivals.push(route)
    if (arrivals.length === writers) release()
    await opened
  }
  return { arrivals }
}

describe('gitea triggers bind on first use (§6)', () => {
  it('binds the repository and installs its webhook as the same write; a refused trigger binds nothing', async () => {
    const h = await harness()
    // §8.3 still holds: a stranger's trigger is refused BEFORE anything is bound.
    const strangerId = randomUUID()
    await seedAgent(prisma, strangerId, { daemonId: h.daemonId, name: 'stranger' })
    const refused = await h.a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: trigger(strangerId) })
    expect(refused.statusCode).toBe(409)
    expect((refused.json() as { message: string }).message).toContain('not authorized for this agent')
    expect(await bindings()).toHaveLength(0)
    expect(await claims()).toBe(0)
    expect(h.fake.hooks.size).toBe(0)

    const agentId = await h.withWorkspace('builder')
    const created = await h.a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: trigger(agentId) })
    expect(created.statusCode).toBe(200)
    expect(created.json()).toMatchObject({
      kind: 'gitea',
      repoId: REPO.toString(),
      repoFullName: 'example-org/example-repo'
    })
    await h.seam.settled()
    const rows = await bindings()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ repoId: REPO, repoPath: 'example-org/example-repo', state: 'ready' })
    expect(await claims()).toBe(1)
    // The catalog row the workspace and Git credentials read from carries the provider's clone URL.
    const catalog = await prisma.codeHostRepository.findFirstOrThrow({
      where: { provider: 'gitea', externalId: REPO }
    })
    expect(catalog.cloneUrl).toBe(`${BASE}/example-org/example-repo.git`)
    const hooks = managedHooks(h)
    expect(hooks).toHaveLength(1)
    for (const event of PR_EVENTS) expect(hooks[0]!.events).toContain(event)
    expect(hooks[0]!.events).not.toContain('issues')
    // The card reads the same binding, webhook installed.
    const listed = await h.a.app.inject({ method: 'GET', url: `${ORG}/gitea/repositories` })
    expect(listed.json()).toMatchObject({
      bindings: [{ repoId: REPO.toString(), state: 'ready', webhookState: 'installed' }]
    })
  })

  it('a repository the bot does not administer is refused and stays unbound', async () => {
    const h = await harness()
    const agentId = await h.withWorkspace('builder', NO_ADMIN)
    const refused = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/hooks`,
      payload: trigger(agentId, { repoId: NO_ADMIN.toString(), name: 'example-org/public-unbound' })
    })
    expect(refused.statusCode).toBe(403)
    expect((refused.json() as { message: string }).message).toContain('must hold admin on example-org/public-unbound')
    expect(await bindings()).toHaveLength(0)
    expect(await claims()).toBe(0)
  })
})

describe('several agents on one repository (§6, §7)', () => {
  it('share one binding and one webhook: the union grows by PATCH, narrows as triggers and agents go, and the last reference leaving never unbinds', async () => {
    const h = await harness()
    const first = await h.withWorkspace('first')
    const second = await h.withWorkspace('second')

    // (1) The first trigger binds and installs; the second reuses the binding and installs nothing.
    const a = await h.a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: trigger(first) })
    expect(a.statusCode).toBe(200)
    await h.seam.settled()
    expect(webhookCreates(h)).toHaveLength(1)
    const b = await h.a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: trigger(second) })
    expect(b.statusCode).toBe(200)
    await h.seam.settled()
    expect(await bindings()).toHaveLength(1)
    expect(await claims()).toBe(1)
    expect(managedHooks(h)).toHaveLength(1)
    expect(webhookCreates(h)).toHaveLength(1)

    // (2) A new family on the second agent widens the union by PATCHing the one webhook, never by creating another.
    h.fake.requests.length = 0
    const issues = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/hooks`,
      payload: trigger(second, ISSUES_TRIGGER)
    })
    expect(issues.statusCode).toBe(200)
    await h.seam.settled()
    expect(managedHooks(h)).toHaveLength(1)
    expect(webhookCreates(h)).toHaveLength(0)
    expect(h.fake.requests.some((r) => r.method === 'PATCH' && /\/hooks\/\d+$/.test(r.url))).toBe(true)
    const widened = managedHooks(h)[0]!
    expect(widened.events).toContain('issues')
    for (const event of PR_EVENTS) expect(widened.events).toContain(event)

    // (3a) Removing the second agent's issues trigger narrows the union; the binding and webhook stay for the others.
    const issuesId = (issues.json() as { id: string }).id
    expect((await h.a.app.inject({ method: 'DELETE', url: `${ORG}/hooks/${issuesId}` })).statusCode).toBe(204)
    await h.seam.settled()
    expect(await bindings()).toHaveLength(1)
    expect(managedHooks(h)).toHaveLength(1)
    expect(managedHooks(h)[0]!.events).not.toContain('issues')
    for (const event of PR_EVENTS) expect(managedHooks(h)[0]!.events).toContain(event)

    // (3b) The same narrowing when the agent itself goes: its triggers leave with it, the first agent's stays.
    const again = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/hooks`,
      payload: trigger(second, ISSUES_TRIGGER)
    })
    expect(again.statusCode).toBe(200)
    await h.seam.settled()
    expect(managedHooks(h)[0]!.events).toContain('issues')
    expect((await h.a.app.inject({ method: 'DELETE', url: `${ORG}/agents/${second}` })).statusCode).toBe(204)
    await h.seam.settled()
    expect(await bindings()).toHaveLength(1)
    expect(managedHooks(h)).toHaveLength(1)
    expect(managedHooks(h)[0]!.events).not.toContain('issues')
    for (const event of PR_EVENTS) expect(managedHooks(h)[0]!.events).toContain(event)

    // (4) The last referencing trigger leaving does not unbind: the binding and its claim stay for the operator, and
    // the webhook follows §7's inverse — no enabled trigger, no ingress — until the card's Remove releases the claim.
    const firstHookId = (a.json() as { id: string }).id
    expect((await h.a.app.inject({ method: 'DELETE', url: `${ORG}/hooks/${firstHookId}` })).statusCode).toBe(204)
    await h.seam.settled()
    const [row] = await bindings()
    expect(row).toMatchObject({ repoId: REPO, state: 'ready' })
    expect(await claims()).toBe(1)
    expect(managedHooks(h)).toHaveLength(0)
    const listed = await h.a.app.inject({ method: 'GET', url: `${ORG}/gitea/repositories` })
    expect(listed.json()).toMatchObject({ bindings: [{ id: row!.id, webhookState: 'not_needed' }] })
    // Still the first agent's workspace: the operator's Remove is refused until that reference is gone too.
    const held = await h.a.app.inject({ method: 'DELETE', url: `${ORG}/gitea/repositories/${row!.id}` })
    expect(held.statusCode).toBe(409)
    expect((held.json() as { message: string }).message).toContain('the workspace of agent first')
    expect((await h.a.app.inject({ method: 'DELETE', url: `${ORG}/agents/${first}` })).statusCode).toBe(204)
    await h.seam.settled()
    expect(await bindings()).toHaveLength(1)
    const removed = await h.a.app.inject({ method: 'DELETE', url: `${ORG}/gitea/repositories/${row!.id}` })
    expect(removed.statusCode).toBe(200)
    expect(removed.json()).toEqual({ removed: true })
    expect(await bindings()).toHaveLength(0)
    expect(await claims()).toBe(0)
  })

  it('two first uses racing resolve on the claim: one binding, one webhook, the loser adopts the winner', async () => {
    const h = await harness()
    const first = await h.withWorkspace('first')
    const second = await h.withWorkspace('second')
    // The barrier holds every first-use read of the repository until BOTH writers have passed their
    // "is it bound yet?" check, so the critical section is entered by two writers at once and only
    // the claim's uniqueness can tell them apart — not the order the requests happened to arrive in.
    const { arrivals } = barrier(h, REPO)
    const [a, b] = await Promise.all([
      h.a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: trigger(first) }),
      h.a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: trigger(second, ISSUES_TRIGGER) })
    ])
    expect(a.statusCode).toBe(200)
    expect(b.statusCode).toBe(200)
    // Both were inside the window before either wrote.
    expect(arrivals.length).toBeGreaterThanOrEqual(2)
    await h.seam.settled()
    const rows = await bindings()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.state).toBe('ready')
    expect(await claims()).toBe(1)
    expect(managedHooks(h)).toHaveLength(1)
    expect(webhookCreates(h)).toHaveLength(1)
    const hook = managedHooks(h)[0]!
    expect(hook.events).toContain('issues')
    for (const event of PR_EVENTS) expect(hook.events).toContain(event)
    expect(await prisma.hookDef.count({ where: { orgId: DEFAULT_ORG_ID, kind: 'gitea', repoId: REPO } })).toBe(2)

    // The same section at the service: exactly one writer creates, both read the same row.
    barrier(h, SECOND)
    const outcomes = await Promise.all([
      h.seam.bindingService.ensureBound(DEFAULT_ORG_ID, SECOND),
      h.seam.bindingService.ensureBound(DEFAULT_ORG_ID, SECOND)
    ])
    expect(outcomes.filter((outcome) => outcome.created)).toHaveLength(1)
    expect(new Set(outcomes.map((outcome) => outcome.binding.id)).size).toBe(1)
    expect(await prisma.giteaRepositoryBinding.count({ where: { repoId: SECOND } })).toBe(1)
    expect(await prisma.codeHostRepositoryClaim.count({ where: { provider: 'gitea', externalId: SECOND } })).toBe(1)
  })
})

describe('gitea workspaces and grants bind on first use (§6)', () => {
  it('creating an agent on an unbound repository the bot administers binds it; the resolve preview only says so', async () => {
    const h = await harness()
    const address = `${BASE}/example-org/second-repo`
    const preview = await h.a.app.inject({
      method: 'GET',
      url: `${ORG}/git/resolve?gitRepo=${encodeURIComponent(address)}`
    })
    expect(preview.statusCode).toBe(200)
    expect(preview.json()).toMatchObject({ provider: 'gitea', access: 'write', defaultBranch: 'main' })
    // A preview is a read: nothing was bound.
    expect(await bindings()).toHaveLength(0)

    const created = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: {
        name: 'gitea-writer',
        runtime: 'claude',
        workspace: { mode: 'git', gitRepo: address, access: 'write' }
      }
    })
    expect(created.statusCode).toBe(201)
    const dto = created.json() as { workspace: { gitRepo: string; credential?: unknown } }
    expect(dto.workspace.credential).toEqual({ provider: 'gitea', access: 'write', repoId: SECOND.toString() })
    // The clone URL is the catalog row's — the provider's own answer, written by the bind.
    expect(dto.workspace.gitRepo).toBe(`${BASE}/example-org/second-repo.git`)
    await h.seam.settled()
    const rows = await bindings()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ repoId: SECOND, repoPath: 'example-org/second-repo', state: 'ready' })
    // No trigger wants ingress yet, so the bind installed no webhook.
    expect(h.fake.hooks.size).toBe(0)
  })

  it('replacing a workspace binds the repository it moves to', async () => {
    const h = await harness()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: h.daemonId, name: 'mover' })
    const replaced = await h.a.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${agentId}/workspace`,
      payload: { mode: 'git', gitRepo: `${BASE}/example-org/example-repo`, access: 'write' }
    })
    expect(replaced.statusCode).toBe(200)
    expect(replaced.json()).toMatchObject({
      workspace: { mode: 'git', credential: { provider: 'gitea', access: 'write', repoId: REPO.toString() } }
    })
    await h.seam.settled()
    const rows = await bindings()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ repoId: REPO, state: 'ready' })
  })

  it('an additional-repository grant binds the repository it names', async () => {
    const h = await harness()
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: h.daemonId, name: 'granted' })
    const granted = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${agentId}/repos`,
      payload: { provider: 'gitea', repoId: SECOND.toString(), access: 'comment' }
    })
    expect(granted.statusCode).toBe(200)
    expect(granted.json()).toMatchObject({
      provider: 'gitea',
      repoId: SECOND.toString(),
      repoFullName: 'example-org/second-repo'
    })
    await h.seam.settled()
    expect((await bindings())[0]).toMatchObject({ repoId: SECOND, state: 'ready' })
    // Granting it twice is still the grant's own refusal, not a second binding.
    const twice = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${agentId}/repos`,
      payload: { provider: 'gitea', repoId: SECOND.toString(), access: 'comment' }
    })
    expect(twice.statusCode).toBe(409)
    expect((twice.json() as { message: string }).message).toContain('already authorized')
    expect(await bindings()).toHaveLength(1)
  })

  it('the card’s own Add still binds ahead of use and refuses a second Add', async () => {
    const h = await harness()
    const added = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/gitea/repositories`,
      payload: { repoId: SECOND.toString() }
    })
    expect(added.statusCode).toBe(200)
    expect(added.json()).toMatchObject({ repoId: SECOND.toString(), state: 'ready', webhookState: 'not_needed' })
    const again = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/gitea/repositories`,
      payload: { repoId: SECOND.toString() }
    })
    expect(again.statusCode).toBe(409)
    expect((again.json() as { message: string }).message).toContain('already bound')
  })
})

describe('removing a referenced binding (§6)', () => {
  it('is refused with 409 naming the workspace, the grant and the trigger, and succeeds once they are gone', async () => {
    const h = await harness()
    const owner = await h.withWorkspace('owner')
    const hook = await h.a.app.inject({ method: 'POST', url: `${ORG}/hooks`, payload: trigger(owner) })
    expect(hook.statusCode).toBe(200)
    const reader = randomUUID()
    await seedAgent(prisma, reader, { daemonId: h.daemonId, name: 'reader' })
    const grant = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${reader}/repos`,
      payload: { provider: 'gitea', repoId: REPO.toString(), access: 'read' }
    })
    expect(grant.statusCode).toBe(200)
    await h.seam.settled()
    const [row] = await bindings()

    const refused = await h.a.app.inject({ method: 'DELETE', url: `${ORG}/gitea/repositories/${row!.id}` })
    expect(refused.statusCode).toBe(409)
    const body = refused.json() as { message: string; code: string }
    expect(body.code).toBe('repository_in_use')
    expect(body.message).toContain('example-org/example-repo is still in use')
    expect(body.message).toContain('the workspace of agent owner')
    expect(body.message).toContain('an additional repository of agent reader')
    expect(body.message).toContain('trigger “example-org/example-repo” of agent owner')
    // Nothing was touched: the webhook and the claim stand.
    expect(managedHooks(h)).toHaveLength(1)
    expect(await claims()).toBe(1)

    const grantId = (grant.json() as { id: string }).id
    const hookId = (hook.json() as { id: string }).id
    expect(
      (await h.a.app.inject({ method: 'DELETE', url: `${ORG}/agents/${reader}/repos/${grantId}` })).statusCode
    ).toBe(204)
    expect((await h.a.app.inject({ method: 'DELETE', url: `${ORG}/hooks/${hookId}` })).statusCode).toBe(204)
    const ownerGone = await h.a.app.inject({ method: 'DELETE', url: `${ORG}/agents/${owner}` })
    expect(ownerGone.statusCode, ownerGone.body).toBe(204)
    await h.seam.settled()
    const removed = await h.a.app.inject({ method: 'DELETE', url: `${ORG}/gitea/repositories/${row!.id}` })
    expect(removed.statusCode).toBe(200)
    expect(removed.json()).toEqual({ removed: true })
    expect(await bindings()).toHaveLength(0)
    expect(await claims()).toBe(0)
    expect(managedHooks(h)).toHaveLength(0)
  })
})

describe('the reference fence (§6)', () => {
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  /** Settles to 'blocked' unless `run` finishes first — the probe that a lock is really held against it. */
  const raced = (run: Promise<unknown>) =>
    Promise.race([
      run.then(
        () => 'finished',
        () => 'finished'
      ),
      sleep(400).then(() => 'blocked')
    ])
  const hookRow = (agentId: string) => ({
    id: randomUUID(),
    orgId: DEFAULT_ORG_ID,
    agentId,
    kind: 'gitea' as const,
    name: 'late',
    sessionMode: 'perThread' as const,
    repoId: REPO,
    repoFullName: 'example-org/example-repo',
    family: 'merge_request',
    events: ['merge_request:*']
  })

  it('a removal waits for an in-flight reference commit and is then refused by it', async () => {
    const h = await harness()
    const { binding } = await h.seam.bindingService.ensureBound(DEFAULT_ORG_ID, REPO)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: h.daemonId, name: 'writer' })
    // A writer has passed the fence and inserted its trigger, but has not committed yet.
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const writer = prisma.$transaction(
      async (tx) => {
        await joinGiteaBindingFence(tx, DEFAULT_ORG_ID, REPO)
        await tx.hookDef.create({ data: hookRow(agentId) })
        await held
      },
      { timeout: 15_000 }
    )
    await sleep(200)
    // The removal cannot count past the writer's shared lock; once it can, the reference is there.
    const removal = h.seam.bindings.beginCleanup(DEFAULT_ORG_ID, binding.id, REPO, new Date(clock.now()), {
      unlessReferenced: true
    })
    expect(await raced(removal)).toBe('blocked')
    release()
    await writer
    expect(await removal).toBe('referenced')
    expect((await h.seam.bindings.get(DEFAULT_ORG_ID, binding.id))!.state).toBe('ready')
    expect(await claims()).toBe(1)
  })

  it('a reference write behind a removal waits for it and is refused once the binding is parked', async () => {
    const h = await harness()
    await h.seam.bindingService.ensureBound(DEFAULT_ORG_ID, REPO)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: h.daemonId, name: 'late' })
    // A removal holds the claim exclusively, about to park it.
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const remover = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "code_host_repository_claim" WHERE "provider" = 'gitea' AND "externalId" = ${REPO.toString()}::bigint FOR UPDATE`
        await held
        await tx.codeHostRepositoryClaim.updateMany({
          where: { provider: 'gitea', externalId: REPO },
          data: { state: 'cleanup_pending' }
        })
      },
      { timeout: 15_000 }
    )
    await sleep(200)
    const grant = new PgAgentRepoAuthorizationRepo(prisma).create({
      agentId: AgentId(agentId),
      provider: 'gitea',
      repoId: REPO,
      repoFullName: 'example-org/example-repo',
      access: 'read'
    })
    // The grant waits on the exclusive lock, then re-reads a parked binding and refuses.
    expect(await raced(grant)).toBe('blocked')
    release()
    await remover
    await expect(grant).rejects.toBeInstanceOf(GiteaBindingUnavailable)
    expect(await prisma.agentRepoAuthorization.count({ where: { provider: 'gitea', repoId: REPO } })).toBe(0)
  })

  it('the trigger, workspace and grant writes all refuse a parked binding', async () => {
    const h = await harness()
    const { binding } = await h.seam.bindingService.ensureBound(DEFAULT_ORG_ID, REPO)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: h.daemonId, name: 'parked-out' })
    expect(await h.seam.bindings.beginCleanup(DEFAULT_ORG_ID, binding.id, REPO, new Date(clock.now()))).toBe('parked')
    await expect(
      new PgHookRepo(prisma).upsert({
        hookId: HookId(randomUUID()),
        orgId: OrgId(DEFAULT_ORG_ID),
        agentId: AgentId(agentId),
        kind: 'gitea',
        name: 'late',
        sessionMode: 'perThread',
        axisBaseUrl: BASE,
        repoId: REPO,
        repoFullName: 'example-org/example-repo',
        family: 'merge_request',
        events: ['merge_request:*']
      })
    ).rejects.toBeInstanceOf(GiteaBindingUnavailable)
    const agents = new PgAgentRepo(prisma)
    const agent = (await agents.get(OrgId(DEFAULT_ORG_ID), AgentId(agentId)))!
    const giteaWorkspace = {
      mode: 'git' as const,
      isolation: 'shared' as const,
      gitRepo: `${BASE}/example-org/example-repo.git`,
      credential: { provider: 'gitea' as const, access: 'write' as const }
    }
    await expect(
      agents.setWorkspace(OrgId(DEFAULT_ORG_ID), agent.id, agent.lastModifiedAt, 'scratch', giteaWorkspace, REPO)
    ).rejects.toBeInstanceOf(GiteaBindingUnavailable)
    // A rollback onto the old gitea workspace is a reference too: it fails closed rather than reviving the binding's authority.
    await expect(
      agents.restoreWorkspace(
        OrgId(DEFAULT_ORG_ID),
        agent.id,
        agent.lastModifiedAt,
        agent.workspace,
        agent.workspaceRepoId,
        giteaWorkspace,
        REPO
      )
    ).rejects.toBeInstanceOf(GiteaBindingUnavailable)
    expect((await agents.get(OrgId(DEFAULT_ORG_ID), AgentId(agentId)))!.workspace.mode).toBe('scratch')
    await expect(
      new PgAgentRepoAuthorizationRepo(prisma).create({
        agentId: AgentId(agentId),
        provider: 'gitea',
        repoId: REPO,
        repoFullName: 'example-org/example-repo',
        access: 'read'
      })
    ).rejects.toBeInstanceOf(GiteaBindingUnavailable)
    expect(await prisma.hookDef.count({ where: { orgId: DEFAULT_ORG_ID, kind: 'gitea', repoId: REPO } })).toBe(0)
    // The route answers the same refusal as a 409, not a 500.
    const viaRoute = await h.a.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${agentId}/repos`,
      payload: { provider: 'gitea', repoId: REPO.toString(), access: 'read' }
    })
    expect(viaRoute.statusCode).toBe(409)
  })
})
