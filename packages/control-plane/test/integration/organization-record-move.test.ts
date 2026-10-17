// The one-time move of the organization files from assistant-mode agents' memory into the record (assistant-mode.md §5.16 "Migration").
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { OrganizationRecordMove } from '../../src/organization-knowledge/record-move.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const log = { info: () => {}, warn: () => {} }

async function assistant(enabledAt: string, assistantMode = true): Promise<string> {
  const id = randomUUID()
  await prisma.agent.create({
    data: {
      id,
      orgId: DEFAULT_ORG_ID,
      name: `agent-${id.slice(0, 8)}`,
      runtime: 'claude',
      ...(assistantMode ? { assistantMode: { enabled: true } } : {}),
      assistantOnboarding: { enabledAt }
    }
  })
  return id
}

async function file(agentId: string, path: string, text: string, mtime: Date): Promise<void> {
  const content = Buffer.from(text)
  await prisma.agentMemoryFile.create({
    data: { agentId, orgId: DEFAULT_ORG_ID, path, content, size: content.byteLength, mtime }
  })
}

const read = async (agentId: string, path: string) => {
  const row = await prisma.agentMemoryFile.findUnique({ where: { agentId_path: { agentId, path } } })
  return row ? Buffer.from(row.content).toString('utf8') : null
}
const entry = (kind: 'organization' | 'channels' | 'people') =>
  prisma.organizationKnowledge.findFirstOrThrow({
    where: { orgId: DEFAULT_ORG_ID, kind },
    include: { revisions: { orderBy: { revision: 'desc' } } }
  })

describe('the one-time move into the organization record', () => {
  it('merges every copy, unions the opt-out, deletes the copies and their index lines, and is idempotent', async () => {
    const first = await assistant('2026-10-10T09:00:00.000Z')
    const second = await assistant('2026-10-12T09:00:00.000Z')
    const outside = await assistant('2026-10-11T09:00:00.000Z', false)
    const index =
      '# Memory\n\n- [Organization](organization.md) — what it does\n- [Deploys](deploys.md) — how we ship\n- [Channels](channels.md) — places\n'
    await file(first, 'memory/MEMORY.md', index, new Date('2026-10-13T00:00:00Z'))
    await file(
      first,
      'memory/organization.md',
      '# Org\nIt builds tools (#general, 2026-10-10)',
      new Date('2026-10-10T10:00:00Z')
    )
    await file(
      second,
      'memory/organization.md',
      '# Org\nIt sells to teams (#sales, 2026-10-12)',
      new Date('2026-10-12T10:00:00Z')
    )
    await file(
      first,
      'memory/channels.md',
      '# Channels\n#release: trains [[release]] (#release, 2026-10-10)',
      new Date('2026-10-10T10:00:00Z')
    )
    await file(
      second,
      'memory/members.md',
      '# People\n## Bob (@bob on Slack) `slack:T0EXAMPLE:U0BOB`\nRole: lead (self, 2026-10-12)\n## Ann (@ann on Slack) `slack:T0EXAMPLE:U0ANN`\nRole: designer (self, 2026-10-12)',
      new Date('2026-10-12T10:00:00Z')
    )
    await file(
      first,
      'people/.directory-opt-out.json',
      JSON.stringify({ version: 1, keys: { 'slack:T0EXAMPLE:U0BOB': '2026-10-11' } }),
      new Date()
    )
    await file(
      second,
      'people/.directory-opt-out.json',
      JSON.stringify({ version: 1, keys: { 'slack:T0EXAMPLE:U0BOB': '2026-10-09' } }),
      new Date()
    )
    await file(outside, 'memory/organization.md', '# Notes\nIts own notes (#general, 2026-10-11)', new Date())

    const move = new OrganizationRecordMove({ prisma, log })
    expect(await move.run()).toEqual({ organizations: 1 })

    const about = await entry('organization')
    expect(about.currentRevision).toBe(1)
    expect(about.revisions[0]).toMatchObject({ source: 'migration' })
    expect(about.revisions[0]!.content).toBe(
      '# Org\n\nIt sells to teams (#sales, 2026-10-12)\nIt builds tools (#general, 2026-10-10)\n'
    )
    expect((await entry('channels')).revisions[0]!.content).toBe(
      '# Channels\n\n#release: trains (#release, 2026-10-10)\n'
    )
    const people = await entry('people')
    expect(people.revisions[0]!.content).toBe(
      '# People\n\n## Ann (@ann on Slack) `slack:T0EXAMPLE:U0ANN`\nRole: designer (self, 2026-10-12)\n'
    )
    expect(new Set(people.readers)).toEqual(new Set([first, second]))
    const optOut = await prisma.organizationPeopleOptOut.findMany({ where: { orgId: DEFAULT_ORG_ID } })
    expect(optOut.map((row) => [row.key, row.clearedOn.toISOString().slice(0, 10)])).toEqual([
      ['slack:T0EXAMPLE:U0BOB', '2026-10-09']
    ])
    expect(await prisma.organizationRecord.findUniqueOrThrow({ where: { orgId: DEFAULT_ORG_ID } })).toMatchObject({
      researchAgentId: first,
      researchedAt: new Date('2026-10-10T10:00:00Z')
    })

    for (const path of ['memory/organization.md', 'memory/channels.md', 'people/.directory-opt-out.json'])
      expect(await read(first, path)).toBeNull()
    expect(await read(second, 'memory/members.md')).toBeNull()
    expect(await read(first, 'memory/MEMORY.md')).toBe('# Memory\n\n- [Deploys](deploys.md) — how we ship\n')
    expect(await read(outside, 'memory/organization.md')).not.toBeNull()

    // Nothing left to move: the record stays as it is.
    expect(await move.run()).toEqual({ organizations: 0 })
    // A copy an older daemon writes later is merged into the record on the next run.
    await file(
      first,
      'memory/channels.md',
      '# Channels\n#ops: incidents (#ops, 2026-10-14)',
      new Date('2026-10-14T00:00:00Z')
    )
    expect(await move.run()).toEqual({ organizations: 1 })
    const channels = await entry('channels')
    expect(channels.currentRevision).toBe(2)
    expect(channels.revisions[0]!.content).toBe(
      '# Channels\n\n#release: trains (#release, 2026-10-10)\n#ops: incidents (#ops, 2026-10-14)\n'
    )
  })
})
