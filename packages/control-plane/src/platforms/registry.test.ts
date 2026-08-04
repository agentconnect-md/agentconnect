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

const telegram = () =>
  createTelegramCpProvider({
    verifyBot: vi.fn(async () => ({ status: 'ok' as const, name: null, privacyModeDisabled: true }))
  })
const discord = () =>
  createDiscordCpProvider({
    ensureMessageContentIntent: vi.fn(async () => 'ready' as const)
  })

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
