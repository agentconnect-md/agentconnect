// An organization's managed desktop egress (computer-use.md §15.4): what it stores and what the console may change.
import { z } from 'zod'
import { ComputerEgressProxyUrl } from '@agentconnect.md/protocol'

/** What an organization stores about its egress; the password lives apart, sealed. */
export const StoredEgress = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('deployment') }),
  z.object({ mode: z.literal('proxy'), url: ComputerEgressProxyUrl, username: z.string().min(1).max(256).optional() })
])
export type StoredEgress = z.infer<typeof StoredEgress>

/** A console change: the deployment's egress, or a proxy whose password is kept when omitted and cleared when null. */
export const ComputerEgressUpdate = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('deployment') }).strict(),
  z
    .object({
      mode: z.literal('proxy'),
      url: ComputerEgressProxyUrl,
      username: z.string().trim().min(1).max(256).nullable().optional(),
      password: z.string().min(1).max(512).nullable().optional()
    })
    .strict()
])
export type ComputerEgressUpdate = z.infer<typeof ComputerEgressUpdate>
