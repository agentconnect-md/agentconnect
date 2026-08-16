/**
 * Skill-source routes — the referenced-guard on DELETE and its (orgId, name)
 * lifecycle fence. Agents bind a source by NAME (every enable-ref is
 * "<source>/<skill>" / "<source>/*" / "<source>"), so deleting a source that
 * agents still enable would leave dangling selectors that silently re-bind to any
 * future source recreated under the same name. DELETE must 409 while referenced
 * (same rule as MCP-provider delete), create must refuse a referenced name
 * (name-capture guard), and agent enable-list writes serialize with both.
 *
 * The fence is the (orgId, name) ADVISORY LOCK SCOPE
 * (persistence/skill-source-lock.ts), taken inside each participant's
 * transaction — so it holds across control-plane instances, and these tests
 * simulate "the other instance" by holding the scope from an independent
 * transaction on the shared pool ({@link holdSkillSourceScope}).
 *
 * One skills-specific difference from the MCP-provider fence: a skill-ref has no
 * daemon-local fallback — the in-scope visibility check refuses a NEW ref whose
 * source is unknown, so an agent write serialized after a delete is refused (403)
 * rather than committing a dangling ref. Dangling refs can therefore only predate
 * the fence (or bypass the routes); the capture guard still protects those.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { Prisma } from '../../src/generated/prisma/client.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { lockSkillSourceNameScope } from '../../src/persistence/skill-source-lock.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'
import type { HttpDeps } from '../../src/http/deps.js'
import { AgentId, OrgId } from '../../src/domain/ids.js'
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
 *  source-name fence is a database advisory scope, so it serializes across app
 *  instances (and across control-plane processes) by construction. */
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
 * Hold the (orgId, name) advisory scope from an INDEPENDENT transaction — the
 * exact shape of a concurrent holder on another control-plane instance (e.g.
 * the rolling-update overlap window). Every fence participant (source
 * delete/create/sharing, agent enable-list writes) queues behind it until
 * release() lets this holder's transaction commit; Postgres then grants the
 * scope to the queued waiters in FIFO order, which is what makes the staged
 * multi-waiter tests below deterministic.
 */
function holdSkillSourceScope(name: string) {
  let open!: () => void
  const gate = new Promise<void>((resolve) => (open = resolve))
  let notifyHeld!: () => void
  const held = new Promise<void>((resolve) => (notifyHeld = resolve))
  const settled = prisma.$transaction(
    async (tx) => {
      await lockSkillSourceNameScope(tx, DEFAULT_ORG_ID, name)
      notifyHeld()
      await gate
    },
    { timeout: 20_000 }
  )
  return {
    held,
    release: async () => {
      open()
      await settled
    }
  }
}

/** Poll pg_locks until at least `count` sessions are queued on an advisory lock
 *  in this pool's database — the deterministic "it is blocked" probe. */
