/**
 * The multi-agent platform fact (§5 `multiAgentShareable`) — unit, no I/O.
 *
 * Two routes read it and used to disagree: `POST /integrations` refused a
 * shareable install on anything but Slack, while `PATCH /bots/:id` gated only on
 * the transport, so a Feishu HTTP bot could be flipped `shareable` and carry a
 * flag the install path never honors. What is worth pinning here is the fact
 * itself against the SHIPPED provider set; the two routes' behavior is pinned
 * where it happens (`test/integration/integrations.route.test.ts`).
 */
import { describe, it, expect, vi } from 'vitest'
import { buildCpPlatformRegistry } from './registry.js'
import { createTelegramCpProvider } from './telegram/provider.js'
import { createDiscordCpProvider } from './discord/provider.js'
import { createSlackCpProvider } from './slack/provider.js'
import { createFeishuCpProvider } from './feishu/provider.js'
import { MULTI_AGENT_UNSUPPORTED_MESSAGE, supportsMultiAgentBots } from './sharing.js'

/** The container's composition, with offline stubs — the same construction
 *  `registry.test.ts` uses. */
const shippedPlatforms = () =>
  buildCpPlatformRegistry([
    createTelegramCpProvider({
      verifyBot: vi.fn(async () => ({ status: 'ok' as const, name: null, privacyModeDisabled: true }))
    }),
    createDiscordCpProvider({ ensureMessageContentIntent: vi.fn(async () => 'ready' as const) }),
    createSlackCpProvider({}),
    createFeishuCpProvider({})
  ])

describe('supportsMultiAgentBots', () => {
  it('is true for Slack alone across the shipped platform set', () => {
    // Named against the REGISTRY rather than a hand-copied list, so a platform
    // added to the composition without a decision here is a failing test — and
    // a reminder that the console's `platformSupportsSharing` mirror
    // (packages/web platform modules) has to move in the same change.
    expect(
      shippedPlatforms()
        .ids()
        .filter((id) => supportsMultiAgentBots(id))
    ).toEqual(['slack'])
  })

  it('refuses ids no provider claims, and near-misses', () => {
    // The callers pass a persisted `platform` column and a request body's
    // platform — both open strings, so the predicate has to be total and
    // exact-match.
    for (const id of ['', 'lark', 'Slack', 'slack ', 'webhook', 'github', '__proto__']) {
      expect(supportsMultiAgentBots(id), id).toBe(false)
    }
  })

  it('sends copy that names the same set it decides', () => {
    // Both routes send this one sentence; it goes stale the moment the
    // predicate admits a second platform, so the coupling is worth a claim.
    expect(MULTI_AGENT_UNSUPPORTED_MESSAGE).toContain('Slack')
    expect(MULTI_AGENT_UNSUPPORTED_MESSAGE).not.toMatch(/telegram|discord|feishu|lark/i)
  })
})
