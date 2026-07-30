import { z } from 'zod'

export const WebchatMcpDelegationReference = z
  .object({
    id: z.string().uuid(),
    generation: z.number().int().positive(),
    expiresAt: z.string().datetime()
  })
  .strict()
export type WebchatMcpDelegationReference = z.infer<typeof WebchatMcpDelegationReference>

export const McpInvocationMint = z
  .object({
    delegationId: z.string().uuid(),
    generation: z.number().int().positive(),
    agentId: z.string().uuid(),
    conversationId: z.string().uuid(),
    invocationId: z.string().uuid(),
    requestHash: z.string().regex(/^[0-9a-f]{64}$/),
    method: z.enum(['tools/list', 'tools/call']),
    toolName: z.string().min(1).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.method === 'tools/call' && !value.toolName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toolName'],
        message: 'toolName is required for tools/call'
      })
    }
    if (value.method === 'tools/list' && value.toolName !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toolName'],
        message: 'toolName is not valid for tools/list'
      })
    }
  })
export type McpInvocationMint = z.infer<typeof McpInvocationMint>

export const McpInvocationMinted = z
  .object({
    invocationId: z.string().uuid(),
    assertion: z.string().min(1),
    expiresAt: z.string().datetime()
  })
  .strict()
export type McpInvocationMinted = z.infer<typeof McpInvocationMinted>

export const WebchatMcpDelegationRevoke = z
  .object({
    delegationId: z.string().uuid(),
    generation: z.number().int().positive(),
    reason: z.enum(['session_closed', 'session_expired', 'agent_detached'])
  })
  .strict()
export type WebchatMcpDelegationRevoke = z.infer<typeof WebchatMcpDelegationRevoke>

export const WebchatMcpDelegationRevoked = z
  .object({
    delegationId: z.string().uuid(),
    generation: z.number().int().positive(),
    revoked: z.boolean()
  })
  .strict()
export type WebchatMcpDelegationRevoked = z.infer<typeof WebchatMcpDelegationRevoked>
