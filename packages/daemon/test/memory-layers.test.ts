// Memory layered by audience (unified-memory-interface.md §6): the shared layer plus at most one more, written alone.
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SourcePlace } from '../src/assistant/place-access.js'
import { LocalMemoryFs } from '../src/memory/fs.js'
import { localMemoryHome } from '../src/memory/home.js'
import { MemoryLayers, layerOfPlace, type MemoryLayerDeps, type MemoryPlace } from '../src/memory/layers.js'
import { createManagedMemoryProvider } from '../src/memory/provider.js'
import { createMemoryReader } from '../src/cp/memory-reader.js'
import { listChannelMemoryKeys, memoryChannelKey, memoryPersonKey } from '../src/memory/store.js'

const AGENT = 'agent-a'
const TENANT = 'T-EXAMPLE'

function tree() {
  const dir = mkdtempSync(join(tmpdir(), 'ac-mem-layers-'))
  const fs = new LocalMemoryFs(dir)
  return { fs, mem: createManagedMemoryProvider(() => localMemoryHome(fs)) }
}

interface Places {
  /** What the platform reports per channel. */
  described?: Record<string, Partial<SourcePlace>>
  external?: string[]
  /** Chat members who linked a console account, by platform id. */
  linked?: Record<string, string>
  fs?: LocalMemoryFs
}

function layers(p: Places = {}) {
  const linkedConsoleUser = vi.fn(async (_agent: string, _int: string, member: string) => p.linked?.[member])
  const deps: MemoryLayerDeps = {
    chatPlatform: (platform) => ['slack', 'telegram', 'discord', 'feishu', 'webchat'].includes(platform),
    integrationFor: (_agent, platform) => `int-${platform}`,
    describe: async (place, kind) => ({ ...place, ...(kind ? { kind } : {}), ...p.described?.[place.channel] }),
    external: (_agent, _int, channel) => p.external?.includes(channel) === true,
    tenantScope: async () => TENANT,
    earlierSenders: async () => [],
    linkedConsoleUser,
    memoryTree: () => p.fs,
    now: () => 0
  }
  return { layers: new MemoryLayers(deps), linkedConsoleUser }
}

const place = (over: Partial<MemoryPlace>): MemoryPlace => ({
  agentId: AGENT,
  platform: 'slack',
  channel: 'C1',
  transportScope: null,
  kinds: [],
  people: [],
  ...over
})

const PUBLIC = { kind: 'channel' as const, private: false }

describe('which layer a place uses', () => {
  it('shares a public channel only where the platform confirms its audience is the organization', () => {
    expect(layerOfPlace({ platform: 'slack', channel: 'C1', ...PUBLIC }, false)).toBe('shared')
    // A conversation shared with another organization, or holding a detected guest, keeps its own.
    expect(layerOfPlace({ platform: 'slack', channel: 'C1', ...PUBLIC }, true)).toBe('place')
    // Telegram, Discord and Feishu cannot confirm who is in a public group, so each keeps its own.
    for (const platform of ['telegram', 'discord', 'feishu'])
      expect(layerOfPlace({ platform, channel: 'G1', ...PUBLIC }, false)).toBe('place')
    expect(layerOfPlace({ platform: 'slack', channel: 'C1', kind: 'channel', private: true }, false)).toBe('place')
    expect(layerOfPlace({ platform: 'slack', channel: 'C1', kind: 'channel' }, false)).toBe('place')
    expect(layerOfPlace({ platform: 'slack', channel: 'G1', kind: 'group_dm', private: true }, false)).toBe('place')
    expect(layerOfPlace({ platform: 'slack', channel: 'D1', kind: 'dm' }, false)).toBe('person')
  })

  it('routes every kind of conversation to its layer and scope', async () => {
    const { layers: l } = layers({
      described: { C1: PUBLIC, C2: { kind: 'channel', private: true } },
      external: ['C3']
    })
    const shared = await l.resolve(place({ channel: 'C1' }))
    expect(shared.layer).toBe('shared')
    // A shared channel still reads its own older folder, beneath the shared layer, and writes the shared layer.
    expect(shared.scope).toEqual({
      agentId: AGENT,
      channelKey: memoryChannelKey('C1'),
      channel: 'C1',
      sharedPlace: true
    })
    const priv = await l.resolve(place({ channel: 'C2' }))
    expect(priv).toEqual({
      layer: 'place',
      scope: { agentId: AGENT, channelKey: memoryChannelKey('C2'), channel: 'C2' }
    })
    expect((await l.resolve(place({ channel: 'C3', kinds: ['channel'] }))).layer).toBe('place')
    expect((await l.resolve(place({ channel: 'G1', kinds: ['group_dm'] }))).layer).toBe('place')
    // A code-host review is no conversation, so what it learns is the organization's.
    expect(await l.resolve(place({ platform: 'github', channel: 'example-org/example-repo' }))).toEqual({
      layer: 'shared',
      scope: { agentId: AGENT }
    })
  })

  it('gives two Telegram groups a place layer each, so they never read each other', async () => {
    const { layers: l } = layers({ described: { '-1001': PUBLIC, '-1002': PUBLIC } })
    const a = await l.resolve(place({ platform: 'telegram', channel: '-1001' }))
    const b = await l.resolve(place({ platform: 'telegram', channel: '-1002' }))
    expect([a.layer, b.layer]).toEqual(['place', 'place'])
    expect(a.scope.channelKey).not.toBe(b.scope.channelKey)
  })

  it('keeps an undescribable place to itself', async () => {
    const { layers: l } = layers()
    const failing = new MemoryLayers({
      ...(l as unknown as { deps: MemoryLayerDeps }).deps,
      describe: async () => {
        throw new Error('platform unreachable')
      }
    })
    expect((await failing.resolve(place({ channel: 'C9' }))).layer).toBe('place')
  })
})

