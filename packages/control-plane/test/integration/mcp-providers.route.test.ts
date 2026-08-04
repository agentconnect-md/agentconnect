/**
 * MCP provider routes — the referenced-guard on DELETE. Agents bind a provider by
 * NAME (`runtimeOverrides.mcpServers`), so deleting a provider that agents still
 * enable would leave dangling selectors that silently re-bind to any future provider
 * recreated under the same name. DELETE must 409 while referenced (same rule as
 * skill-source delete) and go through once every agent has unselected it.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
})

function makeApp(): HttpApp {
  const app = buildHttpApp(prisma)
  opened.push(app)
  return app
}

/** Provision a user + add them to the default org with a role; returns their id. */
async function makeUser(sub: string, role: OrgMemberRole): Promise<string> {
  const email = `${sub}@acme.dev`
  const { userId } = await new PgUserRepo(prisma).provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await new PgUserRepo(prisma).addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

/** An app whose devAuth principal is `userId` — i.e. "act as this user". The
 *  provider-name chains are module-global, so they serialize across app instances. */
function appAs(userId: string): HttpApp {
  const app = buildHttpApp(prisma, { DEFAULT_OWNER_ID: userId })
  opened.push(app)
  return app
}

async function createProvider(app: HttpApp, name: string): Promise<string> {
  const res = await app.app.inject({
    method: 'POST',
    url: `${ORG}/mcp-providers`,
    payload: { name, url: 'https://mcp.example.com/mcp' }
  })
  expect(res.statusCode).toBe(201)
  return res.json().id as string
}

async function createAgent(app: HttpApp, name: string, mcpServers: string[]): Promise<string> {
  const res = await app.app.inject({
    method: 'POST',
    url: `${ORG}/agents`,
    payload: { name, runtime: 'claude', mcpServers }
  })
  expect(res.statusCode).toBe(201)
  return res.json().id as string
}

describe('DELETE /mcp-providers/:id — referenced-guard', () => {
  it('409s while an agent still enables the provider; deletes once unselected', async () => {
    const app = makeApp()
    const providerId = await createProvider(app, 'linear')
    const agentId = await createAgent(app, 'enabler', ['linear'])

    const blocked = await app.app.inject({ method: 'DELETE', url: `${ORG}/mcp-providers/${providerId}` })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().message).toBe('mcp provider is still enabled by one or more agents; unselect it there first')

    // The row survives the refused delete — nothing was unbound or cascade-dropped.
    const still = await app.app.inject({ method: 'GET', url: `${ORG}/mcp-providers/${providerId}` })
    expect(still.statusCode).toBe(200)

    // Unselect from the agent, then the delete goes through.
    const patch = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { mcpServers: [] }
    })
    expect(patch.statusCode).toBe(200)

    const freed = await app.app.inject({ method: 'DELETE', url: `${ORG}/mcp-providers/${providerId}` })
    expect(freed.statusCode).toBe(204)
    const gone = await app.app.inject({ method: 'GET', url: `${ORG}/mcp-providers/${providerId}` })
    expect(gone.statusCode).toBe(404)
  })

  it('creating a provider under a name an agent already enables is refused (name-capture guard)', async () => {
    // The mirror image of the delete guard: agents bind by NAME, so a new provider
    // under an enabled name would silently capture those agents' sessions onto its
    // upstream. Refuse while referenced — under a different name creation is fine.
    const app = makeApp()
    await createAgent(app, 'local-user', ['linear'])

    const captured = await app.app.inject({
      method: 'POST',
      url: `${ORG}/mcp-providers`,
      payload: { name: 'linear', url: 'https://mcp.example.com/mcp' }
    })
    expect(captured.statusCode).toBe(409)

    const other = await app.app.inject({
      method: 'POST',
      url: `${ORG}/mcp-providers`,
      payload: { name: 'linear-2', url: 'https://mcp.example.com/mcp' }
    })
    expect(other.statusCode).toBe(201)
  })

  it('only an exact name match blocks — daemon-local server names on agents do not', async () => {
    const app = makeApp()
    const providerId = await createProvider(app, 'linear')
    // A daemon-configured (non-registry) MCP name carries no provider visibility and
    // must not pin an unrelated provider's lifetime.
    await createAgent(app, 'other-enabler', ['local-tools'])

    const res = await app.app.inject({ method: 'DELETE', url: `${ORG}/mcp-providers/${providerId}` })
    expect(res.statusCode).toBe(204)
  })

  it('deleting an agent releases its reference', async () => {
    const app = makeApp()
    const providerId = await createProvider(app, 'notion')
    const agentId = await createAgent(app, 'short-lived', ['notion'])

    expect((await app.app.inject({ method: 'DELETE', url: `${ORG}/mcp-providers/${providerId}` })).statusCode).toBe(409)

    const drop = await app.app.inject({ method: 'DELETE', url: `${ORG}/agents/${agentId}` })
    expect(drop.statusCode).toBe(204)

    expect((await app.app.inject({ method: 'DELETE', url: `${ORG}/mcp-providers/${providerId}` })).statusCode).toBe(204)
  })
})

