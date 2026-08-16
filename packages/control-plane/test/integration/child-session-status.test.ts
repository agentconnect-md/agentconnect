/**
 * `session/child-status` (D→C REQ) against real rows — the cross-daemon leg of a parent session
 * following a child it started (session-concept §5.4).
 *
 * Both halves are LIVE reads (#1027): the asking daemon is admitted because it SERVES the parent
 * session's agent, and the child is addressed at whoever serves it. `SessionMeta.daemonId` is the
 * daemon that first reported the session and is `onDelete: SetNull`, so after a rollout it names a
 * retired member or nothing — and a pool agent names no machine at all.
 */
import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { AnyFrame, ChildSessionStatus } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon, seedDutyGroup, seedSessionMeta } from '../fixtures/seed.js'
import { poolSetId, seedPoolMember } from '../fakes/member-set.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { PgAgentRepo, PgDaemonRepo, PgDutyGroupRepo, PgRuntimeProfileRepo } from '../../src/persistence/index.js'
import { PgDaemonLifecycleOpRepo } from '../../src/persistence/repositories/daemon-lifecycle-op.repo.js'
import { PgSessionRepo } from '../../src/persistence/repositories/session.repo.js'
import { DaemonRegistryService } from '../../src/registry/registryService.js'
import { PlacementResolver } from '../../src/orchestrator/placementResolver.js'
import { systemClock } from '../../src/domain/clock.js'
import { handleChildSessionStatus } from '../../src/ws/handlers/index.js'
import type { DaemonConnection } from '../../src/ws/connection.js'
import type { DaemonWsDeps } from '../../src/ws/deps.js'

const ASKER = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const OWNER = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd'

const ANSWER: ChildSessionStatus = { found: true, status: 'in-progress', state: 'prompting', updatedAt: 42 }

/** Dispatch a hand-built `session/child-status` REQ through the real handler, over real repos and
 *  the production resolver. Returns the reply payload and which daemon (if any) was probed. */
async function ask(input: {
  from: string
  parentSessionId: string
  childSessionId: string
  childAgentId: string
}): Promise<{ reply: ChildSessionStatus; probed: string[] }> {
  const frame = {
    v: 1,
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: 'session/child-status',
    // An install-wide member carries many orgs on one socket, so the org rides the FRAME; both
    // repository reads below are fenced on it (`frameOrgId`).
    orgId: DEFAULT_ORG_ID,
    payload: {
      parentSessionId: input.parentSessionId,
      childSessionId: input.childSessionId,
      childAgentId: input.childAgentId
    }
  } as AnyFrame
  const probed: string[] = []
  const replyTo = vi.fn()
  const deps = {
    registry: new DaemonRegistryService(
      new PgDaemonRepo(prisma),
      new PgRuntimeProfileRepo(prisma),
      new PgDaemonLifecycleOpRepo(prisma),
      systemClock
    ),
    session: new PgSessionRepo(prisma),
    agent: new PgAgentRepo(prisma),
    placementResolver: new PlacementResolver({ duties: new PgDutyGroupRepo(prisma), clock: systemClock }),
    connReg: {
      get: (daemonId: string) => ({
        daemonId,
        reachable: true,
        sessionEpoch: 7,
        conn: {
          request: async () => {
            probed.push(daemonId)
            return ANSWER
          }
        }
      })
    }
  } as unknown as DaemonWsDeps
  await handleChildSessionStatus(frame, { daemonId: input.from, replyTo } as unknown as DaemonConnection, deps)
  return { reply: replyTo.mock.calls[0]![2] as ChildSessionStatus, probed }
}

describe('session/child-status — authority is the serving member, not the recorded column', () => {
  it('answers for a pool parent and a pool child, each through its current duty holder', async () => {
    const setId = await seedPoolMember(prisma, ASKER)
    await seedPoolMember(prisma, OWNER)
    const parentAgent = await seedAgent(prisma, randomUUID(), { setId })
    const childAgent = await seedAgent(prisma, randomUUID(), { setId })
    await seedDutyGroup(prisma, randomUUID(), ASKER, [parentAgent])
    await seedDutyGroup(prisma, randomUUID(), OWNER, [childAgent])
    // Reported before a rollout: the column names nobody the ledger still knows about.
    const parentSession = await seedSessionMeta(prisma, `s-parent-${randomUUID()}`, parentAgent, {})

    const { reply, probed } = await ask({
      from: ASKER,
      parentSessionId: parentSession,
      childSessionId: `s-child-${randomUUID()}`,
      childAgentId: childAgent
    })

    expect({ reply, probed }).toEqual({ reply: ANSWER, probed: [OWNER] })
  })

  it('refuses a parent session whose agent the asking daemon does not serve', async () => {
    const setId = await poolSetId(prisma)
    await seedPoolMember(prisma, ASKER)
    await seedPoolMember(prisma, OWNER)
    const parentAgent = await seedAgent(prisma, randomUUID(), { setId })
    const childAgent = await seedAgent(prisma, randomUUID(), { setId })
    await seedDutyGroup(prisma, randomUUID(), OWNER, [parentAgent, childAgent])
    const parentSession = await seedSessionMeta(prisma, `s-parent-${randomUUID()}`, parentAgent, {})

    const { reply, probed } = await ask({
      from: ASKER,
      parentSessionId: parentSession,
      childSessionId: `s-child-${randomUUID()}`,
      childAgentId: childAgent
    })

    expect({ reply, probed }).toEqual({ reply: { found: false }, probed: [] })
  })

  it('still answers for two machine-placed agents on different daemons', async () => {
    await seedDaemon(prisma, ASKER)
    await seedDaemon(prisma, OWNER)
    const parentAgent = await seedAgent(prisma, randomUUID(), { daemonId: ASKER })
    const childAgent = await seedAgent(prisma, randomUUID(), { daemonId: OWNER })
    const parentSession = await seedSessionMeta(prisma, `s-parent-${randomUUID()}`, parentAgent, { daemonId: ASKER })

    const { reply, probed } = await ask({
      from: ASKER,
      parentSessionId: parentSession,
      childSessionId: `s-child-${randomUUID()}`,
      childAgentId: childAgent
    })

    expect({ reply, probed }).toEqual({ reply: ANSWER, probed: [OWNER] })
  })

  it('never forwards back to the asking daemon when it serves the child too', async () => {
    await seedDaemon(prisma, ASKER)
    const parentAgent = await seedAgent(prisma, randomUUID(), { daemonId: ASKER })
    const childAgent = await seedAgent(prisma, randomUUID(), { daemonId: ASKER })
    const parentSession = await seedSessionMeta(prisma, `s-parent-${randomUUID()}`, parentAgent, { daemonId: ASKER })

    const { reply, probed } = await ask({
      from: ASKER,
      parentSessionId: parentSession,
      childSessionId: `s-child-${randomUUID()}`,
      childAgentId: childAgent
    })

    expect({ reply, probed }).toEqual({ reply: { found: false }, probed: [] })
  })
})
