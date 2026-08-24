import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentId } from '../domain/ids.js'
import type { IconStore } from '../icons/icon-store.js'
import { createDiscordBotProfileSyncer } from './discord-bot-profile.js'
import { PLATFORM_APP_DESCRIPTION } from './platform-app-description.js'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

function successfulDiscordFetch(): void {
  globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
}

function dataUriBytes(data: string): Buffer {
  expect(data).toMatch(/^data:image\/png;base64,/)
  return Buffer.from(data.slice(data.indexOf(',') + 1), 'base64')
}

describe('createDiscordBotProfileSyncer', () => {
  it('renders the brand glyph and applies the generic public description', async () => {
    successfulDiscordFetch()
    const sync = createDiscordBotProfileSyncer()

    await sync('discord-secret', {
      id: AgentId('00000000-0000-4000-8000-000000000001'),
      icon: { kind: 'glyph', glyph: 'agentconnect', color: '#1a212b' },
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
    const appBody = JSON.parse(requests[1]!.body as string) as { icon: string; description: string }
    expect(appBody.icon).toBe(botBody.avatar)
    expect(appBody.description).toBe(PLATFORM_APP_DESCRIPTION)
    const png = dataUriBytes(botBody.avatar)
    const metadata = await sharp(png).metadata()
    expect(metadata).toMatchObject({ format: 'png', width: 512, height: 512, hasAlpha: false })
    const corner = await sharp(png).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer()
    expect([...corner.subarray(0, 3)]).toEqual([255, 255, 255])
  })

  it('normalizes the stored uploaded image without replacing it with a fallback glyph', async () => {
    successfulDiscordFetch()
    const bytes = await sharp({
      create: { width: 32, height: 32, channels: 4, background: { r: 12, g: 34, b: 56, alpha: 1 } }
    })
      .webp({ lossless: true })
      .toBuffer()
    const store: IconStore = {
      put: vi.fn(async () => undefined),
      get: vi.fn(async () => ({ bytes, contentType: 'image/webp' })),
      delete: vi.fn(async () => undefined),
      publicUrl: vi.fn(() => 'https://images.example.test/icon')
    }
    const sync = createDiscordBotProfileSyncer(store)

    await sync('discord-secret', {
      id: AgentId('00000000-0000-4000-8000-000000000002'),
      icon: { kind: 'image' },
      runtime: 'codex'
    })

    expect(store.get).toHaveBeenCalledWith('icon/agents/00000000-0000-4000-8000-000000000002')
    expect(store.put).not.toHaveBeenCalled()
    const body = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0]![1]!.body as string) as { avatar: string }
    const center = await sharp(dataUriBytes(body.avatar))
      .extract({ left: 256, top: 256, width: 1, height: 1 })
      .raw()
      .toBuffer()
    expect([...center.subarray(0, 3)]).toEqual([12, 34, 56])
  })
})
