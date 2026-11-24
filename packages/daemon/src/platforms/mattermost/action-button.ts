// Mattermost interactive attachment builder (`props.attachments[].actions`) with signed Relay callback tokens.
import { signMattermostActionToken, type MattermostActionClaims } from '@agentconnect.md/protocol'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** How long a signed Mattermost button callback remains valid (7 days, matching card retention). */
export const MATTERMOST_ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Runtime Relay callback coordinates + HMAC secret held on the daemon for interactive buttons. */
export interface MattermostActionCallbackConfig {
  readonly url: string
  readonly secret: string
  readonly daemonId: string
  readonly orgId?: string
}

export interface MattermostAttachmentButtonSpec {
  /** Must be strictly alphanumeric (`^[a-zA-Z0-9]+$`); Mattermost rejects non-alphanumeric IDs. */
  readonly id: string
  readonly name: string
  readonly style?: 'good' | 'warning' | 'danger' | 'default' | 'primary'
  readonly claims: Omit<MattermostActionClaims, 'v' | 'daemonId' | 'exp'>
}

export interface MattermostAttachmentInput {
  readonly color?: string
  readonly fallback?: string
  readonly text: string
  readonly actions?: readonly MattermostAttachmentAction[]
}

export interface MattermostAttachmentAction {
  readonly id: string
  readonly name: string
  readonly type: 'button'
  readonly style?: 'good' | 'warning' | 'danger' | 'default' | 'primary'
  readonly integration: {
    readonly url: string
    readonly context: {
      readonly token: string
    }
  }
}

export interface MattermostAttachment {
  readonly color?: string
  readonly fallback?: string
  readonly text: string
  readonly actions?: readonly MattermostAttachmentAction[]
}

const ALPHANUMERIC_RE = /^[a-zA-Z0-9]+$/

/** Build signed Mattermost interactive actions; returns undefined if callback config or UUID identities are absent. */
export function buildMattermostAttachmentActions(
  callback: MattermostActionCallbackConfig | undefined,
  specs: readonly MattermostAttachmentButtonSpec[],
  nowMs = Date.now()
): MattermostAttachmentAction[] | undefined {
  if (!callback || !callback.url || !callback.secret || !UUID_RE.test(callback.daemonId)) {
    return undefined
  }
  const actions: MattermostAttachmentAction[] = []
  const exp = nowMs + MATTERMOST_ACTION_TTL_MS
  for (const spec of specs) {
    if (!UUID_RE.test(spec.claims.agentId) || !UUID_RE.test(spec.claims.integrationId)) {
      return undefined
    }
    const cleanId = ALPHANUMERIC_RE.test(spec.id)
      ? spec.id
      : spec.id.replace(/[^a-zA-Z0-9]/g, '') || `btn${actions.length}`
    const token = signMattermostActionToken(
      {
        v: 1,
        ...(callback.orgId ? { orgId: callback.orgId } : {}),
        daemonId: callback.daemonId,
        ...spec.claims,
        exp
      },
      callback.secret
    )
    actions.push({
      id: cleanId,
      name: spec.name,
      type: 'button',
      ...(spec.style ? { style: spec.style } : {}),
      integration: {
        url: callback.url,
        context: { token }
      }
    })
  }
  return actions
}

export function mattermostAttachmentProps(attachment: MattermostAttachment): { attachments: [MattermostAttachment] } {
  return { attachments: [attachment] }
}
