/**
 * Skill-source routes — the referenced-guard on DELETE and its (orgId, name)
 * lifecycle fence. Agents bind a source by NAME (every enable-ref is
 * "<source>/<skill>" / "<source>/*" / "<source>"), so deleting a source that
 * agents still enable would leave dangling selectors that silently re-bind to any
 * future source recreated under the same name. DELETE must 409 while referenced
 * (same rule as MCP-provider delete), create must refuse a referenced name
 * (name-capture guard), and agent enable-list writes serialize with both.
 *
 * One skills-specific difference from the MCP-provider fence: a skill-ref has no
 * daemon-local fallback — the in-fence visibility check refuses a NEW ref whose
 * source is unknown, so an agent write queued behind a delete is refused (403)
 * rather than committing a dangling ref. Dangling refs can therefore only predate
 * the fence (or bypass the routes); the capture guard still protects those.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'
import { AgentId, OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

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
 *  source-name chains are module-global, so they serialize across app instances. */
function appAs(userId: string): HttpApp {
  const app = buildHttpApp(prisma, { DEFAULT_OWNER_ID: userId })
  opened.push(app)
  return app
}

async function createSource(app: HttpApp, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await app.app.inject({
    method: 'POST',
    url: `${ORG}/skill-sources`,
    payload: { name, source: 'example-org/example-kit', ...extra }
  })
  expect(res.statusCode).toBe(201)
  return res.json().id as string
}

async function createAgent(app: HttpApp, name: string, skills: string[]): Promise<string> {
  const res = await app.app.inject({
    method: 'POST',
    url: `${ORG}/agents`,
    payload: { name, runtime: 'claude', skills }
  })
  expect(res.statusCode).toBe(201)
  return res.json().id as string
}

describe('DELETE /skill-sources/:id — referenced-guard', () => {
  it('409s while an agent still enables the source; deletes once unselected', async () => {
    const app = makeApp()
    const sourceId = await createSource(app, 'kit')
    const agentId = await createAgent(app, 'enabler', ['kit/helper'])

    const blocked = await app.app.inject({ method: 'DELETE', url: `${ORG}/skill-sources/${sourceId}` })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().message).toBe('skill source is still enabled by one or more agents; unselect it there first')

    // The row survives the refused delete.
    const still = await app.app.inject({ method: 'GET', url: `${ORG}/skill-sources/${sourceId}` })
    expect(still.statusCode).toBe(200)

    // Unselect from the agent, then the delete goes through.
    const patch = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { skills: [] }
    })
    expect(patch.statusCode).toBe(200)

    const freed = await app.app.inject({ method: 'DELETE', url: `${ORG}/skill-sources/${sourceId}` })
    expect(freed.statusCode).toBe(204)
    const gone = await app.app.inject({ method: 'GET', url: `${ORG}/skill-sources/${sourceId}` })
    expect(gone.statusCode).toBe(404)
  })

  it('creating a source under a name an agent already references is refused (name-capture guard)', async () => {
    // The mirror image of the delete guard: agents bind by NAME, so a new source
    // under a referenced name would capture those agents' installs onto its
    // content. The route surface can no longer mint a dangling ref (the in-fence
    // check refuses unknown sources), so seed one through the repo layer — the
    // shape pre-fence data (or non-route writers) can leave behind.
    const app = makeApp()
    await app.deps.repos.agent.create({
      id: AgentId(randomUUID()),
      orgId: OrgId(DEFAULT_ORG_ID),
      name: 'ghost-holder',
      runtime: 'claude',
      skills: ['ghost/helper']
    })

    const captured = await app.app.inject({
      method: 'POST',
      url: `${ORG}/skill-sources`,
      payload: { name: 'ghost', source: 'example-org/example-kit' }
    })
    expect(captured.statusCode).toBe(409)

    const other = await app.app.inject({
      method: 'POST',
      url: `${ORG}/skill-sources`,
      payload: { name: 'ghost-2', source: 'example-org/example-kit' }
    })
    expect(other.statusCode).toBe(201)
  })

  it('only an exact source-name match blocks — refs to a different source do not', async () => {
    const app = makeApp()
    const sourceId = await createSource(app, 'kit')
    await createSource(app, 'toolbox')
    await createAgent(app, 'other-enabler', ['toolbox/helper'])

    const res = await app.app.inject({ method: 'DELETE', url: `${ORG}/skill-sources/${sourceId}` })
    expect(res.statusCode).toBe(204)
  })

  it('deleting an agent releases its reference', async () => {
    const app = makeApp()
    const sourceId = await createSource(app, 'notes')
    const agentId = await createAgent(app, 'short-lived', ['notes/*'])

    expect((await app.app.inject({ method: 'DELETE', url: `${ORG}/skill-sources/${sourceId}` })).statusCode).toBe(409)

    const drop = await app.app.inject({ method: 'DELETE', url: `${ORG}/agents/${agentId}` })
    expect(drop.statusCode).toBe(204)

    expect((await app.app.inject({ method: 'DELETE', url: `${ORG}/skill-sources/${sourceId}` })).statusCode).toBe(204)
  })
})

