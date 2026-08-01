import { describe, expect, it } from 'vitest'
import { resolveOrgTarget } from './org-context'
import type { OrgDto } from './api'

const org = (id: string, slug: string) => ({ id, slug }) as OrgDto

describe('resolveOrgTarget', () => {
  const remembered = org('remembered', 'remembered')
  const rewrittenDefault = org('default', '-')

  it('restores the server-ordered preference for a bare entry rewrite', () => {
    expect(resolveOrgTarget([remembered, rewrittenDefault], rewrittenDefault, '-', false)).toBe(remembered)
  })

  it('keeps an explicit organization URL even when another org was remembered', () => {
    expect(resolveOrgTarget([remembered, rewrittenDefault], rewrittenDefault, 'remembered', true)).toBe(
      rewrittenDefault
    )
  })
})
