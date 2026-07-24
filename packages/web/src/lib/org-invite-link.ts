import type { OrgInviteLinkDto } from '@/lib/api'

/** Treat a just-expired active response as expired without waiting for SWR refresh. */
export function inviteLinkStatus(
  link: Pick<OrgInviteLinkDto, 'status' | 'expiresAt'>,
  nowMs = Date.now()
): OrgInviteLinkDto['status'] {
  return link.status === 'active' && new Date(link.expiresAt).getTime() <= nowMs ? 'expired' : link.status
}

export function inviteLinkUrl(token: string, origin: string): string {
  return `${origin.replace(/\/+$/, '')}/join/${encodeURIComponent(token)}`
}
