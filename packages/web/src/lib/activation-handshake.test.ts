import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  abandonActivation,
  activationPending,
  beginActivation,
  claimActivationProof,
  promoteActivationProof
} from './activation-handshake'

/** Browser-wide storage: one jar shared by every "tab" in a test, which is what
 *  makes the concurrent-tab ordering cases below meaningful. */
function installStorage(): void {
  const map = new Map<string, string>()
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k)
  })
  // A real-ish cookie jar (assign one, read all back; max-age=0 deletes) so the
  // fallback path behaves like a browser rather than like a plain string field.
  const jar = new Map<string, string>()
  vi.stubGlobal('document', {
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
  })
}

const SUB = 'oidc-subject-1'
const OTHER = 'oidc-subject-2'

beforeEach(installStorage)
afterEach(() => vi.unstubAllGlobals())

describe('activation handshake', () => {
  it('only a completed sign-in authorizes a redemption', () => {
    expect(claimActivationProof('tok', SUB)).toBe(false) // a bare visit proves nothing
    expect(beginActivation('tok')).toBe(true)
    expect(activationPending()).toBe(true)
    // Still nothing: an intent is not proof, so the page signs out again.
    expect(claimActivationProof('tok', SUB)).toBe(false)

    expect(beginActivation('tok')).toBe(true)
    promoteActivationProof(SUB) // ← the OIDC callback ran
    expect(claimActivationProof('tok', SUB)).toBe(true)
  })

  it('proof is single-use — a reload after redeeming cannot replay it', () => {
    beginActivation('tok')
    promoteActivationProof(SUB)
    expect(claimActivationProof('tok', SUB)).toBe(true)
    expect(claimActivationProof('tok', SUB)).toBe(false)
  })

  it('a failed sign-out leaves nothing a later sign-in can promote', () => {
    // The page records the intent, resetSession() throws, the page abandons it.
    beginActivation('tok')
    abandonActivation()
    expect(activationPending()).toBe(false)

    // The user then signs in through some other path; that callback must not mint
    // proof for the activation link (which would redeem under the residual identity).
    promoteActivationProof(SUB)
    expect(claimActivationProof('tok', SUB)).toBe(false)
  })

  it('an ordinary console sign-in never mints activation proof', () => {
    promoteActivationProof(SUB)
    expect(claimActivationProof('tok', SUB)).toBe(false)
  })

  it('a second tab consuming the browser-wide intent cannot redeem — it only re-signs-out', () => {
    beginActivation('tok') // tab 1, awaiting sign-out
    // Tab 2 opens the same link: it finds no proof, so it starts its own handshake
    // rather than redeeming under the session tab 1 is still discarding.
    expect(claimActivationProof('tok', SUB)).toBe(false)
    expect(beginActivation('tok')).toBe(true)
    expect(claimActivationProof('tok', SUB)).toBe(false)
  })

  it('proof is bound to its own token — a different link cannot claim it', () => {
    beginActivation('tok-a')
    promoteActivationProof(SUB)
    expect(claimActivationProof('tok-b', SUB)).toBe(false)
    // …and the mismatched claim consumed it, so tok-a must handshake again too.
    expect(claimActivationProof('tok-a', SUB)).toBe(false)
  })

  it('proof is bound to the identity it was minted for — an account swap voids it', () => {
    // Tab 1 completes a sign-in as SUB for this link…
    beginActivation('tok')
    promoteActivationProof(SUB)
    // …then another tab signs in as somebody else (Logto's token store is
    // browser-wide), so tab 1 is now looking at OTHER's session. A bearer link would
    // otherwise activate OTHER's account off tab 1's proof.
    expect(claimActivationProof('tok', OTHER)).toBe(false)
    expect(claimActivationProof('tok', SUB)).toBe(false) // consumed — handshake again
  })

  it('unattributable proof is never minted or claimed', () => {
    beginActivation('tok')
    promoteActivationProof(undefined) // callback could not read a subject
    expect(claimActivationProof('tok', SUB)).toBe(false)

    beginActivation('tok')
    promoteActivationProof(SUB)
    expect(claimActivationProof('tok', undefined)).toBe(false) // signed out mid-flow
  })

  it('starting a new attempt discards proof left over from an earlier one', () => {
    beginActivation('tok')
    promoteActivationProof(SUB) // proof exists but is never claimed
    expect(beginActivation('tok')).toBe(true)
    expect(claimActivationProof('tok', SUB)).toBe(false)
  })

  it('reports failure when the intent cannot be stored — the caller fails closed', () => {
    vi.stubGlobal('sessionStorage', undefined)
    vi.stubGlobal('document', undefined)
    expect(beginActivation('tok')).toBe(false)
  })
})
