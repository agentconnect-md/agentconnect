// The organization record as an assistant-mode agent's shared layer sees it (assistant-mode.md §5.16).
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalMemoryFs } from '../src/memory/fs.js'
import { localMemoryHome } from '../src/memory/home.js'
import { ManagedMemoryProvider } from '../src/memory/providers/managed.js'
import { createMemoryEntryService } from '../src/memory/entries/factory.js'
import { organizationFileRefusal, type OrganizationFile } from '../src/memory/organization-files.js'
import {
  RecordUnavailableError,
  type OrganizationRecordPort,
  type RecordEntry,
  type RecordWrite
} from '../src/memory/organization-record.js'
import type { MemoryScope, MemoryWriteGuard } from '../src/memory/types.js'
import { readerOnboardingMessage, researchRunningLine } from '../src/assistant/research.js'
import { findKnowledge, listKnowledge } from '../src/mcp/ops/knowledge.js'
import type { SessionContext } from '../src/mcp/ops/context.js'
import { openTestStore } from './store-support.js'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

/** The Control Plane's record, in memory: a revision per entry, a write refused when its base is stale. */
class FakeRecord implements OrganizationRecordPort {
  readonly entries = new Map<OrganizationFile, RecordEntry>([
    ['organization.md', { revision: 1, content: '# About', optOut: [] }],
    ['channels.md', { revision: 1, content: '# Channels', optOut: [] }],
    ['members.md', { revision: 1, content: '# People', optOut: [] }]
  ])
  readonly writes: (RecordWrite & { file: OrganizationFile })[] = []
  peopleHidden = false
  unavailable = false

  async read(file: OrganizationFile): Promise<RecordEntry> {
    if (this.unavailable) throw new RecordUnavailableError()
    if (file === 'members.md' && this.peopleHidden)
      throw Object.assign(new Error('not visible'), { code: 'SCOPE_DENIED' })
    return this.entries.get(file)!
  }

  async write(file: OrganizationFile, write: RecordWrite) {
    const current = this.entries.get(file)!
    if (current.revision !== write.baseRevision) return { conflict: current }
    this.writes.push({ file, ...write })
    const optOut = [...current.optOut.filter((k) => !write.optOut.lift.includes(k)), ...write.optOut.mark]
    this.entries.set(file, { revision: current.revision + 1, content: write.content, optOut })
    return { revision: current.revision + 1 }
  }
}