describe('the person layer', () => {
  it('keys an unlinked DM by the platform identity and a console conversation by the console user', async () => {
    const { layers: l } = layers()
    expect(await l.resolve(place({ channel: 'D1', kinds: ['dm'], people: ['U1'] }))).toEqual({
      layer: 'person',
      scope: { agentId: AGENT, personKey: memoryPersonKey(`slack:${TENANT}:U1`) }
    })
    expect(await l.resolve(place({ platform: 'webchat', channel: 'conv-1', people: ['user-1'] }))).toEqual({
      layer: 'person',
      scope: { agentId: AGENT, personKey: memoryPersonKey('user:user-1') }
    })
  })

  it("gives a linked person's Slack DM and webchat one folder, asking the Control Plane once", async () => {
    const { layers: l, linkedConsoleUser } = layers({ linked: { U1: 'user-1' } })
    const dm = await l.resolve(place({ channel: 'D1', kinds: ['dm'], people: ['U1'] }))
    const web = await l.resolve(place({ platform: 'webchat', channel: 'conv-1', people: ['user-1'] }))
    expect(dm.scope.personKey).toBe(memoryPersonKey('user:user-1'))
    expect(web.scope.personKey).toBe(dm.scope.personKey)
    await l.resolve(place({ channel: 'D1', kinds: ['dm'], people: ['U1'] }))
    expect(linkedConsoleUser).toHaveBeenCalledTimes(1)
  })

  it('keeps the last answer when the Control Plane cannot be asked, and counts a never-answered member unlinked', async () => {
    let up = true
    const { layers: base } = layers({ linked: { U1: 'user-1' } })
    const deps = (base as unknown as { deps: MemoryLayerDeps }).deps
    let clock = 0
    const l = new MemoryLayers({
      ...deps,
      now: () => clock,
      linkedConsoleUser: async (a, i, m) => {
        if (!up) throw new Error('control plane unreachable')
        return deps.linkedConsoleUser(a, i, m)
      }
    })
    const dm = place({ channel: 'D1', kinds: ['dm'], people: ['U1'] })
    expect((await l.resolve(dm)).scope.personKey).toBe(memoryPersonKey('user:user-1'))
    up = false
    clock = 60 * 60_000
    expect((await l.resolve(dm)).scope.personKey).toBe(memoryPersonKey('user:user-1'))
    expect((await l.resolve(place({ channel: 'D2', kinds: ['dm'], people: ['U2'] }))).scope.personKey).toBe(
      memoryPersonKey(`slack:${TENANT}:U2`)
    )
  })

  it('moves the platform-keyed folder onto the console-keyed one once, on linking', async () => {
    const { fs, mem } = tree()
    const platformScope = { agentId: AGENT, personKey: memoryPersonKey(`slack:${TENANT}:U1`) }
    await mem.write(platformScope, 'prefs.md', '- likes tabs')
    const linked: Record<string, string> = {}
    const { layers: l } = layers({ fs, linked })
    const dm = place({ channel: 'D1', kinds: ['dm'], people: ['U1'] })
    expect((await l.resolve(dm)).scope).toEqual(platformScope)
    linked.U1 = 'user-1'
    const now = new MemoryLayers({ ...(l as unknown as { deps: MemoryLayerDeps }).deps, now: () => 60 * 60_000 })
    const consoleScope = (await now.resolve(dm)).scope
    expect(consoleScope.personKey).toBe(memoryPersonKey('user:user-1'))
    expect((await mem.read(consoleScope, 'prefs.md')).content).toBe('- likes tabs')
    expect(await fs.readdir(`people/${platformScope.personKey}`)).toEqual([])
    // Only once: a platform-keyed folder written again later is never merged in.
    await mem.write(platformScope, 'later.md', '- stray')
    await now.resolve(dm)
    expect((await mem.read(consoleScope, 'later.md')).content).toBe('')
  })

  it('keeps the console-keyed folder when both exist, and leaves the other unread', async () => {
    const { fs, mem } = tree()
    const platformScope = { agentId: AGENT, personKey: memoryPersonKey(`slack:${TENANT}:U1`) }
    const consoleScope = { agentId: AGENT, personKey: memoryPersonKey('user:user-1') }
    await mem.write(platformScope, 'old.md', '- from the DM')
    await mem.write(consoleScope, 'web.md', '- from webchat')
    const { layers: l } = layers({ fs, linked: { U1: 'user-1' } })
    const scope = (await l.resolve(place({ channel: 'D1', kinds: ['dm'], people: ['U1'] }))).scope
    expect(scope).toEqual(consoleScope)
    expect((await mem.read(scope, 'web.md')).content).toBe('- from webchat')
    expect((await mem.read(scope, 'old.md')).content).toBe('')
    expect((await mem.read(platformScope, 'old.md')).content).toBe('- from the DM')
  })

  it("adopts a DM's own older folder once, when the person has none yet", async () => {
    const { fs, mem } = tree()
    const legacy = { agentId: AGENT, channelKey: memoryChannelKey('D1'), channel: 'D1' }
    await mem.write(legacy, 'notes.md', '- kept per DM before')
    const { layers: l } = layers({ fs })
    const scope = (await l.resolve(place({ channel: 'D1', kinds: ['dm'], people: ['U1'] }))).scope
    expect((await mem.read(scope, 'notes.md')).content).toBe('- kept per DM before')
    expect(await listChannelMemoryKeys(fs)).toEqual([])
  })

  it("reaches the asker's own layer for a tool's layer: 'person', from anywhere", async () => {
    const { layers: l } = layers({ linked: { U1: 'user-1' } })
    expect(
      await l.personScope(AGENT, { kind: 'member', platform: 'slack', integrationId: 'int-slack', userId: 'U1' })
    ).toEqual({ agentId: AGENT, personKey: memoryPersonKey('user:user-1') })
    expect(await l.personScope(AGENT, { kind: 'console', userId: 'user-2' })).toEqual({
      agentId: AGENT,
      personKey: memoryPersonKey('user:user-2')
    })
  })
})

