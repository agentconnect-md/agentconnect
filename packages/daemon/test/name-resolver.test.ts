import { describe, it, expect, vi } from 'vitest'
import { SlackNameResolver } from '../src/slack/name-resolver.js'
import type { SlackConnection } from '../src/slack/connection.js'
import { ChannelNameResolver, type ChannelInfoSource } from '../src/messages/channel-name-resolver.js'

// The resolver only touches getChannelInfo/getUserProfile.
function fakeConn(over: Partial<Pick<SlackConnection, 'getChannelInfo' | 'getUserProfile'>> = {}) {
  return {
    getChannelInfo: vi.fn(async (id: string) => ({ id, name: 'deploys' })),
    getUserProfile: vi.fn(async (id: string) => ({ id, name: 'dana', realName: 'Dana Reyes' })),
    ...over
  } as unknown as SlackConnection & {
    getChannelInfo: ReturnType<typeof vi.fn>
    getUserProfile: ReturnType<typeof vi.fn>
  }
}

const msg = (channel: string, id: string, isBot = false) => ({ channel, sender: { id, isBot } })

const flush = () => new Promise((r) => setImmediate(r))

describe('SlackNameResolver', () => {
  it('resolves channel + human sender once and saves realName over handle', async () => {
    const saved = new Map<string, string>()
    const conn = fakeConn()
    const r = new SlackNameResolver((id, name) => saved.set(id, name))
    r.noteMessage(conn, msg('C1', 'U1'))
    r.noteMessage(conn, msg('C1', 'U1')) // same ids again — must not re-hit the API
    await flush()
    expect(saved.get('C1')).toBe('deploys')
    expect(saved.get('U1')).toBe('Dana Reyes')
    expect(conn.getChannelInfo).toHaveBeenCalledTimes(1)
    expect(conn.getUserProfile).toHaveBeenCalledTimes(1)
  })

  it('skips bot senders and non-user ids, still resolving the channel', async () => {
    const conn = fakeConn()
    const r = new SlackNameResolver(() => {})
    r.noteMessage(conn, msg('C1', 'B99', true)) // bot frame
    r.noteMessage(conn, msg('C1', 'B99', false)) // "B…" is not a user id either
    await flush()
    expect(conn.getUserProfile).not.toHaveBeenCalled()
    expect(conn.getChannelInfo).toHaveBeenCalledTimes(1)
  })

  it('labels a DM channel by its counterpart user, "@"-prefixed, once', async () => {
    const saved = new Map<string, string>()
    const conn = fakeConn({ getChannelInfo: vi.fn(async (id: string) => ({ id, isIm: true, user: 'U7' })) as never })
    const r = new SlackNameResolver((id, name) => saved.set(id, name))
    r.noteMessage(conn, msg('D1', 'U1'))
    await flush()
    r.noteMessage(conn, msg('D1', 'U1'))
    await flush()
    expect(saved.get('D1')).toBe('@Dana Reyes')
    expect(conn.getChannelInfo).toHaveBeenCalledTimes(1)
    expect(conn.getUserProfile).toHaveBeenCalledWith('U7')
  })

  it('caches a nameless channel attempt (DM without counterpart) without saving anything', async () => {
    const saved = new Map<string, string>()
    const conn = fakeConn({ getChannelInfo: vi.fn(async (id: string) => ({ id, isIm: true })) as never })
    const r = new SlackNameResolver((id, name) => saved.set(id, name))
    r.noteMessage(conn, msg('D1', 'U1'))
    await flush()
    r.noteMessage(conn, msg('D1', 'U1'))
    await flush()
    expect(saved.has('D1')).toBe(false)
    expect(conn.getChannelInfo).toHaveBeenCalledTimes(1)
  })

  it('retries a failed lookup after the failure TTL, not before', async () => {
    let now = 0
    const conn = fakeConn({ getChannelInfo: vi.fn(async () => Promise.reject(new Error('ratelimited'))) as never })
    const r = new SlackNameResolver(
      () => {},
      undefined,
      () => now
    )
    r.noteMessage(conn, msg('C1', 'U1', true))
    await flush()
    now = 5 * 60 * 1000 // < 10min failure TTL → still backing off
    r.noteMessage(conn, msg('C1', 'U1', true))
    await flush()
    expect(conn.getChannelInfo).toHaveBeenCalledTimes(1)
    now = 11 * 60 * 1000 // past the TTL → retried
    r.noteMessage(conn, msg('C1', 'U1', true))
    await flush()
    expect(conn.getChannelInfo).toHaveBeenCalledTimes(2)
  })
})

describe('ChannelNameResolver', () => {
  const source = (info: Awaited<ReturnType<ChannelInfoSource['getChannelInfo']>>): ChannelInfoSource => ({
    getChannelInfo: vi.fn(async () => info),
    getUserProfile: vi.fn(async (id: string) => ({ id, name: 'dana', realName: 'Dana Reyes' }))
  })

  it('labels a Discord thread with its enclosing channel, not the thread title', async () => {
    const saved = new Map<string, string>()
    const r = new ChannelNameResolver((id, name) => saved.set(id, name))
    r.noteChannel(source({ id: 'T1', name: '@bot deploy the docs', parentName: 'general' }), 'T1')
    await flush()
    expect(saved.get('T1')).toBe('general')
  })

  it('keeps the channel name when there is no parent', async () => {
    const saved = new Map<string, string>()
    const r = new ChannelNameResolver((id, name) => saved.set(id, name))
    r.noteChannel(source({ id: 'C1', name: 'general' }), 'C1')
    await flush()
    expect(saved.get('C1')).toBe('general')
  })

  it('reports a thread scope (enclosing channel + space) and names the channel itself', async () => {
    const saved = new Map<string, string>()
    const scopes = new Map<string, { parentId?: string; spaceName?: string }>()
    const r = new ChannelNameResolver((id, name) => saved.set(id, name), {
      saveScope: (id, scope) => scopes.set(id, scope)
    })
    r.noteChannel(
      source({ id: 'T1', name: 'deploy the docs', parentId: 'C1', parentName: 'general', spaceName: 'Acme' }),
      'T1'
    )
    await flush()
    expect(scopes.get('T1')).toEqual({ parentId: 'C1', spaceName: 'Acme' })
    // The enclosing channel is a reportable conversation of its own.
    expect(saved.get('C1')).toBe('general')
  })

  it('noteMessage caches the human sender and the users they mentioned', async () => {
    const saved = new Map<string, string>()
    const src = source({ id: 'C1', name: 'general' })
    const r = new ChannelNameResolver((id, name) => saved.set(id, name))
    r.noteMessage(src, { channel: 'C1', sender: { id: 'U9', isBot: false }, mentionedUserIds: ['U7'] })
    await flush()
    expect(saved.get('U9')).toBe('Dana Reyes')
    expect(saved.get('U7')).toBe('Dana Reyes')
  })

  it('noteMessage skips a bot sender (agent frames are labelled by agentId upstream)', async () => {
    const saved = new Map<string, string>()
    const src = source({ id: 'C1', name: 'general' })
    const r = new ChannelNameResolver((id, name) => saved.set(id, name))
    r.noteMessage(src, { channel: 'C1', sender: { id: 'B1', isBot: true } })
    await flush()
    expect(src.getUserProfile).not.toHaveBeenCalled()
    expect(saved.has('B1')).toBe(false)
  })
})