/**
 * Park the DELETE inside its serialized reference check by intercepting the FIRST
 * `agent.list` call (that check is the first caller during the delete; later calls
 * pass through). Returns a release() that lets the delete proceed, plus a promise
 * that resolves once the delete is parked.
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

describe('DELETE /skill-sources/:id — serialized against agent enable-list writes', () => {
  it('an agent CREATE adding a ref waits out the delete; it is refused rather than committing a dangling ref', async () => {
    const app = makeApp()
    const sourceId = await createSource(app, 'kit')
    const { release, parked } = parkDeleteAtReferenceCheck(app)

    const del = app.app.inject({ method: 'DELETE', url: `${ORG}/skill-sources/${sourceId}` })
    await parked

    // Regression (the pre-fix bug): with the check outside the chain, this create
    // completed DURING the parked window and the delete still returned 204, leaving
    // the dangling selector. Now the write joins the source's chain and must block.
    const create = app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'racer', runtime: 'claude', skills: ['kit/helper'] }
    })
    const winner = await Promise.race([
      create.then(() => 'created' as const),
      settleTick(300).then(() => 'blocked' as const)
    ])
    expect(winner).toBe('blocked')

    release()
    // The delete saw no reference (the write was queued behind it) — it completes;
    // the queued create then re-checks visibility INSIDE the fence, finds the
    // source gone, and is refused: no dangling ref is ever committed.
    expect((await del).statusCode).toBe(204)
    expect((await create).statusCode).toBe(403)
    expect((await app.app.inject({ method: 'GET', url: `${ORG}/skill-sources/${sourceId}` })).statusCode).toBe(404)
    // Nothing holds the name, so a replacement source can be registered cleanly —
    // with no captured selections anywhere.
    const recreate = await app.app.inject({
      method: 'POST',
      url: `${ORG}/skill-sources`,
      payload: { name: 'kit', source: 'example-org/example-kit' }
    })
    expect(recreate.statusCode).toBe(201)
  })

  it('an agent PATCH adding a ref waits out the delete the same way', async () => {
    const app = makeApp()
    const sourceId = await createSource(app, 'kit')
    const agentId = await createAgent(app, 'patch-racer', [])
    const { release, parked } = parkDeleteAtReferenceCheck(app)

    const del = app.app.inject({ method: 'DELETE', url: `${ORG}/skill-sources/${sourceId}` })
    await parked

    const patch = app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { skills: ['kit/helper'] }
    })
    const winner = await Promise.race([
      patch.then(() => 'patched' as const),
      settleTick(300).then(() => 'blocked' as const)
    ])
    expect(winner).toBe('blocked')

    release()
    expect((await del).statusCode).toBe(204)
    expect((await patch).statusCode).toBe(403) // the source is gone — the ref is refused, never dangling
    const agent = (await app.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}` })).json()
    expect(agent.skills).toEqual([])
  })

  it('a stale full-replace PATCH re-asserting a ref still fences the delete (no diff-based bypass)', async () => {
    // Ordinary PATCHes overlap: PATCH-A submits ['kit/helper'] (unchanged from ITS
    // snapshot), parks before persisting; PATCH-B removes the ref; DELETE then runs.
    // With an added-vs-before diff the parked PATCH-A computed added=[] and skipped
    // the chain, so DELETE saw B's empty list, returned 204, and A restored the ref
    // onto a deleted source. Keyed off the SUBMITTED list, A holds the chain while
    // parked — the DELETE queues behind it and 409s once A's restore commits.
    const app = makeApp()
    const sourceId = await createSource(app, 'kit')
    const agentId = await createAgent(app, 'stale-patcher', ['kit/helper'])

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
      payload: { skills: ['kit/helper'] } // full replace, "unchanged" from A's stale view
    })
    await parkedA

    const patchB = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { skills: [] }
    })
    expect(patchB.statusCode).toBe(200)

    const del = app.app.inject({ method: 'DELETE', url: `${ORG}/skill-sources/${sourceId}` })
    const winner = await Promise.race([
      del.then(() => 'deleted' as const),
      settleTick(300).then(() => 'blocked' as const)
    ])
    expect(winner).toBe('blocked') // the delete waits behind the parked PATCH-A's chain hold

    releaseA()
    expect((await patchA).statusCode).toBe(200)
    expect((await del).statusCode).toBe(409) // A's restore committed first — the reference is seen
    expect((await app.app.inject({ method: 'GET', url: `${ORG}/skill-sources/${sourceId}` })).statusCode).toBe(200)
  })

  it('a restricted same-name replacement is not grandfathered by a stale full-replace PATCH', async () => {
    // The keep-exemption must attach to what the agent actually HOLDS, not the
    // name: org-visible A is enabled; A's delete parks; a RESTRICTED replacement B
    // and a stale full-replace PATCH queue behind it; a concurrent removal frees the
    // delete. B then commits — and the stale PATCH must NOT ride its old "kept ref"
    // exemption onto B (a source the collaborator cannot even see): the in-fence
    // check sees nothing held and refuses with 403.
    const owner = await makeUser('skls-owner', 'owner')
    const collab = await makeUser('skls-collab', 'collaborator')
    const ownerApp = appAs(owner)
    const collabApp = appAs(collab)

    const sourceA = await createSource(ownerApp, 'kit')
    const agentId = await createAgent(collabApp, 'identity-racer', ['kit/helper'])

    const { release, parked } = parkDeleteAtReferenceCheck(ownerApp)
    const del = ownerApp.app.inject({ method: 'DELETE', url: `${ORG}/skill-sources/${sourceA}` })
    await parked

    const bCreate = ownerApp.app.inject({
      method: 'POST',
      url: `${ORG}/skill-sources`,
      payload: { name: 'kit', source: 'example-org/example-kit', visibility: 'restricted', sharedWith: [] }
    })
    await settleTick(150)
    const stalePatch = collabApp.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { skills: ['kit/helper'] } // full replace — "unchanged" from its stale view of A
    })
    await settleTick(150)
    // A concurrent removal (submits no refs → joins no chain) frees the delete.
    const removal = await collabApp.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { skills: [] }
    })
    expect(removal.statusCode).toBe(200)

    release()
    expect((await del).statusCode).toBe(204)
    expect((await bCreate).statusCode).toBe(201) // replacement B exists, restricted
    expect((await stalePatch).statusCode).toBe(403) // the exemption died with the hold; B is invisible

    const agent = (await collabApp.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}` })).json()
    expect(agent.skills).toEqual([]) // never bound to the invisible replacement
  })

  it('a replacement completed between the route-entry read and the fence cannot become the grandfather baseline', async () => {
    // The keep-exemption derives from the agent's COMMITTED enable-list read inside
    // the fence, never from request-time snapshots: here the stale PATCH captures
    // `before=['kit/helper']` (bound to org-visible A) and then parks BEFORE any
    // other read; a removal, A's delete, and a restricted same-name replacement B
    // all complete during the pause. On resume the committed list no longer holds
    // the ref, so the enable is fresh and B is invisible → 403.
    const owner = await makeUser('sklb-owner', 'owner')
    const collab = await makeUser('sklb-collab', 'collaborator')
    const ownerApp = appAs(owner)
    const collabApp = appAs(collab)

    const sourceA = await createSource(ownerApp, 'kit')
    const agentId = await createAgent(collabApp, 'baseline-racer', ['kit/helper'])

    // Park the stale PATCH right after its optimistic-CAS re-read (the SECOND
    // agent.get: #1 is the route-entry getOrgAgent, #2 refreshMutationAgent) — the
    // last read before the fence.
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
      payload: { skills: ['kit/helper'] }
    })
    await parked

    // While it sleeps: the reference is removed, A is deleted, restricted B lands.
    expect(
      (await collabApp.app.inject({ method: 'PATCH', url: `${ORG}/agents/${agentId}`, payload: { skills: [] } }))
        .statusCode
    ).toBe(200)
    expect((await ownerApp.app.inject({ method: 'DELETE', url: `${ORG}/skill-sources/${sourceA}` })).statusCode).toBe(
      204
    )
    const bCreate = await ownerApp.app.inject({
      method: 'POST',
      url: `${ORG}/skill-sources`,
      payload: { name: 'kit', source: 'example-org/example-kit', visibility: 'restricted', sharedWith: [] }
    })
    expect(bCreate.statusCode).toBe(201)

    releaseGet()
    expect((await stalePatch).statusCode).toBe(403) // committed list holds nothing — B is a fresh, invisible enable
    const agent = (await collabApp.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}` })).json()
    expect(agent.skills).toEqual([])
  })

  it('a removal committed between the fence and the row write cannot revive the hold exemption (row-locked authorize)', async () => {
    // The hold decision is evaluated INSIDE the agent-row-locked update transaction,
    // against the committed list that write merges onto. A removal-only PATCH joins
    // no source-name chain, so it CAN commit inside the fence-to-write window — and
    // any hold read taken earlier in the fence would wrongly keep exempting the
    // stale writer. Here: restricted 'kit' held by the owner's agent; the
    // collaborator's stale full-replace PATCH parks just before its row update; the
    // owner's removal commits; on resume the row-locked read shows nothing held,
    // so re-adding the invisible source is refused.
    const owner = await makeUser('sklh-owner', 'owner')
    const collab = await makeUser('sklh-collab', 'collaborator')
    const ownerApp = appAs(owner)
    const collabApp = appAs(collab)

    await createSource(ownerApp, 'kit', { visibility: 'restricted', sharedWith: [] })
    const agentId = await createAgent(ownerApp, 'held-agent', ['kit/helper'])

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
      payload: { skills: ['kit/helper'] } // full replace — "unchanged" from its stale view
    })
    await parked

    // The removal joins no chain — it lands inside the fence-to-write window.
    expect(
      (await ownerApp.app.inject({ method: 'PATCH', url: `${ORG}/agents/${agentId}`, payload: { skills: [] } }))
        .statusCode
    ).toBe(200)

    releaseWriter()
    expect((await stalePatch).statusCode).toBe(403) // row-locked read: nothing held; 'kit' is invisible
    const agent = (await ownerApp.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}` })).json()
    expect(agent.skills).toEqual([])
  })

  it('a sharing flip queues behind an in-flight enable (no check-to-commit visibility race)', async () => {
    // PUT /skill-sources/:id/sharing joins the name chain: an agent write authorizes
    // visibility INSIDE that chain, so a restrict must not land between its check
    // and its commit. Park the enable at its persist step (in-fence, post-check) and
    // assert the sharing flip waits for it.
    const app = makeApp()
    const sourceId = await createSource(app, 'kit')
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
      payload: { skills: ['kit/helper'] }
    })
    await parked

    const share = app.app.inject({
      method: 'PUT',
      url: `${ORG}/skill-sources/${sourceId}/sharing`,
      payload: { visibility: 'restricted', sharedWith: [] }
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

  it('a sibling-field PATCH omitting skills cannot restore a concurrently-removed ref (atomic bag merge)', async () => {
    // runtimeOverrides is ONE JsonB bag, so a model-only PATCH re-writes the whole
    // bag from what it read. Unlocked, it could carry a stale skills key back after
    // another PATCH removed it — behind the DELETE guard's back and without ever
    // joining a source chain (it submits no skills). The repo row-locks the bag
    // read (FOR UPDATE), so bag writers fully serialize and the sibling PATCH
    // merges onto the post-removal bag. An external row lock parks BOTH patches at
    // their bag read so they queue and serialize behind it.
    const app = makeApp()
    const sourceId = await createSource(app, 'kit')
    const agentId = await createAgent(app, 'sibling-racer', ['kit/helper'])

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
      payload: { skills: [] }
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
    expect(agent.skills).toEqual([]) // the omitted key did NOT restore 'kit/helper'
    expect((await app.app.inject({ method: 'DELETE', url: `${ORG}/skill-sources/${sourceId}` })).statusCode).toBe(204)
  })
})

/**
 * `GET /skill-sources/registry/search` — the "Install from skills.sh" discovery
 * read. The index itself is stubbed (no network in tests); what matters here is
 * that the route sits behind the same write gate as the rest of the install flow,
 * that an unavailable index degrades instead of failing the request, and that the
 * static `registry` segment is not swallowed by the sibling `/:id` route.
 */
