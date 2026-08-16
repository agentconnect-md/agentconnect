// Which daemon↔CP frames carry an organization (k8s-daemon-pool.md M4, daemon-cp-ws-protocol.md §1.1).
import type { FrameType } from './frame.js'

// Frames about the member or the whole install: they name no organization, and on an install-wide
// connection they must not carry one. Duty groups span orgs on one member (grants carry a per-entry
// org); the reconciler's existence query spans every org. Everything else is org-scoped.
export const INSTALL_WIDE_FRAME_TYPES: ReadonlySet<FrameType> = new Set<FrameType>([
  'auth',
  'auth/ok',
  'register',
  'register/ok',
  'daemon/bootstrap/result',
  'capabilities/update',
  'heartbeat',
  'facts/runtime-profile',
  'facts/daemon-runtimes',
  'facts/memory-connections',
  'relay/roster',
  'collaboration/routes',
  'daemon/drain',
  'drain/progress',
  'drain/done',
  'daemon/restart',
  'daemon/upgrade',
  'daemon/control/ack',
  'config/push',
  'duty/grant',
  'duty/renewed',
  'duty/revoke',
  'duty/release',
  'duty/claim',
  'duty/claim/ok',
  'agent/exists',
  'agent/exists/ok'
])

// Generic replies inherit their request's scope; one that correlates to nothing names nothing and is dropped.
export const GENERIC_REPLY_FRAME_TYPES: ReadonlySet<FrameType> = new Set<FrameType>(['ack', 'error'])

export function isInstallWideFrameType(type: string): boolean {
  return INSTALL_WIDE_FRAME_TYPES.has(type as FrameType)
}

/** `connection`: one org bound at auth (API key). `frame`: an install-wide member, every org-scoped frame names its org. */
export type OrganizationMode = 'connection' | 'frame'

/** The receiving end of a connection: its mode and, on a `connection`-mode peer that knows it, the bound org. */
export interface FrameOrgPeer {
  mode: OrganizationMode
  orgId: string | null
}

export interface FrameOrgRef {
  type: string
  orgId?: string | undefined
}

export type FrameOrgVerdict = { ok: true } | { ok: false; message: string }

const OK: FrameOrgVerdict = { ok: true }

/**
 * The connection-layer org gate for an uncorrelated inbound frame. Frame mode: an org-scoped frame
 * must name its org, an install-wide frame must not. Connection mode: an org named must be the
 * connection's. Whether the org owns the targeted resource is the receiver's check, after this one.
 */
export function checkInboundFrameOrg(frame: FrameOrgRef, peer: FrameOrgPeer): FrameOrgVerdict {
  if (GENERIC_REPLY_FRAME_TYPES.has(frame.type as FrameType)) return OK
  if (peer.mode === 'connection') {
    if (frame.orgId && peer.orgId && frame.orgId !== peer.orgId) {
      return { ok: false, message: 'organization does not match authenticated connection' }
    }
    return OK
  }
  if (isInstallWideFrameType(frame.type)) {
    return frame.orgId ? { ok: false, message: `${frame.type} is install-wide and must not carry an organization` } : OK
  }
  return frame.orgId ? OK : { ok: false, message: 'organization is required on an install-wide connection' }
}

/**
 * The org gate for a correlated reply, checked against the request it settles. Frame mode: a typed
 * reply carries exactly the request's org (none for an install-wide request). Connection mode: an
 * org present must match the request's and the connection's. An `error` reply names no resource,
 * so it may omit the org, but one it carries must still be the request's.
 */
export function checkReplyFrameOrg(request: FrameOrgRef, reply: FrameOrgRef, peer: FrameOrgPeer): FrameOrgVerdict {
  if (reply.type === 'error') {
    if (reply.orgId && request.orgId && reply.orgId !== request.orgId) {
      return { ok: false, message: `error reply to ${request.type} names another organization` }
    }
    return OK
  }
  if (peer.mode === 'frame') {
    if (request.orgId) {
      if (reply.orgId === request.orgId) return OK
      return { ok: false, message: `${reply.type} does not carry the organization of the ${request.type} it answers` }
    }
    if (reply.orgId) {
      return { ok: false, message: `${reply.type} answers install-wide ${request.type} but names an organization` }
    }
    return OK
  }
  if (reply.orgId && ((request.orgId && reply.orgId !== request.orgId) || (peer.orgId && reply.orgId !== peer.orgId))) {
    return { ok: false, message: `${reply.type} names another organization than the ${request.type} it answers` }
  }
  return OK
}
