import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  partitionPinned,
  pinnedIdsForAgent,
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

const pin = (id: string, agentId = 'a1'): SessionPin => ({ id, agentId })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readSessionPins', () => {
  it('returns [] without a window (SSR)', () => {
    expect(readSessionPins()).toEqual([])
  })

  it('reads stored pins in order', () => {
    stubStorage(JSON.stringify([pin('b'), pin('a', 'a2')]))
    expect(readSessionPins()).toEqual([pin('b'), pin('a', 'a2')])
  })

  it('returns [] for an unset key, malformed JSON, or a non-array', () => {
    stubStorage()
    expect(readSessionPins()).toEqual([])
    stubStorage('{oops')
    expect(readSessionPins()).toEqual([])
    stubStorage(JSON.stringify({ a: true }))
    expect(readSessionPins()).toEqual([])
  })

  it('migrates the legacy flat string[] shape to unattributed pins', () => {
    stubStorage(JSON.stringify(['s1', 's2']))
    expect(readSessionPins()).toEqual([
      { id: 's1', agentId: '' },
      { id: 's2', agentId: '' }
    ])
  })

  it('drops unusable entries, defaults a missing agentId, and de-duplicates by id', () => {
    stubStorage(JSON.stringify([pin('a'), 3, null, '', { id: 'b' }, { agentId: 'a1' }, pin('a', 'a9')]))
    expect(readSessionPins()).toEqual([pin('a'), { id: 'b', agentId: '' }])
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
  it('pins to the front with its owning agent, and unpins in place', () => {
    expect(toggleSessionPin([pin('a')], 'b', 'a1')).toEqual([pin('b'), pin('a')])
    expect(toggleSessionPin([pin('b'), pin('a')], 'b', 'a1')).toEqual([pin('a')])
    expect(toggleSessionPin([], 'a', 'a7')).toEqual([pin('a', 'a7')])
  })

  it('unpins by id regardless of the agent passed', () => {
    expect(toggleSessionPin([pin('a', 'a2')], 'a', 'a1')).toEqual([])
  })

  it('does not mutate the input', () => {
    const pins = [pin('a')]
    toggleSessionPin(pins, 'b', 'a1')
    expect(pins).toEqual([pin('a')])
  })
})

describe('pinnedIdsForAgent', () => {
  // The regression this locks: the stored list is GLOBAL across agents, so a rail
  // must never treat another agent's pins as its own — an earlier version pruned
  // against one agent's loaded page and deleted every other agent's pin.
  it('claims only the given agent, newest pin first', () => {
    const pins = [pin('x', 'a2'), pin('y', 'a1'), pin('z', 'a1')]
    expect(pinnedIdsForAgent(pins, 'a1')).toEqual(['y', 'z'])
    expect(pinnedIdsForAgent(pins, 'a2')).toEqual(['x'])
    expect(pinnedIdsForAgent(pins, 'a3')).toEqual([])
  })

  it('never claims unattributed (legacy) pins — they would be fetched on every rail', () => {
    expect(pinnedIdsForAgent([{ id: 'old', agentId: '' }], 'a1')).toEqual([])
  })

  it('claims nothing for an unknown agent', () => {
    expect(pinnedIdsForAgent([pin('a')], '')).toEqual([])
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

  it('groups an unattributed pin that IS on the page', () => {
    expect(partitionPinned(rows, [{ id: 'b', agentId: '' }])).toEqual({
      pinned: [{ id: 'b' }],
      rest: [{ id: 'a' }, { id: 'c' }]
    })
  })

  it('is a pass-through with no pins', () => {
    expect(partitionPinned(rows, [])).toEqual({ pinned: [], rest: rows })
  })
})
