// The record frames and the agents' knowledge reads (assistant-mode.md §5.16): placement, assistant mode, the revision check, visibility and `withOutsiders`.
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { isFrame, KNOWLEDGE_RECORD_FEATURE, ORGANIZATION_KNOWLEDGE_FEATURE } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildWsHarness } from '../fakes/build-ws.js'
import type { InMemoryDaemonStub } from '../fakes/daemon-stub.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const DAEMON = 'd5555555-5555-4555-8555-555555555555'
const AUTH_ID = '99999999-9999-4999-8999-999999999991'
const REG_ID = '88888888-8888-4888-8888-888888888881'

async function seedAgent(assistant: boolean): Promise<string> {
  const id = randomUUID()
  await prisma.agent.create({
    data: {
      id,
      orgId: DEFAULT_ORG_ID,
      name: `agent-${id.slice(0, 8)}`,
      runtime: 'claude',
      daemonId: DAEMON,
      ...(assistant ? { assistantMode: { enabled: true } } : {})
    }
  })
  return id
}

async function seedEntry(title: string, visibility: 'all' | 'selected', readers: string[] = []): Promise<void> {
  await prisma.organizationKnowledge.create({
    data: {
      orgId: DEFAULT_ORG_ID,
      title,
      visibility,
      readers,
      revisions: {
        create: { revision: 1, content: `${title} runbook`, digest: `sha256:${'e'.repeat(64)}`, source: 'manual' }
      }
    }
  })
}

async function ready(h: ReturnType<typeof buildWsHarness>, features: string[]) {
  const { stub } = h.connect()
  const saToken = await h.mintPoolMember(DAEMON)
  stub.inject('auth', { serviceAccountToken: saToken, daemonId: DAEMON, agentVersion: '1.4.0' }, { id: AUTH_ID })
  await stub.expectFrame('auth/ok')
  stub.inject(
    'register',
    {
      host: 'member-1',
      capabilities: { platforms: [], runtimes: ['claude'], acp: true, features },
      maxAgents: 8,
      localState: { assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }
    },
    { id: REG_ID }
  )
  const ok = await stub.expectFrame('register/ok')
  return { stub, serverFeatures: (ok.payload as { serverFeatures: string[] }).serverFeatures }
}

async function settle(stub: InMemoryDaemonStub, id: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const reply = stub.sent.find((f) => f.corr === id)
    if (reply) return reply
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`no reply correlated to ${id}`)
}

const FEATURES = [ORGANIZATION_KNOWLEDGE_FEATURE, KNOWLEDGE_RECORD_FEATURE]

