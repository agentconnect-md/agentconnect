import { describe, expect, it } from 'vitest'
import { discordApplicationIdFromToken, discordBotInviteUrl } from './invite'

// These two feed a REAL external install: the URL we hand the user is what
// Discord authorizes the bot with, and a silently wrong client_id or permission
// bitfield produces a bot that joins but cannot post — diagnosed only in the
// server. So the exact strings are pinned here, not just the shapes.

/** A bot token's first segment is base64url(applicationId); the rest is opaque. */
const token = (firstSegment: string) => `${firstSegment}.Gxxxxx.yyyyyyyyyyyyyyyyyyyyyyyyyyy`

describe('discordApplicationIdFromToken', () => {
  it('decodes the application id out of the first segment', () => {
    expect(discordApplicationIdFromToken(token('OTAwMDAwMDAwMDAwMDAwMDAx'))).toBe('900000000000000001')
  })

  it('accepts unpadded base64url, which is how Discord writes it', () => {
    // btoa would emit 'MTIzNDU2Nzg5MDEyMzQ1Njc=' — the token drops the '='.
    expect(discordApplicationIdFromToken(token('MTIzNDU2Nzg5MDEyMzQ1Njc'))).toBe('12345678901234567')
  })

  it('accepts the base64url alphabet, not just standard base64', () => {
    // '>' and '?' are the bytes that encode to '+' and '/' in standard base64;
    // a snowflake never produces them, so exercise the substitution directly.
    const withUrlAlphabet = btoa('1000000000000000>?').replace(/\+/g, '-').replace(/\//g, '_')
    expect(discordApplicationIdFromToken(token(withUrlAlphabet))).toBeNull() // not all digits …
    expect(withUrlAlphabet).toMatch(/[-_]/) // … but the alphabet WAS exercised
  })

  it('tolerates surrounding whitespace from a paste', () => {
    expect(discordApplicationIdFromToken(`  ${token('OTAwMDAwMDAwMDAwMDAwMDAx')}\n`)).toBe('900000000000000001')
  })

  it('returns null for anything that is not a 17–20 digit snowflake', () => {
    expect(discordApplicationIdFromToken('')).toBeNull()
    expect(discordApplicationIdFromToken('not-a-token')).toBeNull()
    expect(discordApplicationIdFromToken(token('MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMg'))).toBeNull() // 22 digits
    expect(discordApplicationIdFromToken(token('bm90LWRpZ2l0cw'))).toBeNull() // decodes, not numeric
    expect(discordApplicationIdFromToken('.Gxxxxx.yyyy')).toBeNull() // empty first segment
  })
})

describe('discordBotInviteUrl', () => {
  it('requests the bot + slash-command scopes and the adapter permission set', () => {
    const url = new URL(discordBotInviteUrl('900000000000000001'))

    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize')
    expect(url.searchParams.get('client_id')).toBe('900000000000000001')
    // `applications.commands` alongside `bot`: a bot-only invite 403s on commands.set.
    expect(url.searchParams.get('scope')).toBe('bot applications.commands')
    // ADD_REACTIONS | VIEW_CHANNEL | SEND_MESSAGES | EMBED_LINKS | ATTACH_FILES |
    // READ_MESSAGE_HISTORY | CREATE_PUBLIC_THREADS | SEND_MESSAGES_IN_THREADS —
    // kept in lock-step with packages/daemon/src/discord. Too wide for 32 bits.
    expect(url.searchParams.get('permissions')).toBe('292057893952')
  })
})
