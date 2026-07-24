import { describe, it, expect } from 'vitest'
import {
  NO_RESPONSE_SENTINEL,
  NO_RESPONSE_RULE,
  isNoResponsePrefix,
  isNoResponseBody
} from '../src/session/no-response.js'

describe('no-response sentinel', () => {
  it('the rule teaches the exact sentinel token', () => {
    expect(NO_RESPONSE_SENTINEL).toBe('AC_NO_RESPONSE')
    expect(NO_RESPONSE_RULE).toContain('`AC_NO_RESPONSE`')
  })

  it('isNoResponseBody matches the bare sentinel or a terminal bare sentinel line', () => {
    expect(isNoResponseBody('AC_NO_RESPONSE')).toBe(true)
    expect(isNoResponseBody('This message is for somebody else.\n\nAC_NO_RESPONSE')).toBe(true)
    expect(isNoResponseBody('This message is for somebody else.\r\n  AC_NO_RESPONSE')).toBe(true)
    expect(isNoResponseBody('AC_NO_RESPONSE.')).toBe(false)
    expect(isNoResponseBody('AC_NO_RESPONSE and more')).toBe(false)
    expect(isNoResponseBody('The reserved token is AC_NO_RESPONSE')).toBe(false)
    expect(isNoResponseBody('AC_NO_RESPONSE\nThis is still a real reply')).toBe(false)
    expect(isNoResponseBody('Example:\n```text\nAC_NO_RESPONSE\n```')).toBe(false)
    expect(isNoResponseBody('ac_no_response')).toBe(false)
    // The old generic phrase is ordinary user/model content now, including as a bare line.
    expect(isNoResponseBody('NO_RESPONSE')).toBe(false)
    expect(isNoResponseBody('const state = "NO_RESPONSE"')).toBe(false)
    expect(isNoResponseBody('')).toBe(false)
  })

  it('isNoResponsePrefix holds only genuine (case-sensitive) prefixes of the sentinel', () => {
    // empty + every proper prefix of the sentinel is held while it may still complete
    expect(isNoResponsePrefix('')).toBe(true)
    expect(isNoResponsePrefix('A')).toBe(true)
    expect(isNoResponsePrefix('AC_NO_RESP')).toBe(true)
    expect(isNoResponsePrefix('AC_NO_RESPONSE')).toBe(true)
    // divergent bodies are released immediately (never held)
    expect(isNoResponsePrefix('Ac')).toBe(false) // lowercase c — ordinary reply
    expect(isNoResponsePrefix('AC ')).toBe(false)
    expect(isNoResponsePrefix('AC_NO_RESPONSE ')).toBe(false)
    expect(isNoResponsePrefix('NO_RESPONSE')).toBe(false)
    expect(isNoResponsePrefix('Hello')).toBe(false)
  })
})