describe('what a session reads and is injected with', () => {
  it('injects the shared index first, then the layer index, and reads a person layer only in its own scope', async () => {
    const { mem } = tree()
    await mem.ensure({ agentId: AGENT }, 'Butler')
    await mem.write({ agentId: AGENT }, 'MEMORY.md', '# shared\n- [deploys](deploys.md)')
    const person = { agentId: AGENT, personKey: memoryPersonKey('user:user-1') }
    await mem.write(person, 'MEMORY.md', '# yours\n- [prefs](prefs.md)')
    await mem.write(person, 'prefs.md', '- likes tabs')
    expect(await mem.standingContextAtSessionStart(person)).toBe(
      '# shared\n- [deploys](deploys.md)\n\nOnly for this person:\n# yours\n- [prefs](prefs.md)'
    )
    // A channel never carries the person layer, so neither its index nor its files reach it.
    const channel = { agentId: AGENT, channelKey: memoryChannelKey('C1'), channel: 'C1', sharedPlace: true as const }
    expect(await mem.standingContextAtSessionStart(channel)).toBe('# shared\n- [deploys](deploys.md)')
    expect((await mem.read(channel, 'prefs.md')).content).toBe('')
    // Each layer keeps its own index: the person's MEMORY.md never falls through to the shared one.
    const fresh = { agentId: AGENT, personKey: memoryPersonKey('user:user-2') }
    expect((await mem.read(fresh, 'MEMORY.md')).content).toBe('')
    expect((await mem.list(fresh)).map((f) => f.name)).toEqual([])
  })

  it("keeps a shared channel's older folder readable while its writes go to the shared layer", async () => {
    const { fs, mem } = tree()
    const legacy = { agentId: AGENT, channelKey: memoryChannelKey('C1'), channel: 'C1' }
    await mem.write(legacy, 'runbook.md', '- restart the worker')
    const shared = { ...legacy, sharedPlace: true as const }
    expect((await mem.read(shared, 'runbook.md')).content).toBe('- restart the worker')
    await mem.write(shared, 'deploys.md', '- ship on Fridays')
    expect((await fs.readFile('memory/deploys.md'))?.content).toBe('- ship on Fridays')
    expect(await fs.readFile(`channels/${legacy.channelKey}/memory/deploys.md`)).toBeNull()
    // Seeding touches the shared store only, so a person or place layer starts with its first write.
    await mem.ensure({ agentId: AGENT, personKey: memoryPersonKey('user:user-3') }, 'Butler')
    expect(await fs.readdir('people')).toEqual([])
  })

  it('lists place layers that hold memory to the console, and never a person layer', async () => {
    const { fs, mem } = tree()
    const reader = createMemoryReader(() => localMemoryHome(fs), { adminSurfaceForAgent: () => mem.adminSurface() })
    const held = { agentId: AGENT, channelKey: memoryChannelKey('C2'), channel: 'C2' }
    const empty = { agentId: AGENT, channelKey: memoryChannelKey('C3'), channel: 'C3' }
    await mem.ensure(held, 'Butler')
    await mem.ensure(empty, 'Butler')
    await mem.write(held, 'room.md', '- a place fact')
    await mem.write({ agentId: AGENT, personKey: memoryPersonKey('user:user-1') }, 'prefs.md', '- likes tabs')
    expect((await reader.channels({ agentId: AGENT })).channels.map((c) => c.channelKey)).toEqual([held.channelKey])
  })
})