/**
 * Park the DELETE inside its serialized reference check by intercepting the FIRST
 * `agent.list` call (that check is the first caller during the delete; later calls —
 * e.g. pushUnassign's daemon fan-out — pass through). Returns a release() that lets
 * the delete proceed, plus a promise that resolves once the delete is parked.
 */
function parkDeleteAtReferenceCheck(app: HttpApp) {
  const repo = app.deps.repos.agent
  const realList = repo.list.bind(repo)
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let notifyParked!: () => void
  const parked = new Promise<void>((r) => (notifyParked = r))
  let intercepted = false
  repo.list = async (orgId) => {
    if (!intercepted) {
      intercepted = true
      notifyParked()
      await gate
    }
    return realList(orgId)
  }
  return { release, parked }
}

const settleTick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('DELETE /mcp-providers/:id — serialized against agent enable-list writes', () => {
  it('an agent CREATE adding the name waits out the delete instead of slipping into its check→drop window', async () => {
    const app = makeApp()
    const providerId = await createProvider(app, 'linear')
    const { release, parked } = parkDeleteAtReferenceCheck(app)

    const del = app.app.inject({ method: 'DELETE', url: `${ORG}/mcp-providers/${providerId}` })
    await parked

    // Regression (the pre-fix bug): with the check outside the chain, this create
    // completed DURING the parked window and the delete still returned 204, leaving
    // the dangling selector. Now the write joins the provider's chain and must block.
    const create = app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'racer', runtime: 'claude', mcpServers: ['linear'] }
    })
    const winner = await Promise.race([
      create.then(() => 'created' as const),
      settleTick(300).then(() => 'blocked' as const)
    ])
    expect(winner).toBe('blocked')

    release()
    // The delete saw no reference (the write was queued behind it) — it completes;
    // the create then lands with 'linear' as a plain daemon-local name (no registry row).
    expect((await del).statusCode).toBe(204)
    expect((await create).statusCode).toBe(201)
    expect((await app.app.inject({ method: 'GET', url: `${ORG}/mcp-providers/${providerId}` })).statusCode).toBe(404)
  })

  it('an agent PATCH adding the name waits out the delete the same way', async () => {
    const app = makeApp()
    const providerId = await createProvider(app, 'linear')
    const agentId = await createAgent(app, 'patch-racer', [])
    const { release, parked } = parkDeleteAtReferenceCheck(app)

    const del = app.app.inject({ method: 'DELETE', url: `${ORG}/mcp-providers/${providerId}` })
    await parked

    const patch = app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { mcpServers: ['linear'] }
    })
    const winner = await Promise.race([
      patch.then(() => 'patched' as const),
      settleTick(300).then(() => 'blocked' as const)
    ])
    expect(winner).toBe('blocked')

    release()
    expect((await del).statusCode).toBe(204)
    expect((await patch).statusCode).toBe(200)
  })

  it('a stale full-replace PATCH re-asserting the name still fences the delete (no diff-based bypass)', async () => {
    // Ordinary PATCHes overlap: PATCH-A submits ['linear'] (unchanged from ITS
    // snapshot), parks before persisting; PATCH-B removes 'linear'; DELETE then runs.
    // With an added-vs-before diff the parked PATCH-A computed added=[] and skipped
    // the chain, so DELETE saw B's empty list, returned 204, and A restored the name
    // onto a deleted provider. Keyed off the SUBMITTED list, A holds the chain while
    // parked — the DELETE queues behind it and 409s once A's restore commits.
    const app = makeApp()
    const providerId = await createProvider(app, 'linear')
    const agentId = await createAgent(app, 'stale-patcher', ['linear'])

    // Park the FIRST agent-row write (PATCH-A's persist step) inside whatever fences
    // the route takes; later writes (PATCH-B) pass through.
    const writer = app.deps.repos.agentConfig
    const realUpdate = writer.update.bind(writer)
    let releaseA!: () => void
    const gateA = new Promise<void>((r) => (releaseA = r))
    let notifyParkedA!: () => void
    const parkedA = new Promise<void>((r) => (notifyParkedA = r))
    let intercepted = false
    writer.update = async (...args: Parameters<typeof realUpdate>) => {
      if (!intercepted) {
        intercepted = true
        notifyParkedA()
        await gateA
      }
      return realUpdate(...args)
    }

    const patchA = app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { mcpServers: ['linear'] } // full replace, "unchanged" from A's stale view
    })
    await parkedA

    const patchB = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { mcpServers: [] }
    })
    expect(patchB.statusCode).toBe(200)

    const del = app.app.inject({ method: 'DELETE', url: `${ORG}/mcp-providers/${providerId}` })
    const winner = await Promise.race([
      del.then(() => 'deleted' as const),
      settleTick(300).then(() => 'blocked' as const)
    ])
    expect(winner).toBe('blocked') // the delete waits behind the parked PATCH-A's chain hold

    releaseA()
    expect((await patchA).statusCode).toBe(200)
    expect((await del).statusCode).toBe(409) // A's restore committed first — the reference is seen
    expect((await app.app.inject({ method: 'GET', url: `${ORG}/mcp-providers/${providerId}` })).statusCode).toBe(200)
  })

  it('a same-name provider re-create cannot slip between a delete and a queued agent write (name-keyed fence)', async () => {
    // The chains are keyed by (orgId, NAME) — the durable binding key — not the row
    // id: an id-keyed chain dies with the deleted row, so a replacement provider
    // created under the same name could commit inside the window while an agent
    // write (queued behind the old row's delete) still holds a stale authorization.
    // Ordering under the fence: DELETE 204 → the queued agent write commits the name
    // (daemon-local at that instant) → the re-create queues behind it and is then
    // REFUSED by the name-capture guard. No silent rebind.
    const app = makeApp()
    const providerId = await createProvider(app, 'linear')
    const { release, parked } = parkDeleteAtReferenceCheck(app)

    const del = app.app.inject({ method: 'DELETE', url: `${ORG}/mcp-providers/${providerId}` })
    await parked

    // Park the queued agent writer at its persist step (INSIDE the name chain) so
    // the recreate window between delete-commit and write-commit is held open.
    const writer = app.deps.repos.agentConfig
    const realCreate = writer.create.bind(writer)
    let releaseWriter!: () => void
    const writerGate = new Promise<void>((r) => (releaseWriter = r))
    let notifyWriterParked!: () => void
    const writerParked = new Promise<void>((r) => (notifyWriterParked = r))
    writer.create = async (...args: Parameters<typeof realCreate>) => {
      notifyWriterParked()
      await writerGate
      return realCreate(...args)
    }
    const create = app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'window-racer', runtime: 'claude', mcpServers: ['linear'] }
    })

    release()
    expect((await del).statusCode).toBe(204)
    await writerParked // the writer now holds the name chain, pre-commit

    const recreate = app.app.inject({
      method: 'POST',
      url: `${ORG}/mcp-providers`,
      payload: { name: 'linear', url: 'https://mcp.example.com/mcp' }
    })
    const winner = await Promise.race([
      recreate.then(() => 'created' as const),
      settleTick(300).then(() => 'blocked' as const)
    ])
    expect(winner).toBe('blocked') // the same-name create queues behind the held chain

    releaseWriter()
    expect((await create).statusCode).toBe(201)
    expect((await recreate).statusCode).toBe(409) // …and is then refused: the agent holds the name
  })

  it('a restricted same-name replacement is not grandfathered by a stale full-replace PATCH (identity-keyed exemption)', async () => {
    // The keep-exemption must attach to the provider ROW the caller held, not the
    // name: org-visible A is enabled; A's delete parks; a RESTRICTED replacement B
    // and a stale full-replace PATCH queue behind it; a concurrent removal frees the
    // delete. B then commits — and the stale PATCH must NOT ride its old "kept name"
    // exemption onto B (a provider the collaborator cannot even see): the in-fence
    // check re-resolves the name, sees B ≠ its snapshot A, and refuses with 403.
    const owner = await makeUser('mcpp-owner', 'owner')
    const collab = await makeUser('mcpp-collab', 'collaborator')
    const ownerApp = appAs(owner)
    const collabApp = appAs(collab)

    const providerA = await createProvider(ownerApp, 'linear')
    const agentId = await createAgent(collabApp, 'identity-racer', ['linear'])

    const { release, parked } = parkDeleteAtReferenceCheck(ownerApp)
    const del = ownerApp.app.inject({ method: 'DELETE', url: `${ORG}/mcp-providers/${providerA}` })
    await parked

    const bCreate = ownerApp.app.inject({
      method: 'POST',
      url: `${ORG}/mcp-providers`,
      payload: { name: 'linear', url: 'https://mcp.example.com/mcp', visibility: 'restricted', sharedWith: [owner] }
    })
    await settleTick(150)
    const stalePatch = collabApp.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { mcpServers: ['linear'] } // full replace — "unchanged" from its stale view of A
    })
    await settleTick(150)
    // A concurrent removal (submits no registry name → joins no chain) frees the delete.
    const removal = await collabApp.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { mcpServers: [] }
    })
    expect(removal.statusCode).toBe(200)

    release()
    expect((await del).statusCode).toBe(204)
    expect((await bCreate).statusCode).toBe(201) // replacement B exists, restricted
    expect((await stalePatch).statusCode).toBe(403) // the exemption died with A; B is invisible

    const agent = (await collabApp.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}` })).json()
    expect(agent.mcpServers).toEqual([]) // never bound to the invisible replacement
  })

  it('a replacement completed between the route-entry read and the fence cannot become the grandfather baseline', async () => {
    // The keep-exemption derives from the agent's COMMITTED enable-list read inside
    // the fence, never from request-time snapshots: here the stale PATCH captures
    // `before=['linear']` (bound to org-visible A) and then parks BEFORE any other
    // read; a removal, A's delete, and a restricted same-name replacement B all
    // complete during the pause. On resume, both a name match and an identity
    // snapshot would say "kept" (everything now resolves to B) — but the committed
    // list no longer holds the name, so the enable is fresh and B is invisible → 403.
    const owner = await makeUser('mcpb-owner', 'owner')
    const collab = await makeUser('mcpb-collab', 'collaborator')
    const ownerApp = appAs(owner)
    const collabApp = appAs(collab)

    const providerA = await createProvider(ownerApp, 'linear')
    const agentId = await createAgent(collabApp, 'baseline-racer', ['linear'])

    // Park the stale PATCH right after its optimistic-CAS re-read (the SECOND
    // agent.get: #1 is the route-entry getOrgAgent, #2 refreshMutationAgent) — the
    // last read before the fence. The CAS row is captured pre-mutation, so the CAS
    // passes on stale data and cannot save us; only the in-fence committed read can.
    const repo = collabApp.deps.repos.agent
    const realGet = repo.get.bind(repo)
    let releaseGet!: () => void
    const gate = new Promise<void>((r) => (releaseGet = r))
    let notifyParked!: () => void
    const parked = new Promise<void>((r) => (notifyParked = r))
    let calls = 0
    repo.get = async (id) => {
      const row = await realGet(id)
      if (++calls === 2) {
        notifyParked()
        await gate
      }
      return row
    }
    const stalePatch = collabApp.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { mcpServers: ['linear'] }
    })
    await parked

    // While it sleeps: the reference is removed, A is deleted, restricted B lands.
    expect(
      (await collabApp.app.inject({ method: 'PATCH', url: `${ORG}/agents/${agentId}`, payload: { mcpServers: [] } }))
        .statusCode
    ).toBe(200)
    expect((await ownerApp.app.inject({ method: 'DELETE', url: `${ORG}/mcp-providers/${providerA}` })).statusCode).toBe(
      204
    )
    const bCreate = await ownerApp.app.inject({
      method: 'POST',
      url: `${ORG}/mcp-providers`,
      payload: { name: 'linear', url: 'https://mcp.example.com/mcp', visibility: 'restricted', sharedWith: [owner] }
    })
    expect(bCreate.statusCode).toBe(201)

    releaseGet()
    expect((await stalePatch).statusCode).toBe(403) // committed list holds nothing — B is a fresh, invisible enable
    const agent = (await collabApp.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}` })).json()
    expect(agent.mcpServers).toEqual([])
  })

  it('a removal committed between the fence and the row write cannot revive the hold exemption (row-locked authorize)', async () => {
    // The hold decision is evaluated INSIDE the agent-row-locked update transaction,
    // against the committed list that write merges onto. A removal-only PATCH joins
    // no provider-name chain, so it CAN commit inside the fence-to-write window —
    // and any hold read taken earlier in the fence would wrongly keep exempting the
    // stale writer. Here: restricted 'linear' held by an org-visible agent; the
    // collaborator's stale full-replace PATCH parks just before its row update; the
    // owner's removal commits; on resume the row-locked read shows nothing held,
    // so re-adding the invisible provider is refused.
    const owner = await makeUser('mcph-owner', 'owner')
    const collab = await makeUser('mcph-collab', 'collaborator')
    const ownerApp = appAs(owner)
    const collabApp = appAs(collab)

    const created = await ownerApp.app.inject({
      method: 'POST',
      url: `${ORG}/mcp-providers`,
      payload: { name: 'linear', url: 'https://mcp.example.com/mcp', visibility: 'restricted', sharedWith: [owner] }
    })
    expect(created.statusCode).toBe(201)
    const agentId = await createAgent(ownerApp, 'held-agent', ['linear'])

    const writer = collabApp.deps.repos.agentConfig
    const realUpdate = writer.update.bind(writer)
    let releaseWriter!: () => void
    const gate = new Promise<void>((r) => (releaseWriter = r))
    let notifyParked!: () => void
    const parked = new Promise<void>((r) => (notifyParked = r))
    writer.update = async (...args: Parameters<typeof realUpdate>) => {
      notifyParked()
      await gate
      return realUpdate(...args)
    }
    const stalePatch = collabApp.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { mcpServers: ['linear'] } // full replace — "unchanged" from its stale view
    })
    await parked

    // The removal joins no chain — it lands inside the fence-to-write window.
    expect(
      (await ownerApp.app.inject({ method: 'PATCH', url: `${ORG}/agents/${agentId}`, payload: { mcpServers: [] } }))
        .statusCode
    ).toBe(200)

    releaseWriter()
    expect((await stalePatch).statusCode).toBe(403) // row-locked read: nothing held; 'linear' is invisible
    const agent = (await ownerApp.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}` })).json()
    expect(agent.mcpServers).toEqual([])
  })

  it('a sharing flip queues behind an in-flight enable (no check-to-commit visibility race)', async () => {
    // PUT /mcp-providers/:id/sharing joins the name chain: an agent write authorizes
    // visibility INSIDE that chain, so a restrict must not land between its check
    // and its commit. Park the enable at its persist step (in-fence, post-check) and
    // assert the sharing flip waits for it.
    const app = makeApp()
    const providerId = await createProvider(app, 'linear')
    const agentId = await createAgent(app, 'share-racer', [])

    const writer = app.deps.repos.agentConfig
    const realUpdate = writer.update.bind(writer)
    let releaseWriter!: () => void
    const gate = new Promise<void>((r) => (releaseWriter = r))
    let notifyParked!: () => void
    const parked = new Promise<void>((r) => (notifyParked = r))
    let intercepted = false
    writer.update = async (...args: Parameters<typeof realUpdate>) => {
      if (!intercepted) {
        intercepted = true
        notifyParked()
        await gate
      }
      return realUpdate(...args)
    }
    const enable = app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { mcpServers: ['linear'] }
    })
    await parked

    const share = app.app.inject({
      method: 'PUT',
      url: `${ORG}/mcp-providers/${providerId}/sharing`,
      payload: { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
    })
    const winner = await Promise.race([
      share.then(() => 'shared' as const),
      settleTick(300).then(() => 'blocked' as const)
    ])
    expect(winner).toBe('blocked') // the flip waits behind the in-flight enable

    releaseWriter()
    expect((await enable).statusCode).toBe(200)
    expect((await share).statusCode).toBe(200)
  })

  it('a sibling-field PATCH omitting mcpServers cannot restore a concurrently-removed name (atomic bag merge)', async () => {
    // runtimeOverrides is ONE JsonB bag, so a model-only PATCH re-writes the whole
    // bag from what it read. Unlocked, it could carry a stale mcpServers key back
    // after another PATCH removed it — behind the DELETE guard's back and without
    // ever joining a provider chain (it submits no mcpServers). The repo now
    // row-locks the bag read (FOR UPDATE), so bag writers fully serialize and the
    // sibling PATCH merges onto the post-removal bag. An external row lock parks
    // BOTH patches at their bag read so they queue and serialize behind it.
    const app = makeApp()
    const providerId = await createProvider(app, 'linear')
    const agentId = await createAgent(app, 'sibling-racer', ['linear'])

    let releaseRow!: () => void
    const rowHeld = new Promise<void>((r) => (releaseRow = r))
    let rowLocked!: () => void
    const lockedRow = new Promise<void>((r) => (rowLocked = r))
    const externalLock = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "agent" WHERE "id" = ${agentId} FOR UPDATE`
        rowLocked()
        await rowHeld
      },
      { timeout: 20_000 }
    )
    await lockedRow

    const removal = app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { mcpServers: [] }
    })
    await settleTick(250)
    const sibling = app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { model: 'stale-sibling' }
    })
    await settleTick(250)

    releaseRow()
    await externalLock
    expect((await removal).statusCode).toBe(200)
    expect((await sibling).statusCode).toBe(200)

    const agent = (await app.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}` })).json()
    expect(agent.model).toBe('stale-sibling')
    expect(agent.mcpServers).toEqual([]) // the omitted key did NOT restore 'linear'
    expect((await app.app.inject({ method: 'DELETE', url: `${ORG}/mcp-providers/${providerId}` })).statusCode).toBe(204)
  })
})
