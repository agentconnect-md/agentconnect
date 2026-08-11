// @vitest-environment happy-dom

// The width contract from three ends: what the clamp admits, what survives a reload, and what the viewport lets the dock take.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DOCK_BODY_FLOOR,
  DOCK_INLINE_CHROME,
  DOCK_WIDE_MIN,
  DOCK_WIDTHS_KEY,
  DOCK_WIDTH_DEFAULT,
  DOCK_WIDTH_INIT,
  DOCK_WIDTH_MAX,
  DOCK_WIDTH_MIN,
  DOCK_WIDTH_PROPERTY,
  clampDockWidth,
  dockWidthCeiling,
  fitDockWidth,
  readDockWidth,
  writeDockWidth
} from './dock-width'

beforeEach(() => {
  window.localStorage.clear()
})

describe('clampDockWidth', () => {
  it('pulls a too-narrow width up to the minimum', () => {
    expect(clampDockWidth(0)).toBe(DOCK_WIDTH_MIN)
    expect(clampDockWidth(DOCK_WIDTH_MIN - 1)).toBe(DOCK_WIDTH_MIN)
    expect(clampDockWidth(-9000)).toBe(DOCK_WIDTH_MIN)
  })

  it('pulls a too-wide width down to the maximum', () => {
    expect(clampDockWidth(DOCK_WIDTH_MAX + 1)).toBe(DOCK_WIDTH_MAX)
    expect(clampDockWidth(9000)).toBe(DOCK_WIDTH_MAX)
  })

  it('keeps a width already inside the contract, rounded to a whole pixel', () => {
    expect(clampDockWidth(520)).toBe(520)
    expect(clampDockWidth(520.4)).toBe(520)
  })

  it('reads a non-finite width as no preference at all', () => {
    expect(clampDockWidth(Number.NaN)).toBe(DOCK_WIDTH_DEFAULT)
    expect(clampDockWidth(Number.POSITIVE_INFINITY)).toBe(DOCK_WIDTH_DEFAULT)
  })
})

// The read side runs during first paint, so every failure mode it can meet must answer with a width rather than a throw.
describe('readDockWidth / writeDockWidth', () => {
  it('round-trips a dragged width', () => {
    writeDockWidth('org-1', 612)
    expect(readDockWidth('org-1')).toBe(612)
  })

  it('clamps on the way in, so a stored width is always inside the contract', () => {
    writeDockWidth('org-1', 9000)
    expect(readDockWidth('org-1')).toBe(DOCK_WIDTH_MAX)
  })

  it('scopes the width per organization', () => {
    writeDockWidth('org-1', 612)
    writeDockWidth('org-2', 400)
    expect(readDockWidth('org-1')).toBe(612)
    expect(readDockWidth('org-2')).toBe(400)
  })

  it('answers the default for an organization that was never dragged', () => {
    writeDockWidth('org-1', 612)
    expect(readDockWidth('org-2')).toBe(DOCK_WIDTH_DEFAULT)
  })

  it('answers the default when nothing is stored at all', () => {
    expect(readDockWidth('org-1')).toBe(DOCK_WIDTH_DEFAULT)
  })

  it('answers the default for malformed JSON rather than throwing', () => {
    window.localStorage.setItem(DOCK_WIDTHS_KEY, '{not json')
    expect(() => readDockWidth('org-1')).not.toThrow()
    expect(readDockWidth('org-1')).toBe(DOCK_WIDTH_DEFAULT)
  })

  it('answers the default for JSON of the wrong shape', () => {
    window.localStorage.setItem(DOCK_WIDTHS_KEY, JSON.stringify({ 'org-1': 612 }))
    expect(readDockWidth('org-1')).toBe(DOCK_WIDTH_DEFAULT)
  })

  it('drops unreadable entries but keeps the readable ones beside them', () => {
    window.localStorage.setItem(
      DOCK_WIDTHS_KEY,
      JSON.stringify([null, 'org-1', { orgId: 'org-1', width: 'wide' }, { orgId: 'org-2', width: 612 }])
    )
    expect(readDockWidth('org-1')).toBe(DOCK_WIDTH_DEFAULT)
    expect(readDockWidth('org-2')).toBe(612)
  })

  it('clamps a stored width that a past contract allowed', () => {
    window.localStorage.setItem(DOCK_WIDTHS_KEY, JSON.stringify([{ orgId: 'org-1', width: 300 }]))
    expect(readDockWidth('org-1')).toBe(DOCK_WIDTH_MIN)
  })

  it('replaces an organization entry rather than accumulating one per drag', () => {
    writeDockWidth('org-1', 500)
    writeDockWidth('org-1', 600)
    expect(readDockWidth('org-1')).toBe(600)
    expect(JSON.parse(window.localStorage.getItem(DOCK_WIDTHS_KEY) ?? '[]')).toHaveLength(1)
  })

  it('writes over a corrupt store instead of failing', () => {
    window.localStorage.setItem(DOCK_WIDTHS_KEY, '{not json')
    writeDockWidth('org-1', 612)
    expect(readDockWidth('org-1')).toBe(612)
  })
})

