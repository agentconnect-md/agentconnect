import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  partitionPinned,
  pinnedIdsForOrg,
  readSessionPins,
  SESSION_PINS_KEY,
  SESSION_PINS_MAX,
  toggleSessionPin,
  writeSessionPins,
  type SessionPin
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

const pin = (id: string, orgId = 'o1'): SessionPin => ({ id, orgId })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readSessionPins', () => {
  it('returns [] without a window (SSR)', () => {
    expect(readSessionPins()).toEqual([])
  })

  it('reads stored pins in order', () => {
    stubStorage(JSON.stringify([pin('b'), pin('a', 'o2')]))
    expect(readSessionPins()).toEqual([pin('b'), pin('a', 'o2')])
  })

  it('returns [] for an unset key, malformed JSON, or a non-array', () => {
    stubStorage()
    expect(readSessionPins()).toEqual([])
    stubStorage('{oops')
    expect(readSessionPins()).toEqual([])
    stubStorage(JSON.stringify({ a: true }))
    expect(readSessionPins()).toEqual([])
  })

  it('migrates the legacy flat string[] shape to session pins', () => {
    stubStorage(JSON.stringify(['s1', 's2']))
    expect(readSessionPins()).toEqual([pin('s1', ''), pin('s2', '')])
  })

  it('drops unusable entries, migrates prior unscoped rows, and de-duplicates by id', () => {
    stubStorage(JSON.stringify([{ id: 'a', agentId: 'a1' }, 3, null, '', { id: 'b' }, { agentId: 'a1' }, pin('a')]))
    expect(readSessionPins()).toEqual([pin('a', ''), pin('b', '')])
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
    expect(() => writeSessionPins([pin('a')])).not.toThrow()
  })
})

describe('writeSessionPins', () => {
  it('persists de-duplicated pins capped at SESSION_PINS_MAX', () => {
    const store = stubStorage()
    const pins = Array.from({ length: SESSION_PINS_MAX + 5 }, (_, i) => pin(`s${i}`))
    writeSessionPins([...pins, pin('s0')])
    const written = JSON.parse(store.get(SESSION_PINS_KEY) ?? '[]') as SessionPin[]
    expect(written).toHaveLength(SESSION_PINS_MAX)
    // Forgetting is by RECENCY: the oldest pins fall off the END.
    expect(written[0]).toEqual(pin('s0'))
    expect(written.map((p) => p.id)).not.toContain(`s${SESSION_PINS_MAX}`)
  })

  it('is a no-op without a window', () => {
    expect(() => writeSessionPins([pin('a')])).not.toThrow()
  })
})

describe('toggleSessionPin', () => {
  it('pins to the front with its organization and unpins by session id', () => {
    expect(toggleSessionPin([pin('a')], 'b', 'o1')).toEqual([pin('b'), pin('a')])
    expect(toggleSessionPin([pin('b'), pin('a')], 'b', 'o2')).toEqual([pin('a')])
    expect(toggleSessionPin([], 'a', 'o2')).toEqual([pin('a', 'o2')])
  })

  it('does not mutate the input', () => {
    const pins = [pin('a')]
    toggleSessionPin(pins, 'b', 'o1')
    expect(pins).toEqual([pin('a')])
  })
})

describe('pinnedIdsForOrg', () => {
  it('filters by organization before the hydration cap is applied', () => {
    const pins = [pin('a', 'o1'), pin('b', 'o2'), pin('c', 'o1')]
    expect(pinnedIdsForOrg(pins, 'o1')).toEqual(['a', 'c'])
    expect(pinnedIdsForOrg(pins, 'o2')).toEqual(['b'])
  })

  it('does not speculate about legacy unscoped pins or an unknown organization', () => {
    expect(pinnedIdsForOrg([pin('old', ''), pin('a')], 'o1')).toEqual(['a'])
    expect(pinnedIdsForOrg([pin('a')], '')).toEqual([])
  })
})

describe('partitionPinned', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  it('lifts pinned rows in PIN order and keeps the rest in input order', () => {
    expect(partitionPinned(rows, [pin('c'), pin('a')])).toEqual({
      pinned: [{ id: 'c' }, { id: 'a' }],
      rest: [{ id: 'b' }]
    })
  })

  it('ignores pinned ids that are not in the list', () => {
    expect(partitionPinned(rows, [pin('zz'), pin('b')])).toEqual({
      pinned: [{ id: 'b' }],
      rest: [{ id: 'a' }, { id: 'c' }]
    })
  })

  it('groups a pin that is on the page', () => {
    expect(partitionPinned(rows, [pin('b', '')])).toEqual({
      pinned: [{ id: 'b' }],
      rest: [{ id: 'a' }, { id: 'c' }]
    })
  })

  it('is a pass-through with no pins', () => {
    expect(partitionPinned(rows, [])).toEqual({ pinned: [], rest: rows })
  })

  it('keeps a conversation pinned after another participant becomes its newest', () => {
    // A conversation row is identified by its newest member, which moves as the
    // participants take turns. The pin was written against `m2`; the row now
    // answers to `m1`, and matching on the row id alone would lose it.
    const conversation = { id: 'm1', members: ['m1', 'm2'] }
    const other = { id: 'x', members: ['x'] }
    expect(partitionPinned([conversation, other], [pin('m2')], (row) => row.members)).toEqual({
      pinned: [conversation],
      rest: [other]
    })
  })

  it('lists a conversation once when several of its members are pinned', () => {
    const conversation = { id: 'm1', members: ['m1', 'm2'] }
    expect(partitionPinned([conversation], [pin('m1'), pin('m2')], (row) => row.members)).toEqual({
      pinned: [conversation],
      rest: []
    })
  })
})
