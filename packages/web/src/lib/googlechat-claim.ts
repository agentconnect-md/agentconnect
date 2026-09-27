// The Google Chat claim link's state, read for display only; the Control Plane re-derives every fact (google-chat-integration.md §10.5).

export interface GoogleChatClaimState {
  /** The Chat app's project number. */
  app: string
  /** `spaces/…` */
  space: string
  /** `users/…`, the Chat user who asked. */
  user: string
  kind: 'dm' | 'space'
  /** Where Chat continues once the claim is done; absent when the prompt carried none, as the welcome card's click does. */
  redirect?: string
}

/** Chat's completion URL is always on Chat's own origin; the page never follows anything else. */
export function isGoogleChatRedirect(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (
    url.protocol === 'https:' && url.hostname === 'chat.google.com' && url.port === '' && !url.username && !url.password
  )
}

const text = (value: unknown, pattern: RegExp): string | null =>
  typeof value === 'string' && pattern.test(value) ? value : null

/** Decode the base64url JSON state; null for anything the page should not show. */
export function decodeGoogleChatClaimState(raw: string | null): GoogleChatClaimState | null {
  if (!raw || raw.length > 4_096 || !/^[A-Za-z0-9_-]+={0,2}$/.test(raw)) return null
  let parsed: unknown
  try {
    const base64 = raw.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const fields = parsed as Record<string, unknown>
  const app = text(fields.app, /^[1-9]\d{0,19}$/)
  const space = text(fields.space, /^spaces\/[A-Za-z0-9_-]{1,128}$/)
  const user = text(fields.user, /^users\/\d{1,64}$/)
  const kind = fields.kind === 'dm' || fields.kind === 'space' ? fields.kind : null
  const redirect = fields.redirect
  // A missing completion URL is fine; a present one off Chat's origin makes the whole link invalid.
  if (redirect !== undefined && !(typeof redirect === 'string' && isGoogleChatRedirect(redirect))) return null
  if (fields.v !== 1 || !app || !space || !user || !kind) return null
  return { app, space, user, kind, ...(redirect ? { redirect } : {}) }
}

/** Where the person goes back to Chat when no completion URL came along: the Space's room or the DM. */
export function googleChatConversationUrl(state: Pick<GoogleChatClaimState, 'kind' | 'space'>): string {
  const id = encodeURIComponent(state.space.slice('spaces/'.length))
  return `https://chat.google.com/${state.kind === 'dm' ? 'dm' : 'room'}/${id}`
}

export type GoogleChatClaimErrorKey =
  | 'invalidLink'
  | 'appUnknown'
  | 'identity'
  | 'external'
  | 'workspaceRequired'
  | 'conversation'
  | 'taken'
  | 'noAgent'
  | 'unavailable'
  | 'noPermission'
  | 'tryAgain'
  | 'generic'

const BY_CODE: Record<string, GoogleChatClaimErrorKey> = {
  GOOGLE_CHAT_CLAIM_STATE_INVALID: 'invalidLink',
  GOOGLE_CHAT_CLAIM_APP_UNKNOWN: 'appUnknown',
  GOOGLE_CHAT_CLAIM_IDENTITY: 'identity',
  GOOGLE_CHAT_CLAIM_EXTERNAL: 'external',
  GOOGLE_CHAT_CLAIM_WORKSPACE_REQUIRED: 'workspaceRequired',
  GOOGLE_CHAT_CLAIM_CONVERSATION: 'conversation',
  GOOGLE_CHAT_CLAIM_TAKEN: 'taken',
  GOOGLE_CHAT_CLAIM_NO_AGENT: 'noAgent',
  GOOGLE_CHAT_CLAIM_UNAVAILABLE: 'unavailable'
}

/** The sentence a claim refusal maps to: its code first, then its status. */
export function googleChatClaimErrorKey(code: string | undefined, status: number): GoogleChatClaimErrorKey {
  const known = code ? BY_CODE[code] : undefined
  if (known) return known
  if (status >= 500) return 'tryAgain'
  if (status === 403) return 'noPermission'
  return 'generic'
}
