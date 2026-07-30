import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyTelegramBot } from './telegram-identity.js'

afterEach(() => vi.unstubAllGlobals())

describe('verifyTelegramBot', () => {
  it('returns the bot name and Group Privacy Mode state from getMe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          ok: true,
          result: { username: 'agentconnect_bot', can_read_all_group_messages: true }
        })
      )
    )

    await expect(verifyTelegramBot('123:secret')).resolves.toEqual({
      status: 'ok',
      name: 'agentconnect_bot',
      privacyModeDisabled: true
    })
  })

  it('reports an enabled Privacy Mode when getMe omits its disabled-only flag', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true, result: { first_name: 'AgentConnect' } }))
    )

    await expect(verifyTelegramBot('123:secret')).resolves.toEqual({
      status: 'ok',
      name: 'AgentConnect',
      privacyModeDisabled: false
    })
  })

  it('distinguishes rejected tokens from transient Telegram failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
        .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
    )

    await expect(verifyTelegramBot('123:bad')).resolves.toEqual({ status: 'invalid' })
    await expect(verifyTelegramBot('123:secret')).resolves.toEqual({ status: 'unreachable' })
  })
})
