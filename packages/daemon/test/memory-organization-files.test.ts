// The organization files' shapes (assistant-mode.md §5.15): each write into the shared layer is checked, naming the line that failed.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MEMBER_FIELDS,
  ORGANIZATION_MAX_BYTES,
  ORGANIZATION_SECTIONS,
  organizationFileOf,
  organizationFileRefusal,
  parseOrganizationFile
} from '../src/memory/organization-files.js'
import { LocalMemoryFs } from '../src/memory/fs.js'
import { localMemoryHome } from '../src/memory/home.js'
import { ManagedMemoryProvider } from '../src/memory/providers/managed.js'
import { createMemoryEntryService } from '../src/memory/entries/factory.js'
import { createMemoryEntriesWriter } from '../src/cp/memory-entries.js'
import { createMemoryReader, MemoryViolationError } from '../src/cp/memory-reader.js'
import { executeTool, type OpsDeps, type SessionContext } from '../src/mcp/ops.js'
import type { MemoryScope } from '../src/memory/types.js'
import { openTestStore } from './store-support.js'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const HEADER = '---\ndescription: what the organization does\n---\n\n'

const ORGANIZATION = `${HEADER}# Example Org

Example Org builds widgets for small shops (#release-train, 2026-10-15)
It sells them online (https://www.example.test/about, 2026-10-16) (web)

## Products and customers
- Widget, the main product (#release-train, 2026-10-15)
- Gadget, in beta (#support, 2026-10-12) (inferred)

## Repositories and systems
- The billing service lives in example-org/example-repo (example-org/example-repo README, 2026-10-17)
- Release steps are in the runbook ("Release runbook", 2026-10-01)
`

const CHANNELS = `---
description: where this agent is and what each place is for
---

- [slack] release-train: release decisions (#release-train, 2026-10-17)
- [slack] support: customer questions (#support, 2026-10-12)
`

const MEMBERS = `---
description: who works on what
---
# Who works on what

## Alice (@alice on Slack, @alice-gh on GitHub)
Role: release manager (self, 2026-10-02)
Works on: the 2.5 release train (#release-train, 2026-10-15)
Knows about: the billing service (example-org/example-repo CODEOWNERS, 2026-10-17)
Ask about: release dates and freezes (#release-train, 2026-10-15) (inferred)

## Bob (@bob on Slack)

Role: support lead (#support, 2026-10-12)
`

