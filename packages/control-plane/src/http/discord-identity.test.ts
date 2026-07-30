import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureDiscordMessageContentIntent } from './discord-identity.js'

const DISCORD_APPLICATION = 'https://discord.com/api/v10/applications/@me'
const PRESENCE_LIMITED = 1 << 13
const MESSAGE_CONTENT = 1 << 18
const MESSAGE_CONTENT_LIMITED = 1 << 19
const APPLICATION_COMMAND_BADGE = 1 << 23

afterEach(() => vi.unstubAllGlobals())

describe('ensureDiscordMessageContentIntent', () => {
  it.each([MESSAGE_CONTENT, MESSAGE_CONTENT_LIMITED])(
    'leaves an application with message-content flag %i unchanged',
    async (flags) => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ flags }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      await expect(ensureDiscordMessageContentIntent('discord-secret')).resolves.toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it('enables the limited flag while preserving the other editable intent flags', async () => {
    const currentFlags = PRESENCE_LIMITED | APPLICATION_COMMAND_BADGE
    const expectedFlags = PRESENCE_LIMITED | MESSAGE_CONTENT_LIMITED
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ flags: currentFlags }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ flags: currentFlags | MESSAGE_CONTENT_LIMITED }), { status: 200 })
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(ensureDiscordMessageContentIntent('discord-secret')).resolves.toBe(true)
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      DISCORD_APPLICATION,
      expect.objectContaining({ headers: { authorization: 'Bot discord-secret' } })
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      DISCORD_APPLICATION,
      expect.objectContaining({
        method: 'PATCH',
        headers: { authorization: 'Bot discord-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ flags: expectedFlags })
      })
    )
  })

  it('reports failure when Discord rejects the flag update', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ flags: 0 }), { status: 200 }))
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(ensureDiscordMessageContentIntent('discord-secret')).resolves.toBe(false)
  })
})
