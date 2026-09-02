/**
 * A session's channel label when the reporting daemon never supplied one.
 *
 * `session_meta.channelName` is a snapshot the daemon captures from its local name
 * cache as it emits `event/session`. That cache learns a Slack channel from the bot's
 * membership listing, so a conversation the agent only ever POSTS into — a schedule
 * firing at a channel nobody has messaged the bot from — can leave the column null
 * permanently, and the console fell back to printing the raw platform id. The org's
 * own conversation directory already holds the name (it is what the Schedules view
 * resolves its target channel through), so the row DTO reads it as a fallback.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import type { HttpDeps } from '../deps.js'
import type { ConversationCoordinate, SessionPageQuery, SessionPageRecord } from '../../persistence/ports.js'
import { installZod } from '../plugins/zod.js'
import { sessionRoutes } from './sessions.js'

const ORG_ID = 'org-1'
const AGENT_ID = 'agent-1'
const HOOK_ID = '11111111-1111-4111-8111-111111111111'
const CRON_ID = '22222222-2222-4222-8222-222222222222'
const at = new Date('2026-08-30T02:00:00Z')

/** A directory entry the daemon's own cache is missing — the case under test. */
const DIRECTORY = [{ platform: 'slack', channelId: 'C0AAA0AAA00', name: 'deploys' }]

function row(overrides: Record<string, unknown>) {
  return {
    id: 'sess-1',
    agentId: AGENT_ID,
    platform: 'slack',
    channel: 'C0AAA0AAA00',
    thread: null,
    triggeredBy: `cron:${CRON_ID}`,
    channelName: null,
    triggeredByName: null,
    hookKind: null,
    lastActivityAt: at,
    startedAt: at,
    visibility: 'org',
    externalProvider: null,
    externalResolution: null,
    activityState: 'idle',
    ...overrides
  }
}

function fakeDeps(sessions: ReturnType<typeof row>[]) {
  const namesForOrg = vi.fn(async (_orgId: string, conversations: readonly ConversationCoordinate[]) =>
    DIRECTORY.filter((entry) =>
      conversations.some((c) => c.platform === entry.platform && c.channelId === entry.channelId)
    )
  )
  const listPage = vi.fn<(q: SessionPageQuery) => Promise<SessionPageRecord>>(async () => ({
    sessions: sessions as unknown as SessionPageRecord['sessions'],
    total: sessions.length,
    hasMore: false
  }))
  const deps = {
    repos: {
      agent: { list: vi.fn(async () => [{ id: AGENT_ID, name: 'build-agent', orgId: ORG_ID }]) },
      session: {
        listPage,
        listFacets: vi.fn(async () => ({ agents: [], integrations: [], channels: [], triggers: [] })),
        listConversationPage: vi.fn(async () => ({ conversations: [], total: 0, hasMore: false })),
        orgHasAny: vi.fn(async () => true),
        listExternalScopes: vi.fn(async () => []),
        getExternalScopes: vi.fn(async () => []),
        getExternalAccessPolicy: vi.fn(async () => null)
      },
      hook: {
        getMany: vi.fn(async () => [
          { id: HOOK_ID, agentId: AGENT_ID, kind: 'webhook', name: 'nightly', repoId: null }
        ]),
        listIdsForOrgKind: vi.fn(async () => []),
        listForOrgKind: vi.fn(async () => [])
      },
      integrationChannel: { namesForOrg }
    },
    clock: { now: () => Date.now() }
  } as unknown as HttpDeps
  return { deps, namesForOrg }
}

async function app(deps: HttpDeps): Promise<FastifyInstance> {
  const instance = Fastify()
  installZod(instance)
  instance.addHook('onRequest', async (req) => {
    req.principal = { userId: 'user-1' }
    req.orgCtx = { orgId: ORG_ID, role: 'collaborator', userId: 'user-1' } as never
  })
  await instance.register(sessionRoutes(deps))
  return instance
}

async function channelNames(deps: HttpDeps): Promise<Array<string | null>> {
  const res = await (await app(deps)).inject({ method: 'GET', url: '/sessions?view=flat' })
  expect(res.statusCode).toBe(200)
  return (res.json() as { sessions: Array<{ channelName: string | null }> }).sessions.map((s) => s.channelName)
}

describe('session channel label falls back to the org conversation directory', () => {
  it('names a channel the reporting daemon never labeled', async () => {
    const { deps } = fakeDeps([row({})])
    expect(await channelNames(deps)).toEqual(['deploys'])
  })

  it('leaves the daemon’s own snapshot alone', async () => {
    // The daemon reports what it observed at the time; a later rename in the directory
    // must not rewrite what a historical row says it ran in.
    const { deps, namesForOrg } = fakeDeps([row({ channelName: 'as-reported' })])
    expect(await channelNames(deps)).toEqual(['as-reported'])
    expect(namesForOrg).not.toHaveBeenCalled()
  })

  it('stays null for a conversation the directory does not know', async () => {
    const { deps } = fakeDeps([row({ channel: 'C0ZZZ9ZZZ99' })])
    expect(await channelNames(deps)).toEqual([null])
  })

  it('never asks the directory about a hook session, whose channel is its hook id', async () => {
    const { deps, namesForOrg } = fakeDeps([
      row({ platform: 'hook', channel: HOOK_ID, triggeredBy: `hook:${HOOK_ID}` })
    ])
    expect(await channelNames(deps)).toEqual(['nightly'])
    expect(namesForOrg).not.toHaveBeenCalled()
  })

  it('asks once per conversation, not once per session', async () => {
    const { deps, namesForOrg } = fakeDeps([row({ id: 'sess-1' }), row({ id: 'sess-2', thread: 't-2' })])
    expect(await channelNames(deps)).toEqual(['deploys', 'deploys'])
    expect(namesForOrg).toHaveBeenCalledTimes(1)
    expect(namesForOrg.mock.calls[0]?.[1]).toEqual([{ platform: 'slack', channelId: 'C0AAA0AAA00' }])
  })
})
