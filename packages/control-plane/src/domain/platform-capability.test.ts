// The platform-capability predicate: the subset rule the install-time gate and the duty ledger's
// claim gate both state. Pure — the SQL that mirrors it row-wise is pinned in the repo tests.
import { describe, it, expect } from 'vitest'
import { missingPlatforms, servesPlatform, servesPlatforms } from './platform-capability.js'

const OLD_IMAGE = ['slack', 'telegram', 'discord', 'feishu']
const NEW_IMAGE = [...OLD_IMAGE, 'linear']

describe('servesPlatforms — the subset rule', () => {
  it('an exact match, and any subset of it, is served', () => {
    expect(servesPlatforms(NEW_IMAGE, NEW_IMAGE)).toBe(true)
    expect(servesPlatforms(NEW_IMAGE, ['slack', 'linear'])).toBe(true)
    expect(servesPlatforms(NEW_IMAGE, ['linear'])).toBe(true)
  })

  // The whole point of the gate: one platform short is ineligible, not degraded. The daemon skips
  // an integration whose platform it has no module for, so a partial match serves a dead surface.
  it('missing ONE platform makes the whole requirement unserved', () => {
    expect(servesPlatforms(OLD_IMAGE, ['linear'])).toBe(false)
    expect(servesPlatforms(OLD_IMAGE, ['slack', 'linear'])).toBe(false)
    expect(missingPlatforms(OLD_IMAGE, ['slack', 'linear'])).toEqual(['linear'])
  })

  // An agent with no integrations at all — webchat, cron, A2A — requires nothing, so the gate is
  // invisible to it. Without this the singleton every agent owns would stop being claimable.
  it('an empty requirement is served by anyone, including a member advertising nothing', () => {
    expect(servesPlatforms(OLD_IMAGE, [])).toBe(true)
    expect(servesPlatforms([], [])).toBe(true)
  })

  it('a member advertising nothing serves no requirement at all', () => {
    expect(servesPlatforms([], ['slack'])).toBe(false)
    expect(missingPlatforms([], ['slack', 'linear'])).toEqual(['slack', 'linear'])
  })

  it('missingPlatforms dedupes and keeps first-seen order — it is a log payload', () => {
    expect(missingPlatforms(OLD_IMAGE, ['linear', 'gitlab', 'linear', 'slack'])).toEqual(['linear', 'gitlab'])
  })

  it('servesPlatform is the one-element case the install gate asks', () => {
    expect(servesPlatform(NEW_IMAGE, 'linear')).toBe(true)
    expect(servesPlatform(OLD_IMAGE, 'linear')).toBe(false)
  })
})
