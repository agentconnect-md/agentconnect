/**
 * Memory headers + the generated index (#41): frontmatter carries the `description`
 * a future session uses to pick a topic, `[[name]]` links resolve on read, and
 * MEMORY.md is derived from those descriptions instead of hand-maintained.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryFs } from '../src/memory/fs.js'
import {
  buildMemoryHeader,
  memoryLinkTargets,
  memoryRefToTopic,
  parseMemoryFrontmatter,
  stampMemoryHeader,
  MEMORY_FORMAT_GUIDANCE,
  normalizeMemoryHeader
} from '../src/memory/frontmatter.js'
import { dreamSystemPrompt } from '../src/dream/dreamer.js'
import {
  ensureMemory,
  MAX_MEMORY_FILE_BYTES,
  memoryNeighbors,
  readMemoryFile,
  regenerateMemoryIndexHoldingLock,
  writeMemoryFile,
  memoryChannelKey
} from '../src/memory/store.js'
import { MEMORY_DISTILLATION_SYSTEM_PROMPT } from '../src/memory/distill.js'
import { createMemoryProvider } from '../src/memory/providers/factory.js'

const fs = () => new LocalMemoryFs(mkdtempSync(join(tmpdir(), 'ac-fm-')))

describe('memory frontmatter', () => {
  it('parses a header, and treats a headerless file as all body', () => {
    const withHeader = parseMemoryFrontmatter(
      '---\nname: deploys\ndescription: "How we ship: pipeline owns it"\ntype: project\n---\n\n- port 4242\n'
    )
    expect(withHeader.hadHeader).toBe(true)
    expect(withHeader.header).toMatchObject({
      name: 'deploys',
      description: 'How we ship: pipeline owns it',
      type: 'project'
    })
    expect(withHeader.body).toBe('- port 4242\n')

    const legacy = parseMemoryFrontmatter('- just a note\n')
    expect(legacy.hadHeader).toBe(false)
    expect(legacy.body).toBe('- just a note\n')
    expect(legacy.header).toEqual({})
  })

  it('survives a malformed header without swallowing the file', () => {
    // An unterminated fence is not a header — never swallow the file as one.
    expect(parseMemoryFrontmatter('---\nname: x\nstill going').hadHeader).toBe(false)
    // An unknown `type` is not silently accepted as one of ours.
    expect(parseMemoryFrontmatter('---\ntype: bogus\n---\nbody\n').header.type).toBeUndefined()
  })

  it('stamps losslessly — nested blocks, comments, and quoting all survive a write', () => {
    // Claude Code writes a nested `metadata:` block; re-serializing from the parsed
    // model would silently delete it, so stamping must patch lines in place.
    const original = [
      '---',
      '# a comment',
      'description: "quoted: with a colon"',
      'metadata:',
      '  node_type: memory',
      '  originSessionId: abc-123',
      'custom-key: keep-me',
      '---',
      '',
      'body text',
      ''
    ].join('\n')

    const stamped = stampMemoryHeader('deploys.md', original, '2026-08-19T00:00:00.000Z')
    for (const kept of [
      '# a comment',
      'metadata:',
      '  node_type: memory',
      '  originSessionId: abc-123',
      'custom-key: keep-me',
      'description: "quoted: with a colon"'
    ]) {
      expect(stamped).toContain(kept)
    }
    expect(stamped).toContain('name: deploys')
    expect(stamped).toContain('modified: 2026-08-19T00:00:00.000Z')
    expect(stamped).toContain('body text')
    // Re-stamping replaces the same two lines rather than appending duplicates.
    const again = stampMemoryHeader('deploys.md', stamped, '2026-08-20T00:00:00.000Z')
    expect(again.match(/^name:/gm)).toHaveLength(1)
    expect(again.match(/^modified:/gm)).toHaveLength(1)
    expect(again).toContain('modified: 2026-08-20T00:00:00.000Z')
    expect(again).not.toContain('2026-08-19')
  })

  it('resolves [[links]], bare names, and file names to a topic file', () => {
    expect(memoryRefToTopic('[[deploys]]')).toBe('deploys.md')
    expect(memoryRefToTopic('deploys')).toBe('deploys.md')
    expect(memoryRefToTopic('deploys.md')).toBe('deploys.md')
    // Anything that is not a plain slug passes through untouched, so the path
    // validator still rejects it — notably the reserved `.history` sidecar, which
    // must never become the topic `.history.md`.
    expect(memoryRefToTopic('../escape')).toBe('../escape')
    expect(memoryRefToTopic('.history')).toBe('.history')
    expect(memoryRefToTopic('[[.history]]')).toBe('.history')
    expect(memoryRefToTopic('a/b')).toBe('a/b')
    expect(memoryLinkTargets('see [[a]] and [[b]], plus [[a]] again')).toEqual(['a', 'b'])
  })

  it('stamps name/modified only on a file that already has a header', () => {
    const stamped = stampMemoryHeader('deploys.md', '---\ndescription: d\n---\nbody\n', '2026-08-19T00:00:00.000Z')
    expect(stamped).toContain('name: deploys')
    expect(stamped).toContain('modified: 2026-08-19T00:00:00.000Z')
    // A plain note stays plain — frontmatter is never forced onto it.
    expect(stampMemoryHeader('n.md', 'plain\n', '2026-08-19T00:00:00.000Z')).toBe('plain\n')
  })
})

describe('generated memory index', () => {
  it('rebuilds MEMORY.md from topic descriptions, sorted, and refreshes on change', async () => {
    const f = fs()
    await ensureMemory(f, 'bot')
    await writeMemoryFile(f, 'zeta.md', '---\ndescription: last one\n---\nz\n', undefined, 'tool')
    await writeMemoryFile(f, 'alpha.md', '---\ndescription: first one\n---\na\n', undefined, 'tool')

    const index = await readMemoryFile(f, 'MEMORY.md')
    expect(index).toContain('- [alpha](alpha.md) — first one')
    expect(index).toContain('- [zeta](zeta.md) — last one')
    expect(index.indexOf('alpha')).toBeLessThan(index.indexOf('zeta'))
    expect(index).toContain('generated')

    // Editing a description re-renders the entry rather than duplicating it.
    await writeMemoryFile(f, 'alpha.md', '---\ndescription: renamed\n---\na\n', undefined, 'tool')
    const updated = await readMemoryFile(f, 'MEMORY.md')
    expect(updated).toContain('- [alpha](alpha.md) — renamed')
    expect(updated).not.toContain('first one')
  })

  it('leaves a legacy hand-written index alone until a described topic exists', async () => {
    const f = fs()
    await ensureMemory(f, 'bot')
    await writeMemoryFile(f, 'MEMORY.md', '# bot memory\n\nmy own notes\n', undefined, 'tool')
    // A headerless topic gives nothing to generate from, so the index is untouched.
    await writeMemoryFile(f, 'plain.md', 'no header here\n', undefined, 'tool')
    expect(await readMemoryFile(f, 'MEMORY.md')).toContain('my own notes')

    // The first described topic migrates it to the generated form.
    await writeMemoryFile(f, 'described.md', '---\ndescription: has one\n---\nx\n', undefined, 'tool')
    const index = await readMemoryFile(f, 'MEMORY.md')
    expect(index).toContain('- [described](described.md) — has one')
    expect(index).toContain('# bot memory') // the agent's own heading is preserved
    expect(index).toContain('- [plain](plain.md)') // headerless topics still get listed
  })

  it('clears an entry when its description is removed, instead of freezing stale text', async () => {
    const f = fs()
    await ensureMemory(f, 'bot')
    await writeMemoryFile(f, 'a.md', '---\ndescription: original text\n---\na\n', undefined, 'tool')
    expect(await readMemoryFile(f, 'MEMORY.md')).toContain('original text')

    // Dropping the last description must not leave the index frozen with it.
    await writeMemoryFile(f, 'a.md', '---\ntype: project\n---\na\n', undefined, 'tool')
    const index = await readMemoryFile(f, 'MEMORY.md')
    expect(index).not.toContain('original text')
    expect(index).toContain('- [a](a.md)')
  })

  it('keeps the generated index inside the managed file bound', async () => {
    const f = fs()
    await ensureMemory(f, 'bot')
    const description = 'x'.repeat(4_000)
    // Enough described topics that the naive index would blow past the write cap.
    for (let i = 0; i < 80; i++) {
      await writeMemoryFile(f, `topic-${i}.md`, `---\ndescription: ${description}\n---\nbody\n`, undefined, 'tool')
    }
    const index = await readMemoryFile(f, 'MEMORY.md')
    expect(Buffer.byteLength(index)).toBeLessThanOrEqual(MAX_MEMORY_FILE_BYTES)
    expect(index).toContain('more topics than fit the index')
  })

  it('readMemory accepts the [[link]] form the agent sees in a body', async () => {
    const f = fs()
    await ensureMemory(f, 'bot')
    await writeMemoryFile(f, 'deploys.md', '---\ndescription: d\n---\nport 4242\n', undefined, 'tool')
    expect(await readMemoryFile(f, '[[deploys]]')).toContain('port 4242')
    expect(await readMemoryFile(f, 'deploys')).toContain('port 4242')
  })
})

describe('memory graph (one hop)', () => {
  const write = (f: ReturnType<typeof fs>, topic: string, description: string, body: string) =>
    writeMemoryFile(f, topic, `---\ndescription: ${description}\n---\n${body}\n`, undefined, 'tool')

  it('reports outgoing links and backlinks, each with its description', async () => {
    const f = fs()
    await ensureMemory(f, 'bot')
    await write(f, 'deploys.md', 'how we ship', 'pipeline owns it, see [[runtimes]]')
    await write(f, 'runtimes.md', 'which runtimes we support', 'claude and codex')
    await write(f, 'oncall.md', 'who to page', 'escalate per [[deploys]]')

    const from = await memoryNeighbors(f, 'deploys.md')
    expect(from.links).toEqual([
      { name: 'runtimes', topic: 'runtimes.md', description: 'which runtimes we support', exists: true }
    ])
    // oncall links to deploys, so deploys sees it as a backlink.
    expect(from.backlinks).toEqual([{ name: 'oncall', topic: 'oncall.md', description: 'who to page', exists: true }])

    // The graph is symmetric from the other end.
    expect((await memoryNeighbors(f, 'runtimes.md')).backlinks.map((n) => n.name)).toEqual(['deploys'])
  })

  it('keeps a link to a memory that does not exist yet, marked as such', async () => {
    const f = fs()
    await ensureMemory(f, 'bot')
    await write(f, 'a.md', 'has a forward reference', 'todo: write [[not-yet]]')

    const { links } = await memoryNeighbors(f, 'a.md')
    expect(links).toEqual([{ name: 'not-yet', topic: 'not-yet.md', exists: false }])
  })

  it('accepts a [[link]] as the lookup and ignores a self-link', async () => {
    const f = fs()
    await ensureMemory(f, 'bot')
    await write(f, 'solo.md', 'points at itself', 'see [[solo]] and [[other]]')
    await write(f, 'other.md', 'the other one', 'x')

    const { links } = await memoryNeighbors(f, '[[solo]]')
    expect(links.map((n) => n.name)).toEqual(['other'])
  })
})

describe('memory graph through the live provider path', () => {
  const withHeader = (description: string, body: string) => `---\ndescription: ${description}\n---\n${body}\n`

  // The tool layer only ever sees the DISPATCHER, so exercising the managed provider
  // directly is not enough: this is the path production actually takes.
  const dispatcher = (dir: string) =>
    createMemoryProvider({
      memoryFsFor: () => new LocalMemoryFs(dir),
      providerKindFor: () => 'managed' as const
    } as never)

  it('returns links through the dispatcher, not just the managed provider', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-disp-'))
    const provider = dispatcher(dir)
    const scope = { agentId: 'bot-a' }
    provider.ensure(scope, 'bot')
    await provider.write(scope, 'a.md', withHeader('the a one', 'points at [[b]]'), undefined, 'tool')
    await provider.write(scope, 'b.md', withHeader('the b one', 'leaf'), undefined, 'tool')

    const related = await provider.neighbors?.(scope, 'a.md')
    expect(related?.links).toEqual([{ name: 'b', topic: 'b.md', description: 'the b one', exists: true }])
    expect((await provider.neighbors?.(scope, 'b.md'))?.backlinks.map((n) => n.name)).toEqual(['a'])
  })

  it('follows edges across the channel/base overlay, preferring the shadowing file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-overlay-'))
    const provider = dispatcher(dir)
    const base = { agentId: 'bot-a' }
    const chan = { agentId: 'bot-a', channelKey: memoryChannelKey('C1'), channel: 'C1' }
    provider.ensure(base, 'bot')
    provider.ensure(chan, 'bot')

    // Shared base holds `policy`; the channel layer holds a note linking to it.
    await provider.write(base, 'policy.md', withHeader('the shared policy', 'base text'), undefined, 'tool')
    await provider.write(chan, 'note.md', withHeader('a channel note', 'per [[policy]]'), undefined, 'tool')

    // The cross-layer edge resolves, using the base file's description.
    const fromNote = await provider.neighbors?.(chan, 'note.md')
    expect(fromNote?.links).toEqual([
      { name: 'policy', topic: 'policy.md', description: 'the shared policy', exists: true }
    ])
    // …and the base memory sees the channel note linking back to it.
    expect((await provider.neighbors?.(chan, 'policy.md'))?.backlinks.map((n) => n.name)).toEqual(['note'])

    // When the channel shadows a base file, the neighbour describes the file that
    // `readMemory` would actually open — the channel one.
    await provider.write(chan, 'policy.md', withHeader('the channel override', 'chan text'), undefined, 'tool')
    const shadowed = await provider.neighbors?.(chan, 'note.md')
    expect(shadowed?.links[0]?.description).toBe('the channel override')
  })
})

describe('dream adoption and index ownership', () => {
  it('hands the index to the generator at adopt, when the adopted topics support it', async () => {
    // Simulates the adopt swap: a hand-authored MEMORY.md written straight to disk
    // (as adopt does), alongside topics that DO carry descriptions.
    const f = fs()
    await ensureMemory(f, 'bot')
    await f.writeFile('memory/MEMORY.md', '# bot memory\n\nthe dream wrote this by hand\n', {})
    await f.writeFile('memory/a.md', '---\ndescription: from the dream\n---\na\n', {})

    await regenerateMemoryIndexHoldingLock(f, 'dream')
    const index = await readMemoryFile(f, 'MEMORY.md')
    expect(index).toContain('- [a](a.md) — from the dream')
    expect(index).not.toContain('the dream wrote this by hand')
    expect(index).toContain('# bot memory') // the heading is still preserved
  })

  it('leaves a dream-authored index alone when nothing can be generated from it', async () => {
    const f = fs()
    await ensureMemory(f, 'bot')
    await f.writeFile('memory/MEMORY.md', '# bot memory\n\ncurated by the dream\n', {})
    await f.writeFile('memory/a.md', 'no header here\n', {})

    await regenerateMemoryIndexHoldingLock(f, 'dream')
    expect(await readMemoryFile(f, 'MEMORY.md')).toContain('curated by the dream')
  })
})

describe('normalizing model-written frontmatter', () => {
  it('re-quotes an unsafe description the dream wrote as free text', () => {
    // The dream emits frontmatter as opaque text; `ship: prod` would split the
    // key/value and — with auto-adopt on — go live malformed.
    const raw = '---\ndescription: ship: prod #now\ntype: project\n---\nbody\n'
    const fixed = normalizeMemoryHeader(raw)
    // Our own parser is lenient, so the point is the STORED bytes: the value is now a
    // properly quoted scalar that a strict YAML reader accepts, matching what the
    // distillation path already writes.
    expect(fixed).toContain('description: "ship: prod #now"')
    expect(parseMemoryFrontmatter(fixed).header.description).toBe('ship: prod #now')
    expect(parseMemoryFrontmatter(fixed).header.type).toBe('project')
    expect(fixed).toContain('body')
  })

  it('quotes EVERY YAML indicator a description can start with', () => {
    // `#` would read as a comment (null value) and `?` is outright invalid; the rest
    // are indicators too. Table-driven so a future edit cannot quietly drop one.
    const leading = ['-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', "'", '"', '%', '@', '`']
    for (const ch of leading) {
      const value = `${ch} release policy`
      const fixed = normalizeMemoryHeader(`---\ndescription: ${value}\n---\nbody\n`)
      // Stored as a quoted scalar…
      expect(fixed).toContain(`description: ${JSON.stringify(value)}`)
      // …and still reads back as exactly what the model meant.
      expect(parseMemoryFrontmatter(fixed).header.description).toBe(value)
    }
  })

  it('leaves an ordinary description unquoted', () => {
    const fixed = normalizeMemoryHeader('---\ndescription: how we ship to prod\n---\nbody\n')
    expect(fixed).toContain('description: how we ship to prod')
  })

  it('is idempotent and leaves everything it does not own untouched', () => {
    const raw = [
      '---',
      '# a comment',
      'description: "already: quoted"',
      'metadata:',
      '  node_type: memory',
      'custom: keep-me',
      '---',
      '',
      'body',
      ''
    ].join('\n')
    const once = normalizeMemoryHeader(raw)
    expect(once).toBe(normalizeMemoryHeader(once))
    for (const kept of ['# a comment', 'metadata:', '  node_type: memory', 'custom: keep-me']) {
      expect(once).toContain(kept)
    }
    expect(parseMemoryFrontmatter(once).header.description).toBe('already: quoted')
  })

  it('leaves a headerless dream file alone', () => {
    expect(normalizeMemoryHeader('just a note\n')).toBe('just a note\n')
  })
})

describe('a description survives the real write path', () => {
  it('round-trips quotes and backslashes, and reaches the generated index', async () => {
    const f = fs()
    await ensureMemory(f, 'bot')
    const nasty = 'he said "ship it", path C:\\tmp — see #2'
    // Exactly what a model writes through the shared tool surface: a header it wrote,
    // stored by the ordinary write path.
    await writeMemoryFile(f, 'quoted.md', `${buildMemoryHeader({ description: nasty })}fact\n`, undefined, 'distill')

    const created = await readMemoryFile(f, 'quoted.md')
    expect(parseMemoryFrontmatter(created).header.description).toBe(nasty)
    // A later ordinary write re-stamps the file; the value must not degrade.
    const restamped = stampMemoryHeader('quoted.md', created, '2026-08-19T00:00:00.000Z')
    expect(parseMemoryFrontmatter(restamped).header.description).toBe(nasty)
    expect(await readMemoryFile(f, 'MEMORY.md')).toContain(nasty)
  })
})

describe('one format text, every trigger', () => {
  it('embeds the SAME shared guidance in all three prompts — the drift that caused this', () => {
    // A turn, per-turn distillation, and a dream all write memory files. Each
    // restating the format in its own words is exactly how they diverged, so the
    // single shared text must appear verbatim in every one of them.
    expect(MEMORY_DISTILLATION_SYSTEM_PROMPT).toContain(MEMORY_FORMAT_GUIDANCE)
    expect(dreamSystemPrompt(false)).toContain(MEMORY_FORMAT_GUIDANCE)
    expect(dreamSystemPrompt(true)).toContain(MEMORY_FORMAT_GUIDANCE)
  })
})
