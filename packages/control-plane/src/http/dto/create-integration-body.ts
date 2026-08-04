/**
 * The `POST /integrations` create body, **composed from the platform registry**
 * (integration-plugin-architecture.md §9).
 *
 * WHAT MOVED. The body used to be a hand-written closed union in
 * `http/dto/index.ts`: four literal credential keys (`slack` / `telegram` /
 * `discord` / `feishu`), a literal four-id loop for the mismatched-block guard,
 * and a `b.platform === 'slack' | 'feishu'` dispatch into the two providers'
 * transport refinements. Each platform now contributes its own block
 * ({@link CpPlatformProvider.credentialBodySchema} +
 * {@link CpPlatformProvider.refineCreateBody}) and core folds the registry's
 * contributions in at container-build time — so registering a fifth provider
 * extends the wire, `/docs`, and `openapi.json` with no edit here (§12), and
 * the registry stays the single platform-set authority (S3 exit criterion).
 *
 * WHAT STAYED CORE (§9). The cross-block rules are platform-agnostic and belong
 * to the composition: the `platform` discriminator itself, exactly-one-of
 * `botId`/credentials, and the mismatched-block guard — the same rules, now
 * expressed as loops over `platforms.ids()` instead of a copied literal list.
 *
 * SHAPE IS UNCHANGED. Same field names, same optionality, same non-strict
 * object (unknown keys are stripped, never rejected), same user-facing issue
 * messages. `src/http/dto/create-integration-body.test.ts` pins that
 * equivalence against the closed union's audited behavior, and pins the
 * OpenAPI enumeration a dynamic composition could otherwise lose silently.
 */
import { z } from 'zod'
import type { CpPlatformProvider, CpPlatformRegistry } from '../../platforms/provider.js'

/** Inbound transport chosen at install time; an omitted value is the create
 *  route's `socket` default (which the refinements below reproduce). */
const InstallTransport = z.enum(['socket', 'http'])

/**
 * Fold the registry's credential blocks into the create body.
 *
 * Called once per composition root (the create-route plugin builds it from
 * `deps.platforms`), never per request: the schema is a pure function of the
 * registered providers, and `@fastify/swagger` reads it at route-registration
 * time to generate the documented request body.
 */
export function buildCreateIntegrationBody(platforms: CpPlatformRegistry) {
  const ids = platforms.ids()
  if (ids.length === 0) {
    throw new Error('cannot compose POST /integrations: no platform provider is registered')
  }

  // The platform-agnostic skeleton. Declared first so the documented property
  // order stays what the closed union produced (core knobs, then one block per
  // platform in registration order).
  const core = {
    // Optional — the app already has a name; when omitted the CP derives it from
    // the platform (the provider's validated identity), falling back to the owning
    // agent's name. Ignored when reusing an existing bot (the bot keeps its name).
    name: z.string().min(1).optional(),
    /** Which registered platform this install is for — the registry's id set IS
     *  the accepted vocabulary, so an unregistered platform is a 400 here. */
    platform: z.enum(ids as [string, ...string[]]),
    agentId: z.string().min(1), // owner ⇒ delivery daemon; must be placed on a daemon
    /** Reuse an existing bot. A CLASSIC bot must be free; a SHAREABLE bot may
     *  already serve other agents (this adds one more, shared-bot-relay.md §4.1). */
    botId: z.string().min(1).optional(),
    /** Opt the (new or reused) bot into multi-agent shared mode (default false).
     *  Requires `transport: 'http'` (a socket bot is single-agent). */
    shareable: z.boolean().optional(),
    /** Inbound transport for the platforms that offer callback ingress. `socket`
     *  uses the platform's daemon-owned long connection; `http` uses the relay. */
    transport: InstallTransport.optional()
  }

  /** One optional credential block per registered platform — "register a new bot
   *  from pasted credentials". Tokens go in, never come back. */
  const credentialBlocks: Record<string, z.ZodOptional<z.ZodType<unknown>>> = {}
  for (const provider of platforms.all()) {
    if (provider.platformId in core) {
      throw new Error(`platform id collides with a core create-body field: ${provider.platformId}`)
    }
    credentialBlocks[provider.platformId] = provider.credentialBodySchema.optional()
  }

  return z.object({ ...core, ...credentialBlocks }).superRefine((body, ctx) => {
    const addIssue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message })
    const blocks: Record<string, unknown> = body
    // The credential block for the chosen platform (else reuse an existing bot).
    const credentials = blocks[body.platform]
    if ((body.botId !== undefined) === (credentials !== undefined)) {
      addIssue(`exactly one of botId or ${body.platform} must be provided`)
    }
    // Guard against a mismatched credential block (e.g. platform:'telegram' + slack:{…}).
    for (const id of ids) {
      if (id !== body.platform && blocks[id] !== undefined) {
        addIssue(`${id} credentials given for a ${body.platform} integration`)
      }
    }
    // `shareable` is an http-only sub-flag, but it degrades gracefully rather than
    // erroring: the console hides the toggle for socket, and `installNewSlackBot`
    // coerces it off for a non-http bot (so a socket bot can never become shareable).
    // No validation needed here.
    // Per-transport credential requirements (only when registering a NEW bot) —
    // the chosen provider's §9 `refineCreateBody`; an omitted transport is the
    // create route's socket default.
    if (body.botId === undefined && credentials !== undefined) {
      const provider: CpPlatformProvider | undefined = platforms.get(body.platform)
      provider?.refineCreateBody?.({ credentials, transport: body.transport ?? 'socket' }, addIssue)
    }
  })
}

/**
 * The chosen platform's credential block of a parsed create body — `undefined`
 * when the install reuses an existing bot (the exactly-one-of rule above makes
 * those the only two shapes that parse).
 *
 * Opaque to core BY DESIGN (§9, the same stance as the relay contract's
 * `TVerified`): the block was validated by the owning provider's
 * `credentialBodySchema`, and only that platform's code — its `validateConfig`
 * and, until the install funnels move, the create route's per-platform tail —
 * knows the field names inside.
 */
export function credentialBlockOf(body: { platform: string }): unknown {
  const blocks: Record<string, unknown> = body
  return blocks[body.platform]
}
