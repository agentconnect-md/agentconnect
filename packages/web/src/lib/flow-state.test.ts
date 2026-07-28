import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFlowState, takeFlowState, writeFlowState } from './flow-state'

/** A `document.cookie` stand-in with the real read/write asymmetry (assigning one
 *  cookie, reading them all back joined) plus max-age=0 deletion. */
function fakeCookieJar(): { document: { cookie: string } } {
  const jar = new Map<string, string>()
  return {
    document: {
      get cookie(): string {
        return [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
      },
      set cookie(assignment: string) {
        const [pair = '', ...attrs] = assignment.split('; ')
        const eq = pair.indexOf('=')
        const name = pair.slice(0, eq)
        if (attrs.some((a) => a.toLowerCase() === 'max-age=0')) jar.delete(name)
        else jar.set(name, pair.slice(eq + 1))
      }
    }
  }
}

/** sessionStorage that works (the happy path). */
function fakeSessionStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k)
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('flow-state', () => {
  it('round-trips through sessionStorage under the shared ac. namespace', () => {
    const store = fakeSessionStorage()
    vi.stubGlobal('sessionStorage', store)
    vi.stubGlobal('document', fakeCookieJar().document)

    expect(writeFlowState('returnTo', '/activate/tok')).toBe(true)
    // Other pages write `ac.returnTo` into sessionStorage directly — stay compatible.
    expect(store.getItem('ac.returnTo')).toBe('/activate/tok')
    expect(takeFlowState('returnTo')).toBe('/activate/tok')
    expect(readFlowState('returnTo')).toBeNull()
  })

  it('falls back to a cookie when sessionStorage throws', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      }
    })
    const { document } = fakeCookieJar()
    vi.stubGlobal('document', document)

    expect(writeFlowState('activate.fresh', 'tok')).toBe(true)
    expect(document.cookie).toContain('ac.activate.fresh=tok')
    expect(readFlowState('activate.fresh')).toBe('tok')
    expect(takeFlowState('activate.fresh')).toBe('tok')
    expect(readFlowState('activate.fresh')).toBeNull()
  })

  it('falls back to a cookie when sessionStorage accepts a write then drops it', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
    const { document } = fakeCookieJar()
    vi.stubGlobal('document', document)

    expect(writeFlowState('activate.fresh', 'tok')).toBe(true)
    expect(readFlowState('activate.fresh')).toBe('tok')
  })

  it('reports failure when NEITHER store is usable — callers must fail closed', () => {
    // No sessionStorage and no document at all (the strictest privacy modes): the
    // activation page relies on this `false` to refuse to redeem under the session
    // it cannot sign out and resume.
    vi.stubGlobal('sessionStorage', undefined)
    vi.stubGlobal('document', undefined)

    expect(writeFlowState('activate.fresh', 'tok')).toBe(false)
    expect(readFlowState('activate.fresh')).toBeNull()
  })

  it('reports failure when cookies are silently dropped', () => {
    vi.stubGlobal('sessionStorage', undefined)
    vi.stubGlobal('document', {
      get cookie() {
        return ''
      },
      set cookie(_v: string) {
        /* accepted and discarded */
      }
    })

    expect(writeFlowState('returnTo', '/activate/tok')).toBe(false)
  })
})
