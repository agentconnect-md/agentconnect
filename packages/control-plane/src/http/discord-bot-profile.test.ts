import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IconStore } from '../icons/icon-store.js'
import { createDiscordBotIconSyncer } from './discord-bot-profile.js'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

function successfulDiscordFetch(): void {
  globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
}

describe('createDiscordBotIconSyncer', () => {
  it('renders a glyph once and applies it to the bot user and application', async () => {
    successfulDiscordFetch()
    const sync = createDiscordBotIconSyncer()

    await sync('discord-secret', {
      id: '00000000-0000-4000-8000-000000000001',
      icon: { kind: 'glyph', glyph: 'terminal', color: '#2a6fdb' },
      runtime: 'claude'
    })

    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
    const calls = vi.mocked(globalThis.fetch).mock.calls
    expect(calls.map(([url]) => url)).toEqual([
      'https://discord.com/api/v10/users/@me',
      'https://discord.com/api/v10/applications/@me'
    ])
    const requests = calls.map(([, init]) => init!)
    expect(requests.every((init) => init.method === 'PATCH')).toBe(true)
    expect(requests.every((init) => new Headers(init.headers).get('authorization') === 'Bot discord-secret')).toBe(true)
    const botBody = JSON.parse(requests[0]!.body as string) as { avatar: string }
    const appBody = JSON.parse(requests[1]!.body as string) as { icon: string }
    expect(botBody.avatar).toMatch(/^data:image\/png;base64,/)
    expect(appBody.icon).toBe(botBody.avatar)
  })

  it('uses the stored uploaded image bytes without replacing them with a fallback glyph', async () => {
    successfulDiscordFetch()
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])
    const store: IconStore = {
      put: vi.fn(async () => undefined),
      get: vi.fn(async () => ({ bytes, contentType: 'image/jpeg' })),
      delete: vi.fn(async () => undefined),
      publicUrl: vi.fn(() => 'https://images.example.test/icon')
    }
    const sync = createDiscordBotIconSyncer(store)

    await sync('discord-secret', {
      id: '00000000-0000-4000-8000-000000000002',
      icon: { kind: 'image' },
      runtime: 'codex'
    })

    expect(store.get).toHaveBeenCalledWith('icon/agents/00000000-0000-4000-8000-000000000002')
    const body = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0]![1]!.body as string) as { avatar: string }
    expect(body.avatar).toBe(`data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`)
  })
})