describe('the organization record over the daemon connection', () => {
  it('advertises the record, creates it on first read, and writes it by revision', async () => {
    const h = buildWsHarness(prisma)
    const { stub, serverFeatures } = await ready(h, FEATURES)
    const agentId = await seedAgent(true)
    expect(serverFeatures).toContain(KNOWLEDGE_RECORD_FEATURE)
    const ask = async (type: 'knowledge/record/read' | 'knowledge/record/write', payload: object) =>
      settle(stub, stub.inject(type, payload, { orgId: DEFAULT_ORG_ID }))

    const read = await ask('knowledge/record/read', { agentId, file: 'channels.md' })
    expect(read.type).toBe('knowledge/record/ok')
    expect(read.payload).toMatchObject({ revision: 1, content: '# Channels', optOut: [] })

    const content = '# Channels\n- [slack] release: release trains and freezes (#release, 2026-10-17)\n'
    const write = (baseRevision: number, text = content, extra: object = {}) =>
      ask('knowledge/record/write', {
        agentId,
        file: 'channels.md',
        baseRevision,
        content: text,
        writerKind: 'getting-to-know',
        ...extra
      })
    const written = await write(1)
    expect(written.type).toBe('knowledge/record/ok')
    const revision = await prisma.organizationKnowledgeRevision.findFirstOrThrow({ where: { revision: 2 } })
    expect(written.payload).toMatchObject({ revision: 2, updatedAt: revision.createdAt.toISOString() })
    expect(revision).toMatchObject({ source: 'agent', sourceAgentId: agentId, writerKind: 'getting_to_know' })

    const stale = await write(1, `${content}- [slack] ops: incidents (#ops, 2026-10-17)\n`)
    expect(stale.type).toBe('knowledge/record/conflict')
    expect(stale.payload).toMatchObject({ revision: 2, updatedAt: revision.createdAt.toISOString(), content })

    const misshapen = await write(2, '# Channels\n#ops: incidents\n')
    if (!isFrame('error')(misshapen)) throw new Error('expected a refusal')
    expect(misshapen.payload.message).toMatch(/channels\.md line 2/)

    // Marks land with a People write and come back on a read.
    const people = await ask('knowledge/record/read', { agentId, file: 'members.md' })
    const marked = await ask('knowledge/record/write', {
      agentId,
      file: 'members.md',
      baseRevision: (people.payload as { revision: number }).revision,
      content: '# People',
      writerKind: 'person',
      optOut: { mark: ['slack:T0EXAMPLE:U0BOB'], lift: [] }
    })
    expect(marked.type).toBe('knowledge/record/ok')
    expect((await ask('knowledge/record/read', { agentId, file: 'members.md' })).payload).toMatchObject({
      optOut: ['slack:T0EXAMPLE:U0BOB']
    })
  })

  it('refuses People to an agent its readers leave out, and a pending write of someone who opted out meanwhile', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h, FEATURES)
    const agentId = await seedAgent(true)
    const ask = async (type: 'knowledge/record/read' | 'knowledge/record/write', payload: object) =>
      settle(stub, stub.inject(type, payload, { orgId: DEFAULT_ORG_ID }))
    const people = await ask('knowledge/record/read', { agentId, file: 'members.md' })
    const base = (people.payload as { revision: number }).revision

    // A removal that changes only the marks leaves the revision where a pending writer read it.
    const bob = '## Bob (@bob on Slack) `slack:T0EXAMPLE:U0BOB`\nRole: on-call lead (#ops, 2026-10-03)'
    const removal = await ask('knowledge/record/write', {
      agentId,
      file: 'members.md',
      baseRevision: base,
      content: '# People',
      writerKind: 'person',
      optOut: { mark: ['slack:T0EXAMPLE:U0BOB'], lift: [] }
    })
    expect(removal.payload).toMatchObject({ revision: base })
    const pending = await ask('knowledge/record/write', {
      agentId,
      file: 'members.md',
      baseRevision: base,
      content: `# People\n\n${bob}\n`,
      writerKind: 'conversation'
    })
    if (!isFrame('error')(pending)) throw new Error('expected a refusal')
    expect(pending.payload.message).toMatch(/slack:T0EXAMPLE:U0BOB/)

    await prisma.organizationKnowledge.updateMany({
      where: { orgId: DEFAULT_ORG_ID, kind: 'people' },
      data: { visibility: 'selected', readers: [], readersFollowAssistantMode: false }
    })
    for (const reply of [
      await ask('knowledge/record/read', { agentId, file: 'members.md' }),
      await ask('knowledge/record/write', {
        agentId,
        file: 'members.md',
        baseRevision: 1,
        content: '# People',
        writerKind: 'conversation'
      })
    ]) {
      if (!isFrame('error')(reply)) throw new Error('expected a refusal')
      expect(reply.payload.code).toBe('SCOPE_DENIED')
    }
    expect((await ask('knowledge/record/read', { agentId, file: 'channels.md' })).type).toBe('knowledge/record/ok')
  })

  it('refuses an agent outside assistant mode', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h, FEATURES)
    const plain = await seedAgent(false)
    const refused = await settle(
      stub,
      stub.inject('knowledge/record/read', { agentId: plain, file: 'organization.md' }, { orgId: DEFAULT_ORG_ID })
    )
    if (!isFrame('error')(refused)) throw new Error('expected a refusal')
    expect(refused.payload.code).toBe('SCOPE_DENIED')
  })

  it('refuses a daemon that did not advertise the record', async () => {
    const h2 = buildWsHarness(prisma)
    const old = await ready(h2, [ORGANIZATION_KNOWLEDGE_FEATURE])
    const assistant = await seedAgent(true)
    const unadvertised = await settle(
      old.stub,
      old.stub.inject(
        'knowledge/record/read',
        { agentId: assistant, file: 'organization.md' },
        { orgId: DEFAULT_ORG_ID }
      )
    )
    if (!isFrame('error')(unadvertised)) throw new Error('expected a refusal')
    expect(unadvertised.payload.code).toBe('SCOPE_DENIED')
  })

  it('returns only the entries the agent reads, and leaves People out with outsiders', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = await ready(h, FEATURES)
    const agentId = await seedAgent(true)
    const other = await seedAgent(false)
    await seedEntry('Shared', 'all')
    await seedEntry('Mine', 'selected', [agentId])
    await seedEntry('Theirs', 'selected', [other])
    await settle(stub, stub.inject('knowledge/record/read', { agentId, file: 'members.md' }, { orgId: DEFAULT_ORG_ID }))

    const titles = async (withOutsiders?: boolean) => {
      const reply = await settle(
        stub,
        stub.inject(
          'knowledge/list',
          { requesterAgentId: agentId, limit: 20, maxBytes: 32768, ...(withOutsiders ? { withOutsiders } : {}) },
          { orgId: DEFAULT_ORG_ID }
        )
      )
      return (reply.payload as { items: { title: string }[] }).items.map((item) => item.title).sort()
    }
    expect(await titles()).toEqual(['About', 'Channels', 'Mine', 'People', 'Shared'])
    expect(await titles(true)).toEqual(['About', 'Channels', 'Mine', 'Shared'])

    const search = await settle(
      stub,
      stub.inject(
        'knowledge/search',
        { requesterAgentId: other, query: 'runbook', limit: 10, maxBytes: 32768 },
        { orgId: DEFAULT_ORG_ID }
      )
    )
    expect((search.payload as { items: { title: string }[] }).items.map((item) => item.title).sort()).toEqual([
      'Shared',
      'Theirs'
    ])
  })
})