// `activeOrg` is null until OrgProvider's fetch lands, so first paint — where the track has to be right — always asks with no org id.
describe('readDockWidth before the org resolves', () => {
  it('answers with the width the reader last used', () => {
    writeDockWidth('org-1', 612)
    expect(readDockWidth('')).toBe(612)
  })

  it('prefers the most recent org, since entries are MRU-ordered', () => {
    writeDockWidth('org-1', 612)
    writeDockWidth('org-2', 420)
    expect(readDockWidth('')).toBe(420)
    writeDockWidth('org-1', 612)
    expect(readDockWidth('')).toBe(612)
  })

  it('still answers the default when nothing was ever dragged', () => {
    expect(readDockWidth('')).toBe(DOCK_WIDTH_DEFAULT)
  })

  it('does not lend one org width to another named org', () => {
    writeDockWidth('org-1', 612)
    expect(readDockWidth('org-2')).toBe(DOCK_WIDTH_DEFAULT)
  })
})

// The applied width is what the transcript pays. The old geometry had a cliff: one pixel past `wide:` handed the body ~544px where 880px stood.
describe('fitDockWidth', () => {
  it('withholds nothing below `wide:`, where the dock is an overlay', () => {
    expect(fitDockWidth(700, DOCK_WIDE_MIN - 1)).toBe(700)
    expect(fitDockWidth(DOCK_WIDTH_MAX, 800)).toBe(DOCK_WIDTH_MAX)
  })

  it('withholds nothing on the server, which has no viewport to fit', () => {
    expect(fitDockWidth(700, 0)).toBe(700)
    expect(fitDockWidth(700, Number.NaN)).toBe(700)
  })

  it('leaves the transcript exactly its floor at the breakpoint itself', () => {
    const applied = fitDockWidth(DOCK_WIDTH_MAX, DOCK_WIDE_MIN)
    expect(applied).toBe(DOCK_WIDTH_MIN)
    expect(DOCK_WIDE_MIN - DOCK_INLINE_CHROME - applied).toBe(DOCK_BODY_FLOOR)
  })

  it('keeps that floor across the laptop widths that graduate into the inline band', () => {
    for (const viewport of [1316, 1366, 1440, 1512, 1600]) {
      const applied = fitDockWidth(DOCK_WIDTH_MAX, viewport)
      expect(viewport - DOCK_INLINE_CHROME - applied).toBeGreaterThanOrEqual(DOCK_BODY_FLOOR)
      expect(applied).toBeGreaterThanOrEqual(DOCK_WIDTH_MIN)
    }
  })

  it('bends nothing once the viewport can hold the whole preference', () => {
    expect(fitDockWidth(DOCK_WIDTH_MAX, 1920)).toBe(DOCK_WIDTH_MAX)
    expect(fitDockWidth(DOCK_WIDTH_DEFAULT, 1440)).toBe(DOCK_WIDTH_DEFAULT)
  })

  it('never bends below the minimum, however narrow the viewport claims to be', () => {
    expect(dockWidthCeiling(DOCK_WIDE_MIN)).toBe(DOCK_WIDTH_MIN)
    expect(fitDockWidth(700, 400)).toBeGreaterThanOrEqual(DOCK_WIDTH_MIN)
  })

  it('clamps the input first, so an out-of-contract width cannot slip through', () => {
    expect(fitDockWidth(9000, 1920)).toBe(DOCK_WIDTH_MAX)
    expect(fitDockWidth(10, 1920)).toBe(DOCK_WIDTH_MIN)
  })
})

