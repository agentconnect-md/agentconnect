/**
 * Structural guard over the activation parity spec (`evals/parity/spec.ts`):
 * the governance rule ("all legs pass or the divergence is declared") only
 * works if the spec itself stays well-formed. See
 * docs/designs/activation-parity.md.
 */
import { describe, expect, it } from 'vitest'
import { PARITY_SCENARIOS, PARITY_SURFACES, declaredOutcome } from '../parity/spec.js'

describe('activation parity spec', () => {
  it('scenario ids are unique', () => {
    const ids = PARITY_SCENARIOS.map((scenario) => scenario.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every scenario runs somewhere: at least one surface expectation each', () => {
    for (const scenario of PARITY_SCENARIOS) {
      expect(Object.keys(scenario.expect).length, scenario.id).toBeGreaterThan(0)
    }
  })

  it('a surface is either expected or declared not-applicable, never both — and a skip carries its reason', () => {
    for (const scenario of PARITY_SCENARIOS) {
      for (const surface of PARITY_SURFACES) {
        const expected = scenario.expect[surface] !== undefined
        const skipped = scenario.notApplicable?.[surface]
        expect(expected && skipped !== undefined, `${scenario.id} declares ${surface} both ways`).toBe(false)
        expect(
          expected || (skipped !== undefined && skipped.length > 0),
          `${scenario.id} says nothing about ${surface}`
        ).toBe(true)
      }
    }
  })

  it('a per-surface difference in expectations is a DECLARED divergence with design citations', () => {
    for (const scenario of PARITY_SCENARIOS) {
      const expectations = PARITY_SURFACES.flatMap((surface) => {
        const expectation = scenario.expect[surface]
        if (expectation === undefined) return []
        // Compare the outcome fields that define parity; notes are per-surface
        // mechanics footnotes and may legitimately differ. Same shape every
        // leg driver pins with an exact toEqual.
        return [JSON.stringify(declaredOutcome(expectation))]
      })
      const diverges = new Set(expectations).size > 1
      if (diverges) {
        expect(scenario.divergence, `${scenario.id} diverges across surfaces without a declaration`).toBeDefined()
      }
      if (scenario.divergence) {
        expect(scenario.divergence.cites.length, `${scenario.id} divergence cites nothing`).toBeGreaterThan(0)
        for (const cite of scenario.divergence.cites) {
          expect(cite, `${scenario.id} divergence citation must point into docs/designs`).toMatch(/^docs\/designs\//)
        }
      }
    }
  })
})