describe('the organization files’ shapes', () => {
  it('names the three files, without regard to case, and lets every other topic through', () => {
    expect(organizationFileOf('organization.md')).toBe('organization.md')
    expect(organizationFileOf('Members.MD')).toBe('members.md')
    expect(organizationFileOf('./channels.md')).toBe('channels.md')
    expect(organizationFileOf('release-train.md')).toBeUndefined()
    expect(organizationFileRefusal('release-train.md', 'anything at all')).toBeUndefined()
    expect(organizationFileRefusal('organization.md', '')).toBeUndefined()
    expect(organizationFileRefusal('organization.md', HEADER)).toBeUndefined()
  })

  it('accepts each file in its shape, and parses its facts and sources', () => {
    const organization = parseOrganizationFile('organization.md', ORGANIZATION)
    expect(organization.ok).toBe(true)
    if (!organization.ok || organization.parsed.file !== 'organization.md') throw new Error('parse failed')
    expect(organization.parsed.facts.map((f) => f.source)).toEqual([
      { kind: 'channel', name: 'release-train' },
      { kind: 'web', url: 'https://www.example.test/about' },
      { kind: 'channel', name: 'release-train' },
      { kind: 'channel', name: 'support' },
      { kind: 'repository', path: 'example-org/example-repo', part: 'README' },
      { kind: 'knowledge', title: 'Release runbook' }
    ])
    expect(organization.parsed.facts[1]).toMatchObject({ line: 8, web: true, inferred: false, date: '2026-10-16' })
    expect(organization.parsed.facts[3]).toMatchObject({ text: 'Gadget, in beta', inferred: true })

    const channels = parseOrganizationFile('channels.md', CHANNELS)
    expect(
      channels.ok && channels.parsed.file === 'channels.md' && channels.parsed.channels.map((c) => c.channel)
    ).toEqual(['release-train', 'support'])
  })

  it('hands the directory its entries, with each line’s field, source and line number', () => {
    const members = parseOrganizationFile('members.md', MEMBERS)
    if (!members.ok || members.parsed.file !== 'members.md') throw new Error('parse failed')
    expect(members.parsed.entries.map((e) => ({ line: e.line, name: e.name, handles: e.handles }))).toEqual([
      { line: 6, name: 'Alice', handles: ['@alice on Slack', '@alice-gh on GitHub'] },
      { line: 12, name: 'Bob', handles: ['@bob on Slack'] }
    ])
    expect(members.parsed.entries[0]!.facts.map((f) => [f.line, f.field, f.source.kind])).toEqual([
      [7, 'Role', 'self'],
      [8, 'Works on', 'channel'],
      [9, 'Knows about', 'repository'],
      [10, 'Ask about', 'channel']
    ])
    expect(members.parsed.entries[0]!.facts[3]).toMatchObject({
      inferred: true,
      text: 'Ask about: release dates and freezes'
    })
  })

  it('refuses a line with no source and date, naming the line in the whole file', () => {
    const text = ORGANIZATION.replace('- Gadget, in beta (#support, 2026-10-12) (inferred)', '- Gadget, in beta')
    expect(organizationFileRefusal('organization.md', text)).toBe(
      'organization.md line 12 "- Gadget, in beta" does not end with its source and date, as "(#release-train, ' +
        '2026-10-17)"; a source is a #channel, a "knowledge entry title", an owner/repo path, self, or a web address ' +
        'followed by (web). Nothing was saved; fix that line and save again.'
    )
  })

  it('refuses a source of no known form, an unreal date, and web markers that do not match the source', () => {
    const line = (tail: string) => `${HEADER}Example Org builds widgets ${tail}\n`
    expect(organizationFileRefusal('organization.md', line('(someone said, 2026-10-15)'))).toContain(
      'names "someone said" as its source, which is none of'
    )
    expect(organizationFileRefusal('organization.md', line('(#general, 2026-02-30)'))).toContain(
      'has "2026-02-30", which is not a real YYYY-MM-DD date'
    )
    expect(organizationFileRefusal('organization.md', line('(https://www.example.test, 2026-10-15)'))).toContain(
      'has a web address as its source, so it also ends with (web)'
    )
    expect(organizationFileRefusal('organization.md', line('(#general, 2026-10-15) (web)'))).toContain(
      'says (web), but its source is not a web address'
    )
    expect(organizationFileRefusal('organization.md', line('(#general, 2026-10-15) (inferred) (inferred)'))).toContain(
      'repeats a marker'
    )
    expect(organizationFileRefusal('organization.md', line('(#general, 2026-10-15) (inferred)'))).toBeUndefined()
  })

  it('keeps organization.md to its summary, its three sections and 16 KB', () => {
    expect(organizationFileRefusal('organization.md', `${HEADER}## Team\nAlice (self, 2026-10-01)\n`)).toContain(
      'line 5 "## Team" is a heading organization.md does not have; its only sections are "## Products and customers", "## How it works", "## Repositories and systems"'
    )
    expect(organizationFileRefusal('organization.md', `${HEADER}### Billing\n`)).toContain('is a heading')
    expect(organizationFileRefusal('organization.md', `${HEADER}## How it works\n\n## How it works\n`)).toContain(
      'line 7 "## How it works" repeats a section'
    )
    const summary = Array.from({ length: 11 }, (_, i) => `Fact ${i + 1} (#general, 2026-10-15)`).join('\n')
    expect(organizationFileRefusal('organization.md', `${HEADER}${summary}\n`)).toContain(
      'line 15 "Fact 11 (#general, 2026-10-15)" is line 11 of the summary before the first section; it holds at most 10'
    )
    const big = `${HEADER}## How it works\n${'- A fact (#general, 2026-10-15)\n'.repeat(600)}`
    expect(Buffer.byteLength(big)).toBeGreaterThan(ORGANIZATION_MAX_BYTES)
    expect(organizationFileRefusal('organization.md', big)).toMatch(
      /^organization\.md is [\d,]+ bytes, over its 16 KB limit/
    )
  })

  it('keeps channels.md to one sourced line per place, each naming its platform', () => {
    expect(organizationFileRefusal('channels.md', `${CHANNELS}#ops: incidents (#ops, 2026-10-15)\n`)).toContain(
      'line 7 "#ops: incidents (#ops, 2026-10-15)" is not one place\'s line, "- [<platform>] <name>: what it is for'
    )
    expect(organizationFileRefusal('channels.md', `${CHANNELS}- [irc] ops: incidents (#ops, 2026-10-15)\n`)).toContain(
      'names "[irc]", which is no platform; a place\'s platform is one of slack, telegram, discord, feishu, googlechat, qq'
    )
    expect(
      organizationFileRefusal('channels.md', `${CHANNELS}- [slack] #ops: incidents (#ops, 2026-10-15)\n`)
    ).toContain('writes "#ops" with a sigil; write the name as the platform shows it, without "#"')
    expect(
      organizationFileRefusal('channels.md', `${CHANNELS}- [slack] Release-Train: again (#release-train, 2026-10-17)\n`)
    ).toContain('repeats Release-Train on slack from line 5; keep one line per place')
    expect(
      organizationFileRefusal(
        'channels.md',
        `${CHANNELS}- [discord] release-train: again (#release-train, 2026-10-17)\n`
      )
    ).toBeUndefined()
    expect(organizationFileRefusal('channels.md', `${CHANNELS}- [slack] ops: incidents\n`)).toContain(
      'line 7 "- [slack] ops: incidents" does not end with its source and date'
    )
    // A link to an agent's own place file never reaches Channels, which keeps purposes only.
    expect(
      organizationFileRefusal('channels.md', `${CHANNELS}- [slack] ops: incidents, see [[ops]] (#ops, 2026-10-15)\n`)
    ).toContain(
      'line 7 "- [slack] ops: incidents, see [[ops]] (#ops, 2026-10-15)" carries a [[link]]; Channels keeps purposes only, so drop the link'
    )
  })

  it('keeps members.md to entries of at most ten lines in four fields', () => {
    expect(organizationFileRefusal('members.md', `${MEMBERS}Likes: coffee (self, 2026-10-02)\n`)).toContain(
      'line 15 "Likes: coffee (self, 2026-10-02)" starts with none of Role:, Works on:, Knows about:, Ask about:'
    )
    expect(organizationFileRefusal('members.md', 'Alice runs releases (self, 2026-10-02)\n')).toContain(
      'is outside any entry'
    )
    expect(organizationFileRefusal('members.md', '## Alice\nRole: release manager (self, 2026-10-02)\n')).toContain(
      'line 1 "## Alice" is not an entry\'s heading, "## <display name> (<handles>) `<key>`"'
    )
    const eleven = Array.from({ length: 11 }, (_, i) => `Works on: project ${i + 1} (#general, 2026-10-15)`).join('\n')
    expect(organizationFileRefusal('members.md', `## Alice (@alice on Slack)\n${eleven}\n`)).toContain(
      'line 12 "Works on: project 11 (#general, 2026-10-15)" is line 11 of Alice\'s entry; an entry has at most 10'
    )
    expect(organizationFileRefusal('members.md', '## Alice (@alice on Slack)\nRole: release manager\n')).toContain(
      'does not end with its source and date'
    )
  })

  it('pins the sections and fields the prompts name to the ones the check accepts', () => {
    expect(ORGANIZATION_SECTIONS).toEqual(['Products and customers', 'How it works', 'Repositories and systems'])
    expect(MEMBER_FIELDS).toEqual(['Role', 'Works on', 'Knows about', 'Ask about'])
  })
})

