import { describe, expect, it } from 'vitest'
import { resolveOrgTarget, switchOrgTarget } from './org-context'
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

describe('switchOrgTarget', () => {
  const acme = org('acme-id', 'acme')
  const other = org('other-id', 'other')

  it('is a NO-OP for the org already active — both switchers make that row clickable', () => {
    // Not merely harmless: the detail-path rule below would otherwise throw away the page the
    // user is reading, on a click that switched nothing.
    expect(switchOrgTarget(acme, acme.id, '/acme/sessions/s_123', 'acme')).toBeNull()
    expect(switchOrgTarget(acme, acme.id, '/acme/billing', 'acme')).toBeNull()
  })

  it('sends a detail view home — its id belongs to the org being left', () => {
    for (const path of [
      '/acme/sessions/s_123',
      '/acme/agents/a_123',
      '/acme/crons/c_123',
      '/acme/daemons/d_123',
      '/acme/daemons/groups/g_123',
      '/acme/conversations/slack:C123'
    ])
      expect(switchOrgTarget(other, acme.id, path, 'acme')).toBe('/other/home')
  })

  it('keeps an org-level page, so a switch stays where the user was working', () => {
    expect(switchOrgTarget(other, acme.id, '/acme/sessions', 'acme')).toBe('/other/sessions')
    expect(switchOrgTarget(other, acme.id, '/acme/billing', 'acme')).toBe('/other/billing')
    expect(switchOrgTarget(other, acme.id, '/acme/settings', 'acme')).toBe('/other/settings')
    expect(switchOrgTarget(other, acme.id, '/acme', 'acme')).toBe('/other/home')
  })

  it('keeps a deep path built from static segments only', () => {
    expect(switchOrgTarget(other, acme.id, '/acme/daemons/cluster', 'acme')).toBe('/other/daemons/cluster')
  })

  it('handles the bare path of the first-visit rewrite window', () => {
    // `subPath` leaves a path that does not start with the slug alone; the depth rule still
    // has to read it, or a bare detail URL would carry its id across the switch.
    expect(switchOrgTarget(other, acme.id, '/sessions/s_123', 'acme')).toBe('/other/home')
    expect(switchOrgTarget(other, acme.id, '/', 'acme')).toBe('/other/home')
  })

  it('treats a brand-new org as a switch — nothing is active from its point of view', () => {
    expect(switchOrgTarget(other, undefined, '/acme/sessions/s_123', 'acme')).toBe('/other/home')
  })
})
