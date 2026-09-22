import { z } from 'zod'
import { ProviderEndpoint, ProviderKeyProvider } from '../provider-key.js'

export const PROVIDER_CREDENTIALS_V1_FEATURE = 'provider-credentials-v1'

export const ProviderCredentialsRequest = z.object({
  agentId: z.string().uuid(),
  provider: ProviderKeyProvider
})
export type ProviderCredentialsRequest = z.infer<typeof ProviderCredentialsRequest>

// Credential material travels only to an authorized daemon; never log or persist the reply there.
export const ProviderCredential = z.object({
  apiKey: z.string().min(1),
  endpoint: ProviderEndpoint.nullable(),
  headers: z.record(z.string(), z.string())
})
export type ProviderCredential = z.infer<typeof ProviderCredential>

// Only confirmed absence is null; authorization and storage failures use correlated errors.
export const ProviderCredentialsReply = z.object({ credentials: ProviderCredential.nullable() })
export type ProviderCredentialsReply = z.infer<typeof ProviderCredentialsReply>

// Organization-scoped invalidation contains no credential material.
export const ProviderCredentialsChanged = z.object({ provider: ProviderKeyProvider })
