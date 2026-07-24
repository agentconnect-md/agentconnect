import { describe, it, expect } from 'vitest'
import { DISCORD_APP_COMMANDS } from '../src/discord/app-commands.js'
import { parseCommand } from '../src/commands/commands.js'

/**
 * The native Discord slash commands are reconstructed into `/text` and fed through
 * parseCommand (see DiscordConnection.onSlashCommand). This guards that lockstep: a
 * registered command the parser doesn't understand would silently no-op.
 */
describe('DISCORD_APP_COMMANDS', () => {
  const names = DISCORD_APP_COMMANDS.map((c) => (c as { name: string }).name)

  it('registers unique, Discord-valid command names', () => {
    expect(new Set(names).size).toBe(names.length)
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9_-]{0,31}$/)
  })

  it('every registered command is recognized by parseCommand', () => {
    for (const n of names) {
      // `/queue` needs an arg; a trailing arg is harmless for the others.
      expect(parseCommand(`/${n} x`), `"/${n}" should parse`).not.toBeNull()
    }
  })

  it('bare (arg-less) forms parse too, except the arg-required ones', () => {
    for (const n of names) {
      if (n === 'queue') continue // requires a message argument
      expect(parseCommand(`/${n}`), `"/${n}" should parse`).not.toBeNull()
    }
  })
})
