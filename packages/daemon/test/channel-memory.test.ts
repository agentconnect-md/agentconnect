/**
 * Channel-scoped managed memory (#653): each channel gets a self-contained folder
 * under `<agentRoot>/channels/<key>/`. Reads overlay the shared base + the channel
 * layer (channel shadows base); writes go only to the channel layer, so channels
 * never cross. DM/webchat are special channels keyed by their conversation.
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createManagedMemoryProvider } from '../src/memory/provider.js'
import { createMemoryReader } from '../src/cp/memory-reader.js'
import {
  memoryChannelKey,
  channelMemoryRoot,
  listChannelMemoryKeys,
  readChannelMemoryMeta,
  writeChannelMemoryMeta,
  MemoryPathError
} from '../src/memory/store.js'
import { LocalMemoryFs } from '../src/memory/fs.js'
import { localMemoryHome } from '../src/memory/home.js'

const local = (dir: string) => new LocalMemoryFs(dir)

function provider() {
  const dir = mkdtempSync(join(tmpdir(), 'ac-chan-mem-'))
  return { dir, mem: createManagedMemoryProvider(() => localMemoryHome(local(dir))) }
}

const chan = (channel: string, transportScope?: string) => ({
  agentId: 'bot-a',
  channelKey: memoryChannelKey(channel, transportScope),
  channel,
  ...(transportScope ? { transportScope } : {})
})

describe('memoryChannelKey / channelMemoryRoot', () => {
  it('is deterministic, filesystem-safe, and disambiguates transport scope', () => {
    expect(memoryChannelKey('C1')).toBe(memoryChannelKey('C1'))
    expect(memoryChannelKey('C1', 's1')).not.toBe(memoryChannelKey('C1', 's2'))
    expect(memoryChannelKey('weird/../name:with spaces')).toMatch(/^[A-Za-z0-9._-]+$/)
  })

  // The agent tree is rooted at a POSIX absolute path here, which resolves onto a drive on Windows.
  it.skipIf(process.platform === 'win32')(
    'rejects an unsafe channel key so a crafted key cannot escape the agent tree',
    () => {
      expect(() => channelMemoryRoot(local('/agent'), '..')).toThrow(MemoryPathError)
      expect(() => channelMemoryRoot(local('/agent'), 'a/b')).toThrow(MemoryPathError)
      expect(channelMemoryRoot(local('/agent'), 'ok-key_1').root).toBe('/agent/channels/ok-key_1')
    }
  )
})

describe('channel-scoped memory overlay', () => {
  it('isolates writes per channel and never crosses', async () => {
    const { mem } = provider()
    const a = chan('C1')
    const b = chan('C2')
    await mem.ensure(a, 'bot')
    await mem.ensure(b, 'bot')

    await mem.write(a, 'notes.md', '- channel A note', undefined, 'tool')
    expect((await mem.read(a, 'notes.md')).content).toBe('- channel A note')
    // Channel B never sees channel A's content.
    expect((await mem.read(b, 'notes.md')).content).toBe('')
    expect((await mem.list(b)).some((f) => f.name === 'notes.md')).toBe(false)
  })

  it('overlays the shared base under a channel: base is readable, channel shadows it', async () => {
    const { mem } = provider()
    const base = { agentId: 'bot-a' }
    const a = chan('C1')
    await mem.ensure(base, 'bot')
    await mem.write(base, 'shared.md', '- shared base fact', undefined, 'tool')
    await mem.write(base, 'topic.md', '- base version', undefined, 'tool')

    await mem.ensure(a, 'bot')
    await mem.write(a, 'topic.md', '- channel version', undefined, 'tool')

    // Base-only file is visible from the channel (fallback); shadowed file returns
    // the channel version; a channel-only write is invisible to the base.
    expect((await mem.read(a, 'shared.md')).content).toBe('- shared base fact')
    expect((await mem.read(a, 'topic.md')).content).toBe('- channel version')
    expect((await mem.read(base, 'topic.md')).content).toBe('- base version')

    const listed = (await mem.list(a)).map((f) => f.name)
    expect(listed).toEqual(expect.arrayContaining(['shared.md', 'topic.md']))
    // Union does not duplicate the shadowed file.
    expect(listed.filter((n) => n === 'topic.md')).toHaveLength(1)
  })

  it('an empty channel file still shadows a non-empty base file (existence, not emptiness)', async () => {
    const { mem } = provider()
    const base = { agentId: 'bot-a' }
    const a = chan('C1')
    await mem.ensure(base, 'bot')
    await mem.write(base, 'topic.md', '- base version', undefined, 'tool')
    await mem.ensure(a, 'bot')
    // Intentionally clear the topic in this channel by writing empty content.
    await mem.write(a, 'topic.md', '', undefined, 'tool')

    // The channel's empty file must win over the base's stale content.
    expect((await mem.read(a, 'topic.md')).content).toBe('')
    // The base is untouched.
    expect((await mem.read(base, 'topic.md')).content).toBe('- base version')
  })

  it('injects the base index then the channel index', async () => {
    const { mem } = provider()
    const base = { agentId: 'bot-a' }
    const a = chan('C1')
    await mem.ensure(base, 'bot')
    await mem.write(base, 'MEMORY.md', '# base index', undefined, 'tool')
    await mem.ensure(a, 'bot')
    await mem.write(a, 'MEMORY.md', '# channel index', undefined, 'tool')

    const injected = await mem.standingContextAtSessionStart(a)
    expect(injected.indexOf('# base index')).toBeGreaterThanOrEqual(0)
    expect(injected.indexOf('# channel index')).toBeGreaterThan(injected.indexOf('# base index'))
  })

  it('the CP memory reader lists channel folders and routes reads to the selected channel', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-chan-reader-'))
    const mem = createManagedMemoryProvider(() => localMemoryHome(local(dir)))
    const reader = createMemoryReader(() => localMemoryHome(local(dir)), {
      adminSurfaceForAgent: () => mem.adminSurface()
    })
    const a = chan('C1')
    await mem.ensure(a, 'bot')
    await mem.write(a, 'notes.md', '- channel A note', undefined, 'tool')

    // channels() surfaces the folder with its source identity.
    expect((await reader.channels({ agentId: 'bot-a' })).channels).toContainEqual({
      channelKey: a.channelKey,
      channel: 'C1'
    })
    // list/read scoped to the channelKey see the channel layer; the base does not.
    expect(
      (await reader.list({ agentId: 'bot-a', channelKey: a.channelKey })).entries.some((e) => e.name === 'notes.md')
    ).toBe(true)
    expect((await reader.list({ agentId: 'bot-a' })).entries.some((e) => e.name === 'notes.md')).toBe(false)
    expect(
      (await reader.read({ agentId: 'bot-a', channelKey: a.channelKey, path: 'notes.md', offset: 0, limit: 65536 }))
        .content
    ).toBe('- channel A note')
  })

  it('records channel source metadata so the console can name folders', async () => {
    const { dir, mem } = provider()
    const a = chan('C1', 'scope-1')
    await mem.ensure(a, 'bot')
    await mem.write(a, 'x.md', '- x', undefined, 'tool')

    const keys = await listChannelMemoryKeys(local(dir))
    expect(keys).toContain(a.channelKey)
    await vi.waitFor(async () =>
      expect(await readChannelMemoryMeta(local(dir), a.channelKey)).toEqual({
        channel: 'C1',
        transportScope: 'scope-1'
      })
    )
  })

  it('records the platform and display name with a place layer, and keeps the name current', async () => {
    const { dir, mem } = provider()
    const a = { ...chan('C0EXAMPLE1'), platform: 'slack', channelName: 'launch-room' }
    await mem.ensure(a, 'bot')
    await vi.waitFor(async () =>
      expect(await readChannelMemoryMeta(local(dir), a.channelKey)).toEqual({
        channel: 'C0EXAMPLE1',
        platform: 'slack',
        name: 'launch-room'
      })
    )
    // A later write that sees the conversation renamed records the new name.
    await writeChannelMemoryMeta(local(dir), a.channelKey, { channel: 'C0EXAMPLE1', name: 'launch-war-room' })
    expect(await readChannelMemoryMeta(local(dir), a.channelKey)).toEqual({
      channel: 'C0EXAMPLE1',
      platform: 'slack',
      name: 'launch-war-room'
    })
    // One that knows no name keeps the one recorded, and an unchanged identity is not rewritten.
    const before = await local(dir).readFile(`channels/${a.channelKey}/channel.json`)
    await writeChannelMemoryMeta(local(dir), a.channelKey, { channel: 'C0EXAMPLE1', platform: 'slack' })
    expect(await local(dir).readFile(`channels/${a.channelKey}/channel.json`)).toEqual(before)
  })

  it('lists a place layer only once it holds memory, never for the marker a read leaves behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-chan-marker-'))
    const mem = createManagedMemoryProvider(() => localMemoryHome(local(dir)))
    const reader = createMemoryReader(() => localMemoryHome(local(dir)), {
      adminSurfaceForAgent: () => mem.adminSurface()
    })
    // A public channel's session reads its own older folder beneath the shared layer; that read marks the folder.
    const shared = { ...chan('C0EXAMPLE2', 'scope-1'), sharedPlace: true as const }
    await mem.ensure(shared, 'bot')
    const view = await mem.entryView?.(shared)
    await view?.context?.({ maxBytes: 1024 })
    expect(await local(dir).readdir(`channels/${shared.channelKey}/memory`)).not.toEqual([])
    expect((await reader.channels({ agentId: 'bot-a' })).channels).toEqual([])

    const place = chan('C0EXAMPLE3')
    await mem.write(place, 'room.md', '- a place fact', undefined, 'tool')
    expect((await reader.channels({ agentId: 'bot-a' })).channels.map((c) => c.channelKey)).toEqual([place.channelKey])
    // Asked for one layer, the reader answers for that one alone.
    expect((await reader.channels({ agentId: 'bot-a', channelKey: shared.channelKey })).channels).toEqual([])
  })

  it('clears a place layer whole, its change log and identity included, and returns no content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-chan-clear-'))
    const mem = createManagedMemoryProvider(() => localMemoryHome(local(dir)))
    const reader = createMemoryReader(() => localMemoryHome(local(dir)), {
      adminSurfaceForAgent: () => mem.adminSurface()
    })
    const a = { ...chan('C0EXAMPLE4'), platform: 'slack', channelName: 'private-room' }
    const b = chan('C0EXAMPLE5')
    await mem.ensure(a, 'bot')
    await mem.write(a, 'secret.md', '- something only that room said', undefined, 'tool')
    await mem.write(b, 'other.md', '- another room', undefined, 'tool')
    await mem.write({ agentId: 'bot-a' }, 'shared.md', '- everyone', undefined, 'tool')

    const answer = await reader.clearChannel({ agentId: 'bot-a', channelKey: a.channelKey })
    expect(answer).toEqual({ agentId: 'bot-a', channelKey: a.channelKey, cleared: true })
    expect(await local(dir).readdir(`channels/${a.channelKey}`)).toEqual([])
    expect((await reader.channels({ agentId: 'bot-a' })).channels.map((c) => c.channelKey)).toEqual([b.channelKey])
    // Every other layer is untouched.
    expect((await mem.read({ agentId: 'bot-a' }, 'shared.md')).content).toBe('- everyone')
    expect((await mem.read(b, 'other.md')).content).toBe('- another room')
    // Nothing left to clear is an answer, not an error.
    expect(await reader.clearChannel({ agentId: 'bot-a', channelKey: a.channelKey })).toMatchObject({ cleared: false })
    await expect(reader.clearChannel({ agentId: 'bot-a', channelKey: '..' })).rejects.toThrow(MemoryPathError)
  })
})
