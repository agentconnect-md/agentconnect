import { z } from 'zod'

export const ProviderKeyProvider = z.enum(['typesafe', 'openrouter', 'cloudflare'])
export type ProviderKeyProvider = z.infer<typeof ProviderKeyProvider>

export const PROVIDER_KEY_PROFILES: Record<
  ProviderKeyProvider,
  { name: string; defaultEndpoint: string | null; endpointRequired: boolean }
> = {
  typesafe: { name: 'TypeSafe (Jev)', defaultEndpoint: 'https://api.typesafe.ai', endpointRequired: false },
  openrouter: { name: 'OpenRouter', defaultEndpoint: 'https://openrouter.ai/api/v1', endpointRequired: false },
  cloudflare: { name: 'Cloudflare AI Gateway', defaultEndpoint: null, endpointRequired: true }
}

export const ProviderEndpoint = z
  .url()
  .max(2048)
  .refine((value) => {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
  }, 'Endpoint must be HTTP(S) without credentials, query parameters, or a fragment')
const HeaderName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/)
const HeaderPatch = z
  .record(
    HeaderName,
    z
      .string()
      .min(1)
      .max(8192)
      .regex(/^[\t\x20-\x7e]+$/)
      .nullable()
  )
  .refine((headers) => Object.keys(headers).length <= 32, 'Too many headers')
  .refine(
    (headers) => new Set(Object.keys(headers).map((name) => name.toLowerCase())).size === Object.keys(headers).length,
    'Header names must be unique ignoring case'
  )
  .transform((headers) =>
    Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))
  )

// This is storage metadata, not evidence that a credential has been validated upstream.
export const ProviderKeyStatus = z.object({
  provider: ProviderKeyProvider,
  name: z.string(),
  defaultEndpoint: z.string().nullable(),
  endpointRequired: z.boolean(),
  endpoint: z.string().nullable(),
  headerNames: z.array(z.string()),
  configured: z.boolean(),
  updatedAt: z.iso.datetime().nullable()
})
export type ProviderKeyStatus = z.infer<typeof ProviderKeyStatus>

export const SetProviderKeyBody = z
  .object({
    apiKey: z.string().trim().min(1).max(8192).regex(/^\S+$/, 'API key must not contain whitespace').optional(),
    endpoint: ProviderEndpoint.nullable().optional(),
    headers: HeaderPatch.optional()
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'At least one configuration field is required')
export type SetProviderKeyInput = z.infer<typeof SetProviderKeyBody>