async function managedHome() {
  const dir = await mkdtemp(join(tmpdir(), 'org-files-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const db = await openTestStore(join(dir, 'state.sqlite'))
  cleanup.push(() => db.close())
  const fs = new LocalMemoryFs(join(dir, 'home'))
  const provider = new ManagedMemoryProvider(() => localMemoryHome(fs))
  return { fs, db, provider }
}

describe('the entry writer checks the final text', () => {
  it('refuses a create, a whole update and an exact edit that break the shape, and stores nothing', async () => {
    const { fs, db, provider } = await managedHome()
    const api = await createMemoryEntryService({
      provider,
      store: db,
      scope: { agentId: 'agent' },
      canRead: () => true,
      write: { source: 'tool', canWrite: () => true, check: organizationFileRefusal }
    })
    await expect(api.create({ label: 'channels', text: '- [slack] ops: incidents\n' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining(
        'channels.md line 1 "- [slack] ops: incidents" does not end with its source and date'
      )
    })
    expect(await fs.readFile('memory/channels.md')).toBeNull()

    const created = await api.create({ label: 'channels', text: CHANNELS })
    const { ref, revision } = created.entry!
    await expect(api.update({ ref, revision, text: `${CHANNELS}- [slack] ops: incidents\n` })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT'
    })
    // An exact edit is checked on the file it would leave, which only the writer sees.
    await expect(
      api.update({ ref, revision, edit: { oldText: ' (#support, 2026-10-12)', newText: '' } })
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      // The stored file's header carries its name and modified time too, so its line numbers are the stored file's.
      message: expect.stringContaining('line 8 "- [slack] support: customer')
    })
    expect((await fs.readFile('memory/channels.md'))!.content).toContain(
      '- [slack] support: customer questions (#support'
    )
    // Any other topic, and a place layer's own files, pass.
    await expect(api.create({ label: 'release-train', text: 'anything' })).resolves.toMatchObject({
      state: 'completed'
    })
  })
})

describe('the memory tools check what they write into the shared layer', () => {
  const ctx = (over: Partial<SessionContext> = {}): SessionContext => ({
    agentId: 'agent',
    platform: 'slack',
    channel: 'C1',
    thread: 'T1',
    deliveryThread: 'T1',
    isDm: false,
    tools: [],
    ...over
  })
  async function deps(scope: MemoryScope) {
    const home = await managedHome()
    return {
      home,
      deps: { memory: home.provider, memoryEntryStore: home.db, memoryScope: () => scope } as unknown as OpsDeps
    }
  }

  it('refuses writeMemory’s whole write and edit into the shared layer, and lets a place layer’s through', async () => {
    const shared = await deps({ agentId: 'agent' })
    await expect(
      executeTool(ctx(), 'writeMemory', { path: 'organization.md', content: `${HEADER}## Team\n` }, shared.deps)
    ).rejects.toThrow('organization.md line 5 "## Team" is a heading organization.md does not have')
    await executeTool(ctx(), 'writeMemory', { path: 'organization.md', content: ORGANIZATION }, shared.deps)
    await expect(
      executeTool(
        ctx(),
        'writeMemory',
        { path: 'organization.md', oldString: ' (#support, 2026-10-12) (inferred)', newString: '' },
        shared.deps
      )
    ).rejects.toThrow('organization.md line 14 "- Gadget, in beta" does not end with its source and date')

    const place = await deps({ agentId: 'agent', channelKey: 'C1' })
    await expect(
      executeTool(ctx(), 'writeMemory', { path: 'organization.md', content: 'notes of this place' }, place.deps)
    ).resolves.toMatchObject({ ok: true, layer: 'here' })
  })

  it('refuses an entry tool’s write with the line, as INVALID_ARGUMENT', async () => {
    const shared = await deps({ agentId: 'agent' })
    await expect(
      executeTool(ctx(), 'createMemoryEntry', { label: 'members', text: '## Alice\n' }, shared.deps)
    ).rejects.toThrow(/INVALID_ARGUMENT: members\.md line 1 "## Alice" is not an entry's heading/)
    await expect(
      executeTool(ctx(), 'createMemoryEntry', { label: 'members', text: MEMBERS }, shared.deps)
    ).resolves.toMatchObject({ state: 'completed', layer: 'shared' })
  })

  it('checks a bound session only when its binding names the shared layer', async () => {
    const { deps: d, home } = await deps({ agentId: 'agent' })
    const staged = { source: 'tool' as const, scope: { agentId: 'agent', root: home.fs } }
    const bad = { path: 'channels.md', content: '- [slack] ops: incidents\n' }
    await expect(executeTool(ctx({ memoryBinding: staged }), 'writeMemory', bad, d)).resolves.toMatchObject({
      ok: true
    })
    await expect(
      executeTool(ctx({ memoryBinding: { ...staged, layer: 'shared' } }), 'writeMemory', bad, d)
    ).rejects.toThrow('channels.md line 1 "- [slack] ops: incidents" does not end with its source and date')
  })
})

describe('the Memory page gets the same refusal', () => {
  it('refuses a console entry write into the shared layer, not into a place layer', async () => {
    const { db, provider } = await managedHome()
    const write = createMemoryEntriesWriter(provider, db, () => true)
    const refused = await write({
      agentId: 'agent',
      operation: 'create',
      request: { label: 'channels', text: '#ops\n' }
    })
    expect(refused).toMatchObject({ operation: 'error', code: 'INVALID_ARGUMENT' })
    expect(refused.operation === 'error' && refused.message).toContain('channels.md line 1 "#ops" is not one place')
    await expect(
      write({ agentId: 'agent', channelKey: 'C1', operation: 'create', request: { label: 'channels', text: '#ops\n' } })
    ).resolves.toMatchObject({ operation: 'completed' })
  })

  it('refuses a console file write into the shared layer', async () => {
    const { fs } = await managedHome()
    const reader = createMemoryReader(() => localMemoryHome(fs))
    await expect(
      reader.write({ agentId: 'agent', path: 'members.md', content: 'Alice runs releases\n' })
    ).rejects.toThrow(MemoryViolationError)
    // The people directory itself is changed in the console only by clearing an entry (assistant-mode.md §5.17).
    await expect(reader.write({ agentId: 'agent', path: 'members.md', content: MEMBERS })).rejects.toThrow(
      'members.md is changed in the console only by clearing an entry'
    )
  })
})
