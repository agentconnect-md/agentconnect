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
  memoryLinkTargets,
  memoryRefToTopic,
  parseMemoryFrontmatter,
  stampMemoryHeader
} from '../src/memory/frontmatter.js'
import { ensureMemory, MAX_MEMORY_FILE_BYTES, readMemoryFile, writeMemoryFile } from '../src/memory/store.js'

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