async function waitForAdvisoryWaiters(count: number): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const [row] = await prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS "count"
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND granted = false
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    `)
    if ((row?.count ?? 0) >= count) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`never observed ${count} queued advisory-lock waiter(s)`)
}

const settleTick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('DELETE /skill-sources/:id — serialized against agent enable-list writes', () => {
  it('an agent CREATE adding a ref serializes behind the delete; it is refused rather than committing a dangling ref', async () => {
    const app = makeApp()
    const sourceId = await createSource(app, 'kit')
    // "The other instance" holds the (orgId, 'kit') scope; the DELETE queues
    // first, the ref-adding CREATE queues second — FIFO then replays exactly
    // the delete-wins interleaving the fence exists for.
    const hold = holdSkillSourceScope('kit')
    await hold.held

    const del = app.app.inject({ method: 'DELETE', url: `${ORG}/skill-sources/${sourceId}` })
    await waitForAdvisoryWaiters(1)

    // Regression (the pre-fix bug): with the check outside the fence, this create
    // completed DURING the held window and the delete still returned 204, leaving
    // the dangling selector. Now the write's transaction takes the same scope and
    // must queue.
    const create = app.app.inject({
      method: 'POST',
      url: `${ORG}/agents`,
      payload: { name: 'racer', runtime: 'claude', skills: ['kit/helper'] }
    })
    await waitForAdvisoryWaiters(2)

    await hold.release()
    // The delete saw no reference (the write was queued behind it) — it completes;
    // the queued create then reads visibility INSIDE its fenced transaction, finds
    // the source gone, and is refused: no dangling ref is ever committed.
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

  it('an agent PATCH adding a ref serializes behind the delete the same way', async () => {
    const app = makeApp()
    const sourceId = await createSource(app, 'kit')
    const agentId = await createAgent(app, 'patch-racer', [])
    const hold = holdSkillSourceScope('kit')
    await hold.held

    const del = app.app.inject({ method: 'DELETE', url: `${ORG}/skill-sources/${sourceId}` })
    await waitForAdvisoryWaiters(1)

    const patch = app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { skills: ['kit/helper'] }
    })
    await waitForAdvisoryWaiters(2)

    await hold.release()
    expect((await del).statusCode).toBe(204)
    expect((await patch).statusCode).toBe(403) // the source is gone — the ref is refused, never dangling
    const agent = (await app.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}` })).json()
    expect(agent.skills).toEqual([])
  })

  it('a stale full-replace PATCH re-asserting a ref still fences the delete (no diff-based bypass)', async () => {
    // Ordinary PATCHes overlap: PATCH-A submits ['kit/helper'] (unchanged from ITS
    // snapshot) and queues on the scope; PATCH-B removes the ref (no submitted refs
    // ⇒ no fence ⇒ commits immediately); DELETE then queues. With an added-vs-before
    // diff, A would have computed added=[] and skipped the fence, so DELETE saw B's
    // empty list, returned 204, and A restored the ref onto a deleted source. Keyed
    // off the SUBMITTED list, A holds a queue slot AHEAD of the delete: its restore
    // commits first (authorized — the source still exists and is org-visible), and
    // the delete then sees the reference and 409s.
    const app = makeApp()
    const sourceId = await createSource(app, 'kit')
    const agentId = await createAgent(app, 'stale-patcher', ['kit/helper'])

    const hold = holdSkillSourceScope('kit')
    await hold.held

    const patchA = app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { skills: ['kit/helper'] } // full replace, "unchanged" from A's stale view
    })
    await waitForAdvisoryWaiters(1) // A queued on the scope — the no-bypass fact itself

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
    expect(winner).toBe('blocked') // the delete queues behind the held scope (and behind A)

    await hold.release()
    expect((await patchA).statusCode).toBe(200)
    expect((await del).statusCode).toBe(409) // A's restore committed first — the reference is seen
    expect((await app.app.inject({ method: 'GET', url: `${ORG}/skill-sources/${sourceId}` })).statusCode).toBe(200)
  })

  it('a restricted same-name replacement is not grandfathered by a stale full-replace PATCH', async () => {
    // The keep-exemption must attach to what the agent actually HOLDS, not the
    // name: org-visible A is enabled; A's delete, a RESTRICTED replacement B, and
    // a stale full-replace PATCH queue on the held scope in that order; a
    // concurrent removal (no submitted refs ⇒ no fence) commits meanwhile and
    // lets the delete pass its reference scan. B then commits — and the stale
    // PATCH must NOT ride its old "kept ref" exemption onto B (a source the
    // collaborator cannot even see): its fenced check sees nothing held and
    // refuses with 403.
    const owner = await makeUser('skls-owner', 'owner')
    const collab = await makeUser('skls-collab', 'collaborator')
    const ownerApp = appAs(owner)
    const collabApp = appAs(collab)

    const sourceA = await createSource(ownerApp, 'kit')
    const agentId = await createAgent(collabApp, 'identity-racer', ['kit/helper'])

    const hold = holdSkillSourceScope('kit')
    await hold.held
    const del = ownerApp.app.inject({ method: 'DELETE', url: `${ORG}/skill-sources/${sourceA}` })
    await waitForAdvisoryWaiters(1)

    const bCreate = ownerApp.app.inject({
      method: 'POST',
      url: `${ORG}/skill-sources`,
      payload: { name: 'kit', source: 'example-org/example-kit', visibility: 'restricted', sharedWith: [owner] }
    })
    await waitForAdvisoryWaiters(2)
    const stalePatch = collabApp.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { skills: ['kit/helper'] } // full replace — "unchanged" from its stale view of A
    })
    await waitForAdvisoryWaiters(3)
    // A concurrent removal (submits no refs → takes no scope) commits while the
    // queue is still parked, releasing the agent's hold on 'kit'.
    const removal = await collabApp.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { skills: [] }
    })
    expect(removal.statusCode).toBe(200)

    await hold.release()
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
    repo.get = async (orgId, id) => {
      const row = await realGet(orgId, id)
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
      payload: { name: 'kit', source: 'example-org/example-kit', visibility: 'restricted', sharedWith: [owner] }
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

    await createSource(ownerApp, 'kit', { visibility: 'restricted', sharedWith: [owner] })
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

  it('a sharing flip serializes with an in-flight enable (no check-to-commit visibility race)', async () => {
    // PUT /skill-sources/:id/sharing takes the (orgId, name) scope: an agent write
    // authorizes visibility inside its own transaction under the same scope, so a
    // restrict can never land between that check and its commit. Queue the enable
    // FIRST and the flip behind it: the enable commits under the visibility it was
    // checked against, then the flip lands — the agent keeps the ref it was granted.
    const app = makeApp()
    const sourceId = await createSource(app, 'kit')
    const agentId = await createAgent(app, 'share-racer', [])

    const hold = holdSkillSourceScope('kit')
    await hold.held
    const enable = app.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { skills: ['kit/helper'] }
    })
    await waitForAdvisoryWaiters(1)

    const share = app.app.inject({
      method: 'PUT',
      url: `${ORG}/skill-sources/${sourceId}/sharing`,
      payload: { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
    })
    const winner = await Promise.race([
      share.then(() => 'shared' as const),
      settleTick(300).then(() => 'blocked' as const)
    ])
    expect(winner).toBe('blocked') // the flip queues behind the held scope (and the enable)

    await hold.release()
    expect((await enable).statusCode).toBe(200)
    expect((await share).statusCode).toBe(200)
    const agent = (await app.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}` })).json()
    expect(agent.skills).toEqual(['kit/helper'])
  })

  it('an enable serialized after a restrict is refused (the flip side of the same fence)', async () => {
    // Same scope, opposite order: the flip queues first, the enable behind it.
    // The enable's fenced visibility read then already sees the restricted row,
    // so the collaborator's fresh ref is refused — never a torn "checked open,
    // committed restricted" state in either order.
    const owner = await makeUser('sklf-owner', 'owner')
    const collab = await makeUser('sklf-collab', 'collaborator')
    const ownerApp = appAs(owner)
    const collabApp = appAs(collab)
    const sourceId = await createSource(ownerApp, 'kit', {
      visibility: 'restricted',
      sharedWith: [collab, owner]
    })
    const agentId = await createAgent(collabApp, 'flip-racer', [])

    const hold = holdSkillSourceScope('kit')
    await hold.held
    const share = ownerApp.app.inject({
      method: 'PUT',
      url: `${ORG}/skill-sources/${sourceId}/sharing`,
      payload: { visibility: 'restricted', sharedWith: [owner] }
    })
    await waitForAdvisoryWaiters(1)
    const enable = collabApp.app.inject({
      method: 'PATCH',
      url: `${ORG}/agents/${agentId}`,
      payload: { skills: ['kit/helper'] }
    })
    await waitForAdvisoryWaiters(2)

    await hold.release()
    expect((await share).statusCode).toBe(200)
    expect((await enable).statusCode).toBe(403)
    const agent = (await collabApp.app.inject({ method: 'GET', url: `${ORG}/agents/${agentId}` })).json()
    expect(agent.skills).toEqual([])
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

/**
 * Numeric repository identity binding (issue #935). `AgentSkillEntry` REQUIRES
 * `githubRepoId`, so a row without one is dropped by the projection: the console
 * shows the source enabled and the daemon never hears about it. No console entry
 * point can send that id — it isn't in any read the web client has — so the CP
 * must resolve it from `source` itself, and must refuse a write it cannot bind
 * rather than persist a row that installs nothing.
 */
describe('POST/PATCH /skill-sources — githubRepoId binding', () => {
  function appResolving(resolve: HttpDeps['resolvePublicRepo']): HttpApp {
    const app = buildHttpApp(prisma, undefined, undefined, undefined, { resolvePublicRepo: resolve })
    opened.push(app)
    return app
  }

  const publicRepo = async (owner: string, repo: string) => ({
    repoId: 7654321n,
    fullName: `${owner}/${repo}`,
    private: false,
    defaultBranch: 'trunk'
  })

  it('binds the id a console create cannot send, and the source then projects onto the AgentSpec', async () => {
    const app = appResolving(publicRepo)
    // Exactly the body SkillSourcesCard/InstallRegistrySkillModal send: no id.
    const created = await app.app.inject({
      method: 'POST',
      url: `${ORG}/skill-sources`,
      payload: { name: 'kit', source: 'anthropics/skills' }
    })
    expect(created.statusCode).toBe(201)
    expect(created.json().githubRepoId).toBe('7654321')

    const agentId = await createAgent(app, 'enabler', ['kit/*'])
    const agent = await app.deps.repos.agent.get(OrgId(DEFAULT_ORG_ID), AgentId(agentId))
    const spec = await app.deps.agentSpecs.assemble(agent!)
    expect(spec.skills).toEqual([{ name: 'kit', source: 'anthropics/skills', githubRepoId: '7654321', skills: [] }])
  })

  it('pins a subdir source to the resolved default branch, not an assumed `main`', async () => {
    const app = appResolving(publicRepo)
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/skill-sources`,
      payload: { name: 'sub', source: 'anthropics/skills', subDir: 'packs' }
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ ref: 'trunk', githubRepoId: '7654321' })
  })

  it('an explicitly supplied id still wins over the lookup', async () => {
    const app = appResolving(publicRepo)
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/skill-sources`,
      payload: { name: 'kit', source: 'anthropics/skills', githubRepoId: '42' }
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().githubRepoId).toBe('42')
  })

  it('refuses a repo GitHub says does not exist instead of storing a non-installable row', async () => {
    const app = appResolving(async () => 'not-found')
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/skill-sources`,
      payload: { name: 'kit', source: 'anthropics/skills' }
    })
    expect(res.statusCode).toBe(400)
    expect((await app.app.inject({ method: 'GET', url: `${ORG}/skill-sources` })).json()).toEqual([])
  })

  it('reports an unreachable GitHub as retryable rather than as a bad request', async () => {
    const app = appResolving(async () => 'unreachable')
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/skill-sources`,
      payload: { name: 'kit', source: 'anthropics/skills' }
    })
    expect(res.statusCode).toBe(503)
  })

  it('rejects a confirmed-private repo before binding it', async () => {
    const app = appResolving(async (owner, repo) => ({
      repoId: 9n,
      fullName: `${owner}/${repo}`,
      private: true,
      defaultBranch: 'main'
    }))
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/skill-sources`,
      payload: { name: 'kit', source: 'anthropics/skills' }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toContain('private skill sources are not supported')
  })

  it('back-fills a historical unbound row on the next edit — the repair PATCH could not do', async () => {
    const app = appResolving(publicRepo)
    const id = await createSource(app, 'legacy')
    // Simulate a row created before the binding existed (SQL bypasses the route).
    await prisma.skillSource.update({ where: { id }, data: { githubRepoId: null } })

    const patched = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/skill-sources/${id}`,
      payload: { skills: ['helper'] }
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().githubRepoId).toBe('7654321')
  })

  it('re-binds when the source is repointed, and leaves a bound row alone otherwise', async () => {
    let calls = 0
    const app = appResolving(async (owner, repo) => {
      calls += 1
      return { repoId: BigInt(1000 + calls), fullName: `${owner}/${repo}`, private: false, defaultBranch: 'main' }
    })
    const id = await createSource(app, 'kit') // calls = 1 → 1001
    const repointed = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/skill-sources/${id}`,
      payload: { source: 'anthropics/skills' }
    })
    expect(repointed.json().githubRepoId).toBe('1002')

    // An unrelated edit keeps the bound id — a `skills`-only PATCH must not depend
    // on GitHub being reachable.
    const unrelated = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/skill-sources/${id}`,
      payload: { skills: ['helper'] }
    })
    expect(unrelated.json().githubRepoId).toBe('1002')
  })

  it('refuses to clear the id — that is precisely the non-installable state', async () => {
    const app = appResolving(publicRepo)
    const id = await createSource(app, 'kit')
    const res = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/skill-sources/${id}`,
      payload: { githubRepoId: null }
    })
    expect(res.statusCode).toBe(400)
    expect((await app.app.inject({ method: 'GET', url: `${ORG}/skill-sources/${id}` })).json().githubRepoId).toBe(
      '7654321'
    )
  })
})