async function fixture(scope: Partial<MemoryScope> = {}, guard?: MemoryWriteGuard) {
  const dir = await mkdtemp(join(tmpdir(), 'org-record-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const db = await openTestStore(join(dir, 'state.sqlite'))
  cleanup.push(() => db.close())
  const fs = new LocalMemoryFs(join(dir, 'home'))
  const record = new FakeRecord()
  const provider = new ManagedMemoryProvider(
    () => localMemoryHome(fs),
    undefined,
    undefined,
    () => record
  )
  const full: MemoryScope = { agentId: 'agent', withOutsiders: false, recordWriter: 'first-look', ...scope }
  await provider.ensure(full, 'agent')
  const api = await createMemoryEntryService({
    provider,
    store: db,
    scope: full,
    canRead: () => true,
    write: { source: 'tool', canWrite: () => true, check: organizationFileRefusal, ...(guard ? { guard } : {}) }
  })
  const refOf = async (label: string) => (await api.list({ limit: 100 })).entries.find((e) => e.label === label)?.ref
  return { fs, record, provider, api, scope: full, refOf }
}

const CHANNELS = '# Channels\n- [slack] release: release trains and freezes (#release, 2026-10-17)'

describe('the record-backed shared layer', () => {
  it('lists the record entries, fills a title-only entry on create, and writes by revision', async () => {
    const f = await fixture()
    await f.fs.writeFile(
      'memory/channels.md',
      '# Channels\n- [slack] old: a copy an older daemon left (#old, 2026-10-01)'
    )
    const labels = (await f.api.list({ limit: 100 })).entries.map((e) => e.label)
    expect(labels).toEqual(expect.arrayContaining(['organization', 'channels', 'members']))
    expect(labels.filter((label) => label === 'channels')).toHaveLength(1)

    const created = await f.api.create({ label: 'channels', text: CHANNELS })
    expect(created.state).toBe('completed')
    expect(f.record.writes).toEqual([
      expect.objectContaining({ file: 'channels.md', baseRevision: 1, writerKind: 'first-look', content: CHANNELS })
    ])
    await expect(f.api.create({ label: 'channels', text: CHANNELS })).rejects.toMatchObject({ code: 'CONFLICT' })

    const ref = (await f.refOf('channels'))!
    const read = (await f.api.get({ ref }))!
    expect(read.text).toBe(CHANNELS)
    const more = `${CHANNELS}\n- [slack] ops: incidents (#ops, 2026-10-17)`
    await f.api.update({ ref, revision: read.entry.revision, text: more })
    expect(f.record.entries.get('channels.md')).toMatchObject({ revision: 3, content: more })
    await expect(f.api.update({ ref, revision: read.entry.revision, text: CHANNELS })).rejects.toMatchObject({
      code: 'CONFLICT'
    })
    await expect(
      f.api.update({ ref, revision: (await f.api.get({ ref }))!.entry.revision, text: '# Channels\n#x: y' })
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT'
    })
    await expect(f.api.delete({ ref, revision: (await f.api.get({ ref }))!.entry.revision })).rejects.toMatchObject({
      code: 'FORBIDDEN'
    })
  })

  it('refuses a whole-file write and keeps the record out of the stored index, adding its lines on read', async () => {
    const f = await fixture()
    await expect(f.provider.write(f.scope, 'organization.md', '# About\n')).rejects.toThrow(/entry tools/)
    await f.api.create({ label: 'deploys', text: '---\ndescription: how we ship\n---\nDeploys go out on Tuesdays.' })
    const stored = (await f.fs.readFile('memory/MEMORY.md'))!.content
    expect(stored).toContain('[deploys](deploys.md)')
    expect(stored).not.toMatch(/organization\.md|channels\.md|members\.md/)
    const standing = await f.provider.standingContextAtSessionStart(f.scope)
    expect(standing).toContain('- [About](organization.md) — what the organization does; nothing recorded yet')
    expect(standing).toContain('- [Channels](channels.md) — what each place is for, 0 places')
    expect(standing).toContain('- [People](members.md) — who works on what, 0 people')
  })

  it('withholds People with outsiders or where it is not visible, and leaves the rest', async () => {
    const outsiders = await fixture({ withOutsiders: true })
    expect((await outsiders.api.list({ limit: 100 })).entries.map((e) => e.label)).not.toContain('members')
    expect(await outsiders.provider.standingContextAtSessionStart(outsiders.scope)).not.toContain('members.md')
    await expect(outsiders.provider.read(outsiders.scope, 'members.md')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await outsiders.provider.read(outsiders.scope, 'channels.md')).content).toBe('# Channels')

    const hidden = await fixture()
    hidden.record.peopleHidden = true
    expect((await hidden.api.list({ limit: 100 })).entries.map((e) => e.label)).toEqual(
      expect.arrayContaining(['organization', 'channels'])
    )
    await expect(hidden.provider.read(hidden.scope, 'members.md')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('refuses the three names with one line, never the shared layer, when the record is not available', async () => {
    const f = await fixture()
    await f.fs.writeFile('memory/channels.md', '# Channels\n- [slack] old: a copy (#old, 2026-10-01)')
    f.record.unavailable = true
    expect((await f.api.list({ limit: 100 })).entries.map((e) => e.label)).not.toContain('channels')
    await expect(f.provider.read(f.scope, 'channels.md')).rejects.toThrow(
      'the organization record is not available right now'
    )
    await expect(f.api.create({ label: 'organization', text: '# About' })).rejects.toMatchObject({
      code: 'UNAVAILABLE'
    })
    expect(await f.provider.standingContextAtSessionStart(f.scope)).not.toContain('channels.md')
  })

  it("sends the person rules' opt-out changes with the People write", async () => {
    const f = await fixture({ recordWriter: 'person' }, async () => ({ mark: ['slack:T0EXAMPLE:U0BOB'], lift: [] }))
    const ref = (await f.refOf('members'))!
    const entry = '# People\n## Ann (@ann on Slack) `slack:T0EXAMPLE:U0ANN`\nRole: designer (self, 2026-10-17)'
    await f.api.update({ ref, revision: (await f.api.get({ ref }))!.entry.revision, text: entry })
    expect(f.record.writes.at(-1)).toMatchObject({
      file: 'members.md',
      writerKind: 'person',
      optOut: { mark: ['slack:T0EXAMPLE:U0BOB'], lift: [] }
    })
  })
})

describe('onboarding and knowledge reads', () => {
  it('greets an agent that does not research by naming the agent that did', () => {
    const text = readerOnboardingMessage({
      person: 'Ann',
      enabler: true,
      researchedBy: { name: 'Atlas', at: '2026-10-17T09:00:00.000Z' },
      timeZone: 'UTC'
    })
    expect(text).toContain('Atlas researched it on 2026-10-17')
    expect(text).toContain('ask Atlas in their direct message')
    expect(researchRunningLine(Date.UTC(2026, 9, 17, 14, 5), 'UTC')).toContain(
      'what is known about the organization may be incomplete'
    )
  })

  it('sends withOutsiders on findKnowledge and listKnowledge when the conversation may hold outsiders', async () => {
    const seen: unknown[] = []
    const deps = {
      findKnowledge: async (req: unknown) => (seen.push(req), { items: [] }),
      listKnowledge: async (req: unknown) => (seen.push(req), { items: [] }),
      outsiders: async () => true
    }
    const ctx = { agentId: 'agent' } as SessionContext
    await findKnowledge(ctx, { query: 'release' }, deps)
    await listKnowledge(ctx, {}, deps)
    await findKnowledge(ctx, { query: 'release' }, { ...deps, outsiders: async () => false })
    expect(seen).toEqual([
      expect.objectContaining({ withOutsiders: true }),
      expect.objectContaining({ withOutsiders: true }),
      expect.not.objectContaining({ withOutsiders: true })
    ])
  })
})
