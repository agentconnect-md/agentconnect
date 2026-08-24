import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IconStore } from '../icons/icon-store.js'
import { renderAgentIconPng } from '../agents/agent-icon-render.js'
import { createTelegramBotIconSyncer } from './telegram-bot-profile.js'
import { AgentId } from '../domain/ids.js'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

function successfulTelegramFetch(): void {
  globalThis.fetch = vi.fn(async () => Response.json({ ok: true })) as unknown as typeof fetch
}

async function uploadedPhoto(): Promise<Blob> {
  const [, init] = vi.mocked(globalThis.fetch).mock.calls[0]!
  const form = init!.body as FormData
  expect(form.get('photo')).toBe(JSON.stringify({ type: 'static', photo: 'attach://profile_photo' }))
  const photo = form.get('profile_photo')
  expect(photo).toBeInstanceOf(Blob)
  return photo as Blob
}

describe('createTelegramBotIconSyncer', () => {
  it('renders a glyph and uploads a square JPEG through setMyProfilePhoto', async () => {
    successfulTelegramFetch()
    const sync = createTelegramBotIconSyncer()

    await sync('telegram-secret', {
      id: AgentId('00000000-0000-4000-8000-000000000001'),
      icon: { kind: 'glyph', glyph: 'terminal', color: '#2a6fdb' },
      runtime: 'claude'
    })

    expect(globalThis.fetch).toHaveBeenCalledOnce()
    expect(vi.mocked(globalThis.fetch).mock.calls[0]![0]).toBe(
      'https://api.telegram.org/bottelegram-secret/setMyProfilePhoto'
    )
    const photo = await uploadedPhoto()
    expect(photo.type).toBe('image/jpeg')
    const metadata = await sharp(await photo.arrayBuffer()).metadata()
    expect(metadata).toMatchObject({ format: 'jpeg', width: 512, height: 512 })
  })

  it('transcodes a stored WebP icon instead of replacing it with a fallback glyph', async () => {
    successfulTelegramFetch()
    const png = await renderAgentIconPng({ kind: 'glyph', glyph: 'bot', color: '#123456' }, 'codex')
    const webp = await sharp(png).webp().toBuffer()
    const store: IconStore = {
      put: vi.fn(async () => undefined),
      get: vi.fn(async () => ({ bytes: webp, contentType: 'image/webp' })),
      delete: vi.fn(async () => undefined),
      publicUrl: vi.fn(() => 'https://images.example.test/icon')
    }
    const sync = createTelegramBotIconSyncer(store)

    await sync('telegram-secret', {
      id: AgentId('00000000-0000-4000-8000-000000000002'),
      icon: { kind: 'image' },
      runtime: 'codex'
    })

    expect(store.get).toHaveBeenCalledWith('icon/agents/00000000-0000-4000-8000-000000000002')
    expect(store.put).not.toHaveBeenCalled()
    const bytes = new Uint8Array(await (await uploadedPhoto()).arrayBuffer())
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xd8])
    expect([...bytes.subarray(-2)]).toEqual([0xff, 0xd9])
  })
})
