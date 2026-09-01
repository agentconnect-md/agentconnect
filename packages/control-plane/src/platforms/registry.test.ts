/**
 * CpPlatformRegistry (§9, S3) — unit, no I/O. The registry is deliberately
 * dumb; what matters is the composition contract: keyed lookup, stable
 * enumeration order, the id set as the single platform-set authority, and a
 * duplicate registration failing construction (a composition bug, not data).
 */
import { describe, it, expect, vi } from 'vitest'
import { buildCpPlatformRegistry } from './registry.js'
import { createTelegramCpProvider } from './telegram/provider.js'
import { createDiscordCpProvider } from './discord/provider.js'
import { createSlackCpProvider } from './slack/provider.js'
import { createFeishuCpProvider } from './feishu/provider.js'
import { createLinearCpProvider } from './linear/provider.js'

const telegram = () =>
  createTelegramCpProvider({
    verifyBot: vi.fn(async () => ({ status: 'ok' as const, name: null, privacyModeDisabled: true }))
  })
const discord = () =>
  createDiscordCpProvider({
    ensureMessageContentIntent: vi.fn(async () => 'ready' as const)
  })
const slack = () => createSlackCpProvider({})
const feishu = () => createFeishuCpProvider({})
const linear = () => createLinearCpProvider({})

describe('buildCpPlatformRegistry', () => {
  it('keys providers by platform id and misses unknown ids', () => {
    const tg = telegram()
    const dc = discord()
    const registry = buildCpPlatformRegistry([tg, dc])
    expect(registry.get('telegram')).toBe(tg)
    expect(registry.get('discord')).toBe(dc)
    expect(registry.get('slack')).toBeUndefined()
    expect(registry.get('')).toBeUndefined()
  })

  it('enumerates providers and ids in registration order', () => {
    const tg = telegram()
    const dc = discord()
    const registry = buildCpPlatformRegistry([tg, dc])
    expect(registry.all()).toEqual([tg, dc])
    expect(registry.ids()).toEqual(['telegram', 'discord'])
  })

  it('holds every served platform — the container composition (S3 exit criterion)', () => {
    const providers = [telegram(), discord(), slack(), feishu(), linear()]
    const registry = buildCpPlatformRegistry(providers)
    expect(registry.ids()).toEqual(['telegram', 'discord', 'slack', 'feishu', 'linear'])
    expect(registry.get('slack')).toBe(providers[2])
    expect(registry.get('feishu')).toBe(providers[3])
    expect(registry.get('linear')).toBe(providers[4])
    // The §6.7 relay path is exactly the platforms that implement it (erratum:
    // absence IS the "no relay path" signal). Linear is relay-only by nature —
    // it has no dial-out transport at all (linear-integration.md §4.2).
    expect(
      registry
        .all()
        .filter((p) => p.projectBotAssign !== undefined)
        .map((p) => p.platformId)
    ).toEqual(['slack', 'feishu', 'linear'])
  })

  it('fails construction on a duplicate platform id', () => {
    expect(() => buildCpPlatformRegistry([telegram(), telegram()])).toThrow(
      'duplicate control-plane platform provider: telegram'
    )
  })

  it('holds an empty set without special-casing', () => {
    const registry = buildCpPlatformRegistry([])
    expect(registry.all()).toEqual([])
    expect(registry.ids()).toEqual([])
    expect(registry.get('telegram')).toBeUndefined()
  })
})
