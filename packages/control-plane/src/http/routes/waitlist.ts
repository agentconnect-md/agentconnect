/**
 * `http/routes/waitlist.ts` — closed-beta admission, CP side (waitlist-and-login.md
 * §5/§8). Root surface (identity-scoped, outside the org boundary):
 *
 *   GET  /me/access      → the caller's admission state + status (drives login routing)
 *   POST /waitlist        → add the caller's OWN verified email as a pending entry
 *   POST /waitlist/redeem → redeem an admin-minted join link ⇒ become a formal user
 *
 * Auth split (§8):
 *  - `/me/access` uses `humanAuth` (identity only). Its email is read from TRUSTED
 *    persistence by `principal.userId` — NEVER from `x-ac-user-email` — so a caller
 *    cannot probe another person's waitlist status. A synthetic placeholder email
 *    reads as "no email" (status `none`, email null).
 *  - `/waitlist` and `/waitlist/redeem` use `oidcAuth`: they must not accept the
 *    devAuth stub, a personal API key, or a plaintext-header email. The per-email
 *    entry (and the redeem email check) uses ONLY the verified email persisted for
 *    `principal.userId`; the request body's email (if any) is ignored.
 *
 * Approval / join-link minting / admin auth are NOT here — they live in a separate
 * external admin app (§7). This file has no `/admin/*` route and no admin concept.
 */
import type { FastifyInstance } from 'fastify'
import type { HttpDeps } from '../deps.js'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { Tag } from '../plugins/openapi.js'
import {
  ErrorDto,
  MeAccessDto,
  WaitlistJoinBody,
  WaitlistJoinDto,
  WaitlistRedeemBody,
  WaitlistRedeemDto,
  type MeAccessDtoT
} from '../dto/index.js'

export function waitlistRoutes(deps: HttpDeps) {
  return async function waitlistRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const waitlistMode = deps.config.WAITLIST_MODE ?? false

    r.get(
      '/me/access',
      {
        preHandler: app.humanAuth,
        schema: {
          tags: [Tag.Profile],
          summary: 'Get your app-admission state',
          description:
            'Whether the signed-in user may enter the app under closed-beta (waitlist) mode, and their derived status. When waitlist mode is off the status is always "active". The email is read from trusted persistence, never from a request header.',
          operationId: 'getMyAccess',
          response: { 200: MeAccessDto, 401: ErrorDto }
        }
      },
      async (req): Promise<MeAccessDtoT> => {
        const access = await deps.waitlist.access(req.principal!.userId)
        // Waitlist off ⇒ preserve today's behavior: everyone is admitted. The real
        // orgCount/email/activated are still reported (harmless, and useful to the UI).
        return {
          waitlistMode,
          status: waitlistMode ? access.status : 'active',
          activated: access.activated,
          orgCount: access.orgCount,
          email: access.email
        }
      }
    )

    r.post(
      '/waitlist',
      {
        // Auth in `preValidation` (NOT preHandler) so it runs BEFORE body-schema
        // validation: an unauthenticated caller is rejected 401/503 first, even with
        // a malformed body — auth-first, no field-requirement probing. The required
        // intake is then enforced by the schema itself (so OpenAPI + types match).
        preValidation: app.oidcAuth,
        schema: {
          tags: [Tag.Profile],
          summary: 'Join the waitlist',
          description:
            'Add the signed-in user’s own verified email to the waitlist as a pending entry (idempotent — a pre-existing entry is left unchanged). The email is taken from the verified identity, never from the request body. The applicant intake is REQUIRED — name, company/team, at least one platform, and team size (use-case is optional) — and is stored as context. Requires OIDC sign-in with a verified email.',
          operationId: 'joinWaitlist',
          body: WaitlistJoinBody,
          response: { 200: WaitlistJoinDto, 400: ErrorDto, 401: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const email = (await deps.waitlist.access(req.principal!.userId)).email
        if (!email) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'a verified email is required to join the waitlist',
            code: 'NO_VERIFIED_EMAIL'
          })
        }
        const status = await deps.waitlist.addSelf(email, req.body)
        return { status }
      }
    )

    r.post(
      '/waitlist/redeem',
      {
        // preValidation (see /waitlist above): auth-first, before body validation.
        preValidation: app.oidcAuth,
        schema: {
          tags: [Tag.Profile],
          summary: 'Redeem a waitlist activation link',
          description:
            'Redeem an activation link, making the signed-in user a formal (activated) user. Activation grants admission, not an organization — the user creates or joins one afterwards. A link minted for a specific email must be redeemed by that verified email; an email-less bearer link may be redeemed by any verified identity and binds to the first redeemer (one use), except that an already-activated account is admitted without consuming it. Optionally send `expectSubject` to assert which signed-in identity the client meant: if it disagrees with the verified token, the request is refused (409 IDENTITY_CHANGED) instead of activating a different account. Idempotent on repeat by the same user. Requires OIDC sign-in with a verified email.',
          operationId: 'redeemWaitlistLink',
          body: WaitlistRedeemBody,
          response: {
            200: WaitlistRedeemDto,
            401: ErrorDto,
            403: ErrorDto,
            409: ErrorDto,
            410: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        // The client may state which identity it believes it is activating. A browser
        // shares its token store across tabs, so another tab signing in elsewhere can
        // swap the identity out from under the activation page — and a bearer
        // (email-less) link accepts ANY verified identity, so it would cheerfully
        // activate that other account. Confirm rather than redeem as someone else.
        // (Not a credential: the identity is still the verified bearer's `sub`.)
        if (req.body.expectSubject && req.body.expectSubject !== req.oidcSubject) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'the signed-in account changed — reopen the activation link and try again',
            code: 'IDENTITY_CHANGED'
          })
        }
        const email = (await deps.waitlist.access(req.principal!.userId)).email
        if (!email) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'a verified email is required to activate',
            code: 'NO_VERIFIED_EMAIL'
          })
        }
        const result = await deps.waitlist.redeem(req.body.token, req.principal!.userId, email)
        if (result.status === 'email_mismatch') {
          return reply.code(403).send({
            error: 'Forbidden',
            statusCode: 403,
            message: `this activation link was issued for ${result.expectedEmail} — sign in with that email to activate`,
            code: 'WAITLIST_EMAIL_MISMATCH'
          })
        }
        if (result.status === 'invalid') {
          return reply.code(410).send({
            error: 'Gone',
            statusCode: 410,
            message: 'this activation link is no longer available — ask an administrator to reissue it',
            code: 'WAITLIST_LINK_UNAVAILABLE'
          })
        }
        return { activated: true as const }
      }
    )
  }
}
