import { z } from 'zod'

/** Non-secret entitlement carried CP → relay → daemon after webchat verification. */
export const WebchatRemoteMcpEntitlement = z
  .object({
    authorityId: z.string().uuid(),
    authorityGeneration: z.number().int().positive(),
    expiresAt: z.string().datetime()
  })
  .strict()
export type WebchatRemoteMcpEntitlement = z.infer<typeof WebchatRemoteMcpEntitlement>

const DescriptorFence = z
  .object({
    authorityId: z.string().uuid(),
    authorityGeneration: z.number().int().positive(),
    conversationId: z.string().uuid(),
    descriptorInstanceId: z.string().uuid(),
    grantRevision: z.number().int().positive()
  })
  .strict()

export const WebchatMcpGrantIssue = z
  .object({
    authorityId: z.string().uuid(),
    authorityGeneration: z.number().int().positive(),
    conversationId: z.string().uuid(),
    descriptorInstanceId: z.string().uuid()
  })
  .strict()
export type WebchatMcpGrantIssue = z.infer<typeof WebchatMcpGrantIssue>

export const WebchatMcpGrantIssued = DescriptorFence.extend({
  grantId: z.string().uuid(),
  token: z.string().min(32),
  expiresAt: z.string().datetime(),
  mcpUrl: z.string().url()
}).strict()
export type WebchatMcpGrantIssued = z.infer<typeof WebchatMcpGrantIssued>

export const WebchatMcpGrantAccept = DescriptorFence.extend({
  grantId: z.string().uuid()
}).strict()
export type WebchatMcpGrantAccept = z.infer<typeof WebchatMcpGrantAccept>

export const WebchatMcpGrantActivate = WebchatMcpGrantAccept.extend({
  activated: z.boolean()
}).strict()
export type WebchatMcpGrantActivate = z.infer<typeof WebchatMcpGrantActivate>

export const WebchatMcpGrantRevoke = z
  .object({
    authorityId: z.string().uuid(),
    authorityGeneration: z.number().int().positive(),
    conversationId: z.string().uuid(),
    reason: z.enum(['session_closed', 'session_expired', 'agent_detached', 'feature_disabled', 'security'])
  })
  .strict()
export type WebchatMcpGrantRevoke = z.infer<typeof WebchatMcpGrantRevoke>

export const WebchatMcpGrantRevoked = WebchatMcpGrantRevoke.pick({
  authorityId: true,
  authorityGeneration: true,
  conversationId: true
})
  .extend({ revoked: z.boolean() })
  .strict()
export type WebchatMcpGrantRevoked = z.infer<typeof WebchatMcpGrantRevoked>
