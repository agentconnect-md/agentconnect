import { describe, expect, it } from 'vitest'
import { resolveOrgTarget, switchOrgPath } from './org-context'
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

describe('switchOrgPath', () => {
  it('sends a detail view home — its id belongs to the org being left', () => {
    for (const path of [
      '/acme/sessions/s_123',
      '/acme/agents/a_123',
      '/acme/crons/c_123',
      '/acme/daemons/d_123',
      '/acme/daemons/groups/g_123',
      '/acme/conversations/slack:C123'
    ])
      expect(switchOrgPath(path, 'acme')).toBe('/home')
  })

  it('keeps an org-level page, so a switch stays where the user was working', () => {
    expect(switchOrgPath('/acme/sessions', 'acme')).toBe('/sessions')
    expect(switchOrgPath('/acme/billing', 'acme')).toBe('/billing')
    expect(switchOrgPath('/acme/settings', 'acme')).toBe('/settings')
    expect(switchOrgPath('/acme', 'acme')).toBe('/home')
  })

  it('keeps a deep path built from static segments only', () => {
    expect(switchOrgPath('/acme/daemons/cluster', 'acme')).toBe('/daemons/cluster')
  })

  it('handles the bare path of the first-visit rewrite window', () => {
    // `subPath` leaves a path that does not start with the slug alone; the depth rule still
    // has to read it, or a bare detail URL would carry its id across the switch.
    expect(switchOrgPath('/sessions/s_123', 'acme')).toBe('/home')
    expect(switchOrgPath('/', 'acme')).toBe('/home')
  })
})