/**
 * Rename/transfer redirects and the accepted-source grammar — the two findings
 * from the review of the binding change.
 *
 * GitHub answers `GET /repos/docker/docker` with `full_name: moby/moby`. Storing
 * the typed slug next to the resolved id would fail on the daemon, whose identity
 * check requires `full_name` to equal the configured source. And because binding
 * is now mandatory, every form `SkillSourceArg` admits must decompose here, or the
 * DTO accepts a source the route then rejects.
 */
describe('POST/PATCH /skill-sources — canonical slug and accepted forms', () => {
  /** Resolves any name to one repo that has since moved to `moby/moby`. */
  const redirected: HttpDeps['resolvePublicRepo'] = async () => ({
    repoId: 111n,
    fullName: 'moby/moby',
    private: false,
    defaultBranch: 'main'
  })

  function appResolving(resolve: HttpDeps['resolvePublicRepo']): HttpApp {
    const app = buildHttpApp(prisma, undefined, undefined, undefined, { resolvePublicRepo: resolve })
    opened.push(app)
    return app
  }

  it('stores the slug GitHub redirected to, so the daemon identity check can pass', async () => {
    const app = appResolving(redirected)
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/skill-sources`,
      payload: { name: 'kit', source: 'docker/docker' }
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ source: 'moby/moby', githubRepoId: '111' })
  })

  it('rewrites only the owner/repo half, preserving the rest of the source string', async () => {
    const app = appResolving(redirected)
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/skill-sources`,
      payload: { name: 'kit', source: 'https://github.com/docker/docker.git/tree/v2/packs' }
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().source).toBe('https://github.com/moby/moby.git/tree/v2/packs')
  })

  it('canonicalizes on the back-fill too — a stale stored slug is repaired with the id', async () => {
    const app = appResolving(redirected)
    const id = await createSource(app, 'legacy', { source: 'docker/docker' })
    await prisma.skillSource.update({ where: { id }, data: { githubRepoId: null, source: 'docker/docker' } })

    const patched = await app.app.inject({
      method: 'PATCH',
      url: `${ORG}/skill-sources/${id}`,
      payload: { skills: ['helper'] }
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json()).toMatchObject({ source: 'moby/moby', githubRepoId: '111' })
  })

  it('leaves the source alone when the resolved name already matches', async () => {
    const app = appResolving(async (owner, repo) => ({
      repoId: 5n,
      fullName: `${owner}/${repo}`,
      private: false,
      defaultBranch: 'main'
    }))
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/skill-sources`,
      payload: { name: 'kit', source: 'https://github.com/anthropics/skills' }
    })
    expect(res.json().source).toBe('https://github.com/anthropics/skills')
  })

  // Every form SkillSourceArg admits must bind; before this, the host-prefixed
  // shorthand and a mid-path `.git` were newly rejected by mandatory binding.
  it.each([
    ['bare shorthand', 'anthropics/skills'],
    ['host-prefixed shorthand', 'github.com/anthropics/skills'],
    ['https', 'https://github.com/anthropics/skills'],
    ['https with .git', 'https://github.com/anthropics/skills.git'],
    ['https tree with .git', 'https://github.com/anthropics/skills.git/tree/main/packs'],
    ['scp ssh', 'git@github.com:anthropics/skills'],
    ['ssh url', 'ssh://git@github.com/anthropics/skills']
  ])('binds a source given in %s form', async (_label, source) => {
    const seen: string[] = []
    const app = appResolving(async (owner, repo) => {
      seen.push(`${owner}/${repo}`)
      return { repoId: 314n, fullName: `${owner}/${repo}`, private: false, defaultBranch: 'main' }
    })
    const res = await app.app.inject({
      method: 'POST',
      url: `${ORG}/skill-sources`,
      payload: { name: 'kit', source }
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().githubRepoId).toBe('314')
    expect(seen).toEqual(['anthropics/skills'])
  })
})
