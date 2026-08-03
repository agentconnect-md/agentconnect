import { describe, it, expect } from 'vitest'
import { isPlatformMemberId } from '../src/platforms/member-id.js'

/**
 * The guard exists so an agent-call `toAgentId` that is really a platform member
 * id — typically copied by a model out of a human-facing mention — is refused
 * BEFORE publishing, rather than surfacing as a visible `@U…` fallback in the
 * thread. These pin what Slack recognizes and, just as load-bearing, that every
 * other platform still recognizes nothing.
 */
describe('platform member id', () => {
  it('recognizes Slack member ids and their mention wrapper', () => {
    for (const id of ['U012ABCDEF', 'W012ABCDEF', '<@U012ABCDEF>', '  U012ABCDEF  ']) {
      expect(isPlatformMemberId('slack', id)).toBe(true)
    }
  })

  it('does not mistake an AgentConnect id for a Slack member id', () => {
    for (const id of ['reviewer', 'code-reviewer', 'agent-1', 'Ubuntu-helper', 'u012abcdef']) {
      expect(isPlatformMemberId('slack', id)).toBe(false)
    }
  })

  it('recognizes nothing on platforms with no registered pattern', () => {
    // Registering Telegram/Discord numeric ids would be a BEHAVIOR CHANGE — ids
    // that route fine today would start being refused — so the default stays
    // "not recognizable", matching today's behavior exactly.
    for (const platform of ['telegram', 'discord', 'feishu', 'some-future-platform']) {
      expect(isPlatformMemberId(platform, 'U012ABCDEF')).toBe(false)
      expect(isPlatformMemberId(platform, '123456789')).toBe(false)
    }
  })
})