// The pre-paint script is hand-written source text: it cannot call the functions above, so every case it must agree with them on is measured here.
describe('DOCK_WIDTH_INIT', () => {
  // What the browser does with the tag; happy-dom does not run inline scripts, so the source is evaluated directly.
  const run = () => new Function(DOCK_WIDTH_INIT)()
  const applied = () => document.documentElement.style.getPropertyValue(DOCK_WIDTH_PROPERTY)

  beforeEach(() => {
    document.documentElement.style.removeProperty(DOCK_WIDTH_PROPERTY)
    window.innerWidth = 1920
  })

  // Everything the reader's store can hold, against every band of the viewport it is fitted to.
  const stores: Array<[string, string | null]> = [
    ['nothing stored', null],
    ['one dragged org', JSON.stringify([{ orgId: 'org-1', width: 612 }])],
    [
      'several orgs, MRU first',
      JSON.stringify([
        { orgId: 'org-2', width: 420 },
        { orgId: 'org-1', width: 612 }
      ])
    ],
    [
      'unreadable members before a readable one',
      JSON.stringify([null, 'org-1', { orgId: 'x', width: 'wide' }, { orgId: 'org-2', width: 612 }])
    ],
    ['a width a past contract allowed', JSON.stringify([{ orgId: 'org-1', width: 300 }])],
    ['a width past the ceiling', JSON.stringify([{ orgId: 'org-1', width: 9000 }])],
    ['a fractional width', JSON.stringify([{ orgId: 'org-1', width: 612.6 }])],
    ['a null width', JSON.stringify([{ orgId: 'org-1', width: null }])],
    ['malformed JSON', '{not json'],
    ['JSON of the wrong shape', JSON.stringify({ 'org-1': 612 })],
    ['an empty list', '[]']
  ]

  for (const [name, raw] of stores) {
    for (const viewport of [1024, DOCK_WIDE_MIN, 1366, 1920]) {
      it(`applies what the reader gets from ${name} at ${viewport}px`, () => {
        if (raw !== null) window.localStorage.setItem(DOCK_WIDTHS_KEY, raw)
        window.innerWidth = viewport
        run()
        // The one claim that matters: the script's number IS the number the dock would compute once it has read storage itself.
        expect(applied()).toBe(`${fitDockWidth(readDockWidth(''), viewport)}px`)
      })
    }
  }

  it('applies the fitted default when storage cannot be read at all, rather than throwing or leaving it unset', () => {
    const getItem = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('private mode')
    })
    window.innerWidth = 1366
    expect(() => run()).not.toThrow()
    expect(applied()).toBe(`${fitDockWidth(DOCK_WIDTH_DEFAULT, 1366)}px`)
    getItem.mockRestore()
  })

  it('has the default to fall back on when the script itself never runs', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/app/globals.css'), 'utf8')
    expect(css).toContain(`--dock-width: ${DOCK_WIDTH_DEFAULT}px;`)
  })
})

// The breakpoint is arithmetic shared with CSS, which cannot import it — so the two are checked against each other here.
describe('DOCK_WIDE_MIN', () => {
  it('is chrome + the minimum dock + the transcript floor', () => {
    expect(DOCK_INLINE_CHROME).toBe(240 + 60 + 26 - 30)
    expect(DOCK_WIDE_MIN).toBe(DOCK_INLINE_CHROME + DOCK_WIDTH_MIN + DOCK_BODY_FLOOR)
    expect(DOCK_WIDE_MIN).toBe(1316)
  })

  it('is the value `--breakpoint-wide` carries in globals.css', () => {
    // Read off disk relative to the package root: `import.meta.url` is not a file URL in the browser-shaped test environment.
    const css = readFileSync(resolve(process.cwd(), 'src/app/globals.css'), 'utf8')
    expect(css).toContain(`--breakpoint-wide: ${DOCK_WIDE_MIN}px;`)
  })
})
