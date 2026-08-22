import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { manifestFor } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { platformIds } from '../src/platforms/integration-config.js'
import { observedMembershipPlatforms } from '../src/platforms/observed-channels.js'

/**
 * The two platform lists that would otherwise be hand-copied beside registries already
 * holding the same set.
 *
 * The load-bearing one: `capabilities.platforms` in the CP registration handshake
 * is what the CP's pre-install gate (`integrationPlatformAvailability`) and the console's
 * tile gating consume, so a platform the daemon can serve but forgot to advertise is
 * silently uninstallable. Both lists are now derived; these pin that the derivations stay
 * tied to the registries, and that adding a platform to one registry and not another
 * fails here rather than in production.
 */

function bareRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-platform-drift-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  return root
}

describe('daemon platform registry (audit F16)', () => {
  it('advertises exactly the platforms it has a module for', () => {
    // The pin on today's true set. A fifth platform makes this fail — deliberately: the
    // reviewer should confirm the CP/console gating is what they intended, not discover
    // it from a failed install.
    expect(platformIds()).toEqual(['slack', 'telegram', 'discord', 'feishu'])
  })

  it('sends the derived list, not a copy, in the CP registration handshake', () => {
    const daemon = new Daemon({ root: bareRoot() })
    expect((daemon as any).registrationPlatforms()).toEqual(platformIds())
  })

  it('agrees with every other platform-keyed registry in the daemon', () => {
    // The drift half. These four tables are independently written and independently
    // consulted (config validation, Layer-2 turn output, §7.4 command chrome, §7.5
    // connection pools); a platform added to one and forgotten in another is a
    // half-served platform, which is what this catches.
    const daemon = new Daemon({ root: bareRoot() }) as any
    const sorted = (ids: string[]): string[] => [...ids].sort()

    expect(sorted(daemon.turnSurfaces.ids())).toEqual(sorted(platformIds()))
    expect(sorted(daemon.commandChrome.ids())).toEqual(sorted(platformIds()))
    // Pools are per (platform, MODE) — Slack runs a socket pool beside a send-only
    // shared one — so the mode suffix is dropped before comparing.
    const poolPlatforms = [
      daemon.connections.slackPool,
      daemon.connections.slackSharedPool,
      daemon.connections.telegramPool,
      daemon.connections.discordPool,
      daemon.connections.feishuPool
    ].map((pool: { name: string }) => pool.name.split('/')[0]!)
    expect(sorted([...new Set(poolPlatforms)])).toEqual(sorted(platformIds()))
  })
})

describe('observed-membership platforms (audit F17)', () => {
  it('is the registry filtered by the manifest, not a hand list', () => {
    expect([...observedMembershipPlatforms()]).toEqual(['telegram', 'discord', 'feishu'])
    for (const platform of platformIds()) {
      expect(observedMembershipPlatforms().includes(platform)).toBe(
        manifestFor(platform).membershipEnumeration === 'observed'
      )
    }
  })

  it('excludes Slack, whose membership snapshot is authoritative', () => {
    expect(manifestFor('slack').membershipEnumeration).toBe('authoritative')
    expect(observedMembershipPlatforms()).not.toContain('slack')
  })

  it('excludes a platform this build has no module for, despite the fail-closed manifest', () => {
    // The subtle half. `manifestFor` is TOTAL and its conservative default is
    // `observed`, so a manifest-only derivation would enumerate every unknown string.
    // Core can only rebuild a channel list for a platform it has a module for, so the
    // registry bounds the set and the manifest only filters it.
    expect(manifestFor('some-future-platform').membershipEnumeration).toBe('observed')
    expect(observedMembershipPlatforms()).not.toContain('some-future-platform')
    expect(observedMembershipPlatforms().every((platform) => platformIds().includes(platform))).toBe(true)
  })
})
