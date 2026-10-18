import { z } from 'zod'
import { ChatCallerRole } from './frames/agent.js'

export const AHP_GRANT_MAX_AGE_MS = 60_000
export const AHP_MAX_MESSAGE_BYTES = 64 * 1024
export const AHP_WEBSOCKET_PROTOCOL = 'ahp'
export const AHP_WEBCHAT_TOKEN_PREFIX = 'agentconnect.ahp-token.'

export const AhpMode = z.enum(['off', 'shadow', 'on'])
export type AhpMode = z.infer<typeof AhpMode>
export const AhpFeatureConfig = z
  .object({
    ahp: z.object({ mode: AhpMode.default('off') }).default({ mode: 'off' }),
    webchat: z.object({ protocol: z.enum(['legacy', 'ahp']).default('legacy') }).default({ protocol: 'legacy' })
  })
  .refine((config) => config.webchat.protocol !== 'ahp' || config.ahp.mode === 'on', {
    path: ['webchat', 'protocol'],
    message: 'AHP Webchat requires AHP mode on'
  })
export type AhpFeatureConfig = z.infer<typeof AhpFeatureConfig>

// Credential verification grants are CP signed, short lived, and never public client identifiers.
export const AhpGrant = z.strictObject({
  token: z.string().min(1).max(8192),
  expiresAtMs: z.number().int().positive()
})
export type AhpGrant = z.infer<typeof AhpGrant>

// Only the trusted relay supplies this context; client JSON-RPC cannot replace any field.
export const AhpAttachmentAuthorization = z.strictObject({
  orgId: z.string().min(1).max(64),
  agentId: z.string().uuid(),
  userId: z.string().min(1).max(256),
  user: z.string().min(1).max(256),
  callerRole: ChatCallerRole,
  callerApproves: z.boolean(),
  conversationId: z.string().uuid().optional(),
  targetSessionId: z.string().min(1).max(256).optional(),
  grant: AhpGrant
})
export type AhpAttachmentAuthorization = z.infer<typeof AhpAttachmentAuthorization>

const attachment = { attachmentId: z.string().uuid() }
export const RdAhpOpen = z.strictObject({ ...attachment, authorization: AhpAttachmentAuthorization })
export type RdAhpOpen = z.infer<typeof RdAhpOpen>
export const RdAhpOpened = z.strictObject({ ...attachment, accepted: z.boolean() })
export type RdAhpOpened = z.infer<typeof RdAhpOpened>
export const RdAhpAuthorize = RdAhpOpen
export type RdAhpAuthorize = RdAhpOpen
export const RdAhpAuthorized = RdAhpOpened
export type RdAhpAuthorized = RdAhpOpened

// Opaque JSON-RPC text; encoded size also leaves room in the bounded rd envelope.
export const AhpMessageText = z
  .string()
  .min(1)
  .max(AHP_MAX_MESSAGE_BYTES)
  .refine((message) => new TextEncoder().encode(message).length <= AHP_MAX_MESSAGE_BYTES)
  .refine((message) => new TextEncoder().encode(JSON.stringify(message)).length <= 2 * AHP_MAX_MESSAGE_BYTES)
export const RdAhpMessage = z.strictObject({ ...attachment, message: AhpMessageText })
export type RdAhpMessage = z.infer<typeof RdAhpMessage>
export const RdAhpClose = z.strictObject({
  ...attachment,
  reason: z.enum(['client_closed', 'unauthorized', 'unavailable', 'overloaded', 'invalid_message'])
})
export type RdAhpClose = z.infer<typeof RdAhpClose>

// A canonical subset: reject encoded aliases, empty/dot segments, authority, queries, and fragments.
export const AhpSessionUri = z
  .string()
  .max(512)
  .regex(/^ahp-session:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)*$/)
export type AhpSessionUri = z.infer<typeof AhpSessionUri>

const registryScope = {
  orgId: z.string().min(1).max(64),
  agentId: z.string().uuid(),
  grant: z.string().min(1).max(8192)
}
const duty = z.strictObject({ groupId: z.string().uuid(), term: z.string().regex(/^[1-9][0-9]*$/) }).optional()
export const AhpSessionReserve = z.strictObject({
  ...registryScope,
  sessionUri: AhpSessionUri,
  operationId: z.string().uuid(),
  duty
})
export type AhpSessionReserve = z.infer<typeof AhpSessionReserve>
export const AhpSessionFinalize = z.strictObject({
  ...registryScope,
  reservationId: z.string().uuid(),
  sessionId: z.string().min(1).max(256),
  duty
})
export type AhpSessionFinalize = z.infer<typeof AhpSessionFinalize>
export const AhpSessionResolve = z.strictObject({ ...registryScope, sessionUri: AhpSessionUri })
export type AhpSessionResolve = z.infer<typeof AhpSessionResolve>
export const AhpSessionList = z.strictObject({
  ...registryScope,
  cursor: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).default(50)
})
export type AhpSessionList = z.infer<typeof AhpSessionList>
export const AhpSessionBinding = z.strictObject({
  reservationId: z.string().uuid(),
  conversationId: z.string().uuid(),
  sessionUri: AhpSessionUri,
  sessionId: z.string().min(1).max(256).optional(),
  callerRole: ChatCallerRole.optional()
})
export type AhpSessionBinding = z.infer<typeof AhpSessionBinding>
const RegistryRefusal = z.strictObject({
  ok: z.literal(false),
  reason: z.enum(['forbidden', 'collision', 'unavailable', 'not_found', 'stale_owner'])
})
export const AhpSessionResult = z.discriminatedUnion('ok', [
  AhpSessionBinding.extend({ ok: z.literal(true) }),
  RegistryRefusal
])
export type AhpSessionResult = z.infer<typeof AhpSessionResult>
export const AhpSessionListResult = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    sessions: z.array(AhpSessionBinding).max(100),
    cursor: z.string().uuid().optional()
  }),
  RegistryRefusal
])
export type AhpSessionListResult = z.infer<typeof AhpSessionListResult>
