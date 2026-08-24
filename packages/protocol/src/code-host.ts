import { z } from 'zod'

/**
 * Code-host provider identity (gitlab-com-integration.md §8.1).
 *
 * Code hosts are NOT chat platforms: they have no connection, no ingress plugin
 * identity, and no manifest entry. What they share is a provider-qualified
 * NUMERIC repository identity — paths and clone URLs are mutable display hints,
 * so authorization, hook matching, and run effects must key on
 * `(provider, externalId)` and never on a display path.
 */
export const CODE_HOST_PROVIDERS = ['github', 'gitlab'] as const
export type CodeHostProvider = (typeof CODE_HOST_PROVIDERS)[number]

export function isCodeHostProvider(value: unknown): value is CodeHostProvider {
  return typeof value === 'string' && (CODE_HOST_PROVIDERS as readonly string[]).includes(value)
}

/** The generic inbound endpoint — the one hook kind that is not a code host. */
export const GENERIC_HOOK_KIND = 'webhook'

/**
 * Inbound-trigger source vocabulary: the generic endpoint plus one entry per code
 * host. Deriving it from `CODE_HOST_PROVIDERS` is what makes a new host a
 * compile-time event — every `Record<HookKind, …>` mapping over this union stops
 * type-checking until it is given an entry, so no host can silently inherit the
 * generic webhook rendering the way GitLab once did.
 */
export const HOOK_KINDS = [GENERIC_HOOK_KIND, ...CODE_HOST_PROVIDERS] as const
export type HookKind = (typeof HOOK_KINDS)[number]

/** A hook kind that identifies a code host, as opposed to the generic endpoint. */
export function isCodeHostHookKind(kind: HookKind): kind is CodeHostProvider {
  return kind !== GENERIC_HOOK_KIND
}

/**
 * Wire form for provider fields — an OPEN string, mirroring the KNOWN_PLATFORMS
 * precedent (frames/route.ts): zod rejects unknown enum values wholesale, and an
 * unknown provider inside a known frame must degrade per-value, never make the
 * whole frame undecodable on an older peer. Consumers gate on
 * `isCodeHostProvider` and fail closed per value.
 */
export const CodeHostProviderString = z.string().min(1)

/** Decimal wire form for provider numeric ids (same shape as HookBigIntString; local to avoid an import cycle). */
export const CodeHostExternalId = z.string().regex(/^(?:0|[1-9]\d*)$/)
export type CodeHostExternalId = z.infer<typeof CodeHostExternalId>

/**
 * Provider-qualified repository reference. `externalId` is the rename-stable
 * authority (GitHub numeric repo id / GitLab numeric project id); `path` is the
 * current display path ("owner/repo", "group/subgroup/project") and is never a
 * match key.
 */
export const CodeHostRepoRef = z.object({
  provider: CodeHostProviderString,
  externalId: CodeHostExternalId,
  path: z.string().min(1).optional()
})
export type CodeHostRepoRef = z.infer<typeof CodeHostRepoRef>
