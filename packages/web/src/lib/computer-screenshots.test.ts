import { describe, expect, it } from 'vitest'
import { screenshotRefsIn } from './computer-screenshots'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

describe('screenshotRefsIn', () => {
  it('finds references in plain and string-escaped JSON, once each', () => {
    const plain = JSON.stringify({ computer: 'c', stored: `sha256:${A}` })
    const nested = JSON.stringify({ rawOutput: [{ type: 'text', text: plain }], content: [{ text: plain }] })
    expect(screenshotRefsIn(nested)).toEqual([A])
    expect(screenshotRefsIn(`${plain} ${JSON.stringify({ stored: `sha256:${B}` })}`)).toEqual([A, B])
  })

  it('ignores anything else', () => {
    expect(screenshotRefsIn(undefined)).toEqual([])
    expect(screenshotRefsIn(JSON.stringify({ sha: `sha256:${A}` }))).toEqual([])
    expect(screenshotRefsIn(JSON.stringify({ stored: `sha256:${'A'.repeat(64)}` }))).toEqual([])
  })

  it('stops at the bound', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({ stored: `sha256:${String(i).repeat(64)}` })
    ).join()
    expect(screenshotRefsIn(many, 3)).toHaveLength(3)
  })
})
