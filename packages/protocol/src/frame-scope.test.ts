import { describe, it, expect } from 'vitest'
import { FRAME_TYPES } from './frame.js'
import {
  INSTALL_WIDE_FRAME_TYPES,
  GENERIC_REPLY_FRAME_TYPES,
  checkInboundFrameOrg,
  checkReplyFrameOrg,
  isInstallWideFrameType
} from './frame-scope.js'

const FRAME = { mode: 'frame', orgId: null } as const
const CONN = { mode: 'connection', orgId: 'org-a' } as const

describe('frame-scope: which frames carry an organization', () => {
  it('classifies every wire frame type as install-wide, generic reply, or org-scoped', () => {
    for (const type of INSTALL_WIDE_FRAME_TYPES) expect(FRAME_TYPES).toContain(type)
    for (const type of GENERIC_REPLY_FRAME_TYPES) expect(FRAME_TYPES).toContain(type)
    const orgScoped = FRAME_TYPES.filter((t) => !isInstallWideFrameType(t) && !GENERIC_REPLY_FRAME_TYPES.has(t))
    // The org-scoped families the daemon and CP exchange today; a new type lands here unless listed above.
    for (const t of ['agent/upsert', 'duty/fetch', 'duty/fetch/ok', 'event/session', 'hook/report', 'session/list'])
      expect(orgScoped).toContain(t)
    for (const t of ['heartbeat', 'register/ok', 'duty/claim', 'agent/exists/ok', 'drain/done'])
      expect(isInstallWideFrameType(t)).toBe(true)
  })

  describe('inbound gate, frame mode', () => {
    it('requires the org on an org-scoped frame', () => {
      expect(checkInboundFrameOrg({ type: 'event/session' }, FRAME)).toMatchObject({ ok: false })
      expect(checkInboundFrameOrg({ type: 'event/session', orgId: 'org-a' }, FRAME)).toEqual({ ok: true })
    })
    it('forbids the org on an install-wide frame', () => {
      expect(checkInboundFrameOrg({ type: 'heartbeat', orgId: 'org-a' }, FRAME)).toMatchObject({ ok: false })
      expect(checkInboundFrameOrg({ type: 'heartbeat' }, FRAME)).toEqual({ ok: true })
    })
    it('lets an uncorrelated generic reply through to be dropped, never answered', () => {
      expect(checkInboundFrameOrg({ type: 'error' }, FRAME)).toEqual({ ok: true })
      expect(checkInboundFrameOrg({ type: 'ack', orgId: 'org-a' }, FRAME)).toEqual({ ok: true })
    })
  })

  describe('inbound gate, connection mode', () => {
    it('accepts a missing org and the connection org, refuses another', () => {
      expect(checkInboundFrameOrg({ type: 'event/session' }, CONN)).toEqual({ ok: true })
      expect(checkInboundFrameOrg({ type: 'event/session', orgId: 'org-a' }, CONN)).toEqual({ ok: true })
      expect(checkInboundFrameOrg({ type: 'heartbeat', orgId: 'org-a' }, CONN)).toEqual({ ok: true })
      expect(checkInboundFrameOrg({ type: 'event/session', orgId: 'org-b' }, CONN)).toMatchObject({ ok: false })
    })
    it('checks nothing when the peer does not know the bound org', () => {
      const peer = { mode: 'connection', orgId: null } as const
      expect(checkInboundFrameOrg({ type: 'agent/upsert', orgId: 'org-b' }, peer)).toEqual({ ok: true })
    })
  })

  describe('reply gate', () => {
    const req = { type: 'session/list', orgId: 'org-a' }
    it('frame mode: a typed reply carries exactly the request org', () => {
      expect(checkReplyFrameOrg(req, { type: 'session/list/page', orgId: 'org-a' }, FRAME)).toEqual({ ok: true })
      expect(checkReplyFrameOrg(req, { type: 'session/list/page' }, FRAME)).toMatchObject({ ok: false })
      expect(checkReplyFrameOrg(req, { type: 'session/list/page', orgId: 'org-b' }, FRAME)).toMatchObject({ ok: false })
      expect(checkReplyFrameOrg(req, { type: 'ack', orgId: 'org-a' }, FRAME)).toEqual({ ok: true })
      expect(checkReplyFrameOrg(req, { type: 'ack' }, FRAME)).toMatchObject({ ok: false })
    })
    it('frame mode: a reply to an install-wide request carries none', () => {
      const claim = { type: 'duty/claim' }
      expect(checkReplyFrameOrg(claim, { type: 'duty/claim/ok' }, FRAME)).toEqual({ ok: true })
      expect(checkReplyFrameOrg(claim, { type: 'duty/claim/ok', orgId: 'org-a' }, FRAME)).toMatchObject({ ok: false })
    })
    it('an error reply may omit the org but must not name another', () => {
      expect(checkReplyFrameOrg(req, { type: 'error' }, FRAME)).toEqual({ ok: true })
      expect(checkReplyFrameOrg(req, { type: 'error', orgId: 'org-a' }, FRAME)).toEqual({ ok: true })
      expect(checkReplyFrameOrg(req, { type: 'error', orgId: 'org-b' }, FRAME)).toMatchObject({ ok: false })
      expect(checkReplyFrameOrg(req, { type: 'error', orgId: 'org-b' }, CONN)).toMatchObject({ ok: false })
    })
    it('connection mode: an org present must be the request org and the connection org; absent is fine', () => {
      expect(checkReplyFrameOrg(req, { type: 'session/list/page' }, CONN)).toEqual({ ok: true })
      expect(checkReplyFrameOrg(req, { type: 'session/list/page', orgId: 'org-a' }, CONN)).toEqual({ ok: true })
      expect(checkReplyFrameOrg(req, { type: 'session/list/page', orgId: 'org-b' }, CONN)).toMatchObject({ ok: false })
      expect(
        checkReplyFrameOrg({ type: 'session/list' }, { type: 'session/list/page', orgId: 'org-b' }, CONN)
      ).toMatchObject({ ok: false })
    })
  })
})
