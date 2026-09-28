// The relay's check of an API key on the agent chat API (shared-bot-relay.md §10.4): the HTTP key checks, then the caller's chat id resolved to its conversation.
import { createHash } from 'node:crypto'
import { AGENT_CHAT_KEY_REFUSAL, type RcVerifyResult } from '@agentconnect.md/protocol'
import { canView } from '../authorization/policy.js'
import { isAgentLevelPermission, keyAdmitted, selectionCovers } from '../domain/api-key-permission.js'
import { AgentId, OrgId, type SessionId } from '../domain/ids.js'
import type { IconStore } from '../icons/icon-store.js'
import { resolveProfilePictureUrl } from '../icons/icon-store.js'
import type { ResolvableAgent } from '../orchestrator/placementResolver.js'
import type { UserKeyPrincipal } from '../ports.js'
import type {
  OrgMemberRole,
  Shareable,
  UserProfileRecord,
  WebchatConversationBinding,
  WebchatResumeBinding
} from '../persistence/ports.js'
import { webchatBinding, type WebchatVerificationDeps } from './webchatVerification.js'

export interface AgentChatKeyVerificationDeps extends Omit<
  WebchatVerificationDeps,
  'tokens' | 'agents' | 'conversations'
> {
  keys: { authenticateUser(token: string): Promise<UserKeyPrincipal | null> }
  agents: { getUnscoped(agentId: AgentId): Promise<(ResolvableAgent & Shareable & { orgId: string }) | null> }
  conversations: WebchatVerificationDeps['conversations'] & {
    resumeBinding(conversationId: string, orgId: OrgId): Promise<WebchatResumeBinding | null>
    ensure(binding: WebchatConversationBinding, apiKeyId: string): Promise<void>
  }
  users: { getProfile(userId: string): Promise<UserProfileRecord | null> }
  iconStore?: IconStore
  reachesContent(orgId: OrgId, currentSessionIds: Array<SessionId | null>): Promise<boolean>
}

export interface AgentChatKeyRequest {
  credential: string
  agentId: string
  chatId: string
}

// Fixed forever: every agent chat conversation id is derived under it.
const AGENT_CHAT_NAMESPACE = Buffer.from('8a3f6c1e2d4b4e7f9c05b1a2d3e4f506', 'hex')

/** The conversation a key's chat id names: a UUIDv5 over org, key owner, agent and chat id, so another member's same chat id is another conversation. */
export function agentChatConversationId(orgId: string, userId: string, agentId: string, chatId: string): string {
  const hash = createHash('sha1')
    .update(AGENT_CHAT_NAMESPACE)
    .update([orgId, userId, agentId, chatId].join('\0'))
    .digest()
  hash[6] = (hash[6]! & 0x0f) | 0x50
  hash[8] = (hash[8]! & 0x3f) | 0x80
  const hex = hash.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The identity a webchat turn is authored under: the profile's name over the sign-in address, and a fetchable avatar. */
export async function webchatAuthorIdentity(
  deps: Pick<AgentChatKeyVerificationDeps, 'users' | 'iconStore'>,
  userId: string,
  email?: string
): Promise<{ user: string; userPicture?: string }> {
  const profile = await deps.users.getProfile(userId)
  const picture = profile
    ? resolveProfilePictureUrl(userId, profile.picture, profile.profilePictureUpdatedAt, deps.iconStore)
    : null
  // Only a fetchable https URL is worth carrying — the wire schema rejects anything else.
  const userPicture = picture && picture.length <= 2_048 && /^https:\/\//.test(picture) ? picture : undefined
  return { user: profile?.displayName?.trim() || email || userId, ...(userPicture ? { userPicture } : {}) }
}

const refuse = (reason: string): RcVerifyResult => ({ ok: false, reason })

export function createAgentChatKeyVerifier(
  deps: AgentChatKeyVerificationDeps
): (req: AgentChatKeyRequest) => Promise<RcVerifyResult> {
  const resolve = webchatBinding(deps)
  return async ({ credential, agentId, chatId }) => {
    const key = await deps.keys.authenticateUser(credential)
    if (!key) return refuse(AGENT_CHAT_KEY_REFUSAL.invalidKey)
    // Admitted as an HTTP route declaring `agent:chat` would admit it; a read-only OAuth token sends no turns.
    const readOnly = key.scopes.length > 0 && !key.scopes.includes('mcp:write')
    if (!keyAdmitted(key.permission, 'POST', 'agent:chat') || readOnly)
      return refuse(AGENT_CHAT_KEY_REFUSAL.notPermitted)
    if (isAgentLevelPermission(key.permission) && !selectionCovers(key.selection, agentId)) {
      return refuse(AGENT_CHAT_KEY_REFUSAL.agentNotFound)
    }
    const role = (await deps.orgs.roleOf(key.orgId, key.userId)) as OrgMemberRole | null
    const agent = await deps.agents.getUnscoped(AgentId(agentId))
    if (!role || !agent || agent.orgId !== key.orgId) return refuse(AGENT_CHAT_KEY_REFUSAL.agentNotFound)
    const ctx = { userId: key.userId, role }
    if (!canView(agent, ctx)) return refuse(AGENT_CHAT_KEY_REFUSAL.agentNotFound)

    const orgId = OrgId(key.orgId)
    const conversationId = agentChatConversationId(key.orgId, key.userId, agent.id, chatId)
    const existing = await deps.conversations.resumeBinding(conversationId, orgId)
    if (!existing) {
      await deps.conversations.ensure(
        { conversationId, userId: key.userId, agentId: AgentId(agent.id), orgId },
        key.apiKeyId
      )
    } else {
      // The id folds in owner and agent, so a mismatch is a collision; a member added since must still be visible.
      if (existing.ownerUserId !== key.userId || existing.primaryAgentId !== agent.id) {
        return refuse(AGENT_CHAT_KEY_REFUSAL.agentNotFound)
      }
      for (const p of await deps.conversations.participants(orgId, conversationId)) {
        const member = p.agentId === agent.id ? agent : await deps.agents.getUnscoped(p.agentId)
        if (!member || member.orgId !== key.orgId || !canView(member, ctx)) {
          return refuse(AGENT_CHAT_KEY_REFUSAL.agentNotFound)
        }
      }
      if (!(await deps.reachesContent(orgId, existing.currentSessionIds)))
        return refuse(AGENT_CHAT_KEY_REFUSAL.agentMoved)
    }

    const verdict = await resolve(
      {
        userId: key.userId,
        ...(await webchatAuthorIdentity(deps, key.userId)),
        agentId: agent.id,
        orgId: key.orgId,
        conversationId
      },
      { remoteMcp: false }
    )
    if (!verdict.ok && (verdict.reason === 'agent unplaced' || verdict.reason === 'daemon offline')) {
      return refuse(AGENT_CHAT_KEY_REFUSAL.agentUnavailable)
    }
    return verdict
  }
}