describe('GET /skill-sources/registry/search', () => {
  const hit = { id: 'anthropics/skills/pdf', name: 'pdf', source: 'anthropics/skills', installs: 42 }

  function appWithRegistry(overrides: Partial<HttpApp['deps']> = {}): HttpApp {
    const app = buildHttpApp(prisma, undefined, undefined, undefined, overrides)
    opened.push(app)
    return app
  }

  it('returns normalized hits and forwards the query, owner, and limit', async () => {
    const calls: Array<[string, unknown]> = []
    const app = appWithRegistry({
      searchSkillRegistry: async (query, opts) => {
        calls.push([query, opts])
        return { status: 'ok', skills: [hit] }
      }
    })

    const res = await app.app.inject({
      method: 'GET',
      url: `${ORG}/skill-sources/registry/search?q=pdf&owner=anthropics&limit=3`
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ reachable: true, skills: [hit] })
    expect(calls).toEqual([['pdf', { owner: 'anthropics', limit: 3 }]])
  })

  it('reports the index unreachable instead of failing the request', async () => {
    const app = appWithRegistry({ searchSkillRegistry: async () => ({ status: 'unreachable' }) })
    const res = await app.app.inject({ method: 'GET', url: `${ORG}/skill-sources/registry/search?q=pdf` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ reachable: false, skills: [] })
  })

  it('reports unreachable when the deployment wires no registry client at all', async () => {
    const res = await makeApp().app.inject({ method: 'GET', url: `${ORG}/skill-sources/registry/search?q=pdf` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ reachable: false, skills: [] })
  })

  it('rejects a blank query and refuses a viewer', async () => {
    const app = appWithRegistry({ searchSkillRegistry: async () => ({ status: 'ok', skills: [hit] }) })
    expect((await app.app.inject({ method: 'GET', url: `${ORG}/skill-sources/registry/search?q=` })).statusCode).toBe(
      400
    )

    const viewerId = await makeUser(`viewer-${randomUUID()}`, 'viewer')
    const viewer = buildHttpApp(prisma, { DEFAULT_OWNER_ID: viewerId })
    opened.push(viewer)
    expect(
      (await viewer.app.inject({ method: 'GET', url: `${ORG}/skill-sources/registry/search?q=pdf` })).statusCode
    ).toBe(403)
  })
})
