import { describe, expect, it } from 'vitest'
import { formatOrgRefusal, ORG_REFUSAL_MESSAGE, parseOrgRefusal } from './org-refusal.js'

describe('org refusal tag', () => {
  it('formats a registered or unregistered code and refuses anything outside the format', () => {
    expect(formatOrgRefusal('out_of_credits', 'Out of credits')).toBe('[ERR:out_of_credits] Out of credits')
    expect(formatOrgRefusal('some_new_reason', 'Refused')).toBe('[ERR:some_new_reason] Refused')
    expect(() => formatOrgRefusal('Out_Of_Credits', 'x')).toThrow()
    expect(() => formatOrgRefusal('402', 'x')).toThrow()
    expect(() => formatOrgRefusal('out_of_credits', '')).toThrow()
    expect(() => formatOrgRefusal('out_of_credits', ' leading space')).toThrow()
  })

  it('accepts only a leading tag as a whole message', () => {
    expect(ORG_REFUSAL_MESSAGE.test('[ERR:out_of_credits] Out of credits')).toBe(true)
    expect(ORG_REFUSAL_MESSAGE.test('Out of credits [ERR:out_of_credits]')).toBe(false)
    expect(ORG_REFUSAL_MESSAGE.test('[ERR:out_of_credits]')).toBe(false)
  })

  it('finds the tag behind each runtime’s decoration, as measured', () => {
    const sent = '[ERR:out_of_credits] Out of AgentConnect credits'
    for (const handedUp of [
      `API Error: 402 ${sent}`,
      `Internal error: turn failed: ${sent}`,
      `Internal error: ${sent}`,
      sent
    ]) {
      expect(parseOrgRefusal(handedUp)).toEqual({
        code: 'out_of_credits',
        known: 'out_of_credits',
        sentence: 'Out of AgentConnect credits'
      })
    }
    // Codex appends after the message; the sentence keeps it until the reader strips the runtime's decoration.
    expect(
      parseOrgRefusal(`unexpected status 402 Payment Required: ${sent}, url: http://gateway.example.test/v1/responses`)
    ).toEqual({
      code: 'out_of_credits',
      known: 'out_of_credits',
      sentence: 'Out of AgentConnect credits, url: http://gateway.example.test/v1/responses'
    })
  })

  it('reports an unregistered code as unknown rather than dropping it, and finds nothing in untagged text', () => {
    expect(parseOrgRefusal('[ERR:some_new_reason] Refused')).toEqual({
      code: 'some_new_reason',
      known: null,
      sentence: 'Refused'
    })
    expect(parseOrgRefusal('Out of AgentConnect credits')).toBeNull()
    expect(parseOrgRefusal('[ERR:402]Refused')).toBeNull()
    expect(parseOrgRefusal('[ERR:Out] Refused')).toBeNull()
  })
})
