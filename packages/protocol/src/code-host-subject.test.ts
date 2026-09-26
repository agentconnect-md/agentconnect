import { describe, expect, it } from 'vitest'
import { CODE_HOST_SUBJECT_MAX_BYTES, codeHostSubjectBody } from './code-host-subject.js'

describe('code-host subject body', () => {
  it('keeps descriptions between four and eight KiB complete, including closing attribution', () => {
    const body = `Summary\n${'界'.repeat(1500)}\nCreated by Example Agent`
    expect(Buffer.byteLength(body)).toBeGreaterThan(4096)
    expect(codeHostSubjectBody(body)).toEqual({ body, bodyTruncated: false })
  })

  it('retains UTF-8 boundaries and both ends through repeated budget reductions', () => {
    const footer = '\nCreated by Example Agent'
    let body = `\uFEFFSummary\n${'界🙂'.repeat(4000)}${footer}`
    for (const budget of [CODE_HOST_SUBJECT_MAX_BYTES, 4095, 1023]) {
      const clipped = codeHostSubjectBody(body, budget)
      expect(clipped.bodyTruncated).toBe(true)
      expect(Buffer.byteLength(clipped.body)).toBeLessThanOrEqual(budget)
      expect(clipped.body).toMatch(/^\uFEFFSummary\n/)
      expect(clipped.body.endsWith(footer)).toBe(true)
      expect(clipped.body).toContain('[... content omitted ...]')
      expect(clipped.body).not.toContain('�')
      body = clipped.body
    }
    expect(codeHostSubjectBody(body, 0)).toEqual({ body: '', bodyTruncated: true })
  })
})
