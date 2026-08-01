import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  partitionPinned,
  pruneSessionPins,
  readSessionPins,
  SESSION_PINS_KEY,
  SESSION_PINS_MAX,
  toggleSessionPin,
  writeSessionPins
} from '@/lib/session-pins'

// The suite runs in the `node` environment, so `window` is genuinely absent until
// stubbed — which also exercises the SSR branch of the storage helpers.
function stubStorage(initial?: string) {
  const store = new Map<string, string>()
  if (initial !== undefined) store.set(SESSION_PINS_KEY, initial)
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v)
  }
  vi.stubGlobal('window', { localStorage })
  return store
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readSessionPins', () => {
  it('returns [] without a window (SSR)', () => {
    expect(readSessionPins()).toEqual([])
  })

  it('reads a stored id list in order', () => {
    stubStorage(JSON.stringify(['b', 'a']))
    expect(readSessionPins()).toEqual(['b', 'a'])
  })

  it('returns [] for an unset key, malformed JSON, or a non-array', () => {
    stubStorage()
    expect(readSessionPins()).toEqual([])
    stubStorage('{oops')
    expect(readSessionPins()).toEqual([])
    stubStorage(JSON.stringify({ a: true }))
    expect(readSessionPins()).toEqual([])
  })

  it('drops non-string / empty entries and de-duplicates', () => {
    stubStorage(JSON.stringify(['a', 3, null, '', 'b', 'a']))
    expect(readSessionPins()).toEqual(['a', 'b'])
  })

  it('survives storage that throws (private mode)', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem() {
          throw new Error('blocked')
        },
        setItem() {
          throw new Error('blocked')
        }
      }
    })
    expect(readSessionPins()).toEqual([])
    expect(() => writeSessionPins(['a'])).not.toThrow()
  })
})

describe('writeSessionPins', () => {
  it('persists de-duplicated ids capped at SESSION_PINS_MAX', () => {
    const store = stubStorage()
    const ids = Array.from({ length: SESSION_PINS_MAX + 5 }, (_, i) => `s${i}`)
    writeSessionPins([...ids, 's0'])
    const written = JSON.parse(store.get(SESSION_PINS_KEY) ?? '[]') as string[]
    expect(written).toHaveLength(SESSION_PINS_MAX)
    // Oldest pins fall off the END — the newest are kept.
    expect(written[0]).toBe('s0')
    expect(written).not.toContain(`s${SESSION_PINS_MAX}`)
  })

  it('is a no-op without a window', () => {
    expect(() => writeSessionPins(['a'])).not.toThrow()
  })
})

describe('toggleSessionPin', () => {
  it('pins to the front and unpins in place', () => {
    expect(toggleSessionPin(['a'], 'b')).toEqual(['b', 'a'])
    expect(toggleSessionPin(['b', 'a'], 'b')).toEqual(['a'])
    expect(toggleSessionPin([], 'a')).toEqual(['a'])
  })

  it('does not mutate the input', () => {
    const ids = ['a']
    toggleSessionPin(ids, 'b')
    expect(ids).toEqual(['a'])
  })
})

describe('pruneSessionPins', () => {
  // The invariant that matters: a pinned session sitting outside the loaded page is
  // unknown, NOT deleted. Pruning eagerly would silently unpin it.
  it('leaves an under-cap list untouched even when nothing is known', () => {
    expect(pruneSessionPins(['a', 'b'], [])).toEqual(['a', 'b'])
  })

  it('drops unknown ids once over the cap', () => {
    const over = Array.from({ length: SESSION_PINS_MAX + 1 }, (_, i) => `s${i}`)
    expect(pruneSessionPins(over, ['s3', 's7'])).toEqual(['s3', 's7'])
  })

  it('keeps the newest cap-worth rather than emptying the list', () => {
    const over = Array.from({ length: SESSION_PINS_MAX + 3 }, (_, i) => `s${i}`)
    const kept = pruneSessionPins(over, ['nothing-matches'])
    expect(kept).toHaveLength(SESSION_PINS_MAX)
    expect(kept[0]).toBe('s0')
  })
})

describe('partitionPinned', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  it('lifts pinned rows in PIN order and keeps the rest in input order', () => {
    expect(partitionPinned(rows, ['c', 'a'])).toEqual({
      pinned: [{ id: 'c' }, { id: 'a' }],
      rest: [{ id: 'b' }]
    })
  })

  it('ignores pinned ids that are not in the list', () => {
    expect(partitionPinned(rows, ['zz', 'b'])).toEqual({ pinned: [{ id: 'b' }], rest: [{ id: 'a' }, { id: 'c' }] })
  })

  it('renders a duplicated pin id once', () => {
    expect(partitionPinned(rows, ['a', 'a'])).toEqual({ pinned: [{ id: 'a' }], rest: [{ id: 'b' }, { id: 'c' }] })
  })

  it('is a pass-through with no pins', () => {
    expect(partitionPinned(rows, [])).toEqual({ pinned: [], rest: rows })
  })
})
