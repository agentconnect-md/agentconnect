// The caller's profile and uploaded photo, and deleting the account itself.
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import type { UserProfileRecord } from '../../persistence/ports.js'
import { MeDto, UpdateMeBody, ErrorDto, type MeDtoT } from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'
import { profilePictureKey, resolveProfilePictureUrl } from '../../icons/icon-store.js'
import { validateIconUpload, MAX_ICON_BYTES } from '../../icons/icon-validate.js'
import { LogtoApiError } from '../../github/logto-identity.js'
import { OrgOwnerRequired } from '../../persistence/errors.js'
import { DELETED_ACCOUNT_CUTOFF_TTL_SECONDS } from '../plugins/auth.js'
import { announceMemberChatRelease, planMemberChatRelease } from '../member-chat-release.js'

export function meRoutes(deps: HttpDeps) {
  return async function meRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    const toDto = (p: UserProfileRecord): MeDtoT => ({
      userId: p.userId,
      email: p.email,
      name: p.displayName,
      picture: resolveProfilePictureUrl(p.userId, p.picture, p.profilePictureUpdatedAt, deps.iconStore),
      pictureCustom: p.profilePictureUpdatedAt !== null,
      pictureUploadEnabled: !!deps.iconStore
    })

    r.get(
      '/me',
      {
        preHandler: app.humanAuth,
        schema: {
          tags: [Tag.Profile],
          summary: 'Get your profile',
          description: "The signed-in user's own profile: identity, display name, and avatar.",
          operationId: 'getMyProfile',
          response: { 200: MeDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const profile = await deps.repos.user.getProfile(req.principal!.userId)
        return profile
          ? toDto(profile)
          : reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'user not found' })
      }
    )

    r.patch(
      '/me',
      {
        preHandler: app.humanAuth,
        schema: {
          tags: [Tag.Profile],
          summary: 'Update your profile',
          description:
            'Edit your display name. Email remains managed by the sign-in provider; profile photos use the dedicated upload endpoint.',
          operationId: 'updateMyProfile',
          body: UpdateMeBody,
          response: { 200: MeDto, 400: ErrorDto, 404: ErrorDto }
        }
      },
      async (req) => {
        // P2025 (row gone) maps to 404 in the server error mapper.
        const updated = await deps.repos.user.updateProfile(req.principal!.userId, { displayName: req.body.name })
        return toDto(updated)
      }
    )

    // Leaves every org the way a member leaving does, then removes the sign-in identity and the account row.
    r.delete(
      '/me',
      {
        preHandler: app.humanAuth,
        config: { interactiveOnly: true },
        schema: {
          tags: [Tag.Profile],
          summary: 'Delete your account',
          description:
            'Permanently delete your account. You leave every organization first, exactly as if you left each one. Refused with 409 `ACCOUNT_OWNS_ORGANIZATIONS` while you are the only owner of an organization; `details.organizations` lists them, so you can delete each one or make someone else an owner. Refused with 503 when the identity service cannot be reached.',
          operationId: 'deleteMyAccount',
          response: { 204: z.null(), 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        const userId = req.principal!.userId
        const soleOwned = (orgs: { orgId: string; slug: string; name: string | null }[]) =>
          reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'you are the only owner of an organization — delete it or make someone else an owner first',
            code: 'ACCOUNT_OWNS_ORGANIZATIONS',
            details: { organizations: orgs.map(({ orgId, slug, name }) => ({ id: orgId, slug, name })) }
          })
        const memberships = await deps.repos.user.listAccountMemberships(userId)
        const blocked = memberships.filter((m) => m.soleOwner)
        if (blocked.length > 0) return soleOwned(blocked)

        for (const membership of memberships) {
          const { orgId } = membership
          const plan = await planMemberChatRelease(deps, orgId, userId, req.log)
          let removed
          try {
            removed = await deps.repos.user.removeMember(orgId, userId, userId, plan.release)
          } catch (err) {
            // Another owner stepped down meanwhile; the orgs already left stay left, and a retry lists this one.
            if (err instanceof OrgOwnerRequired) return soleOwned([membership])
            throw err
          }
          await deps.computers.memberRemoved(orgId, userId, removed.computerAgents)
          await announceMemberChatRelease(deps, req.log, orgId, plan, removed)
        }

        const profile = await deps.repos.user.getProfile(userId)
        // Set only on the real-OIDC path, the one Logto backs.
        const subject = req.oidcSubject
        if (subject && deps.logtoIdentity) {
          try {
            await deps.logtoIdentity.deleteUser(subject)
          } catch (err) {
            if (!(err instanceof LogtoApiError)) throw err
            req.log.warn({ err, userId }, 'account delete: could not delete the sign-in identity')
            return reply.code(503).send({
              error: 'Service Unavailable',
              statusCode: 503,
              message: 'the identity service is unavailable — the account was not deleted'
            })
          }
        }

        const now = deps.clock.now()
        await deps.repos.user.deleteAccount(
          userId,
          new Date(now),
          new Date(now + DELETED_ACCOUNT_CUTOFF_TTL_SECONDS * 1000)
        )
        if (profile?.profilePictureUpdatedAt && deps.iconStore) {
          await deps.iconStore.delete(profilePictureKey(userId)).catch((err) => {
            app.log.warn({ err, userId }, 'profile picture store delete failed (account already deleted)')
          })
        }
        return reply.code(204).send(null)
      }
    )

    // Profile-photo uploads use the same strict raster validation and bounded
    // object-store path as agent/org icons. The parser is only installed with the
    // routes, avoiding a raw-image surface when storage is disabled.
    const iconStore = deps.iconStore
    if (!iconStore) return
    app.addContentTypeParser(
      ['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'],
      { parseAs: 'buffer', bodyLimit: MAX_ICON_BYTES },
      (_req, body, done) => done(null, body)
    )

    r.put(
      '/me/picture',
      {
        preHandler: app.humanAuth,
        schema: {
          tags: [Tag.Profile],
          summary: 'Upload your profile photo',
          description:
            'Store a PNG, JPEG, or WebP photo for your profile. The image replaces the sign-in provider photo until removed.',
          operationId: 'uploadMyProfilePicture',
          consumes: ['image/png', 'image/jpeg', 'image/webp'],
          body: z.any(),
          response: { 200: MeDto, 404: ErrorDto, 413: ErrorDto, 415: ErrorDto }
        }
      },
      async (req, reply) => {
        const bytes = req.body as Buffer
        const validation = await validateIconUpload(bytes)
        if (!validation.ok) {
          return reply
            .code(validation.status)
            .send({ error: 'Unsupported', statusCode: validation.status, message: validation.message })
        }
        const userId = req.principal!.userId
        await iconStore.put(profilePictureKey(userId), bytes, validation.contentType)
        const updated = await deps.repos.user.setProfilePicture(userId, new Date())
        return toDto(updated)
      }
    )

    r.delete(
      '/me/picture',
      {
        preHandler: app.humanAuth,
        schema: {
          tags: [Tag.Profile],
          summary: 'Remove your profile photo',
          description: 'Remove the uploaded photo and restore the avatar from your sign-in provider.',
          operationId: 'deleteMyProfilePicture',
          response: { 200: MeDto, 404: ErrorDto }
        }
      },
      async (req) => {
        const userId = req.principal!.userId
        const updated = await deps.repos.user.clearProfilePicture(userId)
        await iconStore.delete(profilePictureKey(userId)).catch((err) => {
          app.log.warn({ err, userId }, 'profile picture store delete failed (profile already reset)')
        })
        return toDto(updated)
      }
    )
  }
}
