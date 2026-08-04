import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { WebPlatformModule } from './contract'
import { PlatformCredentialCards } from './profile'

/**
 * `ProfileCredentialCard` (§10) — the member `SlackConfigCard` landed behind
 * when it stopped being the last direct core caller of a platform-named
 * `lib/api` export.
 *
 * The RENDER claims run against stand-ins, because the shipped registry has
 * exactly one card and the thing worth pinning is what happens around it: a
 * platform that declares none must contribute nothing at all — no wrapper, no
 * separator, no empty card — which is precisely what the Profile page did
 * before this list existed. The DECLARATION claim runs against the real
 * registry.
 */
const { stubs } = vi.hoisted(() => ({ stubs: [] as WebPlatformModule[] }))

vi.mock('@/components/console/platforms/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./registry')>()
  return { ...actual, platformRegistry: { ...actual.platformRegistry, all: () => stubs } }
})

/** Only `platformId` and the card are read; the rest of the module never
 *  reaches this surface. */
function stub(platformId: string, card?: () => React.ReactElement): WebPlatformModule {
  return { platformId, ...(card ? { ProfileCredentialCard: card } : {}) } as unknown as WebPlatformModule
}

describe('per-platform Profile credential cards', () => {
  it('renders nothing for a platform that declares no card', () => {
    stubs.length = 0
    stubs.push(stub('telegram'), stub('discord'))
    expect(renderToStaticMarkup(<PlatformCredentialCards />)).toBe('')
  })

  it('renders nothing at all when no platform declares one', () => {
    stubs.length = 0
    expect(renderToStaticMarkup(<PlatformCredentialCards />)).toBe('')
  })

  it('renders the declared cards in registry order, skipping the rest', () => {
    stubs.length = 0
    stubs.push(
      stub('slack', () => <i>slack-card</i>),
      stub('telegram'),
      stub('discord'),
      stub('feishu', () => <i>feishu-card</i>)
    )
    expect(renderToStaticMarkup(<PlatformCredentialCards />)).toBe('<i>slack-card</i><i>feishu-card</i>')
  })

  it('declares the card on Slack alone in the shipped registry', async () => {
    // Per-USER tooling credentials, not org bot identities: Slack's App
    // Configuration token is the only one a platform asks its installer for.
    const { platformRegistry } = await vi.importActual<typeof import('./registry')>('./registry')
    expect(
      platformRegistry
        .all()
        .filter((m) => m.ProfileCredentialCard)
        .map((m) => m.platformId)
    ).toEqual(['slack'])
  })
})
