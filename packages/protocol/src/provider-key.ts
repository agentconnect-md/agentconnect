import { z } from 'zod'

export const ProviderKeyProvider = z.enum(['typesafe'])
export type ProviderKeyProvider = z.infer<typeof ProviderKeyProvider>

// This is storage metadata, not evidence that a credential has been validated upstream.
export const ProviderKeyStatus = z.object({
  provider: ProviderKeyProvider,
  name: z.string(),
  configured: z.boolean(),
  updatedAt: z.iso.datetime().nullable()
})
export type ProviderKeyStatus = z.infer<typeof ProviderKeyStatus>

export const SetProviderKeyBody = z
  .object({
    apiKey: z.string().trim().min(1).max(8192).regex(/^\S+$/, 'API key must not contain whitespace')
  })
  .strict()
